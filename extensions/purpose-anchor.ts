// purpose-anchor.ts
// Prevents context drift after compaction by anchoring the session's purpose.
//
// Flow:
//   1. Captures the first user prompt as the session "purpose"
//   2. Saves it to .think/_purpose.md (survives compaction on disk)
//   3. After compaction (session_compact event), re-injects purpose + state
//      via steer message so Pi re-orients to the original task
//
// Install: copy to ~/.pi/agent/extensions/purpose-anchor.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("purpose-anchor");
  } catch {
    return true;
  }
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

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let firstPromptCaptured = false;
  let lastUserPrompt = "";

  pi.on("session_start", async (_event: any, ctx: any) => {
    const thinkDir = path.join(ctx.cwd, ".think");
    const purposeFile = path.join(thinkDir, "_purpose.md");

    if (fs.existsSync(purposeFile)) {
      const purpose = readFileOr(purposeFile, "");
      if (purpose) {
        ctx.ui.notify(`purpose-anchor: resuming — "${purpose.slice(0, 60)}"`, "info");
        firstPromptCaptured = true;
      }
    } else {
      ctx.ui.notify("purpose-anchor active — will capture session purpose from first prompt", "info");
    }
  });

  // Capture every user prompt so we have the first one
  pi.on("input", (event: any) => {
    lastUserPrompt = (event as any).text ?? "";
  });

  // On first turn, save the purpose if not already saved
  pi.on("turn_start", async (_event: any, ctx: any) => {
    if (firstPromptCaptured || !lastUserPrompt) return;
    firstPromptCaptured = true;

    const thinkDir = path.join(ctx.cwd, ".think");
    const purposeFile = path.join(thinkDir, "_purpose.md");

    // Don't overwrite an existing purpose — session continuations keep the original
    if (fs.existsSync(purposeFile)) return;

    ensureDir(thinkDir);
    fs.writeFileSync(purposeFile, lastUserPrompt.trim(), "utf-8");
    ctx.ui.notify(`purpose-anchor: saved purpose — "${lastUserPrompt.trim().slice(0, 60)}"`, "info");
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

    ctx.ui.notify("purpose-anchor: steering Pi to re-read .think/ files after compaction", "info");

    const files: string[] = [];
    if (state) files.push(".think/_state.md");
    if (summary) files.push(".think/_summary.md");

    let content = `[purpose-anchor] Context was just compacted. You lost conversation history.
Your progress is saved on disk. Read it back NOW.

REQUIRED ACTIONS — do these BEFORE anything else:
1. Read .think/_state.md — it has your last action, next action, and key files.${summary ? "\n2. Read .think/_summary.md — it has your completed work summary." : ""}
${summary ? "3" : "2"}. Continue from the "Next Action" in _state.md. Do NOT restart from scratch.
${summary ? "4" : "3"}. Do NOT ask the user to repeat themselves or start a new session.

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
      { deliverAs: "steer" }
    );
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
}
