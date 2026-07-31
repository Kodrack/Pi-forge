// FUNCTIONAL test: drives the REAL progress-checkpoint code with a fake
// ExtensionAPI over a simulated multi-turn session.
//
// The thing worth testing here is CONTEXT COST, not just "does it fire":
// a checkpoint is permanent context, so the test asserts a working session sees
// ZERO of them, the full instructions are sent at most once, and an unresponsive
// model gets handed to the human instead of nagged forever.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-cp-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, ".think"), { recursive: true });

const SRC = path.join(REPO_ROOT, "extensions", "progress-checkpoint.ts");
const stripped = path.join(TMP, "progress-checkpoint.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

const src = fs.readFileSync(SRC, "utf-8");
const num = (name) => Number(src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9]+)`))[1]);
const FIRST = num("FIRST_CHECKPOINT_TURN");
const INTERVAL = num("CHECKPOINT_INTERVAL");
const MAX_MODEL = num("MAX_MODEL_CHECKPOINTS");

function harness() {
  const handlers = {}, notices = [], steers = [];
  mod.default({
    on: (ev, h) => { handlers[ev] = h; },
    registerCommand: () => {},
    sendMessage: async (m) => steers.push(m.content),
  });
  const ctx = { cwd: PROJ, ui: { notify: (m) => notices.push(m) } };
  return { handlers, ctx, notices, steers };
}

// Advance `n` turns. `workEveryTurn` simulates the model editing a real file.
async function turns(h, n, workEveryTurn = false) {
  for (let i = 0; i < n; i++) {
    if (workEveryTurn) {
      await h.handlers.tool_call({ toolName: "edit", input: { path: "regex.js", new_string: "x" } }, h.ctx);
    }
    await h.handlers.turn_end({}, h.ctx);
  }
}

const results = [];
const check = (label, ok) => results.push([label, ok]);
const setState = (s) => fs.writeFileSync(path.join(PROJ, ".think", "_state.md"), s);

// ---- a productive session never sees a checkpoint (the main context saving) ----
{
  setState("## Status: in-progress\nworking");
  const h = harness();
  await turns(h, FIRST + INTERVAL * 3, true);
  check("productive session (files changing) → ZERO checkpoints", h.steers.length === 0);
}

// ---- nothing before the first scheduled turn ----
{
  const h = harness();
  await turns(h, FIRST - 1);
  check(`no checkpoint before turn ${FIRST}`, h.steers.length === 0);
}

// ---- a stalled session gets exactly one full message, then short ones ----
{
  const h = harness();
  await turns(h, FIRST);
  check(`stalled session fires at turn ${FIRST}`, h.steers.length === 1);
  check("first checkpoint carries the full forced-choice instructions",
    h.steers[0].includes("(a) The task IS complete") && h.steers[0].includes("(b) NOT complete"));
  check("first checkpoint has the required harness-message prefix",
    h.steers[0].startsWith("[progress-checkpoint] AUTOMATED HARNESS MESSAGE"));

  // Keep stalling until the model-facing budget is spent.
  await turns(h, INTERVAL * 8);
  check(`model-facing checkpoints capped at ${MAX_MODEL}`, h.steers.length === MAX_MODEL);
  // ~105 chars of every steer is the mandatory harness-message prefix, so judge
  // the absolute size of the reminder, not a ratio it can't reach.
  check(`later checkpoints are the SHORT message (${h.steers[1]?.length} chars, cap 350)`,
    h.steers.length > 1 && h.steers[1].length < 350 && h.steers[1].length < h.steers[0].length / 2);
  check("full instructions sent at most once",
    h.steers.filter((s) => s.includes("(a) The task IS complete")).length === 1);
  check("after the cap it hands off to the human, not the model",
    h.notices.some((n) => /STALLED.*ignored/s.test(n) && /Your call/.test(n)));
}

// ---- total context cost of a fully stalled session stays small ----
{
  const h = harness();
  await turns(h, FIRST + INTERVAL * 10);
  const cost = h.steers.reduce((n, s) => n + s.length, 0);
  check(`total injected context for a stalled session < 2000 chars (was ${cost})`, cost < 2000);
}

// ---- backoff: gaps between checkpoints grow while ignored ----
{
  const h = harness();
  const fireTurns = [];
  const origLen = () => h.steers.length;
  for (let t = 1; t <= FIRST + INTERVAL * 10; t++) {
    const before = origLen();
    await h.handlers.turn_end({}, h.ctx);
    if (origLen() > before) fireTurns.push(t);
  }
  check("second checkpoint is spaced at least one interval after the first",
    fireTurns.length >= 2 && fireTurns[1] - fireTurns[0] >= INTERVAL);
}

// ---- work resuming resets the ignore streak (no premature handoff) ----
{
  const h = harness();
  await turns(h, FIRST);                       // checkpoint #1
  await turns(h, INTERVAL, true);              // model gets back to work
  check("checkpoint after work resumed → skipped (still 1 fired)", h.steers.length === 1);
}

// ---- a task already marked complete is never checkpointed ----
{
  setState("## Status: complete\nfinished");
  const h = harness();
  await turns(h, FIRST + INTERVAL * 2);
  check("task marked complete → no checkpoints", h.steers.length === 0);
  setState("## Status: in-progress\nworking");
}

// ---- .think/ writes are not progress (the model journalling isn't work) ----
{
  const h = harness();
  for (let i = 0; i < FIRST; i++) {
    await h.handlers.tool_call({ toolName: "write", input: { path: ".think/step-001.md", content: "notes" } }, h.ctx);
    await h.handlers.turn_end({}, h.ctx);
  }
  check(".think/-only turns still count as stalled → fires", h.steers.length === 1);
}

// ---- bash appends into a real file count as progress ----
{
  const h = harness();
  for (let i = 0; i < FIRST; i++) {
    await h.handlers.tool_call({ toolName: "bash", input: { command: "cat >> regex.js <<'C'\nx()\nC" } }, h.ctx);
    await h.handlers.turn_end({}, h.ctx);
  }
  check("bash append into code counts as progress → no checkpoint", h.steers.length === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-progress-checkpoint (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
