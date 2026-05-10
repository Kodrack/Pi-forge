// context-monitor.ts
// Watches context token usage after each turn and injects steering messages
// telling the model to write state to .think/ files before context degrades.
//
// Two thresholds:
//   WARN_PERCENT  (65%) — "start writing state now, while you're still coherent"
//   URGENT_PERCENT (80%) — "stop everything, write full state, session ending soon"
//
// Install: copy to ~/.pi/agent/extensions/context-monitor.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------- THRESHOLDS ----------
const WARN_PERCENT   = 65;   // first warning — write state now
const URGENT_PERCENT = 80;   // hard warning — session ending soon

// ---------- STEERING MESSAGES ----------
const WARN_MESSAGE = `[context-monitor] Context is at {PERCENT}% full.
Write your current progress to disk so compaction can safely compress earlier turns.

ACTION REQUIRED before your next response:
1. Write current task state to .think/_state.md (full, accurate, complete)
2. Write a summary of all completed work to .think/_summary.md

Keep your response short. Prioritize the file writes.
Then CONTINUE working normally. Compaction will free up space automatically.`;

const URGENT_MESSAGE = `[context-monitor] Context is at {PERCENT}% full.

Write state to disk NOW, then compact:
1. Write COMPLETE state to .think/_state.md — every detail, nothing from memory
2. Write COMPLETE summary to .think/_summary.md
3. Write next actions to .think/_state.md under "Next Action"
4. Run /compact to free up context space

Then CONTINUE working. Do NOT stop. Do NOT ask the user to start a new session.`;

// ---------- HELPERS ----------
function formatMessage(template: string, percent: number): string {
  return template.replace("{PERCENT}", String(Math.round(percent)));
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  let warnFired   = false;
  let urgentFired = false;

  pi.on("session_start", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? "unknown";
    ctx.ui.notify(
      `context-monitor active — warn at ${WARN_PERCENT}%, urgent at ${URGENT_PERCENT}% (window: ${window} tokens)`,
      "info"
    );
  });

  pi.on("turn_end", async (_event, ctx) => {
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null) return;

    const pct = usage.percent;

    // Reset flags if context dropped (e.g. after compaction or new session).
    if (pct < WARN_PERCENT) {
      warnFired   = false;
      urgentFired = false;
      return;
    }

    // URGENT threshold — fires once, overrides warn.
    if (pct >= URGENT_PERCENT && !urgentFired) {
      urgentFired = true;
      warnFired   = true; // suppress warn since urgent supersedes it

      ctx.ui.notify(
        `context-monitor: URGENT — context at ${Math.round(pct)}%. Writing state to .think/ is critical now.`,
        "warn"
      );

      await pi.sendMessage(
        {
          customType: "context_monitor_urgent",
          content: formatMessage(URGENT_MESSAGE, pct),
          display: {
            label: "context-monitor",
            content: `URGENT: Context at ${Math.round(pct)}%. Write state files and notify user.`,
          },
        },
        { deliverAs: "steer" }
      );
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
        `Warn at ${WARN_PERCENT}%, urgent at ${URGENT_PERCENT}%.`,
        "info"
      );
    },
  });
}
