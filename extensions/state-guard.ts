// state-guard.ts
// Hard-enforces the .think/_state.md workflow on local LLMs.
//
// Four enforcement points:
//   1. Session start: steers model to read _state.md before anything else
//   2. Tool calls: blocks source file reads until _state.md has been read
//   3. Turn end: steers model to update _state.md if stale (every N turns)
//   4. Reopen guard: if a new user prompt arrives while _state.md says
//      "Status: complete", blocks writes/edits to non-.think/ files until
//      _state.md has been rewritten (stale-complete state survives compaction
//      and silently poisons recovery — turn discipline into a hard rule)
//
// Install: copy to ~/.pi/agent/extensions/state-guard.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");

// How many turns without a _state.md write before we inject a reminder
const STALE_TURN_THRESHOLD = 5;

// Tools that are allowed before _state.md is read (don't block everything)
const ALWAYS_ALLOWED_TOOLS = new Set([
  "bash",        // needed for ls, find, etc.
  "list_files",
  "distill_codebase",
  "explore_codebase",
]);

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("state-guard");
  } catch {
    return true;
  }
}

function isThinkPath(filePath: string): boolean {
  return filePath.includes(".think/") || filePath.includes(".think\\");
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function isThinkAtRoot(filePath: string, cwd: string): boolean {
  // Expand tilde and normalize paths
  const normalizedPath = path.resolve(expandTilde(filePath));
  const normalizedCwd = path.resolve(expandTilde(cwd));
  const rootThink = path.join(normalizedCwd, ".think");
  // Check if path starts with the root .think directory
  return normalizedPath.startsWith(rootThink + path.sep) || normalizedPath === rootThink;
}

function isStatePath(filePath: string): boolean {
  return filePath.includes("_state.md");
}

// The canonical ".think/" brain files. These must ALWAYS live in .think/ —
// never inside the project/deliverable folder (e.g. test/_state.md). The model
// often conflates "the folder I'm building in" with its brain dir; when it
// does, every guard that reads .think/_state.md goes blind.
function isBrainFile(filePath: string): boolean {
  const base = (filePath.split(/[\\/]/).pop() || "").trim();
  return (
    /^(_state|_plan|_summary|_purpose|_decisions|_knowledge|_knowledge-manifest)\.md$/i.test(base) ||
    /^step-\d+\.md$/i.test(base)
  );
}

// Completion-aware: if _state.md says the task is done, the stale-update nag is
// counterproductive — there's nothing left to track. Lets the model rest.
function taskMarkedComplete(cwd: string): boolean {
  try {
    const content = fs.readFileSync(path.join(cwd, ".think", "_state.md"), "utf-8");
    const m = content.match(/##\s*Status:\s*([^\n]+)/i);
    return !!m && /\b(complete|completed|done|finished)\b/i.test(m[1]);
  } catch {
    return false;
  }
}

const STALE_MESSAGE = `[state-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it or mention it; act on it.
You haven't updated .think/_state.md in the last ${STALE_TURN_THRESHOLD} turns.
Your progress will be lost if context compacts.

ACTION REQUIRED — update .think/_state.md NOW with this format:

## Task: [one-line description]
## Progress: Step [N] of [total] — [step name]
## Completed: [list completed steps briefly]
## Status: in-progress | blocked | complete
## Last Action: [what you just did]
## Next Action: [EXACTLY what to do next — be specific]
## Key Files:
- [file]: [what it contains]
## Decisions: [key choices made, e.g., "using vanilla JS"]
## Read First: [which 1-2 files to read to continue]

Keep it concise but complete. This is your recovery point after compaction.`;

const READ_FIRST_MESSAGE = `[state-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
Read .think/_state.md FIRST before doing anything else.
If it doesn't exist, create it with this format:

## Task: [describe what the user asked]
## Progress: Step 0 of ? — Planning
## Completed: none yet
## Status: starting
## Next Action: [your first action]
## Key Files: none yet

This is your lifeline across compactions — write everything you need to resume.`;

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let stateReadThisSession = false;
  let turnsSinceStateWrite = 0;
  let stateFileExists = false;
  let readReminderSent = false;
  let turnHadStateWrite = false;
  let reopenPending = false; // user sent a new prompt while _state.md said complete

  // REOPEN GUARD: each user input, check whether _state.md claims the task is
  // done. If so, the model must rewrite _state.md before touching source files.
  pi.on("input", (_event: any) => {
    reopenPending = taskMarkedComplete(process.cwd());
    return { action: "continue" as const };
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const stateFile = path.join(ctx.cwd, ".think", "_state.md");
    stateFileExists = fs.existsSync(stateFile);

    if (stateFileExists) {
      ctx.ui.notify("state-guard active — will enforce _state.md read before source files", "info");
    } else {
      ctx.ui.notify("state-guard active — will enforce _state.md creation on first turn", "info");
    }
  });

  pi.on("turn_start", async (_event: any, _ctx: any) => {
    turnHadStateWrite = false;
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.toolName ?? "";
    const input = event.input as Record<string, any> ?? {};
    let filePath = input.path ?? input.file_path ?? "";

    // BRAIN FILES MUST LIVE IN .think/ — but don't make the model get the path
    // right. If it targets a brain file (_state.md, _plan.md, step-NNN.md, …)
    // anywhere outside .think/ (e.g. test/_state.md), silently REWRITE the path
    // to .think/<base> by mutating event.input in place (pi supports this; see
    // ToolCallEventResult docs). Removes the decision instead of correcting it.
    // Applies to write/edit AND read, so the model can use any path and still
    // hit the one canonical file every guard reads.
    if (
      (toolName === "write" || toolName === "edit" || toolName === "read") &&
      filePath &&
      isBrainFile(filePath) &&
      !isThinkAtRoot(filePath, ctx.cwd)
    ) {
      const base = filePath.split(/[\\/]/).pop() || "_state.md";
      const corrected = `.think/${base}`;
      if (input.path !== undefined) input.path = corrected;
      if (input.file_path !== undefined) input.file_path = corrected;
      filePath = corrected; // keep downstream tracking in sync
      ctx.ui.notify(`state-guard: redirected ${base} → .think/${base} (brain files live in .think/)`, "info");
      // fall through — it's now a .think/ write and gets tracked below
    }

    // Track reads of _state.md
    if (toolName === "read" && isStatePath(filePath)) {
      stateReadThisSession = true;
      return;
    }

    // Track writes to _state.md
    if ((toolName === "write" || toolName === "edit") && isStatePath(filePath)) {
      stateReadThisSession = true; // writing counts as "aware of state"
      turnHadStateWrite = true;
      turnsSinceStateWrite = 0;
      stateFileExists = true;
      reopenPending = false; // state rewritten — reopen satisfied
      return;
    }

    // Allow .think/ reads/writes ONLY if at root level
    if (isThinkPath(filePath)) {
      if (!isThinkAtRoot(filePath, ctx.cwd)) {
        return {
          block: true,
          reason:
            `BLOCKED: .think/ must be at project root, not inside subfolders. ` +
            `You tried to access: ${filePath}\n` +
            `Use: ${path.join(ctx.cwd, ".think")}/ instead.\n` +
            `The .think/ directory at root is symlinked to your session folder.`,
        };
      }
      return; // at root, allow it
    }

    // REOPEN GUARD: _state.md says "complete" but the user sent a new prompt.
    // Hard-block source writes/edits until _state.md is rewritten — otherwise
    // the stale "complete" record survives the next compaction and the model
    // recovers into a state file that lies about reality.
    if (reopenPending && (toolName === "write" || toolName === "edit")) {
      return {
        block: true,
        reason:
          `BLOCKED: .think/_state.md still says "Status: complete", but the user sent a new request. ` +
          `The state file is stale — fix it BEFORE editing source files.\n` +
          `1. Rewrite .think/_state.md NOW with:\n` +
          `   ## Status: in-progress\n` +
          `   ## Task: [the user's new request or reported problem]\n` +
          `   ## Next Action: [your first concrete step]\n` +
          `2. THEN retry this edit.\n` +
          `Do NOT retry this tool call until _state.md is updated.`,
      };
    }

    // Allow non-file tools
    if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return;

    // Block source file reads if _state.md hasn't been read yet AND exists
    if (!stateReadThisSession && stateFileExists && toolName === "read") {
      if (!readReminderSent) {
        readReminderSent = true;
        return {
          block: true,
          reason:
            `read blocked: you haven't read .think/_state.md yet this session. ` +
            `Read it FIRST — it contains your current progress, last action, and next steps. ` +
            `Then continue with your work.`,
        };
      }
      // After first block, allow reads but steer on next turn
      return;
    }

    // Block source file reads if _state.md doesn't exist yet and this is a new task
    if (!stateReadThisSession && !stateFileExists && toolName === "read" && !readReminderSent) {
      readReminderSent = true;
      // Don't hard-block for non-existent state — just steer
      await pi.sendMessage(
        {
          customType: "state_guard_create",
          content: `[state-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.
No .think/_state.md found. Create one NOW before reading source files.

Write this to .think/_state.md:
## Task: [describe what the user asked]
## Progress: Step 0 of ? — Planning
## Completed: none yet
## Status: starting
## Next Action: [your first action]
## Key Files: none yet
## Decisions: [any constraints from user, e.g., "vanilla JS only"]

Then continue with your work.`,
          display: {
            label: "state-guard",
            content: "No _state.md found — steering model to create one",
          },
        },
        { deliverAs: "steer" }
      );
      stateReadThisSession = true; // don't block further
      return;
    }
  });

  // Reset counters after compaction — don't nag immediately after context reset
  pi.on("session_compact", async (_event: any, ctx: any) => {
    turnsSinceStateWrite = 0;
    stateReadThisSession = false;
    readReminderSent = false;
    turnHadStateWrite = false;
    ctx.ui.notify("state-guard: counters reset after compaction", "info");
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    // Count turns since last _state.md write
    if (turnHadStateWrite) {
      turnsSinceStateWrite = 0;
    } else {
      turnsSinceStateWrite++;
    }
    turnHadStateWrite = false;

    // Don't nag about stale state once the task is complete — nothing to track.
    if (taskMarkedComplete(ctx.cwd)) return;

    // Steer if stale
    if (turnsSinceStateWrite >= STALE_TURN_THRESHOLD && stateReadThisSession) {
      ctx.ui.notify(
        `state-guard: ${turnsSinceStateWrite} turns without _state.md update — injecting reminder`,
        "info"
      );

      await pi.sendMessage(
        {
          customType: "state_guard_stale",
          content: STALE_MESSAGE,
          display: {
            label: "state-guard",
            content: `_state.md stale (${turnsSinceStateWrite} turns) — forcing update`,
          },
        },
        { deliverAs: "steer" }
      );

      // Reset counter so we don't spam every turn
      turnsSinceStateWrite = 0;
    }
  });

  pi.registerCommand("state-guard", {
    description: "Show state-guard status",
    handler: async (_args: any, ctx: any) => {
      const stateFile = path.join(ctx.cwd, ".think", "_state.md");
      const exists = fs.existsSync(stateFile);
      ctx.ui.notify(
        `state-guard: _state.md ${exists ? "exists" : "MISSING"} | ` +
        `read this session: ${stateReadThisSession} | ` +
        `turns since write: ${turnsSinceStateWrite} | ` +
        `stale threshold: ${STALE_TURN_THRESHOLD} turns | ` +
        `reopen pending: ${reopenPending}`,
        "info"
      );
    },
  });
}
