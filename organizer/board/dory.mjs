// organizer/board/dory.mjs — the Dory engine, hosted inside the board server.
//
// Cards are STATELESS: what Dory does with a card is defined purely by the
// column it sits in. tick() (polled by server.mjs) scans columns in priority
// order and performs ONE job at a time:
//
//   REPLY   any card (except in_progress) whose last conversation message is
//           human → planless cards get a chat answer; plan-bearing cards route
//           through the responder, which answers questions conversationally
//           OR (on a change request) rewrites tasks/T-NNN.md + tests/T-NNN.sh.
//   PLAN    plan_queue cards → browse the target project read-only, write
//           tasks/T-NNN.md (brief) + tests/T-NNN.sh (acceptance test), post
//           the plan into the conversation, auto-move → plan_created.
//   EXECUTE (dispatch ON only) highest-priority approved card with deps done →
//           in_progress → PiForge executor session → run acceptance test.
//           Pass → done. Fail → retry with test output fed back (max_attempts)
//           → blocked. Bare cards get a quick plan+test at pickup first.
//   INGEST  (/api/ingest) massive raw text → prd/PRD-NNN.md + one task card
//           per work item, created in plan_queue.
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

// Top-level sections of dory-persona.md (one per job kind that uses a persona).
const PERSONA_SECTIONS = ["Chat", "Plan", "Revise"];

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

  function cardHeader(task) {
    return `# CARD ${task.id}: ${task.title}\nPriority P${task.priority}\n\n${task.notes ? `Notes: ${task.notes}\n\n` : ""}# CONVERSATION\n${renderConversation(task)}`;
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
      const proc = spawn(cfg.pi_bin || "pi", full, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.kind ? { ...process.env, DORY_STAGE: opts.kind } : process.env,
      });
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
        if (buf.trim()) handleLine(buf);
        resolve({ out: finals.join("\n\n") || raw, code, timedOut });
      };
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
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

  // ── prompt builders (shared by headless + runner modes) ──────────────────

  function buildChatPrompt(task) {
    return `${persona("Chat")}\n\n${cardHeader(task)}`;
  }

  function buildRespondPrompt(task) {
    const currentPlan = task.brief && fs.existsSync(path.join(mindDir, task.brief))
      ? fs.readFileSync(path.join(mindDir, task.brief), "utf-8")
      : "(no plan written yet)";
    const currentTest = fs.existsSync(path.join(mindDir, `tests/${task.id}.sh`))
      ? fs.readFileSync(path.join(mindDir, `tests/${task.id}.sh`), "utf-8")
      : "(no test written yet)";
    return `${persona("Revise")}\n\n${cardHeader(task)}\n\n# CURRENT BRIEF\n${currentPlan}\n\n# CURRENT TEST\n${currentTest}`;
  }

  function buildPlanPrompt(task, quick) {
    const quickNote = quick ? "\n\nBE BRIEF: this card was queued for immediate execution — smallest viable plan, but the TEST rules still apply in full." : "";
    return `${persona("Plan")}${quickNote}\n\n${cardHeader(task)}\n\nUse the id ${task.id} in the brief heading.`;
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
      `When you believe you are done, the acceptance test must pass: ${task.test_cmd}`
    );
  }

  // ── result handlers (shared by headless + runner modes) ───────────────────

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

  function handlePlanResult(task, out, meta) {
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

  async function handleExecResult(task, _out, meta) {
    const cfg = config();
    const cwd = workDir(cfg);
    const state = execState.get(task.id) ?? { attempt: 1, lastTestOut: "" };
    const maxAttempts = cfg.max_attempts || DEFAULT_MAX_ATTEMPTS;
    const t = freshTask(task.id);
    if (!t) { execState.delete(task.id); return; } // deleted mid-run
    const test = await runTest(t, cwd);
    if (test.code === 0) {
      execState.delete(task.id);
      withTask(task.id, (x) => applyMove(x, "done", "daemon"), `${task.id} done — acceptance test passed on attempt ${state.attempt} (daemon)`);
      diary(`${task.id} DONE (attempt ${state.attempt}) — test passed`);
      return;
    }
    diary(`${task.id} attempt ${state.attempt} failed — test exit ${test.code}`);
    if (state.attempt < maxAttempts && !meta.failed) {
      execState.set(task.id, { attempt: state.attempt + 1, lastTestOut: test.out });
      return; // next tick dispatches the next attempt
    }
    execState.delete(task.id);
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
    const project = workDir(config());
    const stray = `${brief}\n${test ?? ""}`.match(/(?:\/Users|\/home|~\/)[^\s"'`)\]]*/g)?.filter(
      (p) => project && !p.replace("~", process.env.HOME ?? "~").startsWith(project) && !p.startsWith(mindDir)
    );
    if (stray?.length) {
      noteTask(taskId, `plan references paths OUTSIDE the project (${[...new Set(stray)].slice(0, 3).join(", ")}) — the executor is instructed to stay in ${project}, but review the plan before approving`);
    }
  }

  function runTest(task, cwd) {
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", task.test_cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ out: out + "\n[test timed out]", code: -1 });
      }, TEST_TIMEOUT_MS);
      proc.on("close", (code) => {
        clearTimeout(timer);
        liveAppend(`\n── acceptance test exit ${code ?? -1}\n${out.slice(-1500)}\n`);
        resolve({ out, code: code ?? -1 });
      });
    });
  }

  // ── job dispatch: runner delegation or headless subprocess ────────────────

  function runnerAttached() {
    return Date.now() - lastRunnerPoll < RUNNER_FRESH_MS;
  }

  const HANDLERS = { chat: handleChatResult, respond: handleRespondResult, plan: handlePlanResult, exec: handleExecResult };
  const HEADLESS_ARGS = {
    chat:    (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    respond: (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    plan:    (cfg) => ["--no-session", "--tools", "read,bash,web_search", "--thinking", cfg.dory_thinking || "off"],
    exec:    () => ["--no-session"], // executor: full tool set + guard stack
  };
  const TIMEOUTS = { chat: CHAT_TIMEOUT_MS, respond: PLAN_TIMEOUT_MS, plan: PLAN_TIMEOUT_MS, exec: EXEC_TIMEOUT_MS };

  async function dispatch(kind, task, prompt, meta = {}) {
    const cfg = config();
    const cwd = workDir(cfg);
    if (!cwd) {
      cooldown.set(`${kind === "exec" ? "exec" : kind === "plan" ? "plan" : "reply"}:${task.id}`, Date.now());
      noteTask(task.id, `${kind} blocked: no project — press ù from your project's Pi session (or set "project_dir" in ${path.join(mindDir, "config.json")})`);
      return;
    }
    if (runnerAttached()) {
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
      cooldown.set(`${kind === "exec" ? "exec" : kind === "plan" ? "plan" : "reply"}:${task.id}`, Date.now());
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
  function runnerPing() {
    lastRunnerPoll = Date.now();
    return { ok: true, busy: !!(pendingJob && pendingJob.deliveredAt) };
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
    const res = await runPi(cfg, ["--no-session", "--no-tools", "--thinking", cfg.dory_thinking || "off", "-p", `@${pf}`], workDir(cfg) || mindDir, INGEST_TIMEOUT_MS, { dory: true });
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

  async function tick() {
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
        cooldown.set(`${job.kind === "exec" ? "exec" : job.kind === "plan" ? "plan" : "reply"}:${job.taskId}`, Date.now());
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

      // 2. in_progress continuation — next executor attempt
      const inProgress = board.tasks.find((t) => t.status === "in_progress");
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

      // 3. planning queue
      const toPlan = board.tasks.find((t) => t.status === "plan_queue" && !coolingDown(`plan:${t.id}`));
      if (toPlan) {
        busy = false;
        activity = `planning ${toPlan.id}: browsing codebase, writing brief + test…`;
        await dispatch("plan", toPlan, buildPlanPrompt(toPlan, false));
        return;
      }

      // 4. execution pickup — only when the human armed the switch
      if (!board.dispatch) return;
      const ready = board.tasks
        .filter((t) => t.status === "approved" && depsCompleted(board, t) && !coolingDown(`exec:${t.id}`) && !coolingDown(`plan:${t.id}`))
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
    wake: (taskId) => {
      if (taskId) for (const job of ["reply", "plan", "exec"]) cooldown.delete(`${job}:${taskId}`);
      setImmediate(() => void tick());
    },
  };
}
