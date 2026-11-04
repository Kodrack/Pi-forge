// purpose-anchor.ts
// Prevents context drift after compaction by anchoring the session's purpose.
//
// Flow:
//   1. Captures the first user prompt as the session "purpose"
//   2. Saves it to .think/_purpose.md (survives compaction on disk)
//   3. After compaction (session_compact event), re-injects purpose + state
//      via steer message so Pi re-orients to the original task
//
// Commands:
//   /purpose ["text"]     — view or set purpose
//   /purpose-clear        — reset purpose
//   /important "text"     — append to ## Important in _purpose.md + steer immediately
//   /important -compact "text" — same but forces compaction after (cleans context)
//   /important            — list active important notes
//   /important clear      — remove all important notes from _purpose.md
//
// Install: copy to ~/.pi/agent/extensions/purpose-anchor.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");
const DORY_RUNNER_STATE = path.join(os.homedir(), ".pi", "organizer", "dory-runner.json");

// Dory stages that produce marker text only — no code, no .think/ brain files.
// Kinds dispatched by dory.mjs: chat | respond | plan | exec.
const DORY_READONLY_KINDS = ["chat", "plan", "respond", "wave"];

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("purpose-anchor");
  } catch {
    return true;
  }
}

// The Dory job this session is executing, or null. Two transports: DORY_STAGE in
// the env for headless `pi -p` jobs, dory-runner.json for in-session /dory jobs
// (dory-mode.ts cannot set env vars on its own process). The `pid` match matters:
// that file is one global slot, so without it an unrelated session — or one
// started after a /dory session died mid-job — would read someone else's job.
function doryJob(): { key: string; kind: string } | null {
  const envKind = process.env.DORY_STAGE ? String(process.env.DORY_STAGE) : null;
  if (envKind) return { key: `env:${envKind}`, kind: envKind };
  try {
    const state = JSON.parse(fs.readFileSync(DORY_RUNNER_STATE, "utf-8"));
    if (state?.running && state?.job?.kind && state.pid === process.pid) {
      return {
        key: String(state.job.id ?? state.job.taskId ?? state.job.kind),
        kind: String(state.job.kind),
      };
    }
  } catch {}
  return null;
}

function doryReadonlyStage(): string | null {
  const job = doryJob();
  return job && DORY_READONLY_KINDS.includes(job.kind) ? job.kind : null;
}

function readFileOr(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return fallback;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// True if .think/_state.md declares the task finished. Used to avoid waking
// the model after compaction when there is nothing left to do.
function taskMarkedComplete(thinkDir: string): boolean {
  try {
    const content = fs.readFileSync(path.join(thinkDir, "_state.md"), "utf-8");
    const m = content.match(/##\s*Status:\s*([^\n]+)/i);
    return !!m && /\b(complete|completed|done|finished)\b/i.test(m[1]);
  } catch {
    return false;
  }
}

// first-prompt.ts appends a big constraints block (and optionally AGENTS.md) to
// the user's first message. Strip it so the saved purpose is the user's actual
// ask — otherwise the post-compaction re-inject balloons and re-triggers
// compaction immediately, causing a loop.
function stripInjectedInstructions(text: string): string {
  let t = text;
  const markers = [
    /\n+HARD CONSTRAINTS \(you will fail/i,
    /\n+---\n#\s*AGENTS\.md/i,
  ];
  for (const re of markers) {
    const idx = t.search(re);
    if (idx !== -1) t = t.slice(0, idx);
  }
  return t.trim();
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let firstPromptCaptured = false;
  let lastUserPrompt = "";
  // Identity of the dory job this purpose belongs to. Changing = new assignment.
  let lastDoryJobKey = "";

  // Loop guard — PROGRESS-based, not compaction-count based.
  // A legitimate long task goes through many compactions with no user input;
  // that's fine AS LONG AS it's making progress (i.e. _state.md keeps changing
  // every turn, per the workflow). The loop only matters when the model is
  // woken repeatedly but _state.md is FROZEN — it's re-narrating, not working.
  // So: unlimited wakes while state changes; stop waking after the state has
  // been identical across STALL_THRESHOLD consecutive wakes. ABSOLUTE_BACKSTOP
  // is a last-resort guard against a model that makes cosmetic state edits
  // forever — set high so real autonomous runs never hit it.
  let lastStateSnapshot = "";
  let noProgressWakes = 0;
  let totalWakesSinceInput = 0;
  const STALL_THRESHOLD = 3;
  const ABSOLUTE_BACKSTOP = 15;

  pi.on("session_start", async (_event: any, ctx: any) => {
    const thinkDir = path.join(ctx.cwd, ".think");
    const purposeFile = path.join(thinkDir, "_purpose.md");

    // A dory job NEVER resumes the file on disk. Each job (chat, plan, exec) is
    // its own task in the SAME .think/ dir, so an existing _purpose.md belongs to
    // the PREVIOUS job — resuming it makes the post-compaction re-inject hand the
    // model the wrong assignment (a plan job told to "answer the human").
    const doryStage = doryJob();
    if (doryStage) {
      ctx.ui.notify(
        `purpose-anchor: dory ${doryStage.kind} job — capturing a fresh purpose (previous job's purpose is not reused)`,
        "info",
      );
    } else if (fs.existsSync(purposeFile)) {
      const purpose = readFileOr(purposeFile, "");
      if (purpose) {
        ctx.ui.notify(`purpose-anchor: resuming — "${purpose.slice(0, 60)}"`, "info");
        firstPromptCaptured = true;
      }
    } else {
      ctx.ui.notify("purpose-anchor active — will capture session purpose from first prompt", "info");
    }
  });

  // Capture every user prompt so we have the first one. A real user input
  // also resets the loop guard — the cycle only matters when NO user spoke.
  pi.on("input", (event: any) => {
    lastUserPrompt = (event as any).text ?? "";
    // Real user input resets the loop guard — the cycle only matters when no
    // human spoke between compactions.
    noProgressWakes = 0;
    totalWakesSinceInput = 0;
    lastStateSnapshot = "";
  });

  // On first turn, save the purpose if not already saved
  pi.on("turn_start", async (_event: any, ctx: any) => {
    // A NEW dory job re-opens capture. Only the FIRST in-session job gets its own
    // session: newSession() lives on the command context, and the instance built
    // by a session replacement holds only an event context, so from job 2 onward
    // dory-mode falls back to compact() + sendUserMessage() and consecutive jobs
    // share one session. Without this, session_start never fires again,
    // firstPromptCaptured stays true from job 1, and job 2 keeps job 1's purpose
    // — which is the T-007 failure (a plan job re-anchored on the chat prompt).
    const job = doryJob();
    if (job && job.key !== lastDoryJobKey) {
      lastDoryJobKey = job.key;
      firstPromptCaptured = false;
    }

    if (firstPromptCaptured || !lastUserPrompt) return;
    firstPromptCaptured = true;

    const thinkDir = path.join(ctx.cwd, ".think");
    const purposeFile = path.join(thinkDir, "_purpose.md");

    // Don't overwrite an existing purpose — session continuations keep the original.
    // EXCEPT in a dory job: the purpose there is per-job by construction (headless
    // jobs are a fresh process, in-session jobs get ctx.newSession()), while
    // .think/_purpose.md persists across jobs in the same cwd. Without this the
    // second job of a card inherits the first one's assignment and the model burns
    // its whole turn reconciling two contradictory tasks.
    if (!doryJob() && fs.existsSync(purposeFile)) return;

    ensureDir(thinkDir);
    const purposeText = stripInjectedInstructions(lastUserPrompt.trim());
    fs.writeFileSync(purposeFile, purposeText, "utf-8");
    ctx.ui.notify(`purpose-anchor: saved purpose — "${purposeText.slice(0, 60)}"`, "info");
  });

  // After compaction: re-inject purpose + state so Pi re-orients
  pi.on("session_compact", async (_event: any, ctx: any) => {
    const thinkDir = path.join(ctx.cwd, ".think");
    const purposeFile = path.join(thinkDir, "_purpose.md");
    const stateFile = path.join(thinkDir, "_state.md");
    const summaryFile = path.join(thinkDir, "_summary.md");

    const purpose = readFileOr(purposeFile, "");
    const state = readFileOr(stateFile, "");
    const summary = readFileOr(summaryFile, "");

    if (!purpose && !state) {
      ctx.ui.notify("purpose-anchor: no purpose or state files found after compaction", "info");
      return;
    }

    // READ-ONLY DORY STAGE: re-anchor on the job prompt ALONE. The standard
    // re-inject below is the .think/ workflow contract ("read _state.md, continue
    // from Next Action, update it every turn") — in a chat/plan/respond job there
    // is no .think/ workflow and the job forbids touching files, so those
    // instructions leave the model with exactly one legal action (touch
    // _state.md) and it does that until something kills the session.
    const doryStage = doryReadonlyStage();
    if (doryStage) {
      if (!purpose) {
        ctx.ui.notify(`purpose-anchor: dory ${doryStage} job compacted but no purpose on disk — not waking`, "info");
        return;
      }
      ctx.ui.notify(`purpose-anchor: dory ${doryStage} job — re-anchoring on the job prompt (no .think/ instructions)`, "info");
      await pi.sendMessage(
        {
          customType: "purpose_anchor_reinject",
          content:
            `[purpose-anchor] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.\n` +
            `Context was compacted. Here is your assignment again, verbatim — it is the ONLY thing you have to do:\n\n` +
            `---\n${purpose}\n---\n\n` +
            `Answer it NOW in your next message, using the output markers it specifies. ` +
            `Do NOT create or modify any file. Do NOT write .think/ notes. Do NOT restart or ask the user to repeat themselves.`,
          display: {
            label: "purpose-anchor",
            content: `dory ${doryStage} job re-anchored after compaction`,
          },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
      return;
    }

    // CRITICAL: if the task is already complete, do NOT wake the model. Waking
    // it (triggerTurn) when there's nothing to do creates an infinite
    // compaction↔re-inject loop — the model just re-states "done", which grows
    // context, which triggers another compaction. Stay idle; wait for the user.
    if (taskMarkedComplete(thinkDir)) {
      ctx.ui.notify("purpose-anchor: task marked complete in _state.md — staying idle, waiting for user (no re-trigger)", "info");
      return;
    }

    // Progress check: has _state.md changed since the last wake?
    if (state && state === lastStateSnapshot) {
      noProgressWakes++;
    } else {
      noProgressWakes = 0;
      lastStateSnapshot = state;
    }

    const stalled = noProgressWakes >= STALL_THRESHOLD;          // frozen state = stuck
    const backstop = totalWakesSinceInput >= ABSOLUTE_BACKSTOP;  // last-resort guard
    const wouldLoop = stalled || backstop;

    if (wouldLoop) {
      const why = stalled
        ? `_state.md unchanged across ${noProgressWakes} wakes (no progress)`
        : `${totalWakesSinceInput} wakes with no user input (backstop)`;
      ctx.ui.notify(`purpose-anchor: ${why} — NOT re-triggering, going idle. Waiting for user.`, "info");
    } else {
      ctx.ui.notify("purpose-anchor: steering Pi to re-read .think/ files after compaction", "info");
    }

    const files: string[] = [];
    if (state) files.push(".think/_state.md");
    if (summary) files.push(".think/_summary.md");

    let content = `[purpose-anchor] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.
Context was just compacted. You lost conversation history.
Your progress is saved on disk. Read it back NOW.

REQUIRED ACTIONS — do these BEFORE anything else:
1. Read .think/_state.md — it has your last action, next action, and key files.${summary ? "\n2. Read .think/_summary.md — it has your completed work summary." : ""}
${summary ? "3" : "2"}. Continue from the "Next Action" in _state.md. Do NOT restart from scratch.
${summary ? "4" : "3"}. Do NOT ask the user to repeat themselves or start a new session.

IF THE TASK IS ALREADY COMPLETE: do NOT continue and do NOT re-narrate what you did.
Set "## Status: complete" in .think/_state.md (if not already), then STOP and wait for
the user. Repeating "task done" every turn is a failure, not progress.

Original task: "${purpose || "unknown — check _state.md"}"
Files to read: ${files.join(", ") || ".think/_state.md"}`;

    await pi.sendMessage(
      {
        customType: "purpose_anchor_reinject",
        content,
        display: {
          label: "purpose-anchor",
          content: `Re-anchored after compaction: "${(purpose || "no purpose").slice(0, 60)}"`,
        },
      },
      // Only wake the model if we're not looping; otherwise leave it as context.
      { deliverAs: "steer", triggerTurn: !wouldLoop }
    );

    if (!wouldLoop) totalWakesSinceInput++;
  });

  // /purpose command — view or set the current purpose
  pi.registerCommand("purpose", {
    description: "View or set the session purpose. Usage: /purpose or /purpose \"new purpose\"",
    handler: async (args: any, ctx: any) => {
      const thinkDir = path.join(ctx.cwd, ".think");
      const purposeFile = path.join(thinkDir, "_purpose.md");
      const input = (args?.trim() ?? "").replace(/^["']|["']$/g, "");

      if (input) {
        ensureDir(thinkDir);
        fs.writeFileSync(purposeFile, input, "utf-8");
        ctx.ui.notify(`purpose-anchor: purpose set to "${input.slice(0, 80)}"`, "info");
        return;
      }

      const purpose = readFileOr(purposeFile, "");
      if (purpose) {
        ctx.ui.notify(`Current purpose: "${purpose.slice(0, 120)}"`, "info");
      } else {
        ctx.ui.notify("No purpose set. Use /purpose \"your goal\" to set one, or it auto-captures from first prompt.", "info");
      }
    },
  });

  // /purpose-clear command — remove the purpose file
  pi.registerCommand("purpose-clear", {
    description: "Clear the session purpose",
    handler: async (_args: any, ctx: any) => {
      const purposeFile = path.join(ctx.cwd, ".think", "_purpose.md");
      try {
        fs.unlinkSync(purposeFile);
        firstPromptCaptured = false;
        ctx.ui.notify("purpose-anchor: purpose cleared. Will capture from next prompt.", "info");
      } catch {
        ctx.ui.notify("purpose-anchor: no purpose file to clear.", "info");
      }
    },
  });

  // /important command — append to _purpose.md ## Important + steer immediately
  pi.registerCommand("important", {
    description: 'Add a persistent note. Usage: /important "text" or /important -compact "text"',
    handler: async (args: any, ctx: any) => {
      const raw = (args ?? "").trim();
      const thinkDir = path.join(ctx.cwd, ".think");
      const purposeFile = path.join(thinkDir, "_purpose.md");

      // /important clear — remove ## Important section
      if (raw === "clear") {
        const existing = readFileOr(purposeFile, "");
        const idx = existing.indexOf("\n## Important");
        if (idx === -1) {
          ctx.ui.notify("No important notes to clear.", "info");
          return;
        }
        fs.writeFileSync(purposeFile, existing.slice(0, idx).trimEnd() + "\n", "utf-8");
        ctx.ui.notify("purpose-anchor: important notes cleared from _purpose.md", "info");
        return;
      }

      // /important (no args) — list current notes
      if (!raw) {
        const existing = readFileOr(purposeFile, "");
        const idx = existing.indexOf("## Important");
        if (idx === -1) {
          ctx.ui.notify("No important notes. Usage: /important \"your note\"", "info");
          return;
        }
        const section = existing.slice(idx).trim();
        ctx.ui.notify(section, "info");
        return;
      }

      // Parse -compact flag
      const wantCompact = raw.startsWith("-compact");
      const text = (wantCompact ? raw.slice(8) : raw).trim().replace(/^["']|["']$/g, "");

      if (!text) {
        ctx.ui.notify("Usage: /important \"your note\" or /important -compact \"your note\"", "info");
        return;
      }

      // Append to _purpose.md under ## Important
      ensureDir(thinkDir);
      const existing = readFileOr(purposeFile, "");
      const hasSection = existing.includes("## Important");

      let updated: string;
      if (hasSection) {
        updated = existing.trimEnd() + `\n- ${text}\n`;
      } else {
        updated = existing.trimEnd() + `\n\n## Important\n- ${text}\n`;
      }
      fs.writeFileSync(purposeFile, updated, "utf-8");

      ctx.ui.notify(`purpose-anchor: added important note — "${text.slice(0, 60)}"`, "info");

      // Steer immediately
      await pi.sendMessage(
        {
          customType: "important_note",
          content: `[purpose-anchor] AUTOMATED HARNESS MESSAGE relaying a note the user typed via /important. The note itself IS from the user; this wrapper is not.\nIMPORTANT (from user): ${text}\n\nThis has been saved to _purpose.md and will persist across compaction. Apply this immediately and for all future work in this session. Do not reply to this message.`,
          display: { label: "important", content: text.slice(0, 80) },
        },
        { deliverAs: "steer" }
      );

      // Optional: force compact after
      if (wantCompact) {
        ctx.ui.notify("purpose-anchor: forcing compaction — important note is safe in _purpose.md", "info");
        (ctx as any).compact({
          customInstructions:
            "User added an important note and requested compaction. " +
            "The note is saved to .think/_purpose.md on disk. " +
            "Summarize progress normally — the important notes will be re-injected from the file.",
          onComplete: () => {
            ctx.ui.notify("purpose-anchor: compaction complete — important notes persist in _purpose.md", "info");
          },
          onError: (err: Error) => {
            ctx.ui.notify(`purpose-anchor: compaction failed — ${err.message}`, "error");
          },
        });
      }
    },
  });
}
