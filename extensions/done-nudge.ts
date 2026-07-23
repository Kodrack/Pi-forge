// done-nudge.ts
// Nudges the model to DECLARE completion when its own behavior says it's done.
//
// Observed in the 2026-07-23 hard benchmark: two sessions had a fully correct,
// verified solution by ~minute 9, then spent 10+ more minutes re-running checks
// and fiddling (40-49 tool calls) without ever concluding, until the wall clock
// killed them. The doneness signal was sitting in their own tool results —
// repeated successful executions, nothing left to change.
//
// Mechanism (soft steer, fires at most ONCE per session):
//   after N consecutive execution-ish bash calls with ZERO source-file
//   modifications in between — and at least one source modification earlier in
//   the session, and _state.md not already complete — inject one steering
//   message: "your checks pass and nothing is changing; if the deliverable is
//   complete, mark _state.md Status: complete and stop."
//
// This is the mirror image of execution-guard (which blocks premature "done");
// together they derive task state from observable facts instead of trusting
// the model's feel for being finished.
//
// Install: copy to ~/.pi/agent/extensions/done-nudge.ts
// Toggle:  /piforge disable done-nudge | /piforge enable done-nudge

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// Consecutive executions with no source change before the nudge fires.
const EXEC_STREAK_TO_NUDGE = 3;

// File extensions that count as source code (same set as execution-guard).
const CODE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt)$/i;

// Bash commands that count as EXECUTING something.
const EXEC_COMMAND = /(^|[;&|]\s*)(node|python3?|npm|npx|pnpm|yarn|bun|deno|pytest|go\s+(run|test)|cargo\s+(run|test)|ruby|php|bash\s+\S|sh\s+\S|make|\.\/\S)/;

const NUDGE_MESSAGE = `[done-nudge] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
You have now executed checks ${EXEC_STREAK_TO_NUDGE}+ times in a row WITHOUT changing any source file.
If those runs are passing, the task is DONE — more re-testing adds nothing.

Do this now:
1. If the last run's output was correct: update .think/_state.md with "## Status: complete" and a one-line summary of what you verified, then STOP and hand back to the user.
2. If something is actually still broken: name the specific failure in .think/_state.md and fix THAT — do not re-run the same passing checks again.

Do not invent extra improvements, refactors, or tests nobody asked for.`;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("done-nudge");
  } catch {
    return true;
  }
}

function isCodePath(filePath: string): boolean {
  return CODE_EXTENSIONS.test(filePath) && !filePath.includes(".think/") && !filePath.includes(".think\\");
}

function bashWritesCode(command: string): boolean {
  const m = command.match(/>>?\s*([^\s;|&]+)/);
  return !!m && isCodePath(m[1]);
}

// Read "## Status: ..." from _state.md; true if it says complete (mirrors completion-guard).
function taskMarkedComplete(cwd: string): boolean {
  try {
    const content = fs.readFileSync(path.join(cwd, ".think", "_state.md"), "utf-8");
    const m = content.match(/##\s*Status:\s*([^\n]+)/i);
    if (!m) return false;
    return /\b(complete|completed|done|finished)\b/i.test(m[1]);
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let sourceEverModified = false;
  let execStreak = 0;
  let nudged = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `done-nudge active — suggests declaring completion after ${EXEC_STREAK_TO_NUDGE} executions with no source changes`,
      "info"
    );
  });

  // Track only calls that actually EXECUTED (blocked calls never get a result).
  pi.on("tool_result", async (event: any, ctx: any) => {
    if (nudged) return;
    const toolName = event.toolName ?? "";
    const input = (event.input as Record<string, any>) ?? {};

    if (toolName === "write" || toolName === "edit") {
      const filePath = input.path ?? input.file_path ?? "";
      if (isCodePath(filePath)) {
        sourceEverModified = true;
        execStreak = 0; // still changing things — not done
      }
      return;
    }

    if (toolName === "bash") {
      const command = String(input.command ?? "");
      if (bashWritesCode(command)) {
        sourceEverModified = true;
        execStreak = 0;
        return;
      }
      if (!EXEC_COMMAND.test(command)) return; // ls/cat/mkdir — neutral

      execStreak++;
      if (execStreak < EXEC_STREAK_TO_NUDGE) return;
      if (!sourceEverModified) return;          // nothing was built — not our case
      if (taskMarkedComplete(ctx.cwd)) return;  // already declared — completion-guard's job now

      nudged = true;
      ctx.ui.notify(`done-nudge: ${execStreak} executions with no source change — suggesting completion`, "info");
      await pi.sendMessage(
        {
          customType: "done_nudge",
          content: NUDGE_MESSAGE,
          display: {
            label: "done-nudge",
            content: `${execStreak} executions, no source changes — nudged to declare completion`,
          },
        },
        { deliverAs: "steer" }
      );
    }
  });

  pi.registerCommand("done-nudge", {
    description: "Show done-nudge status",
    handler: async (_args: any, ctx: any) => {
      ctx.ui.notify(
        `done-nudge: ${nudged ? "already fired this session" : `exec streak ${execStreak}/${EXEC_STREAK_TO_NUDGE}${sourceEverModified ? "" : " (not armed — no source modified yet)"}`}`,
        "info"
      );
    },
  });
}
