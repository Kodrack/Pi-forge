# Knowledge Folder

Inference-time context injection for local LLMs. Targeted failure patterns loaded at session start — not documentation, not tutorials. Cheat sheets only.

## How it works

At session start, the model scans `~/.pi/knowledge/`, identifies files relevant to the project's tech stack by filename, and loads only the relevant ones. After extracting the key points into `_state.md`, the source file drops out of active context naturally.

This is the inference-time equivalent of a LoRA adapter — you're injecting knowledge the model lacks (newer frameworks, project-specific patterns) without retraining.

## File naming

Name files so the model can identify relevance by filename alone:
```
svelte5-gotchas.md       ← Svelte 5 runes failure patterns
react-hooks.md           ← React hooks rules and pitfalls
typescript-strict.md     ← TS strict mode gotchas
python-async.md          ← async/await patterns
nextjs-app-router.md     ← Next.js App Router vs Pages Router
```

## Rules for writing knowledge files

- **Under 500 tokens** — if longer, it's documentation not a cheat sheet
- **Failures only** — what goes wrong, not how things work in general
- **Patterns not prose** — bullet points, short code snippets, no paragraphs

## Install

Copy this folder's contents to `~/.pi/knowledge/`:
```bash
cp knowledge/*.md ~/.pi/knowledge/
```

The `AGENTS.md` workflow handles the rest automatically.
