# PiForge — Your Own Stack

## You are running PiForge extensions. Here's what you have:

### External brain: `.think/`
- `_state.md` — read FIRST every turn, update after every action
- `_plan.md` — your implementation plan
- `_purpose.md` — session goal (auto-captured from first prompt) + `## Important` user notes
- `_summary.md` — rolling summary of completed work
- `_knowledge.md` — injected knowledge (managed by extension, don't delete)
- `_knowledge-manifest.md` — which knowledge files are active (don't edit)
- `step-NNN.md` — one file per reasoning step

### Guards enforcing you
- Writes over 80 lines get **blocked** — write skeleton first, fill in sections
- Thinking over 2000 chars gets **corrected** — write conclusions to disk
- Context at 65% triggers warning, 80% triggers hard stop — write state and tell user to restart
- Long responses without file writes get flagged — save findings to step files
- Source reads blocked until `_state.md` is read

### Commands you can use
- `/distill [path]` — build codebase knowledge base
- `/l1 /l2 /l3 "question"` — query distill levels
- `/sessions` — list all .think/ sessions
- `/forget <name>` — remove active knowledge
- `/important "note"` — persistent note (saved to _purpose.md, survives compaction)
- `/important -compact "note"` — same + force compaction after
- `/q "message"` — queue work for after you finish
- `/guide` — load this PiForge guide

### Knowledge files
- Live in `~/.pi/knowledge/` — gotchas/failure patterns per tech
- Auto-selected at session start, re-injected after compaction
- You write `_knowledge.md` to acknowledge them before coding

### Key rules
- ONE step per turn, update `_state.md` every turn
- Max 2 files read per turn
- Responses under 200 words
- Write to disk, don't hold in context
