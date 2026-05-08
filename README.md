# PiForge

**Hard enforcement for local LLMs running on [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).**

Local models (35B and under) spiral, forget, and write 800-line files in one shot. PiForge physically prevents that — at the API boundary, not the prompt level — and gives the model an external brain via `.think/` files that survive context compression.

Tested with `qwen3.6-35b-a3b` and `unsloth/Qwen3-30B-A3B` via LM Studio on macOS.

---

## What's in the box

### 7 hard-enforcement extensions

| Extension | What it enforces | Default |
|---|---|---|
| `incremental-guard.ts` | Rejects write/edit calls > 80 lines or 6000 chars — forces skeleton → edit workflow | on |
| `thinking-guard.ts` | Injects correction when thinking block > 2000 chars — stops reasoning spirals | on |
| `context-monitor.ts` | Steers model to write state files at 65% context, urgent at 80% | on |
| `analysis-guard.ts` | Forces findings to `.think/step-NNN.md` when response > 1000 chars with no file write | on |
| `first-prompt.ts` | Appends "plan in steps, implement one at a time" to the first prompt only — preventive, zero context overhead | on |
| `plan-clarify.ts` | Intercepts `_plan.md` writes — forces model to ask ≤3 clarifying questions before any code | **off** |
| `knowledge-injector.ts` | Hardcoded step 0: isolated LLM call selects relevant `~/.pi/knowledge/` files — selection reasoning never in context | **off** |

These are **hard** — the model cannot bypass them. `incremental-guard` and `knowledge-injector` physically reject tool calls. The others inject steering messages before the next LLM call.

`plan-clarify` and `knowledge-injector` are **disabled by default** — enable per session with `/piforge enable <name>`. Use `/piforge` to see status.

### 1 codebase distillation command

`/distill [path]` — crawls a directory, builds an import graph, topologically sorts files (dependencies first, entry points first), clusters similar patterns, batches small files, and injects a structured bottom-up distillation workflow. The model reads and summarizes one file per turn, building a `.think/distill/` knowledge base:

```
.think/distill/
├── manifest.md       ← progress checklist with smart ordering labels
├── files/            ← per-file summaries
├── modules/          ← per-directory summaries
├── architecture.md   ← system overview, data flow, gotchas
└── index.md          ← "to understand X, read Y"
```

`/distill --resume` continues an interrupted distillation from the last unchecked entry.

### 1 soft-enforcement skill

`incremental-codegen` — SKILL.md that teaches the model the skeleton → edit workflow. Works alongside the hard guards.

### Knowledge folder

`knowledge/` — inference-time context injection with zero context pollution.

On turn 1, `knowledge-injector` makes an **isolated LLM call** using Pi's own model and endpoint. It passes the user's prompt + the knowledge filenames and asks "which are relevant?". The selection reasoning happens in that isolated call — it never appears in Pi's conversation history. Only the selected file content gets injected as a steer.

This means: smart semantic selection (the LLM knows the task), zero reasoning trace in context.

```
user prompt → isolated call → selects files → injects content only → Pi's main LLM call
```

Code writes are blocked until `.think/_knowledge.md` is written — proof the model absorbed the knowledge.

Included samples:
- `svelte5-gotchas.md` — Svelte 5 runes failure patterns
- `astro-gotchas.md` — Astro islands, client directives, frontmatter pitfalls

Add your own — name by tech, keep under 500 tokens, failures only:
```
~/.pi/knowledge/
├── astro-gotchas.md
├── svelte5-gotchas.md
├── react-hooks.md
└── ...
```

### Project template

`project-template/CLAUDE.md` — drop into any project. Tells the model to use the `.think/` external brain workflow: scan knowledge folder at session start, read `_state.md` first, write one step file per turn, update state after every action.

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
3. Copy `project-template/CLAUDE.md` into any project you work on
4. Run `pi` from your project directory

On startup you should see:
```
incremental-guard active (max 80 lines / 6000 chars per write/edit)
thinking-guard active (max 2000 chars / 60 lines of thinking per turn)
context-monitor active — warn at 65%, urgent at 80% (window: XXXXX tokens)
analysis-guard active (triggers on responses >1000 chars with no file write)
```

---

## Requirements

- [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) — `npm install -g @mariozechner/pi-coding-agent`
- [LM Studio](https://lmstudio.ai) with a model loaded and server running on `:1234`
- Node.js ≥ 20

**Recommended model:** [unsloth/Qwen3-35B-MoE](https://huggingface.co/unsloth) (Unsloth quantized, runs well at 4-bit on consumer hardware)

Also tested with `qwen3.6-35b-a3b` and `qwen3-coder-30b-a3b-instruct`. Should work with any OpenAI-compatible local server.

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
├── extensions/
│   ├── incremental-guard.ts            ← blocks oversized write/edit calls
│   ├── thinking-guard.ts               ← stops reasoning spirals
│   ├── context-monitor.ts              ← warns before context degrades
│   ├── analysis-guard.ts               ← forces analysis to disk
│   ├── token-counter.ts                ← tracks tokens + Gemini cost comparison
│   ├── first-prompt.ts                 ← injects planning instruction into first prompt only
│   ├── plan-clarify.ts                 ← clarifying questions after _plan.md (off by default)
│   ├── knowledge-injector.ts           ← isolated LLM call selects knowledge files (off by default)
│   ├── piforge-manager.ts              ← /piforge command to toggle extensions
│   └── distill.ts                      ← /distill codebase knowledge builder
├── knowledge/
│   ├── README.md                       ← how to write knowledge files
│   ├── svelte5-gotchas.md              ← Svelte 5 runes failure patterns
│   └── astro-gotchas.md                ← Astro islands + client directives failure patterns
├── skills/
│   └── incremental-codegen/
│       └── SKILL.md                    ← soft-enforcement skill
├── config/
│   ├── models.json                     ← LM Studio provider config template
│   ├── settings.json                   ← Pi global settings
│   └── piforge.json                    ← extension toggles (plan-clarify + knowledge-injector off by default)
└── project-template/
    └── CLAUDE.md                       ← drop in any project
```
