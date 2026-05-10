// state-guard.ts
// Hard-enforces the .think/_state.md workflow on local LLMs.
//
// Three enforcement points:
//   1. Session start: steers model to read _state.md before anything else
//   2. Tool calls: blocks source file reads until _state.md has been read
//   3. Turn end: steers model to update _state.md if stale (every N turns)
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

function isStatePath(filePath: string): boolean {
  return filePath.includes("_state.md");
}

const STALE_MESSAGE = `[state-guard] You haven't updated .think/_state.md in the last ${STALE_TURN_THRESHOLD} turns.
Your progress will be lost if context compacts.

ACTION REQUIRED — update .think/_state.md NOW with:
## Last Action: [what you just did]
## Next Action: [exactly what to do next]
## Key Files: [files that matter, one line each]

Keep it SHORT. Then continue working.`;

const READ_FIRST_MESSAGE = `[state-guard] Read .think/_state.md FIRST before doing anything else.
If it doesn't exist, create it with your current task and next action.
This is your lifeline between turns and across compactions.`;

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let stateReadThisSession = false;
  let turnsSinceStateWrite = 0;
  let stateFileExists = false;
  let readReminderSent = false;
  let turnHadStateWrite = false;

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
    const filePath = input.path ?? input.file_path ?? "";

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
      return;
    }

    // Allow .think/ reads/writes — those are fine
    if (isThinkPath(filePath)) return;

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
          content: `[state-guard] No .think/_state.md found. Create one NOW before reading source files.\n\nWrite this to .think/_state.md:\n## Task: [describe what the user asked]\n## Current Step: 0\n## Status: starting\n## Next Action: [your first action]\n\nThen continue with your work.`,
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

  pi.on("turn_end", async (_event: any, ctx: any) => {
    // Count turns since last _state.md write
    if (turnHadStateWrite) {
      turnsSinceStateWrite = 0;
    } else {
      turnsSinceStateWrite++;
    }
    turnHadStateWrite = false;

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
        `stale threshold: ${STALE_TURN_THRESHOLD} turns`,
        "info"
      );
    },
  });
}
