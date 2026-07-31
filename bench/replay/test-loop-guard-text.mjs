// Replay test: loop-guard response-text loop detection on THINKING models.
// A live turn_end probe (2026-07-22) showed that on Qwen thinking models the
// repeated narration lives in `thinking` blocks while the `text` block is ~2
// chars of whitespace on tool-call turns — so text-only extraction saw 0 chars
// every turn and the detector never fired during a real 9×-identical loop.
// extractText must include thinking blocks; warn at TEXT_WARN repeats, recover
// at TEXT_RECOVER.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "loop-guard.ts";
const src = readExtension(FILE);

const TEXT_SIMILARITY_THRESHOLD = parseNumericConst(src, "TEXT_SIMILARITY_THRESHOLD", FILE);
const TEXT_WARN = parseNumericConst(src, "TEXT_WARN", FILE);
const TEXT_RECOVER = parseNumericConst(src, "TEXT_RECOVER", FILE);
const MIN_TEXT_LEN = parseNumericConst(src, "MIN_TEXT_LEN", FILE);

requireMarker(src, 'b?.type === "text" || b?.type === "thinking"', FILE, "thinking-aware extractText");

// --- verbatim copies from loop-guard.ts ---
function tokenize(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9_\-./\s]/g, " ").split(/\s+/).filter((w) => w.length > 1)
  );
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
function extractText(message) {
  if (!message?.content) return "";
  return (message.content)
    .filter((b) => b?.type === "text" || b?.type === "thinking")
    .map((b) => b?.text ?? b?.thinking ?? "")
    .join(" ")
    .trim();
}
// --- end copies ---

// A tool-call turn as observed live: narration in thinking, whitespace text.
const narration =
  "I need to update _state.md and then continue exploring the codebase before writing " +
  "the documentation. Let me check what I've gathered so far and explore a few more key files.";
const stuckTurn = { content: [{ type: "thinking", thinking: narration }, { type: "text", text: "\n\n" }, { type: "toolCall" }] };
const normalTurns = [
  { content: [{ type: "thinking", thinking: "The user wants a portfolio site. I should start with the plan file, list the sections, then write a skeleton for index.html before any styling." }, { type: "text", text: "\n\n" }, { type: "toolCall" }] },
  { content: [{ type: "thinking", thinking: "Plan is written. Now the HTML skeleton: hero, projects grid, about, contact form. Keep it under the write cap and fill sections with edits afterwards." }, { type: "text", text: "\n\n" }, { type: "toolCall" }] },
];
const turns = [...normalTurns, ...Array(6).fill(stuckTurn)];

// Old behavior sanity: text-only extraction of a stuck tool-call turn is empty.
const textOnly = stuckTurn.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();

// Mirror the guard's turn_end counter logic
let lastTextWords = null, repeatedTextCount = 0;
const actions = turns.map((msg) => {
  const text = extractText(msg);
  if (text.length < MIN_TEXT_LEN) return "skip";
  const words = tokenize(text);
  const sim = lastTextWords ? jaccard(words, lastTextWords) : 0;
  repeatedTextCount = lastTextWords && sim > TEXT_SIMILARITY_THRESHOLD ? repeatedTextCount + 1 : 0;
  lastTextWords = words;
  if (repeatedTextCount >= TEXT_RECOVER) return "recover";
  if (repeatedTextCount >= TEXT_WARN) return "warn";
  return "allow";
});

const firstWarn = actions.indexOf("warn");
const firstRecover = actions.indexOf("recover");
const stuckStart = normalTurns.length; // index of first stuck turn

const checks = [
  [`old text-only extraction was blind (${textOnly.length} chars < ${MIN_TEXT_LEN} min)`, textOnly.length < MIN_TEXT_LEN],
  [`thinking-aware extraction sees the narration (${extractText(stuckTurn).length} chars)`, extractText(stuckTurn).length >= MIN_TEXT_LEN],
  ["normal varied turns never flagged", actions.slice(0, stuckStart).every((a) => a === "allow")],
  [`warn at repeat #${TEXT_WARN + 1} (turn #${firstWarn + 1})`, firstWarn === stuckStart + TEXT_WARN],
  [`recover (abort+compact) at repeat #${TEXT_RECOVER + 1} (turn #${firstRecover + 1}) — real-world loop ran 9×`, firstRecover === stuckStart + TEXT_RECOVER],
];

process.exitCode = report("test-loop-guard-text", checks) === 0 ? 0 : 1;
