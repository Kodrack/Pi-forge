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
- Writes over 100 lines / 6000 chars get **blocked** (edits over 60 lines / 3000 chars) — write skeleton first, fill in sections
- Bash commands over 100 lines / 6000 chars get **blocked** — never inline a whole file in one heredoc; split into multiple small `cat >> file << 'CHUNK'` appends
- Generation is **aborted mid-stream** past 4000 chars of thinking or response text in one block, or 20000 chars total in one turn — think briefly, write conclusions to disk, NEVER dump code into chat
- After a blocked oversized write, the file is watched: if it ends up far smaller than what you attempted, you get steered — append ALL the missing chunks, the file is not done until it matches your plan
- Declaring `Status: complete` while modified code was never executed may be **blocked** (when execution-guard is enabled) — run your code and read the output before declaring done
- When your checks keep passing and you change nothing, you get nudged to mark `_state.md` complete and STOP — do not keep re-testing or invent extra improvements
- Repeating the same write or near-identical response gets warned, then blocked — change approach, do NOT retry the same payload
- Context at 65% triggers warning, 80% triggers forced compaction — write state to .think/ first
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
- `/stt [parakeet|moonshine]` — show/switch voice input engine (user presses è to record speech; audio is chunked every 30s and each chunk's transcript streams into their input box while they keep talking)
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
