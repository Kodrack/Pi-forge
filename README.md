# PiForge

**Hard enforcement for local LLMs running on [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).**

Local models (35B and under) spiral, forget, and write 800-line files in one shot. PiForge physically prevents that — at the API boundary, not the prompt level — and gives the model an external brain via `.think/` files that survive context compression.

Tested with `qwen3.6-35b-a3b` at **Q2_K_XL quantization** via LM Studio on macOS. Yes — a 2-bit quantized model doing structured multi-file coding, codebase distillation, and tool-call workflows. The guard stack makes that possible.

---

## What's in the box

### 13 hard-enforcement extensions (guards)

| Extension | What it enforces | Default |
|---|---|---|
| `incremental-guard.ts` | Rejects writes > 100 lines/6000 chars, edits > 60 lines/3000 chars, bash commands > 100 lines/6000 chars by default — override per machine in `~/.pi/piforge.json`, see [Per-machine settings](#per-machine-settings-pipiforgejson) (closes the heredoc side door — small `cat >>` append chunks stay allowed) — forces skeleton → small edit workflow. After blocking an oversized write it watches the path: if the "recovery" leaves the file at < half the attempted size, it steers once (likely truncated) | on |
| `project-jail.ts` | Confines all file mutations to the project root (session cwd): blocks `write`/`edit` targeting outside paths, and `bash` that mutates or `cd`s into home-area paths (`/Users`, `/home`, `~/`) outside the project. Reading/executing outside files stays allowed. Heredoc **bodies** are excluded from the scan — they're document content, never targets, and a doc mentioning `~/.pi/agent/` used to be unwritable via the sanctioned `cat >> file <<'CHUNK'` append. Side effect: executor sessions can't rewrite Dory's mind-repo tests | on |
| `thinking-guard.ts` | Hard-aborts a runaway generation mid-stream at 4000 chars per block AND 20000 chars cumulative per turn (thinking AND response text channels — the per-turn cap catches dumps split across many small blocks); soft-steers next turn when a thinking block exceeded 15000 chars. In Dory read-only stages the *text* caps are raised to 24000/40000 so a brief + acceptance test isn't clipped | on |
| `context-monitor.ts` | Steers model to write state files at 65% context, force-compacts at 80% with aggressive summarization; re-injects full AGENTS.md every 4th compaction (condensed digest in between, tune `FULL_AGENTS_EVERY`) and auto-continues the session (`triggerTurn`) — Pi's `compact()` aborts the agent loop, so without it the reinjection sits unread until the user types. Auto-continue is withheld when `.think/_state.md` says `Status: complete` or after `MAX_AUTO_CONTINUES` (3) consecutive auto-turns without real user input. Both steers are skipped in Dory read-only stages | on |
| `analysis-guard.ts` | Forces findings to `.think/step-NNN.md` when response > 1000 chars with no file write. Skipped in Dory read-only stages (the response is the deliverable) | on |
| `state-guard.ts` | Blocks source reads until `_state.md` is read; forces updates every 5 turns; enforces `.think/` at root only (not in subfolders); blocks source writes after a new user prompt while `_state.md` says complete, until the state is rewritten. Skipped in Dory read-only stages | on |
| `loop-guard.ts` | Detects repetition loops via Jaccard similarity (warns at 4, blocks at 6) AND malformed tool calls (warns at 4, compacts at 8). Auto-compacts to escape both. Safety net for missing inference settings | **off** |
| `first-prompt.ts` | Appends "plan in steps, implement one at a time" to first prompt — preventive, zero context overhead. Does not re-attach `AGENTS.md`: Pi already loads it into the system prompt. Skipped entirely in Dory read-only stages (the job prompt carries its own persona) | on |
| `plan-clarify.ts` | Intercepts `_plan.md` writes — forces model to ask ≤3 clarifying questions before any code | **off** |
| `knowledge-injector.ts` | Pi subprocess (`--thinking off`) selects relevant `./knowledge/` files per-file. Large files distilled to `.distilled/` with hash-based cache. Manifest survives compaction. `/forget` to remove. | on |
| `response-guard.ts` | Backstop for verbose no-tool-call responses (>20000 chars). In practice superseded by thinking-guard's 4000-char mid-stream abort — only matters when thinking-guard is disabled (see header comments in the file) | on |
| `web-search.ts` | Web search with sub-pi synthesis. Searches DuckDuckGo, fetches pages, synthesizes via isolated sub-pi — main context only sees final summary. `web_search()` tool + `/web-search` command | on |
| `execution-guard.ts` | Blocks `Status: complete` in `_state.md` while code files were modified but nothing was executed since — untested code cannot be declared done. Any execution releases the latch; gives up after 2 blocks. Built for unattended runs (`pi -p`, `/q` queues) | **off** |
| `done-nudge.ts` | The mirror image: after 3 consecutive executions with zero source changes in between, steers once — "your checks pass and nothing is changing; mark `_state.md` complete and stop". Kills the perfect-solution-but-can't-conclude overrun | on |
| `acceptance-guard.ts` | Makes "done" a harness verdict. The model must supply `.think/_acceptance.sh` (exits 0 only if the task is done); on `Status: complete` **the extension runs it** and the exit code decides — nonzero blocks the write and feeds back the real output. Rejects a test that passes before any code exists (a no-op test). Gives up after 3 blocks and hands back unverified. Supersedes `execution-guard` | on |

These are **hard** — the model cannot bypass them. `incremental-guard`, `knowledge-injector`, `execution-guard`, `acceptance-guard`, and `loop-guard` physically reject tool calls. The others inject steering messages before the next LLM call.

`plan-clarify`, `loop-guard`, and `execution-guard` are **disabled by default** — enable per session with `/piforge enable <name>`. Use `/piforge` to see status.

| `progress-checkpoint.ts` | Catches the *opposite* failure to all of the above: a session that never declares anything. At turn 30, then every 20, if **no file outside `.think/` has changed** since the last check, steers a forced choice — write `Status: complete` (acceptance-guard then verifies it) or write the ONE next action and do it; prose is rejected, the answer must be a tool call. A session that keeps changing files never sees one. Full instructions once, then a 284-char reminder, exponential backoff, and after 2 ignored checkpoints it stops steering and tells **you** instead | on |

**The completion chain.** These five extensions divide the job and are easy to confuse:
`progress-checkpoint` makes a stalled session *say something* → `done-nudge` pushes *toward* declaring done → `acceptance-guard` decides *whether it's true* (runs the test) → `execution-guard` is the weaker predecessor (only checks that *something* was spawned — `node --version` satisfies it; leave it off when `acceptance-guard` is on) → `completion-guard` enforces *stopping* once done is established. Only `acceptance-guard` looks at whether the code actually works, and only `progress-checkpoint` fires when the model declares nothing at all.

Context cost is why `progress-checkpoint` is built the way it is: a steer is permanent context, so nagging a 50k-context model is self-defeating. A fully stalled session injects ~1.2k chars total (one full message + one short reminder) and then hands off to the human; a productive session injects zero.

`acceptance-guard` has one opt-in tightening: set `REQUIRE_TEST_BEFORE_CODE = true` at the top of the file to block the first code write until an acceptance test exists. Off by default because it taxes trivial sessions; worth it for unattended runs (`pi -p`, `/q` queues) where nobody is watching.

### Codebase distillation — zoom levels for local models

A local model with 50k context can't hold a real codebase. Reading files one by one is slow, burns context, and the model forgets file #1 by the time it reads file #10. Distill solves this by building compressed versions of the entire codebase at multiple zoom levels — like Google Maps for your code.

**The idea:** You distill your codebase once. This creates three levels of compressed summaries, all mirroring the original folder structure:

```
Source (100%)  →  L1 (~50%)  →  L2 (~25%)  →  L3 (~12%)
full code         key logic     signatures     one-liners
```

When Pi needs to understand the codebase, it doesn't read source files. It queries the right zoom level:

- **L3** — "What modules exist? What's the architecture?" — fits in a few hundred tokens
- **L2** — "How does the auth system work?" — function signatures, key relationships
- **L1** — "Show me the output pipeline logic" — detailed summaries with key code preserved

Pi zooms in only when needed. Most questions are answered at L2/L3 without ever reading source. When Pi does need the actual code, it knows exactly which file to open because L2 already told it where things live.

**How it works:** Crawls the directory, builds an import graph, topologically sorts files, and processes each file via isolated sub-Pi calls — the main session LLM stays idle and clean. The distilled knowledge persists across sessions.

| Extension | What it does | Default |
|---|---|---|
| `distill.ts` | `/distill` command + `distill_codebase` LLM-callable tool | on |
| `distill-query.ts` | `/l1`, `/l2`, `/l3` query commands + `/distill-status` | on |
| `explore.ts` | `/explore` + `explore_codebase` tool (superseded by distill-query) | **off** |
| `distill-awareness.ts` | Session-start context injection (superseded by distill-query) | **off** |

**Additional features:**
- **Purpose-driven notes**: `--purpose "how does auth work?"` takes notes on each file during distillation, then synthesizes a comprehensive answer
- **LLM-callable tool**: Pi can call `distill_codebase` autonomously — no slash command needed
- **Single file support**: Distill one large file with automatic chunking
- **Auto-detect level**: Point at `.think/distill/L1/` and it auto-outputs L2
- **Resume support**: `--resume` continues interrupted distillation

```
/distill [path]                        # distill directory (default: .)
/distill [path] --purpose "question"   # distill + take notes on question
/distill --resume                      # resume interrupted run
/distill --level 2                     # compress L1 → L2
/distill [path] --ratio 30            # aggressive compression (30%)
/l1 "how does auth work?"             # query L1 summaries directly
/l2 "what modules exist?"             # query L2 summaries directly
/l3 "high-level architecture?"        # query L3 summaries directly
/distill-status                        # show coverage per level
```

Output structure:
```
.think/distill/
├── manifest.json      ← state: files, progress per level, config
├── distill.log        ← append-only log
├── L1/                ← mirrors source folder structure, ~50% of source
│   └── src/
│       └── auth.ts.md
├── L2/                ← same structure, ~25% of source
│   └── src/
│       └── auth.ts.md
├── notes/             ← purpose-driven findings (optional)
│   ├── auth-notes.md
│   └── auth-notes-answer.md
└── tmp/               ← prompt files (auto-cleaned)
```

### Web search (context-isolated)

| Extension | What it does | Default |
|---|---|---|
| `web-search.ts` | Web search with sub-pi synthesis — main context only sees final summary | on |

Local models don't have current knowledge. `web-search` lets Pi search the web without polluting the main context with raw HTML:

1. Searches DuckDuckGo for the query
2. Fetches top 5 result pages in parallel
3. Extracts readable content (strips nav, ads, scripts)
4. Spawns isolated sub-pi (`--no-session --no-extensions --no-tools --thinking off --offline`) to synthesize
5. Returns only the synthesis to main context

Raw pages are saved to `.think/web-search/<hash>/` for reference. The main Pi never sees the HTML — only the ~400 word synthesis.

```
/web-search "svelte 5 runes tutorial"    # manual search
# OR Pi can call web_search() tool autonomously
```

Use it BEFORE implementing when:
- Working with a library/API you're unsure about
- User mentions versions, "latest", or recent dates
- Debugging error messages you don't recognize
- Anything that might have changed since training

### Deep research (`/research` — a coded procedure, not a prompt)

| Extension | What it does | Default |
|---|---|---|
| `deep-research.ts` | `/research <topic>` — multi-round research pipeline: decompose → search per sub-question → gap-check → sourced report. All LLM work in isolated sub-Pis; main context receives only the final report | on |

One `web_search` answers one question. `/research` answers a *topic* — but a small local model can't be trusted to self-drive a multi-round methodology (it loses the plot by round 2). So the pipeline is a **deterministic TypeScript loop** and the model only does the cognitive steps, each as an isolated sub-Pi call:

1. **Decompose** — sub-Pi splits the topic into ≤5 sub-questions, each with a search query → `plan.md`
2. **Investigate** — per sub-question: SearXNG search → fetch top 3 pages → sub-Pi writes ≤300-word findings with source URLs → `round-1/qN.md`
3. **Gap-check** — sub-Pi reads all findings, emits up to 3 follow-up queries or `COMPLETE`
4. **Follow-up rounds** for the gaps (default 2 rounds total, hard cap 3)
5. **Synthesize** — sub-Pi writes `report.md` (findings by theme, recommendations, open questions, sources), delivered to the main session as a single steer message

The loop, round caps, pacing (6s between searches — engines suspend on bursts), and file layout are code — the model cannot extend or forget them. Interrupted runs resume: existing `plan.md` and findings files are reused. Failed searches/syntheses are skipped, never fatal.

```
/research "state of local LLM inference on consumer GPUs"
/research "topic" --rounds 1               # single sweep, no gap-check
```

Output structure:
```
.think/research/<topic-slug>/
├── plan.md            ← sub-questions + their search queries
├── round-1/q1.md ...  ← findings per sub-question (query, source URLs, synthesis)
├── round-2/q1.md ...  ← gap-fill findings (if the gap-check asked for them)
├── report.md          ← final sourced report (the only thing the main context sees)
├── research.log       ← append-only pipeline log
└── tmp/               ← prompt files (auto-cleaned)
```

Requires the same SearXNG backend as `web-search` (start with `/searxng up` if it's down).

### Codebase research (`/ask` — deep research over your code)

| Extension | What it does | Default |
|---|---|---|
| `code-research.ts` | `/ask <question>` + `code_research()` LLM-callable tool — same pipeline as `/research` but grep replaces the web: decompose → search the repo → read matching excerpts in sub-Pis → follow the chain → report with `file:line` citations | on |

The codebase twin of `/research`. Same deterministic loop, different backends:

1. **Decompose** — sub-Pi splits the question into ≤5 sub-questions, each with *code search terms* (identifiers, function names, string literals)
2. **Locate** *(pure node, no LLM, no shell)* — scans the repo for each term (distill's skip-dirs), ranks files by hits, cuts **line-numbered excerpt windows** (±40 lines) around the matches — never whole files
3. **Investigate** — per sub-question: one sub-Pi gets the excerpts, writes ≤300-word findings citing **`file:line`** (the evidence chain)
4. **Gap-check** — the multi-hop step: a sub-Pi spots identifiers the findings mention but never explain ("requests go through `EventBus`") and emits new search terms; the next round greps them and follows the chain
5. **Report** — answer + file map + open questions → `report.md`, delivered as one steer message

If `.think/distill/` exists it doubles as a **concept index** (L2 preferred, L1 fallback — L1 is what a plain `/distill` produces): a hit in a summary ("caches results in a memo map") pulls in the source file even when the identifiers never match — so concept questions work, not just identifier greps. No distill → grep-only, still works.

**The model picks it automatically**: `code_research()` is a registered tool whose description tells Pi to use it for multi-file "how does X work" questions and NOT when it already knows the file. Fits between the existing tools: `/l2` is single-shot, `/distill --purpose` reads *every* file (hours); `/ask` reads only what the search hit and hops across rounds (minutes, no network).

```
/ask "how does authentication flow from request to database?"
/ask "question" --rounds 1                 # quick single sweep
# OR Pi calls code_research() autonomously
```

Output structure:
```
.think/code-research/<question-slug>/
├── plan.md            ← sub-questions + their search terms
├── round-1/q1.md ...  ← findings per sub-question (terms, files consulted, file:line-cited findings)
├── round-2/q1.md ...  ← chain-following findings (if the gap-check asked)
├── report.md          ← answer + file map + open questions
├── research.log       ← append-only pipeline log
└── tmp/               ← prompt files (auto-cleaned)
```

### Voice input (push-to-talk, local STT)

| Extension | What it does | Default |
|---|---|---|
| `voice-input.ts` | `è` records the mic, `è` again stops → local speech-to-text → transcript lands in the input editor, Enter sends. Streams: audio is recorded in 30s chunks, each transcribed while you keep talking, so the prompt fills gradually — dictate for minutes (10 min auto-stop). Fully self-provisioning | on |

Zero setup: on session start the extension provisions itself in the background — creates an isolated venv at `~/.pi/stt-venv` (container-like: self-contained, never touches system python, `rm -rf` to remove), pip-installs the engine into it, and pre-downloads the model by transcribing 1s of silence. The footer status live-reports each step (`🎤 setting up parakeet: installing…` → `🎤 è · parakeet ready`); setup output goes to `~/.pi/stt-setup.log`. Nothing runs between transcriptions — the engine is spawned per use and exits in seconds (no daemon, zero idle RAM; models cached on disk in `~/.cache/huggingface`).

Two selectable engines, both fully offline after the first model download:

| Engine | Model | Best for |
|---|---|---|
| `parakeet` (default) | NVIDIA Parakeet TDT 0.6B v3 (MLX, ~600MB) | Best accuracy, Apple Silicon GPU |
| `moonshine` | Moonshine base (~57MB ONNX) | Lightest, fastest, any CPU |

```
pi --stt moonshine     # pick engine via CLI flag
/stt parakeet          # or switch mid-session (auto-installs the new engine too)
```

Why a venv and not Docker: Docker on macOS can't access the Apple Silicon GPU, so a containerized Parakeet (MLX/Metal) can't run at all — the venv gives the same isolation and automation with native GPU speed. Recording uses ffmpeg avfoundation (auto-installed via brew if missing); the terminal needs macOS microphone permission (prompted on first use). Tunables at top of file: `TRIGGER_KEY`, `DEFAULT_ENGINE`, `AUDIO_DEVICE`, `MAX_RECORD_MS`.

The trigger is the bare `è` key (intercepted via a custom editor component — Pi's shortcut system is ASCII-only). Trade-off: you can't *type* è into the prompt anymore (pasting è still works, é is unaffected). Change `TRIGGER_KEY` to any other single character if that bites.

### LM Studio console (remote model load/unload)

| Extension | What it does | Default |
|---|---|---|
| `lmstudio-console.ts` | `/lmstudio` — interactive console over LM Studio's management REST API: pick a model from the server's list (load state, quant, context shown), then load / unload / swap / reload at a different context length. Works against remote instances — the base URL comes from the `lmstudio` provider in `~/.pi/agent/models.json` (override with `LMSTUDIO_URL`) | on |

```
/lmstudio                     # interactive: select model → load / unload / swap
/lmstudio status              # print model states, no dialogs
/lmstudio load <id> [ctx]     # load, optionally at a context length
/lmstudio unload <id|all>     # unload one model, or everything loaded
```

Uses `GET /api/v0/models` for state and `POST /api/v1/models/load|unload` for actions — the same API surface LM Studio's own UI uses, so per-model settings configured there still apply to anything the request doesn't specify. "Swap" unloads whatever is currently loaded before loading the target, since two big models rarely fit in VRAM together. Load requests allow up to 10 minutes (a cold 27B takes a while); the footer shows `loading <model>…` while it runs.

### Session isolation (per-tab `.think/`)

| Extension | What it does | Default |
|---|---|---|
| `session-manager.ts` | Auto-creates isolated `.think/` per Pi terminal instance via symlinks | on |

Every time you open a new Pi terminal, `session-manager` creates a fresh directory under `.think-sessions/` and points the `.think/` symlink to it. The model always writes to `.think/` — same hardcoded path, zero tokens wasted on session management.

```
.think-sessions/
  session-001/          ← first Pi tab's state
  session-002/          ← second Pi tab's state
  session-003/          ← third Pi tab's state
.think/ → .think-sessions/session-003/   ← symlink to active session
```

If `.think/` already exists as a real directory (from before the extension), it gets migrated automatically into `session-001`.

Commands: `/sessions` (list all), `/switch-session [session-id]` (switch to a previous session)

### Purpose anchor (anti-drift after compaction)

| Extension | What it does | Default |
|---|---|---|
| `purpose-anchor.ts` | Captures session purpose from first prompt, re-injects purpose + state after compaction. In a Dory job the purpose is captured per job (never resumed from the previous one) and read-only stages are re-anchored on the job prompt alone | on |

When context gets compacted, Pi can lose track of the original goal. `purpose-anchor` solves this:
1. Saves first user prompt to `.think/_purpose.md`
2. Hooks into Pi's `session_compact` event
3. After compaction, steers Pi to re-read `.think/_state.md` and `_summary.md`
4. Pi re-orients and continues without drift

`/important "note"` adds persistent mid-session directives ("always use async", "don't touch auth module"). Saved to `_purpose.md` under `## Important`, steered immediately, survives compaction. Use `/important -compact "note"` to also force compaction after — cleans the context while the note is safe on disk.

Commands: `/purpose` (view/set), `/purpose-clear` (reset), `/important "note"` (add persistent note), `/important -compact "note"` (add + compact), `/important clear` (remove notes)

### Loop detection (Jaccard similarity + malformed call detection)

| Extension | What it does | Default |
|---|---|---|
| `loop-guard.ts` | Detects repetition loops AND malformed tool calls, auto-recovers via compaction | **off** |

Without proper inference settings (repeat penalty, temperature), Q2 models fall into loops — writing `_state.md` with identical content 20+ times, burning context doing nothing. They also sometimes emit malformed tool calls (empty `{}` arguments) repeatedly, poisoning context with failures. `loop-guard` detects both patterns and auto-recovers.

**Jaccard similarity** measures the overlap between two sets of words. Given two text blocks, tokenize each into a set of lowercase words, then: `J = |intersection| / |union|`. A score of 1.0 = identical word sets, 0.0 = no words in common. This runs in microseconds with zero inference cost — pure `Set` math in JS.

Each write is compared to the **immediately previous write of the same file** — a run of consecutive similar writes triggers the ladder. (It deliberately does NOT average against a write history: legitimate earlier updates dilute an average and let real loops run 2× longer before detection.) Only repeated writes to the **same file** are flagged — writing similar but different files (e.g., `LeftArm.cs` / `RightArm.cs`) is normal progress.

**Write loop escalation:**

| Trigger | Action |
|---|---|
| 4 consecutive similar writes (>85% Jaccard vs previous write) | Warning steer |
| 6 consecutive similar writes | Hard block + escape hint |
| 3 blocked attempts | Abort → compact (ignore loop turns) → restart from `_state.md` |
| Loops again | Abort → double compact (crush context to one sentence) → restart |
| Still loops | Notify user to `/clear` |

**Response-text loop escalation** (same Jaccard math on the model's output — thinking blocks INCLUDED, since on thinking models the repeated narration lives in the thinking channel while the text block is near-empty on tool-call turns):

| Trigger | Action |
|---|---|
| 2 near-identical responses in a row | Warning steer |
| 4 near-identical responses in a row | Abort → compact (break the loop) |

**Malformed tool call escalation:**

| Trigger | Action |
|---|---|
| 4 consecutive malformed calls | Warning steer — suggests simpler alternatives (write/edit instead of bash, avoid paths with spaces) |
| 8 consecutive malformed calls | Abort → compact (clear poisoned context of failed attempts) → restart |
| Still failing | Same escalation as write loops (double compact → tell user to `/clear`) |

Any valid tool call resets the malformed counter. The key insight: each failed attempt stays in context and the model fixates on retrying the same broken call. Compaction removes that poisoned history.

> **This is a safety net, not the primary defense.** The real fix is LM Studio inference settings: `repeat_penalty: 1.1`, `temperature: 0.58`. Enable with `/piforge enable loop-guard`.

### Task queue (post-completion delivery)

| Extension | What it does | Default |
|---|---|---|
| `queue.ts` | `/q "message"` queues work for after Pi finishes — delivered as a fresh turn, not a steer | on |

Queue messages while Pi is working. Each item is delivered one at a time after Pi completes a turn — Pi fully finishes one queued task before starting the next. No context pollution: queued messages don't exist in context until Pi is idle.

```
/q "now run the tests"          # queue a task
/q "then update the README"     # queue another
/q                              # show the queue
/q clear                        # clear all queued items
```

### 1 soft-enforcement skill

`incremental-codegen` — SKILL.md that teaches the model the skeleton → edit workflow. Works alongside the hard guards.

### Knowledge folder

`knowledge/` — inference-time context injection with zero context pollution.

On turn 1, `knowledge-injector` uses **pi subprocess calls** (`pi --thinking off`) to evaluate each knowledge file:

1. **Distillation** (large files >2000 chars): Summarizes to ~100 words, cached in `.distilled/` with hash-based invalidation. Only re-distills when source file changes.
2. **Selection** (per file): Asks "Is this file relevant to the purpose?" with YES bias. Each file evaluated independently — better accuracy than batch selection.

```
user prompt → distill large files (cached) → select per-file → inject content → Pi's main LLM call
```

Using `--thinking off` ensures clean output from thinking models (Qwen3, etc.) — no reasoning trace pollution.

Selected filenames are saved to `.think/_knowledge-manifest.md`. After compaction or session restart, the extension reads the manifest, rebuilds the content from source files, and re-injects automatically — zero LLM cost, no re-selection needed.

Code writes are blocked until `.think/_knowledge.md` is written — proof the model absorbed the knowledge.

**Skipped entirely during Dory `research`, `chat`, `plan`, `respond` and `wave` stages** (`DORY_SKIP_KINDS` in `knowledge-injector.ts`). Those jobs write no code, so selection is pure cost and the write-block is harmful: it burns turns on an acknowledgment and can push the `<<<BRIEF>>>`/`<<<TEST>>>` block out of the final assistant message, which is how a valid plan silently fails to reach the board. The stage is read from `~/.pi/organizer/dory-runner.json` (written by `dory-mode.ts`); `exec` jobs still get knowledge as normal. Four other extensions do the same stage check — see *Dory read-only stages* below.

Commands: `/forget <name>` (remove knowledge mid-session), `/guide` (load PiForge self-documentation into context on demand)

Knowledge is **project-local** — each project has its own `knowledge/` folder. Copy the files you need:

```
<your-project>/knowledge/
├── astro-gotchas.md
├── svelte5-gotchas.md
├── drag-and-drop-gotchas.md
├── canvas-node-editor-gotchas.md
├── playwright-testing.md
└── .distilled/                    ← auto-generated summaries for large files
    └── ...
```

`piforge-self.md` lives at `~/.pi/piforge-self.md` (global, loaded via `/guide`).

Included knowledge files:
- `svelte5-gotchas.md` — Svelte 5 runes failure patterns
- `astro-gotchas.md` — Astro islands, client directives, frontmatter pitfalls
- `drag-and-drop-gotchas.md` — HTML5 drag API, mouse drag, coordinate transforms
- `canvas-node-editor-gotchas.md` — render order, SVG wires, pan/zoom, ports
- `playwright-testing.md` — Playwright waiting, locators, assertions gotchas

Add your own — name by tech, failures only. Small files (<500 tokens) get full content sent to selection LLM. Large files get auto-distilled to `.distilled/` subfolder.

### Project template

`project-template/AGENTS.md` — drop into any project. Tells the model to use the `.think/` external brain workflow: scan knowledge folder at session start, read `_state.md` first, write one step file per turn, update state after every action.

### Organizer / "Dory" (experimental, `organizer/`)

The master layer above the executor: a 7-column, conversation-driven kanban (`chat → plan_queue → plan_created → approved → in_progress → done`, plus `blocked`) over `tasks.json` in a git "mind repo". Cards are stateless — the column defines what Dory does: chat threads in *Chat*, plan + acceptance test written in *Plan Queue*, feedback-driven plan revisions in *Plan Created*, and test-gated PiForge executor runs from *Approved* (bare cards get a quick plan at pickup). Board UI + engine are one zero-dependency process (`node organizer/board/server.mjs <mind-dir>`, or just press `ù` in Pi). See `organizer/README.md`.

**🔎 Research on any card.** A button in the card's panel has Dory web-search the card (1–3 searches) and rewrite its title and description in place, with sources and your original text in the conversation; the card stays in its column, and an already-planned card is told to replan.

**Long tasks become goals.** A card too big for one run is planned as a *goal*: an end-to-end goal test plus small waves of linked subtasks. Each subtask is planned only once the ones it depends on are done, reviewed by you, built, and records the files it changed (later related cards get those as pointers into the real code). When a wave is done the goal test decides: done, or Dory plans the next wave (or says what she's stuck on). Budgets (subtasks per wave, waves, total) are enforced in code. A card is pinned to the project where Dory first works on it (the folder of the Pi session where you pressed `ù`) and is only worked on there. See `organizer/README.md` and `organizer/LONG-HORIZON.md`.

| Extension | What it does | Default |
|---|---|---|
| `dory-board.ts` | `ù` (or `/board`) starts the orchestrator (background queue manager) and opens the kanban in the browser. Retargets Dory's project to this session's cwd on every press. Composes with voice-input's editor wrapper | on |
| `dory-mode.ts` | `/dory` — Dory's tasks run IN THIS Pi session: polls the board for jobs, opens a fresh session for EVERY task (hard context purge — earlier cards never bleed into later ones), runs it visibly with the full PiForge stack, nudges a research/plan/revise/wave job once if it ends without its marker block, posts the result back to the orchestrator (which parses, test-gates, and moves cards). `/dory off` returns the session | on |
| `dory-plan-guard.ts` | Makes Dory's `research`/`chat`/`plan`/`respond`/`wave` jobs **read-only** in-session — the same restriction headless jobs get from `--tools read,bash,web_search`. Blocks `write`/`edit` and mutating `bash` (redirect, heredoc, `tee`, `rm`/`mv`/`mkdir`, `sed -i`, `git add/commit`, installers), and once the marker block (`<<<TEST>>>`/`<<<END>>>`) has streamed it blocks **every** further tool call: the planner must not implement its own plan. Steers once after 3 blocked attempts so the job can't burn its timeout retrying | on |

#### Dory read-only stages

A research/plan/chat/revise/wave job's only deliverable is the marker block the board parses — it writes nothing, and the executor (a separate session, dispatched from *Approved*) is what implements the card. Headless jobs are restricted by `--tools read,bash,web_search` in `dory.mjs`; in-session `/dory` jobs have the full tool set and the full guard stack, so the restriction is enforced by extension instead. Eight extensions read the stage (`DORY_STAGE` env for headless jobs, `~/.pi/organizer/dory-runner.json` for in-session ones) and change behavior when it is `chat`, `plan` or `respond`. The file record carries the writing process's `pid` and is only honored when it matches: it is a single global slot, so without that check an unrelated Pi session — or any session started after a `/dory` session was killed mid-job — would find itself running under a planner's rules.

| Extension | Behavior in a read-only stage | Why |
|---|---|---|
| `dory-plan-guard.ts` | Blocks writes; blocks all tool calls after the marker block | The enforcement itself |
| `state-guard.ts` | Skipped entirely | Its "create `_state.md` NOW" steer both fights the read-only browse and pushes the job into writing files |
| `analysis-guard.ts` | Skipped entirely | The long response *is* the deliverable; it cannot be saved to `.think/step-NNN.md` |
| `first-prompt.ts` | Skipped entirely — no planning nudge | The job prompt carries its own persona; when first-prompt still attached `AGENTS.md`, a plan job copied that executor contract into the brief and followed it into implementation |
| `thinking-guard.ts` | Text abort caps raised (24000/block, 40000/turn) | A brief + acceptance test legitimately runs past the 4000-char text cap; clipping it loses the plan |
| `knowledge-injector.ts` | Skipped (selection pass + write-block) | No code is written, so selection is pure cost |
| `context-monitor.ts` | No `AGENTS.md`/digest re-injection after compaction; no "write your state files" warn steer (force-compaction still applies) | Same reason as `first-prompt`, but on the compaction path — re-injecting the contract restores the executor's rules mid-job, after `first-prompt` correctly withheld them |
| `purpose-anchor.ts` | Re-anchors on the **job prompt alone**, with no `.think/` instructions; `_purpose.md` is rewritten per job instead of resumed | The standard re-inject is the `.think/` workflow contract. And `_purpose.md` persists across jobs in one cwd, so a resumed purpose is the *previous* job's assignment |

In **every** Dory job, `exec` included, `acceptance-guard` and `progress-checkpoint` are inert: `dory.mjs` runs the card's own acceptance test and owns the retry loop, so a second oracle would deadlock the board.

Regression fixed 2026-07-25 (card T-006, "website for a CRM"): the plan job emitted a correct brief, then guard steers pushed it into `.think/` writes and on into writing `crm.html` — implementing inside the planning job. Replayed by `bench/replay/test-dory-plan-guard.mjs`.

Regression fixed 2026-07-26 (card T-007, same CRM ask): a `chat` job answered correctly, then compaction re-armed the whole coding harness against it — `context-monitor` re-injected all of `AGENTS.md` ("YOU MUST create `.think/_state.md`") on top of a prompt that says "Never create or modify any file", and `purpose-anchor` re-injected a `_purpose.md` still holding the *chat* job's prompt while the live job was a `plan` job. The model spent its whole reasoning budget reconciling two assignments, and with the card genuinely blocked on user input it re-sent the same no-op edit to `_state.md` seven times. Root cause was an install skew — `~/.pi/agent/extensions/` held pre-stand-down copies, so `dory-plan-guard.ts` wasn't installed at all. Run `bash dev-link.sh` while developing; the stand-down wiring for all six workflow extensions is asserted by `bench/replay/test-dory-standdown.mjs`.

---

## Install

```bash
git clone https://github.com/yourusername/piforge
cd piforge
bash install.sh
```

Then:
1. Start LM Studio, load your model, start the server on `:1234`
2. Edit `~/.pi/agent/models.json` — set the model `id` to match your LM Studio model
3. The workflow contract is installed globally (`~/.pi/agent/AGENTS.md`) — optionally add a project-local `AGENTS.md` containing ONLY project-specific rules
4. Run `pi` from your project directory

`install.sh` also runs `patch-pi-loader.sh`, which removes `CLAUDE.md`/`CLAUDE.MD` from Pi's context-file candidates (`dist/core/resource-loader.js`). Pi loads one context file per directory from `["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` for the cwd **and every ancestor directory**, so without the patch any repo with a `CLAUDE.md` and no `AGENTS.md` silently feeds Claude-Code instructions to the local model — often 10KB+ that does not apply to it. Pi offers no setting for this: `--no-context-files` is CLI-only and all-or-nothing, and `ExtensionAPI` has `getSystemPrompt()` with no setter. **Upgrading pi reverts the patch** — re-run `bash install.sh` (or `bash patch-pi-loader.sh`) afterwards. Revert with the `.piforge-bak` file it leaves beside the loader.

On startup you should see:
```
incremental-guard active (write: 100 lines/6000 chars, edit: 60 lines/3000 chars, bash: 100 lines/6000 chars)
thinking-guard active (max 2000 chars / 60 lines of thinking per turn)
context-monitor active — warn at 65%, force compact at 80% (window: XXXXX tokens)
analysis-guard active (triggers on responses >1000 chars with no file write)
session-manager: session-001 — .think/ ready
```

### Per-machine settings (`~/.pi/piforge.json`)

Machine-specific tuning lives in `~/.pi/piforge.json`, never in the repo. The repo's `config/piforge.json` is only the starting template; `install.sh` copies it once and never overwrites an existing file, and `/piforge enable|disable` edits it in place without touching the other sections.

```json
{
  "disabled": ["plan-clarify", "explore", "distill-awareness"],
  "limits": {
    "incremental-guard": { "maxLinesPerWrite": 200 }
  }
}
```

```
/piforge                                             # extension toggles + whether any limits are overridden
/piforge enable|disable <name>                       # switch an extension on/off on this machine
/piforge limits                                      # every tunable limit: active value + default
/piforge set incremental-guard.maxLinesPerWrite 200  # override a limit on this machine
/piforge reset incremental-guard.maxLinesPerWrite    # back to default (also: reset incremental-guard | reset all)
```

Every one of these writes `~/.pi/piforge.json` and nothing else — never the extension code. Changes apply on `/reload`. Values are validated before anything is saved (positive whole numbers; setting a limit to its default removes the override instead of pinning it). Editing the file by hand works too.

- `disabled` — extensions switched off on this machine (same list `/piforge` shows).
- `limits.incremental-guard` — overrides the guard's shipped defaults. Keys: `maxLinesPerWrite` (default 100), `maxCharsPerWrite` (6000), `maxLinesPerEdit` (60), `maxCharsPerEdit` (3000), `maxLinesPerBash` (100), `maxCharsPerBash` (6000). Omitted keys keep their default; values must be positive integers. Read at session start, so `/reload` applies a change. The startup banner lists active overrides, and any key it had to ignore (typo, wrong type) is named in a warning.

Models and the LM Studio host are machine-local too, but they belong to Pi itself: `~/.pi/agent/models.json` and `~/.pi/agent/settings.json` (`install.sh` asks before overwriting those).

### Updating PiForge

```bash
cd piforge && git pull
bash install.sh        # or: bash dev-link.sh if you work on PiForge itself
```

Then `/reload` (or restart `pi`). What an update touches, and what it never does:

- **Replaced:** the extensions, the skill, the global `AGENTS.md` and the `/guide` doc — that's the PiForge code.
- **Never overwritten:** `~/.pi/piforge.json` (your toggles and limits). New extensions that ship disabled by default are not added to your `disabled` list — compare with `config/piforge.json` after an update, or check `/piforge`.
- **Asked first:** `~/.pi/agent/models.json` and `~/.pi/agent/settings.json` (Pi's own model/host/compaction config).
- **Moved, not lost:** if you tuned limits the old way — by editing the constants in the *installed* `~/.pi/agent/extensions/incremental-guard.ts` — the update would replace that file. Both `install.sh` and `dev-link.sh` first run `migrate-config.mjs`, which copies any non-default value into `~/.pi/piforge.json` (a value already set there wins) and prints what it moved. Check the result with `/piforge limits`.

---

## Requirements

- [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) — `npm install -g @mariozechner/pi-coding-agent`
- [LM Studio](https://lmstudio.ai) with a model loaded and server running on `:1234`
- Node.js ≥ 20

**Recommended model:** `qwen3.6-35b-a3b` at Q2_K_XL quantization (Unsloth). Runs on consumer hardware via LM Studio.

> We develop and test PiForge at **Q2_K_XL** — the most aggressive quantization level. The results at 2-bit are already surprisingly good. At higher quantizations, they only get better.

Also tested with `qwen3-coder-30b-a3b-instruct`. Should work with any OpenAI-compatible local server.

---

## LM Studio settings

### System prompt

Add this in LM Studio → Model → System Prompt:

```
CRITICAL OUTPUT RULE: You MUST NEVER write more than 2000 tokens in a single tool call.

When generating a new file:
- First call: write ONLY the <head> and <style> section
- Second call: use bash to append the <body> HTML: cat >> file.html << 'CHUNK'
- Third call: use bash to append the <script> section
- NEVER put an entire HTML file in one write call

When the file would be large, ALWAYS use multiple bash append calls.

DO NOT OVERTHINK. Short thinking is better than long thinking.
```

> Note: the Pi `incremental-guard` extension enforces this at the API layer regardless — the system prompt is a soft nudge on top. Bash append chunks are ALSO capped per call (100 lines / 6000 chars): a whole file smuggled through one giant heredoc gets rejected the same way an oversized `write` does; multiple small `cat >>` chunks are the intended path.

### Inference parameters

| Parameter | Value | Notes |
|---|---|---|
| Temperature | `0.58` | Focused but not robotic |
| Response length limit | `2000` tokens | Backstop — guards are the real enforcement |
| Top-K sampling | `30` | Narrows token selection |
| Repeat penalty | `1.1` | Mild reduction of token-level loops |
| Top-P sampling | `0.95` | Standard nucleus sampling |
| Min-P sampling | `0.08` | Cuts low-probability tail tokens |

> The response length limit is not always respected by local models — treat it as a last-resort backstop, not primary enforcement. The guard stack handles the real enforcement.

---

## Why this exists

Cloud models (GPT-4, Claude, Gemini) self-regulate well enough that you don't need enforcement. Local 35B models don't — they ignore prompt rules, spiral in reasoning loops, and produce truncated garbage when they try to write large files.

The existing local LLM tooling (Cline, Roo, etc.) is designed for cloud models and just pointed at local endpoints. PiForge is built specifically for the constraints of local inference:

- **Hard limits** at the API layer, not suggestions in a prompt
- **External memory** via `.think/` files — the model writes everything to disk instead of holding it in context
- **Distillation** — build a knowledge base from a codebase once, reference it across sessions without re-reading source files

> A scalpel isn't better than a chainsaw because it's sharper — it's better because you're doing surgery, not cutting trees.
>
> PiForge doesn't make a Q2 quantized model smart. It removes every decision the model is bad at, until what remains is a narrow set of small, recoverable tasks it can do reliably. The right tool constrained to the right task performs well regardless of raw capability.

---

## Testing PiForge itself

`bench/` is a dev-side harness (never installed) that verifies the guards do what they claim:

```bash
bash bench/run-replay.sh              # instant: replays recorded failure scenarios against guard logic
bash bench/live/run-live.sh           # real pi + your local model: bypass trials + false-positive regression
TRIALS=1 bash bench/live/run-live.sh  # quick smoke (~5 min)
```

It exists because a benchmark caught a real hole: a single bash heredoc bypassed `incremental-guard` 5/5 times (0/5 after the fix). Run it after editing any guard — see [bench/README.md](./bench/README.md).

## Full setup guide

See [PI-SETUP.md](./PI-SETUP.md) for the complete reference — every config option, tuning guide, benchmark results, and troubleshooting section.

---

## File structure

```
piforge/
├── README.md
├── install.sh                          ← run this first (and after every update)
├── migrate-config.mjs                  ← run by install.sh/dev-link.sh: moves hand-edited limits into ~/.pi/piforge.json
├── PI-SETUP.md                         ← full reference guide
├── bench/                              ← dev-side test harness (never installed)
│   ├── run-replay.sh                   ← instant logic replays (no LLM)
│   └── live/run-live.sh                ← real-pi bypass trials + regression
├── distill-v2-plan.md                  ← distill design document
├── distill-v2-implementation.md        ← distill implementation spec
├── extensions/
│   ├── incremental-guard.ts            ← blocks oversized write/edit calls
│   ├── thinking-guard.ts               ← stops reasoning spirals
│   ├── context-monitor.ts              ← warns before context degrades
│   ├── analysis-guard.ts               ← forces analysis to disk
│   ├── token-counter.ts                ← tracks tokens + Gemini cost comparison
│   ├── first-prompt.ts                 ← injects planning instruction into first prompt only
│   ├── plan-clarify.ts                 ← clarifying questions after _plan.md (off by default)
│   ├── knowledge-injector.ts           ← isolated LLM selects project-local knowledge files, hash-based distill cache
│   ├── state-guard.ts                  ← blocks reads until _state.md read, forces updates
│   ├── acceptance-guard.ts             ← runs .think/_acceptance.sh; blocks "Status: complete" unless it exits 0
│   ├── progress-checkpoint.ts          ← stalled session (no file changes) → forced "done or next action" checkpoint
│   ├── loop-guard.ts                   ← detects repetition loops + malformed tool calls
│   ├── piforge-manager.ts              ← /piforge: toggles + limits (limits|set|reset) → ~/.pi/piforge.json
│   ├── dory-board.ts                   ← ù or /board: start the Dory board server + open the kanban
│   ├── dory-mode.ts                    ← /dory: run board jobs in this session (fresh session per job)
│   ├── dory-plan-guard.ts              ← keeps research/chat/plan/respond/wave jobs read-only, stops them after the marker block
│   ├── distill.ts                      ← /distill + distill_codebase tool
│   ├── distill-query.ts                ← /l1 /l2 /l3 direct level queries + /distill-status
│   ├── deep-research.ts                ← /research — multi-round research pipeline (coded, not prompted)
│   ├── code-research.ts                ← /ask + code_research tool — deep research over the codebase
│   ├── explore.ts                      ← /explore + explore_codebase tool (off by default)
│   ├── distill-awareness.ts            ← session-start awareness (off by default)
│   ├── purpose-anchor.ts              ← anti-drift: re-injects purpose after compaction
│   ├── session-manager.ts             ← per-tab .think/ isolation via symlinks
│   ├── lmstudio-console.ts            ← /lmstudio: list/load/unload models on the LM Studio server
│   └── queue.ts                       ← /q "message" — post-completion task queue
├── knowledge/                          ← copy to your project's knowledge/ folder
│   ├── svelte5-gotchas.md              ← Svelte 5 runes failure patterns
│   ├── astro-gotchas.md                ← Astro islands + client directives failure patterns
│   ├── drag-and-drop-gotchas.md        ← HTML5 drag API, mouse drag, coordinate transforms
│   ├── canvas-node-editor-gotchas.md   ← render order, SVG wires, pan/zoom, ports
│   └── playwright-testing.md           ← Playwright waiting, locators, assertions gotchas
├── config/
│   ├── piforge-self.md                 ← PiForge guide (installed to ~/.pi/, loaded via /guide)
├── skills/
│   └── incremental-codegen/
│       └── SKILL.md                    ← soft-enforcement skill
├── config/
│   ├── models.json                     ← LM Studio provider config template
│   ├── settings.json                   ← Pi global settings
│   └── piforge.json                    ← template for ~/.pi/piforge.json (copied once; per-machine toggles + limits live there)
└── project-template/
    └── AGENTS.md                       ← installed globally to ~/.pi/agent/AGENTS.md
```
