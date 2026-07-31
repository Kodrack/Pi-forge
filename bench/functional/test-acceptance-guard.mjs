// FUNCTIONAL test: drives the REAL acceptance-guard code, with a real bash
// spawn, in a throwaway project dir.
//
// Why this tier exists (bench/replay/ already tests this guard):
// replay tests mirror the guard's logic in JS and grep the source for markers.
// That verifies the INTENDED logic, not the shipped code — so it green-lit an
// acceptance-guard that never armed its latch on write/edit tool_calls (only in
// tool_result), because the mirror implemented the arming the extension was
// missing. This tier imports the extension itself, so a divergence like that
// fails instead of passing. Prefer it for anything whose behavior depends on
// real I/O (spawning a test, reading a file, exit codes).
//
// Requires node's type stripping (node >= 22.6):
//   node --experimental-strip-types bench/functional/test-acceptance-guard.mjs
// or just: bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, ".think"), { recursive: true });

// Node can strip types but not resolve the pi package's type-only import from a
// temp dir — drop that line and import the rest verbatim.
const SRC = path.join(REPO_ROOT, "extensions", "acceptance-guard.ts");
const stripped = path.join(TMP, "acceptance-guard.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

const ACC = path.join(PROJ, ".think", "_acceptance.sh");
const complete = "## Status: complete\nall done";
const call = (t, input) => ({ toolName: t, input });

// Fresh guard instance + captured UI/steer output.
function harness() {
  const handlers = {}, notices = [], steers = [];
  mod.default({
    on: (ev, h) => { handlers[ev] = h; },
    registerCommand: () => {},
    sendMessage: async (m) => { steers.push(m.customType); },
  });
  return { handlers, ctx: { cwd: PROJ, ui: { notify: (m) => notices.push(m) } }, notices, steers };
}

const results = [];
const check = (label, ok) => results.push([label, ok]);

// ---- a failing oracle blocks completion and feeds back the real output ----
{
  const { handlers, ctx } = harness();
  fs.writeFileSync(ACC, `echo "FAIL case 3: got 'no match' want 'match'"\nexit 1\n`);
  await handlers.tool_call(call("write", { path: "regex.js", content: "x" }), ctx);
  const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
  check("failing oracle → completion blocked", v?.block === true);
  check("block reason carries the real test output", /FAIL case 3/.test(v?.reason ?? ""));
  check("block reason reports the exit code", /exited 1/.test(v?.reason ?? ""));
  check("block reason forbids editing the test to pass", /do NOT edit the test/.test(v?.reason ?? ""));
}

// ---- a passing oracle lets completion through ----
{
  const { handlers, ctx, notices } = harness();
  fs.writeFileSync(ACC, `echo ok\nexit 0\n`);
  await handlers.tool_call(call("write", { path: "regex.js", content: "x" }), ctx);
  const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
  check("passing oracle → completion allowed", !v);
  check("verified pass is announced to the user", notices.some((n) => /passed — completion verified/.test(n)));
}

// ---- code changed but no oracle → demand one ----
{
  const { handlers, ctx } = harness();
  fs.rmSync(ACC, { force: true });
  await handlers.tool_call(call("write", { path: "regex.js", content: "x" }), ctx);
  const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
  check("no oracle → completion blocked", v?.block === true);
  check("block reason demands an acceptance script", /_acceptance\.sh/.test(v?.reason ?? ""));
}

// ---- doc-only session is never gated (no false positives) ----
{
  const { handlers, ctx } = harness();
  await handlers.tool_call(call("write", { path: "README.md", content: "x" }), ctx);
  const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
  check("docs-only session → not armed, allowed", !v);
}

// ---- bash chunked-append into code arms the latch ----
{
  const { handlers, ctx } = harness();
  fs.writeFileSync(ACC, `exit 1\n`);
  await handlers.tool_call(call("bash", { command: "cat >> regex.js <<'CHUNK'\nmatch()\nCHUNK" }), ctx);
  const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
  check("bash append into code arms the latch → blocked", v?.block === true);
}

// ---- give-up valve: a stubborn model is handed back, never trapped ----
{
  const { handlers, ctx, notices } = harness();
  fs.writeFileSync(ACC, `exit 1\n`);
  await handlers.tool_call(call("write", { path: "regex.js", content: "x" }), ctx);
  let blocked = 0;
  for (let i = 0; i < 6; i++) {
    const v = await handlers.tool_call(call("write", { path: ".think/_state.md", content: complete }), ctx);
    if (v?.block) blocked++;
  }
  check("give-up valve caps blocks (no infinite loop)", blocked === 3);
  check("give-up is announced as UNVERIFIED", notices.some((n) => /giving up/i.test(n)));
}

// ---- a fake oracle (passes with no implementation) is caught ----
{
  const { handlers, ctx, steers } = harness();
  fs.writeFileSync(ACC, `exit 0\n`);
  await handlers.turn_end({}, ctx);
  check("oracle passing pre-implementation → steered for a real test",
    steers.includes("acceptance_guard_fake_test"));
}

// ---- in-progress checkpoints are never gated ----
{
  const { handlers, ctx } = harness();
  fs.writeFileSync(ACC, `exit 1\n`);
  await handlers.tool_call(call("write", { path: "regex.js", content: "x" }), ctx);
  const v = await handlers.tool_call(
    call("write", { path: ".think/_state.md", content: "## Status: in-progress\nworking" }), ctx);
  check("in-progress checkpoint → allowed", !v);
}

fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-acceptance-guard (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
