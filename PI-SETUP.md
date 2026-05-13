# Pi Coding Agent — LM Studio Setup (Replication Guide)

A complete, copy-pasteable record of every change made to set up Pi Coding Agent against a local LM Studio server with `qwen3.6-35b-a3b`, plus an incremental-coding workflow that keeps API calls small — a seven-extension hard-enforcement stack that physically prevents oversized writes, runaway thinking, context degradation, and lost analysis — a `/distill` codebase knowledge-base builder, knowledge file injection, and first-prompt planning enforcement.

Tested on macOS (zsh) with Node 24, npm 11, Pi 0.73.0.

> **Quick install:** `bash install.sh` from the repo root installs everything automatically. The manual `cp` commands in each section below are for reference — run them from inside the `piforge/` directory (`$(pwd)` = the repo root).

---

## Table of contents
1. [Prerequisites](#1-prerequisites)
2. [Install Pi](#2-install-pi)
3. [Verify PATH](#3-verify-path)
4. [Configure LM Studio as a provider](#4-configure-lm-studio-as-a-provider)
5. [Set Pi defaults](#5-set-pi-defaults)
6. [Install the incremental-codegen skill (soft enforcement)](#6-install-the-incremental-codegen-skill-soft-enforcement)
7. [Per-project AGENTS.md template](#7-per-project-agentsmd-template)
8. [Install the incremental-guard extension (HARD: write/edit size)](#8-install-the-incremental-guard-extension-hard-writeedit-size)
9. [Install the thinking-guard extension (HARD: reasoning length)](#9-install-the-thinking-guard-extension-hard-reasoning-length)
10. [Install the context-monitor extension (HARD: context fill)](#10-install-the-context-monitor-extension-hard-context-fill)
11. [Install the analysis-guard extension (HARD: lost analysis)](#11-install-the-analysis-guard-extension-hard-lost-analysis)
12. [Install the distill extension (codebase knowledge base)](#12-install-the-distill-extension-codebase-knowledge-base)
13. [Install first-prompt extension (planning injection)](#13-install-first-prompt-extension-planning-injection)
14. [Install knowledge-injector extension (inference-time context)](#14-install-knowledge-injector-extension-inference-time-context)
15. [Install plan-clarify extension (clarifying questions)](#15-install-plan-clarify-extension-clarifying-questions)
16. [Install piforge-manager extension (toggle system)](#16-install-piforge-manager-extension-toggle-system)
17. [Install session-manager extension (per-tab .think/ isolation)](#17-install-session-manager-extension-per-tab-think-isolation)
18. [Install loop-guard extension (repetition loop detection)](#18-install-loop-guard-extension-repetition-loop-detection)
19. [LM Studio inference settings](#19-lm-studio-inference-settings)
20. [First run + verification](#20-first-run--verification)
21. [Useful slash commands inside Pi](#21-useful-slash-commands-inside-pi)
22. [Troubleshooting](#22-troubleshooting)
23. [Replication checklist](#23-replication-checklist)

---

## Layered enforcement model

This setup uses three layers, weakest to strongest:

| Layer | What | Reliability with local 35B |
|---|---|---|
| **Soft (skill)** | `incremental-codegen` SKILL.md tells the model the workflow | ~50–70% — model usually follows |
| **Soft (project)** | `AGENTS.md` reinforces rules per-project | adds another ~10–15% |
| **HARD (extensions)** | Four guards enforce behavior at runtime — model cannot bypass | ~99% per guard |

### The four hard-enforcement extensions

| Extension | What it guards | Trigger |
|---|---|---|
| `incremental-guard.ts` | write/edit tool call size | Rejects writes > 100 lines/6000 chars; edits > 60 lines/3000 chars |
| `thinking-guard.ts` | reasoning/thinking block length | Injects correction if thinking > 2000 chars |
| `context-monitor.ts` | context window fill | Steers model to write state at 65%, urgent at 80% |
| `analysis-guard.ts` | long responses with no file write | Forces step file write after any analysis > 1000 chars |

All four work together. `incremental-guard` stops bad code writes. `thinking-guard` stops reasoning spirals. `context-monitor` prevents context degradation. `analysis-guard` ensures findings are never lost to context.

### Extension scope reference

#### `incremental-guard.ts`
- **Scope:** `write` and `edit` tool calls only
- **Hook:** `tool_call` event — fires before the call executes
- **Blocks:** write > 100 lines or 6000 chars; edit new_string > 60 lines or 3000 chars; edit old_string > 120 lines (whole-file-via-edit trick)
- **Exempt:** lockfiles, `.svg`, `.lock` files (configurable)
- **On block:** sends a structured error with exact replan instructions — model must split work and retry
- **Command:** `/guard`

#### `thinking-guard.ts`
- **Scope:** assistant thinking/reasoning blocks (the `<think>` content)
- **Hook:** `message_update` (live streaming) + `turn_end` (enforcement)
- **Triggers:** thinking block > 2000 chars or 60 lines
- **Early warning:** at 80% of limit during streaming
- **On trigger:** injects steering message telling model to write conclusion to `.think/_state.md` and keep next response under 100 words
- **Does NOT cover:** chat response text (that's `analysis-guard`)
- **Command:** `/thinking-guard`

#### `context-monitor.ts`
- **Scope:** overall session context token usage
- **Hook:** `turn_end` — checks `ctx.getContextUsage()` after every turn
- **Triggers:** 65% context used (warn), 80% context used (urgent)
- **Fires once per threshold** — resets only if context drops
- **On warn (65%):** steering to write `_state.md` + `_summary.md` now
- **On urgent (80%):** steering to stop work, write full state, tell user to start fresh session
- **Why 65%:** 35B models with 4-bit KV cache degrade before the window fills — writing state early while the model is still coherent
- **Command:** `/context-monitor`

#### `analysis-guard.ts`
- **Scope:** any long chat response that didn't write a file
- **Hook:** `tool_call` (tracks writes per turn) + `turn_end` (checks response length)
- **Triggers:** response text > 1000 chars AND no `write`/`edit` call happened that turn
- **On trigger:** injects steering message with exact step file template to fill in
- **Does NOT trigger:** if the model already wrote a file that turn (correct behavior)
- **Command:** `/analysis-guard`

#### `distill.ts`
- **Scope:** codebase crawl + knowledge base generation (not a guard — a command)
- **Command:** `/distill [path]` or `/distill --resume`
- **What it does:** crawls a directory, builds an import graph, topologically sorts files (dependencies first, entry points first), clusters similar files, batches small files, writes a manifest to `.think/distill/manifest.md`, then injects a workflow steering message
- **Output structure:** `.think/distill/files/` (per-file summaries), `.think/distill/modules/` (per-directory), `architecture.md`, `index.md`
- **Resume:** `/distill --resume` reads the existing manifest, counts done vs. total, re-injects the workflow from the last unchecked entry

#### `first-prompt.ts`
- **Scope:** the very first user prompt of a session
- **Hook:** `input` event — fires before the prompt reaches the LLM
- **What it does:** appends `"Plan the implementation in numbered steps. Implement ONE step at a time ."` to the first prompt only
- **Fires once:** `fired` flag prevents any effect on subsequent prompts
- **Overhead:** zero — no steer message, no LLM call, no context cost
- **Toggle:** `/piforge disable first-prompt` / `/piforge enable first-prompt`
- **Default:** enabled

#### `knowledge-injector.ts`
- **Scope:** turn 1 of every session + after compaction/restart
- **Hook:** `input` (captures prompt) + `turn_start` (injects selected content) + `session_compact` (re-injects from manifest)
- **What it does:** uses pi subprocess calls (`pi --thinking off`) to evaluate each knowledge file:
  1. **Distillation** (large files >2000 chars): Summarizes to ~100 words, cached in `.distilled/` with hash-based invalidation
  2. **Selection** (per file): Asks "Is this file relevant to the purpose?" — each file evaluated independently for better accuracy
- **Blocks:** code writes (`write`/`edit`) until `.think/_knowledge.md` is created — proof the model processed the injected knowledge
- **Commands:** `/forget <name>` removes from manifest; `/forget` lists active knowledge
- **Toggle:** `/piforge enable knowledge-injector` / `/piforge disable knowledge-injector`
- **Default:** on

#### `plan-clarify.ts`
- **Scope:** fires whenever `_plan.md` is written
- **Hook:** `tool_call` (detects `_plan.md` write) + `turn_end` (injects steer)
- **What it does:** after `_plan.md` is written, injects a steering message telling the model to re-read the plan, identify top assumptions, and ask the user ≤ 3 clarifying questions (numbered options) before writing any code
- **Format enforced:** numbered questions with 2–4 options each, always includes "Other" as last option
- **Toggle:** `/piforge enable plan-clarify` / `/piforge disable plan-clarify`
- **Default:** disabled (adds a turn of latency; enable when building something where wrong assumptions are expensive)

#### `piforge-manager.ts`
- **Scope:** session management only — no LLM interception
- **Hook:** `session_start` (shows disabled extensions)
- **What it does:** provides `/piforge` command to list and toggle extensions; reads/writes `~/.pi/piforge.json`
- **Command:** `/piforge` (status), `/piforge enable <name>`, `/piforge disable <name>`
- **Toggleable extensions:** `first-prompt`, `knowledge-injector`, `plan-clarify`

#### `session-manager.ts`
- **Scope:** `.think/` directory isolation per Pi terminal instance
- **Hook:** `session_start` (creates new session, updates symlink)
- **What it does:** each new Pi terminal gets its own `.think/` directory via symlinks under `.think-sessions/`. The model always writes to `.think/` — same hardcoded path, zero overhead. Supports `/switch-session` to switch between sessions and `/sessions` to list them.
- **Commands:** `/sessions` (list all), `/switch-session` (list + pick), `/switch-session <id>` (switch directly)
- **Migration:** if `.think/` exists as a real directory, it's moved to `.think-sessions/session-001/` automatically

#### `loop-guard.ts`
- **Scope:** write/edit tool calls (content similarity) + ALL tool calls (malformed argument detection)
- **Hook:** `tool_call` — Jaccard similarity on word sets for writes, empty/missing field check for all calls
- **What it does:** two detectors: (1) repeated writes to the same file with >85% similarity → escalate from warning to auto-compact. (2) consecutive malformed tool calls (empty `{}` arguments, missing required fields) → warn at 4, compact at 8. Both share the same recovery ladder: compact → double compact → tell user to `/clear`. Zero inference cost.
- **Default:** disabled — the primary defense is LM Studio inference settings (repeat penalty). Enable with `/piforge enable loop-guard`
- **Why it exists:** without repeat penalty, Q2 models loop on identical writes. They also sometimes emit malformed tool calls repeatedly (can't format JSON for paths with spaces), poisoning context with failures. This catches both patterns regardless of inference harness.

---

## 1. Prerequisites

- **Node.js ≥ 20** and **npm ≥ 10**
- **LM Studio** with at least one model downloaded (recommended: `qwen3.6-35b-a3b` for general work, `qwen3-coder-30b-a3b-instruct` for code-heavy tasks)
- LM Studio server reachable at `http://localhost:1234/v1` (LM Studio → Developer tab → Start Server)

Quick checks:
```bash
node --version
npm --version
curl -s http://localhost:1234/v1/models | head
```

---

## 2. Install Pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

Verify:
```bash
which pi          # → /Users/<you>/.npm-global/bin/pi
pi --version      # → 0.73.0 or newer
```

---

## 3. Verify PATH

Pi's binary lives in your global npm bin directory. Make sure it's on PATH so `pi` works in every new terminal.

Add to `~/.zshrc` if not already present:
```bash
export PATH=~/.npm-global/bin:$PATH
```

Reload:
```bash
source ~/.zshrc
```

(On bash, use `~/.bashrc`. On fish, the equivalent `set -gx PATH ...`.)

---

## 4. Configure LM Studio as a provider

Pi reads custom providers from `~/.pi/agent/models.json`. Create it:

**File: `~/.pi/agent/models.json`**
```json
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3.6-35b-a3b",
          "name": "Qwen 3.6 35B A3B (LM Studio)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 50000,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "qwen3-coder-30b-a3b-instruct",
          "name": "Qwen 3 Coder 30B (LM Studio)",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Notes:
- The `id` must match exactly what `curl http://localhost:1234/v1/models` returns. Add/remove entries to taste.
- `apiKey: "lm-studio"` is a placeholder — LM Studio doesn't validate it.
- `compat.supportsDeveloperRole: false` and `supportsReasoningEffort: false` are required for OpenAI-compatible local servers.
- Set `reasoning: true` only on models that actually support thinking (Qwen3 family does; vanilla instruct models don't).
- `contextWindow` should match what you've set in LM Studio for that model load.
- **Don't lower `maxTokens` to force smaller calls** — that just truncates output mid-byte and the model produces broken files. Use the `incremental-guard` extension (Section 8) for real enforcement.

Verify Pi sees the models:
```bash
pi --list-models
```
Expected:
```
provider  model                         context  max-out  thinking  images
lmstudio  qwen3-coder-30b-a3b-instruct  32.8K    8.2K     no        no
lmstudio  qwen3.6-35b-a3b               50K      8.2K     yes       no
```

---

## 5. Set Pi defaults

Pi reads global settings from `~/.pi/agent/settings.json`. This sets your default provider/model and tunes context behaviour for local LLMs.

**File: `~/.pi/agent/settings.json`**
```json
{
  "defaultProvider": "lmstudio",
  "defaultModel": "qwen3.6-35b-a3b",
  "defaultThinkingLevel": "medium",
  "hideThinkingBlock": false,
  "quietStartup": false,
  "treeFilterMode": "all",
  "compaction": {
    "enabled": true,
    "reserveTokens": 8192,
    "keepRecentTokens": 28000
  }
}
```

Why each line:
- `defaultProvider` / `defaultModel` — `pi` launches into LM Studio + qwen3.6 with no flags.
- `defaultThinkingLevel: "medium"` — turn on the model's thinking stage when supported.
- `hideThinkingBlock: false` — render the thinking block in the TUI so you can see what the model is reasoning about (vs. staring at a spinner).
- `quietStartup: false` — show the full startup banner (loaded skills, context files, extensions) so you can verify everything wired up.
- `treeFilterMode: "all"` — `/tree` inside Pi shows every event (tool calls, intermediate steps).
- `compaction.keepRecentTokens: 28000` — for a 50k-context model, keep the most recent 28k of conversation verbatim and only summarise older turns.
- `compaction.reserveTokens: 8192` — leave 8k of room for the model's reply before triggering compaction.

---

## 6. Install the incremental-codegen skill (soft enforcement)

Local 35B models lose coherence past ~2k output tokens, and they often choose `write` (full file) over `edit` (targeted patch). This skill steers them toward small incremental steps.

Per the Agent Skills spec, the file lives in a directory whose name matches the skill `name`, with the file itself called `SKILL.md`.

```bash
mkdir -p ~/.pi/agent/skills/incremental-codegen
```

**File: `~/.pi/agent/skills/incremental-codegen/SKILL.md`**
````markdown
---
name: incremental-codegen
description: Build or substantially modify any code file by working in small incremental steps — plan, skeleton, then ONE feature per turn — instead of writing the whole file in one large `write` call. Use whenever the user requests a new file, a feature, a UI, or a refactor that would otherwise produce more than ~100 lines of output in a single tool call.
---

# Incremental Code Generation

You are running on a local LLM with limited output coherence. Large single-shot file generations produce truncated/buggy code. Always work in small steps so the user can verify and redirect.

## Hard rules

1. **Never write more than ~100 lines of code in a single `write` or `edit` tool call.** If a file naturally needs more, split it across multiple calls.
2. **Never use `write` to rewrite an existing file.** Use `edit` for changes to anything that already exists on disk.
3. **One feature per turn.** Stop after each feature so the user can verify before continuing.

## The workflow

For any non-trivial code task (new file, new component, multi-section UI, etc.), follow these phases in order:

### Phase 1 — Plan (always first)
- Write a short numbered plan to `_plan.md` in the working directory.
- The plan must list each feature/section as a separate step, in build order.
- After writing the plan, **stop and report it to the user**. Wait for confirmation before continuing.

### Phase 2 — Skeleton
- Write a minimal scaffold of the file with empty/placeholder sections.
- Mark each unfinished section with `<!-- TODO: <feature-name> -->` (or the language's comment syntax).
- The skeleton must be valid syntax (parseable HTML / runnable JS / compilable code) but feature-empty.
- Maximum ~100 lines. **Stop after this turn.**

### Phase 3 — Implement, ONE TODO per turn
- Pick the next `TODO` from `_plan.md`.
- Use `edit` to replace just that section. Do not touch unrelated code.
- After each implementation turn:
  - Briefly confirm what was added (1–2 lines).
  - Mark the step done in `_plan.md`.
  - **Stop and wait for the user.** Do not auto-continue to the next TODO.

### Phase 4 — Validate
- After all TODOs are implemented, run a syntax check (e.g. `node --check`, `python -m py_compile`, or open in browser).
- Report findings. Fix only via small `edit` calls.

## When NOT to use this skill
- Single-line fixes / typo edits
- Reading or explaining code
- File rename, move, or delete
- Any change that fits in <30 lines total

## Failure modes to avoid
- ❌ Writing `index.html` with 800 lines of HTML+CSS+JS in one `write` call.
- ❌ "Just give me the full file" — refuse and propose the skeleton path.
- ❌ Implementing two TODOs in one turn.
- ❌ Continuing past a phase without stopping.

## Recovery
If you realize mid-turn that you're about to violate these rules (e.g. you started writing a huge file), STOP, abandon the current output, and restart with Phase 1 (Plan).
````

> **Important:** the directory name (`incremental-codegen`) must match the `name:` field in the frontmatter, otherwise Pi will warn `name "..." does not match parent directory "skills"`. Don't put the file directly in `~/.pi/agent/skills/`.

Verify the skill loads:
```bash
pi
# inside the TUI:
/skills
```
You should see `incremental-codegen` listed under loaded skills.

---

## 7. Per-project AGENTS.md template

Pi auto-loads `AGENTS.md` (or `CLAUDE.md`) walking up from the working directory. Drop this in any project root that should follow the incremental workflow.

**File: `<your-project>/AGENTS.md`**
```markdown
# Project Rules for Pi (and any agent)

## Workflow — MANDATORY for code generation

You are a local LLM with limited output coherence. **Never produce a full multi-section file in a single tool call.** Always work in small steps.

For any new file, new feature, UI, or refactor, follow this workflow:

1. **Plan** — Write a numbered plan to `_plan.md`. Each item = one feature. STOP and show the user.
2. **Skeleton** — Write a minimal scaffold with `<!-- TODO: name -->` markers for each feature. Max ~100 lines. STOP.
3. **Implement** — One `edit` call per TODO. Do not implement two TODOs in one turn. STOP after each.
4. **Validate** — Run a syntax check at the end.

## Hard limits

- Max **~100 lines of code** in any single `write` or `edit` tool call.
- Use `write` only for new files. Use `edit` for everything else.
- Stop after each phase. Wait for the user before proceeding.

## Style

- Be terse. Prefer doing over explaining.
- Comment only when behavior isn't obvious from the code.
- If the user asks for "the full file", refuse and propose the skeleton path.

## Loaded skill

The global `incremental-codegen` skill defines this workflow in detail. Apply it by default.
```

---

## 8. Install the incremental-guard extension (HARD enforcement)

The skill and AGENTS.md are **suggestions** — the model can still ignore them. This extension makes ignoring them impossible. It hooks Pi's `tool_call` event and physically rejects any `write` or `edit` whose payload exceeds the configured limits, sending an error back to the model that forces it to replan.

### Why an extension and not just `maxTokens`?

`maxTokens` is a guillotine — it cuts the model off mid-output and you get a broken half-file. The extension does **strategic** enforcement: the model's tool call is rejected with a clear message (*"do not retry with the same payload, split the work like this..."*), the model sees the error, replans, and retries with a smaller call. The model still does the splitting; the extension just refuses to let it cheat.

### Setup

```bash
mkdir -p ~/.pi/agent/extensions
```

**File: `~/.pi/agent/extensions/incremental-guard.ts`**
```typescript
// incremental-guard.ts
// Hard-enforces the "small calls" workflow on local LLMs.
// Rejects oversized `write` and `edit` tool calls, forcing the model to
// replan and split the work into multiple smaller calls.
//
// Soft layer (the incremental-codegen skill + AGENTS.md) tells the model HOW
// to split. This extension makes ignoring those rules impossible — when the
// model emits a giant `write` anyway, we block it with a clear error and the
// model has to retry with a smaller call.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// ---------- LIMITS (tune these as needed) ----------
const MAX_LINES_PER_WRITE = 80;       // skeleton scaffold cap
const MAX_LINES_PER_EDIT  = 80;       // single-feature edit cap
const MAX_CHARS_PER_CALL  = 6000;     // ~1500 tokens, regardless of line count

// Files exempt from the cap (config files, lockfiles, etc. that legitimately
// need to be written wholesale). Add more globs here if needed.
const EXEMPT_PATH_PATTERNS = [
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /\.lock$/i,
  /\.svg$/i,        // SVGs are often a single big blob
];

function isExempt(path?: string): boolean {
  if (!path) return false;
  return EXEMPT_PATH_PATTERNS.some((re) => re.test(path));
}

function lineCount(s?: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

function charCount(s?: string): number {
  return s?.length ?? 0;
}

// ---------- EXTENSION ENTRY POINT ----------
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `incremental-guard active (max ${MAX_LINES_PER_WRITE} lines / ${MAX_CHARS_PER_CALL} chars per write/edit)`,
      "info"
    );
  });

  pi.on("tool_call", async (event, _ctx) => {
    // ---------- WRITE ----------
    // Block any `write` call whose `content` exceeds limits.
    // `write` is for new files only — we let the model use it for skeletons,
    // but never for big initial blobs.
    if (event.toolName === "write") {
      const input = event.input as { path?: string; content?: string; file_path?: string };
      const path = input.path ?? input.file_path;
      const content = input.content ?? "";

      if (isExempt(path)) return; // skip cap for lockfiles etc.

      const lines = lineCount(content);
      const chars = charCount(content);

      if (lines > MAX_LINES_PER_WRITE || chars > MAX_CHARS_PER_CALL) {
        return {
          block: true,
          reason:
            `write rejected: ${lines} lines / ${chars} chars exceeds limit ` +
            `(${MAX_LINES_PER_WRITE} lines / ${MAX_CHARS_PER_CALL} chars). ` +
            `Do NOT retry with the same payload. Instead: ` +
            `(1) write a SHORT plan to _plan.md listing each feature as a numbered TODO, ` +
            `(2) write a SKELETON file with empty <!-- TODO: name --> markers (under ${MAX_LINES_PER_WRITE} lines), ` +
            `(3) implement ONE TODO per turn using the 'edit' tool. ` +
            `Stop after each step and wait for the user.`,
        };
      }
    }

    // ---------- EDIT ----------
    // Block any `edit` whose new_string exceeds limits, and also any edit
    // that effectively rewrites the file (huge old_string → huge new_string).
    if (event.toolName === "edit") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        old_string?: string;
        new_string?: string;
      };
      const path = input.path ?? input.file_path;
      const oldS = input.old_string ?? "";
      const newS = input.new_string ?? "";

      if (isExempt(path)) return;

      const newLines = lineCount(newS);
      const newChars = charCount(newS);

      if (newLines > MAX_LINES_PER_EDIT || newChars > MAX_CHARS_PER_CALL) {
        return {
          block: true,
          reason:
            `edit rejected: replacement is ${newLines} lines / ${newChars} chars ` +
            `(limit ${MAX_LINES_PER_EDIT} lines / ${MAX_CHARS_PER_CALL} chars). ` +
            `Do NOT retry with the same payload. Split this change into multiple ` +
            `smaller 'edit' calls — one feature/section per call. ` +
            `If you're tempted to rewrite a whole file, you're doing it wrong: ` +
            `make a list of the discrete changes, then apply them one at a time.`,
        };
      }

      // Catch the "rewrite the entire file via edit" trick (e.g., old_string
      // is the whole file, new_string is the whole file).
      const oldLines = lineCount(oldS);
      if (oldLines > MAX_LINES_PER_EDIT * 2) {
        return {
          block: true,
          reason:
            `edit rejected: old_string is ${oldLines} lines, which suggests you're ` +
            `replacing a huge region (likely the whole file). ` +
            `Use targeted edits: pick the smallest unique snippet that identifies ` +
            `the section to change, and replace only that. ` +
            `Multiple small edits beat one big one.`,
        };
      }
    }
  });

  // Optional: register a /guard command to inspect/disable at runtime.
  pi.registerCommand("guard", {
    description: "Show or toggle incremental-guard limits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `incremental-guard: write ≤ ${MAX_LINES_PER_WRITE} lines, ` +
          `edit ≤ ${MAX_LINES_PER_EDIT} lines, both ≤ ${MAX_CHARS_PER_CALL} chars. ` +
          `Edit ~/.pi/agent/extensions/incremental-guard.ts to change.`,
        "info"
      );
    },
  });
}
```

### What it enforces

| Check | Limit | If exceeded |
|---|---|---|
| `write` content lines | 80 | Reject with replan instructions |
| `write` content chars | 6000 | Reject with replan instructions |
| `edit` new_string lines | 80 | Reject, model must split into multiple edits |
| `edit` new_string chars | 6000 | Reject, model must split |
| `edit` old_string lines | 160 | Reject ("you're rewriting the whole file via edit") |

When blocked, the model receives this error as the tool result:

> *"write rejected: 312 lines / 14820 chars exceeds limit (100 lines / 6000 chars). Do NOT retry with the same payload. Instead: (1) write a SHORT plan to _plan.md… (2) write a SKELETON file with empty `<!-- TODO: name -->` markers… (3) implement ONE TODO per turn using the 'edit' tool."*

The model's training to handle errors kicks in, it parses the message, and retries with a smaller call. **There is no way to win by ignoring the rule.**

### Tuning

Edit `~/.pi/agent/extensions/incremental-guard.ts`:
- `MAX_LINES_PER_WRITE` / `MAX_LINES_PER_EDIT` — bump up if 80 is too tight for your style
- `MAX_CHARS_PER_CALL` — for very dense code (minified, no whitespace), the char limit kicks in first
- `EXEMPT_PATH_PATTERNS` — add file types that should bypass the guard (e.g. `/\.json$/i` for config files you want written wholesale)

After editing, run `/reload` inside Pi (no need to quit).

### Inspecting

Inside Pi:
```
/guard
```
Notifies the current limits and where to edit them.

### Disabling temporarily

Run Pi with `--no-extensions`:
```bash
pi --no-extensions
```
Or rename the file out of the extensions directory.

---

## 9. Install the thinking-guard extension (HARD: reasoning length)

Local 35B models can spiral into multi-thousand token reasoning loops. This extension intercepts the thinking stream and injects a correction when the thinking block exceeds the limit.

**File: `~/.pi/agent/extensions/thinking-guard.ts`**

```bash
cp $(pwd)/extensions/thinking-guard.ts ~/.pi/agent/extensions/
```

### What it enforces

| Check | Limit | Action |
|---|---|---|
| Thinking block chars | 2000 | Warn at 80%, inject correction steering at 100% |
| Thinking block lines | 60 | Same |

The correction message tells the model to write its conclusion to `.think/_state.md` and keep the next response under 100 words.

### Tuning

Edit `~/.pi/agent/extensions/thinking-guard.ts`:
- `MAX_THINKING_CHARS` — default 2000, raise if your model needs more thinking room
- `MAX_THINKING_LINES` — default 60

### Inspecting

```
/thinking-guard
```

---

## 10. Install the context-monitor extension (HARD: context fill)

Context quality degrades before the window fills. This extension watches token usage after every turn and steers the model to write full state to `.think/` files before coherence drops.

**File: `~/.pi/agent/extensions/context-monitor.ts`**

```bash
cp $(pwd)/extensions/context-monitor.ts ~/.pi/agent/extensions/
```

### What it enforces

| Threshold | Action |
|---|---|
| 65% context used | Steering message: write `_state.md` and `_summary.md` now |
| 80% context used | Urgent steering: stop work, write full state, tell user to restart session |

Fires once per threshold. Resets if context drops (e.g. after compaction or `/clear`).

### Why this matters

The 35B model loses coherence before the context window fills — especially with 4-bit KV cache quantization. Triggering at 65% means the model writes state while it's still accurate, not after it's already fuzzy.

### Tuning

Edit `~/.pi/agent/extensions/context-monitor.ts`:
- `WARN_PERCENT` — default 65
- `URGENT_PERCENT` — default 80

### Inspecting

```
/context-monitor
```
Shows live token count and window size.

---

## 11. Install the analysis-guard extension (HARD: lost analysis)

When the model gives a long analysis response without writing to disk, that analysis is lost as context fills. This extension detects long text responses with no file write and forces a step file write.

**File: `~/.pi/agent/extensions/analysis-guard.ts`**

```bash
cp $(pwd)/extensions/analysis-guard.ts ~/.pi/agent/extensions/
```

### What it enforces

| Check | Trigger | Action |
|---|---|---|
| Response > 1000 chars AND no write/edit call | Every turn | Inject steering to write `.think/step-NNN.md` |

> **Note:** The threshold was raised from 500 → 1000 after benchmarking showed false positives on short completion summaries (e.g. "Done! Created file X with features Y, Z"). 500 was too sensitive for coding tasks where the model naturally writes a brief summary at the end.

### Tuning

Edit `~/.pi/agent/extensions/analysis-guard.ts`:
- `MIN_ANALYSIS_CHARS` — default 1000, lower to 500 if you want to catch shorter responses too

### Inspecting

```
/analysis-guard
```

---

## 12. Install the distill extension (codebase knowledge base)

`/distill` crawls a directory, builds an import graph, and injects a structured distillation workflow into Pi. The model then reads and summarizes files one per turn, building a `.think/distill/` knowledge base that the next session can reference without holding the full codebase in context.

**File: `~/.pi/agent/extensions/distill.ts`**

```bash
cp $(pwd)/extensions/distill.ts ~/.pi/agent/extensions/
```

### Smart ordering pipeline

When you run `/distill [path]`, the extension:

1. **Crawls** the directory (respects `node_modules`, `dist`, `.git` etc. skip list)
2. **Parses imports** — regex-extracts all relative `import`/`require`/`from` statements
3. **Builds a dependency graph** and topologically sorts: dependencies come before the files that use them
4. **Entry points first** — `index.ts`, `main.py`, `app.js`, `server.ts`, `__init__.py` etc. are always at the top
5. **Clusters similar files** — `*.controller.ts`, `*.service.ts`, `*.model.ts`, `*.test.ts` etc. grouped (up to 3 per turn)
6. **Batches small files** — files under 30 lines batched up to 5 per turn with one shared summary file
7. **Writes manifest** to `.think/distill/manifest.md` with turn-by-turn checklist
8. **Injects workflow** as a steering message — model reads manifest, processes one turn, marks `[✓]`, stops

### Output structure

```
.think/distill/
├── manifest.md           ← checklist of all turns, with labels (entry point, cluster: services, etc.)
├── files/                ← one .md per turn (single file or batch)
├── modules/              ← directory-level summaries (Phase 2)
├── architecture.md       ← system overview, entry points, data flow (Phase 3)
└── index.md              ← lookup table: "to understand X, read Y" (Phase 3)
```

### Usage

```
/distill src/             # crawl src/ directory
/distill .                # crawl current working directory
/distill path/to/module   # crawl a specific subdirectory
/distill --resume         # continue an interrupted distillation
```

### What `--resume` does

Reads `.think/distill/manifest.md`, counts `[✓]` vs `[ ]` entries, and re-injects the workflow message telling the model to pick up from the first unchecked entry. Use this when a session ends mid-distillation.

### How incremental-guard interacts with distill

The `incremental-guard` extension naturally enforces one-file-per-turn for distill too — if the model tries to write a large summary file in one shot, it gets blocked and must split. This means the three-phase distillation (file summaries → module summaries → architecture) works well even on large codebases.

### File size limits

Files over 80KB are skipped (likely generated). Files over ~150 lines are processed in a single turn — large enough to be meaningful on a local 35B model. Chunking for very large files can be added later if needed.

### Supported file types

`.js .ts .tsx .jsx .mjs .cjs .py .go .rs .java .rb .php .cs .cpp .c .css .scss .sass .less .html .vue .svelte .sql .md`

Skipped: `.min.js`, `.bundle.js`, `.d.ts`, `.lock`, `.map`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

---

## 13. Install first-prompt extension (planning injection)

`first-prompt.ts` appends a planning instruction to the very first user prompt of a session — programmatically, with zero context overhead. No steer message, no LLM call — just a text append before the prompt reaches the model.

**Appended text:**
```
Plan the implementation in numbered steps. Implement ONE step at a time .
```

**File: `~/.pi/agent/extensions/first-prompt.ts`**

```bash
cp $(pwd)/extensions/first-prompt.ts ~/.pi/agent/extensions/
```

### Behavior

- Fires **once per session** on the very first `input` event — a `fired` flag prevents any effect on subsequent prompts
- Enabled by default — disable with `/piforge disable first-prompt` if you want raw prompts
- No model decision involved — pure programmatic text append

### Why it helps

Local 35B models often start implementation immediately without planning. Appending the planning instruction to the first prompt (rather than a system prompt) ensures it arrives with full attention weight at the moment the model is deciding what to do. Costs nothing — doesn't add a message, doesn't consume a turn.

---

## 14. Install knowledge-injector extension (inference-time context)

`knowledge-injector.ts` loads tech-specific knowledge files from `./knowledge/` (project-local) at the start of each session — without polluting the context with selection reasoning.

**How it works:**

```
user prompt → distill large files (cached) → select per-file → inject content → Pi's main LLM call
```

Uses **pi subprocess calls** with `--thinking off` for clean output from thinking models:

1. **Distillation**: Large files (>2000 chars) are summarized to ~100 words. Cached in `.distilled/` with hash-based invalidation — only re-distills when source file changes.
2. **Selection**: Each file is evaluated independently ("Is this file relevant to the purpose?"). Per-file evaluation is more accurate than batch selection.

**File: `~/.pi/agent/extensions/knowledge-injector.ts`**

```bash
cp $(pwd)/extensions/knowledge-injector.ts ~/.pi/agent/extensions/
```

### Knowledge folder setup

Knowledge is **project-local**. Each project has its own `knowledge/` folder:

```bash
cp -r $(pwd)/knowledge/ <your-project>/knowledge/
```

```
<your-project>/knowledge/
├── svelte5-gotchas.md
├── drag-and-drop-gotchas.md
├── canvas-node-editor-gotchas.md
├── ...
└── .distilled/                    ← auto-generated summaries for large files
    └── canvas-node-editor-gotchas.md
```

`piforge-self.md` is installed globally to `~/.pi/piforge-self.md` (loaded via `/guide`).

### Writing knowledge files

- **Name by tech keyword** — `drag-and-drop-gotchas.md` matches tasks involving drag-and-drop
- **Failures only** — common mistakes, gotchas, non-obvious behavior. Not tutorials.
- **Small files (<500 tokens)** — full content sent to selection LLM for maximum signal
- **Large files (>500 tokens)** — auto-distilled to `.distilled/` subfolder, summary used for selection
- **One tech per file** — LLM selects by relevance; mixing techs reduces precision

### Code-write gate

Until `.think/_knowledge.md` is created, `write`/`edit` tool calls are blocked. This forces the model to acknowledge it processed the injected knowledge before writing code. Create `.think/_knowledge.md` with a brief note about what was loaded.

### Toggle

Disabled by default. Enable per session when working with a tech that has knowledge files:

```
/piforge enable knowledge-injector
```

Then `/reload` to apply, or start a new Pi session.

### Compaction survival

When context gets compacted, the injected knowledge is lost from conversation history. But the manifest (`.think/_knowledge-manifest.md`) survives on disk. On `session_compact`, the extension:

1. Reads the manifest (list of active knowledge filenames)
2. Rebuilds `.think/_knowledge.md` from the source files in `./knowledge/`
3. Re-injects the full content as a steer

This is fully programmatic — zero LLM cost. The model gets its knowledge back automatically after every compaction.

### `/forget` command

Remove a knowledge file from the active set mid-session:

```
/forget playwright-testing    — removes from manifest, steers model
/forget                       — shows currently active knowledge
```

### `/guide` command

Load PiForge's self-documentation into context on demand:

```
/guide    — injects piforge-self.md as a steer, replies "PiForge guide loaded — what do you want to know?"
```

The guide file (`piforge-self.md`) lives at `~/.pi/piforge-self.md` (global, not in project knowledge). `/guide` is explicit on-demand loading — it's never auto-selected by the knowledge-injector.

---

## 15. Install plan-clarify extension (clarifying questions)

`plan-clarify.ts` intercepts `_plan.md` writes and forces the model to ask the user up to 3 clarifying questions before writing any code. Prevents 10-turn builds of the wrong thing because the model silently assumed wrong answers.

**File: `~/.pi/agent/extensions/plan-clarify.ts`**

```bash
cp $(pwd)/extensions/plan-clarify.ts ~/.pi/agent/extensions/
```

### Flow

```
Model writes _plan.md
→ extension detects the write (tool_call event)
→ at turn_end: injects steering message
→ model re-reads plan, identifies assumptions, asks ≤ 3 questions
→ user answers
→ model proceeds to skeleton with correct assumptions
```

### Question format enforced

```
Before I start building, a few quick questions:

1. [question]
   1) [option A]
   2) [option B]
   3) [option C]
   4) Other (type your answer)

2. [question]
   ...

→ Reply with numbers (e.g. "1, 2, 1") or write your own answer.
```

Rules injected: max 3 questions, 2–4 options each, always include "Other", plain language, stop before coding.

### Toggle

Disabled by default. Enable when building something where wrong assumptions are expensive:

```
/piforge enable plan-clarify
```

Then `/reload` or start fresh session. Adds one turn of latency per planning phase.

---

## 16. Install piforge-manager extension (toggle system)

`piforge-manager.ts` provides the `/piforge` command for listing and toggling extensions. It reads/writes `~/.pi/piforge.json`.

**File: `~/.pi/agent/extensions/piforge-manager.ts`**

```bash
cp $(pwd)/extensions/piforge-manager.ts ~/.pi/agent/extensions/
```

### Config file

```bash
# Create ~/.pi/piforge.json (plan-clarify + loop-guard disabled by default)
cat > ~/.pi/piforge.json << 'EOF'
{
  "disabled": ["knowledge-injector", "plan-clarify"]
}
EOF
```

Or copy from PiForge:

```bash
cp $(pwd)/config/piforge.json ~/.pi/piforge.json
```

### Commands

```
/piforge                        — show all toggleable extensions + current status
/piforge enable knowledge-injector   — enable for this session
/piforge disable first-prompt        — disable for this session
```

Changes take effect next session, or immediately after `/reload`.

### Toggleable extensions

| Extension | Default | When to enable |
|---|---|---|
| `first-prompt` | on | Always — disable only for raw testing |
| `knowledge-injector` | **on** | Auto-selects relevant `./knowledge/` files per task |
| `plan-clarify` | off | When wrong assumptions would be expensive to fix later |

### Session-start notification

If any extensions are disabled, piforge-manager notifies on startup:
```
piforge: disabled → knowledge-injector, plan-clarify (use /piforge to manage)
```

---

## 17. Install session-manager extension (per-tab `.think/` isolation)

Every new Pi terminal gets its own `.think/` directory automatically. The model always writes to `.think/` — same hardcoded path, zero overhead. A symlink swaps what `.think/` points to behind the scenes.

**File: `~/.pi/agent/extensions/session-manager.ts`**

```bash
cp $(pwd)/extensions/session-manager.ts ~/.pi/agent/extensions/
```

### How it works

On every `session_start`:
1. Creates `.think-sessions/session-NNN/` (incrementing number)
2. Points the `.think/` symlink to that directory
3. The model writes to `.think/` as always — completely transparent

```
.think-sessions/
  sessions.json             ← index of all sessions
  session-001/              ← first Pi tab
    _state.md, _plan.md, step-001.md ...
  session-002/              ← second Pi tab
    _state.md, _plan.md, step-001.md ...
.think/ → .think-sessions/session-002/   ← symlink to active session
```

### First-time migration

If `.think/` already exists as a real directory (from before this extension was installed), it gets moved to `.think-sessions/session-001/` automatically. No data loss.

### Commands

```
/sessions                   — list all sessions with task name + last-active date
/switch-session                     — same list, with instructions to pick one
/switch-session session-003         — switch .think/ symlink to that session, inject steer to read _state.md
```

### .gitignore

The extension auto-appends `.think/` and `.think-sessions/` to `.gitignore` on first run.

---

## 18. Install loop-guard extension (repetition loop + malformed call detection)

`loop-guard.ts` detects two failure patterns: (1) writing the same file with identical content repeatedly (Jaccard similarity), and (2) consecutive malformed tool calls with empty/missing arguments. Zero inference cost — pure string math.

**File: `~/.pi/agent/extensions/loop-guard.ts`**
```bash
cp $(pwd)/extensions/loop-guard.ts ~/.pi/agent/extensions/
```

**Default: disabled** — the primary defense against loops is proper LM Studio inference settings (repeat penalty 1.1, temperature 0.58). This extension is a safety net for when settings are missing or insufficient. Enable with `/piforge enable loop-guard`.

### How it works — write loops

Tracks write/edit tool calls per file path. Each write's content is tokenized into a lowercase word set. Jaccard similarity (intersection/union of word sets) is computed against previous writes to the **same file** in a sliding window of 10.

Writing different files with similar content (e.g., `LeftArm.cs` / `RightArm.cs`) is never flagged — only repeated writes to the same path.

### How it works — malformed tool calls

Checks every tool call for missing or empty required arguments: bash without `command`, write without `content`/`path`, edit without `old_string`/`new_string`, read without `path`. Consecutive malformed calls increment a counter. Any valid call resets it.

Q2 models sometimes can't format tool call JSON correctly — especially for bash commands with complex paths (spaces, quotes). The model emits `{}` or omits required fields, the call fails, the failure stays in context, and the model retries the same broken call. Each failure makes the next attempt worse. Compaction clears that poisoned history.

### Write loop escalation

| Tier | Trigger | Action |
|---|---|---|
| **Warn** | 4 writes to same file with >85% Jaccard | Steer: "you may be looping, make next action different" |
| **Block** | 6 writes to same file with >85% Jaccard | `blockToolCall` + specific escape hint |
| **Compact** | 3 blocked attempts | Abort → compact (summarize real progress, ignore loop turns) → restart from `_state.md` |
| **Nuclear** | Loops again after compact | Abort → double compact (crush context to one sentence) → restart |
| **Give up** | Loops after nuclear | Notify user: "type `/clear` then read `_state.md`" |

### Malformed call escalation

| Tier | Trigger | Action |
|---|---|---|
| **Warn** | 4 consecutive malformed calls | Steer: "calls are failing — use write/edit instead of bash, simplify paths" |
| **Compact** | 8 consecutive malformed calls | Abort → compact (clear poisoned context of failed attempts) → restart |
| **Nuclear+** | Still failing after compact | Same escalation as write loops (double compact → tell user to `/clear`) |

### Jaccard similarity

```
Text A words: {deleted, old, files, need, recreate, macro}
Text B words: {deleted, old, files, need, recreate, macro}
Jaccard = intersection / union = 6/6 = 1.0 (identical → loop)

Text A: {deleted, old, files, need, recreate}
Text B: {torsosection, done, writing, leftarm, next}
Jaccard = 0/10 = 0.0 (completely different → real progress)
```

### Why this exists

Without proper repeat penalty settings, local models (especially at Q2 quantization) fall into repetition loops — writing `_state.md` with identical content 20+ times, burning through context doing nothing. They also emit malformed tool calls when JSON formatting exceeds their precision (paths with spaces, complex escaping). Both patterns poison context — the model sees its own failures and fixates on them. This guard detects the symptoms and auto-recovers via compaction, which clears the poisoned history.

---

## 19. LM Studio inference settings

These settings apply per-request (no model reload needed). Change them in LM Studio's Inference tab.

| Setting | Recommended | Why |
|---|---|---|
| `max_tokens` | 800–1000 | Hard caps chat response length — prevents reasoning spirals that slip past thinking-guard |
| `repetition_penalty` | 1.1 | Mild reduction of token-level loops |
| `temperature` | 0.4 | Focused output without being robotic |

> **Note:** `max_tokens` is a guillotine (truncates mid-output). The extensions are smarter — they reject and redirect. Use `max_tokens` as a last-resort backstop, not primary enforcement.

---

## 20. First run + verification

1. Start LM Studio's server and load `qwen3.6-35b-a3b`.
2. From any project directory:
   ```bash
   cd /path/to/project
   pi
   ```
3. Pi should boot with:
   - Provider: `lmstudio`
   - Model: `qwen3.6-35b-a3b`
   - Skills: `incremental-codegen`
   - Context: your `AGENTS.md` (loaded automatically if present in project dir)
   - Extension notifications (all four):
     ```
     incremental-guard active (max 100 lines / 6000 chars per write/edit)
     thinking-guard active (max 2000 chars / 60 lines of thinking per turn)
     context-monitor active — warn at 65%, urgent at 80% (window: XXXXX tokens)
     analysis-guard active (triggers on responses >1000 chars with no file write)
     ```
4. Inside Pi, run:
   ```
   /skills
   /guard
   /thinking-guard
   /context-monitor
   /analysis-guard
   /usage
   ```
   Confirm all four guards are active and turn-1 token usage is small (~1.5k–3k, not 15k+).

Expected behaviour on a "build me a Web-OS desktop in index.html" prompt:
- Turn 1: writes `_plan.md`, stops.
- Turn 2 (after "go"): writes a skeleton `index.html` with `<!-- TODO -->` markers, stops.
- Turn 3+: one `edit` call per TODO.
- If the model attempts a big `write`, the guard rejects it, you see the rejection in the TUI, and the model replans.

### Known issues (fixed)

| Bug | Symptom | Fix |
|---|---|---|
| `ctx.sendMessage is not a function` | `thinking-guard`, `context-monitor`, `analysis-guard` crash on steering injection | `sendMessage` lives on `pi` (ExtensionAPI), not `ctx` (ExtensionContext). All three extensions updated to use `pi.sendMessage(...)` |

All extension files in `piforge/extensions/` reflect the fix.

### Benchmark results

Three real-world prompts tested after full stack was operational:

**1. Analysis — Node.js 200 OK empty body bug**
- Model read `_state.md` first ✓
- Gave detailed ranked analysis ✓
- `analysis-guard` fired (response > 1000 chars, no file write) ✓
- Model wrote `step-001.md` in response to steering ✓

**2. Analysis + code — Checkout race condition**
- Model tried to write a 127-line / 6284-char step file → `incremental-guard` blocked it ✓
- Model split into `_plan.md` + condensed `step-001.md` ✓
- `analysis-guard` fired on final summary → model wrote `step-002.md` ✓

**3. UI creation — Pomodoro timer (pomodoro.html)**
- Model tried to write 361-line / 12124-char file in one shot → `incremental-guard` blocked it ✓
- Model wrote `_plan.md`, skeleton HTML, then filled sections incrementally ✓
- Final output: beautiful, fully functional timer with dark mode, SVG ring, Web Audio API ✓
- `analysis-guard` false-positive on completion summary → threshold raised 500 → 1000 ✓

---

## 21. Useful slash commands inside Pi

| Command | What it does |
|---|---|
| `/login` | Add API keys / OAuth for cloud providers |
| `/model` | Switch between models on the fly (reloads `models.json`) |
| `/skills` | List loaded skills |
| `/skill:incremental-codegen` | Force-activate the skill for the current task |
| `/guard` | Show incremental-guard limits (write/edit size) |
| `/thinking-guard` | Show thinking-guard limits (reasoning length) |
| `/context-monitor` | Show live context token usage and thresholds |
| `/analysis-guard` | Show analysis-guard config (response length threshold) |
| `/distill [path]` | Crawl a codebase and build `.think/distill/` knowledge base |
| `/distill --resume` | Resume an interrupted distillation from the last unchecked entry |
| `/piforge` | Show all toggleable extensions + enabled/disabled status |
| `/piforge enable <name>` | Enable an extension (takes effect next session or after `/reload`) |
| `/piforge disable <name>` | Disable an extension |
| `/sessions` | List all `.think/` sessions with task + last-active date |
| `/switch-session` | List sessions and pick one to resume |
| `/switch-session <id>` | Switch `.think/` to that session and inject steer to read `_state.md` |
| `/forget <name>` | Remove a knowledge file from active set (e.g., `/forget playwright-testing`) |
| `/forget` | List currently active knowledge files |
| `/guide` | Load PiForge self-documentation into context on demand |
| `/important "note"` | Add persistent note — steered immediately, saved to `_purpose.md`, survives compaction |
| `/important -compact "note"` | Same + forces compaction after (cleans context, note is safe on disk) |
| `/important` | List active important notes |
| `/important clear` | Remove all important notes from `_purpose.md` |
| `/q "message"` | Queue work for after Pi finishes current task |
| `/q` | Show queued messages |
| `/q clear` | Clear the queue |
| `/reload` | Hot-reload extensions / skills / settings (no need to quit) |
| `/usage` | Show tokens per turn — verify calls stay small |
| `/tree` | Show full event tree (tool calls, thinking, results) |
| `/settings` | Edit a subset of settings without leaving Pi |
| `/clear` | Reset session (keeps Pi running) |
| `/exit` | Quit Pi |
| `Ctrl+O` | Show the full startup banner (loaded resources) |
| `Ctrl+P` | Cycle through models (configure with `--models` or `models` setting) |

CLI flags worth knowing:
```bash
pi --no-context-files          # ignore AGENTS.md / CLAUDE.md auto-loading
pi --no-skills                 # disable skills for this session
pi --no-extensions             # disable the guard (and any other extension)
pi --thinking high             # bump reasoning depth
pi -p "your prompt"            # one-shot, non-interactive
pi @file1.md @file2.html "..." # attach files to the initial message
pi --continue                  # resume the last session
```

---

## 22. Troubleshooting

**`No models available`**
LM Studio server isn't running, or `models.json` `id` doesn't match the model id from `curl /v1/models`. Check both.

**`name "X" does not match parent directory "skills"`**
The skill is a flat `.md` file. Move it into a subdirectory whose name matches the `name:` frontmatter field, and rename the file to `SKILL.md`.

**Model still rawdogs the whole file in one `write` call**
This shouldn't happen with the guard installed. If it does:
1. Confirm the guard is loaded: `/guard` should display the limits
2. Check `~/.pi/agent/extensions/incremental-guard.ts` is present
3. Look for TypeScript errors at startup (Pi prints them)
4. Try `pi --extension ~/.pi/agent/extensions/incremental-guard.ts` to force-load it

**Guard rejects legitimate calls** (e.g. a real config file that's intentionally large)
Add the file's path pattern to `EXEMPT_PATH_PATTERNS` in the extension, then `/reload`.

**Tool calls fail / model retries with garbage**
LM Studio's chat template might be mis-configured for tool calling. In LM Studio: Model → Settings → Prompt Template — ensure the template includes the model's tool-call format (Qwen3 uses Hermes-style `<tool_call>...</tool_call>`).

**Pi doesn't see updates to `models.json` / `settings.json`**
Most settings are picked up live. For a clean reload, just exit Pi and run `pi` again, or use `/reload` inside Pi.

**Context still fills up too fast**
Lower `compaction.keepRecentTokens` to e.g. 16000, or run `/clear` between unrelated tasks.

**Guard rejection loops indefinitely (model keeps trying same big call)**
The reason text isn't being interpreted. Two possible fixes:
1. Make the rejection message more directive (it's already pretty explicit)
2. Switch to `qwen3-coder-30b-a3b-instruct` which handles tool errors better than the general 35b
3. Manually `/clear` and restart with a more constrained initial prompt

---

## 23. Replication checklist

On a fresh machine, in order:

- [ ] Node ≥ 20, npm ≥ 10 installed
- [ ] LM Studio installed, model downloaded, server running on `:1234`
- [ ] `npm install -g @mariozechner/pi-coding-agent`
- [ ] `~/.npm-global/bin` on PATH (`pi --version` works)
- [ ] `~/.pi/agent/models.json` created (provider + models)
- [ ] `~/.pi/agent/settings.json` created (defaults + compaction)
- [ ] `~/.pi/agent/skills/incremental-codegen/SKILL.md` created
- [ ] `~/.pi/agent/extensions/incremental-guard.ts` created
- [ ] `~/.pi/agent/extensions/thinking-guard.ts` created
- [ ] `~/.pi/agent/extensions/context-monitor.ts` created
- [ ] `~/.pi/agent/extensions/analysis-guard.ts` created
- [ ] `~/.pi/agent/extensions/distill.ts` created
- [ ] `~/.pi/agent/extensions/first-prompt.ts` created
- [ ] `~/.pi/agent/extensions/knowledge-injector.ts` created
- [ ] `~/.pi/agent/extensions/plan-clarify.ts` created
- [ ] `~/.pi/agent/extensions/piforge-manager.ts` created
- [ ] `~/.pi/agent/extensions/session-manager.ts` created
- [ ] `~/.pi/agent/extensions/loop-guard.ts` created
- [ ] `~/.pi/agent/extensions/queue.ts` created
- [ ] `~/.pi/piforge.json` created (`{ "disabled": ["plan-clarify", "explore", "distill-awareness", "loop-guard"] }`)
- [ ] `~/.pi/piforge-self.md` installed (PiForge guide for `/guide` command)
- [ ] Project `knowledge/` folder created with relevant gotchas files
- [ ] `pi --list-models` shows the LM Studio models
- [ ] `pi` boots with all extension notifications (7 active + disabled list)
- [ ] No skill warnings, no extension errors
- [ ] `/skills`, `/guard`, `/thinking-guard`, `/context-monitor`, `/analysis-guard`, `/piforge` all respond
- [ ] LM Studio inference: `max_tokens` ≤ 1000, `repetition_penalty` 1.1, `temperature` 0.4
- [ ] Drop `AGENTS.md` into each project that should follow the workflow

That's the whole setup. No shell-level env vars, no proxies — just these files in `~/.pi/` plus an `AGENTS.md` per project:

```
~/.pi/
├── piforge.json                        ← extension toggles
├── knowledge/
│   ├── svelte5-gotchas.md
│   ├── astro-gotchas.md
│   ├── playwright-testing.md
│   ├── drag-and-drop-gotchas.md
│   └── canvas-node-editor-gotchas.md
└── agent/
    ├── models.json
    ├── settings.json
    ├── skills/
    │   └── incremental-codegen/
    │       └── SKILL.md
    └── extensions/
        ├── incremental-guard.ts        ← blocks oversized write/edit calls
        ├── thinking-guard.ts           ← stops reasoning spirals
        ├── context-monitor.ts          ← warns before context degrades
        ├── analysis-guard.ts           ← forces analysis to be written to disk
        ├── distill.ts                  ← /distill codebase knowledge-base builder
        ├── first-prompt.ts             ← injects planning instruction into first prompt
        ├── knowledge-injector.ts       ← pi subprocess selects project-local knowledge files
        ├── plan-clarify.ts             ← asks clarifying questions after _plan.md (off by default)
        ├── piforge-manager.ts          ← /piforge toggle command
        ├── session-manager.ts          ← per-tab .think/ isolation via symlinks
        ├── loop-guard.ts               ← repetition loop + malformed call detection (off by default)
        └── queue.ts                    ← /q post-completion task queue
```

All extension source files live in `piforge/extensions/`. To update an extension: edit the file there, then copy it to `~/.pi/agent/extensions/` and run `/reload` inside Pi. Or re-run `bash install.sh` to reinstall everything.

---

## Appendix A — Full settings reference

Source of truth: `~/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/settings.md`.

Locations:
- `~/.pi/agent/settings.json` — global (all projects)
- `<project>/.pi/settings.json` — project (overrides global; nested objects merge, they don't replace)

### Model & Thinking
| Setting | Default | Description |
|---|---|---|
| `defaultProvider` | — | provider name (`anthropic`, `openai`, `lmstudio`…) |
| `defaultModel` | — | model id |
| `defaultThinkingLevel` | — | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `hideThinkingBlock` | `false` | hide thinking blocks in output |
| `thinkingBudgets` | — | per-level token budgets (object: `{minimal, low, medium, high}` → number) |

### UI & Display
| Setting | Default | Description |
|---|---|---|
| `theme` | `"dark"` | `dark` / `light` / custom name |
| `quietStartup` | `false` | hide startup banner |
| `collapseChangelog` | `false` | condense changelog after updates |
| `enableInstallTelemetry` | `true` | anonymous install/update version ping |
| `doubleEscapeAction` | `"tree"` | what double-Esc does: `tree` / `fork` / `none` |
| `treeFilterMode` | `"default"` | `/tree` filter: `default` / `no-tools` / `user-only` / `labeled-only` / `all` |
| `editorPaddingX` | `0` | horizontal padding for input editor (0–3) |
| `autocompleteMaxVisible` | `5` | autocomplete dropdown size (3–20) |
| `showHardwareCursor` | `false` | terminal cursor visible |

### Compaction
| Setting | Default | Description |
|---|---|---|
| `compaction.enabled` | `true` | enable auto-compaction |
| `compaction.reserveTokens` | `16384` | tokens reserved for LLM response before triggering |
| `compaction.keepRecentTokens` | `20000` | recent tokens kept verbatim (not summarised) |

### Branch Summary
| Setting | Default | Description |
|---|---|---|
| `branchSummary.reserveTokens` | `16384` | tokens reserved for branch summarisation |
| `branchSummary.skipPrompt` | `false` | skip "Summarize branch?" prompt on `/tree` navigation |

### Retry
| Setting | Default | Description |
|---|---|---|
| `retry.enabled` | `true` | agent-level retry on transient errors |
| `retry.maxRetries` | `3` | max agent-level retry attempts |
| `retry.baseDelayMs` | `2000` | base delay for exponential backoff (2s → 4s → 8s) |
| `retry.provider.timeoutMs` | SDK default | provider/SDK request timeout (ms) |
| `retry.provider.maxRetries` | SDK default | provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | `60000` | max server-requested delay before failing (`0` disables cap) |

### Warnings
| Setting | Default | Description |
|---|---|---|
| `warnings.anthropicExtraUsage` | `true` | warn when Anthropic subscription auth may use paid extra usage |

### Message Delivery
| Setting | Default | Description |
|---|---|---|
| `steeringMode` | `"one-at-a-time"` | how steering messages are sent: `all` or `one-at-a-time` |
| `followUpMode` | `"one-at-a-time"` | how follow-up messages are sent: `all` or `one-at-a-time` |
| `transport` | `"sse"` | preferred provider transport: `sse` / `websocket` / `auto` |

### Terminal & Images
| Setting | Default | Description |
|---|---|---|
| `terminal.showImages` | `true` | show images in terminal (if supported) |
| `terminal.imageWidthCells` | `60` | preferred inline image width in cells |
| `terminal.clearOnShrink` | `false` | clear empty rows when content shrinks (can flicker) |
| `images.autoResize` | `true` | resize images to 2000×2000 max |
| `images.blockImages` | `false` | block all images from being sent to LLM |

### Shell
| Setting | Description |
|---|---|
| `shellPath` | custom shell path (e.g. Cygwin on Windows) |
| `shellCommandPrefix` | prefix every bash command (e.g. `"shopt -s expand_aliases"`) |
| `npmCommand` | argv for npm operations, e.g. `["mise","exec","node@20","--","npm"]` |

### Sessions & Markdown
| Setting | Default | Description |
|---|---|---|
| `sessionDir` | — | session file storage (relative, absolute, or `~`) |
| `enabledModels` | — | model patterns for Ctrl+P cycling, e.g. `["claude-*","gpt-4o"]` |
| `markdown.codeBlockIndent` | `"  "` | indent for rendered code blocks |

### Resources (where pi loads extensions, skills, prompts, themes from)

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported. Arrays support glob patterns; `!pattern` excludes, `+path` force-includes, `-path` force-excludes.

| Setting | Default | Description |
|---|---|---|
| `packages` | `[]` | npm/git packages to load resources from |
| `extensions` | `[]` | local extension file paths or directories |
| `skills` | `[]` | local skill file paths or directories |
| `prompts` | `[]` | local prompt template paths or directories |
| `themes` | `[]` | local theme file paths or directories |
| `enableSkillCommands` | `true` | register skills as `/skill:name` commands |

### Environment variables that affect startup

| Variable | Effect |
|---|---|
| `PI_OFFLINE=1` (or `--offline`) | disable all startup network operations (update checks, install telemetry) |
| `PI_SKIP_VERSION_CHECK=1` | disable the version update check only |
| `PI_CODING_AGENT_SESSION_DIR` | session storage dir; loses to `--session-dir`, beats `sessionDir` setting |

### Project override example

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// <project>/.pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Effective in that project
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```

Use this to override just the few fields you want per-project (e.g. swap to Claude Sonnet for a specific repo) without duplicating the rest.
