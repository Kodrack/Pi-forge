// completion-guard.ts
// Hard-stops the "keeps going after done" overrun on local LLMs.
//
// Local models told to "continue automatically" finish the real task, then
// invent refactors / improvements / extra features nobody asked for and never
// hand back. This guard makes STOPPING enforceable at the tool-call boundary:
//
//   1. Completion latch: once .think/_state.md says "## Status: complete",
//      any further source write/edit is BLOCKED — the model must either stop
//      and hand back, or (for a genuinely new task) re-declare Status:
//      in-progress in _state.md first. Updating _state.md flips the gate, so
//      legit continuation stays possible; accidental drift does not.
//
//   2. Per-turn change ceiling: even before completion is declared, more than
//      MAX_CHANGES_PER_TURN source edits in a single turn is blocked — forcing
//      the model to checkpoint into _state.md and let the user review.
//
// .think/ writes are always allowed (the model needs to update its own state).
//
// Install: copy to ~/.pi/agent/extensions/completion-guard.ts
// Toggle:  /piforge disable completion-guard | /piforge enable completion-guard

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// Max source-file changes allowed in a single turn before we force a checkpoint.
const MAX_CHANGES_PER_TURN = 8;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("completion-guard");
  } catch {
    return true;
  }
}

function isThinkPath(filePath: string): boolean {
  return filePath.includes(".think/") || filePath.includes(".think\\");
}

// Read "## Status: ..." from _state.md; true if it says complete/done.
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

  let changesThisTurn = 0;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `completion-guard active — blocks edits after _state.md Status: complete (max ${MAX_CHANGES_PER_TURN} changes/turn)`,
      "info"
    );
  });

  pi.on("turn_start", async () => {
    changesThisTurn = 0;
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.toolName ?? "";
    if (toolName !== "write" && toolName !== "edit") return;

    const input = (event.input as Record<string, any>) ?? {};
    const filePath = input.path ?? input.file_path ?? "";

    // Always allow the model to update its own brain (_state.md, steps, summary).
    if (isThinkPath(filePath)) return;

    // 1. Completion latch — task is marked done, so stop touching source.
    if (taskMarkedComplete(ctx.cwd)) {
      return {
        block: true,
        reason:
          `BLOCKED: .think/_state.md says Status: complete. The task is done — STOP and hand back to the user. ` +
          `Do NOT add refactors, tests, or improvements that weren't requested. ` +
          `If the user gave a genuinely NEW task, first rewrite .think/_state.md with "## Status: in-progress" ` +
          `and the new Task/Next Action, then proceed.`,
      };
    }

    // 2. Per-turn change ceiling — catch runaway editing before completion.
    changesThisTurn++;
    if (changesThisTurn > MAX_CHANGES_PER_TURN) {
      return {
        block: true,
        reason:
          `BLOCKED: ${changesThisTurn - 1} source changes already this turn (limit ${MAX_CHANGES_PER_TURN}). ` +
          `Stop here. Update .think/_state.md with what you've done, the current Status, and the exact Next Action, ` +
          `then end your turn so the user can review. Do not keep going in one turn.`,
      };
    }
  });

  pi.registerCommand("completion-guard", {
    description: "Show completion-guard status",
    handler: async (_args: any, ctx: any) => {
      const complete = taskMarkedComplete(ctx.cwd);
      ctx.ui.notify(
        `completion-guard: task ${complete ? "COMPLETE (source edits blocked)" : "in-progress"} | ` +
          `changes this turn: ${changesThisTurn}/${MAX_CHANGES_PER_TURN}`,
        "info"
      );
    },
  });
}
