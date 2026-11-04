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
import * as os from "os";

// ---------- THRESHOLDS ----------
// Minimum response text length to be considered "analysis worth saving".
// Short answers (<500 chars) are not worth forcing a file write.
const MIN_ANALYSIS_CHARS = 1000;

// Dory's chat/plan/respond jobs are read-only and their deliverable IS a long
// text block (the <<<BRIEF>>>/<<<TEST>>> marker payload). Nagging them to save
// it to .think/step-NNN.md is both impossible (dory-plan-guard blocks the
// write) and harmful: on 2026-07-25 that steer is what turned the T-006 plan
// job into an implementation run. Kinds from dory.mjs: chat|respond|plan|exec.
const DORY_READONLY_KINDS = ["research", "chat", "plan", "respond", "wave"];
const DORY_RUNNER_STATE = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");

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
// The Dory stage this session runs, or null. DORY_STAGE (env) for headless
// `pi -p` jobs, dory-runner.json for in-session /dory jobs — the latter only
// when `pid` matches, since that file is one global slot and a record left by a
// killed session would otherwise silence this guard in every later session.
function doryReadonlyStage(): string | null {
  let kind: string | null = process.env.DORY_STAGE ? String(process.env.DORY_STAGE) : null;
  if (!kind) {
    try {
      const state = JSON.parse(fs.readFileSync(DORY_RUNNER_STATE, "utf-8"));
      kind = state?.running && state?.job?.kind && state.pid === process.pid ? String(state.job.kind) : null;
    } catch {
      kind = null;
    }
  }
  return kind !== null && DORY_READONLY_KINDS.includes(kind) ? kind : null;
}

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
    const dory = doryReadonlyStage();
    ctx.ui.notify(
      dory
        ? `analysis-guard: standing down (dory ${dory} job — the response text IS the deliverable)`
        : `analysis-guard active (triggers on responses >${MIN_ANALYSIS_CHARS} chars with no file write)`,
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
    // Checked per turn, not once per session: dory-mode runs consecutive jobs
    // (different kinds) in ONE session from the second job onward, so a stage
    // captured at session_start would be the previous job's.
    if (doryReadonlyStage()) {
      turnHadFileWrite = false;
      return;
    }
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
