// knowledge-injector.ts
// Hardcoded step 0: makes an isolated LLM call (using Pi's own model + endpoint)
// to select relevant knowledge files based on the user's prompt. The selection
// reasoning never touches Pi's conversation context — only the selected file
// content is injected as a steer. Code writes are blocked until the model writes
// .think/_knowledge.md proving it absorbed the knowledge.
//
// Flow:
//   user submits prompt → input event captures it
//   turn_start fires (before Pi's LLM call)
//   → isolated fetch() to Pi's model/endpoint: "which files are relevant?"
//   → fetch completes, Pi's LLM call has NOT started yet (sequential)
//   → only selected file content injected as steer — no selection reasoning in context
//   → Pi makes its main LLM call with knowledge already in context
//   → code writes blocked until .think/_knowledge.md written
//
// Install: copy to ~/.pi/agent/extensions/knowledge-injector.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const KNOWLEDGE_DIR = path.join(os.homedir(), ".pi", "knowledge");
const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("knowledge-injector");
  } catch {
    return true;
  }
}

function listKnowledgeFiles(): Array<{ filePath: string; name: string }> {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  try {
    return fs.readdirSync(KNOWLEDGE_DIR)
      .filter(f => f.endsWith(".md") && f !== "README.md")
      .map(f => ({ filePath: path.join(KNOWLEDGE_DIR, f), name: f }));
  } catch {
    return [];
  }
}

function knowledgeDone(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, ".think", "_knowledge.md"));
}

async function selectRelevantFiles(
  baseUrl: string,
  modelId: string,
  userPrompt: string,
  files: Array<{ name: string }>
): Promise<string[]> {
  const fileList = files.map((f, i) => `${i + 1}. ${f.name}`).join("\n");

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: `Task: "${userPrompt}"

Available knowledge files:
${fileList}

Which of these files contain failure patterns relevant to this task?
Reply with ONLY the relevant filenames, one per line.
If none are relevant, reply: none`,
          },
        ],
        max_tokens: 80,
        temperature: 0.1,
        stream: false,
      }),
    });

    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const reply: string = data?.choices?.[0]?.message?.content ?? "";

    if (reply.trim().toLowerCase() === "none") return [];

    return files
      .filter(f => reply.toLowerCase().includes(f.name.toLowerCase().replace(".md", "")))
      .map(f => f.name);
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  let firstTurnHandled = false;
  let scanDone = false;
  let lastUserPrompt = "";
  let hasFiles = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!isEnabled()) {
      ctx.ui.notify("knowledge-injector disabled (use /piforge enable knowledge-injector to activate)", "info");
      return;
    }
    hasFiles = listKnowledgeFiles().length > 0;
    if (hasFiles) {
      ctx.ui.notify("knowledge-injector active — isolated LLM call will select relevant files before turn 1", "info");
    }
  });

  // capture user prompt before turn_start fires
  pi.on("input", (event) => {
    lastUserPrompt = (event as any).text ?? "";
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!isEnabled() || firstTurnHandled || !hasFiles) return;
    firstTurnHandled = true;

    if (knowledgeDone(process.cwd())) {
      scanDone = true;
      return;
    }

    const files = listKnowledgeFiles();
    if (files.length === 0) return;

    // get Pi's current model and endpoint — same as what Pi will use
    const model = ctx.getModel() as any;
    const baseUrl: string = model?.baseUrl ?? "http://localhost:1234/v1";
    const modelId: string = model?.id ?? "";

    ctx.ui.notify(`knowledge-injector: selecting from ${files.length} files via isolated call...`, "info");

    const selected = await selectRelevantFiles(baseUrl, modelId, lastUserPrompt, files);

    if (selected.length === 0) {
      ctx.ui.notify(`knowledge-injector: isolated call returned no relevant files (checked: ${files.map(f => f.name).join(", ")})`, "info");
      scanDone = true;
      return;
    }

    ctx.ui.notify(`knowledge-injector: isolated call selected → ${selected.join(", ")}`, "info");

    // read and inject only the content — selection reasoning stays out of context
    const sections: string[] = [];
    for (const name of selected) {
      const filePath = path.join(KNOWLEDGE_DIR, name);
      try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        sections.push(`### ${name.replace(".md", "")}\n\n${content}`);
        ctx.ui.notify(`knowledge-injector: loaded ${name}`, "info");
      } catch {}
    }

    if (sections.length === 0) return;

    await pi.sendMessage(
      {
        customType: "knowledge_inject",
        content: `[knowledge-injector] Relevant failure patterns for this task:\n\n${sections.join("\n\n---\n\n")}\n\nApply these. Write .think/_knowledge.md with the key points before writing any code.`,
        display: {
          label: "knowledge-injector",
          content: `Loaded: ${selected.join(", ")} — selected via isolated LLM call`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isEnabled() || !hasFiles || scanDone) return;

    const name = (event as any).toolName ?? "";
    if (name !== "write" && name !== "edit") return;

    const input = (event as any).input as { path?: string; file_path?: string };
    const filePath = input?.path ?? input?.file_path ?? "";

    if (filePath.includes(".think/") || filePath.includes(".think\\")) return;

    if (knowledgeDone(process.cwd())) {
      scanDone = true;
      return;
    }

    (ctx as any).blockToolCall(
      "[knowledge-injector] Write .think/_knowledge.md with the key patterns from the loaded knowledge files before writing any code."
    );
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!hasFiles || scanDone) return;
    if (knowledgeDone(process.cwd())) {
      scanDone = true;
      ctx.ui.notify("knowledge-injector: _knowledge.md written — code writes unblocked", "info");
    }
  });

  pi.registerCommand("knowledge", {
    description: "Show knowledge files and step 0 status",
    handler: async (_args, ctx) => {
      const files = listKnowledgeFiles();
      const done = knowledgeDone(process.cwd());
      ctx.ui.notify(
        `knowledge-injector: ${files.length} files | step 0: ${done ? "complete" : "pending"}\n` +
          files.map(f => `  ${f.name}`).join("\n"),
        "info"
      );
    },
  });
}
