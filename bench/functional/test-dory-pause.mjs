// FUNCTIONAL test: "Dory paused" STOPS Dory immediately — the REAL engine with
// a scripted fake `pi` that takes a long time (delayMs), paused mid-job.
//
//   - a running planning job: its pi process is killed at once; the card is
//     left as it was (no plan written, no failure note, no cooldown)
//   - a running build: killed, card back to Approved (never Blocked), attempt
//     counter reset; resuming builds it from attempt 1
//   - a running acceptance test: killed, same revert
//   - while paused, nothing at all runs (no replies, research or planning)
//   - a job handed to the /dory session: taken back at once and the abort is
//     sent with the next heartbeat; the session's late result is ignored
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createDory } = await import(path.join(REPO, "organizer/board/dory.mjs"));
const { applyMove, createTask } = await import(path.join(REPO, "organizer/board/board-core.mjs"));
const FAKE_PI = path.join(REPO, "bench/functional/fake-pi/fake-pi.mjs");
fs.chmodSync(FAKE_PI, 0o755);
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-pause-")));

const checks = [];
const check = (label, ok) => checks.push([label, !!ok]);
function report(extra) {
  let failed = 0;
  for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
  if (extra) { console.log(`  FAIL  ${extra}`); failed++; }
  console.log(`test-dory-pause (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  return failed;
}
process.on("uncaughtException", (err) => { report(`crashed after the last check above: ${err?.message ?? err}`); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function makeEnv(rules, extraConfig = {}) {
  const dir = path.join(ROOT, `env-${++n}`);
  const mind = path.join(dir, "mind");
  const project = path.join(dir, "project");
  fs.mkdirSync(mind, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(mind, "config.json"), JSON.stringify({ project_dir: project, pi_bin: FAKE_PI, runner_mode: "auto", dory_thinking: "off", ...extraConfig }));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(scenario, JSON.stringify(rules));
  process.env.FAKE_PI_SCENARIO = scenario;
  process.env.FAKE_PI_LOG = log;
  const boardPath = path.join(mind, "tasks.json");
  const loadBoard = () => { try { return JSON.parse(fs.readFileSync(boardPath, "utf-8")); } catch { return { version: 1, dispatch: false, tasks: [] }; } };
  const saveBoard = (b) => fs.writeFileSync(boardPath, JSON.stringify(b, null, 2));
  saveBoard({ version: 1, dispatch: true, tasks: [] });
  const dory = createDory({ mindDir: mind, loadBoard, saveBoard, applyMove, createTask });
  const E = {
    mind, project, dory,
    card: (id) => loadBoard().tasks.find((t) => t.id === id),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    add: (fields, extra = {}) => { const b = loadBoard(); const t = createTask(b, fields, "human"); Object.assign(t, extra); saveBoard(b); return t.id; },
    patch: (id, fields) => { const b = loadBoard(); Object.assign(b.tasks.find((t) => t.id === id), fields); saveBoard(b); },
    say: (id, text) => { const b = loadBoard(); b.tasks.find((t) => t.id === id).conversation.push({ at: new Date().toISOString(), by: "human", text }); saveBoard(b); },
    setDispatch: (on) => { const b = loadBoard(); b.dispatch = on; saveBoard(b); },
    // what the server does when the switch flips to paused
    pause: () => { E.setDispatch(false); return E.dory.stop("paused"); },
    waitForCalls: async (k, ms = 8000) => { const t0 = Date.now(); while (E.calls().length < k && Date.now() - t0 < ms) await sleep(50); },
  };
  return E;
}
const brief = (id, test) => `<<<BRIEF>>>\n# ${id} — work\n<<<TEST>>>\n#!/usr/bin/env bash\nset -e\n${test}\n<<<END>>>`;

// ---- 1. pause during a planning job ----
{
  const E = makeEnv([
    { stage: "plan", match: "# CARD T-001:", out: brief("T-001", "true"), delayMs: 30000 },
    { stage: "plan", match: "# CARD T-001:", out: brief("T-001", "true") },
  ]);
  E.add({ title: "slow plan", status: "plan_queue" });
  const t0 = Date.now();
  const ticking = E.dory.tick();
  await E.waitForCalls(1);
  const stopped = E.pause();
  await ticking;
  const c = E.card("T-001");
  check("1 pause mid-plan: the job ends within seconds, not after its 30s run", Date.now() - t0 < 6000);
  check("1 stop() reports what it stopped", stopped.some((x) => x.includes("process")));
  check("1 the card is untouched: still in Plan Queue, no plan, no failure note", c.status === "plan_queue" && !c.brief && !(c.notes ?? "").includes("failed"));
  await E.dory.tick();
  check("1 while paused nothing starts", E.calls().length === 1);
  E.setDispatch(true);
  await E.dory.tick();
  check("1 resumed: planned right away (no cooldown), from scratch", E.card("T-001").status === "plan_created" && E.calls().length === 2);
}

// ---- 2. pause during a build ----
{
  const E = makeEnv([
    { stage: "exec", match: "# T-001 —", files: { "half.txt": "partial" }, out: "done", delayMs: 30000 },
    { stage: "exec", match: "# T-001 —", files: { "done.txt": "ok" }, out: "done" },
  ]);
  E.add({ title: "build me", status: "approved" });
  fs.writeFileSync(path.join(E.mind, "tasks", "T-001.md"), "# T-001 — work\n");
  fs.writeFileSync(path.join(E.mind, "tests", "T-001.sh"), "test -f done.txt\n");
  E.patch("T-001", { brief: "tasks/T-001.md", test_cmd: `bash "${path.join(E.mind, "tests/T-001.sh")}"` });
  const ticking = E.dory.tick();
  await E.waitForCalls(1);
  check("2 the build started (card In Progress)", E.card("T-001").status === "in_progress");
  E.pause();
  await ticking;
  let c = E.card("T-001");
  check("2 pause mid-build: card back to Approved — not Blocked", c.status === "approved");
  check("2 the human is told the build was stopped and may have left partial edits", (c.notes ?? "").includes("paused mid-run"));
  E.setDispatch(true);
  await E.dory.tick();
  c = E.card("T-001");
  check("2 resumed: built again from attempt 1 and passes", c.status === "done" && E.calls().length === 2);
}

// ---- 3. pause during the acceptance test ----
{
  const E = makeEnv([{ stage: "exec", match: "# T-001 —", out: "done" }]);
  E.add({ title: "slow test", status: "approved" });
  fs.writeFileSync(path.join(E.mind, "tasks", "T-001.md"), "# T-001 — work\n");
  fs.writeFileSync(path.join(E.mind, "tests", "T-001.sh"), "sleep 30\n");
  E.patch("T-001", { brief: "tasks/T-001.md", test_cmd: `bash "${path.join(E.mind, "tests/T-001.sh")}"` });
  const t0 = Date.now();
  const ticking = E.dory.tick();
  await E.waitForCalls(1);
  await sleep(500); // executor finished; the 30s acceptance test is running now
  E.pause();
  await ticking;
  check("3 pause mid-test: the test is killed at once, card back to Approved", Date.now() - t0 < 6000 && E.card("T-001").status === "approved");
}

// ---- 4. paused = nothing at all, not even replies or research ----
{
  const E = makeEnv([
    { stage: "chat", match: "# CARD T-001:", out: "<<<REPLY>>>\nhi\n<<<END>>>" },
    { stage: "research", match: "# CARD T-002:", out: "<<<DESCRIPTION>>>\nd\n<<<END>>>" },
  ]);
  const a = E.add({ title: "talk", status: "chat" });
  E.say(a, "hello?");
  E.add({ title: "dig", status: "chat" }, { research_requested: new Date().toISOString() });
  E.setDispatch(false);
  await E.dory.tick(); await E.dory.tick();
  check("4 paused: no reply, no research, no planning", E.calls().length === 0);
  E.setDispatch(true);
  await E.dory.tick(); await E.dory.tick();
  check("4 active again: the waiting reply and research run", E.calls().map((c) => c.stage).join(",") === "chat,research");
}

// ---- 5. a job handed to the /dory session ----
{
  const E = makeEnv([], { runner_mode: "session" });
  E.add({ title: "plan in session", status: "plan_queue" });
  E.dory.runnerPing({ job: null });               // /dory attached
  await E.dory.tick();                            // job queued for the session
  const job = E.dory.runnerPoll().job;            // …and picked up
  check("5 the plan job went to the /dory session", job?.kind === "plan" && job.taskId === "T-001");
  const stopped = E.pause();
  check("5 pause takes the job back from the session", stopped.some((x) => x.includes("plan T-001") && x.includes("/dory")));
  const hb = E.dory.runnerPing({ job: job.id });
  check("5 the session's next heartbeat carries the abort for that job", hb.abort === job.id);
  check("5 once the session reports it stopped, the abort is cleared", E.dory.runnerPing({ job: null }).abort === null);
  const late = await E.dory.runnerResult({ id: job.id, output: brief("T-001", "true") });
  check("5 a late result from the aborted job is ignored (card not planned)", late.ok === false && !E.card("T-001").brief && E.card("T-001").status === "plan_queue");
}

fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(report() ? 1 : 0);
