# PiForge

**Hard enforcement for local LLMs running on [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).**

Local models (35B and under) spiral, forget, and write 800-line files in one shot. PiForge physically prevents that — at the API boundary, not the prompt level — and gives the model an external brain via `.think/` files that survive context compression.

Tested with `qwen3.6-35b-a3b` at **Q2_K_XL quantization** via LM Studio on macOS. Yes — a 2-bit quantized model doing structured multi-file coding, codebase distillation, and tool-call workflows. The guard stack makes that possible.

---

## What's in the box

### 10 hard-enforcement extensions (guards)

| Extension | What it enforces | Default |
|---|---|---|
| `incremental-guard.ts` | Rejects writes > 100 lines/6000 chars, edits > 60 lines/3000 chars — forces skeleton → small edit workflow | on |
| `thinking-guard.ts` | Injects correction when thinking block > 2000 chars — stops reasoning spirals | on |
| `context-monitor.ts` | Steers model to write state files at 65% context, force-compacts at 80% with aggressive summarization; re-injects full AGENTS.md every 4th compaction (condensed digest in between, tune `FULL_AGENTS_EVERY`) | on |
| `analysis-guard.ts` | Forces findings to `.think/step-NNN.md` when response > 1000 chars with no file write | on |
| `state-guard.ts` | Blocks source reads until `_state.md` is read; forces updates every 5 turns; enforces `.think/` at root only (not in subfolders); blocks source writes after a new user prompt while `_state.md` says complete, until the state is rewritten | on |
| `loop-guard.ts` | Detects repetition loops via Jaccard similarity (warns at 4, blocks at 6) AND malformed tool calls (warns at 4, compacts at 8). Auto-compacts to escape both. Safety net for missing inference settings | **off** |
| `first-prompt.ts` | Appends "plan in steps, implement one at a time" to first prompt — preventive, zero context overhead | on |
| `plan-clarify.ts` | Intercepts `_plan.md` writes — forces model to ask ≤3 clarifying questions before any code | **off** |
| `knowledge-injector.ts` | Pi subprocess (`--thinking off`) selects relevant `./knowledge/` files per-file. Large files distilled to `.distilled/` with hash-based cache. Manifest survives compaction. `/forget` to remove. | on |
| `web-search.ts` | Web search with sub-pi synthesis. Searches DuckDuckGo, fetches pages, synthesizes via isolated sub-pi — main context only sees final summary. `web_search()` tool + `/web-search` command | on |

These are **hard** — the model cannot bypass them. `incremental-guard`, `knowledge-injector`, and `loop-guard` physically reject tool calls. The others inject steering messages before the next LLM call.

`plan-clarify` and `loop-guard` are **disabled by default** — enable per session with `/piforge enable <name>`. Use `/piforge` to see status.

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
| `purpose-anchor.ts` | Captures session purpose from first prompt, re-injects purpose + state after compaction | on |

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

The guard tracks writes per file path in a sliding window of 10. Only repeated writes to the **same file** are flagged — writing similar but different files (e.g., `LeftArm.cs` / `RightArm.cs`) is normal progress.

**Write loop escalation:**

| Trigger | Action |
|---|---|
| 4 similar writes (>85% Jaccard) | Warning steer |
| 6 similar writes | Hard block + escape hint |
| 3 blocked attempts | Abort → compact (ignore loop turns) → restart from `_state.md` |
| Loops again | Abort → double compact (crush context to one sentence) → restart |
| Still loops | Notify user to `/clear` |

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

On startup you should see:
```
incremental-guard active (max 100 lines / 6000 chars per write/edit)
thinking-guard active (max 2000 chars / 60 lines of thinking per turn)
context-monitor active — warn at 65%, force compact at 80% (window: XXXXX tokens)
analysis-guard active (triggers on responses >1000 chars with no file write)
session-manager: session-001 — .think/ ready
```

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

> Note: the Pi `incremental-guard` extension enforces this at the API layer regardless — the system prompt is a soft nudge on top.

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

## Full setup guide

See [PI-SETUP.md](./PI-SETUP.md) for the complete reference — every config option, tuning guide, benchmark results, and troubleshooting section.

---

## File structure

```
piforge/
├── README.md
├── install.sh                          ← run this first
├── PI-SETUP.md                         ← full reference guide
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
│   ├── loop-guard.ts                   ← detects repetition loops + malformed tool calls
│   ├── piforge-manager.ts              ← /piforge command to toggle extensions
│   ├── distill.ts                      ← /distill + distill_codebase tool
│   ├── distill-query.ts                ← /l1 /l2 /l3 direct level queries + /distill-status
│   ├── explore.ts                      ← /explore + explore_codebase tool (off by default)
│   ├── distill-awareness.ts            ← session-start awareness (off by default)
│   ├── purpose-anchor.ts              ← anti-drift: re-injects purpose after compaction
│   ├── session-manager.ts             ← per-tab .think/ isolation via symlinks
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
│   └── piforge.json                    ← extension toggles (plan-clarify + loop-guard off by default)
└── project-template/
    └── AGENTS.md                       ← installed globally to ~/.pi/agent/AGENTS.md
```
