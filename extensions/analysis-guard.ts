// analysis-guard.ts
// Detects long analysis/reasoning responses that didn't write anything to disk
// and injects a steering message forcing the model to save findings to a
// .think/step-NNN.md file before the next turn.
//
// Completes the three-guard stack:
//   incremental-guard  → prevents oversized write/edit tool calls
//   thinking-guard     → prevents runaway thinking blocks
//   analysis-guard     → prevents useful analysis from being lost to context
//
// Install: copy to ~/.pi/agent/extensions/analysis-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

// ---------- THRESHOLDS ----------
// Minimum response text length to be considered "analysis worth saving".
// Short answers (<500 chars) are not worth forcing a file write.
const MIN_ANALYSIS_CHARS = 1000;

// ---------- STEERING MESSAGE ----------
const CORRECTION_MESSAGE = `[analysis-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
You just gave a long analysis but did not write it to disk.
Context is lossy — this analysis will be forgotten.

ACTION REQUIRED:
1. Write your findings to .think/step-NNN.md (use next available number)
   Use this structure:
   ## Input: [what you analyzed]
   ## CONCLUSION: [your key findings, ranked]
   ## Next: [what to do with this]

2. Update .think/_state.md with:
   ## Last Action: analyzed [topic]
   ## Key Files: .think/step-NNN.md — [one line summary]

Do this NOW before responding further. Keep the file under 2K tokens.`;

// ---------- HELPERS ----------
function getTextLength(message: any): number {
  if (!message?.content) return 0;
  return (message.content as any[])
    .filter((b) => b?.type === "text")
    .reduce((sum, b) => sum + (b?.text?.length ?? 0), 0);
}

function hadFileWrite(toolResults: any[]): boolean {
  if (!toolResults?.length) return false;
  return toolResults.some((r) => {
    const name = r?.toolName ?? r?.name ?? "";
    return name === "write" || name === "edit";
  });
}

// Completion-aware: if .think/_state.md says the task is done, don't nag the
// model to persist analysis — the answer's already delivered and the task is
// over. Avoids the post-completion step-file/state cascade on one-shot tasks.
function taskMarkedComplete(cwd: string): boolean {
  try {
    const content = fs.readFileSync(path.join(cwd, ".think", "_state.md"), "utf-8");
    const m = content.match(/##\s*Status:\s*([^\n]+)/i);
    return !!m && /\b(complete|completed|done|finished)\b/i.test(m[1]);
  } catch {
    return false;
  }
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  // Track per-turn whether any write/edit happened.
  let turnHadFileWrite = false;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `analysis-guard active (triggers on responses >${MIN_ANALYSIS_CHARS} chars with no file write)`,
      "info"
    );
  });

  // Track write/edit results within the current turn. tool_result only fires
  // for calls that actually executed — a write BLOCKED by another guard emits
  // no result, so it correctly doesn't count as "analysis was saved".
  pi.on("tool_result", async (event, _ctx) => {
    const name = (event as any).toolName ?? "";
    if (name === "write" || name === "edit") {
      turnHadFileWrite = true;
    }
  });

  // Reset per-turn state at start of each turn.
  pi.on("turn_start", async (_event, _ctx) => {
    turnHadFileWrite = false;
  });

  // Enforce at turn end.
  pi.on("turn_end", async (event, ctx) => {
    const textLen = getTextLength(event.message);

    // Also check toolResults for any write/edit that completed this turn.
    const wroteFile = turnHadFileWrite || hadFileWrite((event as any).toolResults ?? []);

    // Reset for next turn.
    turnHadFileWrite = false;

    // Only trigger if: response was long AND no files were written.
    if (textLen < MIN_ANALYSIS_CHARS || wroteFile) return;

    // Don't force a step-file write if the task is already complete — nothing
    // left to preserve for resumption, the answer's been delivered.
    if (taskMarkedComplete(ctx.cwd)) return;

    ctx.ui.notify(
      `analysis-guard: ${textLen} char response with no file write — injecting step-file reminder.`,
      "info"
    );

    await pi.sendMessage(
      {
        customType: "analysis_guard_correction",
        content: CORRECTION_MESSAGE,
        display: {
          label: "analysis-guard",
          content: `Long response (${textLen} chars) not saved to disk. Forcing step file write.`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  // /analysis-guard command — show current config.
  pi.registerCommand("analysis-guard", {
    description: "Show analysis-guard config",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `analysis-guard: triggers on responses >${MIN_ANALYSIS_CHARS} chars with no write/edit tool call. ` +
        `Edit ~/.pi/agent/extensions/analysis-guard.ts to tune, then /reload.`,
        "info"
      );
    },
  });
}
