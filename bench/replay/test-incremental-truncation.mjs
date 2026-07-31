// Replay test: incremental-guard's truncated-recovery watchdog.
// Mirrors the decision thresholds (fractions parsed live) and replays the
// recorded failure: a blocked 206-line write "recovered" as a 29-line fragment.
//
// Origin: benchmark 2026-07-23, regex-lite runs 2 & 3 — write OVERWRITES, so a
// small "recovery" write after a blocked big one silently loses most of the
// planned file; the model never appended the rest.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "incremental-guard.ts";
const src = readExtension(FILE);

const WARN_FRACTION = parseNumericConst(src, "TRUNCATION_WARN_FRACTION", FILE);
const DONE_FRACTION = parseNumericConst(src, "TRUNCATION_DONE_FRACTION", FILE);

requireMarker(src, "blockedAttemptLines.set", FILE, "blocked-attempt size tracking");
requireMarker(src, "attempted * TRUNCATION_DONE_FRACTION", FILE, "goal-reached release");
requireMarker(src, "attempted * TRUNCATION_WARN_FRACTION", FILE, "truncation warn threshold");
requireMarker(src, "truncationWarned.add", FILE, "one-steer-per-path latch");

// --- decision logic mirroring the guard's tool_result watchdog ---
// verdict for one executed write, given the blocked attempt size and the
// resulting on-disk line count: "warn" | "watch" | "release"
function verdict(attempted, actual) {
  if (actual >= attempted * DONE_FRACTION) return "release";
  if (actual >= attempted * WARN_FRACTION) return "watch";
  return "warn";
}

const checks = [
  ["recorded: blocked 206-line write, 29-line recovery → warn", verdict(206, 29) === "warn"],
  ["recorded: blocked 265-line write, 53-line recovery → warn", verdict(265, 53) === "warn"],
  ["chunked rebuild in progress (60% of attempt) → keep watching, no steer", verdict(200, 130) === "watch"],
  ["rebuild essentially complete (85% of attempt) → release tracking", verdict(200, 170) === "release"],
  ["legit smaller redesign just over half the size → no false warn", verdict(100, 55) !== "warn"],
  ["warn threshold is below done threshold (sane ordering)", WARN_FRACTION < DONE_FRACTION],
];

process.exitCode = report("test-incremental-truncation", checks) === 0 ? 0 : 1;
