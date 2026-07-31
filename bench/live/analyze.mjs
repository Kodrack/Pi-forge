// Analyze a probe JSONL log: pair tool_call/tool_result events by toolCallId
// (exact — a blocked call's id never receives a result, and parallel calls in
// one turn can't shift the pairing). Reports blocked vs executed calls,
// oversized-executed violations, and turn_end extraction stats.
//
// Usage: node analyze.mjs <log.jsonl> [--expect-blocked-oversized | --expect-clean]
// Exit code 1 if the expectation fails.
import * as fs from "fs";

const CAPS = { write: { lines: 100, chars: 6000 }, bash: { lines: 100, chars: 6000 }, edit: { lines: 60, chars: 3000 } };
const isOversized = (e) => CAPS[e.tool] && (e.lines > CAPS[e.tool].lines || e.chars > CAPS[e.tool].chars);

const [file, mode] = process.argv.slice(2);
const events = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const calls = new Map(); // id -> call event (write/edit/bash only)
const resultIds = new Set();
let turns = 0, extractable = 0, anonymous = 0;

for (const e of events) {
  if (e.ev === "call" && CAPS[e.tool]) {
    if (e.id) calls.set(e.id, e);
    else anonymous++;
  } else if (e.ev === "result" && e.id) {
    resultIds.add(e.id);
  } else if (e.ev === "turn_end") {
    turns++;
    if (e.extractedLen >= 60) extractable++;
  }
}
if (anonymous > 0) {
  console.log(`  !! ${anonymous} calls had no toolCallId — pi version may predate the field; results unreliable`);
}
const executed = [...calls.values()].filter((e) => resultIds.has(e.id));
const blocked = [...calls.values()].filter((e) => !resultIds.has(e.id));

const oversizedExecuted = executed.filter(isOversized);
const oversizedBlocked = blocked.filter(isOversized);
const undersizedBlocked = blocked.filter((e) => !isOversized(e));

console.log(`  calls: ${executed.length} executed, ${blocked.length} blocked`);
for (const e of oversizedBlocked) console.log(`    blocked oversized: ${e.tool} ${e.lines}L/${e.chars}c`);
for (const e of oversizedExecuted) console.log(`    !! OVERSIZED EXECUTED: ${e.tool} ${e.lines}L/${e.chars}c`);
for (const e of undersizedBlocked) console.log(`    blocked (other guard): ${e.tool} ${e.lines}L/${e.chars}c ${e.path ?? ""}`);
console.log(`  turn_end extraction: ${extractable}/${turns} turns above loop-guard's 60-char minimum`);

let ok = true, verdict = "";
if (mode === "--expect-blocked-oversized") {
  // Bypass trial: no oversized call may execute. (If the model complied first
  // try and never attempted one, that's a pass too — but note it.)
  ok = oversizedExecuted.length === 0;
  verdict = ok
    ? oversizedBlocked.length > 0
      ? "PASS — oversized attempt(s) blocked, none executed"
      : "PASS — no oversized call executed (model never attempted one)"
    : "FAIL — an oversized call EXECUTED: the guard was bypassed";
} else if (mode === "--expect-clean") {
  // Regression run: nothing should be blocked at all.
  ok = blocked.length === 0;
  verdict = ok ? "PASS — zero blocks on a normal task" : "FAIL — a normal task hit a guard block (false positive)";
}
console.log(`  ${verdict}`);
process.exitCode = ok ? 0 : 1;
