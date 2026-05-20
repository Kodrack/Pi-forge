// init-project.ts
// Provides /init command to set up a project with AGENTS.md and .think/ workflow.
//
// Commands:
//   /init         — copy AGENTS.md template to current project root
//   /init --force — overwrite existing AGENTS.md
//
// Install: copy to ~/.pi/agent/extensions/init-project.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TEMPLATE_PATH = path.join(os.homedir(), ".pi", "templates", "AGENTS.md");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Initialize project with AGENTS.md template. Usage: /init or /init --force",
    handler: async (args: string, ctx: any) => {
      const force = (args ?? "").trim() === "--force";
      const destPath = path.join(process.cwd(), "AGENTS.md");

      // Check if template exists
      if (!fs.existsSync(TEMPLATE_PATH)) {
        ctx.ui.notify(
          `init: template not found at ${TEMPLATE_PATH}. Run from Pi-forge to install templates.`,
          "error"
        );
        return;
      }

      // Check if AGENTS.md already exists
      if (fs.existsSync(destPath) && !force) {
        ctx.ui.notify(
          `init: AGENTS.md already exists. Use /init --force to overwrite.`,
          "warn"
        );
        return;
      }

      // Copy template
      try {
        const template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
        fs.writeFileSync(destPath, template);
        ctx.ui.notify(
          `init: AGENTS.md created at ${destPath}`,
          "info"
        );

        // Also create knowledge/ folder if it doesn't exist
        const knowledgeDir = path.join(process.cwd(), "knowledge");
        if (!fs.existsSync(knowledgeDir)) {
          fs.mkdirSync(knowledgeDir, { recursive: true });
          ctx.ui.notify(`init: created knowledge/ folder for project-specific gotchas`, "info");
        }

        // Steer the model to acknowledge the setup
        await pi.sendMessage(
          {
            customType: "init_complete",
            content: `[init] Project initialized with AGENTS.md workflow.

AGENTS.md has been created in the project root. It contains:
- .think/ workflow rules (state, plan, step files)
- Context constraints for local LLMs
- File templates

The knowledge/ folder has been created for project-specific gotchas.

Read AGENTS.md now and follow its workflow for all tasks.`,
            display: { label: "init", content: "Project initialized with AGENTS.md" },
          },
          { deliverAs: "steer" }
        );
      } catch (err: any) {
        ctx.ui.notify(`init: failed to create AGENTS.md — ${err.message}`, "error");
      }
    },
  });
}
