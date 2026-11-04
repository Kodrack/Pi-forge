// piforge-manager.ts
// Manages this machine's PiForge settings in ~/.pi/piforge.json (machine-local,
// never in git): which extensions are disabled, and per-machine limit overrides.
// Extensions read that file on session_start, so changes apply on /reload.
//
// Commands:
//   /piforge                          — extension toggles + current status
//   /piforge enable <name>            — enable an extension
//   /piforge disable <name>           — disable an extension
//   /piforge limits                   — every tunable limit: active value, default
//   /piforge set <ext>.<key> <value>  — override a limit on this machine
//   /piforge reset <ext>.<key>|<ext>|all — drop override(s), back to defaults
//
// Install: copy to ~/.pi/agent/extensions/piforge-manager.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

const TOGGLEABLE = [
  { name: "first-prompt",       description: "Appends 'plan in steps, implement one at a time' to first prompt" },
  { name: "knowledge-injector", description: "Isolated LLM call selects knowledge files before turn 1" },
  { name: "plan-clarify",       description: "Asks ≤3 clarifying questions after _plan.md is written" },
  { name: "deep-plan",          description: "/plan <task> — researches in an isolated read-only sub-Pi (web search on), writes _plan.md, then enforces step order" },
  { name: "bash-output-guard",  description: "Replaces oversized bash/grep/find/ls results with a summary naming the heaviest files — caps what a tool RETURNS" },
  { name: "state-guard",        description: "Blocks source reads until _state.md read; forces updates every 3 turns" },
  { name: "purpose-anchor",     description: "Captures session purpose, re-injects after compaction (idle when task complete)" },
  { name: "completion-guard",   description: "Blocks source edits after _state.md Status: complete; caps changes/turn" },
  { name: "execution-guard",    description: "Blocks Status: complete while modified code was never executed (for unattended runs; off by default)" },
  { name: "acceptance-guard",   description: "Runs .think/_acceptance.sh at completion; blocks Status: complete unless it exits 0 (supersedes execution-guard)" },
  { name: "progress-checkpoint", description: "On a stalled session (no file changes), demands \"done\" or a concrete next action — hands off to you after 2 ignored" },
  { name: "done-nudge",         description: "Suggests declaring completion after repeated executions with no source changes" },
  { name: "deep-research",      description: "/research <topic> — multi-round web research (decompose → search → gap-check → sourced report)" },
  { name: "code-research",      description: "/ask <question> + code_research tool — deep codebase investigation with file:line-cited report" },
  { name: "distill",            description: "/distill command + distill_codebase tool" },
  { name: "distill-query",      description: "/l1 /l2 /l3 direct level queries" },
  { name: "explore",            description: "/explore + explore_codebase tool (superseded by distill-query)" },
  { name: "distill-awareness",  description: "Session-start distill context injection (superseded by distill-query)" },
  { name: "voice-input",        description: "Push-to-talk voice input (è key), local STT via parakeet or moonshine" },
  { name: "dory-board",         description: "Open the Dory kanban board in the browser (ù key or /board), auto-starts the server" },
  { name: "project-jail",       description: "Blocks file mutations outside the project root (cwd) — write/edit/bash confined to the project" },
  { name: "dory-mode",          description: "/dory — turn this Pi session into Dory (persona + dory_board tool for the kanban)" },
  { name: "dory-plan-guard",    description: "Keeps Dory's chat/plan/respond/wave jobs read-only and stops them once the marker block is out" },
  { name: "lmstudio-console",   description: "/lmstudio — list/load/unload models on the LM Studio server (interactive console)" },
];

// piforge.json is this machine's PiForge config: "disabled" plus other sections
// (e.g. "limits" read by incremental-guard). Always read-modify-write the WHOLE
// object so toggling an extension never drops the other sections.
type PiforgeConfig = { disabled: string[]; [section: string]: unknown };

function readConfig(): PiforgeConfig {
  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    config = {};
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) config = {};
  if (!Array.isArray(config.disabled)) config.disabled = [];
  return config;
}

// Write via a temp file + rename so an interrupted write can't leave a
// half-written piforge.json (which every extension would then read as "no config").
function writeConfig(config: PiforgeConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_PATH);
}

// ---------- LIMITS ----------
// Every setting /piforge set|reset can change. Each lives in piforge.json under
// "limits" → <ext> → <key>, and the owning extension reads it on session_start.
// `def` MUST equal the default constant in the owning extension —
// bench/functional/test-piforge-config.mjs parses both and fails on drift.
export const SETTINGS: { ext: string; key: string; def: number; desc: string }[] = [
  { ext: "incremental-guard", key: "maxLinesPerWrite", def: 100,  desc: "max lines in one write call" },
  { ext: "incremental-guard", key: "maxCharsPerWrite", def: 6000, desc: "max chars in one write call" },
  { ext: "incremental-guard", key: "maxLinesPerEdit",  def: 60,   desc: "max lines in one edit new_string (old_string: 2x)" },
  { ext: "incremental-guard", key: "maxCharsPerEdit",  def: 3000, desc: "max chars in one edit new_string" },
  { ext: "incremental-guard", key: "maxLinesPerBash",  def: 100,  desc: "max lines in one bash command" },
  { ext: "incremental-guard", key: "maxCharsPerBash",  def: 6000, desc: "max chars in one bash command" },
];

function findSetting(id: string) {
  return SETTINGS.find((s) => `${s.ext}.${s.key}` === id);
}

function getOverride(config: PiforgeConfig, ext: string, key: string): unknown {
  const limits = config.limits as Record<string, Record<string, unknown>> | undefined;
  return limits?.[ext]?.[key];
}

// Remove a key; prune the now-empty ext object and "limits" so the file stays tidy.
function dropOverride(config: PiforgeConfig, ext: string, key: string): boolean {
  const limits = config.limits as Record<string, Record<string, unknown>> | undefined;
  if (!limits?.[ext] || !(key in limits[ext])) return false;
  delete limits[ext][key];
  if (Object.keys(limits[ext]).length === 0) delete limits[ext];
  if (Object.keys(limits).length === 0) delete config.limits;
  return true;
}

function limitsReport(config: PiforgeConfig): string {
  const rows = SETTINGS.map((s) => {
    const id = `${s.ext}.${s.key}`;
    const o = getOverride(config, s.ext, s.key);
    const valid = typeof o === "number" && Number.isInteger(o) && o > 0;
    const shown =
      o === undefined ? `${s.def}` : valid ? `${o}  (default ${s.def})` : `${s.def}  (invalid override ${JSON.stringify(o)} ignored)`;
    return `  ${id.padEnd(36)} ${shown.padEnd(18)} ${s.desc}`;
  });
  return (
    "piforge limits (this machine, ~/.pi/piforge.json):\n" +
    rows.join("\n") +
    "\nchange: /piforge set <ext>.<key> <value>  ·  undo: /piforge reset <ext>.<key>|<ext>|all  ·  then /reload"
  );
}

const USAGE =
  "usage: /piforge | /piforge enable|disable <name> | /piforge limits | " +
  "/piforge set <ext>.<key> <value> | /piforge reset <ext>.<key>|<ext>|all";

function isDisabled(name: string): boolean {
  return readConfig().disabled.includes(name);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = readConfig();
    if (config.disabled.length > 0) {
      ctx.ui.notify(`piforge: disabled → ${config.disabled.join(", ")} (use /piforge to manage)`, "info");
    }
  });

  pi.registerCommand("piforge", {
    description: "PiForge settings for this machine: extension toggles and limits (/piforge limits|set|reset)",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const action = parts[0];
      const name = parts[1];

      // show status
      if (!action) {
        const config = readConfig();
        const lines = TOGGLEABLE.map(e => {
          const status = config.disabled.includes(e.name) ? "disabled" : "enabled ";
          return `  [${status}]  ${e.name.padEnd(22)} ${e.description}`;
        });
        const overridden = SETTINGS.filter((s) => getOverride(config, s.ext, s.key) !== undefined).length;
        ctx.ui.notify(
          "piforge extension status:\n" + lines.join("\n") +
            `\nlimits: ${overridden ? `${overridden} overridden on this machine` : "all defaults"} — /piforge limits`,
          "info"
        );
        return;
      }

      if (action === "limits") {
        ctx.ui.notify(limitsReport(readConfig()), "info");
        return;
      }

      if (action === "set") {
        const id = parts[1];
        const raw = parts[2];
        const setting = id ? findSetting(id) : undefined;
        if (!setting) {
          ctx.ui.notify(
            `${id ? `unknown setting "${id}". ` : ""}settable: ${SETTINGS.map((s) => `${s.ext}.${s.key}`).join(", ")}\n${USAGE}`,
            "info"
          );
          return;
        }
        const value = Number(raw);
        if (raw === undefined || !/^[0-9]+$/.test(raw) || !Number.isInteger(value) || value <= 0) {
          ctx.ui.notify(`piforge: ${id} needs a positive whole number (got ${JSON.stringify(raw ?? "")}) — nothing saved`, "warning");
          return;
        }
        const config = readConfig();
        if (value === setting.def) {
          dropOverride(config, setting.ext, setting.key);
          writeConfig(config);
          ctx.ui.notify(`piforge: ${id} = ${value} is the default — override removed from ~/.pi/piforge.json (/reload to apply)`, "info");
          return;
        }
        const limits = ((config.limits ??= {}) as Record<string, Record<string, unknown>>);
        const section = (limits[setting.ext] ??= {});
        const before = section[setting.key];
        section[setting.key] = value;
        writeConfig(config);
        ctx.ui.notify(
          `piforge: ${id} = ${value} (was ${before ?? `default ${setting.def}`}) — saved to ~/.pi/piforge.json, /reload to apply`,
          "info"
        );
        return;
      }

      if (action === "reset") {
        const target = parts[1];
        if (!target) {
          ctx.ui.notify(USAGE, "info");
          return;
        }
        const matches =
          target === "all" ? SETTINGS : SETTINGS.filter((s) => `${s.ext}.${s.key}` === target || s.ext === target);
        if (matches.length === 0) {
          ctx.ui.notify(`piforge: nothing called "${target}" — see /piforge limits`, "info");
          return;
        }
        const config = readConfig();
        const dropped = matches.filter((s) => dropOverride(config, s.ext, s.key)).map((s) => `${s.ext}.${s.key}`);
        if (dropped.length === 0) {
          ctx.ui.notify(`piforge: ${target} already at defaults — nothing to reset`, "info");
          return;
        }
        writeConfig(config);
        ctx.ui.notify(`piforge: reset to default → ${dropped.join(", ")} (/reload to apply)`, "info");
        return;
      }

      if (action !== "enable" && action !== "disable") {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      if (!name) {
        const names = TOGGLEABLE.map(e => e.name).join(", ");
        ctx.ui.notify(`specify an extension name: ${names}`, "info");
        return;
      }

      if (!TOGGLEABLE.find(e => e.name === name)) {
        const names = TOGGLEABLE.map(e => e.name).join(", ");
        ctx.ui.notify(`unknown extension "${name}". toggleable extensions: ${names}`, "info");
        return;
      }

      const config = readConfig();

      if (action === "disable") {
        if (!config.disabled.includes(name)) config.disabled.push(name);
        writeConfig(config);
        ctx.ui.notify(`piforge: ${name} disabled (takes effect next session — /reload to apply now)`, "info");
      } else {
        config.disabled = config.disabled.filter(n => n !== name);
        writeConfig(config);
        ctx.ui.notify(`piforge: ${name} enabled (takes effect next session — /reload to apply now)`, "info");
      }
    },
  });
}
