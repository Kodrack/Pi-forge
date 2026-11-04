# Organizer ("Dory") — the master side of PiForge

PiForge makes a small model *execute* coding tasks. The organizer is the layer
above it: a "developer mind" that turns raw requirements into planned tasks,
holds project memory in a git repo of plain files, and (eventually) dispatches
approved tasks to PiForge executor sessions. Dory is the master, PiForge is the
executor; the human approval gate sits between them.

## The 7 columns (cards are stateless — the column defines the behavior)

```
chat → plan_queue → plan_created → approved → in_progress → done
 💬        📝          🔁 review      ⏳ queue     🤖 exec        ✅
                                                    └──► blocked (after N failed attempts)
```

1. **Chat** — each card is a conversation thread with Dory (click the card →
   drawer with the thread + reply box). Dory answers; she may browse the
   project read-only first.
2. **Plan Queue** — Dory picks cards here, browses the codebase, writes
   `tasks/T-NNN.md` (plan) + `tests/T-NNN.sh` (acceptance test), posts the
   plan into the card's conversation, and auto-moves the card onward.
3. **Plan Created** — review stage. Reply on the card with feedback → Dory
   rewrites the plan and answers "this is the new plan"; the card stays here
   until YOU drag it to Approved.
4. **Approved** — Dory's to-do queue (needs the header toggle ON). Picked by
   priority, dependencies first. A bare card dropped straight here works too:
   Dory writes a quick plan + test at pickup, then implements ("I need this
   done quickly" path).
5. **In Progress** — engine-owned (you can't drag INTO it): PiForge executor
   session in the project, then the acceptance test runs.
6. **Blocked** — attempts exhausted (`max_attempts`, default 3); the failure
   output is attached to the card. Drag it anywhere to retry/replan.
7. **Done** — the acceptance test exited 0.

You can drag any card to any column (except In Progress) — cards carry no
workflow state, so wherever a card lands, Dory does that column's job with
whatever the card contains. Old 5-column boards are migrated automatically.

**🔎 Research, on any card.** The card's detail panel has a **🔎 Research**
button (or tick *research first* when creating a card). Dory runs a read-only
job with `web_search` (1–3 searches: current versions, recommended approach,
pitfalls) and rewrites the card's **title and description in place**; her
message lists the sources and quotes your original text, so nothing you wrote
is lost. The card doesn't move. If it already has a plan (or a goal outline),
she says the plan was written for the old description and suggests replanning.
Not available while a card is In Progress. A failed attempt retries after 5
minutes; after 3 failures the request is dropped and you're told.

## Board (`board/`)

A zero-dependency kanban UI over `tasks.json` in the mind repo.

```bash
node organizer/board/server.mjs ~/dev-mind     # PORT=4747 by default
open http://localhost:4747
```

Or from inside any Pi session: press **`ù`** (or `/board`) — the `dory-board.ts`
extension auto-starts the server against `~/dev-mind` (creating and
git-initializing it on first use) and opens the page. Override with
`DORY_MIND_DIR` / `DORY_BOARD_PORT` env vars.

- `tasks.json` is the single machine-readable state — every writer (UI, Dory,
  daemon) mutates it through the same HTTP API; the UI live-updates via SSE
  when anyone else writes it.
- Every mutation appends to the task's `history` array (the complete trail)
  and is git-committed when the mind dir is a repo (bursts batch into one
  commit with a combined message).
- The header switch (**dory active / dory paused**, `dispatch` in `tasks.json`)
  is Dory's master switch for ALL work. Active: she answers, researches, plans
  and builds. **Paused: she stops immediately** — a running job is killed on
  the spot (a background `pi` and everything it started, or an acceptance/goal
  test), a job in your `/dory` session is aborted within ~2 s (the session
  checks the board every 2 s while it works), and an interrupted build goes
  back to Approved with a note (partial edits may remain; it restarts from
  attempt 1). Nothing is counted as a failure. While paused, nothing runs at
  all — not even replies. A new board starts paused.
- Illegal state transitions are rejected by the server (409 + allowed moves).

API: `GET /api/board` · `POST /api/ingest` · `POST /api/tasks` (with initial
`status`: chat | plan_queue | approved, optional `research: true`) ·
`POST /api/tasks/:id/message` · `POST /api/tasks/:id/research` ·
`GET /api/tasks/:id/detail` · `POST /api/tasks/:id/move` · `PATCH /api/tasks/:id` ·
`DELETE /api/tasks/:id` · `POST /api/dispatch` · `GET /api/events` (SSE).
See the header comment in `board/server.mjs` for payloads.

Deleting: hover a card → `✕` (confirm dialog), or the `clear` button in the
Completed column header to purge all finished tasks. Deletion also removes the
task's `tasks/T-NNN.md` + `tests/T-NNN.sh` files, strips it from other tasks'
`depends_on`, and is git-committed like every other mutation.

## The Dory engine (`board/dory.mjs`)

Runs **inside the board server** — launching the board launches Dory. One job
per 5s tick, priority: replies (chat + plan revisions) → goals (start a wave,
run the goal test, plan the next wave) → execution → 🔎 research → planning →
pickup.
All LLM work via `pi` subprocesses; personas live in `dory-persona.md`
(`## Research`, `## Chat`, `## Plan`, `## Revise`, `## Revise goal`, `## Wave` sections).

**Goals: long tasks in waves** (design + rationale: `LONG-HORIZON.md`). When a
card is too big for one executor run, the plan job answers with a **goal**
instead of a brief: a one-paragraph goal, an end-to-end **goal test**, and a
first wave of 2–4 small **subtasks**. The outline waits in Plan Created like any
plan (reply to change it, or to turn it back into one card).

1. Drag the goal to Approved (dispatch ON). Dory checks the goal test *fails*
   (a test that already passes tests nothing), creates the wave as linked
   subtask cards (`↳ T-020 · wave 1` on the board) and moves the goal to In
   Progress. The goal itself never runs the executor.
2. Each subtask is planned **just in time**: only once the subtasks it depends
   on are Done, so its plan is written against code that exists. Every subtask
   plan comes back to you in Plan Created; you approve each one.
3. Every card that passes its test records **which files it changed** (shown
   in the card's panel). Later subtasks of the goal — and any card that
   depends on it — get those as **file pointers** in their plan and executor
   prompts, and read the real files. The code is the reference; Dory only
   says where to look.
4. When a wave is all Done, the engine runs the goal test. Pass → goal Done.
   Fail → a read-only **wave** job plans the next wave from the goal, the
   files every subtask changed, and the failing output — or answers STUCK with what it needs from
   you (goal → Blocked).
5. A Blocked subtask pauses its goal until you fix or delete it.

Budgets are enforced in code, never trusted to the prompt — set them in
`config.json`:

```json
"long_horizon": { "max_subtasks_per_wave": 4, "max_waves": 5, "max_subtasks_total": 15 }
```

Subtasks can't be split again (depth 1), duplicate titles are dropped, bad
dependencies are dropped and reported, and a dependency cycle rejects the whole
wave. Out of budget with the goal test still failing → goal Blocked with the
last test output. Only `review` autonomy exists today: every subtask waits for
your approval.

**Cards are pinned to their project.** When Dory first works on a card
(research, plan or build), the card adopts the current project — the folder of
the Pi session where you pressed `ù` — and from then on is only planned,
researched and built there, never in whatever project Dory points at later.
Creating a card doesn't pin it, so you can queue cards first and start `pi` in
the right folder when work begins. Subtasks inherit their goal's project. If your `/dory`
session is in another project, the card waits and tells you to press `ù` in its
project's Pi session; background jobs simply run in the card's own folder. A
card whose project folder is gone is not run anywhere. The card panel shows
its project; a card from another project gets a 📁 badge on the board.

**How later cards know what earlier ones did:** the files themselves. Each
passed card records the files its run changed (a snapshot of the project is
taken when the card is claimed, so earlier cards' files and pre-existing
edits are never credited to it). Plans, revisions, waves and executor runs of
related cards — its dependencies, its goal's subtasks — get those file
pointers and read the code. There is no separate journal to drift from it.

**Planning order.** Normal and 📥 ingested cards are planned **ahead**, in
order, even if the cards they depend on aren't built yet, so you can review the
whole backlog. Goal **subtasks** are planned just in time (only once their
dependencies are Done), because waves are designed around planning against
code that exists. Change it in `config.json`: `"jit_planning": "subtasks"`
(default) | `"all"` (every card waits for its dependencies) | `"none"`.

**Dory's own stages are read-only.** A research/chat/plan/revise/wave job's entire deliverable
is the marker block the engine parses out of its final message — it writes no
files, and the *executor* (a separate session dispatched from Approved) is what
implements the card. Headless jobs get that from `--tools read,bash,web_search`;
in-session jobs (`/dory`) have the full tool set, so `dory-plan-guard.ts`
enforces it there — writes blocked, and every tool call after the marker block
blocked, so a planner cannot slide into implementing its own plan. Each job
exports its stage (`DORY_STAGE` for subprocesses, `dory-runner.json` — tagged
with the owning `pid`, so other sessions ignore it — in-session)
and the guards that assume a code-writing session stand down for it
(`state-guard`, `analysis-guard`, `first-prompt`, `knowledge-injector`; see
"Dory read-only stages" in the root `README.md`).

**Ingest** (📥 panel / `POST /api/ingest`): paste a massive requirements text —
Dory structures it into `prd/PRD-NNN.md` plus one Plan Queue card per work
item, with priorities and dependencies.

**Dory runs in YOUR Pi session** — the intended setup:

1. `cd` into your project, run `pi`, press **`ù`** — starts the orchestrator
   (silent background queue manager) and opens the web board, targeted at
   this folder.
2. Type **`/dory`** — this session becomes Dory's body: every job from the
   board (chat replies, planning, revisions, executor runs) executes HERE,
   fully visible in your Pi TUI with the whole PiForge stack. Before EVERY
   task the extension opens a fresh session — a hard context purge, so one
   card's context never bleeds into the next — then runs the job and posts
   the result back to the orchestrator, which parses it, runs acceptance
   tests, moves cards, commits. If a research/plan/revise/wave job ends
   without its marker block (a small model announcing "let me read X, then
   deliver" and stopping), it gets ONE automated nudge to deliver before the
   result is sent. `/dory off` returns the session to you.

The board server is a pure ORCHESTRATOR: kanban state machine + job queue +
test gate + git trail. When no Pi session is attached via `/dory`, jobs fall
back to headless `pi -p` subprocesses (watch them in the browser 🧠 panel, or
run the server in a terminal via `bash ~/.pi/organizer/dory-console.sh` to see
them stream there). All work happens in the folder where you ran `pi` — every
ù press retargets it, and `project-jail` hard-blocks anything outside.

**Watching in the browser instead**: the header shows a spinner + activity line
whenever a job is running, and the 🧠 console panel streams the same output
(also tailable: `tail -f <mind-dir>/.dory-tmp/live.log`). To see reasoning,
set `"dory_thinking": "low"` (or higher) in `config.json` — default `off` for
speed. Failed jobs leave their raw output in `.dory-tmp/*-failed-*.txt` and
retry after a 5-minute cooldown (moving the card retries immediately).

**IMPORTANT after updating PiForge**: a running board server keeps the code it
loaded at startup (the page will look new — HTML is re-read per request — but
the engine is stale). Restart it: `pkill -f "organizer/board/server.mjs"`,
then press `ù` again.

Everything is written to the mind repo (PRDs, briefs, tests, conversations in
`tasks.json`, `diary/`) and git-committed, so the full "what and why" trail is
browsable.

### Setup (one-time)

Set the target project in `<mind-dir>/config.json` (auto-created on first run):

```json
{ "project_dir": "/abs/path/to/your/project", "pi_bin": "pi", "dory_model": "", "max_attempts": 3 }
```

### Launching Dory

Press **`ù`** (or `/board`) in any Pi session — starts the server (board +
engine) and opens the page. Or standalone: `node organizer/board/server.mjs
~/dev-mind`. Then: paste requirements into 📥 → review the generated cards →
drag to Approved → flip the toggle to **dory active**. LM Studio must be
running (Dory and the executor are both `pi` calls).

## Planned

- **Executor-side hard guard** — block edits to the mind repo's `tests/` from
  executor sessions (today they're protected only by living outside the
  project dir).
- **Chat pane** — same page, talking to a Dory Pi session via `pi --mode rpc`
  bridged through the board server.
- **Memory conventions** — `_mind.md` entry point, decision records, memory
  recall injected into intake.
