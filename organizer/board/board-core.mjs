// organizer/board/board-core.mjs — the board's card rules, shared by the HTTP
// server (server.mjs), the Dory engine (via the functions server.mjs passes it)
// and the tests. Pure functions over the in-memory board; no I/O.

// The 7-column, conversation-driven pipeline. Cards are STATELESS — behavior
// is defined purely by the column a card sits in (see dory.mjs):
//   chat         — conversation thread with Dory
//   plan_queue   — Dory writes plan + acceptance test, auto-moves onward
//   plan_created — human reviews; feedback in the conversation → Dory revises
//   approved     — Dory's to-do queue (dispatch ON); bare cards get a quick
//                  plan+test at pickup
//   in_progress  — engine-owned while executing
//   blocked      — attempts exhausted, needs the human
//   done         — acceptance test passed
// Humans drag cards anywhere except INTO in_progress (that would claim work
// nobody is doing); engine moves use by="dory"/"daemon".
export const STATUSES = ["chat", "plan_queue", "plan_created", "approved", "in_progress", "blocked", "done"];

export function nextId(board) {
  const max = board.tasks.reduce((m, t) => Math.max(m, Number(t.id.replace(/\D/g, "")) || 0), 0);
  return `T-${String(max + 1).padStart(3, "0")}`;
}

// Shared by the HTTP API and the Dory engine — one code path for mutations.
// Cards are stateless, so movement is free — the only restriction is that
// nobody but the daemon may claim a card as in_progress.
export function applyMove(task, to, by) {
  if (!STATUSES.includes(to)) return { error: `unknown status "${to}"` };
  if (to === task.status) return { ok: true };
  if (to === "in_progress" && by !== "daemon") {
    return { error: `only the daemon moves cards into in_progress — drop it in "approved" and turn dispatch on`, allowed: STATUSES.filter((s) => s !== "in_progress") };
  }
  const now = new Date().toISOString();
  task.history.push({ at: now, from: task.status, to, by });
  task.status = to;
  task.updated = now;
  return { ok: true };
}

// Columns a card may be born in: a chat thread, straight to planning, or
// straight to the execution queue ("I need this done quickly").
export const CREATABLE_IN = ["chat", "plan_queue", "approved"];

export function createTask(board, fields, by) {
  const now = new Date().toISOString();
  const status = CREATABLE_IN.includes(fields.status) ? fields.status : "chat";
  const task = {
    id: nextId(board),
    title: String(fields.title).trim(),
    status,
    priority: Number(fields.priority) || 3,
    notes: fields.notes || "",
    test_cmd: fields.test_cmd || "",
    depends_on: Array.isArray(fields.depends_on) ? fields.depends_on : [],
    brief: fields.brief || "", // path to tasks/T-NNN.md once Dory planned it
    conversation: [],          // {at, by: "human"|"dory", text}
    created: now,
    updated: now,
    history: [{ at: now, from: null, to: status, by }],
  };
  board.tasks.push(task);
  return task;
}
