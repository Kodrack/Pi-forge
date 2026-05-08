// plan-clarify.ts
// Detects when _plan.md is written and injects a steering message that
// forces the model to read the plan, identify assumptions, and ask the
// user up to 3 clarifying questions before proceeding to implementation.
//
// This prevents the model from building the wrong thing for 10 turns
// because it silently assumed wrong answers to key questions.
//
// Flow:
//   Model writes _plan.md
//   → extension detects the write
//   → injects steering: "read the plan, ask 3 questions, wait for answers"
//   → model asks questions in plain language
//   → user answers
//   → model proceeds to skeleton with correct assumptions
//
// Install: copy to ~/.pi/agent/extensions/plan-clarify.ts
// Usage:   automatic — fires whenever _plan.md is written

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("plan-clarify");
  } catch {
    return true;
  }
}

const STEERING_MESSAGE = `[plan-clarify] You just wrote _plan.md.

Before writing any code, do this NOW:

1. Re-read _plan.md carefully
2. Identify the top assumptions you made that the user has NOT explicitly confirmed — things like:
   - Technology choices (CSS framework, state management approach, styling method)
   - Behavior details (persistence, auth, dark mode implementation)
   - Scope (which features are MVP vs nice-to-have)
   - File structure or naming conventions
   - TypeScript vs JavaScript

3. Pick the 3 most impactful assumptions and ask them with numbered options.
   Format exactly like this:

   Before I start building, a few quick questions:

   1. [question]
      1) [option A]
      2) [option B]
      3) [option C]
      4) Other (type your answer)

   2. [question]
      1) [option A]
      2) [option B]
      3) Other (type your answer)

   3. [question]
      1) [option A]
      2) [option B]
      3) Other (type your answer)

   → Reply with numbers (e.g. "1, 2, 1") or write your own answer for any question.

4. STOP. Do not write any code until the user answers.

Rules:
- Maximum 3 questions — pick the ones that would most change the implementation if answered differently
- Always include an "Other (type your answer)" as the last option
- 2-4 options per question — no more
- Ask in plain language, not technical jargon
- If you genuinely have no ambiguities, say "Plan looks clear — starting skeleton now." and proceed
- Do NOT ask questions you can reasonably infer from the user's original request`;

export default function (pi: ExtensionAPI) {
  let planWrittenThisTurn = false;
  let planFilePath = "";

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) {
      ctx.ui.notify("plan-clarify disabled (use /piforge enable plan-clarify to activate)", "info");
      return;
    }
    ctx.ui.notify("plan-clarify active — will ask clarifying questions after _plan.md is written", "info");
  });

  pi.on("turn_start", async (_event, _ctx) => {
    planWrittenThisTurn = false;
    planFilePath = "";
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!isEnabled()) return;
    const name = (event as any).toolName ?? "";
    if (name !== "write" && name !== "edit") return;

    const input = (event as any).input as { path?: string; file_path?: string };
    const filePath = input?.path ?? input?.file_path ?? "";

    if (path.basename(filePath) === "_plan.md") {
      planWrittenThisTurn = true;
      planFilePath = filePath;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isEnabled() || !planWrittenThisTurn) return;

    planWrittenThisTurn = false;

    ctx.ui.notify(
      "plan-clarify: _plan.md written — injecting clarification phase before implementation.",
      "info"
    );

    await pi.sendMessage(
      {
        customType: "plan_clarify",
        content: STEERING_MESSAGE,
        display: {
          label: "plan-clarify",
          content: "_plan.md detected — model will ask clarifying questions before starting skeleton.",
        },
      },
      { deliverAs: "steer" }
    );
  });

  pi.registerCommand("plan-clarify", {
    description: "Show plan-clarify status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "plan-clarify: fires automatically when _plan.md is written. " +
        "Model asks up to 3 clarifying questions before proceeding to skeleton.",
        "info"
      );
    },
  });
}
