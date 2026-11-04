// FUNCTIONAL test: on-demand web research ("🔎 Research" on a card), driven
// through the REAL Dory engine with a scripted fake `pi` (fake-pi/fake-pi.mjs),
// plus the REAL board server's HTTP endpoint.
//
// A card flagged research_requested — in any column but In Progress — gets a
// read-only research job; Dory's TITLE/DESCRIPTION replace the card's title and
// description IN PLACE (the card doesn't move), the original text is quoted in
// her message with the sources, and a card that already has a plan is told to
// replan.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createDory } = await import(path.join(REPO, "organizer/board/dory.mjs"));
const { applyMove, createTask } = await import(path.join(REPO, "organizer/board/board-core.mjs"));
const FAKE_PI = path.join(REPO, "bench/functional/fake-pi/fake-pi.mjs");
fs.chmodSync(FAKE_PI, 0o755);
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-research-")));

const checks = [];
const check = (label, ok) => checks.push([label, !!ok]);
let server = null;
function report(extra) {
  let failed = 0;
  for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
  if (extra) { console.log(`  FAIL  ${extra}`); failed++; }
  console.log(`test-dory-research (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  return failed;
}
process.on("uncaughtException", (err) => { server?.kill(); report(`crashed after the last check above: ${err?.message ?? err}`); process.exit(1); });

let n = 0;
function makeEnv(rules) {
  const dir = path.join(ROOT, `env-${++n}`);
  const mind = path.join(dir, "mind");
  const project = path.join(dir, "project");
  fs.mkdirSync(mind, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(mind, "config.json"), JSON.stringify({ project_dir: project, pi_bin: FAKE_PI, runner_mode: "auto", dory_thinking: "off" }));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(scenario, JSON.stringify(rules));
  process.env.FAKE_PI_SCENARIO = scenario;
  process.env.FAKE_PI_LOG = log;
  const boardPath = path.join(mind, "tasks.json");
  const loadBoard = () => { try { return JSON.parse(fs.readFileSync(boardPath, "utf-8")); } catch { return { version: 1, dispatch: false, tasks: [] }; } };
  const saveBoard = (b) => fs.writeFileSync(boardPath, JSON.stringify(b, null, 2));
  const dory = createDory({ mindDir: mind, loadBoard, saveBoard, applyMove, createTask });
  return {
    mind, dory,
    card: (id) => loadBoard().tasks.find((t) => t.id === id),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    add: (fields, extra = {}) => { const b = loadBoard(); const t = createTask(b, fields, "human"); Object.assign(t, extra); saveBoard(b); return t.id; },
    patch: (id, fields) => { const b = loadBoard(); Object.assign(b.tasks.find((t) => t.id === id), fields); saveBoard(b); },
    say: (id, text) => { const b = loadBoard(); b.tasks.find((t) => t.id === id).conversation.push({ at: new Date().toISOString(), by: "human", text }); saveBoard(b); },
    tick: async (k = 1) => { for (let i = 0; i < k; i++) await dory.tick(); },
  };
}
const researchOut = (title, desc) =>
  `${title ? `<<<TITLE>>>\n${title}\n` : ""}<<<DESCRIPTION>>>\n${desc}\n<<<SOURCES>>>\n- https://example.org/docs — current API\n<<<REPLY>>>\nMade it concrete.\n<<<END>>>`;
const asked = { research_requested: new Date().toISOString() };

// ---- R1: a fresh Chat card, researched in place ----
{
  const E = makeEnv([{ stage: "research", match: "# CARD T-001:", out: researchOut("Add dark mode with CSS prefers-color-scheme", "Use `prefers-color-scheme` + a toggle in localStorage.\n\nOpen questions: default theme?") }]);
  E.add({ title: "dark mode", status: "chat", notes: "make the site dark" }, asked);
  await E.tick();
  const c = E.card("T-001");
  const call = E.calls()[0];
  check("R1 research job ran as the read-only 'research' stage", call?.stage === "research");
  check("R1 the Research persona reached the model (button wording + web_search)", call?.prompt.includes('pressed "🔎 Research"') && call.prompt.includes("web_search"));
  check("R1 dispatch switch OFF didn't stop it (read-only job)", !c.research_requested);
  check("R1 title and description rewritten", c.title === "Add dark mode with CSS prefers-color-scheme" && c.notes.startsWith("Use `prefers-color-scheme`"));
  check("R1 the card stays in its column (Chat)", c.status === "chat" && c.history.length === 1);
  const msg = c.conversation.at(-1);
  check("R1 message keeps the ORIGINAL title + description and lists sources",
    msg.by === "dory" && msg.text.includes("(was: dark mode)") && msg.text.includes("> make the site dark") && msg.text.includes("https://example.org/docs"));
  check("R1 Dory's REPLY is included", msg.text.startsWith("Made it concrete."));
  await E.tick();
  check("R1 the request is cleared: not researched again", E.calls().length === 1 && c.researched);
}

// ---- R2: a card with a plan stays put and is told to replan ----
{
  const E = makeEnv([{ stage: "research", match: "# CARD T-001:", out: researchOut("Better", "Deeper description.") }]);
  E.add({ title: "planned card", status: "chat" }, { ...asked, brief: "tasks/T-001.md" });
  E.patch("T-001", { status: "plan_created" });
  await E.tick();
  const c = E.card("T-001");
  check("R2 card in Plan Created is researched without moving", c.status === "plan_created" && c.notes === "Deeper description.");
  check("R2 …and Dory points out its plan was written for the old description", c.conversation.at(-1).text.includes('Reply "replan"'));
}

// ---- R3: never while In Progress ----
// A normal In Progress card ends the engine's tick before the research step, so
// the case the filter really guards is a GOAL card: it sits In Progress while
// its subtasks run, and the tick goes on past it.
{
  const E = makeEnv([{ stage: "research", match: "# CARD T-001:", out: researchOut("X", "Y") }]);
  E.add({ title: "running goal", status: "chat" }, { ...asked, kind: "goal", wave: 1, goal: "g" });
  E.patch("T-001", { status: "in_progress" });
  await E.tick();
  check("R3 a goal In Progress is not researched (the flag waits)", E.calls().every((c) => c.stage !== "research") && E.card("T-001").research_requested);
}

// ---- R4: missing TITLE → title kept ----
{
  const E = makeEnv([{ stage: "research", match: "# CARD T-001:", out: researchOut(null, "Better description.") }]);
  E.add({ title: "keep me", status: "chat" }, asked);
  await E.tick();
  const c = E.card("T-001");
  check("R4 no TITLE block → title unchanged, description updated", c.title === "keep me" && c.notes === "Better description." && c.conversation.at(-1).text.includes("(unchanged)"));
}

// ---- R5: failures: retry after cooldown, give up after 3 ----
{
  const bad = { stage: "research", match: "# CARD T-001:", out: "I could not find anything." };
  const E = makeEnv([bad, { ...bad }, { ...bad }]);
  E.add({ title: "x", status: "chat", notes: "original" }, asked);
  await E.tick();
  let c = E.card("T-001");
  check("R5 no DESCRIPTION → description untouched, request kept, human told", c.notes.includes("original") && c.research_requested && c.notes.includes("will retry"));
  await E.tick();
  check("R5 cooldown: no immediate retry", E.calls().length === 1);
  E.dory.wake("T-001"); await E.tick();
  E.dory.wake("T-001"); await E.tick();
  c = E.card("T-001");
  check("R5 after 3 failures the request is dropped and the human told", !c.research_requested && c.notes.includes("gave up") && E.calls().length === 3);
  E.dory.wake("T-001"); await E.tick();
  check("R5 …and nothing retries after giving up", E.calls().length === 3);
}

// ---- R6: a waiting human message is answered first ----
{
  const E = makeEnv([
    { stage: "chat", match: "# CARD T-001:", out: "<<<REPLY>>>\nSure, I'll focus on mobile.\n<<<END>>>" },
    { stage: "research", match: "# CARD T-001:", out: researchOut("Mobile nav", "Hamburger menu below 768px.") },
  ]);
  const id = E.add({ title: "nav", status: "chat" }, asked);
  E.say(id, "focus on mobile please");
  await E.tick();
  check("R6 reply comes before research (a waiting human beats queued work)", E.calls()[0]?.stage === "chat" && E.card(id).research_requested);
  await E.tick();
  check("R6 …then research runs and sees the conversation", E.calls()[1]?.stage === "research" && E.calls()[1].prompt.includes("focus on mobile please") && !E.card(id).research_requested);
}

// ---- S: the real server's HTTP endpoint ----
{
  const mind = path.join(ROOT, "server-mind");
  fs.mkdirSync(mind, { recursive: true });
  // Seed an In Progress card BEFORE the server starts: editing tasks.json under a
  // running server races its engine's own saves. (Dispatch off + a card in
  // progress also keeps the engine idle for the whole test.)
  {
    const b = { version: 1, dispatch: false, tasks: [] };
    const t = createTask(b, { title: "being built", status: "chat" }, "human");
    t.status = "in_progress";
    fs.writeFileSync(path.join(mind, "tasks.json"), JSON.stringify(b));
  }
  const port = 47000 + Math.floor(Math.random() * 900);
  server = spawn(process.execPath, [path.join(REPO, "organizer/board/server.mjs"), mind], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  const call = async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  for (let i = 0; i < 40; i++) { try { await call("/api/board"); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const created = await call("/api/tasks", "POST", { title: "with research", status: "chat", research: true });
  check("S create with research:true → card born with the request", created.status === 201 && created.data.research_requested);
  const plain = await call("/api/tasks", "POST", { title: "plain", status: "plan_queue" });
  const r1 = await call(`/api/tasks/${plain.data.id}/research`, "POST", {});
  check("S POST /research flags a card in any column (Plan Queue), card stays put", r1.status === 200 && r1.data.research_requested && r1.data.status === "plan_queue");
  const r2 = await call(`/api/tasks/T-001/research`, "POST", {});
  check("S POST /research on an In Progress card → 409 with an explanation", r2.status === 409 && /being built/.test(r2.data.error));
  const page = await (await fetch(base + "/")).text();
  check("S board page has the 🔎 Research button and the research-first box", page.includes('id="dResearch"') && page.includes('id="newResearch"'));
  server.kill();
  server = null;
}

fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(report() ? 1 : 0);
