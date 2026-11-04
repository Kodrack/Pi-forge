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
- The header toggle sets `dispatch` in `tasks.json` — the master switch the
  dispatch daemon honors: ON = Dory automatically picks up approved tasks.
- Illegal state transitions are rejected by the server (409 + allowed moves).

API: `GET /api/board` · `POST /api/ingest` · `POST /api/tasks` (with initial
`status`: chat | plan_queue | approved) · `POST /api/tasks/:id/message` ·
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
run the goal test, plan the next wave) → execution → planning → pickup.
All LLM work via `pi` subprocesses; personas live in `dory-persona.md`
(`## Chat`, `## Plan`, `## Revise`, `## Revise goal`, `## Wave` sections).

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
3. A subtask that passes leaves a **handoff note** in `handoffs/T-NNN.md`: the
   files that run changed, plus the executor's own `<<<HANDOFF>>>` notes. Later
   subtask plans, executor runs and wave jobs of the same goal read them.
4. When a wave is all Done, the engine runs the goal test. Pass → goal Done.
   Fail → a read-only **wave** job plans the next wave from the goal, the
   handoffs and the failing output — or answers STUCK with what it needs from
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

**Planning order changed for every card:** a card in Plan Queue is planned only
once the cards it `depends_on` are Done (before, cards from 📥 ingest were all
planned at once, against code that didn't exist yet).

**Dory's own stages are read-only.** A chat/plan/revise/wave job's entire deliverable
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
   task the extension opens a fresh session — a hard context purge — then
   runs the job and posts the result back to the orchestrator, which parses
   it, runs acceptance tests, moves cards, commits. `/dory off` returns the
   session to you.

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
