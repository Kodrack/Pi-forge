// loop-guard.ts
// Detects and breaks repetition loops using Jaccard similarity.
// Also detects malformed tool call loops (empty/invalid arguments).
//
// --- Write loop detection (Jaccard) ---
// Tracks write/edit tool calls per file path. If the same file is written
// with content similarity > 0.85 (Jaccard on word sets), escalates:
//
//   4 similar writes  → warning steer
//   6 similar writes  → hard block + escape hint
//   3 blocked attempts → abort + compact (clean context, _state.md survives)
//   loops AGAIN after  → abort + double compact (nuclear — near-empty context)
//   STILL loops        → notify user to /clear
//
// --- Malformed tool call detection ---
// Tracks consecutive tool calls with missing/empty required arguments.
// Q2 models sometimes emit {} or omit required fields repeatedly:
//
//   4 consecutive malformed → warning steer with concrete alternative
//   8 consecutive malformed → abort + compact (clear poisoned context)
//   still failing after     → escalate same as write loops
//
// Zero inference cost — pure string math (Set intersection/union).
// Works with any harness (LM Studio, Ollama, vLLM, llama.cpp).
//
// The real fix is proper inference settings (repeat_penalty, temperature).
// This is the safety net for when settings are missing or insufficient.
//
// Install: copy to ~/.pi/agent/extensions/loop-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("loop-guard");
  } catch {
    return true;
  }
}

const SIMILARITY_THRESHOLD = 0.85;
const WARN_COUNT = 4;
const BLOCK_COUNT = 6;
const MAX_HISTORY = 10;

// Malformed tool call thresholds
const MALFORMED_WARN = 4;
const MALFORMED_COMPACT = 8;

interface WriteEntry {
  words: Set<string>;
  turn: number;
}

const fileHistory: Map<string, WriteEntry[]> = new Map();
let currentTurn = 0;
let interventionCount = 0;
let compactCount = 0;
let lastBlockedPath = "";
let recovering = false;
let malformedCount = 0;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-./\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function avgSimilarity(history: WriteEntry[]): number {
  if (history.length < 2) return 0;
  const latest = history[history.length - 1];
  let total = 0;
  const comparisons = history.length - 1;
  for (let i = 0; i < comparisons; i++) {
    total += jaccard(latest.words, history[i].words);
  }
  return total / comparisons;
}

function getEscapeHint(filePath: string): string {
  if (filePath.includes("_state")) {
    return "Your _state.md has not changed in multiple turns. You are stuck. Do something DIFFERENT: read a file, write code, or ask the user for help. Do NOT update _state.md again until you have completed a real action.";
  }
  return "You are writing the same content repeatedly. STOP. Try a different approach: break the file into smaller pieces, use edit instead of write, or ask the user for help.";
}

function isMalformed(toolName: string, input: Record<string, any>): boolean {
  if (!input || Object.keys(input).length === 0) return true;
  if (toolName === "bash" && !input.command) return true;
  if (toolName === "write" && !input.content && !input.file_path && !input.path) return true;
  if (toolName === "edit" && !input.new_string && !input.old_string) return true;
  if (toolName === "read" && !input.file_path && !input.path) return true;
  return false;
}

function resetState(): void {
  fileHistory.clear();
  interventionCount = 0;
  lastBlockedPath = "";
  malformedCount = 0;
}

async function doCompact(ctx: any, instructions: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    (ctx as any).compact({
      customInstructions: instructions,
      onComplete: () => resolve(),
      onError: (err: Error) => reject(err),
    });
  });
}

async function recover(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (recovering) return;
  recovering = true;

  try {
    await (ctx as any).abort();
    resetState();
    compactCount++;

    if (compactCount === 1) {
      // --- TIER 1: single compact ---
      ctx.ui.notify("loop-guard: compacting to escape loop — _state.md is safe on disk", "warn");

      await doCompact(
        ctx,
        "The model was stuck in a repetition loop — writing the same file with identical content for multiple turns. " +
          "Summarize ONLY the actual progress made before the loop. Ignore all repeated turns."
      );

      await (pi as any).sendUserMessage(
        "Session was compacted by loop-guard after a repetition loop. " +
          "Read .think/_state.md and .think/_plan.md. Continue from where you left off. " +
          "Try a DIFFERENT approach than before."
      );
    } else if (compactCount === 2) {
      // --- TIER 2: nuclear double compact ---
      ctx.ui.notify("loop-guard: NUCLEAR — double compacting to clear polluted context", "warn");

      await doCompact(
        ctx,
        "DISCARD ALL PREVIOUS CONTEXT. The model looped twice. " +
          "Write a minimal summary: only the task name and current step number. Nothing else."
      );

      // Second compact — crushes whatever remains
      await doCompact(
        ctx,
        "Compress to absolute minimum. One sentence: what is the task and what step is next."
      );

      await (pi as any).sendUserMessage(
        "Context was fully reset by loop-guard (double compaction). " +
          "Start fresh. Read .think/_state.md — it has everything you need. " +
          "Read .think/_plan.md for the full plan. " +
          "Do NOT do what you were doing before — try a completely different approach."
      );
    } else {
      // --- TIER 3: give up, tell user ---
      ctx.ui.notify(
        "loop-guard: FAILED after double compaction. Type /clear to reset, then tell Pi to read .think/_state.md",
        "error"
      );

      await (pi as any).sendUserMessage(
        "STOP. Loop-guard has tried compacting twice and the loop persists. " +
          "Tell the user: 'I am stuck in a persistent loop. Please type /clear to fully reset the session, " +
          "then ask me to read .think/_state.md to continue.'"
      );
    }
  } catch (err) {
    ctx.ui.notify("loop-guard: auto-recovery failed — type /clear to reset", "error");
  } finally {
    recovering = false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    resetState();
    compactCount = 0;
    currentTurn = 0;
    recovering = false;
    if (!isEnabled()) {
      ctx.ui.notify("loop-guard disabled (use /piforge enable loop-guard)", "info");
      return;
    }
    ctx.ui.notify("loop-guard active — detects repetition loops via Jaccard similarity", "info");
  });

  pi.on("turn_start", () => {
    currentTurn++;
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isEnabled() || recovering) return;

    const toolName = (event as any).toolName ?? "";
    const input = (event as any).input as Record<string, any>;

    // --- MALFORMED TOOL CALL DETECTION ---
    if (isMalformed(toolName, input)) {
      malformedCount++;

      if (malformedCount >= MALFORMED_COMPACT) {
        ctx.ui.notify(`loop-guard: ${malformedCount} consecutive malformed calls — compacting`, "warn");
        setTimeout(() => recover(pi, ctx), 100);
        return;
      }

      if (malformedCount >= MALFORMED_WARN) {
        await pi.sendMessage(
          {
            customType: "malformed_warning",
            content: `[loop-guard] Your last ${malformedCount} tool calls had empty or missing arguments. ` +
              `STOP retrying the same call. Try a different approach: ` +
              `use 'write' or 'edit' instead of 'bash', avoid paths with spaces, ` +
              `keep arguments simple. If you need to run a command, make sure the 'command' field is set.`,
            display: {
              label: "loop-guard",
              content: `${malformedCount} consecutive malformed tool calls`,
            },
          },
          { deliverAs: "steer" }
        );
      }
      return;
    }
    // Valid call — reset malformed counter
    malformedCount = 0;

    if (toolName !== "write" && toolName !== "edit") return;
    const filePath: string = input?.path ?? input?.file_path ?? "";
    const content: string = input?.content ?? input?.new_string ?? "";

    if (!filePath || !content) return;
    if (/step-\d+/.test(filePath)) return;

    // Reset intervention count when model writes a DIFFERENT file
    if (filePath !== lastBlockedPath && lastBlockedPath) {
      interventionCount = 0;
      lastBlockedPath = "";
    }

    const words = tokenize(content);
    const history = fileHistory.get(filePath) ?? [];
    history.push({ words, turn: currentTurn });

    while (history.length > MAX_HISTORY) history.shift();
    fileHistory.set(filePath, history);

    if (history.length < WARN_COUNT) return;

    const similarity = avgSimilarity(history);
    if (similarity <= SIMILARITY_THRESHOLD) return;

    // --- BLOCK ---
    if (history.length >= BLOCK_COUNT) {
      interventionCount++;
      lastBlockedPath = filePath;

      // Escalate to auto-recovery after 3 blocked attempts
      if (interventionCount >= 3) {
        (ctx as any).blockToolCall(
          `[loop-guard] ${interventionCount} interventions failed. Initiating auto-recovery.`
        );
        setTimeout(() => recover(pi, ctx), 100);
        return;
      }

      (ctx as any).blockToolCall(
        `[loop-guard] LOOP DETECTED — you've written "${filePath.split("/").pop()}" ${history.length} times with ${Math.round(similarity * 100)}% similarity. ${getEscapeHint(filePath)}`
      );
      return;
    }

    // --- WARN ---
    await pi.sendMessage(
      {
        customType: "loop_warning",
        content: `[loop-guard] Warning: "${filePath.split("/").pop()}" written ${history.length} times with ${Math.round(similarity * 100)}% similarity. You may be in a loop. Make sure your next action produces DIFFERENT output.`,
        display: {
          label: "loop-guard",
          content: `Warning: ${history.length} similar writes to ${filePath.split("/").pop()} (${Math.round(similarity * 100)}%)`,
        },
      },
      { deliverAs: "steer" }
    );
  });
}
