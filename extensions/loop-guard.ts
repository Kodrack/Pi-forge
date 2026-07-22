// loop-guard.ts
// Detects and breaks repetition loops using Jaccard similarity.
// Also detects malformed tool call loops (empty/invalid arguments).
//
// --- Write loop detection (Jaccard) ---
// Tracks write/edit tool calls per file path. Each write is compared to the
// IMMEDIATELY PREVIOUS write of the same file (consecutive similarity, NOT a
// history average — averaging let legit earlier writes dilute the score so the
// warn tier never fired and blocks came 2× late; proven by replay benchmark).
// A run of consecutive writes with similarity > 0.85 escalates:
//
//   4 similar writes in a row → warning steer
//   6 similar writes in a row → hard block + escape hint
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
// --- Response-text loop detection ---
// Catches the model emitting the SAME response repeatedly without progress
// (e.g. "My bad — I didn't apply anything, let me fix that" 4× while only
// re-reading the same file). The write/malformed detectors miss this entirely
// because reads are valid and nothing is written. Jaccard on assistant output —
// THINKING blocks included: on thinking models (Qwen3.x) the repeated narration
// lives in the thinking channel and the text block is ~2 chars of whitespace on
// tool-call turns (proven by turn_end probe), so text-only extraction sees
// nothing and the detector never fires.
//
//   2 near-identical responses in a row → warning steer
//   4 near-identical responses in a row → abort + compact (break the loop)
//   (recovery at the 4th, not 3rd — thinking text is noisier and compaction
//    is disruptive, so demand one more repeat before pulling that lever)
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
const WARN_COUNT = 4;   // 4 consecutive similar writes to the same file → warn
const BLOCK_COUNT = 6;  // 6 consecutive similar writes → hard block

// Malformed tool call thresholds
const MALFORMED_WARN = 4;
const MALFORMED_COMPACT = 8;

// Response-text loop thresholds
const TEXT_SIMILARITY_THRESHOLD = 0.85;
const TEXT_WARN = 1;      // counter 1 = 2nd near-identical response → warn
const TEXT_RECOVER = 3;   // counter 3 = 4th near-identical response → break it
const MIN_TEXT_LEN = 60;  // ignore trivial/short responses

// Per-file write tracking: last write's word set + how many consecutive writes
// have been similar to their immediate predecessor. Comparing only against the
// previous write (not a history average) is what makes the warn/block counts
// mean what they say.
interface FileTrack {
  lastWords: Set<string>;
  consecutiveSimilar: number; // N means the last N+1 writes were all mutually similar
}

const fileTracks: Map<string, FileTrack> = new Map();
let interventionCount = 0;
let compactCount = 0;
let lastBlockedPath = "";
let recovering = false;
let malformedCount = 0;
let lastTextWords: Set<string> | null = null;
let repeatedTextCount = 0;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\-./\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

// Extract the model's output for loop comparison — thinking AND text blocks.
// On thinking models the narration lives in `thinking`; the `text` block on
// tool-call turns is often just whitespace, so text-only extraction is blind.
function extractText(message: any): string {
  if (!message?.content) return "";
  return (message.content as any[])
    .filter((b) => b?.type === "text" || b?.type === "thinking")
    .map((b) => b?.text ?? b?.thinking ?? "")
    .join(" ")
    .trim();
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
  fileTracks.clear();
  interventionCount = 0;
  lastBlockedPath = "";
  malformedCount = 0;
  lastTextWords = null;
  repeatedTextCount = 0;
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
    recovering = false;
    if (!isEnabled()) {
      ctx.ui.notify("loop-guard disabled (use /piforge enable loop-guard)", "info");
      return;
    }
    ctx.ui.notify("loop-guard active — detects repetition loops via Jaccard similarity", "info");
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
    const track = fileTracks.get(filePath);
    const similarity = track ? jaccard(words, track.lastWords) : 0;
    const consecutiveSimilar =
      track && similarity > SIMILARITY_THRESHOLD ? track.consecutiveSimilar + 1 : 0;
    fileTracks.set(filePath, { lastWords: words, consecutiveSimilar });

    // consecutiveSimilar = N means the last N+1 writes were all mutually similar.
    const similarRun = consecutiveSimilar + 1;
    if (similarRun < WARN_COUNT) return;

    // --- BLOCK ---
    if (similarRun >= BLOCK_COUNT) {
      interventionCount++;
      lastBlockedPath = filePath;

      // Escalate to auto-recovery after 3 blocked attempts
      if (interventionCount >= 3) {
        setTimeout(() => recover(pi, ctx), 100);
        return {
          block: true,
          reason: `[loop-guard] ${interventionCount} interventions failed. Initiating auto-recovery.`,
        };
      }

      return {
        block: true,
        reason: `[loop-guard] LOOP DETECTED — you've written "${filePath.split("/").pop()}" ${similarRun} times in a row with ${Math.round(similarity * 100)}% similarity. ${getEscapeHint(filePath)}`,
      };
    }

    // --- WARN ---
    await pi.sendMessage(
      {
        customType: "loop_warning",
        content: `[loop-guard] Warning: "${filePath.split("/").pop()}" written ${similarRun} times in a row with ${Math.round(similarity * 100)}% similarity. You may be in a loop. Make sure your next action produces DIFFERENT output.`,
        display: {
          label: "loop-guard",
          content: `Warning: ${similarRun} consecutive similar writes to ${filePath.split("/").pop()} (${Math.round(similarity * 100)}%)`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  // --- RESPONSE-TEXT LOOP DETECTION ---
  // Catches the model repeating the same response without progress (e.g.
  // "My bad — I didn't apply anything, let me fix that" 4× while only re-reading
  // a file). The write/malformed detectors miss this because reads are valid and
  // nothing is written.
  pi.on("turn_end", async (event: any, ctx: any) => {
    if (!isEnabled() || recovering) return;

    const text = extractText(event.message);
    if (text.length < MIN_TEXT_LEN) return; // ignore trivial/short responses

    const words = tokenize(text);
    const sim = lastTextWords ? jaccard(words, lastTextWords) : 0;
    if (lastTextWords && sim > TEXT_SIMILARITY_THRESHOLD) {
      repeatedTextCount++;
    } else {
      repeatedTextCount = 0;
    }
    lastTextWords = words;

    // 3rd near-identical response in a row → break the loop
    if (repeatedTextCount >= TEXT_RECOVER) {
      ctx.ui.notify(
        `loop-guard: same response ${repeatedTextCount + 1}× in a row with no progress — compacting to break loop`,
        "warn"
      );
      setTimeout(() => recover(pi, ctx), 100);
      return;
    }

    // 2nd near-identical response → warn
    if (repeatedTextCount >= TEXT_WARN) {
      await pi.sendMessage(
        {
          customType: "text_loop_warning",
          content:
            `[loop-guard] You've given nearly the same response ${repeatedTextCount + 1} turns in a row without making progress. ` +
            `STOP repeating. Take a concrete DIFFERENT action now (write/edit a file), or stop and ask the user. ` +
            `Do NOT restate the same intention again.`,
          display: {
            label: "loop-guard",
            content: `Repeated response ${repeatedTextCount + 1}× — possible loop`,
          },
        },
        { deliverAs: "steer" }
      );
    }
  });
}
