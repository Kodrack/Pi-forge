// piforge-manager.ts
// Manages which PiForge extensions are enabled or disabled via ~/.pi/piforge.json.
// Extensions that support toggling check that file on session_start.
//
// Commands:
//   /piforge              — show all toggleable extensions + current status
//   /piforge enable <name>  — enable an extension
//   /piforge disable <name> — disable an extension
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
  { name: "state-guard",        description: "Blocks source reads until _state.md read; forces updates every 3 turns" },
  { name: "purpose-anchor",     description: "Captures session purpose, re-injects after compaction" },
  { name: "distill",            description: "/distill command + distill_codebase tool" },
  { name: "distill-query",      description: "/l1 /l2 /l3 direct level queries" },
  { name: "explore",            description: "/explore + explore_codebase tool (superseded by distill-query)" },
  { name: "distill-awareness",  description: "Session-start distill context injection (superseded by distill-query)" },
];

function readConfig(): { disabled: string[] } {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { disabled: [] };
  }
}

function writeConfig(config: { disabled: string[] }) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

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
    description: "Manage PiForge extension toggles",
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
        ctx.ui.notify("piforge extension status:\n" + lines.join("\n"), "info");
        return;
      }

      if (action !== "enable" && action !== "disable") {
        ctx.ui.notify("usage: /piforge | /piforge enable <name> | /piforge disable <name>", "info");
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
