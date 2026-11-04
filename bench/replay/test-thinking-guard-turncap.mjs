// Replay test: thinking-guard's two hard-abort layers (per-block + per-turn),
// and the raised TEXT caps for Dory's marker-block deliverable.
// Thresholds parsed live from extensions/thinking-guard.ts; the counter logic
// below mirrors the guard's message_update branches.
//
// Origin: benchmark 2026-07-23 — four sessions ended in 21,720-30,621-char
// single-turn code dumps. Each streamed as MANY alternating thinking/text
// blocks, all under HARD_ABORT_CHARS, so the per-block abort (counters reset
// on every block start) never fired. The cumulative per-turn cap closes that.
//
// 2026-07-25: the 4000-char text cap also clips the one legitimate long text
// stream in the system — a Dory plan job's <<<BRIEF>>>/<<<TEST>>> block, which
// IS the deliverable. Those stages get raised TEXT caps only (see
// DORY_READONLY_KINDS in the guard); the thinking channel keeps HARD_ABORT_CHARS.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "thinking-guard.ts";
const src = readExtension(FILE);

const HARD_ABORT_CHARS = parseNumericConst(src, "HARD_ABORT_CHARS", FILE);
const TURN_ABORT_CHARS = parseNumericConst(src, "TURN_ABORT_CHARS", FILE);
const MAX_THINKING_CHARS = parseNumericConst(src, "MAX_THINKING_CHARS", FILE);
const DORY_TEXT_ABORT_CHARS = parseNumericConst(src, "DORY_TEXT_ABORT_CHARS", FILE);
const DORY_TURN_ABORT_CHARS = parseNumericConst(src, "DORY_TURN_ABORT_CHARS", FILE);

requireMarker(src, 'ae.type === "thinking_start"', FILE, "per-block thinking counter reset");
requireMarker(src, 'ae.type === "text_start"', FILE, "per-block text counter reset");
requireMarker(src, "turnStreamChars > turnAbortChars", FILE, "cumulative per-turn abort check");
requireMarker(src, "turnStreamChars = 0", FILE, "per-turn counter reset at turn boundary");
requireMarker(src, "liveTextChars > textAbortChars", FILE, "text-channel abort uses the stage-resolved cap");
requireMarker(src, "liveThinkingChars > HARD_ABORT_CHARS", FILE, "thinking channel keeps the strict cap");
requireMarker(src, "doryStage ? DORY_TEXT_ABORT_CHARS : HARD_ABORT_CHARS", FILE, "dory text cap resolution");

const NORMAL = { textBlockCap: HARD_ABORT_CHARS, turnCap: TURN_ABORT_CHARS };
const DORY = { textBlockCap: DORY_TEXT_ABORT_CHARS, turnCap: DORY_TURN_ABORT_CHARS };

// --- counter logic mirroring the guard ---
// Simulate a stream of events under a stage's caps; return which abort (if any)
// fires first. The thinking channel always uses HARD_ABORT_CHARS.
function simulate(events, caps = NORMAL) {
  let block = 0, turn = 0;
  for (const ev of events) {
    if (ev.type === "start") { block = 0; continue; }
    block += ev.chars;
    turn += ev.chars;
    const blockCap = ev.channel === "text" ? caps.textBlockCap : HARD_ABORT_CHARS;
    if (block > blockCap) return "block-abort";
    if (turn > caps.turnCap) return "turn-abort";
  }
  return null;
}

// Recorded evasion shape (regex-lite run 2, 27,960 chars): alternating blocks,
// each safely under the per-block cap.
function alternatingBlocks(totalChars, blockChars, channel = "thinking") {
  const events = [];
  let emitted = 0;
  while (emitted < totalChars) {
    events.push({ type: "start" });
    const n = Math.min(blockChars, totalChars - emitted);
    events.push({ type: "delta", chars: n, channel });
    emitted += n;
  }
  return events;
}

const checks = [
  [
    `single ${HARD_ABORT_CHARS + 500}-char block → per-block abort (unchanged behavior)`,
    simulate([{ type: "start" }, { type: "delta", chars: HARD_ABORT_CHARS + 500 }]) === "block-abort",
  ],
  [
    `recorded 27,960-char turn as ${Math.floor(HARD_ABORT_CHARS * 0.85)}-char blocks → turn-abort (was: streamed through)`,
    simulate(alternatingBlocks(27960, Math.floor(HARD_ABORT_CHARS * 0.85))) === "turn-abort",
  ],
  [
    `smallest recorded dump (21,720 chars) in small blocks → turn-abort`,
    simulate(alternatingBlocks(21720, 3000)) === "turn-abort",
  ],
  [
    `normal turn (3 blocks, ${Math.floor(TURN_ABORT_CHARS / 4)} chars total) → no abort`,
    simulate(alternatingBlocks(Math.floor(TURN_ABORT_CHARS / 4), 3000)) === null,
  ],
  [
    `turn cap sits above the soft steer threshold (${MAX_THINKING_CHARS}) so soft layer fires first`,
    TURN_ABORT_CHARS > MAX_THINKING_CHARS,
  ],
  // --- dory marker-block deliverable ---
  [
    `normal session: a 9,000-char brief-sized TEXT block → block-abort (why the dory caps exist)`,
    simulate([{ type: "start" }, { type: "delta", chars: 9000, channel: "text" }], NORMAL) === "block-abort",
  ],
  [
    `dory stage: the same 9,000-char TEXT block streams through intact`,
    simulate([{ type: "start" }, { type: "delta", chars: 9000, channel: "text" }], DORY) === null,
  ],
  [
    `dory stage still has a ceiling: ${DORY_TURN_ABORT_CHARS + 5000} chars of text → turn-abort`,
    simulate(alternatingBlocks(DORY_TURN_ABORT_CHARS + 5000, 8000, "text"), DORY) === "turn-abort",
  ],
  [
    `dory stage: THINKING keeps the strict per-block cap (${HARD_ABORT_CHARS})`,
    simulate([{ type: "start" }, { type: "delta", chars: HARD_ABORT_CHARS + 500, channel: "thinking" }], DORY) === "block-abort",
  ],
  [
    `dory caps are raised, not lowered (text ${DORY_TEXT_ABORT_CHARS} > ${HARD_ABORT_CHARS}, turn ${DORY_TURN_ABORT_CHARS} > ${TURN_ABORT_CHARS})`,
    DORY_TEXT_ABORT_CHARS > HARD_ABORT_CHARS && DORY_TURN_ABORT_CHARS > TURN_ABORT_CHARS,
  ],
];

process.exitCode = report("test-thinking-guard-turncap", checks) === 0 ? 0 : 1;
