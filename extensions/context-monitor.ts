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
// The reinjection AUTO-CONTINUES the session: Pi's compact() aborts the agent
// loop first (agent-session.js), so a plain steer message would sit unread
// until the user types. triggerTurn: true starts the turn ourselves — unless
// .think/_state.md says Status: complete, or MAX_AUTO_CONTINUES consecutive
// auto-turns have fired without any real user input.
//
// Install: copy to ~/.pi/agent/extensions/context-monitor.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DORY_RUNNER_STATE = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");

// Dory stages that produce marker text only — no code, no .think/ brain files.
// Kinds dispatched by dory.mjs: chat | respond | plan | exec.
const DORY_READONLY_KINDS = ["research", "chat", "plan", "respond", "wave"];

// The Dory stage this session is executing (null = not a read-only Dory job).
// DORY_STAGE (env) for headless `pi -p` jobs, dory-runner.json for in-session
// /dory jobs (dory-mode.ts cannot set env vars on its own process) — honored only
// when `pid` matches, since that file is one global slot shared by every Pi
// process on the machine. See dory-plan-guard.ts, which enforces read-only there.
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

// Max consecutive reinjections that auto-trigger a turn without any real user
// input in between. Any interactive/rpc input resets the counter.
const MAX_AUTO_CONTINUES = 3;

// Same completion detection as acceptance-guard.ts — keep the two in sync.
const COMPLETE_STATUS = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;

// .think/_state.md says the task is done — do not auto-continue past that.
function stateSaysComplete(): boolean {
  const state = readFileOrNull(path.join(process.cwd(), ".think", "_state.md"));
  return state !== null && COMPLETE_STATUS.test(state);
}

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
  let autoContinueCount = 0;

  // Real user input (typed or rpc) resets the auto-continue budget.
  pi.on("input", async (event) => {
    if (event.source !== "extension") autoContinueCount = 0;
    return undefined;
  });

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

    // WARN threshold — fires once. Skipped in read-only dory stages: the warning
    // is an order to write .think/_state.md + _summary.md, and those jobs have no
    // .think/ workflow and are forbidden from touching files.
    if (pct >= WARN_PERCENT && !warnFired) {
      warnFired = true;
      const doryStage = doryReadonlyStage();
      if (doryStage) {
        ctx.ui.notify(
          `context-monitor: ${Math.round(pct)}% — skipping the .think/ write steer (dory ${doryStage} job)`,
          "info",
        );
        return;
      }

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
    // Read-only dory stage: do NOT re-inject the workflow contract. AGENTS.md is
    // the code-writing contract ("YOU MUST create .think/_state.md BEFORE doing
    // anything else"), and a chat/plan/respond job prompt says the opposite
    // ("Never create or modify any file"). Injecting both hands the model two
    // contradictory assignments and it spends the rest of the job reconciling
    // them. purpose-anchor re-anchors these jobs on their own prompt instead.
    const doryStage = doryReadonlyStage();
    if (doryStage) {
      ctx.ui.notify(
        `context-monitor: compaction #${compactionCount} — AGENTS.md NOT re-injected (dory ${doryStage} job; purpose-anchor re-anchors it)`,
        "info",
      );
      return;
    }
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

    // Pi's compact() aborted the agent loop, so without triggerTurn this message
    // waits for the user. Auto-continue unless the task is done or the budget is spent.
    const complete = stateSaysComplete();
    const capped = autoContinueCount >= MAX_AUTO_CONTINUES;
    const autoContinue = !complete && !capped;
    if (autoContinue) autoContinueCount++;

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
      { deliverAs: "steer", triggerTurn: autoContinue }
    );
    ctx.ui.notify(
      (useFull
        ? `context-monitor: full AGENTS.md re-injected (compaction #${compactionCount})`
        : `context-monitor: condensed digest injected (compaction #${compactionCount})`) +
        (extraMd ? " + project rules" : "") +
        (autoContinue
          ? ` — auto-continuing (${autoContinueCount}/${MAX_AUTO_CONTINUES})`
          : complete
            ? " — NOT auto-continuing (_state.md says complete)"
            : ` — NOT auto-continuing (${MAX_AUTO_CONTINUES} auto-turns without user input; type anything to resume)`),
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
