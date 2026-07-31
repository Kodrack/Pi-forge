// FUNCTIONAL test: drives the REAL deep-plan code against a fake ExtensionAPI,
// with process.cwd() pointed at a throwaway project holding a real _plan.md.
//
// Only PHASE 2 (step-order enforcement) is exercised here. Phase 1 spawns a
// `pi -p` subprocess against a live model — that belongs in bench/live, not in a
// suite that has to run instantly and offline.
//
// The cases that matter are the ALLOW ones. A gate that blocks everything looks
// like it works right up until it stops the model from finishing anything, so
// every block case below is paired with the nearest legal action.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-plan-")));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, ".think"), { recursive: true });
process.chdir(PROJ);

const SRC = path.join(REPO_ROOT, "extensions", "deep-plan.ts");
const stripped = path.join(TMP, "deep-plan.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));

const PLAN = path.join(PROJ, ".think", "_plan.md");
const writePlan = (steps) =>
  fs.writeFileSync(PLAN, `# Plan: test\n\n## Steps\n${steps}\n\n## Risks\nnone\n`);

// Fresh instance per case: the guard keeps per-session block counters.
async function load() {
  const mod = await import(`${stripped}?v=${Math.random()}`);
  let toolCall;
  const commands = {};
  mod.default({
    on: (ev, h) => { if (ev === "tool_call") toolCall = h; },
    registerCommand: (name, spec) => { commands[name] = spec; },
    sendMessage: async () => {},
  });
  return { toolCall, commands };
}

const results = [];
const check = (label, ok) => results.push([label, ok]);
const isBlocked = async (v) => !!(await v)?.block;

const stateWrite = (tc, content) =>
  tc({ toolName: "write", input: { path: ".think/_state.md", content } }, {});
const planWrite = (tc, content) =>
  tc({ toolName: "write", input: { path: ".think/_plan.md", content } }, {});

const DONE = "## Status: complete\n## Next Action: none";

// ---- completion gating ----
{
  writePlan("1. [x] scaffold — CHECK: file exists\n2. [ ] wire it up — CHECK: node app.js exits 0");
  const { toolCall } = await load();
  const r = await stateWrite(toolCall, DONE);
  check("Status: complete with an open step → blocked", !!r?.block);
  check("  ...and the reason names the open step number", /step\(s\): 2|step 2/.test(r?.reason ?? ""));
  check("  ...and tells the model not to retry", /do NOT retry/i.test(r?.reason ?? ""));
}
{
  writePlan("1. [x] scaffold — CHECK: file exists\n2. [x] wire it up — CHECK: node app.js exits 0");
  const { toolCall } = await load();
  check("Status: complete with ALL steps done → allowed", !(await isBlocked(stateWrite(toolCall, DONE))));
}
{
  writePlan("1. [ ] only step — CHECK: it works");
  const { toolCall } = await load();
  check("in-progress state write while a step is open → allowed", !(await isBlocked(stateWrite(toolCall, "## Status: in-progress"))));
}

// ---- step-order gating ----
{
  writePlan("1. [ ] first — CHECK: a\n2. [ ] second — CHECK: b\n3. [ ] third — CHECK: c");
  const { toolCall } = await load();
  const skip = "## Steps\n1. [ ] first — CHECK: a\n2. [ ] second — CHECK: b\n3. [x] third — CHECK: c";
  const r = await planWrite(toolCall, skip);
  check("marking step 3 done while step 1 is open → blocked", !!r?.block);
  check("  ...and the reason points at step 1", /step 1/.test(r?.reason ?? ""));
}
{
  writePlan("1. [ ] first — CHECK: a\n2. [ ] second — CHECK: b");
  const { toolCall } = await load();
  const inOrder = "## Steps\n1. [x] first — CHECK: a\n2. [ ] second — CHECK: b";
  check("marking the CURRENT step done → allowed", !(await isBlocked(planWrite(toolCall, inOrder))));
}
{
  writePlan("1. [x] first — CHECK: a\n2. [ ] second — CHECK: b\n3. [ ] third — CHECK: c");
  const { toolCall } = await load();
  const next = "## Steps\n1. [x] first — CHECK: a\n2. [x] second — CHECK: b\n3. [ ] third — CHECK: c";
  check("marking the next step after a done one → allowed", !(await isBlocked(planWrite(toolCall, next))));
}
{
  writePlan("1. [ ] first — CHECK: a\n2. [ ] second — CHECK: b");
  const { toolCall } = await load();
  const edit = "## Steps\n1. [ ] first, reworded — CHECK: a\n2. [ ] second — CHECK: b";
  check("editing plan prose without checking anything off → allowed", !(await isBlocked(planWrite(toolCall, edit))));
}

// ---- scope: no plan, or a plan with no checkboxes, enforces nothing ----
{
  fs.rmSync(PLAN, { force: true });
  const { toolCall } = await load();
  check("no _plan.md at all → completion NOT gated", !(await isBlocked(stateWrite(toolCall, DONE))));
}
{
  fs.writeFileSync(PLAN, "# Plan: prose only\n\nJust do the thing.\n");
  const { toolCall } = await load();
  check("plan with no numbered checkboxes → completion NOT gated", !(await isBlocked(stateWrite(toolCall, DONE))));
}
{
  writePlan("1. [ ] first — CHECK: a");
  const { toolCall } = await load();
  check("source file write is never gated", !(await isBlocked(toolCall({ toolName: "write", input: { path: "src/app.js", content: "x" } }, {}))));
  check("bash is never gated", !(await isBlocked(toolCall({ toolName: "bash", input: { command: "node app.js" } }, {}))));
}

// ---- the safety valve: a model wedged against its own plan is released ----
{
  writePlan("1. [ ] first — CHECK: a");
  const { toolCall } = await load();
  let blocks = 0;
  for (let i = 0; i < 6; i++) if (await isBlocked(stateWrite(toolCall, DONE))) blocks++;
  check(`gives up after repeated blocks (${blocks} of 6 blocked, not all)`, blocks > 0 && blocks < 6);
}

// ---- commands are registered ----
{
  const { commands } = await load();
  check("/plan registered", !!commands.plan);
  check("/plan-status registered", !!commands["plan-status"]);
  check("/plan does not collide with a pi builtin", !["compact", "new", "fork", "model", "resume", "session", "tree"].includes("plan"));
}

// ---- report ----
let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-deep-plan (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
