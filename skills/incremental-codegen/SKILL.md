---
name: incremental-codegen
description: Build or substantially modify any code file by working in small incremental steps — plan, skeleton, then ONE feature per turn — instead of writing the whole file in one large `write` call. Use whenever the user requests a new file, a feature, a UI, or a refactor that would otherwise produce more than ~80 lines of output in a single tool call.
---

# Incremental Code Generation

You are running on a local LLM with limited output coherence. Large single-shot file generations produce truncated/buggy code. Always work in small steps so the user can verify and redirect.

## Hard rules

1. **Never write more than ~80 lines of code in a single `write` or `edit` tool call.** If a file naturally needs more, split it across multiple calls.
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
- Maximum ~80 lines. **Stop after this turn.**

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
