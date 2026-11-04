// dory-plan-guard.ts
// Keeps Dory's non-coding jobs (chat | plan | respond) READ-ONLY when they run
// in an attached /dory session, and stops the job the moment its deliverable
// has been emitted.
//
// Why this exists: headless Dory jobs get `--tools read,bash,web_search` from
// dory.mjs, so they physically cannot write. The in-session path (/dory, the
// runner) has the FULL tool set and the full guard stack, so the same persona
// ("CRITICAL — you do not create files") was prompt-level only. Observed
// 2026-07-25 on card T-006 ("website for a CRM"): the plan job produced a
// correct <<<BRIEF>>>, then state-guard and analysis-guard steered it into
// writing .think/_state.md and .think/step-001.md, and from there it started
// IMPLEMENTING its own plan (crm.html) inside the PLANNING job. A plan job's
// only deliverable is the marker block the board parses; the executor — a
// different, guarded session dispatched from the Approved column — is what
// writes code.
//
// Two hard rules while a chat/plan/respond job owns the session:
//   1. Tool allowlist mirroring headless mode (read/bash/web_search + the
//      read-only extras). write, edit and every mutating bash form (redirect
//      into a file, heredoc-into-file, rm/mv/mkdir/tee/sed -i, git write ops,
//      package installers) are BLOCKED at the tool-call boundary.
//   2. Deliverable latch: once the closing marker block has streamed, ANY
//      further tool call is blocked. This is the anti-drift rule — the harness
//      already has the text, so everything after it is the planner trying to
//      become the executor.
//
// Exec jobs (kind "exec") and ordinary interactive sessions are untouched —
// readonlyJob() returns null there and every hook no-ops.
//
// Companion changes (same failure): state-guard, analysis-guard, first-prompt
// and thinking-guard's text-abort all skip / relax for these stages.
//
// Toggleable: /piforge disable dory-plan-guard
// Install: copy to ~/.pi/agent/extensions/dory-plan-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");
const DORY_RUNNER_STATE = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");

// Dory stages whose entire deliverable is marker text. "exec" is deliberately
// absent: that stage IS the code-writing one. Kinds dispatched by dory.mjs:
// chat | respond | plan | exec.
const READONLY_KINDS = ["chat", "plan", "respond"];

// Tools a planning/chat job may use. Mirrors HEADLESS_ARGS in dory.mjs
// (`--tools read,bash,web_search`) plus PiForge's read-only extras, so both
// dispatch paths give Dory the same capabilities.
const ALLOWED_TOOLS = new Set([
  "read",
  "read_file",
  "ls",
  "list_files",
  "glob",
  "grep",
  "find",
  "bash", // conditionally — mutating commands are filtered below
  "web_search",
  "distill_codebase",
  "explore_codebase",
]);

// After this many blocks in one job, also steer: a local model that keeps
// retrying writes will otherwise burn the whole 15-minute plan timeout and the
// card never moves.
const BLOCKS_BEFORE_STEER = 3;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("dory-plan-guard");
  } catch {
    return true;
  }
}

// The Dory job this session is executing right now, or null if none.
// Two transports, because Dory runs jobs two different ways:
//   - HEADLESS throwaway `pi -p` subprocess: dory.mjs passes DORY_STAGE in env.
//   - IN-SESSION via /dory: dory-mode.ts records the active job in
//     dory-runner.json (it cannot set env vars on its own process).
// Env first — process-scoped, cannot go stale.
//
// Resolved on EVERY call, never cached for the session: only the FIRST
// in-session job gets its own fresh session. `newSession()` lives on the
// command context, and the instance created by a session replacement only ever
// holds an event context, so from job 2 onward dory-mode falls back to
// compact() + sendUserMessage() and consecutive jobs — of DIFFERENT kinds —
// share one session. A stage cached at session_start would therefore be the
// previous job's, which would leave a plan job unguarded and, worse, make an
// exec job read-only.
// The `pid` check is load-bearing, not defensive: dory-runner.json is a single
// global slot in ~/.pi, so an unrelated interactive session — or any session
// started after a /dory session was killed mid-job — would otherwise read
// "plan job in flight" and find its own writes blocked. Only the process that
// wrote the record (the one actually running the job) honors it.
function doryJob(): { key: string; kind: string } | null {
  const fromEnv = process.env.DORY_STAGE;
  if (fromEnv) return { key: `env:${fromEnv}`, kind: String(fromEnv) };
  try {
    const state = JSON.parse(fs.readFileSync(DORY_RUNNER_STATE, "utf-8"));
    if (!state?.running || !state?.job?.kind || state.pid !== process.pid) return null;
    return { key: String(state.job.id ?? state.job.taskId ?? state.job.kind), kind: String(state.job.kind) };
  } catch {
    return null;
  }
}

function readonlyJob(): { key: string; kind: string } | null {
  const job = doryJob();
  return job && READONLY_KINDS.includes(job.kind) ? job : null;
}

// Quoted segments are emptied before scanning for redirects — otherwise a
// perfectly read-only `grep -n "=>" file` or `grep "a > b"` reads as a write.
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

// Redirects that mutate the filesystem. `>/dev/null`, `2>&1`, `>&2` are not
// writes — they are how you silence a read-only command.
function hasFileRedirect(command: string): boolean {
  const bare = stripQuoted(command);
  const re = />>?\s*([^\s;|&]+|&\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    const target = m[1];
    if (/^&\d$/.test(target)) continue; // 2>&1
    if (/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(target)) continue;
    return true;
  }
  return false;
}

// Commands that create/modify/remove state even without a redirect. Slightly
// over-broad on purpose (a read-only `tar -tf` is blocked too) — a planning job
// needs none of these, and the block reason points it back at the read tools.
const MUTATING_CMD =
  /(^|[;&|(){}]\s*|\s)(rm|rmdir|mv|cp|mkdir|touch|tee|dd|truncate|ln|chmod|chown|unzip|tar|patch|wget|sed\s+-i|perl\s+-[a-z]*i|python3?\s+-c|node\s+-e|curl\s+[^;&|]*-[oO]|find\s+[^;&|]*-delete|git\s+(add|commit|apply|checkout|restore|reset|rm|mv|stash|push|init|clean)|npm\s+(i|install|ci|add|remove|init|create)|(pnpm|yarn|bun)\s+(install|add|remove|create|init)|npx|pip3?\s+install|cargo\s+(new|init|add))\b/;

function bashMutates(command: string): boolean {
  return hasFileRedirect(command) || MUTATING_CMD.test(stripQuoted(command));
}

// Has the job's deliverable already streamed? The personas close with
// <<<END>>>, but local models mangle the closing marker often enough that one
// signal isn't enough: a plan payload always contains <<<TEST>>>, and the
// observed T-006 failure closed the block by repeating <<<BRIEF>>>.
function deliverableEmitted(text: string): boolean {
  if (text.includes("<<<END>>>")) return true;
  if (text.includes("<<<TEST>>>")) return true;
  const count = (marker: string) => text.split(marker).length - 1;
  return count("<<<BRIEF>>>") >= 2 || count("<<<REPLY>>>") >= 2;
}

export default function doryPlanGuard(pi: ExtensionAPI) {
  // State belongs to a JOB, not to the session: consecutive jobs share one
  // session (see doryJob()). jobKey changing is the reset signal.
  let jobKey = "";
  let delivered = false;
  let turnText = "";
  let blocks = 0;
  let steered = false;

  // Returns the active read-only job's kind, or null. Resets the per-job latch
  // and counters the first time a new job is seen.
  function activeStage(): string | null {
    if (!isEnabled()) return null;
    const job = readonlyJob();
    if (!job) return null;
    if (job.key !== jobKey) {
      jobKey = job.key;
      delivered = false;
      turnText = "";
      blocks = 0;
      steered = false;
    }
    return job.kind;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    const active = activeStage();
    ctx.ui.notify(
      active
        ? `dory-plan-guard active (dory ${active} job — read-only: no write/edit, no mutating bash; the marker block is the deliverable)`
        : "dory-plan-guard active — enforces read-only during dory chat/plan/respond jobs (exec untouched)",
      "info",
    );
  });

  // Latch the deliverable MID-STREAM, not at turn_end: a turn can emit the
  // marker block and then tool calls, and by turn_end the drift has already
  // executed.
  pi.on("message_update", async (event, _ctx) => {
    const ae = (event as any).assistantMessageEvent;
    if (ae?.type !== "text_start" && ae?.type !== "text_delta") return; // skip the fs read on every other delta
    if (!activeStage() || delivered) return;
    if (ae.type === "text_start") turnText = "";
    else {
      turnText += (ae.content as string) ?? "";
      if (deliverableEmitted(turnText)) delivered = true;
    }
  });

  // Backstop for the non-streaming path (final message assembled at once).
  pi.on("turn_end", async (event: any, _ctx) => {
    if (!activeStage() || delivered) return;
    const text = (event.message?.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("");
    if (deliverableEmitted(text)) delivered = true;
    turnText = "";
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const stage = activeStage();
    if (!stage) return;
    const tool = event.toolName ?? "";

    // Rule 2 — the job is done. Anything else is the planner trying to
    // implement its own plan (the T-006 drift).
    if (delivered) {
      blocks++;
      await maybeSteer(ctx, stage);
      return {
        block: true,
        reason:
          `[dory-plan-guard] Your deliverable for this Dory ${stage} job is ALREADY COMPLETE — ` +
          `the harness captured the marker block and will write the files and update the card itself.\n` +
          `1. Do NOT implement anything. Implementation is a SEPARATE job run by the executor ` +
          `when the human moves this card to Approved.\n` +
          `2. Do NOT call any more tools and do NOT retry this one.\n` +
          `3. End your turn now with one short sentence (or no text at all).`,
      };
    }

    // Rule 1 — read-only tool allowlist.
    if (!ALLOWED_TOOLS.has(tool)) {
      blocks++;
      await maybeSteer(ctx, stage);
      return {
        block: true,
        reason:
          `[dory-plan-guard] '${tool}' is not available in a Dory ${stage} job — this stage is READ-ONLY.\n` +
          `1. Do NOT retry this call, and do NOT look for another way to write files ` +
          `(no bash redirect, no heredoc, no tee).\n` +
          `2. You do not write the plan, the test, tasks.json or any .think/ file — the board harness ` +
          `parses your FINAL MESSAGE and writes them itself. Anything you put on disk is discarded.\n` +
          `3. Continue with read tools only (read, ls, grep, find, bash for read-only inspection, web_search), ` +
          `then emit your ENTIRE deliverable between the markers the prompt gave you.`,
      };
    }

    if (tool === "bash") {
      const command = (event.input as { command?: string })?.command ?? "";
      if (bashMutates(command)) {
        blocks++;
        await maybeSteer(ctx, stage);
        return {
          block: true,
          reason:
            `[dory-plan-guard] That bash command modifies the filesystem, and a Dory ${stage} job is READ-ONLY.\n` +
            `1. Do NOT retry it in any form — a redirect (> or >>), a heredoc, tee, sed -i, mkdir, rm, ` +
            `git add/commit or an installer are all blocked here.\n` +
            `2. Nothing needs to be written: the board harness writes the plan and the test from your ` +
            `FINAL MESSAGE (the marker block). Files you create are discarded.\n` +
            `3. Use bash only to LOOK (ls, cat, grep, find, git log/diff/status), then emit the marker block.`,
        };
      }
    }
  });

  // One steer after repeated blocks: a model that keeps retrying writes would
  // otherwise spend the whole plan timeout doing it and the card never moves.
  async function maybeSteer(ctx: any, stage: string): Promise<void> {
    if (steered || blocks < BLOCKS_BEFORE_STEER) return;
    steered = true;
    ctx?.ui?.notify?.(`dory-plan-guard: ${blocks} blocked calls — steering the job to emit its deliverable`, "warn");
    await pi.sendMessage(
      {
        customType: "dory_plan_guard_stop",
        content:
          `[dory-plan-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
          `You are running a Dory ${stage} job. It is READ-ONLY: every write attempt has been blocked and always will be.\n` +
          `You are NOT implementing this card — a separate executor session does that later.\n` +
          `ACTION REQUIRED NOW: stop calling tools and emit your ENTIRE deliverable in your next message, ` +
          `between the markers the prompt specified, with no prose outside them. Then stop.`,
        display: {
          label: "dory-plan-guard",
          content: `${blocks} write attempts blocked in a read-only ${stage} job — forcing the deliverable.`,
        },
      },
      { deliverAs: "steer" },
    );
  }

  pi.registerCommand("dory-plan-guard", {
    description: "Show dory-plan-guard status (read-only enforcement for Dory chat/plan/respond jobs)",
    handler: async (_args, ctx) => {
      const active = activeStage();
      const job = doryJob();
      ctx.ui.notify(
        !isEnabled()
          ? "dory-plan-guard: disabled (use /piforge enable dory-plan-guard)"
          : active
            ? `dory-plan-guard: ENFORCING (dory ${active} job — ${blocks} calls blocked, deliverable ${delivered ? "emitted" : "pending"})`
            : `dory-plan-guard: idle (current dory stage: ${job?.kind ?? "none"} — enforces only ${READONLY_KINDS.join("/")})`,
        "info",
      );
    },
  });
}
