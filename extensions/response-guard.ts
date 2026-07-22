// response-guard.ts
// Detects verbose responses (reasoning dumps) and injects correction.
// Catches LLMs that ignore "keep it short" rules and dump their thinking as regular output.
//
// KNOWN LIMITATIONS (verified by live probe, 2026-07-22 — kept as-is by user decision):
// 1. The tool-call exemption below checks `b.type === "tool_use"` (Anthropic API
//    naming). Pi's assistant message blocks use `type: "toolCall"`, so the check
//    never matches — every turn is treated as having no tool calls.
// 2. thinking-guard hard-aborts ANY text stream at 4000 chars, so the 20000-char
//    threshold here is unreachable while thinking-guard is enabled. This guard
//    only matters as a backstop in sessions where thinking-guard is disabled.
//
// Install: copy to ~/.pi/agent/extensions/response-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_RESPONSE_CHARS = 20000; // ~5k tokens (4 chars per token)
const MAX_RESPONSE_LINES = 500;

const CORRECTION_MESSAGE = `[response-guard] Your response exceeded 5000 tokens. You're reasoning out loud instead of acting.

STOP. Do not continue.

What went wrong:
- You wrote thousands of words of analysis in the chat
- This wastes tokens and pollutes context
- The user doesn't need your internal reasoning

What to do now:
1. If you have useful findings, write them to .think/step-NNN.md
2. Your next response must be a tool call or a SHORT status update (under 100 words)
3. Act, don't explain.`;

export default function (pi: ExtensionAPI) {
  let responseChars = 0;
  let responseLines = 0;
  let warnFired = false;

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `response-guard active (max ${MAX_RESPONSE_CHARS} chars / ${MAX_RESPONSE_LINES} lines per response)`,
      "info"
    );
  });

  // Track response length during streaming
  pi.on("message_update", async (event, ctx) => {
    const ae = event.assistantMessageEvent as any;

    if (ae.type === "text_start") {
      responseChars = 0;
      responseLines = 0;
      warnFired = false;
    }

    if (ae.type === "text_delta") {
      const text = (ae.content as string) ?? "";
      responseChars += text.length;
      responseLines += (text.match(/\n/g) || []).length;

      // Early warning at 80% of limit
      if (!warnFired && (responseChars > MAX_RESPONSE_CHARS * 0.8 || responseLines > MAX_RESPONSE_LINES * 0.8)) {
        warnFired = true;
        ctx.ui.notify(
          `response-guard: response getting long (${responseChars} chars, ${responseLines} lines)...`,
          "warn"
        );
      }
    }
  });

  // Inject correction at turn end if response was too long
  pi.on("turn_end", async (event, ctx) => {
    const msg = event.message as any;

    // Check if there were any tool calls — if so, verbose text is acceptable.
    // NOTE: "tool_use" never matches — Pi uses type "toolCall" (see header note).
    const hasToolCalls = msg?.content?.some((b: any) => b.type === "tool_use");
    if (hasToolCalls) {
      responseChars = 0;
      responseLines = 0;
      return;
    }

    // No tool calls + long response = reasoning dump
    if (responseChars > MAX_RESPONSE_CHARS || responseLines > MAX_RESPONSE_LINES) {
      ctx.ui.notify(
        `response-guard: response was ${responseChars} chars / ${responseLines} lines with no tool calls. Injecting correction.`,
        "warn"
      );

      await pi.sendMessage(
        {
          customType: "response_guard_correction",
          content: CORRECTION_MESSAGE,
          display: {
            label: "response-guard",
            content: `Response too long (${responseChars} chars). Correction injected.`,
          },
        },
        { deliverAs: "steer" }
      );
    }

    responseChars = 0;
    responseLines = 0;
  });
}
