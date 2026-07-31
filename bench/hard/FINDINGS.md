# Hard-benchmark findings — FULL SUITE (25/25 runs complete)

Run: 2026-07-23, qwen3.6-35b-a3b (Q3 MoE) via LM Studio, full PiForge harness,
5 tasks x 5 iterations, 20-min cap per run. Raw data: /tmp/piforge-hard.xWsiSh
(results.csv, per-run probe JSONLs, all trial dirs kept).

## Scoreboard

| Task | Strict pass | Avg case score | Avg time | Guard blocks | Artifact-correct |
|---|---|---|---|---|---|
| bug-hunt-lru | 5/5 | 100% | 3.8 min | 0 | 5/5 |
| csv-kit | 5/5 | 100% | 7.8 min | 3 | 5/5 |
| spreadsheet | 3/5 | 100% | 15.3 min | 6 | **5/5** (2 TIMEOUTs held perfect solutions) |
| json-patch | 0/5 | 89% | 10.9 min | 6 | 0/5, but all misses are unhappy-path cases |
| regex-lite | 0/5 | 38% | 14.7 min | 7 | 0/5 (best: 27/35, timed out mid-iteration) |

Strict: 13/25 PASS. Artifact-quality: 15/25 fully correct, 5 more at ≥81% of cases.
Guard integrity: 22 blocks total, zero oversized calls executed (no bypasses), and
zero blocks on the tasks where guards had nothing to catch (bug-hunt-lru: 0 in 5 runs)
— no false-positive interference observed anywhere in the suite.

## The four failure classes (from probe-log autopsies)

**A. Runaway text-dump collapse — regex-lite only, 4 of 5 runs.**
Final turns of 27,960 / 28,525 / 21,720 / 30,621 chars of pure text (code dumped into
chat instead of files). All other 20 runs peaked ≤ 4,383 chars/turn. thinking-guard's
4,000-char HARD abort was evaded every time because its counters reset per
thinking/text block (thinking-guard.ts:101-102) — it caps the largest block, not the
turn. Appears precisely when the model is cognitively overwhelmed by the hardest task.

**B. Ships code it never ran — regex-lite runs 2 & 3 (both catastrophic: 0/35, 14/35).**
Zero bash calls in the entire session; run 2's file crashes on load (references a
function that was never written). Every non-regex run executed its code. Run 5 is the
degenerate cousin: 30k-char dump, regex.js never created at all.

**C. Can't declare done — spreadsheet runs 2 & 4.**
Perfect 8/8 artifacts complete by ~minute 8-10, then 40-49 tool calls of re-testing and
fiddling with passing tests and no meaningful source changes until the cap killed the
session. The doneness signal (repeated successful executions, no edits needed) was
present in tool results; nothing in the harness surfaces it. Mirror image of B: the
model has no reliable internal task-state signal in either direction — consistent with
the maintainer's own daily-use observation.

**D. Unhappy-path blindness — json-patch, systematic (not variance).**
"remove nonexistent path must ERROR" failed in 5/5 runs; "failed test op must abort"
in 3/5. All mechanics (pointer escapes, array insert/move, atomicity ordering) were
near-flawless every run. The model implements what a spec DOES and skims what it
FORBIDS; it never tests error cases unprompted.

## Proposals, re-ranked on full data (all model-agnostic by construction)

### P1 — thinking-guard: add cumulative per-turn cap (CONFIRMED, dominant)
Per-block counter reset = any multi-block streaming (all thinking-capable models)
evades the hard abort. Fix: keep per-block cap, ADD per-turn cumulative counter
(reset only at turn boundaries, cap ~12,000 chars), abort on either. Counts chars at
stream level — no assumptions about block order/count/model. Covers failure class A
including run 5 (dump instead of file). Replay-testable from these logs.

### P2 — doneness, both directions (classes B + C, one mechanism)
The harness already externalizes state into _state.md; extend it to derive DONE-ness
from observable facts:
  a) Execution latch (class B): hard-block completion-flavored _state.md writes while
     code-like files (.js/.ts/.py…) were modified but nothing was executed since.
     One-shot latch (releases after any execution), per reopen-guard convention.
  b) Success steer (class C): after N (~3) consecutive successful bash executions with
     zero source-file writes between them, inject one steer: "your checks pass and
     nothing changed — if the deliverable is complete, mark _state.md complete and
     stop." One-shot per session.
Scoped to code-file sessions; doc/config-only sessions never arm either arm.

### P3 — incremental-guard: oversized-write recovery loses code (class A adjacent)
Observed: blocked 206/265-line writes "recovered" by overwriting with a 29/53-line
fragment, rest never appended (regex runs 2-3). Fix (a): block-reason text — spell out
chunked-append workflow and "file is not done until it matches your plan; keep a
remaining-chunks checklist in _plan.md". Fix (b): one-shot steer when a blocked N-line
write to a path is followed by a write/edit leaving that file < N/2 lines: "likely
INCOMPLETE — append the missing parts in small chunks."

### P4 — knowledge file: spec-implementation gotchas (class D)
Harness guards can't fix "never wrote the error-path tests." Add
knowledge/spec-implementation-gotchas.md (failure-pattern style, per repo convention):
"specs' MUST-fail requirements are implementation requirements — enumerate every
'must error' clause and write a test for each before declaring done; silent success on
invalid input is the most common spec-conformance bug." knowledge-injector then arms it
for spec-flavored tasks. Would have targeted the exact 5/5-consistent json-patch miss.

### P5 — response-guard: fix both documented limitations (subsumed backstop)
With P1's per-turn cap, response-guard becomes reachable/meaningful again: fix
`tool_use` → `toolCall`, and set its threshold relative to the per-turn abort cap
(backstop below hard abort). Supersedes the 2026-07-22 "kept as-is" decision — that
decision predates this failure data.

### P6 — one-shot (`pi -p`) mode: steers die with the session (design gap)
All soft enforcement assumes a next turn; in -p mode the model ending its final turn
ends the session before any correction acts (observed: class A dumps were final turns).
If headless operation matters, deliver one queued follow-up message (queue.ts already
has the mechanism) when P2's incomplete-signals fire at session end. Off by default.

### P7 — env: sampling variance check
Same task spread 27/0/14/26/0 (regex-lite). Verify the README-recommended inference
settings are applied on the serving host before attributing everything to the model.

## What NOT to change
- incremental-guard limits: 22 blocks, 0 bypasses, recoveries succeeded in every
  passing run — thresholds are doing their job.
- The .think/ workflow: every run followed it; the two best task sweeps (lru, csv)
  show the state-file discipline coexisting with fast completion.
- No evidence for new hard guards beyond P2a — the easy tasks ran block-free, which is
  exactly the false-positive-free profile to preserve.

## Meta: benchmark suite notes
- All five verifiers validated against reference solutions before the run (full-score).
- TIMEOUT verdicts can hide correct artifacts (spreadsheet 2 & 4 scored 8/8) — read
  verdict + score together; artifact-correct rate is the capability signal, strict PASS
  is the autonomy signal.
- Re-run after any P1-P6 implementation for before/after: same tasks, same verifiers,
  `bash bench/hard/run-hard.sh`.

## Implemented (2026-07-23, same day)
- P1 → thinking-guard.ts: TURN_ABORT_CHARS = 20000 cumulative per-turn cap.
- P2a → execution-guard.ts (NEW, **off by default** — enable for unattended runs).
- P2b → done-nudge.ts (NEW, on by default).
- P3 → incremental-guard.ts: rewritten oversized-write reason + truncated-recovery
  watchdog (TRUNCATION_WARN_FRACTION / TRUNCATION_DONE_FRACTION).
- P4 → knowledge/spec-implementation-gotchas.md.
- Replay tests: test-thinking-guard-turncap, test-execution-guard,
  test-incremental-truncation — all pass; existing replay suite unaffected.
- P5/P6/P7 intentionally deferred.

## Post-fix verification (2026-07-23 evening, focused live tests)
Focused probes instead of a full re-run (per maintainer request). Trial data in
/tmp/piforge-focused.Pjxfe6.

- **P1 CONFIRMED FIXED.** 4/4 runs: max streamed turn 1,095-4,910 chars
  (baseline regex-lite: 21,720-30,621 in 4/5 runs). Zero text-dump collapses.
- **P2a CONFIRMED (after fixing a live-caught bug).** First probe exposed a
  parallel-tool-call ordering hole: the completion write's tool_call arrives
  before the code write's tool_result, leaving the result-armed latch unarmed.
  Fixed by arming at CALL time (executions still release at result time);
  scenario added to test-execution-guard.mjs. Retest: both untested-completion
  attempts blocked, then yielded at MAX_BLOCKS_PER_SESSION by design (the test
  prompt explicitly forbade running — user instruction beats guard insistence).
- **P2b LIKELY WORKING.** Spreadsheet 2/2 PASS, self-concluded at 622s/943s
  (baseline: 2/5 ground into the 1207s cap with perfect artifacts). Steer
  delivery isn't visible in -p probe logs, so causality is inferred from the
  outcome change.
- **regex-lite remains the model's capability wall** (18/35, 10/35 timeouts) —
  but it now fails by writing buggy algorithms inside the workflow instead of
  collapsing out of it. Harness scope ends here; P7 (sampling settings) is the
  remaining untested lever.
- **P4 untested by benchmarks** — bare trial dirs have no knowledge/ folder;
  validate in a real project with knowledge-injector active.
