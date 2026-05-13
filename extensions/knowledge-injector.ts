// knowledge-injector.ts
// Inference-time knowledge injection with compaction survival.
//
// Session start (turn 1):
//   1. Isolated LLM call selects relevant files from ~/.pi/knowledge/
//   2. Saves selected filenames to .think/_knowledge-manifest.md (manifest)
//   3. Builds .think/_knowledge.md from source files (full content)
//   4. Injects content as steer — model gets knowledge on first LLM call
//   5. Blocks code writes until .think/_knowledge.md is read by model
//
// After compaction (session_compact):
//   1. Reads manifest (.think/_knowledge-manifest.md)
//   2. Rebuilds .think/_knowledge.md from source files
//   3. Injects content as steer — model gets knowledge back automatically
//   Zero LLM cost — fully programmatic rebuild.
//
// The manifest on disk is the source of truth. It survives compaction,
// session restarts, and context loss. The full content is always rebuilt
// fresh from ~/.pi/knowledge/ source files.
//
// Commands: /forget <name> — remove a knowledge file from the active set
//
// Install: copy to ~/.pi/agent/extensions/knowledge-injector.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const KNOWLEDGE_DIR = path.join(os.homedir(), ".pi", "knowledge");
const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- HELPERS ----------

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("knowledge-injector");
  } catch {
    return true;
  }
}

function thinkDir(): string {
  return path.join(process.cwd(), ".think");
}

function manifestPath(): string {
  return path.join(thinkDir(), "_knowledge-manifest.md");
}

function contentPath(): string {
  return path.join(thinkDir(), "_knowledge.md");
}

function ensureThinkDir(): void {
  const dir = thinkDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readManifest(): string[] {
  try {
    const content = fs.readFileSync(manifestPath(), "utf-8");
    return content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim());
  } catch {
    return [];
  }
}

function writeManifest(active: string[]): void {
  ensureThinkDir();
  const md = `# Active Knowledge\n${active.map((n) => `- ${n}`).join("\n")}\n`;
  fs.writeFileSync(manifestPath(), md);
}

function listKnowledgeFiles(): Array<{ filePath: string; name: string }> {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map((f) => ({ filePath: path.join(KNOWLEDGE_DIR, f), name: f }));
  } catch {
    return [];
  }
}

// Rebuild _knowledge.md from manifest + source files. Returns loaded names.
function rebuildContent(): string[] {
  const active = readManifest();
  if (active.length === 0) {
    try { fs.unlinkSync(contentPath()); } catch {}
    return [];
  }

  ensureThinkDir();
  const sections: string[] = [];
  const loaded: string[] = [];

  for (const name of active) {
    const fileName = name.endsWith(".md") ? name : `${name}.md`;
    const filePath = path.join(KNOWLEDGE_DIR, fileName);
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      const id = fileName.replace(".md", "");
      sections.push(`## ${id}\n\n${content}`);
      loaded.push(id);
    } catch {}
  }

  if (sections.length > 0) {
    fs.writeFileSync(contentPath(), `# Active Knowledge\n\n${sections.join("\n\n---\n\n")}\n`);
  } else {
    try { fs.unlinkSync(contentPath()); } catch {}
  }

  if (loaded.length !== active.length) writeManifest(loaded);
  return loaded;
}

// Build the steer content from _knowledge.md
function buildSteerContent(): string {
  try {
    return fs.readFileSync(contentPath(), "utf-8").trim();
  } catch {
    return "";
  }
}

async function selectRelevantFiles(
  baseUrl: string,
  modelId: string,
  userPrompt: string,
  files: Array<{ name: string }>
): Promise<string[]> {
  if (files.length === 0) return [];
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
      .filter((f) => reply.toLowerCase().includes(f.name.toLowerCase().replace(".md", "")))
      .map((f) => f.name);
  } catch {
    return [];
  }
}

function getModelConfig(pi: ExtensionAPI, ctx: any): { baseUrl: string; modelId: string } {
  let baseUrl = "http://localhost:1234/v1";
  let modelId = "";
  try {
    const model = (ctx as any).getModel?.() ?? (pi as any).getModel?.();
    if (model) {
      baseUrl = model.baseUrl ?? baseUrl;
      modelId = model.id ?? modelId;
    }
  } catch {}
  return { baseUrl, modelId };
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  let firstTurnHandled = false;
  let lastUserPrompt = "";
  let knowledgeAcknowledged = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (!isEnabled()) {
      ctx.ui.notify("knowledge-injector disabled (use /piforge enable knowledge-injector)", "info");
      return;
    }

    const active = readManifest();
    if (active.length > 0) {
      const loaded = rebuildContent();
      ctx.ui.notify(`knowledge-injector active — restored: ${loaded.join(", ")}`, "info");
    } else {
      const files = listKnowledgeFiles();
      ctx.ui.notify(
        files.length > 0
          ? `knowledge-injector active — ${files.length} knowledge files available`
          : "knowledge-injector active — no files in ~/.pi/knowledge/",
        "info"
      );
    }
  });

  pi.on("input", (event: any) => {
    lastUserPrompt = event.text ?? "";
  });

  // First turn: select + inject
  pi.on("turn_start", async (_event: any, ctx: any) => {
    if (!isEnabled() || firstTurnHandled) return;
    firstTurnHandled = true;

    const active = readManifest();

    // Resuming with existing manifest — inject directly
    if (active.length > 0) {
      const content = buildSteerContent();
      if (content) {
        await pi.sendMessage(
          {
            customType: "knowledge_inject",
            content: `[knowledge-injector] Relevant failure patterns for this task:\n\n${content}\n\nApply these. Write .think/_knowledge.md acknowledgment before writing any code.`,
            display: { label: "knowledge-injector", content: `Restored: ${active.join(", ")}` },
          },
          { deliverAs: "steer" }
        );
      }
      return;
    }

    // Fresh session — isolated LLM call to select
    const files = listKnowledgeFiles();
    if (files.length === 0) return;

    const { baseUrl, modelId } = getModelConfig(pi, ctx);
    ctx.ui.notify(`knowledge-injector: selecting from ${files.length} files via isolated call...`, "info");

    const selected = await selectRelevantFiles(baseUrl, modelId, lastUserPrompt, files);
    if (selected.length === 0) {
      ctx.ui.notify("knowledge-injector: no relevant files for this task", "info");
      knowledgeAcknowledged = true;
      return;
    }

    // Save to manifest + build content
    writeManifest(selected.map((n) => n.replace(".md", "")));
    const loaded = rebuildContent();
    const content = buildSteerContent();

    ctx.ui.notify(`knowledge-injector: selected → ${loaded.join(", ")}`, "info");

    if (content) {
      await pi.sendMessage(
        {
          customType: "knowledge_inject",
          content: `[knowledge-injector] Relevant failure patterns for this task:\n\n${content}\n\nApply these. Write .think/_knowledge.md acknowledgment before writing any code.`,
          display: { label: "knowledge-injector", content: `Loaded: ${loaded.join(", ")}` },
        },
        { deliverAs: "steer" }
      );
    }
  });

  // After compaction: rebuild from manifest and re-inject
  pi.on("session_compact", async (_event: any, ctx: any) => {
    if (!isEnabled()) return;

    const active = readManifest();
    if (active.length === 0) return;

    const loaded = rebuildContent();
    if (loaded.length === 0) return;

    const content = buildSteerContent();
    if (!content) return;

    ctx.ui.notify(`knowledge-injector: re-injecting after compaction — ${loaded.join(", ")}`, "info");

    await pi.sendMessage(
      {
        customType: "knowledge_reinject",
        content: `[knowledge-injector] Context was compacted. Re-injecting knowledge:\n\n${content}\n\nThis knowledge was selected at session start and is still active. Continue applying these patterns.`,
        display: { label: "knowledge-injector", content: `Re-injected: ${loaded.join(", ")}` },
      },
      { deliverAs: "steer" }
    );
  });

  // Block code writes until model acknowledges knowledge
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isEnabled() || knowledgeAcknowledged) return;

    const name = (event as any).toolName ?? "";
    if (name !== "write" && name !== "edit") return;

    const input = (event as any).input as { path?: string; file_path?: string };
    const filePath = input?.path ?? input?.file_path ?? "";

    // Allow .think/ writes
    if (filePath.includes(".think/") || filePath.includes(".think\\")) {
      // Check if this is the acknowledgment write
      if (filePath.includes("_knowledge")) {
        knowledgeAcknowledged = true;
      }
      return;
    }

    // No manifest = no knowledge to acknowledge
    if (readManifest().length === 0) {
      knowledgeAcknowledged = true;
      return;
    }

    (ctx as any).blockToolCall(
      "[knowledge-injector] Write .think/_knowledge.md acknowledging the loaded knowledge patterns before writing any code."
    );
  });

  pi.on("turn_end", async () => {
    if (knowledgeAcknowledged) return;
    if (fs.existsSync(path.join(thinkDir(), "_knowledge.md"))) {
      knowledgeAcknowledged = true;
    }
  });

  // /forget — remove a knowledge file from active set
  pi.registerCommand("forget", {
    description: "Remove knowledge. Usage: /forget playwright-testing",
    handler: async (args: string, ctx: any) => {
      const name = (args ?? "").trim().replace(".md", "");
      if (!name) {
        const active = readManifest();
        ctx.ui.notify(
          active.length > 0
            ? `Active knowledge: ${active.join(", ")}\nUsage: /forget <name>`
            : "No active knowledge.",
          "info"
        );
        return;
      }

      const active = readManifest();
      const idx = active.indexOf(name);
      if (idx === -1) {
        ctx.ui.notify(`"${name}" not active. Current: ${active.join(", ") || "none"}`, "warn");
        return;
      }

      active.splice(idx, 1);
      writeManifest(active);
      const loaded = rebuildContent();
      ctx.ui.notify(`knowledge-injector: removed "${name}"`, "info");

      const msg = loaded.length > 0
        ? `Removed "${name}". Remaining: ${loaded.join(", ")}.`
        : `Removed "${name}". No active knowledge remaining.`;

      await pi.sendMessage(
        {
          customType: "knowledge_forget",
          content: `[knowledge-injector] ${msg}`,
          display: { label: "knowledge-injector", content: `Removed: ${name}` },
        },
        { deliverAs: "steer" }
      );
    },
  });

  // /guide — load piforge-self.md on demand
  pi.registerCommand("guide", {
    description: "Load the PiForge guide into context",
    handler: async (_args: string, ctx: any) => {
      const guidePath = path.join(KNOWLEDGE_DIR, "piforge-self.md");
      if (!fs.existsSync(guidePath)) {
        ctx.ui.notify("knowledge-injector: piforge-self.md not found in ~/.pi/knowledge/", "error");
        return;
      }

      const content = fs.readFileSync(guidePath, "utf-8").trim();
      ctx.ui.notify("knowledge-injector: PiForge guide loaded", "info");

      await pi.sendMessage(
        {
          customType: "knowledge_guide",
          content: `[knowledge-injector] PiForge guide loaded:\n\n${content}\n\nPiForge guide loaded — what do you want to know?`,
          display: { label: "knowledge-injector", content: "PiForge guide loaded" },
        },
        { deliverAs: "steer" }
      );
    },
  });
}
