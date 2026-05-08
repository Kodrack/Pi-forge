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

interface CounterData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  lastUpdated: string;
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
    data.lastUpdated = new Date().toISOString();
    saveCounter(data);

    const turnCost    = calcCost(inTokens, outTokens);
    const sessionCost = calcCost(sessionInputTokens, sessionOutputTokens);
    const totalCost   = calcCost(data.totalInputTokens, data.totalOutputTokens);

    ctx.ui.notify(
      `token-counter: turn in=${formatTokens(inTokens)} out=${formatTokens(outTokens)} (${formatCost(turnCost)}) | ` +
      `session ${formatCost(sessionCost)} | ` +
      `all-time saved ${formatCost(totalCost)} vs Gemini 2.5 Pro`,
      "info"
    );
  });

  pi.registerCommand("tokens", {
    description: "Show all-time input/output token counts and cost saved vs Gemini 2.5 Pro",
    handler: async (_args, ctx) => {
      const d = loadCounter();
      const sessionCost = calcCost(sessionInputTokens, sessionOutputTokens);
      const totalCost   = calcCost(d.totalInputTokens, d.totalOutputTokens);

      ctx.ui.notify(
        `token-counter (vs Gemini 2.5 Pro — in $1.25/1M, out $10/1M)\n` +
        `\n` +
        `  This session\n` +
        `    Input   : ${formatTokens(sessionInputTokens)}\n` +
        `    Output  : ${formatTokens(sessionOutputTokens)}\n` +
        `    Saved   : ${formatCost(sessionCost)}\n` +
        `\n` +
        `  All-time (${d.totalSessions} sessions)\n` +
        `    Input   : ${formatTokens(d.totalInputTokens)}\n` +
        `    Output  : ${formatTokens(d.totalOutputTokens)}\n` +
        `    Saved   : ${formatCost(totalCost)}\n` +
        `\n` +
        `  Last updated: ${d.lastUpdated}`,
        "info"
      );
    },
  });
}
