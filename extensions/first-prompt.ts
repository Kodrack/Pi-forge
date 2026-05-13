// first-prompt.ts
// Appends a planning instruction to the first user prompt of every session.
// Programmatic — no model decision, no steer message, zero context overhead.
// Only fires once per session on the very first input event.
//
// Install: copy to ~/.pi/agent/extensions/first-prompt.ts
// Toggle:  /piforge disable first-prompt | /piforge enable first-prompt

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");
const APPEND = "\n\nPlan the implementation in numbered steps. Implement ONE step at a time. Don't wait for user input between steps.";

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("first-prompt");
  } catch {
    return true;
  }
}

export default function (pi: ExtensionAPI) {
  let fired = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) {
      ctx.ui.notify("first-prompt disabled (use /piforge enable first-prompt to activate)", "info");
      return;
    }
    ctx.ui.notify("first-prompt active — will inject planning instruction into first prompt", "info");
  });

  pi.on("input", (event) => {
    if (!isEnabled() || fired) return { action: "continue" as const };
    fired = true;

    const original = (event as any).text ?? "";
    return {
      action: "transform" as const,
      text: original + APPEND,
    };
  });
}
