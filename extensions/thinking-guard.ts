// thinking-guard.ts
// Detects runaway thinking/reasoning AND runaway response text, and stops it.
//
// Two layers:
//   1. LIVE mid-stream HARD ABORT — watches BOTH the thinking channel
//      (thinking_delta) and the response-text channel (text_delta) as they
//      stream. If either blows past HARD_ABORT_CHARS, it calls ctx.abort() to
//      KILL the generation immediately (catches verbatim-repetition spirals that
//      would otherwise run to the token cap), then steers "commit and think
//      briefly". This is the only thing that can stop a single runaway
//      generation — every other guard acts only at turn boundaries.
//      A second, cumulative PER-TURN cap (TURN_ABORT_CHARS) covers the case the
//      per-block cap can't: output split across many alternating blocks, each
//      individually under the block cap. Observed evasion: 28-30k-char code
//      dumps streamed as small blocks (2026-07-23 hard benchmark).
//   2. turn_end soft steer — if a (non-aborted) thinking block exceeded the
//      softer MAX_THINKING_CHARS, steer the NEXT turn to think less.
//
// The text-channel coverage matters: a spiral emitted as plain response text
// (not inside a <thinking> block) is invisible to thinking-only checks.
//
// Works alongside incremental-guard.ts (write/edit) and loop-guard.ts
// (cross-turn repetition). The real prevention is inference settings
// (repeat_penalty) — this is the safety net.
//
// Install: copy to ~/.pi/agent/extensions/thinking-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- LIMITS (tune these) ----------
const MAX_THINKING_CHARS = 15000;  // ~3.75k tokens — soft, steers next turn
const MAX_THINKING_LINES = 375;    // secondary line-count check

// Hard mid-stream abort cap, applied to EITHER channel's live char count.
// 4000 chars ≈ 1k tokens ≈ ~650 words — already well past a normal short
// response, so a runaway gets killed fast. NOTE: this will also clip a
// genuinely long answer (e.g. a detailed research write-up) mid-stream.
const HARD_ABORT_CHARS = 4000;

// Cumulative per-TURN abort cap, counted across ALL thinking and text blocks
// in the turn (reset only at turn boundaries). The per-block cap above resets
// on every thinking_start/text_start, so output that streams as MANY blocks —
// which is how every thinking-capable model emits (think → text → think → …) —
// can run to the token cap while each block stays under 4000 chars. Verified
// in the 2026-07-23 hard benchmark: four sessions ended in 21,720–30,621-char
// single-turn code dumps that the per-block abort never saw. Must sit ABOVE
// MAX_THINKING_CHARS so the soft steer stays the first line of defense.
const TURN_ABORT_CHARS = 20000;

// The correction message injected as a steering message after a long thinking block.
// Mirrors the .think/ workflow from AGENTS.md so the model knows exactly what to do.
const CORRECTION_MESSAGE = `[thinking-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
Your thinking block was too long — you are overthinking.
STOP the current reasoning chain immediately.

Rules:
1. Write your conclusion (one sentence) to .think/_state.md right now.
2. Do NOT re-reason from scratch — use what you already figured out.
3. Your next response must be under 100 words.
4. If you need more analysis, write it to .think/step-NNN.md — do NOT do it in your head.

The file system is your brain. Use it. Stop holding state in the conversation.`;

// Dory's chat/plan/respond jobs are the one case where a long TEXT stream is
// the point: the whole deliverable is the <<<BRIEF>>>/<<<TEST>>> marker block
// the board parses, and a brief with a real acceptance test runs well past
// HARD_ABORT_CHARS. Aborting it mid-stream loses the plan (the card never
// moves), so those stages get raised TEXT caps. The thinking channel keeps the
// normal caps — a runaway there is still a runaway. Kinds from dory.mjs:
// chat | respond | plan | exec (exec is a normal coding session).
const DORY_READONLY_KINDS = ["research", "chat", "plan", "respond", "wave"];
const DORY_RUNNER_STATE = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");
const DORY_TEXT_ABORT_CHARS = 24000;  // per text block, dory marker deliverable
const DORY_TURN_ABORT_CHARS = 40000;  // cumulative per turn, dory marker deliverable

// ---------- HELPERS ----------
// The Dory stage this session runs, or null. DORY_STAGE (env) for headless
// `pi -p` jobs, dory-runner.json for in-session /dory jobs — honored only when
// `pid` matches, so a record left behind by a killed /dory session can never
// relax the caps in an unrelated session.
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

function getThinkingText(message: any): string {
  if (!message?.content) return "";
  return (message.content as any[])
    .filter((b) => b?.type === "thinking")
    .map((b) => b?.thinking ?? "")
    .join("");
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  // Live char counts per channel during streaming.
  let liveThinkingChars = 0;
  let liveTextChars = 0;
  // Cumulative streamed chars this TURN (both channels; NOT reset per block).
  let turnStreamChars = 0;
  let liveWarnFired = false;
  let abortedThisTurn = false;

  // Re-resolved at every BLOCK boundary (thinking_start / text_start), not once
  // per session: from the second job onward dory-mode runs consecutive jobs — of
  // different kinds — in ONE session, so caps captured at session_start would
  // belong to the previous job (and would leave an exec job with a planner's
  // relaxed caps). Per-block is cheap; per-delta would be an fs read per token.
  let doryStage: string | null = doryReadonlyStage();
  let textAbortChars = doryStage ? DORY_TEXT_ABORT_CHARS : HARD_ABORT_CHARS;
  let turnAbortChars = doryStage ? DORY_TURN_ABORT_CHARS : TURN_ABORT_CHARS;

  function resolveCaps(): void {
    doryStage = doryReadonlyStage();
    textAbortChars = doryStage ? DORY_TEXT_ABORT_CHARS : HARD_ABORT_CHARS;
    turnAbortChars = doryStage ? DORY_TURN_ABORT_CHARS : TURN_ABORT_CHARS;
  }

  // Kill a runaway generation mid-stream and steer the model to think briefly.
  async function abortRunaway(ctx: any, channel: string, chars: number): Promise<void> {
    abortedThisTurn = true;
    try { ctx.abort(); } catch {}
    ctx.ui.notify(`thinking-guard: ABORTED runaway ${channel} (${chars} chars) — likely a loop/overthinking`, "warn");
    await pi.sendMessage(
      {
        customType: "output_guard_abort",
        content:
          `[thinking-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
          `Your ${channel} ran past ${chars} characters without finishing — you were looping/overthinking, ` +
          `so the generation was STOPPED.\n\n` +
          `Do NOT re-derive what you already wrote. Instead:\n` +
          `1. Pick ONE interpretation and commit to it.\n` +
          `2. Write a one-sentence conclusion to .think/_state.md.\n` +
          `3. Take a concrete next action (write/edit a file) OR ask the user ONE clarifying question.\n` +
          `4. Keep your next response under 100 words. Think briefly — short thinking beats long thinking.`,
        display: { label: "thinking-guard", content: `Aborted runaway ${channel} (${chars} chars)` },
      },
      { deliverAs: "steer" }
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `thinking-guard active (soft ${MAX_THINKING_CHARS} chars/turn, hard abort at ${HARD_ABORT_CHARS}/block thinking + ` +
      `${textAbortChars}/block text + ${turnAbortChars}/turn` +
      `${doryStage ? ` — text caps raised for the dory ${doryStage} deliverable` : ""})`,
      "info"
    );
  });

  // Live mid-stream tracking — warns early, and HARD-ABORTS either channel if it runs away.
  pi.on("message_update", async (event, ctx) => {
    const ae = event.assistantMessageEvent as any;

    if (ae.type === "thinking_start") { liveThinkingChars = 0; liveWarnFired = false; resolveCaps(); }
    if (ae.type === "text_start") { liveTextChars = 0; resolveCaps(); }

    if (ae.type === "thinking_delta") {
      const len = (ae.content as string)?.length ?? 0;
      liveThinkingChars += len;
      turnStreamChars += len;
      if (!liveWarnFired && liveThinkingChars > MAX_THINKING_CHARS * 0.8) {
        liveWarnFired = true;
        ctx.ui.notify(`thinking-guard: thinking approaching limit (${liveThinkingChars} chars)…`, "warn");
      }
      if (!abortedThisTurn && liveThinkingChars > HARD_ABORT_CHARS) {
        await abortRunaway(ctx, "thinking", liveThinkingChars);
      }
      // Per-turn cumulative cap: catches many-small-blocks runaways that the
      // per-block cap (reset on every block start) never sees.
      if (!abortedThisTurn && turnStreamChars > turnAbortChars) {
        await abortRunaway(ctx, "turn output (cumulative)", turnStreamChars);
      }
    }

    // The channel that was invisible before: runaway plain response text.
    if (ae.type === "text_delta") {
      const len = (ae.content as string)?.length ?? 0;
      liveTextChars += len;
      turnStreamChars += len;
      if (!abortedThisTurn && liveTextChars > textAbortChars) {
        await abortRunaway(ctx, "response text", liveTextChars);
      }
      if (!abortedThisTurn && turnStreamChars > turnAbortChars) {
        await abortRunaway(ctx, "turn output (cumulative)", turnStreamChars);
      }
    }
  });

  // Hard enforcement at turn end — inject a steering message if thinking was too long.
  pi.on("turn_end", async (event, ctx) => {
    const wasAborted = abortedThisTurn;

    // Reset live counters for next turn.
    liveThinkingChars = 0;
    liveTextChars = 0;
    turnStreamChars = 0;
    liveWarnFired = false;
    abortedThisTurn = false;

    // Already steered via mid-stream abort — don't double up.
    if (wasAborted) return;

    const thinking = getThinkingText(event.message);
    const chars = thinking.length;
    const lines = thinking.split(/\r?\n/).length;

    if (chars <= MAX_THINKING_CHARS && lines <= MAX_THINKING_LINES) return;

    ctx.ui.notify(
      `thinking-guard: thinking block was ${chars} chars / ${lines} lines ` +
      `(limit ${MAX_THINKING_CHARS} chars / ${MAX_THINKING_LINES} lines). ` +
      `Injecting correction steering message.`,
      "warn"
    );

    // Inject as a steering message — delivered to the model before its next LLM call.
    // The model sees this as a system-level correction and must respond to it.
    await pi.sendMessage(
      {
        customType: "thinking_guard_correction",
        content: CORRECTION_MESSAGE,
        display: {
          label: "thinking-guard",
          content: `Thinking too long (${chars} chars). Correction injected.`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  // /thinking-guard command — show current limits at runtime.
  pi.registerCommand("thinking-guard", {
    description: "Show thinking-guard limits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `thinking-guard: soft ${MAX_THINKING_CHARS} chars / ${MAX_THINKING_LINES} lines per turn; ` +
        `hard abort ${HARD_ABORT_CHARS} chars/block thinking, ${textAbortChars} chars/block text, ` +
        `${turnAbortChars} chars cumulative/turn` +
        `${doryStage ? ` (text caps raised: dory ${doryStage} job)` : ""}. ` +
        `Edit ~/.pi/agent/extensions/thinking-guard.ts to change limits, then /reload.`,
        "info"
      );
    },
  });
}
