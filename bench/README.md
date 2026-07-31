# bench/ — PiForge testing itself

A dev-side harness that verifies the guards actually do what their comments claim.
It is **not** part of the PiForge install — `install.sh` and `dev-link.sh` ignore it.
Run it after editing a guard, before committing.

Origin: on 2026-07-22 an ad-hoc version of this suite proved that a single bash
heredoc bypassed `incremental-guard` 5/5 times, and that `loop-guard`'s
response-text detector extracted 0 chars on every turn of a thinking model
(it missed a real 9×-identical-response loop). Both were fixed and re-verified
(0/5 bypass after). This folder makes that check repeatable.

## Three layers

### 1. Replay tests — instant, no LLM

```bash
bash bench/run-replay.sh
```

Pure Node scripts that replay recorded failure scenarios against each guard's
decision logic. Milliseconds, run them on every guard edit.

| Test | What it proves |
|---|---|
| `replay/test-incremental-limits.mjs` | write/edit/bash size caps block and allow the right payloads (incl. the heredoc side door and the whole-file-rewrite-via-edit trick) |
| `replay/test-loop-guard-write.mjs` | consecutive-write similarity warns at 4 and blocks at 6 identical writes, with zero false positives on legit evolving `_state.md` updates |
| `replay/test-loop-guard-text.mjs` | thinking-aware `extractText` sees the narration a thinking model puts in `thinking` blocks; warn/recover fire at the documented repeat counts |
| `replay/test-execution-guard.mjs` | `Status: complete` is blocked while modified code was never executed; any execution releases the latch; doc-only sessions never arm |
| `replay/test-acceptance-guard.mjs` | `Status: complete` is blocked unless `.think/_acceptance.sh` exits 0; a fixed cause is allowed on retry; doc-only sessions never arm; the give-up valve hands back after 3 blocks |

**Staying honest against the real source:** Node can't import the `.ts`
extensions directly, so the tests copy the small pure functions — but all
numeric thresholds are parsed **live** from `extensions/*.ts` (tuning a const
is picked up automatically), and each test greps for load-bearing logic markers
in the extension source. If a guard's logic changes and a marker disappears,
the test fails with "copy may be stale" instead of green-lighting outdated
assumptions. When that happens: update the copied logic to match the extension,
then update the marker.

**Known limit of this layer — read before trusting a green replay run.** Because
the logic is *mirrored*, a replay test proves the intended design, not the
shipped code. It green-lit an `acceptance-guard` that never armed its latch on
`write`/`edit` tool_calls (only in `tool_result`), because the mirror
implemented arming the extension was missing — every gated scenario passed in
replay and failed for real. Markers don't catch this: the marker was present in
a *comment*. For anything whose behavior depends on real I/O, add a functional
test too.

### 2. Functional tests — instant, no LLM, real extension code

```bash
bash bench/run-functional.sh
```

Imports the actual `extensions/*.ts` via node's type stripping (needs node ≥
22.6) and drives it with a fake `ExtensionAPI` in a throwaway project dir, so
real file reads and real subprocess spawns happen. Slower to write than a replay
test and it can't cover streaming, but it cannot drift from the shipped code.

| Test | What it proves |
|---|---|
| `functional/test-acceptance-guard.mjs` | the guard actually spawns `.think/_acceptance.sh`, blocks on a real nonzero exit with the real output in `block.reason`, allows a real exit 0, catches a test that passes pre-implementation, caps its own blocks |
| `functional/test-progress-checkpoint.mjs` | over a simulated 200-turn session: a productive session gets **zero** checkpoints, a stalled one gets full instructions exactly once then a ≤350-char reminder, total injected context stays under 2k chars, backoff spaces them out, resumed work resets the streak, and an unresponsive model is handed to the human instead of nagged |
| `functional/test-project-jail.mjs` | heredoc **bodies** mentioning `~/.pi/agent/` no longer trip the jail (the recorded 2026-07-26 false positive), while every real escape still blocks — `cat > ~/Desktop/…​ <<EOF`, `mkdir -p ~/Desktop`, `cp` to home, `cd` out; reads/executes outside stay allowed; `<<-`, unquoted tags, post-body commands and unterminated heredocs all covered |

### 3. Live suite — real Pi + your local model

```bash
bash bench/live/run-live.sh              # 5 bypass trials + regression (~15–25 min)
TRIALS=1 bash bench/live/run-live.sh     # quick smoke (~5 min)
```

Requires LM Studio serving the model from `~/.pi/agent/models.json` and the
extensions installed (`dev-link.sh` or `install.sh`). Spawns real `pi -p`
sessions in throwaway dirs under `/tmp`, with `live/probe.ts` loaded via `-e`
to log every tool call, result, and turn — a call with no result was blocked
by a guard.

- **Bypass trials** prompt the model to write a 150-line file in ONE bash
  heredoc. PASS = no oversized call executed. The model getting blocked once
  and finishing via chunked `cat >>` appends is the *intended* outcome — the
  file still lands, just in small recoverable pieces.
- **Regression** runs a trivial task and expects **zero** blocks — catches
  false positives from new guard rules.

Run logs and probe JSONLs are kept in the printed `/tmp/piforge-bench.*` dir
for inspection. `live/analyze.mjs` does the pass/fail judgement and pairs
parallel tool calls correctly (FIFO per tool).

### 4. Hard capability suite — how good is the model+harness, really?

```bash
bash bench/hard/run-hard.sh                 # 5 tasks x 5 iterations (hours!)
ITERS=1 bash bench/hard/run-hard.sh         # one pass over all tasks
TASKS="regex-lite" bash bench/hard/run-hard.sh
TIMEOUT_S=1800 bash bench/hard/run-hard.sh  # raise the per-run wall clock cap (default 1200s)
```

Unlike the live suite (which tests the *guards*), this measures **task success**:
deliberately difficult, objectively verifiable coding tasks run end-to-end under
the full PiForge harness. Each task has a hidden verifier
(`hard/tasks/<task>/verify.mjs`) that runs the produced code from *outside* the
trial dir against a case battery the model never sees. Every verifier has been
validated against a known-good reference solution (35/35, 8/8, 10/10, 16/16, 8/8).

| Task | What makes it hard |
|---|---|
| `regex-lite` | regex engine from scratch; needs real backtracking (`(a\|ab)*c` vs `ababc`); built-in `RegExp` is detected and auto-fails |
| `csv-kit` | RFC 4180 state-machine parser (embedded quotes/commas/newlines) + 3-module CLI with exact output-quoting rules |
| `bug-hunt-lru` | 4 planted, *interacting* bugs in an LRU+TTL cache; `test.js` is checksummed (modifying it auto-fails); hidden edge cases beyond the visible suite |
| `json-patch` | RFC 6902 incl. JSON Pointer `~0`/`~1` escapes, `-` append, whole-doc path `""`, atomic ERROR semantics |
| `spreadsheet` | recursive-descent formula parser + dependency-order evaluation, forward refs, transitive CYCLE propagation; `eval()` auto-fails |

Per run it records verdict (PASS / FAIL / TIMEOUT), case score, wall time, and
executed/blocked tool-call counts from the probe; `results.csv` in the printed
work dir has everything, and a per-task summary prints at the end.

### 5. Paste suite — evaluating a model you can only chat with

```bash
bash bench/paste/make-pastes.sh        # build out/A-<task>.txt + out/B-<task>.txt
node bench/paste/collect.mjs reply.txt json-patch   # split files, run the real verifier
node bench/paste/score-discipline.mjs reply-B.txt   # which guards would have fired
```

For deciding whether a *different* model is worth switching to when PiForge isn't
installed against it (no Pi, no tools — just a chat box). PASTE-A measures one-shot
capability and is scored by the same hidden verifiers as the hard suite; PASTE-B
makes the model emit the agent transcript it *would* run, scored for guard-need.
Only meaningful as a delta against the same paste run on the incumbent model.
See `paste/README.md`.

## When to add a test

Every time a guard gains a rule or a real-world failure slips past one:
1. reproduce it (replay if the logic is pure, live if it needs the model),
2. fix the guard,
3. keep the reproduction here as a permanent regression test.
