// dory-mode.ts
// /dory — run Dory IN THIS Pi session. The board server becomes a pure
// orchestrator: it queues jobs (chat replies, plans, revisions, executor
// runs) from the kanban, and THIS session executes them, fully visible in
// the TUI with the whole PiForge stack active.
//
// Context hygiene is hard-coded: before EVERY job the extension calls
// ctx.newSession() — a brand-new session (purged context), then sends the
// job prompt as a user message. When the agent loop ends (agent_end), ALL
// assistant text from the job is posted back to the orchestrator, which parses
// it (plan markers, replies), updates the board, runs acceptance tests, and
// moves cards. Then the next job gets the next fresh session.
//
// Two things this has to work around, both non-obvious:
//   1. newSession() disposes the session AND its ExtensionRunner, so the job is
//      finished by a DIFFERENT instance of this extension than the one that
//      started it. Job state therefore lives in ~/.pi/organizer/dory-runner.json,
//      not in the closure — otherwise agent_end finds no job and drops the
//      result with no error, leaving the card stuck in its column.
//   2. Guards steer mid-job (analysis-guard forcing a .think/ write), which adds
//      turns after the marker block. So collect every assistant message, not
//      just the last one, or a perfectly good plan parses as empty.
//
// While /dory is ON, this session belongs to Dory — don't type your own
// prompts into it (each job replaces the visible session). /dory off returns
// it to you. If no session is attached, the orchestrator falls back to
// headless subprocesses (watchable in the browser 🧠 panel).
//
// Commands: /dory on | off | status   (plain /dory toggles)
// Toggleable: /piforge disable dory-mode
// Install: copy to ~/.pi/agent/extensions/dory-mode.ts

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");
const BOARD_URL = `http://localhost:${Number(process.env.DORY_BOARD_PORT || 4747)}`;
// Heartbeat + job-intake cadence. MUST stay comfortably below dory.mjs's
// RUNNER_FRESH_MS (35s) — that window is what marks this session "attached", and
// if it lapses the board stops delegating and jobs leave this session. Keep the
// ratio at 3x or more: raising this without raising RUNNER_FRESH_MS reintroduces
// the detach bug.
const POLL_MS = 10000;
// Runner state lives on DISK, not in this module's closure. ctx.newSession()
// disposes the current session and builds a fresh ExtensionRunner with freshly
// constructed extensions, so the instance that dispatched a job is NOT the
// instance whose agent_end fires when that job finishes — closure state would
// be empty there and the result would be dropped silently.
const RUNNER_STATE_PATH = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");
// The orchestrator parses plan/exec output with indexOf, i.e. the FIRST marker
// block wins. If the model produced more than one deliverable (a retry), keep the
// newest: a plan's BRIEF or GOAL block, else a wave's SUBTASKS/STUCK block,
// else a research job's block — from its TITLE (the block's first marker; a
// TITLE-less answer falls back to DESCRIPTION).
const DELIVERABLE_MARKERS = [["<<<BRIEF>>>", "<<<GOAL>>>"], ["<<<SUBTASKS>>>", "<<<STUCK>>>"], ["<<<TITLE>>>"], ["<<<DESCRIPTION>>>"]];

type RunnerJob = { id: string; kind: string; taskId: string };

function readRunnerState(): { running: boolean; job?: RunnerJob } {
  try {
    return JSON.parse(fs.readFileSync(RUNNER_STATE_PATH, "utf-8"));
  } catch {
    return { running: false };
  }
}

// `pid` is what makes the job record safe to read from other extensions.
// The file is a single global slot in ~/.pi, so without an owner every Pi
// process on the machine reads "a dory plan job is in flight" — including
// unrelated interactive sessions, and including a record left behind by a
// session that was killed mid-job. Consumers (dory-plan-guard, state-guard,
// analysis-guard, first-prompt, thinking-guard, knowledge-injector) only honor
// the record when `pid === process.pid`, which is exactly the case this
// transport exists for: passing the current job to the extension instances of a
// REPLACEMENT session inside the SAME process.
function writeRunnerState(state: { running: boolean; job?: RunnerJob }): void {
  try {
    fs.mkdirSync(path.dirname(RUNNER_STATE_PATH), { recursive: true });
    fs.writeFileSync(RUNNER_STATE_PATH, JSON.stringify({ ...state, pid: process.pid }));
  } catch {} // best effort — a lost state file only costs one /dory re-arm
}

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("dory-mode");
  } catch {
    return true;
  }
}

async function api(pathname: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BOARD_URL}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

export default function doryMode(pi: ExtensionAPI) {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Any context works for the heartbeat and for pi.sendUserMessage(). Only a
  // COMMAND context can replace the session (newSession), so this is typed loose
  // and feature-detected — a session replacement hands us an event context.
  let currentCtx: any;
  let currentJob: RunnerJob | undefined;
  let polling = false;

  function armTimer(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void heartbeat();
      void intake();
    }, POLL_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    // Every job replaces the session, and jiti loads extensions with
    // moduleCache:false, so THIS is a brand-new instance with empty closure
    // state. Rebuild from disk and re-arm, or the runner silently detaches
    // itself after the first job and the board falls back to subprocesses.
    const state = readRunnerState();
    if (!state.running) {
      ctx.ui.notify("dory-mode available — /dory runs Dory's tasks in this session", "info");
      return;
    }
    running = true;
    currentCtx = ctx; // event ctx: enough to heartbeat and to start jobs
    currentJob = state.job;
    armTimer();
    ctx.ui.notify(
      currentJob
        ? `🐟 dory ${currentJob.kind} ${currentJob.taskId} — running here; result goes back to the board when done`
        : "🐟 dory runner still ON — watching the board (jobs run in this session)",
      "info",
    );
  });

  // Clear our interval when this session is torn down. Safe because the
  // replacement session's session_start re-arms from disk — without this, every
  // job would leave another live poller behind, all racing for the same jobs.
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // Job completion: the agent loop of the delegated job ended — collect the
  // final assistant text and hand it back to the orchestrator.
  pi.on("agent_end", async (event: any, ctx) => {
    if (!running || !currentJob) return;
    const job = currentJob;
    currentJob = undefined;
    // EVERY assistant text block, oldest → newest — not just the last message.
    // A guard steer (analysis-guard demanding a .think/ write, for example) adds
    // turns AFTER the marker block, leaving a short confirmation as the final
    // message. Parsing only that yields no <<<BRIEF>>>/<<<TEST>>> and the card
    // silently fails to move even though the model did produce a valid plan.
    let output = (event.messages ?? [])
      .filter((m: any) => m.role === "assistant")
      .map((m: any) =>
        (m.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join(""),
      )
      .filter((t: string) => t.trim().length > 0)
      .join("\n\n");
    for (const group of DELIVERABLE_MARKERS) {
      const last = Math.max(...group.map((m) => output.lastIndexOf(m)));
      if (last >= 0) {
        if (last > 0) output = output.slice(last);
        break;
      }
    }
    try {
      await api("/api/runner/result", "POST", { id: job.id, output });
      writeRunnerState({ running: true }); // job done, runner stays on
      ctx.ui.notify(`dory: ${job.kind} ${job.taskId} done — result sent to the board`, "info");
    } catch {
      ctx.ui.notify(`dory: board unreachable — result of ${job.taskId} lost (it will retry)`, "warning");
    }
  });

  // Heartbeat — ALWAYS, including mid-job. This is the whole reason jobs used to
  // escape into headless subprocesses: dory.mjs treats a heartbeat older than
  // RUNNER_FRESH_MS (15s) as "the Pi session left", and the old code returned
  // before its fetch whenever a job was in flight. Any job longer than 15s
  // therefore detached the runner and everything after it ran outside this
  // session. Intake is a separate concern below.
  async function heartbeat(): Promise<void> {
    if (!running) return;
    try {
      await api("/api/runner/ping", "POST", {});
    } catch {} // board down; next tick retries
  }

  async function intake(): Promise<void> {
    if (!running || polling || currentJob || !currentCtx) return;
    polling = true;
    try {
      const res = await api("/api/runner/poll");
      const job = res?.job;
      if (!job) return;
      currentJob = { id: job.id, kind: job.kind, taskId: job.taskId };
      // Persist BEFORE starting: the job may replace the session, and the fresh
      // instance reads this to learn which job it owns.
      writeRunnerState({ running: true, job: currentJob });
      await startJob(job);
    } catch {
      // board down or ctx stale — keep quiet, next tick retries
    } finally {
      polling = false;
    }
  }

  // Run the job IN THIS Pi session. Two entry paths, because only a command
  // context can replace the session:
  //   - command ctx (from /dory, or handed back by withSession): newSession()
  //     gives the hard per-job context purge. Preferred.
  //   - event ctx only (this instance was created BY a session replacement):
  //     compact() as a soft purge, then pi.sendUserMessage() — which lives on the
  //     API object, not the context, so it works from any instance. No purge
  //     guarantee, but the job still runs here, in the user's one visible thread.
  async function startJob(job: { id: string; kind: string; taskId: string; prompt: string }): Promise<void> {
    if (typeof currentCtx?.newSession === "function") {
      const result = await currentCtx.newSession({
        withSession: async (fresh: any) => {
          currentCtx = fresh; // the old ctx is stale after replacement
          fresh.ui.notify(`🐟 dory ${job.kind} ${job.taskId} — fresh session (context purged)`, "info");
          await fresh.sendUserMessage(job.prompt);
        },
      });
      if (result?.cancelled) {
        currentJob = undefined; // user declined; orchestrator times it out
        writeRunnerState({ running: true });
      }
      return;
    }
    try {
      currentCtx?.compact?.();
    } catch {}
    currentCtx?.ui?.notify?.(
      `🐟 dory ${job.kind} ${job.taskId} — running in this session (compacted; no hard purge, this instance has no command context)`,
      "info",
    );
    pi.sendUserMessage(job.prompt);
  }

  pi.registerCommand("dory", {
    description: "Run Dory's board tasks in THIS session: /dory [on|off|status]",
    handler: async (args, ctx) => {
      if (!isEnabled()) {
        ctx.ui.notify("dory-mode disabled (use /piforge enable dory-mode)", "info");
        return;
      }
      const arg = (args ?? "").trim();
      if (arg === "status") {
        ctx.ui.notify(`dory runner: ${running ? `ON${currentJob ? ` — working on ${currentJob.taskId}` : " — idle, watching the board"}` : "off"}`, "info");
        return;
      }
      if (arg === "off" || (running && !arg)) {
        running = false;
        currentJob = undefined;
        if (timer) clearInterval(timer);
        writeRunnerState({ running: false });
        ctx.ui.notify("dory runner OFF — this session is yours again", "info");
        return;
      }
      // turning on
      try {
        await api("/api/board");
      } catch {
        ctx.ui.notify("dory-mode: board server not running — press ù or /board first, then /dory again", "error");
        return;
      }
      running = true;
      currentCtx = ctx;
      writeRunnerState({ running: true });
      armTimer();
      ctx.ui.notify(
        `🐟 dory runner ON — board tasks now run HERE, each in a fresh session (context purged per task). ` +
        `Manage cards at ${BOARD_URL}. This session belongs to Dory until /dory off.`,
        "info"
      );
      void heartbeat();
      void intake();
    },
  });
}
