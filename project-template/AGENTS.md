# STOP. READ THIS FIRST.
# YOU MUST create .think/_state.md BEFORE doing anything else.
# YOU MUST NOT write code until you have a _plan.md.
# EVERY turn: read _state.md → do ONE thing → update _state.md → STOP.


## CRITICAL: Context Constraints
- **Max context: 30K tokens. You WILL lose coherence if you exceed this.**
- Never hold more than **2 files** (max 2K tokens each) in a single prompt
- Your memory is the filesystem. Write EVERYTHING down. Trust files, not memory.

## Core Principle: Think On Paper, Not In Your Head
You are running on a local LLM with limited context. Instead of reasoning inside the conversation, you reason by **writing and reading files**. The `.think/` directory is your brain.

---

## Directory Structure

```
.think/                     # Your external brain — ALWAYS use this
  _state.md                 # Current task state & what to do next (READ THIS FIRST)
  _plan.md                  # Overall plan with numbered steps
  _decisions.md             # Key decisions made (append-only log)
  step-001.md               # Reasoning for step 1
  step-002.md               # Reasoning for step 2
  ...
  _summary.md               # Rolling summary of completed work
```

---

## Workflow Rules

### 0. KNOWLEDGE SCAN — Session Start Only
At the very start of a new session:
1. List `~/.pi/knowledge/` 
2. Identify any files relevant to this project's tech stack by filename
3. Load relevant files (max 2), extract the key failure patterns into `_state.md`
4. Do not re-read knowledge files after this — the extracted points in `_state.md` are enough

If `~/.pi/knowledge/` is empty or nothing is relevant, skip and proceed to step 1.

### 1. ALWAYS START by reading `_state.md`
Before doing ANYTHING, read `.think/_state.md`. If it doesn't exist, create it.
This file tells you: where you are, what's next, what files matter.

### 2. One Step = One File
Each reasoning step gets its own file (`step-NNN.md`). Each file must be:
- **Under 2K tokens** (~1500 words max)
- Self-contained: includes the question, reasoning, and conclusion
- Ends with `## CONCLUSION:` and a clear result

### 3. The Two-File Rule
In any single turn, you may read **at most 2 files**:
- Usually: `_state.md` + one other file you need
- After reasoning: write your output file, then update `_state.md`

### 4. Update `_state.md` EVERY turn
After every action, rewrite `_state.md` with:
```markdown
# Current State
## Task: [one-line description]
## Current Step: [number]
## Status: [in-progress / blocked / complete]
## Last Action: [what you just did]
## Next Action: [exactly what to do next]
## Key Files:
- [file]: [what it contains, 1 line]
## Context Needed Next Turn: [which 1-2 files to read]
```

### 5. Summarize, Don't Accumulate
After every 3-5 steps, write `_summary.md` with a condensed version of all progress so far. This prevents needing to read old step files.

### 6. Chain of Thought via Files
Instead of thinking in one long response:
```
Turn 1: Read _state.md → Write step-001.md (analyze problem) → Update _state.md
Turn 2: Read _state.md + step-001.md → Write step-002.md (design solution) → Update _state.md  
Turn 3: Read _state.md + step-002.md → Implement code → Update _state.md
Turn 4: Read _state.md → Write step-003.md (verify/test) → Update _state.md
```

### 7. For Code Tasks
When writing or editing code:
- Read `_state.md` to know what to do
- Read at most 1 source file at a time
- Write changes to the source file
- Log what you changed in a step file
- Update `_state.md` with the result

### 7b. For Analysis Tasks
When answering questions, debugging, reviewing, or explaining anything:
- Write your findings to `.think/step-NNN.md` BEFORE or IMMEDIATELY AFTER responding
- Never give a useful answer and skip the file write — context will be lost
- The step file must include your conclusion so it can be recovered next turn
- Update `_state.md` with what was analyzed and what was found

### 8. For Large Files
If a source file is too large to read at once:
- Read it in sections (use line ranges if available)
- Write notes about each section to a step file
- Combine notes in the next turn

9. **RESPONSES UNDER 200 WORDS** — say what you did, what's next, nothing more
10. **NO EXPLANATIONS unless asked** — just do the work and update _state.md

---

## File Templates

### _state.md (create at start of every new task)
```markdown
# Current State
## Task: [describe the task]
## Current Step: 0
## Status: starting
## Last Action: none
## Next Action: Read the relevant files and create a plan in _plan.md
## Key Files: none yet
## Context Needed Next Turn: [relevant source file]
```

### _plan.md
```markdown
# Plan: [Task Name]
## Goal: [what we're trying to achieve]
## Steps:
1. [ ] Analyze [what]
2. [ ] Design [what]  
3. [ ] Implement [what]
4. [ ] Test [what]
5. [ ] Verify [what]
## Constraints: [any limits or requirements]
## Estimated Steps: [number]
```

### step-NNN.md
```markdown
# Step NNN: [Title]
## Input: [what I'm looking at]
## Question: [what I need to figure out]
## Reasoning:
[your analysis — keep it focused]
## CONCLUSION:
[clear, actionable result]
## Next: [what should happen next]
```

---

## HARD RULES — Never Break These

1. **NEVER try to hold an entire codebase in context** — read one file at a time
2. **NEVER skip updating _state.md** — it's your lifeline between turns
3. **NEVER write a step file longer than 2K tokens** — split into multiple steps
4. **NEVER read more than 2 files per turn** — pick the 2 most important
5. **ALWAYS write before you forget** — analysis, decisions, findings, conclusions — ALL go to a step file immediately, not just code work
6. **ALWAYS check _state.md first** — even if you think you remember what to do
7. **Keep responses SHORT** — save tokens for tool calls, not prose
8. **Prefer file writes over long explanations** — show, don't tell