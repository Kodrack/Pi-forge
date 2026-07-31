// Replay test: acceptance-guard's harness-owned done check.
// Replays completion sequences against the guard's decision logic (mirrored
// below; markers verify the branches still exist in extensions/acceptance-guard.ts).
//
// Origin: the 2026-07-26 regex-engine trace. The model spent one 29,781-char
// turn re-litigating its approach, reached the right answer twice, discarded it
// both times, and wrote zero code — because nothing in the session could say
// whether it was done. execution-guard would not have helped: its EXEC_COMMAND
// is satisfied by any spawn, so "node --version" counts as verification.
// This guard makes the exit code of .think/_acceptance.sh the verdict.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "acceptance-guard.ts";
const src = readExtension(FILE);

const MAX_BLOCKS_PER_SESSION = parseNumericConst(src, "MAX_BLOCKS_PER_SESSION", FILE);
const OUTPUT_TAIL_CHARS = parseNumericConst(src, "OUTPUT_TAIL_CHARS", FILE);

requireMarker(src, "lastCodeModSeq === 0 || gaveUp", FILE, "not-armed / gave-up escape");
requireMarker(src, "COMPLETE_STATUS.test(newContent)", FILE, "completion-status content check");
requireMarker(src, "await runAcceptance(ctx.cwd)", FILE, "harness (not model) runs the oracle");
requireMarker(src, "result.code === 0", FILE, "exit code decides completion");
requireMarker(src, "blocksThisSession >= MAX_BLOCKS_PER_SESSION", FILE, "give-up safety valve");
requireMarker(src, "CALL time as well as result time", FILE, "call-time arming (parallel tool calls)");
requireMarker(src, "do NOT edit the test to make it pass", FILE, "anti-cheat instruction in block reason");

// --- decision logic mirroring the guard ---
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt)$/i;
const COMPLETE = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;
const isCode = (p) => CODE_EXT.test(p) && !p.includes(".think/");
const bashWritesCode = (cmd) => {
  const m = cmd.match(/>>?\s*([^\s;|&]+)/);
  return !!m && isCode(m[1]);
};

// Feed {tool, path?, command?, content?, testExists?, testExit?}; per-event
// testExists/testExit model the oracle's state at that moment (so a scenario can
// simulate the model fixing the code between declarations).
// Returns { blockedAt, reasons, gaveUp }.
function run(events) {
  let seq = 0, lastMod = 0, blocks = 0, gaveUp = false;
  const blockedAt = [], reasons = [];

  events.forEach((e, i) => {
    // --- tool_call phase: code modifications arm at CALL time ---
    if ((e.tool === "write" || e.tool === "edit") && isCode(e.path ?? "")) {
      seq++; lastMod = seq; return;
    }
    if (e.tool === "bash" && bashWritesCode(e.command ?? "")) {
      seq++; lastMod = seq; return;
    }

    // --- gate 2: the done check ---
    const isState = /\.think\/_state\.md$/.test(e.path ?? "");
    if ((e.tool === "write" || e.tool === "edit") && isState && COMPLETE.test(e.content ?? "")) {
      if (lastMod === 0 || gaveUp) return;              // doc session / already gave up

      if (!e.testExists) {                              // no oracle → demand one
        if (blocks >= MAX_BLOCKS_PER_SESSION) { gaveUp = true; return; }
        blocks++; blockedAt.push(i); reasons.push("no-test");
        return;
      }
      if (e.testExit === 0) return;                     // verified → allow
      if (blocks >= MAX_BLOCKS_PER_SESSION) { gaveUp = true; return; }
      blocks++; blockedAt.push(i); reasons.push("test-failed");
      return;
    }
    seq++;
  });

  return { blockedAt, reasons, gaveUp };
}

const complete = "## Status: complete\ndone";
const inProgress = "## Status: in-progress\nworking";

// The regex trace, had the model actually produced code: declares complete with
// a failing acceptance test — (a|ab)*c against "ababc" still not matching.
const failingTest = [
  { tool: "write", path: "regex.js" },
  { tool: "edit", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 1 },
];

// Same session, model fixes the cause and re-declares: now allowed.
const fixedAfterBlock = [
  { tool: "write", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 1 },
  { tool: "edit", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 0 },
];

// Code written, no oracle at all → completion is unverifiable, demand a test.
const noTest = [
  { tool: "write", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: false },
];

// Doc-only session: never armed, completion is free (no test demanded).
const docsOnly = [
  { tool: "write", path: "README.md" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: false },
];

// Chunked-append recovery path arms the latch too (bash >> into a code file).
const appendArms = [
  { tool: "bash", command: "cat >> regex.js <<'CHUNK'\nmatch()\nCHUNK" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 1 },
];

// Stubborn model re-declares against a permanently failing test: blocks up to
// the cap, then hands back to the human UNVERIFIED rather than looping forever.
const stubborn = [
  { tool: "write", path: "regex.js" },
  ...Array(MAX_BLOCKS_PER_SESSION + 2).fill(
    { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 1 }
  ),
];

// Live-probe ordering: code write + completion write as parallel calls in one turn.
const parallelTurn = [
  { tool: "write", path: "hello.js" },
  { tool: "write", path: ".think/_state.md", content: complete, testExists: true, testExit: 1 },
];

// in-progress checkpoints are never gated.
const checkpoint = [
  { tool: "write", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: inProgress, testExists: true, testExit: 1 },
];

const checks = [
  ["failing acceptance test at completion → blocked", run(failingTest).reasons[0] === "test-failed"],
  ["passing acceptance test → completion allowed", run([failingTest[0], { ...failingTest[2], testExit: 0 }]).blockedAt.length === 0],
  ["fix after a block, re-declare with exit 0 → allowed on 2nd try", run(fixedAfterBlock).blockedAt.length === 1],
  ["code modified but no oracle → blocked, test demanded", run(noTest).reasons[0] === "no-test"],
  ["docs-only session → never armed, no test demanded", run(docsOnly).blockedAt.length === 0],
  ["bash append into code arms the latch → blocked", run(appendArms).blockedAt.length === 1],
  ["parallel same-turn code+complete calls → blocked", run(parallelTurn).blockedAt.length === 1],
  [`stubborn re-declares → ${MAX_BLOCKS_PER_SESSION} blocks then hands back`,
    run(stubborn).blockedAt.length === MAX_BLOCKS_PER_SESSION && run(stubborn).gaveUp === true],
  ["in-progress status writes are never gated", run(checkpoint).blockedAt.length === 0],
  ["output tail is bounded (context safety)", OUTPUT_TAIL_CHARS > 0 && OUTPUT_TAIL_CHARS <= 4000],
];

process.exitCode = report("test-acceptance-guard", checks) === 0 ? 0 : 1;
