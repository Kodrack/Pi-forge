# Long-horizon tasks: goal cards and subtasks (design)

Status: **phases 1 and 2 implemented** (goal cards, wave 1, just-in-time
planning, goal test, next waves, handoff notes, budgets) — see
`organizer/README.md` → *Goals*. Phases 3–4 are still proposals.
Autonomy: only **review** exists (every subtask waits for human approval).

**Changed after implementation (2026-11-04):** the prose *handoff notes*
(`handoffs/T-NNN.md` + an executor `<<<HANDOFF>>>` block) were replaced by
**changed-file pointers**: every card that passes records the files its run
changed (snapshot of the project at claim time), and related cards' prompts
list them so the job reads the real code. The code is the reference; there is
no prose to drift from it. Every card is also **pinned to its project**. Where
this document says "handoff", read "changed-file pointers". See
`organizer/README.md` → *Goals* and *Cards are pinned to their project*.
Planning ahead vs just in time: only goal subtasks wait for their dependencies by default; normal and ingested cards are planned ahead (`config.json` → `jit_planning`).

Decisions taken (§14): Dory writes the first goal test and the human reviews
it with the outline; subtasks keep their own priority; subtasks are approved
one by one; "files changed" uses git status filtered by mtime when the project
is a repo, else an mtime walk.

Found while implementing: `persona()` cut every section at the first line
starting with `## `, which the brief template inside `## Plan` contains, so
the planner never received the TEST format or rules. Sections now end only at
the next real persona header.

## 1. Goal

Let Dory take a card that is too big for one executor run ("recipe site with
accounts, search and favourites"), break it into subtasks herself, and drive
it to done across several runs, while keeping three things true:

- **visible**: every unit of work is a normal card with its own plan, test and git trail
- **controllable**: nothing is built without the approval the user chose; hard budgets cap how far Dory can go on her own
- **verifiable**: the big card is done only when a *goal test* passes, not when the subtasks say so

Non-goals: nested hierarchies (one level only), Dory editing code, parallel execution (still one job at a time).

## 2. What the engine does today (and what this design has to change)

References are to `board/dory.mjs` and `board/server.mjs` on the `dory` branch.

| Today | Consequence for long horizon |
|---|---|
| `tick()` plans **any** `plan_queue` card, ignoring `depends_on` (step 3) | Cards from 📥 ingest are all planned at once, against code that doesn't exist yet. Subtasks must be planned *just in time* instead. |
| Step 2 assumes **one** `in_progress` card (`board.tasks.find(...)`) | A goal card waiting on its subtasks would be treated as the running job. Goal cards must be skipped there. |
| `handleExecResult(task, _out, meta)` ignores the executor's final message | Free channel for a **handoff note** (what the subtask left behind for the next one). |
| `ingest()` already turns text into linked cards (`createTask` + `depends_on` from zero-based indices) | The subtask parser can reuse this almost as is. |
| Read-only job kinds `["chat","plan","respond"]` are hard-coded in 8 extensions (`dory-plan-guard.ts` + the 7 that stand down) | A new read-only job kind (`wave`) has to be added everywhere, or the guards treat it as a coding session. `bench/replay/test-dory-standdown.mjs` must cover it. |
| `execState` (attempt counter) lives in memory | Unchanged here; a restart mid-run resets attempts to 1, as today. |

## 3. Concepts

- **Goal card**: a card Dory decided is too big. It gets a *goal* (one paragraph), a *goal test* (end-to-end check) and subtasks. It never runs the executor itself.
- **Subtask**: a normal card with `parent` set to the goal's id. Planned, approved, executed and tested exactly like any card.
- **Wave**: the batch of subtasks Dory creates at once. Small on purpose (default ≤ 4). The next wave is planned only after the current one is done, against the code that now exists.
- **Goal test**: `tests/T-NNN.sh` of the goal card. Run by the engine after each wave. Passing = goal done.
- **Handoff note**: `handoffs/T-NNN.md` written when a subtask is done. What changed and how to use it ("`auth.js` exports `getUser()` → `{id, name}`; login page at `/login`"). Fed into every later plan and wave job of the same goal. This is how a long task keeps memory while each job starts fresh.

## 4. Lifecycle

```
Plan queue ──plan job──► small card? ──► BRIEF + TEST (today, unchanged)
                     └─► big card?   ──► GOAL + goal TEST + wave-1 SUBTASKS
                                          card becomes kind:"goal" → Plan created
Plan created (goal)  human reviews the outline; reply = revise outline; drag → Approved
Approved (goal)      engine (dispatch ON): creates wave-1 subtask cards,
                     moves goal → In progress (engine-owned, like today)
In progress (goal)   waits. Subtasks flow through the normal columns:
                       plan_queue (planned only when their deps are done)
                       → plan_created (review: human approves) → approved → done
                     every subtask done → handoff note written
wave finished        engine runs the goal test
   pass ───────────► goal → Done
   fail ───────────► "wave" job: goal + all handoffs + goal-test output
                       → next wave of SUBTASKS (→ back to In progress)
                       → or STUCK: reason (→ goal Blocked, reason posted)
budget exhausted ──► goal → Blocked with the budget that ran out
```

A subtask that ends **Blocked** pauses its goal: no new wave is planned until
the human resolves it (reply + drag back to Approved, or delete it). The goal
card shows which subtask is blocking.

## 5. Data model

New task fields (all optional; old boards keep working):

| Field | On | Meaning |
|---|---|---|
| `kind` | goal | `"goal"`; absent = normal card |
| `parent` | subtask | id of the goal card |
| `wave` | subtask | 1, 2, … |
| `waves_done` | goal | completed waves, for budgets and the UI |
| `goal` | goal | the one-paragraph goal statement |

Goal test: the goal card's normal `test_cmd` + `tests/T-NNN.sh`. Its `brief` points
to `tasks/T-NNN.md`, which holds the goal, the outline and the wave history.

New mind-repo folder: `handoffs/` (git-committed like everything else).

`config.json` gains:

```json
"long_horizon": {
  "autonomy": "review",
  "max_subtasks_per_wave": 4,
  "max_waves": 5,
  "max_subtasks_total": 15
}
```

`autonomy`: `review` (default: subtasks stop in Plan created), `auto-wave`
(subtasks auto-approved, but each new wave waits in Plan created as an outline
on the goal card), `auto` (runs until the goal test passes or a budget runs out).

## 6. Prompts and markers

**Plan persona (`## Plan`)** gets one decision up front: *"If this card needs
more than ~5 small steps or touches several unrelated parts of the project,
it is a goal: output a GOAL block instead of a BRIEF."*

```
<<<GOAL>>>
one paragraph: what "done" means for the whole thing
<<<TEST>>>
#!/usr/bin/env bash   ← end-to-end goal test, same rules as today
<<<SUBTASKS>>>
[{"title": "...", "notes": "what/why, the interface it must expose", "priority": 2, "depends_on": [0]}]
<<<END>>>
```

The SUBTASKS format is exactly ingest's TASKS format (zero-based indices).
A card with `parent` set may **not** answer with GOAL (depth limit); the
parser rejects it and the plan job is retried with a reminder.

**New `## Wave` persona** (read-only job, kind `wave`): input = goal, goal
test, every subtask's title + status + handoff, and the goal test's failing
output. Output either `<<<SUBTASKS>>>…<<<END>>>` (next wave, may depend on done
subtasks by id) or `<<<STUCK>>>reason<<<END>>>`.

**Executor prompt** (`buildExecPrompt`) for subtasks gets the goal paragraph
and earlier handoffs as context, and is asked to end with:

```
<<<HANDOFF>>>
files created/changed, functions or endpoints the next subtasks can use, anything left unfinished
<<<END>>>
```

The engine adds a deterministic part (files changed under the project during
the run) so a weak or missing HANDOFF block still leaves a usable note.

## 7. Engine changes (`board/dory.mjs`)

1. `tick()` step 2: `find(t => t.status === "in_progress" && t.kind !== "goal")`.
2. `tick()` step 3 (planning): only pick `plan_queue` cards whose `depends_on`
   are done (`depsCompleted`). This is the *just-in-time* rule; it also fixes ingest.
3. `handlePlanResult`: if GOAL is present → validate, mark `kind:"goal"`, store
   SUBTASKS as the pending wave-1 outline in the brief, post the outline, move → Plan created.
4. New step "goal advance" (after replies, before planning):
   - approved goal + dispatch ON → create the pending wave's cards, goal → In progress
   - in-progress goal whose current wave is all done → run goal test → Done, or dispatch a `wave` job
   - any subtask blocked → hold (no new wave)
5. New `handleWaveResult`: SUBTASKS → validate + create cards (or park them as an outline under `auto-wave`); STUCK → goal Blocked.
6. `handleExecResult`: on pass, write `handoffs/T-NNN.md` from HANDOFF + changed files.
7. Shared `createSubtasks(goal, items, wave)`: reuses ingest's mapping; enforces every budget below.

`server.mjs`: nothing structural. The new fields pass through `createTask`/PATCH; moving a goal card *into* In progress stays daemon-only, as for every card.

## 8. Budgets and validation (enforced in code, not in the prompt)

| Rule | When violated |
|---|---|
| Subtasks per wave ≤ `max_subtasks_per_wave` | extra items dropped, note posted on the goal |
| Waves ≤ `max_waves`, total subtasks ≤ `max_subtasks_total` | goal → Blocked: "budget reached after N waves, goal test still failing: …" |
| Depth 1: a subtask can't become a goal | plan output rejected, retried once with a reminder, then the subtask is Blocked |
| `depends_on` must be acyclic and point inside this goal | invalid edges dropped and listed in a note; cycles reject the whole wave |
| Duplicate titles within a goal | duplicates dropped |
| Goal test must FAIL before wave 1 is built | checked when the goal is approved; a goal test that already passes is rejected (same rule acceptance-guard applies to `_acceptance.sh`) |

## 9. Guard changes outside the organizer

`wave` is a read-only Dory stage. Add it wherever `chat/plan/respond` are listed:
`dory-plan-guard.ts` (allowlist + marker latch: `<<<END>>>` after SUBTASKS/STUCK),
`state-guard`, `analysis-guard`, `first-prompt`, `thinking-guard` (raised text
caps), `knowledge-injector`, `context-monitor`, `purpose-anchor`.
`test-dory-standdown.mjs` and `test-dory-plan-guard.mjs` get the new kind.

## 10. Board UI (`board/index.html`)

- Goal card: badge "Goal", progress "Wave 2 · 3/5 done", link list of subtasks, the goal test's last result.
- Subtask card: small "↳ T-020" badge linking to its goal.
- Optional filter "show one goal" that hides everything else.

## 11. How it can go wrong and what catches it

| Failure | Caught by |
|---|---|
| Dory splits a small card | Review: the outline sits in Plan created; reply "do it as one card" (Revise turns it back into a normal BRIEF) |
| Subtask plans drift from the goal | Goal paragraph + handoffs in every subtask prompt; goal test decides done |
| Later subtasks assume code that wasn't built | Just-in-time planning against the real project + handoff notes |
| Endless waves | `max_waves`, `max_subtasks_total`, STUCK output |
| Goal test that can never pass (or passes trivially) | Must fail before wave 1; human reviews it with the outline |
| Subtask blocked | Goal pauses; blocker shown on the goal card |
| Engine restart mid-goal | All state is in `tasks.json` + mind repo (`waves_done`, statuses); only the in-memory attempt counter resets |

## 12. Tests

- **Replay** (no LLM): SUBTASKS parser + every budget/validation rule; the GOAL-vs-BRIEF decision parsing; depth-limit rejection.
- **Functional** (real engine, fake `pi`): `config.json` → `pi_bin` points at a fixture script that prints canned marker output per job kind. Drive a full goal: plan → outline → approve → wave 1 → subtasks done → goal test fails → wave 2 → goal test passes → Done. Plus: budget exhaustion → Blocked; blocked subtask pauses the goal; restart mid-goal resumes.
- **Stand-down**: extend `test-dory-standdown.mjs` with `wave`.
- **Live** (LM Studio): one small goal (2 subtasks) end to end with the real model, before turning on `auto-wave`.

## 13. Phases

1. **Goal cards + wave 1 + just-in-time planning + goal test**, review autonomy only. Includes the two `tick()` fixes, the `wave` guard stand-down, and UI badges.
2. **Next waves**: `wave` job, handoff notes, budgets, STUCK.
3. **Autonomy dial** (`auto-wave`, `auto`); **rescue** (Dory proposes splitting a Blocked card); **discovery** (executor-reported missing work lands in Chat for triage, never auto-built).
4. **Ingest as a goal**: 📥 creates one goal card (PRD = goal) instead of loose cards, so big requirement dumps get waves, handoffs and a goal test too.

## 14. Open questions

1. Who writes the goal test's first version: Dory in the plan job (proposed), or the human?
2. Should subtasks inherit the goal's priority, or keep their own?
3. Under `review`, approve subtasks one by one (proposed), or approve a whole wave at once by dragging the goal?
4. Deterministic "files changed" for handoffs: the project may not be a git repo. Use a git snapshot if it is, otherwise an mtime scan of the project?
