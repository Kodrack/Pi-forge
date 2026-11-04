// organizer/board/dory.mjs — the Dory engine, hosted inside the board server.
//
// Cards are STATELESS: what Dory does with a card is defined purely by the
// column it sits in. tick() (polled by server.mjs) scans columns in priority
// order and performs ONE job at a time:
//
//   RESEARCH any card flagged research_requested (the 🔎 button, any column but
//           in_progress) → read-only job with web_search: rewrite the card's
//           title + description IN PLACE from what the web says (original kept
//           in the conversation, sources posted). The card doesn't move.
//   REPLY   any card (except in_progress) whose last conversation message is
//           human → planless cards get a chat answer; plan-bearing cards route
//           through the responder, which answers questions conversationally
//           OR (on a change request) rewrites tasks/T-NNN.md + tests/T-NNN.sh.
//   PLAN    plan_queue cards → browse the target project read-only, write
//           tasks/T-NNN.md (brief) + tests/T-NNN.sh (acceptance test), post
//           the plan into the conversation, auto-move → plan_created.
//   PAUSE   the header switch (board.dispatch) is the master switch for ALL work:
//           paused = no replies, research, planning or building, and flipping
//           it to paused STOPS the running job at once (stop(): child processes
//           killed, a /dory job aborted via the heartbeat, an interrupted build
//           back to Approved — never Blocked, no cooldown).
//   EXECUTE highest-priority approved card with deps done →
//           in_progress → PiForge executor session → run acceptance test.
//           Pass → done. Fail → retry with test output fed back (max_attempts)
//           → blocked. Bare cards get a quick plan+test at pickup first.
//   INGEST  (/api/ingest) massive raw text → prd/PRD-NNN.md + one task card
//           per work item, created in plan_queue.
//   PROJECT a card is PINNED (task.project) to the current project — where ù was
//           pressed — when Dory first works on it, and only worked on there. A card that passes its test records the
//           files it changed (task.changed_files); plans, revisions, waves and
//           executor runs of related cards (its dependencies, its goal's
//           subtasks) get those as POINTERS and read the real files: the code
//           is the reference, Dory only says where to look.
//   GOALS   (long horizon, see organizer/LONG-HORIZON.md) a plan job may answer
//           a too-big card with GOAL + goal test + a first wave of SUBTASKS.
//           Approving the goal creates the wave as linked subtask cards; each
//           is planned just in time (only once its deps are done), reviewed and
//           built like any card, and records the files it changed. When a wave is done
//           the goal test runs: pass → goal done, fail → a read-only "wave" job
//           plans the next wave (or says STUCK). Budgets are enforced in code.
//
// WHERE JOBS RUN — two modes, chosen automatically per job:
//   RUNNER   when an interactive Pi session has attached via /dory (the
//            dory-mode extension polls /api/runner/poll), jobs are DELEGATED
//            to it: the session opens a fresh session per task (context
//            reset), runs the job visibly in the user's own Pi TUI with the
//            full PiForge stack, and posts the final answer back.
//   HEADLESS when no runner is attached, jobs spawn throwaway `pi -p`
//            subprocesses (--mode json), streamed to the 🧠 browser console
//            and .dory-tmp/live.log (and stdout when running via
//            dory-console.sh). Ingest always runs headless (pure text).
//
// Config: <mind-dir>/config.json — { "project_dir": "/abs/path", "pi_bin",
// "dory_model", "dory_thinking", "max_attempts" }.
//
// Install: copied with the board to ~/.pi/organizer/board/ (see install.sh)

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

const CHAT_TIMEOUT_MS = 10 * 60 * 1000;
const INGEST_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_TIMEOUT_MS = 15 * 60 * 1000;
const EXEC_TIMEOUT_MS = 30 * 60 * 1000;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;  // don't hot-loop a failing job
// Heartbeat window = "a Pi session is attached". Must be several times
// dory-mode.ts's POLL_MS (10s) so one slow or skipped ping never detaches a
// session that is simply busy working a job — that misread is what used to send
// every subsequent job into a headless subprocess.
const RUNNER_FRESH_MS = 35 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

// Long-horizon goals. Overridable per mind repo in config.json → "long_horizon".
// Only "review" autonomy exists today: every subtask stops in plan_created for
// the human, exactly like a normal card.
const LH_DEFAULTS = { autonomy: "review", max_subtasks_per_wave: 4, max_waves: 5, max_subtasks_total: 15 };
const POINTER_CARDS_MAX = 30;       // related cards listed as file pointers in one prompt
const MAX_SPLIT_REJECTS = 2;
const MAX_RESEARCH_FAILURES = 3;     // then the request is dropped and the human told        // a subtask answering with GOAL this often → blocked (depth limit)
const CHANGED_FILES_MAX = 40;
// Top-level sections of dory-persona.md (one per job kind that uses a persona).
const PERSONA_SECTIONS = ["Research", "Chat", "Plan", "Revise", "Revise goal", "Wave"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".think", ".think-sessions", ".next", "dist", "build", ".venv", "__pycache__"]);

// Which cooldown bucket a job kind uses ("reply" covers chat + respond).
function cooldownKey(kind) {
  return kind === "exec" ? "exec" : kind === "plan" ? "plan" : kind === "wave" ? "wave" : kind === "research" ? "research" : "reply";
}

// Ingest persona is short enough to live here; the per-column personas are
// the bigger, more tunable ones and live in organizer/dory-persona.md.
const INGEST_PROMPT = `You are Dory, a software project organizer. Below is a raw requirements
dump from a human. Structure it.

1. Write a concise PRD in markdown: goal, scope, non-goals, open questions.
2. Split the work into independent, small, ordered tasks a coding agent can
   implement one at a time. Use dependencies instead of mega-tasks.

Output EXACTLY this structure and nothing else:

<<<PRD>>>
(the PRD markdown)
<<<TASKS>>>
[{"title": "...", "notes": "one-paragraph what/why", "priority": 1, "depends_on": [0]}]
<<<END>>>

TASKS is a JSON array. priority: 1 (urgent) to 3 (normal). depends_on lists
ZERO-BASED indices of tasks in this same array that must complete first.

RAW REQUIREMENTS:
`;

function between(text, startMark, endMarks) {
  const i = text.indexOf(startMark);
  if (i < 0) return null;
  const from = i + startMark.length;
  let to = text.length;
  for (const m of endMarks) {
    const j = text.indexOf(m, from);
    if (j >= 0 && j < to) to = j;
  }
  return text.slice(from, to).trim();
}

function stripFences(s) {
  return s.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

export function createDory({ mindDir, loadBoard, saveBoard, applyMove, createTask }) {
  let activity = "";
  let busy = false;          // a headless subprocess job is in flight
  let liveLog = "";          // raw streaming output of the current job
  const LIVE_LOG_MAX = 40000;
  const ingestQueue = [];
  const cooldown = new Map();      // "job:id" → last failure ts
  const execState = new Map();     // taskId → { attempt, lastTestOut }

  // PAUSE = STOP. Every child process (pi jobs, acceptance/goal tests) is
  // tracked so "Dory paused" can kill it on the spot; stopGen bumps on every
  // stop so any job awaiting a process knows its result must be discarded.
  const runningProcs = new Set();
  let stopGen = 0;

  // Jobs run in their OWN process group (spawn detached) and are stopped as a
  // group: killing just `bash -c …` or `pi` leaves its children (a test's
  // `npm test`/`sleep`, pi's tool subprocesses) running and holding the output
  // pipes open, so the job wouldn't really stop.
  function killTree(proc, signal) {
    try { process.kill(-proc.pid, signal); } catch { try { proc.kill(signal); } catch {} }
  }
  let abortedRunnerJob = null;     // id of a job the /dory session must abort (sent with the heartbeat)

  // Runner delegation state (an interactive Pi session attached via /dory).
  let lastRunnerPoll = 0;
  let pendingJob = null;           // { id, kind, taskId, prompt, quick, timeoutMs, createdAt, deliveredAt }
  let jobCounter = 0;

  const TMP_DIR = path.join(mindDir, ".dory-tmp");
  for (const d of ["tasks", "tests", "prd", "diary", ".dory-tmp"]) {
    fs.mkdirSync(path.join(mindDir, d), { recursive: true });
  }
  const gitignore = path.join(mindDir, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, ".dory-tmp/\n");

  function config() {
    try {
      return JSON.parse(fs.readFileSync(path.join(mindDir, "config.json"), "utf-8"));
    } catch {
      // runner_mode: "session" = run every job in the attached Pi session and
      // hold jobs when none is attached. "auto" = allow headless subprocesses.
      const def = { project_dir: "", pi_bin: "pi", dory_model: "", dory_thinking: "off", runner_mode: "session", max_attempts: DEFAULT_MAX_ATTEMPTS };
      fs.writeFileSync(path.join(mindDir, "config.json"), JSON.stringify(def, null, 2) + "\n");
      return def;
    }
  }

  // ── live console: stream of the current job ──────────────────────────────
  // Mirrored to .dory-tmp/live.log, the 🧠 browser panel, and stdout when the
  // server runs in a terminal (dory-console.sh). In runner mode the output is
  // visible in the user's own Pi session instead.
  const CONSOLE = process.stdout.isTTY || process.env.DORY_CONSOLE === "1";

  function liveStart(label) {
    const banner =
      `\n${"━".repeat(70)}\n` +
      `▶ ${new Date().toISOString()} · ${label}\n` +
      `${"━".repeat(70)}\n`;
    liveLog = banner;
    try { fs.writeFileSync(path.join(TMP_DIR, "live.log"), banner); } catch {}
    if (CONSOLE) process.stdout.write(banner);
  }

  function liveAppend(chunk) {
    liveLog = (liveLog + chunk).slice(-LIVE_LOG_MAX);
    try { fs.appendFileSync(path.join(TMP_DIR, "live.log"), chunk); } catch {}
    if (CONSOLE) process.stdout.write(String(chunk));
  }

  function diary(line) {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(mindDir, "diary", `${day}.md`);
    const stamp = new Date().toISOString().slice(11, 16);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${day}\n\n`);
    fs.appendFileSync(file, `- ${stamp} ${line}\n`);
  }

  function coolingDown(key) {
    return Date.now() - (cooldown.get(key) ?? 0) < FAIL_COOLDOWN_MS;
  }

  // Long-horizon budgets: defaults, overridden by config.json → long_horizon
  // (positive integers only; anything else falls back to the default).
  function lh(cfg) {
    const out = { ...LH_DEFAULTS };
    const o = cfg.long_horizon ?? {};
    for (const k of ["max_subtasks_per_wave", "max_waves", "max_subtasks_total"]) {
      if (Number.isInteger(o[k]) && o[k] > 0) out[k] = o[k];
    }
    return out;
  }

  const isGoal = (t) => t?.kind === "goal";
  const subtasksOf = (board, goalId) => board.tasks.filter((x) => x.parent === goalId);
  function goalOf(board, t) {
    return t?.parent ? board.tasks.find((x) => x.id === t.parent && isGoal(x)) ?? null : null;
  }

  // ── projects + file pointers ──────────────────────────────────────────────

  // The project a card belongs to. A card is pinned when Dory FIRST works on it
  // (research, plan or build): it adopts the current project — the folder of the
  // Pi session where ù was pressed — and is only ever worked on there after
  // that, so it can't be planned in one folder and built in another. Subtasks
  // inherit their goal's project.
  // null = the card's project folder no longer exists.
  function projectOf(task, cfg = config()) {
    if (task?.project) return fs.existsSync(task.project) ? task.project : null;
    return workDir(cfg);
  }

  function pinProject(task, project) {
    if (task.project || !project) return;
    withTask(task.id, (t) => { if (!t.project) t.project = project; }, `${task.id} pinned to ${project} (dory)`);
    task.project = project;
  }

  // Done cards related to `task` — its dependencies, and (for a subtask or a
  // goal) every subtask of the goal — with the files each changed. These are
  // POINTERS: the job reads the real files for what exists now.
  function filePointers(board, task) {
    const ids = new Set(task.depends_on ?? []);
    const goalId = isGoal(task) ? task.id : task.parent;
    if (goalId) for (const x of subtasksOf(board, goalId)) ids.add(x.id);
    ids.delete(task.id);
    const rows = board.tasks
      .filter((x) => ids.has(x.id) && x.status === "done" && Array.isArray(x.changed_files))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(-POINTER_CARDS_MAX)
      .map((x) => `- ${x.id} ${x.title}: ${x.changed_files.length ? x.changed_files.join(", ") : "(no file changes detected)"}`);
    if (!rows.length) return "";
    return `\n\n# FILES CHANGED BY RELATED CARDS (pointers: read these files for what exists now)\n${rows.join("\n")}`;
  }

  function goalContext(board, t) {
    const goal = goalOf(board, t);
    if (!goal) return "";
    return `\n\n# PART OF A LARGER GOAL (${goal.id}: ${goal.title})\n${goal.goal ?? goal.notes ?? ""}`;
  }

  function parseItems(raw) {
    try {
      const items = JSON.parse(stripFences(raw ?? ""));
      if (!Array.isArray(items) || !items.length || !items.every((t) => t && typeof t.title === "string" && t.title.trim())) return null;
      return items;
    } catch {
      return null;
    }
  }

  // ── persona sections (## Chat / ## Plan / ## Revise) ─────────────────────

  function persona(section) {
    let raw = null;
    for (const p of [path.join(ENGINE_DIR, "..", "dory-persona.md"), path.join(ENGINE_DIR, "dory-persona.md")]) {
      if (fs.existsSync(p)) { raw = fs.readFileSync(p, "utf-8"); break; }
    }
    if (!raw) throw new Error("dory-persona.md not found next to the board install");
    // End at the next PERSONA header only. A bare "\n## " also matches the
    // headings inside the brief template (## Purpose, ## Plan (small steps…)),
    // which used to cut the Plan persona off before its TEST format and rules.
    const part = between(raw, `\n## ${section}\n`, PERSONA_SECTIONS.filter((n) => n !== section).map((n) => `\n## ${n}\n`));
    if (!part) throw new Error(`persona section "## ${section}" missing in dory-persona.md`);
    return part;
  }

  function renderConversation(task) {
    if (!task.conversation?.length) return "(no messages yet)";
    return task.conversation.map((m) => `${m.by.toUpperCase()}: ${m.text}`).join("\n\n");
  }

  // Notes may reference mind-repo files by their repo-relative path ("PRD:
  // prd/PRD-001.md", written by ingest). Jobs run in the PROJECT folder, where
  // that path doesn't exist — the planner reported "the PRD is missing" — so
  // show it as a full path the job can actually read.
  function absolutizeMindPaths(text) {
    return text.replace(/\bPRD: (prd\/PRD-\d+\.md)\b/g, (_m, rel) => `PRD: ${path.join(mindDir, rel)} (the requirements this card comes from — read it)`);
  }

  function cardHeader(task) {
    const notes = task.notes ? absolutizeMindPaths(task.notes) : "";
    return `# CARD ${task.id}: ${task.title}\nPriority P${task.priority}\n\n${notes ? `Notes: ${notes}\n\n` : ""}# CONVERSATION\n${renderConversation(task)}`;
  }

  // ── pi subprocess (headless mode) ─────────────────────────────────────────

  // Render an in-flight assistant message (pi --mode json "partial") to plain
  // text for the live console. Must be DETERMINISTIC: the stream is shown by
  // diffing successive renders, so decorations may only ever append.
  function renderMessage(msg) {
    let s = "";
    for (const c of msg?.content ?? []) {
      if (c.type === "thinking") s += `\n··· thinking ···\n${c.thinking ?? ""}`;
      else if (c.type === "text") s += c.text ?? "";
      else if (c.type === "toolCall" || c.type === "tool_call") {
        s += `\n▸ tool ${c.name ?? c.toolName ?? "?"} ${JSON.stringify(c.arguments ?? c.args ?? {}).slice(0, 300)}\n`;
      }
    }
    return s;
  }

  // Spawn pi in --mode json and stream the session into the live console.
  // Resolves with `out` = the assistant's final text (for marker parsing).
  function runPi(cfg, args, cwd, timeoutMs, opts = {}) {
    return new Promise((resolve) => {
      const full = ["--mode", "json", ...args];
      if (opts.dory && cfg.dory_model) full.push("--model", cfg.dory_model);
      liveStart(activity || full.join(" "));
      // DORY_STAGE tells the PiForge extension stack which stage this throwaway
      // subprocess is running, so extensions can skip work that only makes sense
      // for code-writing stages (knowledge-injector's selection pass and its
      // write-block). In-session /dory jobs get the same signal from
      // ~/.pi/organizer/dory-runner.json instead, since they share one process.
      const gen = stopGen;
      const proc = spawn(cfg.pi_bin || "pi", full, {
        cwd,
        detached: true, // own process group → stop() kills pi AND its children
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.kind ? { ...process.env, DORY_STAGE: opts.kind } : process.env,
      });
      runningProcs.add(proc);
      let raw = "";
      let buf = "";
      let partialLen = 0;
      const finals = [];

      const handleLine = (line) => {
        if (!line.trim()) return;
        let e = null;
        if (line.startsWith("{")) { try { e = JSON.parse(line); } catch {} }
        if (!e) { liveAppend(line + "\n"); return; } // extension banners, plain output
        switch (e.type) {
          case "message_update": {
            const partial = e.assistantMessageEvent?.partial;
            if (partial) {
              const rendered = renderMessage(partial);
              if (rendered.length > partialLen) liveAppend(rendered.slice(partialLen));
              partialLen = Math.max(partialLen, rendered.length);
            }
            break;
          }
          case "message_start":
            if (e.message?.role === "assistant") partialLen = 0;
            break;
          case "message_end": {
            const m = e.message ?? {};
            if (m.role === "assistant") {
              const txt = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
              if (txt) finals.push(txt);
              liveAppend("\n");
            } else if (m.role === "toolResult" || m.role === "tool") {
              const txt = (m.content ?? []).map((c) => c.text ?? "").join("");
              if (txt) liveAppend(`◂ result ${txt.slice(0, 500)}${txt.length > 500 ? " …" : ""}\n`);
            }
            break;
          }
          default:
            break;
        }
      };

      proc.stdout.on("data", (d) => {
        raw += d;
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      proc.stderr.on("data", (d) => { raw += d; liveAppend(String(d)); });

      const finish = (code, timedOut) => {
        runningProcs.delete(proc);
        if (buf.trim()) handleLine(buf);
        resolve({ out: finals.join("\n\n") || raw, code, timedOut, aborted: gen !== stopGen });
      };
      const timer = setTimeout(() => {
        killTree(proc, "SIGKILL");
        finish(-1, true);
      }, timeoutMs);
      proc.on("close", (code) => {
        clearTimeout(timer);
        finish(code ?? -1, false);
      });
    });
  }

  function promptFile(name, content) {
    const p = path.join(TMP_DIR, name);
    fs.writeFileSync(p, content);
    return p;
  }

  // Project resolution: explicit config wins, then the cwd dory-board.ts
  // passed at server spawn, then the server's own cwd. The mind dir itself is
  // never a valid project.
  function workDir(cfg) {
    for (const d of [cfg.project_dir, process.env.DORY_PROJECT_DIR, process.cwd()]) {
      if (d && path.resolve(d) !== path.resolve(mindDir) && fs.existsSync(d)) return d;
    }
    return null;
  }

  // ── board mutation helpers ────────────────────────────────────────────────

  function withTask(id, fn, commitMsg) {
    const board = loadBoard();
    const t = board.tasks.find((x) => x.id === id);
    if (!t) return null; // deleted from the board mid-run
    const result = fn(t, board) ?? true;
    saveBoard(board, commitMsg);
    return result;
  }

  function say(taskId, text, commitMsg) {
    return withTask(taskId, (t) => {
      t.conversation.push({ at: new Date().toISOString(), by: "dory", text });
      t.updated = new Date().toISOString();
    }, commitMsg);
  }

  function noteTask(id, note) {
    const board = loadBoard();
    const t = board.tasks.find((x) => x.id === id);
    if (!t) return;
    // Blockers must be visible where the human actually looks: post into the
    // conversation too (deduped — this fires on every retry).
    if (!(t.conversation ?? []).some((m) => m.text.includes(note))) {
      t.conversation.push({ at: new Date().toISOString(), by: "dory", text: `⚠ ${note}` });
    }
    if (!(t.notes ?? "").includes(note)) t.notes = `${t.notes ?? ""}\n⚠ ${note}`.trim();
    t.updated = new Date().toISOString();
    saveBoard(board, `${id} note (dory)`);
  }

  function needsReply(task) {
    return task.conversation?.length && task.conversation.at(-1).by === "human";
  }

  function freshTask(id) {
    return loadBoard().tasks.find((x) => x.id === id);
  }

  // ── long horizon: subtask creation + changed files ───────────────────────

  // Turn a wave's SUBTASKS items into linked cards on `board` (caller saves).
  // Every budget and validation rule lives HERE, in code — never trusted to the
  // prompt. Returns { created, notes } or { error } (nothing created on error).
  //   - duplicate titles (vs this wave and earlier subtasks of the goal) dropped
  //   - at most max_subtasks_per_wave, and the goal's total ≤ max_subtasks_total
  //   - depends_on: integer = index in THIS wave's array; "T-NNN" = an existing
  //     subtask of this goal; anything else dropped and reported
  //   - a dependency cycle inside the wave rejects the whole wave
  function createSubtasks(board, goal, items, wave, cfg) {
    const L = lh(cfg);
    const notes = [];
    const existing = subtasksOf(board, goal.id);
    const seen = new Set(existing.map((x) => x.title.trim().toLowerCase()));
    let kept = [];
    items.forEach((item, i) => {
      const key = String(item.title).trim().toLowerCase();
      if (seen.has(key)) { notes.push(`dropped duplicate subtask "${item.title}"`); return; }
      seen.add(key);
      kept.push({ item, orig: i });
    });
    if (kept.length > L.max_subtasks_per_wave) {
      notes.push(`wave capped at ${L.max_subtasks_per_wave} subtasks (dropped: ${kept.slice(L.max_subtasks_per_wave).map((k) => `"${k.item.title}"`).join(", ")})`);
      kept = kept.slice(0, L.max_subtasks_per_wave);
    }
    const room = L.max_subtasks_total - existing.length;
    if (room <= 0) return { error: `subtask budget used up (${L.max_subtasks_total} total for one goal)` };
    if (kept.length > room) {
      notes.push(`goal total capped at ${L.max_subtasks_total} subtasks (dropped: ${kept.slice(room).map((k) => `"${k.item.title}"`).join(", ")})`);
      kept = kept.slice(0, room);
    }
    if (!kept.length) return { error: "no valid subtasks in this wave" };

    const pos = new Map(kept.map((k, j) => [k.orig, j])); // original index → kept index
    const existingIds = new Set(existing.map((x) => x.id));
    const edges = kept.map((k) => {
      const out = { local: [], ids: [] };
      for (const d of Array.isArray(k.item.depends_on) ? k.item.depends_on : []) {
        if (Number.isInteger(d) && pos.has(d) && pos.get(d) !== pos.get(k.orig)) out.local.push(pos.get(d));
        else if (typeof d === "string" && existingIds.has(d)) out.ids.push(d);
        else notes.push(`"${k.item.title}": ignored dependency ${JSON.stringify(d)}`);
      }
      return out;
    });
    // cycle check over in-wave edges (DFS with colours)
    const colour = new Array(kept.length).fill(0);
    const cyclic = (n) => {
      if (colour[n] === 1) return true;
      if (colour[n] === 2) return false;
      colour[n] = 1;
      for (const m of edges[n].local) if (cyclic(m)) return true;
      colour[n] = 2;
      return false;
    };
    for (let n = 0; n < kept.length; n++) {
      if (cyclic(n)) return { error: "the subtasks' dependencies form a cycle — wave rejected" };
    }

    const created = kept.map((k) =>
      createTask(board, {
        title: String(k.item.title).trim().slice(0, 200),
        status: "plan_queue",
        notes: `${k.item.notes ?? ""}\n\nSubtask of goal ${goal.id} ("${goal.title}"), wave ${wave}.`.trim(),
        priority: [1, 2, 3].includes(k.item.priority) ? k.item.priority : 3,
      }, "dory")
    );
    created.forEach((t, j) => {
      t.project = goal.project ?? workDir(cfg) ?? undefined;
      t.parent = goal.id;
      t.wave = wave;
      t.depends_on = [...edges[j].local.map((m) => created[m].id), ...edges[j].ids];
    });
    return { created, notes };
  }

  // Every project file with its mtime (skipping SKIP_DIRS, .think*). Capped so
  // a huge tree can't stall the engine.
  function scanProject(cwd) {
    const out = {};
    let visited = 0;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (++visited > 20000) return;
        if (e.name.startsWith(".think") || SKIP_DIRS.has(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else if (e.isFile()) { try { out[rel] = fs.statSync(path.join(cwd, rel)).mtimeMs; } catch {} }
      }
    };
    walk("");
    return out;
  }

  // Snapshot of the project when a card is claimed for execution, kept on disk
  // so a restart mid-run can still tell what this card changed.
  const snapPath = (taskId) => path.join(TMP_DIR, `snap-${taskId}.json`);
  function snapshotProject(taskId, cwd) {
    try { fs.writeFileSync(snapPath(taskId), JSON.stringify(scanProject(cwd))); } catch {}
  }

  // Files this card's run created or modified: compared against the snapshot
  // taken at claim time (exact — earlier cards' files and pre-existing edits are
  // never credited). Without a snapshot, fall back to "modified since the card
  // went in_progress".
  function changedFiles(cwd, taskId, sinceMs) {
    const now = scanProject(cwd);
    let before = null;
    try { before = JSON.parse(fs.readFileSync(snapPath(taskId), "utf-8")); } catch {}
    const files = Object.keys(now).filter((rel) => (before ? before[rel] !== now[rel] : now[rel] >= sinceMs));
    return files.sort().slice(0, CHANGED_FILES_MAX);
  }

  // A card that passed its test records which files its run changed — the
  // pointer later related cards follow to the real code.
  function recordChangedFiles(task, cwd) {
    const startedAt = Date.parse([...(task.history ?? [])].reverse().find((h) => h.to === "in_progress")?.at ?? "") || Date.now() - EXEC_TIMEOUT_MS;
    const files = cwd ? changedFiles(cwd, task.id, startedAt) : [];
    try { fs.unlinkSync(snapPath(task.id)); } catch {}
    withTask(task.id, (t) => { t.changed_files = files; }, `${task.id} changed files recorded (dory)`);
    diary(`${task.id} changed: ${files.length ? files.join(", ") : "(nothing detected)"}`);
  }

  // ── prompt builders (shared by headless + runner modes) ──────────────────

  function buildResearchPrompt(task) {
    return `${persona("Research")}\n\n${cardHeader(task)}`;
  }

  function buildChatPrompt(task) {
    return `${persona("Chat")}\n\n${cardHeader(task)}${filePointers(loadBoard(), task)}`;
  }

  function buildRespondPrompt(task) {
    if (isGoal(task)) return buildGoalRespondPrompt(task);
    const currentPlan = task.brief && fs.existsSync(path.join(mindDir, task.brief))
      ? fs.readFileSync(path.join(mindDir, task.brief), "utf-8")
      : "(no plan written yet)";
    const currentTest = fs.existsSync(path.join(mindDir, `tests/${task.id}.sh`))
      ? fs.readFileSync(path.join(mindDir, `tests/${task.id}.sh`), "utf-8")
      : "(no test written yet)";
    return `${persona("Revise")}\n\n${cardHeader(task)}\n\n# CURRENT BRIEF\n${currentPlan}\n\n# CURRENT TEST\n${currentTest}${filePointers(loadBoard(), task)}`;
  }

  function buildPlanPrompt(task, quick) {
    const quickNote = quick ? "\n\nBE BRIEF: this card was queued for immediate execution — smallest viable plan, but the TEST rules still apply in full." : "";
    const board = loadBoard();
    const sub = (task.parent
      ? `\n\nTHIS CARD IS A SUBTASK of goal ${task.parent}. It was already split once: answer with BRIEF + TEST only — a GOAL answer is rejected.` +
        goalContext(board, task)
      : "") + filePointers(board, task);
    return `${persona("Plan")}${quickNote}\n\n${cardHeader(task)}${sub}\n\nUse the id ${task.id} in the brief heading.`;
  }

  // Revising a goal card. Before wave 1 starts the outline can still change
  // (GOAL block) or the goal can go back to being one normal card (BRIEF block);
  // once running, the conversation is answers only.
  function buildGoalRespondPrompt(task) {
    const board = loadBoard();
    const started = (task.wave ?? 0) > 0 || subtasksOf(board, task.id).length > 0;
    const outline = task.brief && fs.existsSync(path.join(mindDir, task.brief)) ? fs.readFileSync(path.join(mindDir, task.brief), "utf-8") : "(no outline)";
    const test = fs.existsSync(path.join(mindDir, `tests/${task.id}.sh`)) ? fs.readFileSync(path.join(mindDir, `tests/${task.id}.sh`), "utf-8") : "(no goal test)";
    const subs = subtasksOf(board, task.id).map((x) => `- ${x.id} [${x.status}] wave ${x.wave}: ${x.title}`).join("\n") || "(none yet)";
    return (
      `${persona("Revise goal")}\n\n${cardHeader(task)}\n\n# STATE\n${started ? "RUNNING: the outline is fixed, answer with REPLY only." : "NOT STARTED: the outline may still change."}\n\n` +
      `# CURRENT GOAL + OUTLINE\n${outline}\n\n# CURRENT GOAL TEST\n${test}\n\n# SUBTASKS\n${subs}${filePointers(board, task)}`
    );
  }

  // Next wave of a goal whose goal test still fails after the current wave.
  function buildWavePrompt(goal, testOut) {
    const board = loadBoard();
    const L = lh(config());
    const subs = subtasksOf(board, goal.id);
    const list = subs.map((x) => `- ${x.id} [${x.status}] wave ${x.wave}: ${x.title}`).join("\n");
    const room = Math.min(L.max_subtasks_per_wave, L.max_subtasks_total - subs.length);
    const test = fs.existsSync(path.join(mindDir, `tests/${goal.id}.sh`)) ? fs.readFileSync(path.join(mindDir, `tests/${goal.id}.sh`), "utf-8") : "(no goal test)";
    return (
      `${persona("Wave")}\n\n${cardHeader(goal)}\n\n# GOAL\n${goal.goal ?? goal.notes ?? ""}\n\n# GOAL TEST\n${test}\n\n` +
      `# GOAL TEST OUTPUT NOW (it fails)\n\`\`\`\n${(testOut ?? "").slice(-2500)}\n\`\`\`\n\n` +
      `# SUBTASKS SO FAR\n${list}${filePointers(board, goal)}\n\n` +
      `# BUDGET\nThis will be wave ${(goal.wave ?? 0) + 1} of at most ${L.max_waves}. You may create at most ${Math.max(room, 0)} subtasks.`
    );
  }

  function buildExecPrompt(task, briefContent, lastTestOut) {
    const retryNote = lastTestOut
      ? `\n\n# PREVIOUS ATTEMPT FAILED — acceptance test output:\n\`\`\`\n${lastTestOut.slice(-2000)}\n\`\`\`\nFix the cause and make the test pass.`
      : "";
    return (
      `Implement this task in the current project. Follow the workflow contract.\n\n` +
      `IMPORTANT: the project root is your CURRENT WORKING DIRECTORY. Do ALL work here with relative paths. ` +
      `If the brief mentions any absolute path outside this directory, IGNORE that location and treat it as this project root instead.\n\n` +
      `${briefContent}\n\n# REQUIREMENTS DISCUSSION (the card's conversation — context and clarifications from the human)\n${renderConversation(task)}${retryNote}\n\n` +
      `When you believe you are done, the acceptance test must pass: ${task.test_cmd}` +
      goalContext(loadBoard(), task) + filePointers(loadBoard(), task)
    );
  }

  // ── result handlers (shared by headless + runner modes) ───────────────────

  // Research: the card's title/description are rewritten IN PLACE from what Dory
  // found on the web. The ORIGINAL text is quoted in her message, so nothing the
  // human wrote is lost. The card stays in its column.
  function handleResearchResult(task, out, meta) {
    const title = between(out, "<<<TITLE>>>", ["<<<DESCRIPTION>>>", "<<<SOURCES>>>", "<<<REPLY>>>", "<<<END>>>"]);
    const description = between(out, "<<<DESCRIPTION>>>", ["<<<SOURCES>>>", "<<<REPLY>>>", "<<<END>>>"]);
    const sources = between(out, "<<<SOURCES>>>", ["<<<REPLY>>>", "<<<END>>>"]);
    const reply = between(out, "<<<REPLY>>>", ["<<<END>>>"]);
    if (meta.failed || !description) {
      cooldown.set(`research:${task.id}`, Date.now());
      fs.writeFileSync(path.join(TMP_DIR, `research-failed-${task.id}.txt`), out ?? "");
      let failures = 0;
      withTask(task.id, (t) => {
        failures = t.research_failures = (t.research_failures ?? 0) + 1;
        if (failures >= MAX_RESEARCH_FAILURES) delete t.research_requested;
      }, `${task.id} research failed (dory)`);
      diary(`research ${task.id} FAILED ${failures}x (${meta.detail ?? "no DESCRIPTION block"})`);
      noteTask(
        task.id,
        failures >= MAX_RESEARCH_FAILURES
          ? `web research failed ${failures} times — gave up; press 🔎 Research to try again (raw output in .dory-tmp/research-failed-${task.id}.txt)`
          : `web research failed — will retry in 5 minutes (raw output in .dory-tmp/research-failed-${task.id}.txt)`
      );
      return;
    }
    const newTitle = (title ?? "").split("\n")[0].trim().slice(0, 200) || task.title;
    const before = { title: task.title, notes: (task.notes ?? "").trim() };
    const hadPlan = !!task.brief && !isGoal(task);
    const goalOutline = isGoal(task) && !((task.wave ?? 0) > 0);
    withTask(task.id, (t) => {
      t.title = newTitle;
      t.notes = description.trim();
      t.researched = new Date().toISOString();
      delete t.research_requested;
      delete t.research_failures;
    }, `${task.id} researched in place (dory)`);
    say(
      task.id,
      `${reply ? reply.trim() + "\n\n" : ""}I searched the web and rewrote this card.\n\n` +
        `Title: ${newTitle}${newTitle !== before.title ? `\n(was: ${before.title})` : " (unchanged)"}\n\n` +
        `Sources:\n${sources?.trim() || "(none listed)"}\n\n` +
        `Your original description:\n${before.notes ? before.notes.split("\n").map((l) => `> ${l}`).join("\n") : "> (empty)"}\n\n` +
        (hadPlan
          ? `This card already has a plan, written for the OLD description. Reply "replan" and I'll revise it, or drag the card to Plan Queue to plan it fresh.`
          : goalOutline
            ? `This goal's outline was written for the OLD description. Reply "update the outline" and I'll revise it before you approve.`
            : `Reply here to adjust it.`),
      `${task.id} research posted (dory)`
    );
    diary(`researched ${task.id} in place (${task.status})`);
  }

  function handleChatResult(task, out, meta) {
    const reply = between(out, "<<<REPLY>>>", ["<<<END>>>"]) || out.trim().slice(-3000);
    if (!reply || meta.failed) {
      cooldown.set(`reply:${task.id}`, Date.now());
      diary(`chat reply ${task.id} FAILED (${meta.detail ?? "empty output"})`);
      return;
    }
    say(task.id, reply, `${task.id} chat reply (dory)`);
    diary(`replied on ${task.id} (chat)`);
  }

  function handleRespondResult(task, out, meta) {
    if (!meta.failed && (isGoal(task) || between(out, "<<<GOAL>>>", ["<<<TEST>>>"]) !== null)) {
      const handled = handleGoalRespond(task, out);
      if (handled) return;
    }
    const brief = between(out, "<<<BRIEF>>>", ["<<<TEST>>>", "<<<REPLY>>>"]);
    const test = between(out, "<<<TEST>>>", ["<<<REPLY>>>", "<<<END>>>"]);
    const reply = between(out, "<<<REPLY>>>", ["<<<END>>>"]) || (!brief ? out.trim().slice(-3000) : "");
    if ((!brief && !reply) || meta.failed) {
      cooldown.set(`reply:${task.id}`, Date.now());
      fs.writeFileSync(path.join(TMP_DIR, `revise-failed-${task.id}.txt`), out);
      diary(`respond ${task.id} FAILED (${meta.detail ?? "no output"})`);
      return;
    }
    if (brief) {
      writePlanFiles(task.id, brief, test);
      say(task.id, reply || "I updated the plan — see the brief on this card.", `${task.id} plan revised (dory)`);
      diary(`revised plan for ${task.id} after feedback`);
    } else {
      say(task.id, reply, `${task.id} reply (dory)`);
      diary(`replied on ${task.id} (plan question)`);
    }
  }

  // GOAL + goal TEST + SUBTASKS from a plan or revise job → the card becomes a
  // goal (not started yet: the wave-1 outline waits in pending_wave until the
  // human approves the goal). Returns false when the payload is unusable.
  function parseGoalPayload(out) {
    const goal = between(out, "<<<GOAL>>>", ["<<<TEST>>>"]);
    const test = between(out, "<<<TEST>>>", ["<<<SUBTASKS>>>", "<<<REPLY>>>", "<<<END>>>"]);
    const items = parseItems(between(out, "<<<SUBTASKS>>>", ["<<<REPLY>>>", "<<<END>>>"]));
    return goal && test && items ? { goal, test, items } : null;
  }

  function applyGoalPlan(task, payload) {
    const L = lh(config());
    const items = payload.items.slice(0, L.max_subtasks_per_wave);
    const outline = items
      .map((it, i) => `${i}. ${it.title}${Array.isArray(it.depends_on) && it.depends_on.length ? ` (after ${it.depends_on.join(", ")})` : ""}${it.notes ? ` — ${it.notes}` : ""}`)
      .join("\n");
    const brief = `# ${task.id} — ${task.title} (goal)\n\n## Goal\n${payload.goal}\n\n## Wave 1 outline\n${outline}\n`;
    writePlanFiles(task.id, brief, payload.test);
    withTask(task.id, (t) => {
      t.kind = "goal";
      t.goal = payload.goal;
      t.pending_wave = items;
      t.wave = 0;
      t.waves_done = 0;
    }, `${task.id} is a goal — wave-1 outline written (dory)`);
    if (payload.items.length > items.length) noteTask(task.id, `outline capped at ${L.max_subtasks_per_wave} subtasks per wave; the rest can come in a later wave`);
    return outline;
  }

  function rejectSplit(task) {
    let rejects = 0;
    withTask(task.id, (t) => { t.split_rejects = rejects = (t.split_rejects ?? 0) + 1; }, `${task.id} split rejected (dory)`);
    diary(`plan ${task.id} answered with GOAL but it is a subtask (depth limit) — rejected ${rejects}x`);
    if (rejects >= MAX_SPLIT_REJECTS) {
      withTask(task.id, (t) => applyMove(t, "blocked", "dory"), `${task.id} blocked — keeps splitting a subtask (dory)`);
      noteTask(task.id, `blocked: Dory tried to split this subtask ${rejects} times, but subtasks can't have subtasks. Make the card smaller, or turn it into its own goal outside goal ${task.parent}.`);
    } else {
      cooldown.set(`plan:${task.id}`, Date.now());
      noteTask(task.id, `plan rejected: subtasks can't be split again (depth limit) — will retry with a BRIEF`);
    }
    return false;
  }

  // Revise on a goal (or a normal card asked to be split). Returns true when it
  // fully handled the result; false lets the normal revise path run.
  function handleGoalRespond(task, out) {
    const board = loadBoard();
    const started = (task.wave ?? 0) > 0 || subtasksOf(board, task.id).length > 0;
    const reply = between(out, "<<<REPLY>>>", ["<<<END>>>"]);
    const wantsGoal = between(out, "<<<GOAL>>>", ["<<<TEST>>>"]) !== null;
    const wantsBrief = between(out, "<<<BRIEF>>>", ["<<<TEST>>>", "<<<REPLY>>>"]) !== null;
    if (!isGoal(task)) {
      // a normal card the human asked to split
      if (task.parent || !["plan_queue", "plan_created", "approved"].includes(task.status)) return false;
      const payload = parseGoalPayload(out);
      if (!payload) return false;
      const outline = applyGoalPlan(task, payload);
      say(task.id, `${reply || "Split into a goal."}\n\nWave 1:\n${outline}`, `${task.id} converted to a goal (dory)`);
      diary(`${task.id} converted to a goal after feedback`);
      return true;
    }
    if (started && (wantsGoal || wantsBrief)) {
      say(task.id, `${reply ? reply + "\n\n" : ""}(The goal is already running, so its outline can't change now. To change direction: let the current wave finish, or move this goal to Blocked and tell me what to do differently.)`, `${task.id} reply (dory)`);
      return true;
    }
    if (!started && wantsGoal) {
      const payload = parseGoalPayload(out);
      if (!payload) return false;
      const outline = applyGoalPlan(task, payload);
      say(task.id, `${reply || "This is the new outline."}\n\nWave 1:\n${outline}`, `${task.id} goal outline revised (dory)`);
      diary(`revised goal outline for ${task.id} after feedback`);
      return true;
    }
    if (!started && wantsBrief) {
      // back to one normal card
      withTask(task.id, (t) => { delete t.kind; delete t.goal; delete t.pending_wave; delete t.wave; delete t.waves_done; }, `${task.id} goal → normal card (dory)`);
      return false; // the normal revise path writes the BRIEF/TEST and replies
    }
    return false;
  }

  function handlePlanResult(task, out, meta) {
    if (!meta.failed && between(out, "<<<GOAL>>>", ["<<<TEST>>>"]) !== null) {
      if (task.parent) return rejectSplit(task);
      const payload = parseGoalPayload(out);
      if (payload) {
        const outline = applyGoalPlan(task, payload);
        if (!meta.quick) {
          withTask(task.id, (t) => applyMove(t, "plan_created", "dory"), `${task.id} plan_queue → plan_created (goal outline, dory)`);
        }
        say(
          task.id,
          `This is bigger than one card, so I made it a goal.\n\nGoal: ${payload.goal}\n\nWave 1:\n${outline}\n\n` +
            `The goal test (on this card) decides when the whole thing is done. Reply to change the outline, or drag this card to Approved to start wave 1 — each subtask still comes back to you for review.`,
          `${task.id} goal outline posted (dory)`
        );
        diary(`planned ${task.id} as a GOAL (wave 1: ${payload.items.length} subtasks)${meta.quick ? " (quick pickup)" : ""}`);
        return true;
      }
      // GOAL marker but unusable payload → fall through to the normal failure path
    }
    const brief = between(out, "<<<BRIEF>>>", ["<<<TEST>>>"]);
    const test = between(out, "<<<TEST>>>", ["<<<END>>>"]);
    if (!brief || !test || meta.failed) {
      cooldown.set(`plan:${task.id}`, Date.now());
      fs.writeFileSync(path.join(TMP_DIR, `plan-failed-${task.id}.txt`), out);
      diary(`plan ${task.id} FAILED (${meta.detail ?? "unparseable output"})`);
      noteTask(task.id, `planning failed — will retry; raw output in .dory-tmp/plan-failed-${task.id}.txt`);
      return false;
    }
    writePlanFiles(task.id, brief, test);
    if (!meta.quick) {
      withTask(task.id, (t) => applyMove(t, "plan_created", "dory"), `${task.id} plan_queue → plan_created (dory)`);
      say(task.id, `Here is the plan:\n\n${brief.slice(0, 2500)}${brief.length > 2500 ? "\n…(full brief on the card)" : ""}\n\nReply here with changes, or drag the card to Approved.`, `${task.id} plan posted (dory)`);
    }
    diary(`planned ${task.id}${meta.quick ? " (quick pickup)" : " — awaiting review in plan_created"}`);
    return true;
  }

  function handleWaveResult(goal, out, meta) {
    const stuck = between(out, "<<<STUCK>>>", ["<<<END>>>"]);
    const items = parseItems(between(out, "<<<SUBTASKS>>>", ["<<<STUCK>>>", "<<<END>>>"]));
    if (!meta.failed && stuck && !items) {
      withTask(goal.id, (g) => applyMove(g, "blocked", "dory"), `${goal.id} blocked — Dory is stuck (dory)`);
      noteTask(goal.id, `stuck after wave ${goal.wave}: ${stuck}`);
      diary(`${goal.id} STUCK after wave ${goal.wave}`);
      return;
    }
    if (meta.failed || !items) {
      cooldown.set(`wave:${goal.id}`, Date.now());
      fs.writeFileSync(path.join(TMP_DIR, `wave-failed-${goal.id}.txt`), out ?? "");
      diary(`wave for ${goal.id} FAILED (${meta.detail ?? "unparseable output"})`);
      noteTask(goal.id, `planning the next wave failed — will retry; raw output in .dory-tmp/wave-failed-${goal.id}.txt`);
      return;
    }
    let result = null;
    withTask(goal.id, (g, board) => {
      result = createSubtasks(board, g, items, (g.wave ?? 0) + 1, config());
      if (!result.error) g.wave = (g.wave ?? 0) + 1;
    }, `${goal.id} next wave (dory)`);
    if (!result || result.error) {
      cooldown.set(`wave:${goal.id}`, Date.now());
      noteTask(goal.id, `next wave rejected: ${result?.error ?? "goal deleted"}`);
      diary(`wave for ${goal.id} rejected: ${result?.error}`);
      return;
    }
    say(
      goal.id,
      `The goal test still fails, so here is wave ${goal.wave + 1}:\n${result.created.map((t) => `- ${t.id} ${t.title}`).join("\n")}` +
        `${result.notes.length ? `\n\nNotes: ${result.notes.join("; ")}` : ""}\n\nEach one comes back to you for review in Plan created.`,
      `${goal.id} wave ${goal.wave + 1} posted (dory)`
    );
    diary(`${goal.id} wave ${goal.wave + 1}: created ${result.created.map((t) => t.id).join(", ")}`);
  }

  async function handleExecResult(task, out, meta) {
    const cfg = config();
    const cwd = projectOf(task, cfg);
    const state = execState.get(task.id) ?? { attempt: 1, lastTestOut: "" };
    const maxAttempts = cfg.max_attempts || DEFAULT_MAX_ATTEMPTS;
    const t = freshTask(task.id);
    if (!t) { execState.delete(task.id); return; } // deleted mid-run
    const test = await runTest(t, cwd);
    if (test.aborted) { revertStopped("exec", task.id); return; } // paused during the acceptance test
    if (test.code === 0) {
      execState.delete(task.id);
      withTask(task.id, (x) => applyMove(x, "done", "daemon"), `${task.id} done — acceptance test passed on attempt ${state.attempt} (daemon)`);
      diary(`${task.id} DONE (attempt ${state.attempt}) — test passed`);
      recordChangedFiles(freshTask(task.id) ?? t, cwd);
      return;
    }
    diary(`${task.id} attempt ${state.attempt} failed — test exit ${test.code}`);
    if (state.attempt < maxAttempts && !meta.failed) {
      execState.set(task.id, { attempt: state.attempt + 1, lastTestOut: test.out });
      return; // next tick dispatches the next attempt
    }
    execState.delete(task.id);
    try { fs.unlinkSync(snapPath(task.id)); } catch {}
    withTask(task.id, (x) => {
      applyMove(x, "blocked", "daemon");
      x.notes = `${x.notes ?? ""}\n⚠ blocked after ${state.attempt} attempts. Last test output:\n${test.out.slice(-1500)}`.trim();
    }, `${task.id} blocked after ${state.attempt} attempts (daemon)`);
    diary(`${task.id} BLOCKED after ${state.attempt} attempts`);
  }

  function writePlanFiles(taskId, brief, test) {
    const briefRel = `tasks/${taskId}.md`;
    fs.writeFileSync(path.join(mindDir, briefRel), brief + "\n");
    if (test) fs.writeFileSync(path.join(mindDir, `tests/${taskId}.sh`), stripFences(test) + "\n", { mode: 0o755 });
    withTask(taskId, (t) => {
      t.brief = briefRel;
      if (test) t.test_cmd = `bash "${path.join(mindDir, `tests/${taskId}.sh`)}"`;
    }, `${taskId} plan files written (dory)`);
    // Safety net: a plan that references locations outside the project would
    // make the executor build in the wrong place — surface it before approval.
    const project = projectOf(freshTask(taskId));
    const stray = `${brief}\n${test ?? ""}`.match(/(?:\/Users|\/home|~\/)[^\s"'`)\]]*/g)?.filter(
      (p) => project && !p.replace("~", process.env.HOME ?? "~").startsWith(project) && !p.startsWith(mindDir)
    );
    if (stray?.length) {
      noteTask(taskId, `plan references paths OUTSIDE the project (${[...new Set(stray)].slice(0, 3).join(", ")}) — the executor is instructed to stay in ${project}, but review the plan before approving`);
    }
  }

  function runTest(task, cwd) {
    return new Promise((resolve) => {
      const gen = stopGen;
      const proc = spawn("bash", ["-c", task.test_cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      runningProcs.add(proc);
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        killTree(proc, "SIGKILL");
        runningProcs.delete(proc);
        resolve({ out: out + "\n[test timed out]", code: -1, aborted: gen !== stopGen });
      }, TEST_TIMEOUT_MS);
      proc.on("close", (code) => {
        clearTimeout(timer);
        runningProcs.delete(proc);
        if (gen !== stopGen) return resolve({ out, code: -1, aborted: true });
        liveAppend(`\n── acceptance test exit ${code ?? -1}\n${out.slice(-1500)}\n`);
        resolve({ out, code: code ?? -1, aborted: false });
      });
    });
  }

  // A stopped job leaves no trace except this: an interrupted build goes back to
  // Approved (attempt counter reset — it starts clean on resume), never Blocked,
  // no cooldown. Read-only jobs simply end; their card stays where it is.
  function revertStopped(kind, taskId) {
    if (kind !== "exec") return;
    execState.delete(taskId);
    try { fs.unlinkSync(snapPath(taskId)); } catch {}
    const moved = withTask(taskId, (t) => t.status === "in_progress" && applyMove(t, "approved", "dory").ok, `${taskId} paused mid-run → approved (dory)`);
    if (moved) noteTask(taskId, "paused mid-run: the build was stopped; partial edits may remain in the project. It restarts from attempt 1 when Dory is active again.");
  }

  // Dory paused → stop EVERYTHING now: kill every child process, take back a
  // job delivered to the /dory session (it aborts the model on its next
  // heartbeat, ~2s), and put an interrupted build back in Approved.
  function stop(reason = "paused") {
    stopGen++;
    const stopped = [];
    for (const proc of runningProcs) {
      killTree(proc, "SIGTERM");
      setTimeout(() => killTree(proc, "SIGKILL"), 2000).unref?.();
    }
    if (runningProcs.size) stopped.push(`${runningProcs.size} running process(es)`);
    if (pendingJob) {
      const job = pendingJob;
      pendingJob = null;
      if (job.deliveredAt) abortedRunnerJob = job.id;
      stopped.push(`${job.kind} ${job.taskId}${job.deliveredAt ? " (in your /dory session)" : ""}`);
      revertStopped(job.kind, job.taskId);
    }
    const label = activity;
    activity = "";
    if (stopped.length || label) {
      liveAppend(`\n■ ${reason} — stopped: ${stopped.join(", ") || label}\n`);
      diary(`${reason} — stopped ${stopped.join(", ") || label}`);
    }
    return stopped;
  }

  // ── job dispatch: runner delegation or headless subprocess ────────────────

  function runnerAttached() {
    return Date.now() - lastRunnerPoll < RUNNER_FRESH_MS;
  }

  const HANDLERS = { research: handleResearchResult, chat: handleChatResult, respond: handleRespondResult, plan: handlePlanResult, wave: handleWaveResult, exec: handleExecResult };
  const HEADLESS_ARGS = {
    research:(cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    chat:    (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    respond: (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    plan:    (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    wave:    (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    exec:    () => ["--no-session"], // executor: full tool set + guard stack
  };
  const TIMEOUTS = { research: PLAN_TIMEOUT_MS, chat: CHAT_TIMEOUT_MS, respond: PLAN_TIMEOUT_MS, plan: PLAN_TIMEOUT_MS, wave: PLAN_TIMEOUT_MS, exec: EXEC_TIMEOUT_MS };

  async function dispatch(kind, task, prompt, meta = {}) {
    const cfg = config();
    const cwd = projectOf(task, cfg);
    if (!cwd) {
      cooldown.set(`${cooldownKey(kind)}:${task.id}`, Date.now());
      noteTask(
        task.id,
        task.project
          ? `${kind} blocked: this card's project folder ${task.project} no longer exists`
          : `${kind} blocked: no project — press ù from your project's Pi session (or set "project_dir" in ${path.join(mindDir, "config.json")})`
      );
      return;
    }
    pinProject(task, cwd);
    // The /dory session works in the CURRENT project (where ù was pressed). A
    // card pinned to another project must not run there: hold it (or, in
    // runner_mode auto, run it headless in its own project instead).
    const current = workDir(cfg);
    const sameProject = !!current && path.resolve(current) === path.resolve(cwd);
    if (runnerAttached() && !sameProject && (cfg.runner_mode || "session") === "session") {
      cooldown.set(`${cooldownKey(kind)}:${task.id}`, Date.now());
      liveStart(`${activity} → held: ${task.id} belongs to ${cwd}`);
      noteTask(task.id, `${kind} waiting: this card belongs to ${cwd}, but your /dory session is in ${current ?? "(no project)"}. Press ù in a Pi session in ${cwd} (then /dory) to work on it.`);
      return;
    }
    if (runnerAttached() && sameProject) {
      // Delegate to the attached interactive Pi session: it opens a FRESH
      // session (context reset), runs the job visibly, posts the result back.
      pendingJob = {
        id: `job-${++jobCounter}`,
        kind, taskId: task.id, prompt,
        quick: !!meta.quick,
        timeoutMs: TIMEOUTS[kind],
        createdAt: Date.now(),
        deliveredAt: 0,
      };
      liveStart(`${activity} → delegated to your Pi session (/dory)`);
      return;
    }
    // SESSION MODE (default): everything Dory does runs in the user's own Pi
    // session — one visible thread, full PiForge stack, nothing hidden in a
    // subprocess. If the runner is not attached we HOLD the job rather than leak
    // it. Set "runner_mode": "auto" in config.json to allow the headless fallback.
    if ((cfg.runner_mode || "session") === "session") {
      cooldown.set(`${cooldownKey(kind)}:${task.id}`, Date.now());
      liveStart(`${activity} → waiting for your Pi session — press ù there, then /dory`);
      diary(`${kind} ${task.id} held — no Pi session attached (runner_mode=session)`);
      noteTask(
        task.id,
        `${kind} is waiting for your Pi session: run /dory in it. ` +
          `(To allow headless subprocesses instead, set "runner_mode": "auto" in ${path.join(mindDir, "config.json")}.)`,
      );
      return;
    }
    // Headless: throwaway pi subprocess.
    busy = true;
    try {
      const pf = promptFile(`${kind}-${task.id}.md`, prompt);
      const isDory = kind !== "exec";
      const res = await runPi(cfg, [...HEADLESS_ARGS[kind](cfg), "-p", `@${pf}`], cwd, TIMEOUTS[kind], { dory: isDory, kind });
      if (res.aborted) { revertStopped(kind, task.id); return; } // Dory was paused mid-job
      const detail = res.timedOut ? "timeout" : `exit ${res.code}`;
      await HANDLERS[kind](task, res.out, { quick: !!meta.quick, failed: res.timedOut, detail });
    } finally {
      busy = false;
    }
  }

  // ── runner endpoints (called by server.mjs) ───────────────────────────────

  // Heartbeat only — refreshes the attach window WITHOUT delivering a job.
  // The runner has to be able to say "still here" while it is busy, otherwise any
  // job longer than RUNNER_FRESH_MS makes dory conclude the Pi session left and
  // every following job escapes into a headless subprocess.
  function runnerPing(body = {}) {
    lastRunnerPoll = Date.now();
    // The session reports which job it's working on; once it no longer is, the
    // abort has been carried out.
    if (abortedRunnerJob && body.job !== abortedRunnerJob) abortedRunnerJob = null;
    return { ok: true, busy: !!(pendingJob && pendingJob.deliveredAt), abort: abortedRunnerJob };
  }

  function runnerPoll() {
    lastRunnerPoll = Date.now();
    if (pendingJob && !pendingJob.deliveredAt) {
      pendingJob.deliveredAt = Date.now();
      liveAppend(`… picked up by the Pi session\n`);
      return { job: { id: pendingJob.id, kind: pendingJob.kind, taskId: pendingJob.taskId, prompt: pendingJob.prompt } };
    }
    return { job: null, activity };
  }

  async function runnerResult({ id, output }) {
    if (!pendingJob || pendingJob.id !== id) return { ok: false, error: "unknown or expired job" };
    const job = pendingJob;
    pendingJob = null;
    const task = freshTask(job.taskId);
    liveAppend(`◂ result received from the Pi session (${(output ?? "").length} chars)\n`);
    if (task) await HANDLERS[job.kind](task, output ?? "", { quick: job.quick, failed: false, detail: "runner" });
    activity = "";
    return { ok: true };
  }

  // ── INGEST (always headless — pure text structuring) ──────────────────────

  async function ingest(text) {
    const cfg = config();
    activity = "ingesting requirements → PRD + tasks…";
    const pf = promptFile("ingest.md", INGEST_PROMPT + text);
    // Pure text in → text out: no tools AND no extensions (the sub-Pi isolation
    // pattern). With extensions loaded, the coding workflow guards injected
    // their rules ("read _state.md…") into the ingest prompt, and voice-input's
    // background setup outlived the job and crashed the pi process.
    const res = await runPi(cfg, ["--no-session", "--no-extensions", "--no-tools", "--thinking", cfg.dory_thinking || "off", "-p", `@${pf}`], workDir(cfg) || mindDir, INGEST_TIMEOUT_MS, { dory: true });
    const prd = between(res.out, "<<<PRD>>>", ["<<<TASKS>>>"]);
    const tasksRaw = between(res.out, "<<<TASKS>>>", ["<<<END>>>"]);
    let items;
    try {
      items = JSON.parse(stripFences(tasksRaw ?? ""));
      if (!Array.isArray(items) || !items.length || !items.every((t) => t?.title)) throw new Error("bad task array");
    } catch {
      cooldown.set("ingest", Date.now());
      diary(`ingest FAILED — could not parse Dory output (${res.timedOut ? "timeout" : `exit ${res.code}`})`);
      fs.writeFileSync(path.join(TMP_DIR, "ingest-failed-output.txt"), res.out);
      throw new Error("ingest failed — raw output in .dory-tmp/ingest-failed-output.txt");
    }

    const board = loadBoard();
    const prdNum = fs.readdirSync(path.join(mindDir, "prd")).filter((f) => f.startsWith("PRD-")).length + 1;
    const prdRel = `prd/PRD-${String(prdNum).padStart(3, "0")}.md`;
    fs.writeFileSync(path.join(mindDir, prdRel), (prd ?? "# PRD\n(missing)") + "\n");

    const created = items.map((item) =>
      createTask(board, {
        title: String(item.title).slice(0, 200),
        status: "plan_queue",
        notes: `${item.notes ?? ""}\n\nPRD: ${prdRel}`.trim(),
        priority: [1, 2, 3].includes(item.priority) ? item.priority : 3,
      }, "dory")
    );
    items.forEach((item, i) => {
      if (Array.isArray(item.depends_on)) {
        created[i].depends_on = item.depends_on
          .filter((d) => Number.isInteger(d) && d >= 0 && d < created.length && d !== i)
          .map((d) => created[d].id);
      }
    });
    saveBoard(board, `ingest → ${prdRel} + ${created.length} tasks (dory)`);
    diary(`ingested requirements → ${prdRel}, created ${created.map((t) => t.id).join(", ")} in plan_queue`);
  }

  // ── main loop: one job at a time, column priority order ───────────────────

  function depsCompleted(board, task) {
    return (task.depends_on ?? []).every((id) => board.tasks.find((t) => t.id === id)?.status === "done");
  }

  // ── long horizon: advance goal cards (one action per tick) ───────────────
  // Returns true when it did something (the tick ends there).
  async function advanceGoals(board) {
    const cfg = config();
    const L = lh(cfg);
    const goals = board.tasks
      .filter((t) => isGoal(t) && (t.status === "approved" || t.status === "in_progress"))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const goal of goals) {
      if (!board.dispatch) return false; // the master switch holds every goal
      if (coolingDown(`goal:${goal.id}`) || coolingDown(`wave:${goal.id}`)) continue;
      const cwd = projectOf(goal, cfg);
      if (!cwd) {
        cooldown.set(`goal:${goal.id}`, Date.now());
        noteTask(goal.id, goal.project ? `goal waiting: its project folder ${goal.project} no longer exists` : `goal waiting: no project — press ù from your project's Pi session (or set "project_dir" in config.json)`);
        continue;
      }
      pinProject(goal, cwd);

      // Approved goal → start wave 1 (after checking the goal test isn't already green).
      if (goal.status === "approved") {
        if (!depsCompleted(board, goal)) continue;
        if (!goal.test_cmd || !Array.isArray(goal.pending_wave) || !goal.pending_wave.length) {
          withTask(goal.id, (g) => applyMove(g, "blocked", "dory"), `${goal.id} blocked — goal without outline/test (dory)`);
          noteTask(goal.id, "this goal has no wave-1 outline or goal test — drag it back to Plan queue to replan it");
          return true;
        }
        activity = `checking goal test of ${goal.id} before wave 1…`;
        const pre = await runTest(goal, cwd);
        if (pre.aborted) return true; // paused mid-check: nothing changes
        if (pre.code === 0) {
          withTask(goal.id, (g) => applyMove(g, "blocked", "dory"), `${goal.id} blocked — goal test already passes (dory)`);
          noteTask(goal.id, "the goal test already passes before any work — it doesn't test the goal. Reply with what it should check (I'll revise it), then drag the goal back to Approved.");
          diary(`${goal.id} goal test passes before wave 1 — blocked`);
          return true;
        }
        let result = null;
        withTask(goal.id, (g, b) => {
          result = createSubtasks(b, g, g.pending_wave, 1, cfg);
          if (result.error) return;
          g.wave = 1;
          delete g.pending_wave;
          applyMove(g, "in_progress", "daemon");
        }, `${goal.id} wave 1 started (daemon)`);
        if (!result || result.error) {
          cooldown.set(`goal:${goal.id}`, Date.now());
          noteTask(goal.id, `couldn't start wave 1: ${result?.error ?? "goal deleted"} — reply to revise the outline`);
          return true;
        }
        say(
          goal.id,
          `Wave 1 started:\n${result.created.map((t) => `- ${t.id} ${t.title}`).join("\n")}` +
            `${result.notes.length ? `\n\nNotes: ${result.notes.join("; ")}` : ""}\n\nI'll plan each one when the subtasks it depends on are done; every plan comes back to you for review.`,
          `${goal.id} wave 1 posted (daemon)`
        );
        diary(`${goal.id} wave 1 started: ${result.created.map((t) => t.id).join(", ")}`);
        return true;
      }

      // Running goal → wait for the current wave; when it's done, run the goal test.
      const wave = subtasksOf(board, goal.id).filter((x) => x.wave === goal.wave);
      const blocked = wave.filter((x) => x.status === "blocked");
      if (blocked.length) {
        const msg = `paused: ${blocked.map((x) => x.id).join(", ")} ${blocked.length > 1 ? "are" : "is"} Blocked — fix it (reply + drag back to Approved) or delete it, and the goal continues`;
        if (!(goal.notes ?? "").includes(msg)) noteTask(goal.id, msg);
        continue;
      }
      if (!wave.every((x) => x.status === "done")) continue;

      activity = `wave ${goal.wave} of ${goal.id} done — running the goal test…`;
      const test = await runTest(goal, cwd);
      if (test.aborted) return true; // paused mid-check: nothing changes
      if (test.code === 0) {
        withTask(goal.id, (g) => { g.waves_done = g.wave; applyMove(g, "done", "daemon"); }, `${goal.id} done — goal test passed after wave ${goal.wave} (daemon)`);
        say(goal.id, `Goal reached: the goal test passes after wave ${goal.wave} (${subtasksOf(board, goal.id).length} subtasks).`, `${goal.id} goal reached (daemon)`);
        diary(`${goal.id} GOAL DONE after wave ${goal.wave}`);
        return true;
      }
      withTask(goal.id, (g) => { g.waves_done = g.wave; }, `${goal.id} wave ${goal.wave} done, goal test still failing (daemon)`);
      const total = subtasksOf(board, goal.id).length;
      if (goal.wave >= L.max_waves || total >= L.max_subtasks_total) {
        const which = goal.wave >= L.max_waves ? `${L.max_waves} waves` : `${L.max_subtasks_total} subtasks`;
        withTask(goal.id, (g) => {
          applyMove(g, "blocked", "daemon");
          g.notes = `${g.notes ?? ""}\n⚠ budget reached (${which}), goal test still failing. Last output:\n${test.out.slice(-1500)}`.trim();
        }, `${goal.id} blocked — budget reached (daemon)`);
        say(goal.id, `I stopped: the budget (${which}) is used up and the goal test still fails. The last test output is in the notes. Raise "long_horizon" limits in config.json, or reply with how to proceed and drag the goal back to Approved.`, `${goal.id} budget reached (daemon)`);
        diary(`${goal.id} BLOCKED — budget (${which}) reached`);
        return true;
      }
      activity = `planning wave ${goal.wave + 1} of ${goal.id}…`;
      await dispatch("wave", goal, buildWavePrompt(goal, test.out));
      return true;
    }
    return false;
  }

  async function tick() {
    // Paused: Dory does NOTHING — no replies, research, planning or building.
    // (A job still in flight when the switch flipped was stopped by stop().)
    if (!loadBoard().dispatch) {
      if (pendingJob || runningProcs.size) stop("paused");
      return;
    }
    // A delegated job is in flight — enforce its timeout, and if the runner
    // vanished before ever picking it up, hand it back to dispatch(), which
    // decides what that means: held in runner_mode=session, headless in auto.
    if (pendingJob) {
      if (!pendingJob.deliveredAt && !runnerAttached()) {
        const job = pendingJob;
        pendingJob = null;
        const task = freshTask(job.taskId);
        diary(`runner detached before pickup — re-dispatching ${job.kind} ${job.taskId}`);
        if (task) await dispatch(job.kind, task, job.prompt, { quick: job.quick });
        return;
      }
      if (Date.now() - pendingJob.createdAt > pendingJob.timeoutMs) {
        const job = pendingJob;
        pendingJob = null;
        cooldown.set(`${cooldownKey(job.kind)}:${job.taskId}`, Date.now());
        diary(`${job.kind} ${job.taskId} TIMED OUT in the Pi session runner`);
        activity = "";
      }
      return;
    }
    if (busy) return;
    busy = true;
    try {
      if (ingestQueue.length) {
        const text = ingestQueue.shift();
        busy = false; // ingest manages its own runPi; keep tick reentrancy simple
        if (!coolingDown("ingest")) await ingest(text).catch(() => {});
        return;
      }
      const board = loadBoard();

      // 1. conversations first — a waiting human beats queued work
      const awaiting = board.tasks.find(
        (t) => t.status !== "in_progress" && needsReply(t) && !coolingDown(`reply:${t.id}`)
      );
      if (awaiting) {
        busy = false;
        if (awaiting.brief) {
          activity = `responding on ${awaiting.id}…`;
          await dispatch("respond", awaiting, buildRespondPrompt(awaiting));
        } else {
          activity = `chatting on ${awaiting.id}…`;
          await dispatch("chat", awaiting, buildChatPrompt(awaiting));
        }
        return;
      }

      // 1b. goal cards — start waves, check the goal test, plan the next wave.
      //     busy stays TRUE here: the goal test can run for minutes, and a
      //     re-entrant tick (polled every 5s) would start the same wave twice.
      if (await advanceGoals(board)) return;

      // 2. in_progress continuation — next executor attempt (goal cards sit in
      //    in_progress while their subtasks run; they never execute themselves)
      const inProgress = board.tasks.find((t) => t.status === "in_progress" && !isGoal(t));
      if (inProgress) {
        busy = false;
        if (!board.dispatch) return; // paused mid-task: hold position
        const state = execState.get(inProgress.id) ?? { attempt: 1, lastTestOut: "" };
        execState.set(inProgress.id, state);
        const briefContent = fs.readFileSync(path.join(mindDir, inProgress.brief), "utf-8");
        activity = `executing ${inProgress.id} — attempt ${state.attempt}/${config().max_attempts || DEFAULT_MAX_ATTEMPTS}`;
        await dispatch("exec", inProgress, buildExecPrompt(inProgress, briefContent, state.lastTestOut));
        return;
      }

      // 2b. web research — cards whose 🔎 button was pressed, in any column but
      //     in_progress (read-only job; needs no dispatch switch, like planning).
      const toResearch = board.tasks.find(
        (t) => t.research_requested && t.status !== "in_progress" && !coolingDown(`research:${t.id}`)
      );
      if (toResearch) {
        busy = false;
        activity = `researching ${toResearch.id} on the web…`;
        await dispatch("research", toResearch, buildResearchPrompt(toResearch));
        return;
      }

      // 3. planning queue. Goal SUBTASKS are planned just in time (only once the
      //    cards they depend on are done, so the plan is written against code that
      //    exists — waves are designed around that). Normal and ingested cards are
      //    planned AHEAD by default so the human can review the whole backlog.
      //    config.json "jit_planning": "subtasks" (default) | "all" | "none".
      const jit = ["all", "none"].includes(config().jit_planning) ? config().jit_planning : "subtasks";
      const waitsForDeps = (t) => jit === "all" || (jit === "subtasks" && !!t.parent);
      const toPlan = board.tasks.find(
        (t) => t.status === "plan_queue" && !(isGoal(t) && (t.wave ?? 0) > 0) &&
          (!waitsForDeps(t) || depsCompleted(board, t)) && !coolingDown(`plan:${t.id}`)
      );
      if (toPlan) {
        busy = false;
        activity = `planning ${toPlan.id}: browsing codebase, writing brief + test…`;
        await dispatch("plan", toPlan, buildPlanPrompt(toPlan, false));
        return;
      }

      // 4. execution pickup — only when the human armed the switch
      if (!board.dispatch) return;
      const ready = board.tasks
        .filter((t) => t.status === "approved" && !isGoal(t) && depsCompleted(board, t) && !coolingDown(`exec:${t.id}`) && !coolingDown(`plan:${t.id}`))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      const next = ready[0];
      if (!next) return;
      busy = false;
      if (!next.brief || !next.test_cmd) {
        // Stateless pickup: a bare card dropped straight into approved gets a
        // quick plan + acceptance test before any code is written.
        activity = `quick plan for ${next.id} (picked up bare)…`;
        await dispatch("plan", next, buildPlanPrompt(next, true), { quick: true });
        return;
      }
      // Claim it — re-check the column at claim time (human may have dragged it away).
      if (!withTask(next.id, (x) => x.status === "approved" && applyMove(x, "in_progress", "daemon").ok, `${next.id} approved → in_progress (daemon)`)) return;
      execState.set(next.id, { attempt: 1, lastTestOut: "" });
      { const p = projectOf(next); if (p) snapshotProject(next.id, p); }
      diary(`executing ${next.id} "${next.title}"`);
      const briefContent = fs.readFileSync(path.join(mindDir, next.brief), "utf-8");
      activity = `executing ${next.id} — attempt 1/${config().max_attempts || DEFAULT_MAX_ATTEMPTS}`;
      await dispatch("exec", next, buildExecPrompt(next, briefContent, ""));
    } catch (err) {
      diary(`dory error: ${String(err.message ?? err).slice(0, 300)}`);
    } finally {
      busy = false;
      if (!pendingJob) activity = ""; // delegated jobs keep their activity label until the result arrives
    }
  }

  return {
    tick,
    activity: () => activity,
    live: () => ({ activity, log: liveLog, runner: runnerAttached() }),
    projectDir: () => workDir(config()),
    runnerPing,
    runnerPoll,
    runnerResult,
    enqueueIngest: (text) => {
      cooldown.delete("ingest");
      ingestQueue.push(text);
      setImmediate(() => void tick());
    },
    // Reactive board: a human touching a card (move, message, create) means
    // "react NOW" — clear its failure cooldowns and tick immediately.
    stop,
    wake: (taskId) => {
      if (taskId) for (const job of ["reply", "plan", "exec", "wave", "goal", "research"]) cooldown.delete(`${job}:${taskId}`);
      setImmediate(() => void tick());
    },
  };
}
