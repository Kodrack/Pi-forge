// thinking-guard.ts
// Detects runaway thinking/reasoning blocks and injects a correction steering
// message telling the model to stop overthinking, write conclusions to .think/
// files, and keep responses short.
//
// Works alongside incremental-guard.ts (which covers write/edit tool calls).
// This guard covers the reasoning text itself — the looping that incremental-guard
// can't catch because it never becomes a tool call.
//
// Install: copy to ~/.pi/agent/extensions/thinking-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------- LIMITS (tune these) ----------
const MAX_THINKING_CHARS = 2000;  // ~500 tokens — enough to reason, not enough to spiral
const MAX_THINKING_LINES = 60;    // secondary line-count check

// The correction message injected as a steering message after a long thinking block.
// Mirrors the .think/ workflow from AGENTS.md so the model knows exactly what to do.
const CORRECTION_MESSAGE = `[thinking-guard] Your thinking block was too long — you are overthinking.
STOP the current reasoning chain immediately.

Rules:
1. Write your conclusion (one sentence) to .think/_state.md right now.
2. Do NOT re-reason from scratch — use what you already figured out.
3. Your next response must be under 100 words.
4. If you need more analysis, write it to .think/step-NNN.md — do NOT do it in your head.

The file system is your brain. Use it. Stop holding state in the conversation.`;

// ---------- HELPERS ----------
function getThinkingText(message: any): string {
  if (!message?.content) return "";
  return (message.content as any[])
    .filter((b) => b?.type === "thinking")
    .map((b) => b?.thinking ?? "")
    .join("");
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  // Track thinking chars live during streaming so we can show a warning early.
  // The hard enforcement happens at turn_end (where we can inject steering).
  let liveThinkingChars = 0;
  let liveWarnFired = false;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `thinking-guard active (max ${MAX_THINKING_CHARS} chars / ${MAX_THINKING_LINES} lines of thinking per turn)`,
      "info"
    );
  });

  // Live tracking during streaming — shows a warning when the model is mid-spiral.
  pi.on("message_update", async (event, ctx) => {
    const ae = event.assistantMessageEvent as any;

    if (ae.type === "thinking_start") {
      liveThinkingChars = 0;
      liveWarnFired = false;
    }

    if (ae.type === "thinking_delta") {
      liveThinkingChars += (ae.content as string)?.length ?? 0;

      // Early warning at 80% of the limit — visible in the TUI while streaming.
      if (!liveWarnFired && liveThinkingChars > MAX_THINKING_CHARS * 0.8) {
        liveWarnFired = true;
        ctx.ui.notify(
          `thinking-guard: thinking block approaching limit (${liveThinkingChars} chars so far)…`,
          "warn"
        );
      }
    }
  });

  // Hard enforcement at turn end — inject a steering message if thinking was too long.
  pi.on("turn_end", async (event, ctx) => {
    const thinking = getThinkingText(event.message);
    const chars = thinking.length;
    const lines = thinking.split(/\r?\n/).length;

    // Reset live counter for next turn.
    liveThinkingChars = 0;
    liveWarnFired = false;

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
        `thinking-guard: max ${MAX_THINKING_CHARS} chars / ${MAX_THINKING_LINES} lines per thinking block. ` +
        `Edit ~/.pi/agent/extensions/thinking-guard.ts to change limits, then /reload.`,
        "info"
      );
    },
  });
}
