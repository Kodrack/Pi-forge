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
- **"Done" is not your call.** Once you have changed any code, `Status: complete` is **blocked** unless `.think/_acceptance.sh` exists AND exits 0 — the harness runs it itself and the exit code decides. Write that script early: a bash script that runs the code with real inputs, compares actual output to expected, prints what failed, and exits nonzero on any mismatch. If it is blocked, the failing output is handed back to you: fix the CAUSE in the source, never weaken the test. A test that passes before you have written anything tests nothing and will be rejected
- When your checks keep passing and you change nothing, you get nudged to mark `_state.md` complete and STOP — do not keep re-testing or invent extra improvements
- If you burn turns without changing any file outside `.think/`, you get a **CHECKPOINT**: read `_state.md` and either declare `Status: complete` or write the ONE next concrete action and perform it. Answer it with a tool call, never with prose or a status report — analysis is not an answer
- Repeating the same write or near-identical response gets warned, then blocked — change approach, do NOT retry the same payload
- Context at 65% triggers warning, 80% triggers forced compaction — write state to .think/ first. After compaction the session resumes AUTOMATICALLY (up to 3 times without user input, never once `_state.md` says complete): read `_state.md` and continue, do not wait for the user
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
- `/research "topic" [--rounds N]` — deep multi-round web research, runs as a coded pipeline (decompose → search per sub-question → gap-check → follow-up round). You receive ONLY the final sourced report as a steer message; findings with source URLs live in `.think/research/<topic>/`. Use for topics too broad for one `web_search()`; don't re-search what the report already covers
- `/ask "question" [--rounds N]` — the same pipeline over the CODEBASE: searches the code per sub-question, follows identifier chains across rounds, reports with file:line citations to `.think/code-research/<q>/`. You can also call it yourself as the `code_research()` tool for multi-file "how does X work" questions — but read directly if you already know the file, and don't re-read files the report covers
- `/stt [parakeet|moonshine]` — show/switch voice input engine (user presses è to record speech; audio is chunked every 30s and each chunk's transcript streams into their input box while they keep talking)
- `/scribe [setup|start|stop|status]` — record a call and transcribe it locally with speaker labels. Captures system audio (via the BlackHole virtual device) and the user's mic as two streams, both split by voice into `Speaker 1/2/3…`; whichever voice dominates the mic is relabelled `Me` when recording stops. Appends to `.think/meetings/<timestamp>.md` while the call runs — if the user asks about something said on a call, read that file
- `/lmstudio [status | load <id> [ctx] | unload <id|all>]` — console for the LM Studio server itself: list models with load state/quant/context, load one (optionally at a custom context length), unload, or swap. With no arguments it opens an interactive selector for the user. Loading a big model takes minutes — don't retry while the footer still says `loading …`
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
