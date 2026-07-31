// deep-plan.ts
// `/plan <task>` — research the task in an ISOLATED sub-Pi, then execute the
// resulting plan one numbered step at a time.
//
// The gap this fills: AGENTS.md already mandates a _plan.md before any code,
// but the template it hands the model is a to-do list ("1. [ ] Analyze [what]")
// — no unknowns, no alternatives, no per-step success criterion. So the model
// dutifully writes a plan that contains no thinking, and the first real design
// decision gets made mid-implementation, five turns in, with a context already
// full of source files.
//
// Two phases:
//
//   PHASE 1 (this command)  — a throwaway `pi -p` subprocess reads the codebase
//   and searches the web, then emits a plan. Its research NEVER enters the main
//   session: the subprocess dies and only the plan text comes back. On a 50k
//   context that distinction is the whole point — ten file reads and three web
//   pages spent on planning would otherwise leave nothing for the work.
//
//   PHASE 2 (the tool_call hook) — the main session executes the plan, and this
//   extension enforces the ORDER: step N+1 cannot be checked off while step N is
//   open, and `Status: complete` is blocked while any step is unchecked.
//   acceptance-guard still decides whether "complete" is TRUE; this only decides
//   whether it is EARLY. The two compose and neither knows about the other.
//
// Why the planner is structurally read-only rather than guard-enforced: it runs
// with an explicit tool allowlist that simply has no `write`, `edit` or `bash`
// in it. There is nothing to block because there is nothing to block WITH — a
// guard can be wrong, a missing tool cannot. It also means the planner loads
// NO guard extensions (`--no-extensions` with a single explicit `-e` for
// web-search), so none of them need to know this feature exists.
//
// `--no-context-files` matters as much: AGENTS.md is the EXECUTOR's contract
// ("YOU MUST create .think/_state.md before anything else"). Handing it to a
// planner produces a planner that starts implementing.
//
// Install: copy to ~/.pi/agent/extensions/deep-plan.ts
// Toggle:  /piforge disable deep-plan | /piforge enable deep-plan

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Pin the sub-Pi to the SAME provider/model as the main session.
//
// A sub-Pi subprocess otherwise resolves its own default model, and if that
// resolution fails Pi falls back to its built-in default provider rather than
// erroring — so a config mismatch can silently route sub-Pi work to a different
// (possibly paid, cloud) model with nothing in the output to reveal it. Passing
// the flags explicitly keeps every sub-Pi call on the local model and makes a
// bad id fail loudly instead.
function subPiModelFlags(): string {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf-8"));
    const provider = s?.defaultProvider;
    const model = s?.defaultModel;
    return provider && model ? ` --provider ${provider} --model "${model}"` : "";
  } catch {
    return "";
  }
}


const execAsync = promisify(exec);
const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// Planning is the one place a long think earns its cost — it happens once, in a
// subprocess, and everything downstream inherits its quality. This is NOT the
// `--thinking off` the other sub-Pi callers use: those synthesize text that
// would be polluted by a reasoning trace, whereas here the trace is discarded
// and only the marker block is read. Drop to "low" if your model rambles.
const PLANNER_THINKING = "medium";

// Planning reads files and hits the network; it is slower than a normal turn.
const PLANNER_TIMEOUT_MS = 600000;

// Tools the planner may use. No write/edit/bash — see header. `read` and the
// search tools are enough to explore a codebase; `web_search` comes from the
// one extension we load explicitly.
const PLANNER_TOOLS = "read,ls,grep,ripgrep,fd,find,web_search";

// Stop enforcing step order after this many blocks — a model wedged against its
// own plan must not be trapped against it forever.
const MAX_BLOCKS_PER_SESSION = 3;

const PLAN_PATH = ".think/_plan.md";

// The planner's whole deliverable. Mirrors the marker convention used elsewhere
// so a truncated or rambling reply is detectable rather than silently half-read.
const OPEN = "<<<PLAN>>>";
const CLOSE = "<<<END>>>";

// ---------- HELPERS ----------
function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("deep-plan");
  } catch {
    return true;
  }
}

function thinkDir(cwd: string): string {
  return path.join(cwd, ".think");
}

function planFile(cwd: string): string {
  return path.join(cwd, PLAN_PATH);
}

function ensureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

// Steps are `1. [ ] text` / `1. [x] text`, the shape AGENTS.md already documents.
type Step = { n: number; done: boolean; text: string };

function parseSteps(planText: string): Step[] {
  const steps: Step[] = [];
  for (const line of planText.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\.\s*\[( |x|X)\]\s*(.*)$/);
    if (m) steps.push({ n: parseInt(m[1], 10), done: m[2].toLowerCase() === "x", text: m[3].trim() });
  }
  return steps;
}

function readPlanSteps(cwd: string): Step[] {
  try {
    return parseSteps(fs.readFileSync(planFile(cwd), "utf-8"));
  } catch {
    return [];
  }
}

// The lowest-numbered unchecked step — the only one the model may be working on.
function currentStep(steps: Step[]): Step | null {
  return steps.find((s) => !s.done) ?? null;
}

const COMPLETE_STATUS = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;

function isStatePath(filePath: string): boolean {
  return /\.think[\/\\]_state\.md$/.test(filePath);
}

function isPlanPath(filePath: string): boolean {
  return /\.think[\/\\]_plan\.md$/.test(filePath);
}

// Text a write/edit call is about to put on disk, whichever param carries it.
function payloadOf(input: Record<string, any>): string {
  return String(input.content ?? input.new_string ?? input.newText ?? input.text ?? "");
}

// ---------- THE PLANNER PROMPT ----------
// Written to disk and passed as @file: a long prompt on the command line hits
// ARG_MAX and gets mangled by shell quoting.
function plannerPrompt(task: string, cwd: string): string {
  return `You are a PLANNER. You are NOT implementing anything — a different session will do that later, and it will only ever see the plan you write here. You have no write, edit or bash tools; do not ask for them.

Project root: ${cwd}

THE TASK:
${task}

WHAT TO DO, IN ORDER:

1. EXPLORE. Read the files this task will touch. Use grep/ripgrep to find the relevant code before reading whole files. Establish what already exists — the conventions in use, the shape of the code you will extend. Do not guess.

2. RESEARCH THE UNKNOWNS. For every external library, API, framework version or error message this task depends on, call web_search. Your training data is stale; a wrong API assumption written into a plan becomes a wrong implementation nobody catches until it runs. If the task has NO external unknowns, say so explicitly — that is a valid finding, not a skipped step.

3. DECIDE. Pick an approach. Name at least one alternative you considered and why you rejected it. A plan with no rejected alternative is a plan that did not make a decision.

4. WRITE THE PLAN in the exact format below. Steps must be small enough that ONE of them is one turn of work — if a step needs more than about 60 lines of new code, split it. Every step needs a check: a concrete, observable way to tell it worked. "Verify it works" is not a check; "run node app.js, expect exit 0 and 'ready' on stdout" is.

Emit NOTHING after the closing marker.

${OPEN}
# Plan: <short title>

## Goal
<what "done" looks like, in one or two sentences, from outside the code>

## What exists now
<what you found while exploring — files, entry points, conventions to follow>

## Unknowns researched
<for each: the question, what you searched, what you found. Or exactly: "None — no external dependencies.">

## Approach
<the approach you chose>

## Rejected
<at least one alternative and why not>

## Steps
1. [ ] <action> — CHECK: <observable check>
2. [ ] <action> — CHECK: <observable check>
3. [ ] <action> — CHECK: <observable check>

## Risks
<what is most likely to go wrong, and the first thing to try if it does>
${CLOSE}
`;
}

function extractPlan(stdout: string): string | null {
  const start = stdout.indexOf(OPEN);
  if (start === -1) return null;
  const end = stdout.indexOf(CLOSE, start + OPEN.length);
  // No closing marker = the planner was cut off mid-plan. Salvage it rather than
  // discarding several minutes of research; the missing tail is visible to the
  // user and they can re-run.
  const body = end === -1
    ? stdout.slice(start + OPEN.length)
    : stdout.slice(start + OPEN.length, end);
  const text = body.trim();
  return text.length > 0 ? text : null;
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let blocksThisSession = 0;
  let gaveUp = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    const steps = readPlanSteps(ctx.cwd || process.cwd());
    if (steps.length > 0) {
      const open = steps.filter((s) => !s.done).length;
      ctx.ui.notify(
        `deep-plan active — ${PLAN_PATH} has ${steps.length} steps, ${open} open (step order enforced)`,
        "info",
      );
    } else {
      ctx.ui.notify(`deep-plan active — /plan <task> to research and plan in an isolated sub-Pi`, "info");
    }
  });

  pi.registerCommand("plan", {
    description: "Research a task in an isolated sub-Pi and write .think/_plan.md. Usage: /plan <task>",
    handler: async (args: any, ctx: any) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify(`Usage: /plan <task description>\nExisting plan: ${PLAN_PATH}`, "info");
        return;
      }

      const cwd = ctx?.cwd || process.cwd();
      const dir = thinkDir(cwd);
      ensureDir(dir);

      // Never silently clobber a plan that still has work in it.
      const existing = readPlanSteps(cwd);
      const openSteps = existing.filter((s) => !s.done).length;
      if (openSteps > 0) {
        const backup = path.join(dir, `_plan-superseded-${existing.length}steps.md`);
        try { fs.copyFileSync(planFile(cwd), backup); } catch {}
        ctx.ui.notify(
          `deep-plan: existing plan had ${openSteps} open step(s) — copied to ${path.basename(backup)} before replacing`,
          "warning",
        );
      }

      const promptFile = path.join(dir, "_plan-prompt.md");
      fs.writeFileSync(promptFile, plannerPrompt(task, cwd), "utf-8");

      // The one extension the planner loads. Resolved next to this file so it
      // works from a dev symlink or a real install; skipped if absent, in which
      // case the planner simply has no web_search and says so in Unknowns.
      const webSearch = path.join(path.dirname(new URL(import.meta.url).pathname), "web-search.ts");
      const withSearch = fs.existsSync(webSearch);
      const tools = withSearch ? PLANNER_TOOLS : PLANNER_TOOLS.replace(",web_search", "");

      const cmd =
        `pi --no-session --no-extensions ` +
        (withSearch ? `-e "${webSearch}" ` : "") +
        `--tools ${tools} --no-context-files --no-skills ` +
        `${subPiModelFlags()} --thinking ${PLANNER_THINKING} -p "@${promptFile}" < /dev/null`;

      ctx.ui.notify(
        `deep-plan: researching in an isolated sub-Pi (read-only, ${withSearch ? "web search on" : "NO web search — web-search.ts not found"}). ` +
        `Its context is discarded; only the plan comes back. This takes a few minutes.`,
        "info",
      );

      let stdout = "";
      try {
        const r = await execAsync(cmd, { timeout: PLANNER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, cwd });
        stdout = r.stdout || "";
      } catch (err: any) {
        // A timeout still leaves everything printed so far on err.stdout.
        stdout = err?.stdout || "";
        if (!stdout) {
          ctx.ui.notify(`deep-plan: planner failed — ${err?.message ?? "no output"}`, "error");
          return;
        }
        ctx.ui.notify(`deep-plan: planner hit the ${PLANNER_TIMEOUT_MS / 1000}s timeout — salvaging partial output`, "warning");
      }

      const plan = extractPlan(stdout);
      if (!plan) {
        const dump = path.join(dir, "_plan-raw.md");
        try { fs.writeFileSync(dump, stdout, "utf-8"); } catch {}
        ctx.ui.notify(
          `deep-plan: no ${OPEN} block in the planner's output (${stdout.length} chars). ` +
          `Raw output saved to ${dump} — re-run /plan, or write ${PLAN_PATH} by hand.`,
          "error",
        );
        return;
      }

      fs.writeFileSync(planFile(cwd), plan + "\n", "utf-8");
      const steps = parseSteps(plan);

      if (steps.length === 0) {
        ctx.ui.notify(
          `deep-plan: wrote ${PLAN_PATH}, but it has no "N. [ ] ..." steps — step order will NOT be enforced. ` +
          `Check the plan and add numbered checkboxes if you want gating.`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        `deep-plan: ${PLAN_PATH} written — ${steps.length} steps. Step order is now enforced.\n` +
        steps.map((s) => `  ${s.n}. ${s.text.slice(0, 90)}`).join("\n"),
        "info",
      );

      // Hand the plan to the model as its assignment. The research that produced
      // it stays in the dead subprocess — this is the only thing that crosses.
      await pi.sendMessage(
        {
          customType: "deep_plan_handoff",
          content:
            `[deep-plan] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.\n` +
            `A plan for this task has been researched and written to ${PLAN_PATH}. It is your assignment.\n\n` +
            `---\n${plan}\n---\n\n` +
            `Work it ONE step at a time, in order, lowest unchecked number first. For each step: do the work, ` +
            `run its CHECK, and only then mark that step [x] in ${PLAN_PATH}. ` +
            `Marking a step done out of order is blocked, and so is declaring the task complete while any step is open. ` +
            `Start with step 1 NOW.`,
          display: { label: "deep-plan", content: `plan handed off — ${steps.length} steps` },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  });

  pi.registerCommand("plan-status", {
    description: "Show progress against .think/_plan.md",
    handler: async (_args: any, ctx: any) => {
      const steps = readPlanSteps(ctx.cwd || process.cwd());
      if (steps.length === 0) {
        ctx.ui.notify(`deep-plan: no steps in ${PLAN_PATH}. Run /plan <task> to create one.`, "info");
        return;
      }
      const done = steps.filter((s) => s.done).length;
      ctx.ui.notify(
        `deep-plan: ${done}/${steps.length} steps done${gaveUp ? " (order enforcement OFF — gave up after repeated blocks)" : ""}\n` +
        steps.map((s) => `  ${s.done ? "[x]" : "[ ]"} ${s.n}. ${s.text.slice(0, 90)}`).join("\n"),
        "info",
      );
    },
  });

  // ---------- PHASE 2: step-order enforcement ----------
  pi.on("tool_call", async (event: any, _ctx: any) => {
    if (gaveUp) return;

    const toolName = event.toolName ?? "";
    if (toolName !== "write" && toolName !== "edit") return;

    const input = (event.input as Record<string, any>) ?? {};
    const filePath = String(input.path ?? input.file_path ?? "");
    if (!filePath) return;

    const cwd = process.cwd();
    const steps = readPlanSteps(cwd);
    if (steps.length === 0) return; // no plan, or a plan with no checkboxes — nothing to enforce

    // (a) Declaring the whole task complete while steps remain open.
    if (isStatePath(filePath) && COMPLETE_STATUS.test(payloadOf(input))) {
      const open = steps.filter((s) => !s.done);
      if (open.length > 0) {
        blocksThisSession++;
        if (blocksThisSession > MAX_BLOCKS_PER_SESSION) {
          gaveUp = true;
          return;
        }
        return {
          block: true,
          reason:
            `BLOCKED: you are declaring the task complete, but ${PLAN_PATH} still has ` +
            `${open.length} unchecked step(s): ${open.map((s) => s.n).join(", ")}. ` +
            `Do NOT retry this write. Do ONE of these instead: ` +
            `(1) if those steps are genuinely done, mark them [x] in ${PLAN_PATH} first — one at a time, in order, ` +
            `running each step's CHECK before you mark it; ` +
            `(2) if they are NOT done, work step ${open[0].n} now: "${open[0].text.slice(0, 120)}"; ` +
            `(3) if a step turned out to be unnecessary, edit ${PLAN_PATH} to say so and mark it [x] with a one-line reason.`,
        };
      }
    }

    // (b) Checking off a step out of order.
    if (isPlanPath(filePath)) {
      const after = parseSteps(payloadOf(input));
      if (after.length === 0) return; // an edit that didn't touch checkbox lines

      const cur = currentStep(steps);
      const newlyDone = after.filter((s) => s.done && steps.some((o) => o.n === s.n && !o.done));
      const skipped = cur ? newlyDone.filter((s) => s.n > cur.n) : [];

      if (skipped.length > 0 && cur) {
        blocksThisSession++;
        if (blocksThisSession > MAX_BLOCKS_PER_SESSION) {
          gaveUp = true;
          return;
        }
        return {
          block: true,
          reason:
            `BLOCKED: you are marking step ${skipped.map((s) => s.n).join(", ")} done while step ${cur.n} ` +
            `is still open. The plan is ordered — later steps assume the earlier ones exist. ` +
            `Do NOT retry this write. Work step ${cur.n} first: "${cur.text.slice(0, 120)}". ` +
            `Run its CHECK, mark ONLY step ${cur.n} as [x], then move on. ` +
            `If step ${cur.n} is genuinely unnecessary, mark it [x] with a one-line reason in the same edit — ` +
            `but do not silently skip past it.`,
        };
      }
    }
  });
}
