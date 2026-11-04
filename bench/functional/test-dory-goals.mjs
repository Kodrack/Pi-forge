// FUNCTIONAL test: long-horizon goal cards, driven through the REAL Dory engine
// (organizer/board/dory.mjs + board-core.mjs) with a scripted fake `pi`
// (fake-pi/fake-pi.mjs) instead of a model. Real files, real acceptance tests,
// real goal tests — only the LLM is scripted.
//
// Covers: plan → goal outline → approve → wave 1 → just-in-time subtask
// planning → changed-file pointers → goal test fails → wave 2 → goal test passes; plus
// every budget/validation rule and failure path from organizer/LONG-HORIZON.md,
// and a regression check that the Plan persona reaches the model whole.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createDory } = await import(path.join(REPO, "organizer/board/dory.mjs"));
const { applyMove, createTask } = await import(path.join(REPO, "organizer/board/board-core.mjs"));
const FAKE_PI = path.join(REPO, "bench/functional/fake-pi/fake-pi.mjs");
fs.chmodSync(FAKE_PI, 0o755);

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-goals-")));
const checks = [];
const check = (label, ok) => checks.push([label, !!ok]);
function report(extra) {
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }
  if (extra) { console.log(`  FAIL  ${extra}`); failed++; }
  console.log(`test-dory-goals (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  return failed;
}
// A broken engine can throw mid-scenario; report it as a named failure with
// every check collected so far, instead of a bare stack trace.
process.on("uncaughtException", (err) => {
  report(`crashed after the last check above: ${err?.message ?? err}`);
  process.exit(1);
});

// ---------- harness ----------
let envN = 0;
function makeEnv({ rules, longHorizon = {}, maxAttempts = 2, gitProject = false }) {
  const dir = path.join(ROOT, `env-${++envN}`);
  const mind = path.join(dir, "mind");
  const project = path.join(dir, "project");
  fs.mkdirSync(mind, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  if (gitProject) {
    execFileSync("git", ["init", "-q"], { cwd: project });
    fs.writeFileSync(path.join(project, "old.txt"), "pre-existing");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: project });
    fs.writeFileSync(path.join(project, "old.txt"), "edited long ago, uncommitted");
    const hourAgo = new Date(Date.now() - 3600e3);
    fs.utimesSync(path.join(project, "old.txt"), hourAgo, hourAgo);
  }
  fs.writeFileSync(path.join(mind, "config.json"), JSON.stringify({
    project_dir: project, pi_bin: FAKE_PI, runner_mode: "auto", dory_thinking: "off",
    max_attempts: maxAttempts, long_horizon: longHorizon,
  }));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(scenario, JSON.stringify(rules));
  process.env.FAKE_PI_SCENARIO = scenario;
  process.env.FAKE_PI_LOG = log;
  const boardPath = path.join(mind, "tasks.json");
  const loadBoard = () => {
    try { return JSON.parse(fs.readFileSync(boardPath, "utf-8")); } catch { return { version: 1, dispatch: false, tasks: [] }; }
  };
  const saveBoard = (b) => fs.writeFileSync(boardPath, JSON.stringify(b, null, 2));
  const dory = createDory({ mindDir: mind, loadBoard, saveBoard, applyMove, createTask });
  const env = {
    mind, project, dory,
    setConfig: (patch) => {
      const p = path.join(mind, "config.json");
      fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf-8")), ...patch }));
    },
    card: (id) => loadBoard().tasks.find((t) => t.id === id),
    tasks: () => loadBoard().tasks,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    add: (fields) => { const b = loadBoard(); const t = createTask(b, fields, "human"); saveBoard(b); return t.id; },
    patch: (id, fields) => { const b = loadBoard(); Object.assign(b.tasks.find((t) => t.id === id), fields); saveBoard(b); },
    move: (id, to) => { const b = loadBoard(); const r = applyMove(b.tasks.find((t) => t.id === id), to, "human"); saveBoard(b); return r; },
    dispatch: (on) => { const b = loadBoard(); b.dispatch = on; saveBoard(b); },
    tick: async (n = 1) => { for (let i = 0; i < n; i++) await dory.tick(); },
  };
  return env;
}

// scripted answers
const goalPlan = (match, goalTest, subtasks) => ({
  stage: "plan", match,
  out: `<<<GOAL>>>\nA tiny site with pages A, B and C.\n<<<TEST>>>\n#!/usr/bin/env bash\nset -e\n${goalTest}\n<<<SUBTASKS>>>\n${JSON.stringify(subtasks)}\n<<<END>>>`,
});
const briefPlan = (match, id, test) => ({
  stage: "plan", match,
  out: `<<<BRIEF>>>\n# ${id} — work\n## Purpose\nx\n<<<TEST>>>\n#!/usr/bin/env bash\nset -e\n${test}\n<<<END>>>`,
});
const execRule = (match, files, handoff) => ({
  stage: "exec", match, files,
  out: `done.${handoff ? `\n<<<HANDOFF>>>\n${handoff}\n<<<END>>>` : ""}`,
});
// plan/respond/wave prompts carry the card header ("# CARD T-002:"); the
// executor's prompt is built from the brief ("# T-002 — …").
const promptsFor = (env, stage, card) =>
  env.calls().filter((c) => c.stage === stage && c.prompt.includes(stage === "exec" ? `# ${card} —` : `# CARD ${card}:`));
const firstPrompt = (env, stage, card) => promptsFor(env, stage, card)[0]?.prompt ?? "";

// =====================================================================
// A. Full run: goal → wave 1 (JIT planning, file pointers) → wave 2 → done
// =====================================================================
{
  const E = makeEnv({ rules: [
    goalPlan("# CARD T-001:", "test -f a.txt\ntest -f b.txt\ntest -f c.txt", [
      { title: "Page A", notes: "creates a.txt" }, { title: "Page B", notes: "creates b.txt", depends_on: [0] }]),
    briefPlan("# CARD T-002:", "T-002", "test -f a.txt"),
    execRule("# T-002 —", { "a.txt": "A" }, "a.txt holds page A; use readA()"),
    briefPlan("# CARD T-003:", "T-003", "test -f b.txt"),
    execRule("# T-003 —", { "b.txt": "B" }, "b.txt holds page B"),
    { stage: "wave", match: "# CARD T-001:", out: `<<<SUBTASKS>>>\n${JSON.stringify([
      { title: "Page C", notes: "creates c.txt", depends_on: ["T-003"] }, { title: "page a", notes: "dup" }])}\n<<<END>>>` },
    briefPlan("# CARD T-004:", "T-004", "test -f c.txt"),
    execRule("# T-004 —", { "c.txt": "C" }, "c.txt holds page C"),
  ] });
  E.add({ title: "Build mini site", status: "plan_queue" });

  await E.tick();
  let g = E.card("T-001");
  check("A1 plan on a big card → card becomes a goal in Plan created", g.kind === "goal" && g.status === "plan_created");
  check("A1 wave-1 outline kept for approval (2 subtasks), goal test written", g.pending_wave?.length === 2 && fs.existsSync(path.join(E.mind, "tests/T-001.sh")));
  check("A1 no subtask cards exist before approval", E.tasks().length === 1);
  check("A1 outline posted to the human", g.conversation.at(-1).text.includes("made it a goal"));
  check("A1 the Plan persona reached the model whole (TEST rules + GOAL option)",
    firstPrompt(E, "plan", "T-001").includes("Rules for the TEST section") && firstPrompt(E, "plan", "T-001").includes("<<<GOAL>>>"));

  E.move("T-001", "approved");
  await E.tick();
  check("A2 dispatch OFF → approved goal does not start", E.tasks().length === 1);
  E.dispatch(true);
  await E.tick();
  g = E.card("T-001");
  check("A2 approve + dispatch → wave 1 created, goal In progress", g.status === "in_progress" && g.wave === 1 && !g.pending_wave);
  check("A2 subtasks linked: parent, wave, dependency mapped to the real id",
    E.card("T-002")?.parent === "T-001" && E.card("T-003")?.wave === 1 && JSON.stringify(E.card("T-003").depends_on) === '["T-002"]');

  await E.tick();
  check("A3 just in time: T-002 planned → Plan created (review)", E.card("T-002").status === "plan_created" && E.card("T-002").brief);
  check("A3 subtask plan prompt carries the goal and says it can't split", /PART OF A LARGER GOAL[\s\S]*SUBTASK of goal T-001/.test(firstPrompt(E, "plan", "T-002")) || (firstPrompt(E, "plan", "T-002").includes("SUBTASK of goal T-001") && firstPrompt(E, "plan", "T-002").includes("PART OF A LARGER GOAL")));
  await E.tick();
  check("A3 T-003 NOT planned while T-002 isn't done", E.card("T-003").status === "plan_queue" && !E.card("T-003").brief && promptsFor(E, "plan", "T-003").length === 0);
  check("A3 the goal card never runs the executor", promptsFor(E, "exec", "T-001").length === 0);

  E.move("T-002", "approved");
  await E.tick();
  check("A4 approved subtask built, its test passed → Done", E.card("T-002").status === "done");
  check("A4 the card records the files its run changed (snapshot at claim time)", JSON.stringify(E.card("T-002").changed_files) === '["a.txt"]');
  check("A4 no prose handoff any more: the executor isn't asked for one", !firstPrompt(E, "exec", "T-002").includes("<<<HANDOFF>>>") && !fs.existsSync(path.join(E.mind, "handoffs")));
  check("A4 the card is pinned to the project it was built in", E.card("T-002").project === E.project && E.card("T-001").project === E.project);

  await E.tick();
  check("A5 T-003 planned once T-002 is done, with a pointer to T-002's files",
    E.card("T-003").status === "plan_created" && firstPrompt(E, "plan", "T-003").includes("FILES CHANGED BY RELATED CARDS") && firstPrompt(E, "plan", "T-003").includes("- T-002 Page A: a.txt"));
  E.move("T-003", "approved");
  await E.tick();
  check("A5 T-003 built → Done, and its executor got the pointer to a.txt",
    E.card("T-003").status === "done" && firstPrompt(E, "exec", "T-003").includes("- T-002 Page A: a.txt"));
  check("A5 T-003 is credited with ONLY its own file (not a.txt, written just before it was claimed)",
    JSON.stringify(E.card("T-003").changed_files) === '["b.txt"]');

  await E.tick();
  g = E.card("T-001");
  const waveCall = E.calls().find((c) => c.stage === "wave");
  check("A6 wave done + goal test fails → wave job ran with the failing output and every subtask's files",
    waveCall && waveCall.prompt.includes("GOAL TEST OUTPUT NOW") && waveCall.prompt.includes("- T-002 Page A: a.txt") && waveCall.prompt.includes("- T-003 Page B: b.txt"));
  check("A6 wave 2 created: T-004, depends on T-003 by id; duplicate 'page a' dropped",
    g.wave === 2 && g.waves_done === 1 && E.card("T-004")?.wave === 2 && JSON.stringify(E.card("T-004").depends_on) === '["T-003"]' && E.tasks().length === 4);
  check("A6 duplicate reported to the human", g.conversation.at(-1).text.includes("dropped duplicate"));

  await E.tick();
  E.move("T-004", "approved");
  await E.tick();
  check("A7 wave-2 subtask built → Done", E.card("T-004").status === "done");
  await E.tick();
  g = E.card("T-001");
  check("A7 goal test passes → goal Done", g.status === "done" && g.waves_done === 2);
  check("A7 nobody executed the goal card itself", promptsFor(E, "exec", "T-001").length === 0);
}

// =====================================================================
// B. Budget: max_waves=1 → goal Blocked, no wave job
// =====================================================================
{
  const E = makeEnv({ longHorizon: { max_waves: 1 }, rules: [
    goalPlan("# CARD T-001:", "test -f a.txt\ntest -f z.txt", [{ title: "Only A" }]),
    briefPlan("# CARD T-002:", "T-002", "test -f a.txt"),
    execRule("# T-002 —", { "a.txt": "A" }),
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true);
  await E.tick(); await E.tick(); E.move("T-002", "approved"); await E.tick(); await E.tick();
  const g = E.card("T-001");
  check("B budget max_waves reached + goal test failing → goal Blocked with the reason",
    g.status === "blocked" && g.notes.includes("budget reached (1 waves)") && E.calls().every((c) => c.stage !== "wave"));
}

// =====================================================================
// C. STUCK → goal Blocked with Dory's reason
// =====================================================================
{
  const E = makeEnv({ rules: [
    goalPlan("# CARD T-001:", "test -f a.txt\ntest -f z.txt", [{ title: "Only A" }]),
    briefPlan("# CARD T-002:", "T-002", "test -f a.txt"),
    execRule("# T-002 —", { "a.txt": "A" }),
    { stage: "wave", match: "# CARD T-001:", out: "<<<STUCK>>>\nNeed the API key for the payment provider.\n<<<END>>>" },
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true);
  await E.tick(); await E.tick(); E.move("T-002", "approved"); await E.tick(); await E.tick();
  const g = E.card("T-001");
  check("C STUCK → goal Blocked, reason shown to the human", g.status === "blocked" && g.conversation.at(-1).text.includes("API key"));
}

// =====================================================================
// D. Depth limit: a subtask that keeps answering GOAL → Blocked
// =====================================================================
{
  const sub = goalPlan("# CARD T-002:", "true", [{ title: "deeper" }]);
  const E = makeEnv({ rules: [
    goalPlan("# CARD T-001:", "test -f z.txt", [{ title: "Sub" }]), sub, { ...sub },
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true); await E.tick();
  await E.tick();
  check("D subtask answering GOAL is rejected (stays in Plan queue, not a goal)", E.card("T-002").status === "plan_queue" && E.card("T-002").kind !== "goal");
  E.dory.wake("T-002"); await E.tick();
  check("D …second time → Blocked (subtasks can't have subtasks), no new cards", E.card("T-002").status === "blocked" && E.tasks().length === 2);
}

// =====================================================================
// E. Goal test already passing before wave 1 → Blocked, nothing created
// =====================================================================
{
  const E = makeEnv({ rules: [goalPlan("# CARD T-001:", "true", [{ title: "A" }])] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true); await E.tick();
  check("E goal test passes before any work → goal Blocked, no subtasks", E.card("T-001").status === "blocked" && E.tasks().length === 1);
}

// =====================================================================
// F. A blocked subtask pauses the goal (no wave job, note on the goal)
// =====================================================================
{
  const E = makeEnv({ rules: [
    goalPlan("# CARD T-001:", "test -f a.txt", [{ title: "A" }]),
    briefPlan("# CARD T-002:", "T-002", "test -f a.txt"),
    execRule("# T-002 —", {}), execRule("# T-002 —", {}),   // two failed attempts
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true); await E.tick(); await E.tick();
  E.move("T-002", "approved"); await E.tick(); await E.tick(); await E.tick();
  const g = E.card("T-001");
  check("F subtask blocked after max attempts → goal paused (still In progress), no wave job",
    E.card("T-002").status === "blocked" && g.status === "in_progress" && g.notes.includes("paused: T-002") && E.calls().every((c) => c.stage !== "wave"));
}

// =====================================================================
// G/H. Wave validation: cycle rejected; per-wave and total caps
// =====================================================================
{
  const E = makeEnv({ longHorizon: { max_subtasks_per_wave: 2, max_subtasks_total: 3 }, rules: [
    goalPlan("# CARD T-001:", "test -f a.txt\ntest -f z.txt", [{ title: "A" }]),
    briefPlan("# CARD T-002:", "T-002", "test -f a.txt"),
    execRule("# T-002 —", { "a.txt": "A" }),
    { stage: "wave", match: "# CARD T-001:", out: `<<<SUBTASKS>>>\n${JSON.stringify([{ title: "X", depends_on: [1] }, { title: "Y", depends_on: [0] }])}\n<<<END>>>` },
    { stage: "wave", match: "# CARD T-001:", out: `<<<SUBTASKS>>>\n${JSON.stringify([{ title: "P" }, { title: "Q" }, { title: "R" }, { title: "S", depends_on: [9, "T-999"] }])}\n<<<END>>>` },
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true); await E.tick(); await E.tick();
  E.move("T-002", "approved"); await E.tick(); await E.tick();
  check("G dependency cycle → whole wave rejected, nothing created, goal told", E.tasks().length === 2 && E.card("T-001").notes.includes("cycle"));
  E.dory.wake("T-001"); await E.tick();
  const subs = E.tasks().filter((t) => t.parent === "T-001");
  check("H wave capped: per-wave 2 (and total 3) → exactly 2 new subtasks", subs.length === 3 && E.card("T-001").wave === 2);
  check("H the cap is reported to the human", E.card("T-001").conversation.at(-1).text.includes("capped at 2"));
}

// =====================================================================
// I. Normal cards: planned AHEAD by default (the whole backlog is reviewable)
// =====================================================================
{
  const E = makeEnv({ rules: [
    briefPlan("# CARD T-001:", "T-001", "test -f one.txt"),
    execRule("# T-001 —", { "one.txt": "1" }),
    briefPlan("# CARD T-002:", "T-002", "test -f two.txt"),
  ] });
  E.add({ title: "First", status: "plan_queue" });
  const second = E.add({ title: "Second", status: "plan_queue" });
  E.patch(second, { depends_on: ["T-001"] });
  await E.tick(); await E.tick();
  check("I normal card: BRIEF → Plan created, not a goal", E.card("T-001").status === "plan_created" && !E.card("T-001").kind);
  check("I default: a normal card is planned AHEAD even though its dependency isn't built", E.card("T-002").status === "plan_created");
  E.move("T-001", "approved"); E.dispatch(true); await E.tick();
  check("I a normal card that passes records its changed files too", E.card("T-001").status === "done" && JSON.stringify(E.card("T-001").changed_files) === '["one.txt"]');
}

// =====================================================================
// I2. jit_planning "all": every card waits for its dependencies to be built
// =====================================================================
{
  const E = makeEnv({ rules: [
    briefPlan("# CARD T-001:", "T-001", "test -f one.txt"),
    execRule("# T-001 —", { "one.txt": "1" }),
    briefPlan("# CARD T-002:", "T-002", "test -f two.txt"),
  ] });
  E.setConfig({ jit_planning: "all" });
  E.add({ title: "First", status: "plan_queue" });
  const second = E.add({ title: "Second", status: "plan_queue" });
  E.patch(second, { depends_on: ["T-001"] });
  await E.tick(); await E.tick();
  check("I2 jit_planning=all: a card with an unbuilt dependency is NOT planned yet", promptsFor(E, "plan", "T-002").length === 0);
  E.move("T-001", "approved"); E.dispatch(true); await E.tick(); await E.tick();
  check("I2 …planned once it's built, with a pointer to the files it changed",
    E.card("T-002").status === "plan_created" && firstPrompt(E, "plan", "T-002").includes("- T-001 First: one.txt"));
}

// =====================================================================
// K. Handoff in a git project: pre-existing uncommitted edits aren't credited
// =====================================================================
{
  const E = makeEnv({ gitProject: true, rules: [
    goalPlan("# CARD T-001:", "test -f new.txt\ntest -f z.txt", [{ title: "N" }]),
    briefPlan("# CARD T-002:", "T-002", "test -f new.txt"),
    execRule("# T-002 —", { "new.txt": "n" }),
  ] });
  E.add({ title: "Goal", status: "plan_queue" });
  await E.tick(); E.move("T-001", "approved"); E.dispatch(true); await E.tick(); await E.tick();
  E.move("T-002", "approved"); await E.tick();
  check("K git project: changed files list the new file, not the old uncommitted edit", JSON.stringify(E.card("T-002").changed_files) === '["new.txt"]');
}

// =====================================================================
// P. Project pinning: a card is only ever worked on in its own project
// =====================================================================
{
  const E = makeEnv({ rules: [
    briefPlan("# CARD T-001:", "T-001", "true"),
    briefPlan("# CARD T-002:", "T-002", "true"),
    briefPlan("# CARD T-003:", "T-003", "true"),
    briefPlan("# CARD T-004:", "T-004", "true"),
  ] });
  const projectA = E.project;
  const projectB = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, "projB-")));
  E.add({ title: "A card", status: "plan_queue" });
  E.patch("T-001", { project: projectA });
  E.setConfig({ project_dir: projectB });          // ù pressed in another project
  await E.tick();
  check("P1 a pinned card runs in ITS project, not the current one", E.calls()[0]?.cwd === projectA && E.card("T-001").status === "plan_created");

  E.add({ title: "legacy card", status: "plan_queue" }); // no project (pre-pinning board)
  await E.tick();
  check("P2 an unpinned card adopts the current project on its first job", E.card("T-002").project === projectB && E.calls()[1]?.cwd === projectB);

  E.add({ title: "orphan", status: "plan_queue" });
  E.patch("T-003", { project: path.join(ROOT, "deleted-project") });
  await E.tick();
  check("P3 a card whose project folder is gone isn't run anywhere, human told",
    E.calls().length === 2 && E.card("T-003").notes.includes("no longer exists"));

  // /dory attached (session runner) while ù points at project B
  E.setConfig({ runner_mode: "session" });
  E.patch("T-003", { status: "chat" });              // park the orphan
  E.add({ title: "A again", status: "plan_queue" });
  E.patch("T-004", { project: projectA });
  E.dory.runnerPing();
  await E.tick();
  check("P4 /dory session in project B: a project-A card is held, not run in B",
    E.dory.runnerPoll().job === null && E.card("T-004").notes.includes(`belongs to ${projectA}`));
  E.setConfig({ project_dir: projectA });
  E.dory.wake("T-004");
  E.dory.runnerPing();
  await E.tick();
  const job = E.dory.runnerPoll().job;
  check("P4 …after ù in project A, the job goes to the /dory session", job?.taskId === "T-004" && job.kind === "plan");
}

fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(report() ? 1 : 0);
