// context-monitor.ts
// Watches context token usage after each turn and injects steering messages
// telling the model to write state to .think/ files before context degrades.
//
// Two thresholds:
//   WARN_PERCENT  (65%) — "start writing state now, while you're still coherent"
//   FORCE_COMPACT_PERCENT (80%) — force compaction with aggressive summarization
//
// After each compaction, workflow rules are re-injected: the full AGENTS.md
// every FULL_AGENTS_EVERY-th compaction, a ~250-token condensed digest in
// between (set FULL_AGENTS_EVERY = 1 for full AGENTS.md every time).
//
// Install: copy to ~/.pi/agent/extensions/context-monitor.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// The PiForge workflow contract lives at ~/.pi/agent/AGENTS.md
// (copied there by install.sh, symlinked to the repo by dev-link.sh).
// A project-local AGENTS.md is optional, holds project-specific rules, and is
// ALWAYS injected in full alongside the contract (even on digest compactions).
function readFileOrNull(p: string): string | null {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

function readGlobalAgentsMd(): string | null {
  return readFileOrNull(path.join(os.homedir(), ".pi", "agent", "AGENTS.md"));
}

function readProjectAgentsMd(): string | null {
  return readFileOrNull(path.join(process.cwd(), "AGENTS.md"));
}

// ---------- THRESHOLDS ----------
const WARN_PERCENT   = 65;   // warning — write state now
const FORCE_COMPACT_PERCENT = 80; // force compaction — no warning, just compact

// How often the FULL AGENTS.md is re-injected after compaction.
// 1 = full AGENTS.md every compaction (legacy behavior).
// 4 = full on compaction 1, 5, 9, ... — condensed digest (~250 tokens) in between.
const FULL_AGENTS_EVERY = 4;

// Sent to the compaction summarizer — keeps the summary tiny since durable
// state lives in .think/ on disk, but protects findings not yet written there.
const COMPACT_INSTRUCTIONS =
  "Compress aggressively. Do NOT reproduce file contents, tool outputs, or step-by-step reasoning — " +
  "all durable state lives in .think/ files on disk. Keep ONLY: the task one-liner, files modified " +
  "this session, and any finding or error NOT yet written to a .think/ file. Target under 500 tokens.";

// Condensed AGENTS.md — the load-bearing rules only. Injected after compactions
// where the full AGENTS.md is skipped.
const AGENTS_DIGEST = `[context-monitor] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.
Context was compacted. Core workflow rules (condensed):
1. Read .think/_state.md FIRST, before anything else.
2. Do ONE thing per turn, then update .think/_state.md and STOP.
3. Write EVERY finding, decision, and error to a .think/step-NNN.md file BEFORE responding — anything not on disk is destroyed at the next compaction.
4. Read at most 2 files per turn. Never hold whole codebases in context.
5. No code without _plan.md. Small edits only: skeleton first, then fill in with edits.
6. Keep responses under 200 words. No explanations unless asked.
Full rules are in ~/.pi/agent/AGENTS.md on disk — re-read it if unsure.`;

// ---------- STEERING MESSAGES ----------
const WARN_MESSAGE = `[context-monitor] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
Context is at {PERCENT}% full.
Write your current progress to disk so compaction can safely compress earlier turns.

ACTION REQUIRED before your next response:
1. Write current task state to .think/_state.md (full, accurate, complete)
2. Write a summary of all completed work to .think/_summary.md

Keep your response short. Prioritize the file writes.
Then CONTINUE working normally. Compaction will free up space automatically.`;


// ---------- HELPERS ----------
function formatMessage(template: string, percent: number): string {
  return template.replace("{PERCENT}", String(Math.round(percent)));
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  let warnFired = false;
  let compactionCount = 0;

  pi.on("session_start", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? "unknown";
    ctx.ui.notify(
      `context-monitor active — warn at ${WARN_PERCENT}%, force compact at ${FORCE_COMPACT_PERCENT}% (window: ${window} tokens)`,
      "info"
    );
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null) return;

    const pct = usage.percent;

    // Reset flags if context dropped (e.g. after compaction or new session).
    if (pct < WARN_PERCENT) {
      warnFired = false;
      return;
    }

    // FORCE COMPACT threshold — always compact when above 80%, every turn if needed.
    if (pct >= FORCE_COMPACT_PERCENT) {
      warnFired = true; // suppress warn since we're compacting

      ctx.ui.notify(
        `context-monitor: ${Math.round(pct)}% — forcing compaction now`,
        "warn"
      );

      try {
        (ctx as any).compact?.({
          customInstructions: COMPACT_INSTRUCTIONS,
          onComplete: async () => {
            ctx.ui.notify("context-monitor: compaction complete", "info");
            // Rule re-injection happens in the session_compact handler below,
            // which fires for ALL compactions (auto, manual, extension).
          },
          onError: (err: Error) => {
            ctx.ui.notify(`context-monitor: compaction failed — ${err.message}`, "error");
          },
        });
      } catch (err: any) {
        ctx.ui.notify(`context-monitor: compact() failed — ${err.message}`, "error");
      }
      return;
    }

    // WARN threshold — fires once.
    if (pct >= WARN_PERCENT && !warnFired) {
      warnFired = true;

      ctx.ui.notify(
        `context-monitor: context at ${Math.round(pct)}% — steering model to write .think/ state files now.`,
        "info"
      );

      await pi.sendMessage(
        {
          customType: "context_monitor_warn",
          content: formatMessage(WARN_MESSAGE, pct),
          display: {
            label: "context-monitor",
            content: `Context at ${Math.round(pct)}%. Writing state to .think/ files.`,
          },
        },
        { deliverAs: "steer" }
      );
    }
  });

  // Fires for EVERY compaction — Pi-native auto, manual /compact, and
  // extension-triggered — so the counter is deterministic code and never
  // misses one. Re-injects full AGENTS.md every FULL_AGENTS_EVERY-th
  // compaction, the condensed digest otherwise.
  pi.on("session_compact", async (_event, ctx) => {
    compactionCount++;
    const globalMd = readGlobalAgentsMd();
    const projectMd = readProjectAgentsMd();
    // No global install? The project file acts as the contract (legacy setups).
    const contractMd = globalMd ?? projectMd;
    const extraMd = globalMd ? projectMd : null;

    // OURS (contract): full every FULL_AGENTS_EVERY-th compaction, digest otherwise.
    const useFull = contractMd && (compactionCount - 1) % FULL_AGENTS_EVERY === 0;
    const rulesPart = useFull
      ? `[context-monitor] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.\n` +
        `Context was compacted. Re-injecting AGENTS.md rules:\n\n---\n${contractMd}\n---`
      : AGENTS_DIGEST;
    // THEIRS (project AGENTS.md): always appended IN FULL, every reinjection.
    const projectPart = extraMd
      ? `\n\nPROJECT-SPECIFIC RULES (project AGENTS.md, always in full):\n---\n${extraMd}\n---`
      : "";
    const content = `${rulesPart}${projectPart}\n\nNow read .think/_state.md and continue from where you left off.`;
    await pi.sendMessage(
      {
        customType: "agents_md_reinjection",
        content,
        display: {
          label: "context-monitor",
          content:
            (useFull
              ? `full AGENTS.md re-injected (compaction #${compactionCount})`
              : `condensed rules digest injected (compaction #${compactionCount}, full every ${FULL_AGENTS_EVERY})`) +
            (extraMd ? " + project AGENTS.md in full" : ""),
        },
      },
      { deliverAs: "steer" }
    );
    ctx.ui.notify(
      (useFull
        ? `context-monitor: full AGENTS.md re-injected (compaction #${compactionCount})`
        : `context-monitor: condensed digest injected (compaction #${compactionCount})`) +
        (extraMd ? " + project rules" : ""),
      "info"
    );
  });

  // /context-monitor command — show live usage.
  pi.registerCommand("context-monitor", {
    description: "Show current context usage and thresholds",
    handler: async (_args, ctx) => {
      const usage = ctx.getContextUsage();
      if (!usage) {
        ctx.ui.notify("context-monitor: no usage data available yet.", "info");
        return;
      }
      const pct = usage.percent !== null ? `${Math.round(usage.percent)}%` : "unknown";
      ctx.ui.notify(
        `context-monitor: ${usage.tokens ?? "?"} / ${usage.contextWindow} tokens (${pct}). ` +
        `Warn at ${WARN_PERCENT}%, force compact at ${FORCE_COMPACT_PERCENT}%.`,
        "info"
      );
    },
  });
}
