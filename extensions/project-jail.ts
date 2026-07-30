// project-jail.ts
// HARD guard: confines all file mutations to the project root (the session's
// working directory). Born from a real failure: an executor followed absolute
// paths written into a plan and built an entire website in ~/Desktop/… instead
// of the project it was launched in.
//
// Blocks, before execution:
//   - write/edit whose target resolves OUTSIDE the project root (tmpdir and
//     .think/ stay allowed)
//   - bash commands that reference home-area paths (/Users/…, /home/…, ~/…)
//     outside the project root AND contain a mutating/relocating token
//     (redirection, mkdir, cp, mv, rm, touch, tee, ln, sed -i, git init/clone,
//     npm/npx create, cd). Reading/executing outside files stays allowed —
//     e.g. `bash ~/shared/tests/T-001.sh` runs fine.
//
// Side effect worth knowing: a test suite kept outside the project (a shared
// spec repo, say) becomes read-only to the session — it can run those tests but
// physically cannot rewrite them, so the pass/fail contract cannot be gamed.
//
// Toggleable: /piforge disable project-jail
// Install: copy to ~/.pi/agent/extensions/project-jail.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// Locations a mutation may touch besides the project root.
const EXTRA_ALLOWED_ROOTS = [os.tmpdir(), "/tmp"];

// Home-area path tokens in bash commands — system paths (/opt, /usr, …) are
// binaries/libs, not places the model "builds in the wrong folder".
const OUTSIDE_PATH_RE = /(?:^|[\s"'`=(])((?:\/Users|\/home)\/[^\s"'`;|&)]+|~\/[^\s"'`;|&)]+)/g;
const MUTATION_RE = /(?:>>?|\b(?:mkdir|touch|cp|mv|rm|tee|ln|chmod|chown|rsync|sed\s+-i|git\s+(?:init|clone)|npm\s+create|npx\s+create[\w-]*|yarn\s+create|cd)\b)/;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("project-jail");
  } catch {
    return true;
  }
}

function expand(p: string): string {
  return path.resolve(p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
}

// Heredoc bodies are DOCUMENT CONTENT — they can never be a mutation target, so
// scanning them only produces false positives. Observed 2026-07-26: the model
// appended PiForge documentation with `cat >> <file> <<'CHUNK'`, the doc text
// mentioned ~/.pi/agent/ (as PiForge docs must), and the command was blocked
// even though the target was inside the project. That fires on the very workflow
// incremental-guard forces the model into (chunked `cat >>` appends), so any
// document mentioning a home path became unwritable.
//
// The OPENER line is kept and still scanned, so a genuine
// `cat > ~/Desktop/site/index.html <<'EOF'` — the failure this guard was built
// for — is still caught.
function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split(/\r?\n/)) {
    if (terminator !== null) {
      // `<<-` allows an indented terminator, so compare trimmed.
      if (line.trim() === terminator) terminator = null;
      continue; // drop body lines
    }
    kept.push(line);
    const m = line.match(/<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (m) terminator = m[1] ?? m[2] ?? m[3] ?? null;
  }
  return kept.join("\n");
}

function isInside(target: string, root: string): boolean {
  const t = expand(target);
  const r = path.resolve(root);
  return t === r || t.startsWith(r + path.sep);
}

function isAllowed(target: string, projectRoot: string): boolean {
  return [projectRoot, ...EXTRA_ALLOWED_ROOTS].some((root) => isInside(target, root));
}

export default function projectJail(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    ctx.ui.notify(`project-jail active — file mutations confined to ${process.cwd()}`, "info");
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!isEnabled()) return;
    const projectRoot = process.cwd();

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { path?: string; file_path?: string };
      const target = input.path ?? input.file_path;
      if (target && !isAllowed(target, projectRoot)) {
        return {
          block: true,
          reason:
            `${event.toolName} rejected: "${target}" is OUTSIDE the project root. ` +
            `ALL work happens in the current project: ${projectRoot}. ` +
            `Do NOT retry with this path and do NOT invent other locations. ` +
            `Recreate the same file INSIDE the project using a RELATIVE path ` +
            `(e.g. src/${path.basename(expand(target))}).`,
        };
      }
    }

    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      const command = input.command ?? "";
      // Scan the shell portion only — heredoc bodies are content, not targets.
      const scannable = stripHeredocBodies(command);
      const outside = [...scannable.matchAll(OUTSIDE_PATH_RE)]
        .map((m) => m[1])
        .filter((p) => !isAllowed(p, projectRoot));
      if (outside.length && MUTATION_RE.test(scannable)) {
        return {
          block: true,
          reason:
            `bash rejected: the command mutates or moves into a location OUTSIDE the project root ` +
            `(${[...new Set(outside)].slice(0, 3).join(", ")}). ` +
            `ALL work happens in the current project: ${projectRoot} — you are already there. ` +
            `Do NOT retry this command and do NOT 'cd' elsewhere. ` +
            `Re-run it using RELATIVE paths inside the project.`,
        };
      }
    }
  });
}
