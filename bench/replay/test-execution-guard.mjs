// Replay test: execution-guard's completion latch.
// Replays the recorded tool-call sequences from the 2026-07-23 hard benchmark
// against the guard's decision logic (mirrored below; markers verify the
// branches still exist in extensions/execution-guard.ts).
//
// Origin: regex-lite runs 2 & 3 — code written, ZERO executions all session,
// Status: complete declared on a file that crashes on load.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "execution-guard.ts";
const src = readExtension(FILE);

const MAX_BLOCKS_PER_SESSION = parseNumericConst(src, "MAX_BLOCKS_PER_SESSION", FILE);

requireMarker(src, "lastExecSeq > lastCodeModSeq", FILE, "release-on-execution check");
requireMarker(src, "lastCodeModSeq === 0", FILE, "not-armed (no code modified) check");
requireMarker(src, "COMPLETE_STATUS.test(newContent)", FILE, "completion-status content check");
requireMarker(src, "bashWritesCode(command)", FILE, "bash-redirect-counts-as-modification check");
requireMarker(src, "Arm at CALL time", FILE, "call-time arming (parallel tool calls in one turn)");

// --- decision logic mirroring the guard ---
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt)$/i;
const EXEC_CMD = /(^|[;&|]\s*)(node|python3?|npm|npx|pnpm|yarn|bun|deno|pytest|go\s+(run|test)|cargo\s+(run|test)|ruby|php|bash\s+\S|sh\s+\S|make|\.\/\S)/;
const COMPLETE = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;
const isCode = (p) => CODE_EXT.test(p) && !p.includes(".think/");
const bashWritesCode = (cmd) => {
  const m = cmd.match(/>>?\s*([^\s;|&]+)/);
  return !!m && isCode(m[1]);
};

// Feed a sequence of {tool, path?, command?, content?}; return list of blocked indexes.
// Mirrors the guard's CALL-TIME arming: code modifications arm the latch the
// moment the call is seen (parallel tool calls in one turn deliver the
// completion write's tool_call before the code write's tool_result — the live
// probe caught exactly that ordering). Executions release only at tool_result.
function run(seqEvents) {
  let seq = 0, lastMod = 0, lastExec = 0, blocks = 0;
  const blockedAt = [];
  seqEvents.forEach((e, i) => {
    // --- tool_call phase ---
    if ((e.tool === "write" || e.tool === "edit") && isCode(e.path ?? "")) {
      seq++; lastMod = seq;
    } else if (e.tool === "bash" && bashWritesCode(e.command ?? "")) {
      seq++; lastMod = seq;
    } else if ((e.tool === "write" || e.tool === "edit") && /\.think\/_state\.md$/.test(e.path ?? "") && COMPLETE.test(e.content ?? "")) {
      if (lastMod !== 0 && !(lastExec > lastMod) && blocks < MAX_BLOCKS_PER_SESSION) {
        blocks++;
        blockedAt.push(i);
        return; // blocked → no tool_result tracking
      }
    }
    // --- tool_result phase (call executed) ---
    seq++;
    if (e.tool === "bash") {
      const cmd = e.command ?? "";
      if (!bashWritesCode(cmd) && EXEC_CMD.test(cmd)) lastExec = seq;
    }
  });
  return blockedAt;
}

const complete = "## Status: complete\ndone";
const inProgress = "## Status: in-progress\nworking";

// Recorded shape of regex-lite run 2: state writes, code write, complete — zero bash.
const run2 = [
  { tool: "write", path: ".think/_state.md", content: inProgress },
  { tool: "write", path: "regex.js" },
  { tool: "edit", path: "regex.js" },
  { tool: "write", path: ".think/_state.md", content: complete }, // ← must block
];

// Same but the model runs its code before declaring: must NOT block.
const healthy = [
  { tool: "write", path: "regex.js" },
  { tool: "bash", command: "node regex.js 'a*' 'aaa'" },
  { tool: "write", path: ".think/_state.md", content: complete },
];

// Doc-only session: no code modified, completion is free.
const docsOnly = [
  { tool: "write", path: "README.md" },
  { tool: "write", path: ".think/_state.md", content: complete },
];

// Modification AFTER the last execution re-arms the latch.
const modAfterExec = [
  { tool: "write", path: "app.js" },
  { tool: "bash", command: "node app.js" },
  { tool: "bash", command: "cat >> app.js <<'CHUNK'\nmore()\nCHUNK" }, // append = modification
  { tool: "write", path: ".think/_state.md", content: complete }, // ← must block
];

// Stubborn model: keeps declaring complete without running — gives up after cap.
const stubborn = [
  { tool: "write", path: "app.js" },
  ...Array(MAX_BLOCKS_PER_SESSION + 2).fill({ tool: "write", path: ".think/_state.md", content: complete }),
];

// Neutral bash (ls) must not release the latch.
const neutralBash = [
  { tool: "write", path: "app.js" },
  { tool: "bash", command: "ls -la && cat app.js" },
  { tool: "write", path: ".think/_state.md", content: complete }, // ← must block
];

// Live-probe failure 2026-07-23: code write + completion write issued as
// PARALLEL calls in one turn (state call arrives before code result).
const parallelTurn = [
  { tool: "write", path: "hello.js" },
  { tool: "write", path: ".think/_state.md", content: complete }, // ← must block
];

const checks = [
  ["recorded run 2 shape (code, zero executions, complete) → blocked", run(run2).length === 1],
  ["parallel same-turn code+complete calls → blocked (live-probe regression)", run(parallelTurn).length === 1],
  ["healthy shape (code, node run, complete) → allowed", run(healthy).length === 0],
  ["docs-only session → never armed, allowed", run(docsOnly).length === 0],
  ["append after execution re-arms → blocked", run(modAfterExec).length === 1],
  [`stubborn re-declares → gives up after ${MAX_BLOCKS_PER_SESSION} blocks`, run(stubborn).length === MAX_BLOCKS_PER_SESSION],
  ["neutral bash (ls/cat) does not release the latch → blocked", run(neutralBash).length === 1],
  ["in-progress status writes are never touched", run([
    { tool: "write", path: "app.js" },
    { tool: "write", path: ".think/_state.md", content: inProgress },
  ]).length === 0],
];

process.exitCode = report("test-execution-guard", checks) === 0 ? 0 : 1;
