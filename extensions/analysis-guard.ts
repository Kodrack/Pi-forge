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

// ---------- THRESHOLDS ----------
// Minimum response text length to be considered "analysis worth saving".
// Short answers (<500 chars) are not worth forcing a file write.
const MIN_ANALYSIS_CHARS = 1000;

// ---------- STEERING MESSAGE ----------
const CORRECTION_MESSAGE = `[analysis-guard] You just gave a long analysis but did not write it to disk.
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

  // Track write/edit tool calls within the current turn.
  pi.on("tool_call", async (event, _ctx) => {
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
