// progress-checkpoint.ts
// Periodically forces the model to answer "done or not?" WITH A FILE WRITE.
//
// The gap this fills: every completion mechanism in PiForge reacts to the model
// writing "## Status: complete" — acceptance-guard verifies it, completion-guard
// enforces stopping after it. Nothing happens if the model never declares
// anything. The 2026-07-26 regex trace is that case: one turn, 29,781 chars of
// thinking, ZERO tool calls, no declaration, so no guard had anything to react
// to. The model had reached the right answer twice and simply never committed.
//
// So this checkpoints on a cadence, but only when the session has actually
// STALLED — if files changed since the last checkpoint, the model is working and
// is left alone. A stalled session gets a forced choice:
//   (a) done      → write Status: complete  (acceptance-guard then verifies it)
//   (b) not done  → write the ONE next action and do it
// Both branches END IN A TOOL CALL. That is the point: a yes/no question invites
// a prose answer, which is just another turn with no output. Asking "are you
// done?" is only safe because acceptance-guard runs the test — a model that
// answers yes to escape the question gets blocked with the real failure.
//
// CONTEXT COST is the design constraint. A steer is permanent context, so
// repeated nagging is self-defeating on a 50k-context local model. Three things
// keep it cheap:
//   1. The progress gate — a working model never sees a checkpoint at all.
//   2. Full instructions ONCE, then a ~150-char reminder (not ~1200 again).
//   3. Exponential backoff, and after MAX_MODEL_CHECKPOINTS consecutive ignored
//      checkpoints it stops talking to the model entirely and notifies the HUMAN
//      instead — zero context cost. A model that ignored two checkpoints will
//      not act on the fifth; that is a person's problem to fix.
//
// Deliberately NOT a blocker: the model may be legitimately mid-task, and
// blocking a tool call would be wrong. This steers.
//
// Install: copy to ~/.pi/agent/extensions/progress-checkpoint.ts
// Toggle:  /piforge disable progress-checkpoint | /piforge enable progress-checkpoint

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// Turn number of the FIRST checkpoint. Deliberately late: the incremental
// workflow (skeleton + many small edits) burns turns fast, so an early
// checkpoint would interrupt normal work.
const FIRST_CHECKPOINT_TURN = 30;

// Base turns between checkpoints. Doubles on each consecutive ignored one.
const CHECKPOINT_INTERVAL = 20;

// After this many CONSECUTIVE ignored checkpoints, stop steering the model and
// notify the human instead. Keeps model-facing context cost to roughly one full
// message plus one short reminder per stalled session.
const MAX_MODEL_CHECKPOINTS = 2;

// File extensions that count as real work (mirrors execution-guard, plus docs —
// a session legitimately spending turns on README/config is not stalled).
const CODE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt|json|md|html|css|yml|yaml|toml)$/i;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("progress-checkpoint");
  } catch {
    return true;
  }
}

// Work outside .think/ counts as progress; the model's own notes do not.
function isWorkPath(filePath: string): boolean {
  if (!filePath) return false;
  if (filePath.includes(".think/") || filePath.includes(".think\\")) return false;
  return CODE_EXTENSIONS.test(filePath);
}

function bashWritesWork(command: string): boolean {
  const m = command.match(/>>?\s*([^\s;|&]+)/);
  return !!m && isWorkPath(m[1]);
}

// Already declared complete → nothing to checkpoint (completion-guard owns the
// after-done behavior from here).
function taskMarkedComplete(cwd: string): boolean {
  try {
    const content = fs.readFileSync(path.join(cwd, ".think", "_state.md"), "utf-8");
    const m = content.match(/##\s*Status:\s*([^\n]+)/i);
    return !!m && /\b(complete|completed|done|finished)\b/i.test(m[1]);
  } catch {
    return false;
  }
}

// Sent once per stalled session — teaches the forced choice.
const CHECKPOINT_FULL =
  `[progress-checkpoint] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
  `CHECKPOINT: no file outside .think/ has changed in a while — this session has stalled.\n\n` +
  `Read .think/_state.md now, then pick exactly ONE and DO IT THIS TURN:\n` +
  `(a) The task IS complete → write "## Status: complete" to .think/_state.md. ` +
  `The harness will run your .think/_acceptance.sh to confirm, so only choose this if the code really works.\n` +
  `(b) NOT complete → write the ONE next concrete action to .think/_state.md ` +
  `(a specific file and a specific change, not "continue implementing"), then perform it.\n\n` +
  `Rules:\n` +
  `1. Do NOT reply with analysis, a plan, or a status report — your next output must be a TOOL CALL.\n` +
  `2. If you already worked out the approach, stop re-evaluating it and implement it.\n` +
  `3. If you are stuck on a decision, pick the option you already called best and commit. ` +
  `A working first version beats a perfect undecided one.`;

// Every later checkpoint — the full rules are already in context above, so this
// only needs to re-assert the demand. ~1/8th the size.
const CHECKPOINT_TERSE =
  `[progress-checkpoint] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
  `CHECKPOINT: still no file changes. Per the earlier checkpoint: write "## Status: complete", ` +
  `or write the ONE next action to .think/_state.md and do it. Tool call only — no prose.`;

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let turnCount = 0;
  // Turn number of the next scheduled evaluation.
  let nextCheckpointTurn = FIRST_CHECKPOINT_TURN;
  // Consecutive checkpoints that produced no work — drives backoff and handoff.
  let consecutiveIgnored = 0;
  let totalFired = 0;
  let handedToHuman = false;
  // Did any real work land since the last checkpoint evaluation?
  let workSinceLastCheckpoint = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `progress-checkpoint active — stalled-session check at turn ${FIRST_CHECKPOINT_TURN}, then every ` +
        `${CHECKPOINT_INTERVAL} (skipped while files change; hands off to you after ${MAX_MODEL_CHECKPOINTS} ignored)`,
      "info"
    );
  });

  // Count real work at CALL time as well as result time: a blocked write still
  // means the model is trying to make progress, and the same parallel-call
  // ordering that bit execution-guard applies here.
  pi.on("tool_call", async (event: any, _ctx: any) => {
    const toolName = event.toolName ?? "";
    const input = (event.input as Record<string, any>) ?? {};
    if (toolName === "write" || toolName === "edit") {
      if (isWorkPath(input.path ?? input.file_path ?? "")) workSinceLastCheckpoint = true;
      return;
    }
    if (toolName === "bash" && bashWritesWork(String(input.command ?? ""))) {
      workSinceLastCheckpoint = true;
    }
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    turnCount++;
    if (turnCount < nextCheckpointTurn) return;

    // Schedule the next evaluation before any early return, so a skipped
    // checkpoint doesn't re-fire on every subsequent turn.
    const scheduleNext = (ignored: boolean) => {
      consecutiveIgnored = ignored ? consecutiveIgnored + 1 : 0;
      // Back off exponentially while ignored; return to base once work resumes.
      const interval = CHECKPOINT_INTERVAL * Math.pow(2, consecutiveIgnored > 0 ? consecutiveIgnored - 1 : 0);
      nextCheckpointTurn = turnCount + interval;
      workSinceLastCheckpoint = false;
    };

    // Already declared done — completion-guard and acceptance-guard take over.
    if (taskMarkedComplete(ctx.cwd)) {
      scheduleNext(false);
      return;
    }

    // Files are changing → the model is working. Never interrupt progress, and
    // this does not count as ignoring a checkpoint.
    if (workSinceLastCheckpoint) {
      scheduleNext(false);
      return;
    }

    // Stalled. Past the model-facing budget, this costs the model nothing: tell
    // the human and stop injecting context.
    if (consecutiveIgnored >= MAX_MODEL_CHECKPOINTS) {
      handedToHuman = true;
      scheduleNext(true);
      ctx.ui.notify(
        `progress-checkpoint: STALLED at turn ${turnCount} — ${consecutiveIgnored} checkpoints ignored, ` +
          `no file changes. Not steering again (it would only burn context). Your call: give it a concrete ` +
          `instruction, or /checkpoint now to force another.`,
        "warn"
      );
      return;
    }

    totalFired++;
    const first = totalFired === 1;
    scheduleNext(true);
    ctx.ui.notify(
      `progress-checkpoint: turn ${turnCount}, no file changes since last check — asking for ` +
        `done-or-next-action (${first ? "full" : "short"} message, ${totalFired}/${MAX_MODEL_CHECKPOINTS})`,
      "warn"
    );
    await pi.sendMessage(
      {
        customType: "progress_checkpoint",
        content: first ? CHECKPOINT_FULL : CHECKPOINT_TERSE,
        display: {
          label: "progress-checkpoint",
          content: `Turn ${turnCount}: stalled — demanding "done" or a concrete next action`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  pi.registerCommand("checkpoint", {
    description: "Show progress-checkpoint status, or force a checkpoint now",
    handler: async (args: any, ctx: any) => {
      if (String(args ?? "").trim() === "now") {
        totalFired++;
        await pi.sendMessage(
          {
            customType: "progress_checkpoint",
            content: totalFired === 1 ? CHECKPOINT_FULL : CHECKPOINT_TERSE,
            display: { label: "progress-checkpoint", content: "Manual checkpoint (/checkpoint now)" },
          },
          { deliverAs: "steer" }
        );
        ctx.ui.notify("progress-checkpoint: checkpoint injected for the next turn.", "info");
        return;
      }

      ctx.ui.notify(
        `progress-checkpoint: turn ${turnCount} | next check at turn ${nextCheckpointTurn} | ` +
          `fired ${totalFired} (${consecutiveIgnored} consecutive ignored)` +
          `${handedToHuman ? " | HANDED TO YOU — no longer steering" : ""} | ` +
          `${workSinceLastCheckpoint ? "files HAVE changed since last check (will skip)" : "no file changes since last check (will fire)"} | ` +
          `task ${taskMarkedComplete(ctx.cwd) ? "marked complete" : "in progress"}. ` +
          `'/checkpoint now' to force one.`,
        "info"
      );
    },
  });
}
