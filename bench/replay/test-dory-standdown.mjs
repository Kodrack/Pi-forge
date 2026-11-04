// Replay test: every .think/-workflow extension stands down in a read-only
// Dory stage, and a Dory job never inherits the previous job's purpose.
//
// Replays the real failure from 2026-07-26 (card T-007). A dory chat job ran
// with the FULL coding harness attached, so the model got two contradictory
// contracts — the job prompt ("Never create or modify any file") and AGENTS.md
// ("YOU MUST create .think/_state.md BEFORE doing anything else") — then hit a
// compaction where:
//   - context-monitor re-injected all of AGENTS.md, and
//   - purpose-anchor re-injected .think/_purpose.md, which still held the
//     PREVIOUS (chat) job's prompt while the live job was a plan job.
// With the task blocked on user input and file writes the only "action" the
// nags asked for, the model re-sent the same no-op edit to _state.md 7 times.
//
// Two invariants, both source-level (these are wiring bugs, not math bugs):
//   1. Every extension that steers the .think/ workflow resolves the dory stage
//      through the pid-guarded transport and stands down in chat/plan/respond.
//   2. purpose-anchor refreshes _purpose.md for a dory job instead of resuming
//      whatever the last job left on disk.
import { readExtension, requireMarker, report } from "./lib/extension-source.mjs";

// Extensions that inject .think/-workflow instructions. All must stand down.
const WORKFLOW_EXTENSIONS = [
  "state-guard.ts",
  "analysis-guard.ts",
  "first-prompt.ts",
  "thinking-guard.ts",
  "purpose-anchor.ts",
  "context-monitor.ts",
];

// "wave" (planning a goal's next wave) is the fourth marker-only stage.
const READONLY_KINDS = ["chat", "plan", "respond", "wave"];
const checks = [];

for (const file of WORKFLOW_EXTENSIONS) {
  const src = readExtension(file);

  // The env transport (headless `pi -p`, set by dory.mjs) …
  const hasEnv = src.includes("process.env.DORY_STAGE");
  // … and the in-session transport, which is only trustworthy with the pid
  // match: dory-runner.json is ONE global slot in ~/.pi, so without it an
  // unrelated session — or one orphaned by a /dory session killed mid-job —
  // reads someone else's job and stands down when it shouldn't.
  const hasPidGuard = /pid\s*(===|!==)\s*process\.pid/.test(src);
  // Every read-only kind must be covered. The recorded failure was a chat job
  // followed by a plan job; "respond" is the third marker-only stage.
  const kindsCovered = READONLY_KINDS.every((k) => src.includes(`"${k}"`));
  // And the stage has to actually be consulted somewhere, not just defined.
  const standsDown = /doryReadonlyStage\(\)|doryJob\(\)/.test(src);

  checks.push([`${file}: reads DORY_STAGE (headless transport)`, hasEnv]);
  checks.push([`${file}: pid-guarded dory-runner.json (in-session transport)`, hasPidGuard]);
  checks.push([`${file}: covers all read-only kinds (${READONLY_KINDS.join("/")})`, kindsCovered]);
  checks.push([`${file}: consults the stage at runtime`, standsDown]);
}

// --- purpose-anchor: per-job purpose, not per-directory ---
const pa = readExtension("purpose-anchor.ts");
requireMarker(pa, "if (!doryJob() && fs.existsSync(purposeFile)) return;", "purpose-anchor.ts",
  "per-job purpose refresh");
checks.push([
  "purpose-anchor: a dory job overwrites a stale _purpose.md (plan job can't inherit the chat job's prompt)",
  /if \(!doryJob\(\) && fs\.existsSync\(purposeFile\)\) return;/.test(pa),
]);
checks.push([
  "purpose-anchor: a NON-dory session still resumes its purpose (normal loop unchanged)",
  pa.includes("!doryJob() && fs.existsSync(purposeFile)"),
]);
// From job 2 onward dory-mode reuses the session (compact + sendUserMessage), so
// session_start never fires again. Capture must re-open on the JOB key instead,
// or job 2 silently keeps job 1's purpose — the exact T-007 failure.
requireMarker(pa, "if (job && job.key !== lastDoryJobKey) {", "purpose-anchor.ts",
  "per-job capture reset in turn_start");
const turnStart = pa.slice(pa.indexOf('pi.on("turn_start"'), pa.indexOf('pi.on("session_compact"'));
checks.push([
  "purpose-anchor: a new dory job re-opens capture (jobs 2+ share one session)",
  /job\.key !== lastDoryJobKey[\s\S]{0,160}firstPromptCaptured = false/.test(turnStart),
]);
checks.push([
  "purpose-anchor: the job-key reset runs BEFORE the firstPromptCaptured early-return",
  turnStart.indexOf("lastDoryJobKey") < turnStart.indexOf("if (firstPromptCaptured ||"),
]);
checks.push([
  "purpose-anchor: job key prefers the job id over the kind (two chat jobs are two purposes)",
  /state\.job\.id \?\? state\.job\.taskId \?\? state\.job\.kind/.test(pa),
]);
// The read-only re-inject must not carry .think/ orders — those are what left
// the model with "touch _state.md" as its only legal action.
const readonlyReinject = pa.slice(pa.indexOf("READ-ONLY DORY STAGE"), pa.indexOf("Progress check:"));
checks.push([
  "purpose-anchor: read-only re-inject tells the model NOT to write .think/ notes",
  readonlyReinject.includes("Do NOT write .think/ notes"),
]);
checks.push([
  "purpose-anchor: read-only re-inject carries no 'read _state.md' order",
  !/Read \.think\/_state\.md/.test(readonlyReinject),
]);

// --- context-monitor: no AGENTS.md re-injection in a read-only stage ---
const cm = readExtension("context-monitor.ts");
const compactHandler = cm.slice(cm.indexOf('pi.on("session_compact"'));
checks.push([
  "context-monitor: session_compact returns before building the AGENTS.md re-inject",
  compactHandler.indexOf("doryReadonlyStage()") < compactHandler.indexOf("readGlobalAgentsMd()"),
]);
checks.push([
  "context-monitor: still force-compacts in dory jobs (context hygiene is universal)",
  cm.includes("FORCE_COMPACT_PERCENT") && !/doryReadonlyStage\(\)[\s\S]{0,200}FORCE COMPACT/.test(cm),
]);

process.exitCode = report("test-dory-standdown", checks) === 0 ? 0 : 1;
