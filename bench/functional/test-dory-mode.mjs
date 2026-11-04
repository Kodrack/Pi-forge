// FUNCTIONAL test: dory-mode.ts (the /dory runner) against a mock Pi + a mock
// board, driving the REAL extension code.
//
// Reproduces how Pi actually behaves: newSession() DISPOSES the extension
// instance that called it, and the replacement session gets a NEW instance that
// only ever receives an EVENT context (no newSession). Checks:
//   1. every job — not just the first — opens a genuinely fresh session (the
//      command context Pi hands to withSession is carried to the next instance).
//      Before the fix, job 2+ ran in the SAME session (compacted), and an earlier
//      card's context bled into the next card's plan.
//   2. a marker-only job (plan/research/respond/wave) that ends WITHOUT its
//      marker block gets exactly ONE nudge turn before the result is posted.
//   3. a stale command context falls back to running in place instead of failing.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-dorymode-")));
process.env.HOME = TMP;
fs.mkdirSync(path.join(TMP, ".pi", "organizer"), { recursive: true });

// ---- fake timers: capture setInterval callbacks so the test drives polling ----
const intervals = new Map();
let intervalId = 0;
globalThis.setInterval = (fn) => { intervals.set(++intervalId, fn); return intervalId; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
// Fire every live timer once (heartbeat, 2s abort check, intake), like time passing.
const pollNow = async () => { for (const fn of [...intervals.values()]) await fn(); await new Promise((r) => setImmediate(r)); };

// ---- mock board ----
const jobs = [];                 // queued jobs the board will hand out
let abortId = null;              // what the board's heartbeat reply says to abort
const pings = [];
const results = [];              // posted results
globalThis.fetch = async (url, opts = {}) => {
  const p = new URL(url).pathname;
  let body = {};
  if (p === "/api/runner/poll") body = { job: jobs.shift() ?? null };
  else if (p === "/api/runner/ping") { pings.push(JSON.parse(opts.body ?? "{}")); body = { ok: true, abort: abortId }; }
  else if (p === "/api/runner/result") { results.push(JSON.parse(opts.body)); body = { ok: true }; }
  else body = { ok: true };
  return { json: async () => body };
};

// ---- load the real extension (type import stripped) ----
const stripped = path.join(TMP, "dory-mode.ts");
fs.writeFileSync(stripped, fs.readFileSync(path.join(REPO, "extensions", "dory-mode.ts"), "utf-8")
  .replace(/^import type .*$/gm, "// (type import stripped)"));
const mod = await import(stripped);

const checks = [];
const check = (label, ok) => checks.push([label, !!ok]);
const tick = () => new Promise((r) => setImmediate(r));

// One Pi "instance" = one call of the extension factory with its own handlers.
const sent = [];       // pi.sendUserMessage calls (any instance)
const log = [];        // what happened, in order
function instance(name) {
  const h = { cmds: {} };
  mod.default({
    on: (ev, fn) => { h[ev] = fn; },
    registerCommand: (n, def) => { h.cmds[n] = def; },
    sendUserMessage: (text) => { sent.push({ via: `pi:${name}`, text }); },
  });
  return h;
}
const ui = { notify: () => {} };
let current = null;    // the live instance (Pi disposes the previous one on replacement)

// A command-capable context. newSession() behaves like Pi: build the replacement
// instance (event ctx only), run its session_start, THEN call withSession with
// a fresh command-capable context bound to the new session.
let ctxN = 0;
function commandCtx(name, { stale = false } = {}) {
  return {
    ui,
    compact: () => log.push(`compact(${name})`),
    sendUserMessage: async (text) => { sent.push({ via: `ctx:${name}`, text }); },
    newSession: async ({ withSession }) => {
      if (stale) throw new Error("stale context");
      log.push(`newSession(${name})`);
      await current?.session_shutdown?.({}); // Pi tears the old session down first
      current = instance(`inst${++ctxN}`);
      await current.session_start({}, { ui, compact: () => log.push(`compact(event${ctxN})`), abort: () => log.push(`abort(event${ctxN})`) });
      await withSession(commandCtx(`fresh${ctxN}`));
      return { cancelled: false };
    },
  };
}
const endJob = async (text) => {
  await current.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text }] }] }, { ui });
  await tick();
};

// ---- 1. /dory on → job 1 → job 2 → job 3: each in its own fresh session ----
const first = instance("inst0");
current = first;
jobs.push({ id: "job-1", kind: "plan", taskId: "T-012", prompt: "PLAN T-012" });
await first.cmds.dory.handler("", commandCtx("cmd"));
await tick();
check("job 1 opened a fresh session from the /dory command context", log.includes("newSession(cmd)") && sent.some((s) => s.via === "ctx:fresh1" && s.text === "PLAN T-012"));
await endJob("<<<BRIEF>>>\n# T-012\n<<<TEST>>>\ntrue\n<<<END>>>");
check("job 1's result was posted to the board", results.length === 1 && results[0].id === "job-1");

jobs.push({ id: "job-2", kind: "plan", taskId: "T-013", prompt: "PLAN T-013" });
await pollNow();
check("job 2 ALSO opened a fresh session (via the context handed to withSession), not a compacted reuse",
  log.includes("newSession(fresh1)") && !log.some((l) => l.startsWith("compact(")) && sent.some((s) => s.via === "ctx:fresh2" && s.text === "PLAN T-013"));
await endJob("<<<BRIEF>>>\n# T-013\n<<<TEST>>>\ntrue\n<<<END>>>");

jobs.push({ id: "job-3", kind: "research", taskId: "T-014", prompt: "RESEARCH T-014" });
await pollNow();
check("job 3 too: one fresh session per job, every time", log.includes("newSession(fresh2)") && sent.some((s) => s.via === "ctx:fresh3"));

// ---- 2. no marker block → exactly one nudge, then the result is posted ----
const before = results.length;
await endJob("Let me read menu.html precisely, then deliver.");
const nudges = sent.filter((s) => s.text.includes("AUTOMATED HARNESS MESSAGE") && s.text.includes("deliverable"));
check("research job ended without its block → one nudge turn, nothing posted yet", nudges.length === 1 && results.length === before);
check("the nudge is marked as an automated harness message (not the user)", nudges[0]?.text.startsWith("[dory-mode] AUTOMATED HARNESS MESSAGE"));
await endJob("<<<TITLE>>>\nMenu\n<<<DESCRIPTION>>>\nCategorized menu.\n<<<END>>>");
check("…the nudged turn's deliverable is posted", results.length === before + 1 && results.at(-1).id === "job-3" && results.at(-1).output.startsWith("<<<TITLE>>>"));

jobs.push({ id: "job-4", kind: "plan", taskId: "T-015", prompt: "PLAN T-015" });
await pollNow();
await endJob("still reading…");
await endJob("still nothing");
check("never more than one nudge per job: the second miss is posted as-is (the board retries)",
  sent.filter((s) => s.text.includes("AUTOMATED HARNESS MESSAGE")).length === 2 && results.at(-1).id === "job-4" && results.at(-1).output === "still nothing");

jobs.push({ id: "job-5", kind: "exec", taskId: "T-016", prompt: "BUILD T-016" });
await pollNow();
await endJob("done, no markers needed");
check("executor jobs are never nudged (no marker block expected)", results.at(-1).id === "job-5" && sent.filter((s) => s.text.includes("AUTOMATED HARNESS MESSAGE")).length === 2);

// ---- 2b. "Dory paused" on the board → the session aborts the model ----
jobs.push({ id: "job-p", kind: "exec", taskId: "T-020", prompt: "BUILD T-020" });
await pollNow();
const resultsBefore = results.length;
abortId = "job-p";
await pollNow();   // the 2s heartbeat while a job runs
check("heartbeats report which job the session is working on", pings.some((p) => p.job === "job-p"));
check("board says abort → the session aborts the model (ctx.abort)", log.some((l) => l.startsWith("abort(")));
await endJob("partial output after abort");
check("the aborted run's agent_end posts NOTHING (the board already took the job back)", results.length === resultsBefore);
abortId = null;

// ---- 3. stale shared context → falls back to running in place ----
globalThis[Symbol.for("piforge.dory-mode.commandContext")] = commandCtx("stale", { stale: true });
const logLen = log.length;
jobs.push({ id: "job-6", kind: "plan", taskId: "T-017", prompt: "PLAN T-017" });
await pollNow();
check("a stale command context doesn't break the runner: the job runs in place (compacted)",
  log.slice(logLen).some((l) => l.startsWith("compact(")) && sent.some((s) => s.via.startsWith("pi:") && s.text === "PLAN T-017"));

fs.rmSync(TMP, { recursive: true, force: true });
let failed = 0;
for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
console.log(`test-dory-mode (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);