// Replay test: loop-guard write-loop detection (consecutive similarity).
// Replays the real failure from 2026-07-22: a model updated _state.md
// legitimately 3 times while exploring, then wrote the SAME state 10 times.
// The old history-averaging logic never warned and blocked only at the 5th–9th
// wasted write; the consecutive logic must warn at WARN_COUNT and block at
// BLOCK_COUNT similar writes in a row, with zero false positives on the
// legit evolving updates.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "loop-guard.ts";
const src = readExtension(FILE);

const SIMILARITY_THRESHOLD = parseNumericConst(src, "SIMILARITY_THRESHOLD", FILE);
const WARN_COUNT = parseNumericConst(src, "WARN_COUNT", FILE);
const BLOCK_COUNT = parseNumericConst(src, "BLOCK_COUNT", FILE);

requireMarker(src, "track.consecutiveSimilar + 1", FILE, "consecutive-similarity counter");
requireMarker(src, "jaccard(words, track.lastWords)", FILE, "compare-to-previous-write");

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
// --- end copies ---

// Realistic evolving _state.md updates (same template, changing fields) —
// measured 0.58–0.63 similarity between consecutive legit updates.
const stateUpdate = (step, action, next) => `# Current State
## Task: Analyze Action Centre repo and create MD documentation
## Progress: Step ${step}
## Status: in-progress
## Last Action: ${action}
## Next Action: ${next}
## Read First: .think/_state.md`;

const legit = [
  stateUpdate("1 — Explored repo structure", "Listed Services directory tree and solution layout", "Read Program.cs and the API controllers"),
  stateUpdate("2 — Explored controllers", "Read IssueController.cs and SnapshotsController.cs endpoints", "Read IssueManager and the SnapshotCreatedEventHandler business logic"),
  stateUpdate("3 — Explored core logic", "Read IssueManager.cs lifecycle code and Mongo Collections.cs", "Explore DataAccess layer then write the documentation MD file"),
];
const stuck = legit[legit.length - 1]; // model rewrites its latest state verbatim
const writes = [...legit, ...Array(8).fill(stuck)];

// Mirror the guard's per-file tracking
let track = null;
const events = writes.map((content) => {
  const words = tokenize(content);
  const similarity = track ? jaccard(words, track.lastWords) : 0;
  const consecutiveSimilar = track && similarity > SIMILARITY_THRESHOLD ? track.consecutiveSimilar + 1 : 0;
  track = { lastWords: words, consecutiveSimilar };
  const similarRun = consecutiveSimilar + 1;
  return { similarity, similarRun, action: similarRun >= BLOCK_COUNT ? "block" : similarRun >= WARN_COUNT ? "warn" : "allow" };
});

const legitEvents = events.slice(0, legit.length);
const firstWarnIdx = events.findIndex((e) => e.action === "warn");
const firstBlockIdx = events.findIndex((e) => e.action === "block");
// stuck #1 is a verbatim rewrite of legit #3, so the similar run starts there:
// warn must land WARN_COUNT-1 writes later, block BLOCK_COUNT-1 writes later.
const expectedWarnIdx = legit.length - 1 + (WARN_COUNT - 1);
const expectedBlockIdx = legit.length - 1 + (BLOCK_COUNT - 1);

const checks = [
  ["legit evolving updates never flagged (no false positives)", legitEvents.every((e) => e.action === "allow")],
  [`legit consecutive similarity stays under threshold (${legitEvents.slice(1).map((e) => e.similarity.toFixed(2)).join(", ")} < ${SIMILARITY_THRESHOLD})`,
    legitEvents.slice(1).every((e) => e.similarity <= SIMILARITY_THRESHOLD)],
  [`warn fires at ${WARN_COUNT} consecutive similar writes (write #${firstWarnIdx + 1})`, firstWarnIdx === expectedWarnIdx],
  [`block fires at ${BLOCK_COUNT} consecutive similar writes (write #${firstBlockIdx + 1})`, firstBlockIdx === expectedBlockIdx],
  ["block persists on further identical writes", events.slice(expectedBlockIdx).every((e) => e.action === "block")],
];

process.exitCode = report("test-loop-guard-write", checks) === 0 ? 0 : 1;
