#!/usr/bin/env node
// organizer/board/server.mjs — kanban board server for the Dory mind repo.
//
// Zero dependencies. Serves the board UI (index.html) and a small JSON API
// over <mind-dir>/tasks.json — the single machine-readable state of the task
// pipeline. Every mutation is validated against the state machine, appended
// to the task's history, written to disk, and committed to git when the mind
// dir is a repo. External edits to tasks.json (Dory intake, the dispatch
// daemon) are picked up via fs.watch and pushed live to the UI over SSE —
// ALL writers go through the same file, so the board can never drift.
//
// Usage:  node server.mjs [mind-repo-dir]     (default: current directory)
//         PORT=4747 node server.mjs ~/dev-mind
//
// API:
//   GET    /api/board                → full tasks.json (+ live dory activity)
//   POST   /api/dispatch             {on: bool, by?} — master switch the daemon honors
//   POST   /api/tasks                {title, status? (chat|plan_queue|approved), priority?, notes?, research?, ...}
//   POST   /api/tasks/:id/message    {text, by?} — append to the card's conversation
//   POST   /api/tasks/:id/research   ask Dory to web-research the card (title +
//                                    description updated in place; not while in_progress)
//   GET    /api/tasks/:id/detail     → task + plan/test file contents (drawer UI)
//   POST   /api/tasks/:id/move       {to, by?}   — free movement, in_progress is daemon-only
//   PATCH  /api/tasks/:id            {title?, priority?, notes?, test_cmd?, depends_on?}
//   DELETE /api/tasks/:id            removes the task + its brief/test files,
//                                    strips it from other tasks' depends_on
//   GET    /api/events               → SSE, fires "changed" on any tasks.json write

import http from "http";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { createDory } from "./dory.mjs";
import { STATUSES, applyMove, createTask } from "./board-core.mjs";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIND_DIR = path.resolve(process.argv[2] || process.cwd());
const BOARD_PATH = path.join(MIND_DIR, "tasks.json");
const PORT = Number(process.env.PORT || 4747);

// Old 5-column boards are migrated on load.
const STATUS_MIGRATION = { created: "plan_queue", completed: "done" };

// ── board file ──────────────────────────────────────────────────────────────

function loadBoard() {
  try {
    const board = JSON.parse(fs.readFileSync(BOARD_PATH, "utf-8"));
    if (board.dispatch === undefined) board.dispatch = false;
    // Idempotent migration from the old 5-column schema.
    for (const t of board.tasks) {
      if (STATUS_MIGRATION[t.status]) t.status = STATUS_MIGRATION[t.status];
      if (!Array.isArray(t.conversation)) t.conversation = [];
    }
    return board;
  } catch {
    // dispatch: master switch the dispatch daemon honors — false = Dory paused,
    // true = Dory automatically picks up "approved" tasks by priority.
    return { version: 1, dispatch: false, tasks: [] };
  }
}

function saveBoard(board, commitMsg) {
  board.updated = new Date().toISOString();
  fs.writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2) + "\n");
  gitCommit(commitMsg);
}

// Commits are serialized and batched: `git add` always stages the file's
// LATEST content, so a burst of mutations collapses into one commit — batching
// the pending messages keeps that one commit message accurate. The complete
// per-mutation trail lives in each task's `history` array regardless.
let pendingMsgs = [];
let committing = false;
function gitCommit(msg) {
  pendingMsgs.push(msg);
  if (committing) return;
  committing = true;
  void drainCommits();
}
async function drainCommits() {
  while (pendingMsgs.length) {
    const message = `board: ${pendingMsgs.splice(0).join("; ")}`;
    await new Promise((resolve) => {
      // -A: Dory also writes prd/, tasks/, tests/, diary/ (.dory-tmp is gitignored)
      execFile("git", ["-C", MIND_DIR, "add", "-A"], (err) => {
        if (err) return resolve(); // not a git repo — board still works, just no history
        execFile("git", ["-C", MIND_DIR, "commit", "-m", message, "--no-gpg-sign"], () => resolve());
      });
    });
  }
  committing = false;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// ── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set();
let watchDebounce;

function broadcastChange() {
  for (const res of sseClients) res.write(`data: changed\n\n`);
}

function watchBoard() {
  // Watch the directory, not the file — editors and atomic writers replace
  // the file (rename), which kills a direct file watch.
  fs.watch(MIND_DIR, (_event, filename) => {
    if (filename !== "tasks.json") return;
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(broadcastChange, 150);
  });
}

// ── request handling ────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (req.method === "GET" && url.pathname === "/api/board") {
    return send(res, 200, { ...loadBoard(), activity: dory.activity(), project: dory.projectDir() });
  }

  if (req.method === "GET" && url.pathname === "/api/live") {
    return send(res, 200, dory.live());
  }

  // Runner protocol — an interactive Pi session attached via /dory polls for
  // jobs and posts results; the engine is then a pure orchestrator.
  // Heartbeat: keeps the runner "attached" while it is busy on a job, without
  // consuming a pending job. Separate from /poll for exactly that reason.
  if (req.method === "POST" && url.pathname === "/api/runner/ping") {
    return send(res, 200, dory.runnerPing());
  }
  if (req.method === "GET" && url.pathname === "/api/runner/poll") {
    return send(res, 200, dory.runnerPoll());
  }
  if (req.method === "POST" && url.pathname === "/api/runner/result") {
    const body = await readBody(req);
    return send(res, 200, await dory.runnerResult(body));
  }

  // Retarget Dory's project — dory-board.ts calls this on every ù press with
  // the Pi session's cwd, so Dory works on "the project where I typed pi".
  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readBody(req);
    const cfgPath = path.join(MIND_DIR, "config.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")); } catch {}
    if (body.project_dir !== undefined) {
      if (typeof body.project_dir !== "string" || (body.project_dir && !fs.existsSync(body.project_dir))) {
        return send(res, 400, { error: `project_dir does not exist: ${body.project_dir}` });
      }
      cfg.project_dir = body.project_dir;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    gitCommit(`config: project_dir → ${cfg.project_dir || "(unset)"}`);
    dory.wake(); // retarget = react now (clears nothing, just ticks)
    return send(res, 200, cfg);
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    const body = await readBody(req);
    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return send(res, 400, { error: "text required" });
    }
    dory.enqueueIngest(body.text);
    return send(res, 202, { queued: true });
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dispatch") {
    const body = await readBody(req);
    const board = loadBoard();
    board.dispatch = !!body.on;
    saveBoard(board, `dispatch ${board.dispatch ? "ON" : "OFF"} (${body.by || "human"})`);
    dory.wake();
    return send(res, 200, { dispatch: board.dispatch });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readBody(req);
    if (!body.title || typeof body.title !== "string") return send(res, 400, { error: "title required" });
    const board = loadBoard();
    const task = createTask(board, body, body.by || "human");
    // Pin the card to the project Dory is working in right now (where ù was
    // last pressed): it is only ever planned and built there.
    const project = dory.projectDir();
    if (project) task.project = project;
    if (body.research === true) task.research_requested = new Date().toISOString();
    saveBoard(board, `${task.id} created (${task.history[0].by})${task.research_requested ? " + research requested" : ""}`);
    dory.wake(task.id);
    return send(res, 201, task);
  }

  // /api/tasks/:id/move  and  /api/tasks/:id
  if (parts[1] === "tasks" && parts[2]) {
    const board = loadBoard();
    const task = board.tasks.find((t) => t.id === parts[2]);
    if (!task) return send(res, 404, { error: `unknown task ${parts[2]}` });

    if (req.method === "POST" && parts[3] === "message") {
      const body = await readBody(req);
      if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
        return send(res, 400, { error: "text required" });
      }
      const now = new Date().toISOString();
      task.conversation.push({ at: now, by: body.by === "dory" ? "dory" : "human", text: body.text.trim() });
      task.updated = now;
      saveBoard(board, `${task.id} message (${body.by || "human"})`);
      dory.wake(task.id);
      return send(res, 200, task);
    }

    // Web research on demand, in any column: the card stays where it is; Dory's
    // research job updates its title/description and posts the sources.
    if (req.method === "POST" && parts[3] === "research") {
      if (task.status === "in_progress") {
        return send(res, 409, { error: `${task.id} is being built right now — research it after it leaves In Progress` });
      }
      if (!task.research_requested) {
        task.research_requested = new Date().toISOString();
        delete task.research_failures;
        task.updated = task.research_requested;
        saveBoard(board, `${task.id} research requested (human)`);
      }
      dory.wake(task.id);
      return send(res, 200, task);
    }

    if (req.method === "GET" && parts[3] === "detail") {
      const read = (rel) => {
        try { return fs.readFileSync(path.join(MIND_DIR, rel), "utf-8"); } catch { return null; }
      };
      return send(res, 200, {
        ...task,
        plan_content: task.brief ? read(task.brief) : null,
        test_content: read(`tests/${task.id}.sh`),
      });
    }

    if (req.method === "POST" && parts[3] === "move") {
      const body = await readBody(req);
      const prevStatus = task.status;
      const result = applyMove(task, body.to, body.by || "human");
      if (result.error) return send(res, result.allowed ? 409 : 400, result);
      if (task.status !== prevStatus) {
        saveBoard(board, `${task.id} ${prevStatus} → ${task.status} (${body.by || "human"})`);
        dory.wake(task.id);
      }
      return send(res, 200, task);
    }

    if (req.method === "DELETE" && !parts[3]) {
      board.tasks = board.tasks.filter((t) => t.id !== task.id);
      // Drop dangling dependency references and Dory's files for this task.
      for (const t of board.tasks) {
        if (Array.isArray(t.depends_on)) t.depends_on = t.depends_on.filter((id) => id !== task.id);
      }
      for (const rel of [`tasks/${task.id}.md`, `tests/${task.id}.sh`]) {
        try { fs.unlinkSync(path.join(MIND_DIR, rel)); } catch {}
      }
      saveBoard(board, `${task.id} deleted (${url.searchParams.get("by") || "human"})`);
      return send(res, 200, { deleted: task.id });
    }

    if (req.method === "PATCH" && !parts[3]) {
      const body = await readBody(req);
      for (const key of ["title", "priority", "notes", "test_cmd", "depends_on", "brief"]) {
        if (body[key] !== undefined) task[key] = key === "priority" ? Number(body[key]) || task.priority : body[key];
      }
      task.updated = new Date().toISOString();
      saveBoard(board, `${task.id} edited`);
      return send(res, 200, task);
    }
  }

  send(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(UI_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err.message ?? err) });
  }
});

if (!fs.existsSync(BOARD_PATH)) saveBoard({ version: 1, tasks: [] }, "initialize empty board");

// The Dory engine runs inside this process: ingest + intake whenever work is
// queued, execution only while the board's dispatch toggle is ON. The poll is
// cheap (no-op when idle) and tick() never overlaps itself.
const dory = createDory({ mindDir: MIND_DIR, loadBoard, saveBoard, applyMove, createTask });
const DORY_POLL_MS = 5000;
setInterval(() => void dory.tick(), DORY_POLL_MS);

watchBoard();
server.listen(PORT, () => {
  console.log(`dory board — mind dir: ${MIND_DIR}`);
  console.log(`open http://localhost:${PORT}`);
});
