// Replay test: incremental-guard block decisions (write / edit / bash caps).
// Thresholds are parsed live from extensions/incremental-guard.ts; the decision
// logic below is a copy of the guard's tool_call branches (markers verify the
// branches still exist in the source).
//
// Origin: benchmark 2026-07-22 — a single bash heredoc wrote a 150-line file
// with zero blocks, 5/5 live trials, because the guard only inspected write/edit.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "incremental-guard.ts";
const src = readExtension(FILE);

const MAX_LINES_PER_WRITE = parseNumericConst(src, "MAX_LINES_PER_WRITE", FILE);
const MAX_CHARS_PER_WRITE = parseNumericConst(src, "MAX_CHARS_PER_WRITE", FILE);
const MAX_LINES_PER_EDIT  = parseNumericConst(src, "MAX_LINES_PER_EDIT", FILE);
const MAX_CHARS_PER_EDIT  = parseNumericConst(src, "MAX_CHARS_PER_EDIT", FILE);
const MAX_LINES_PER_BASH  = parseNumericConst(src, "MAX_LINES_PER_BASH", FILE);
const MAX_CHARS_PER_BASH  = parseNumericConst(src, "MAX_CHARS_PER_BASH", FILE);

requireMarker(src, 'event.toolName === "bash"', FILE, "bash cap branch");
requireMarker(src, 'event.toolName === "write"', FILE, "write cap branch");
requireMarker(src, 'event.toolName === "edit"', FILE, "edit cap branch");
requireMarker(src, "oldLines > MAX_LINES_PER_EDIT * 2", FILE, "whole-file-rewrite-via-edit check");

// --- decision logic mirroring the guard ---
const lineCount = (s) => (s ? s.split(/\r?\n/).length : 0);
const blocksWrite = (content) =>
  lineCount(content) > MAX_LINES_PER_WRITE || content.length > MAX_CHARS_PER_WRITE;
const blocksEdit = (newS, oldS = "") =>
  lineCount(newS) > MAX_LINES_PER_EDIT || newS.length > MAX_CHARS_PER_EDIT ||
  lineCount(oldS) > MAX_LINES_PER_EDIT * 2;
const blocksBash = (command) =>
  lineCount(command) > MAX_LINES_PER_BASH || command.length > MAX_CHARS_PER_BASH;

const nLines = (n, line = ".u{margin:0}") => Array(n).fill(line).join("\n");

const checks = [
  // write
  [`write ${MAX_LINES_PER_WRITE + 33} lines → blocked`, blocksWrite(nLines(MAX_LINES_PER_WRITE + 33))],
  [`write ${MAX_LINES_PER_WRITE - 30} lines → allowed`, !blocksWrite(nLines(MAX_LINES_PER_WRITE - 30))],
  [`write ${MAX_CHARS_PER_WRITE + 1000} chars on few lines → blocked`, blocksWrite("x".repeat(MAX_CHARS_PER_WRITE + 1000))],
  // edit
  [`edit ${MAX_LINES_PER_EDIT + 1} lines → blocked`, blocksEdit(nLines(MAX_LINES_PER_EDIT + 1))],
  [`edit ${MAX_LINES_PER_EDIT - 10} lines → allowed`, !blocksEdit(nLines(MAX_LINES_PER_EDIT - 10))],
  [`edit with whole-file old_string (${MAX_LINES_PER_EDIT * 2 + 1} lines) → blocked`, blocksEdit("small", nLines(MAX_LINES_PER_EDIT * 2 + 1))],
  // bash — the closed side door
  [`bash heredoc ${MAX_LINES_PER_BASH + 23} lines → blocked (was 5/5 bypass before fix)`, blocksBash(`cat > big.css <<'EOF'\n${nLines(MAX_LINES_PER_BASH + 21)}\nEOF`)],
  [`bash heredoc ${MAX_CHARS_PER_BASH + 500} chars → blocked`, blocksBash("cat > f <<'EOF'\n" + "x".repeat(MAX_CHARS_PER_BASH + 500) + "\nEOF")],
  [`bash normal command (149 chars, 1 line) → allowed`, !blocksBash("echo '.u1{margin:0} .u2{padding:0}' >> big.css && wc -l big.css")],
  [`bash chunked append (60 lines, ~2000 chars) → allowed`, !blocksBash(`cat >> big.css <<'CHUNK'\n${nLines(58)}\nCHUNK`)],
];

process.exitCode = report("test-incremental-limits", checks) === 0 ? 0 : 1;
