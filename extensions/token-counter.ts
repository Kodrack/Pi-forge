// token-counter.ts
// Tracks cumulative input AND output tokens across all sessions.
// Never resets — persists to ~/.pi/token-counter.json between sessions.
// Shows cost saved vs Gemini 2.5 Pro pricing:
//   Input:  $1.25 / 1M tokens
//   Output: $10.00 / 1M tokens
//
// Output tokens: estimated from response character count (chars / 4).
// Input tokens:  from ctx.getContextUsage() at turn_end — this is the full
//                context sent to the model each turn (how cloud APIs actually bill).
//
// THROUGHPUT (tok/s) is measured across the DECODE window only — first streamed
// delta to last — not turn wall-clock. A turn includes tool calls, and on
// 2026-07-31 a single `find` blocked a turn for five minutes; charging that to
// the model would have reported ~0.06 tok/s for a model that was never running.
// Prefill is reported separately as ttft (time to first token), which is where a
// large prompt actually costs you: a 24K-token context spends real seconds there
// before a single token appears.
//
// Both are ESTIMATES — output tokens come from chars/4, so treat tok/s as
// indicative, not a benchmark. Use it to spot a change, not to quote a number.
//
// Install: copy to ~/.pi/agent/extensions/token-counter.ts
// Usage:   /tokens

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- PRICING ----------
// Gemini 2.5 Pro (standard tier, ≤200K context)
// https://ai.google.dev/pricing
const PRICE_INPUT_PER_M  = 1.25;   // $ per 1M input tokens
const PRICE_OUTPUT_PER_M = 10.00;  // $ per 1M output tokens

// ---------- PERSISTENCE ----------

const COUNTER_FILE = path.join(os.homedir(), ".pi", "token-counter.json");

// A turn this small is noise: a 3-token reply decoded in 90ms reports a wild
// rate that says nothing and would drag the running average around. Skipped for
// both display and the average.
const MIN_TOKENS_FOR_RATE = 20;
const MIN_DECODE_MS_FOR_RATE = 400;

interface CounterData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  lastUpdated: string;
  // Throughput is accumulated SEPARATELY from totalOutputTokens. Every turn
  // recorded before this feature existed has tokens but no timing, so dividing
  // the lifetime token count by the timed milliseconds would understate the rate
  // permanently. Only turns we actually measured feed the average.
  timedOutputTokens?: number;
  totalDecodeMs?: number;
}

function loadCounter(): CounterData {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
      // migrate old format (totalTokens only) to new format
      if (typeof parsed.totalTokens === "number" && parsed.totalInputTokens === undefined) {
        return {
          totalInputTokens: 0,
          totalOutputTokens: parsed.totalTokens,
          totalSessions: parsed.totalSessions ?? 0,
          lastUpdated: parsed.lastUpdated ?? new Date().toISOString(),
        };
      }
      return parsed;
    }
  } catch {
    // corrupt or missing — start fresh
  }
  return { totalInputTokens: 0, totalOutputTokens: 0, totalSessions: 0, lastUpdated: new Date().toISOString() };
}

function saveCounter(data: CounterData): void {
  try {
    fs.mkdirSync(path.dirname(COUNTER_FILE), { recursive: true });
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // silently ignore
  }
}

// ---------- HELPERS ----------

function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(2)}K`;
  if (usd >= 1)    return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(5)}`;
}

function calcCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * PRICE_INPUT_PER_M
       + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
}

function formatRate(tokens: number, ms: number): string | null {
  if (tokens < MIN_TOKENS_FOR_RATE || ms < MIN_DECODE_MS_FOR_RATE) return null;
  const tps = tokens / (ms / 1000);
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

function formatSeconds(ms: number): string {
  return ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`;
}

// Count all output characters in an assistant message (thinking + text blocks).
function countOutputChars(message: any): number {
  if (!message?.content) return 0;
  return (message.content as any[]).reduce((sum, block) => {
    if (block?.type === "thinking") return sum + (block?.thinking?.length ?? 0);
    if (block?.type === "text")     return sum + (block?.text?.length ?? 0);
    return sum;
  }, 0);
}

// ---------- EXTENSION ----------

export default function (pi: ExtensionAPI) {
  let data = loadCounter();
  let sessionInputTokens  = 0;
  let sessionOutputTokens = 0;
  let sessionTimedTokens  = 0;
  let sessionDecodeMs     = 0;

  // Decode-window timing for the turn in flight.
  let turnStartedAt  = 0;
  let firstDeltaAt   = 0;
  let lastDeltaAt    = 0;

  pi.on("turn_start", async () => {
    turnStartedAt = Date.now();
    firstDeltaAt = 0;
    lastDeltaAt = 0;
  });

  // Stamp the decode window from the stream itself. Both channels count: on a
  // thinking model most of the generated tokens are in the thinking block, and
  // ignoring them would report a rate several times lower than reality.
  pi.on("message_update", async (event: any) => {
    const ae = event?.assistantMessageEvent;
    if (ae?.type !== "text_delta" && ae?.type !== "thinking_delta") return;
    const now = Date.now();
    if (firstDeltaAt === 0) firstDeltaAt = now;
    lastDeltaAt = now;
  });

  pi.on("session_start", async (_event, ctx) => {
    data = loadCounter();
    data.totalSessions += 1;
    saveCounter(data);

    const totalCost = calcCost(data.totalInputTokens, data.totalOutputTokens);
    ctx.ui.notify(
      `token-counter: all-time in=${formatTokens(data.totalInputTokens)} ` +
      `out=${formatTokens(data.totalOutputTokens)} | ` +
      `saved ${formatCost(totalCost)} vs Gemini 2.5 Pro | ` +
      `${data.totalSessions} sessions`,
      "info"
    );
  });

  pi.on("turn_end", async (event, ctx) => {
    // --- output tokens: count from response content ---
    const outChars  = countOutputChars(event.message);
    const outTokens = estimateTokens(outChars);

    // --- input tokens: full context sent to the model this turn ---
    // ctx.getContextUsage().tokens = total tokens currently in context window.
    // This is how cloud APIs bill — the entire history is resent every call.
    const usage     = ctx.getContextUsage();
    const inTokens  = usage?.tokens ?? 0;

    if (outTokens === 0 && inTokens === 0) return;

    sessionInputTokens  += inTokens;
    sessionOutputTokens += outTokens;
    data.totalInputTokens  += inTokens;
    data.totalOutputTokens += outTokens;

    // --- throughput ---
    const decodeMs = firstDeltaAt && lastDeltaAt > firstDeltaAt ? lastDeltaAt - firstDeltaAt : 0;
    const ttftMs   = firstDeltaAt && turnStartedAt ? firstDeltaAt - turnStartedAt : 0;
    const turnRate = formatRate(outTokens, decodeMs);

    if (turnRate) {
      sessionTimedTokens += outTokens;
      sessionDecodeMs    += decodeMs;
      data.timedOutputTokens = (data.timedOutputTokens ?? 0) + outTokens;
      data.totalDecodeMs     = (data.totalDecodeMs ?? 0) + decodeMs;
    }

    data.lastUpdated = new Date().toISOString();
    saveCounter(data);

    const turnCost    = calcCost(inTokens, outTokens);
    const sessionCost = calcCost(sessionInputTokens, sessionOutputTokens);
    const totalCost   = calcCost(data.totalInputTokens, data.totalOutputTokens);
    const avgRate     = formatRate(data.timedOutputTokens ?? 0, data.totalDecodeMs ?? 0);

    ctx.ui.notify(
      `token-counter: turn in=${formatTokens(inTokens)} out=${formatTokens(outTokens)} (${formatCost(turnCost)})` +
      (turnRate ? ` @ ${turnRate} tok/s` : "") +
      (ttftMs > 0 ? ` ttft ${formatSeconds(ttftMs)}` : "") +
      ` | session ${formatCost(sessionCost)} | ` +
      `all-time saved ${formatCost(totalCost)} vs Gemini 2.5 Pro` +
      (avgRate ? ` | avg ${avgRate} tok/s` : ""),
      "info"
    );
  });

  pi.registerCommand("tokens", {
    description: "Show all-time input/output token counts and cost saved vs Gemini 2.5 Pro",
    handler: async (_args, ctx) => {
      const d = loadCounter();
      const sessionCost = calcCost(sessionInputTokens, sessionOutputTokens);
      const totalCost   = calcCost(d.totalInputTokens, d.totalOutputTokens);
      const sessRate    = formatRate(sessionTimedTokens, sessionDecodeMs) ?? "—";
      const allRate     = formatRate(d.timedOutputTokens ?? 0, d.totalDecodeMs ?? 0) ?? "—";
      const timedShare  = d.totalOutputTokens > 0
        ? Math.round(((d.timedOutputTokens ?? 0) / d.totalOutputTokens) * 100)
        : 0;

      ctx.ui.notify(
        `token-counter (vs Gemini 2.5 Pro — in $1.25/1M, out $10/1M)\n` +
        `\n` +
        `  This session\n` +
        `    Input   : ${formatTokens(sessionInputTokens)}\n` +
        `    Output  : ${formatTokens(sessionOutputTokens)}\n` +
        `    Speed   : ${sessRate} tok/s${sessionDecodeMs > 0 ? ` over ${formatSeconds(sessionDecodeMs)} of decoding` : ""}\n` +
        `    Saved   : ${formatCost(sessionCost)}\n` +
        `\n` +
        `  All-time (${d.totalSessions} sessions)\n` +
        `    Input   : ${formatTokens(d.totalInputTokens)}\n` +
        `    Output  : ${formatTokens(d.totalOutputTokens)}\n` +
        `    Speed   : ${allRate} tok/s  (from ${formatTokens(d.timedOutputTokens ?? 0)} timed tokens, ${timedShare}% of output)\n` +
        `    Saved   : ${formatCost(totalCost)}\n` +
        `\n` +
        `  tok/s is decode-window only (first token → last), excluding tool time.\n` +
        `  Output tokens are estimated at chars/4, so treat the rate as indicative.\n` +
        `  Last updated: ${d.lastUpdated}`,
        "info"
      );
    },
  });
}
