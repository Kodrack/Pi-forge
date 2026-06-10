// first-prompt.ts
// Appends a planning instruction to the first user prompt of every session.
// Programmatic — no model decision, no steer message, zero context overhead.
// Only fires once per session on the very first input event.
//
// Install: copy to ~/.pi/agent/extensions/first-prompt.ts
// Toggle:  /piforge disable first-prompt | /piforge enable first-prompt

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// The PiForge workflow contract lives at ~/.pi/agent/AGENTS.md
// (copied there by install.sh, symlinked to the repo by dev-link.sh).
// A project-local AGENTS.md is optional, holds project-specific rules, and is
// always appended in full after the contract.
function readFileOrNull(p: string): string | null {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

function readAgentsMd(): string | null {
  const globalMd = readFileOrNull(path.join(os.homedir(), ".pi", "agent", "AGENTS.md"));
  const projectMd = readFileOrNull(path.join(process.cwd(), "AGENTS.md"));
  // No global install? The project file acts as the contract (legacy setups).
  if (!globalMd) return projectMd;
  if (!projectMd) return globalMd;
  return `${globalMd}\n\n---\n# PROJECT-SPECIFIC RULES (project AGENTS.md)\n${projectMd}`;
}

const APPEND = `

HARD CONSTRAINTS (you will fail if you ignore these):
1. Your output limit is ~4096 tokens. If you exceed it, generation stops mid-sentence with NO recovery.
2. NEVER write more than 80 lines in a single response — even in plain text.
3. For any file > 50 lines: write skeleton first (under 50 lines), then fill in with edit calls.
4. After EVERY action, update .think/_state.md with what you did and what's next.

Why this matters: If you get cut off mid-file, your next turn won't know where you stopped. The filesystem is your memory — use it.

WEB SEARCH: You have web_search(query). Use it BEFORE implementing when:
- Working with a library/API you're unsure about
- User mentions specific versions or "latest"
- Debugging unfamiliar error messages
- Anything that may have changed since your training cutoff

FRONTEND/UI TASKS (HTML, CSS, JS with visual output):
- Implement MAX 2 changes per turn, then OPEN IN BROWSER to verify
- Before implementing from a spec: check variable names match actual code (loop vars, function params)
- After any JS edit: browser test is REQUIRED — syntax check (node -c) catches syntax, not runtime errors
- If something breaks: STOP, revert to working state, implement ONE change at a time

Plan the implementation as numbered steps in _plan.md. Do ONLY what the user asked — do NOT add refactors, tests, extra features, or "improvements" they didn't request. Work THROUGH your planned steps: after finishing a step, update _state.md and CONTINUE to the next step automatically — do NOT stop and wait for the user between steps. Keep going until EVERY planned step is done; only then set _state.md "## Status: complete", give a ONE-LINE summary, and STOP. Do not invent more work beyond the plan. If the task is a one-shot answer (a question, a search, a lookup), answer it, set Status: complete, and STOP.`;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("first-prompt");
  } catch {
    return true;
  }
}

export default function (pi: ExtensionAPI) {
  let fired = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) {
      ctx.ui.notify("first-prompt disabled (use /piforge enable first-prompt to activate)", "info");
      return;
    }
    const agentsMd = readAgentsMd();
    if (agentsMd) {
      ctx.ui.notify(`first-prompt active — found AGENTS.md (${agentsMd.length} chars), will inject on first prompt`, "info");
    } else {
      ctx.ui.notify("first-prompt active — no AGENTS.md found, using default constraints", "info");
    }
  });

  pi.on("input", (event) => {
    if (!isEnabled() || fired) return { action: "continue" as const };
    fired = true;

    const original = (event as any).text ?? "";
    const agentsMd = readAgentsMd();
    const instructions = agentsMd
      ? `\n\n---\n# AGENTS.md\n${agentsMd}\n---\n`
      : APPEND;

    return {
      action: "transform" as const,
      text: original + instructions,
    };
  });
}
