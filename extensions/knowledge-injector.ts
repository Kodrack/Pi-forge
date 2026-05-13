// knowledge-injector.ts
// Inference-time knowledge injection with compaction survival.
//
// Session start (turn 1):
//   1. Isolated LLM call selects relevant files from <project>/knowledge/
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
// fresh from <project>/knowledge/ source files.
//
// Knowledge folder is PROJECT-LOCAL: <cwd>/knowledge/
// Each project has its own knowledge files relevant to its tech stack.
//
// Commands: /forget <name> — remove a knowledge file from the active set
//
// Install: copy to ~/.pi/agent/extensions/knowledge-injector.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const SUB_PI_TIMEOUT = 60000; // 60s timeout for subprocess calls

function hashContent(content: string): string {
  return crypto.createHash("md5").update(content).digest("hex");
}

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
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

const DISTILLED_DIR = path.join(KNOWLEDGE_DIR, ".distilled");
const TOKEN_THRESHOLD = 2000; // ~500 tokens ≈ 2000 chars

function ensureDistilledDir(): void {
  if (!fs.existsSync(DISTILLED_DIR)) fs.mkdirSync(DISTILLED_DIR, { recursive: true });
}

function distilledPath(fileName: string): string {
  return path.join(DISTILLED_DIR, fileName);
}

function readDistilledFile(fileName: string): { description: string; hash: string } | null {
  try {
    const content = fs.readFileSync(distilledPath(fileName), "utf-8");
    const hashMatch = content.match(/^<!-- hash:([a-f0-9]+) -->/);
    const hash = hashMatch ? hashMatch[1] : "";
    const description = content.replace(/^<!-- hash:[a-f0-9]+ -->\n/, "").trim();
    return { description, hash };
  } catch {
    return null;
  }
}

function writeDistilledFile(fileName: string, description: string, hash: string): void {
  ensureDistilledDir();
  fs.writeFileSync(distilledPath(fileName), `<!-- hash:${hash} -->\n${description}\n`);
}

function extractHeaders(content: string): string {
  const title = (content.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  const headers = content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.replace(/^##\s*/, "").trim())
    .slice(0, 6);
  const topics = headers.length > 0 ? ` | topics: ${headers.join(", ")}` : "";
  return `${title}${topics}`;
}

async function distillFile(
  fileName: string,
  content: string,
  log?: (msg: string) => void
): Promise<string> {
  const tmpDir = os.tmpdir();
  const promptFile = path.join(tmpDir, `ki-distill-${Date.now()}.md`);

  const prompt = `Summarize this knowledge file. Start your response with exactly:

# ${fileName}
**Covers:** [technology/domain]

**Key failure patterns:**
- [specific pattern from the file]
- [another pattern]

**Critical rules:**
- [specific rule]

~100 words. Be specific.

---
${content}`;

  fs.writeFileSync(promptFile, prompt, "utf8");
  log?.(`  distill → pi subprocess (${content.length} chars)`);

  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
      { timeout: SUB_PI_TIMEOUT }
    );
    const result = (stdout || "").trim();

    if (!result) {
      log?.(`  distill FAILED: empty output`);
      return "";
    }
    log?.(`  distill OK: ${result.length} chars`);
    return result;
  } catch (err: any) {
    const salvaged = (err.stdout || "").trim();
    if (salvaged.length > 20) {
      log?.(`  distill partial: ${salvaged.length} chars (timeout)`);
      return salvaged;
    }
    log?.(`  distill FAILED: ${err.message}`);
    return "";
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

function listKnowledgeFiles(): Array<{ filePath: string; name: string; description: string; content: string }> {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return [];
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith("."))
      .map((f) => {
        const filePath = path.join(KNOWLEDGE_DIR, f);
        const content = fs.readFileSync(filePath, "utf-8");
        return { filePath, name: f, content, description: "" };
      });
  } catch {
    return [];
  }
}

async function buildDescriptions(
  files: Array<{ filePath: string; name: string; content?: string }>,
  log?: (msg: string) => void
): Promise<Array<{ filePath: string; name: string; description: string; content?: string }>> {
  const result = [];
  for (const f of files) {
    const content = f.content ?? fs.readFileSync(f.filePath, "utf-8");
    const hash = hashContent(content);

    if (content.length > TOKEN_THRESHOLD) {
      // Large file — check hash, re-distill only if content changed
      const cached = readDistilledFile(f.name);
      if (cached && cached.hash === hash) {
        log?.(`  ${f.name} — cached (.distilled/${f.name})`);
        result.push({ filePath: f.filePath, name: f.name, description: cached.description, content });
        continue;
      }
      log?.(`  ${f.name} — large (${content.length} chars), distilling...`);
      let description = await distillFile(f.name, content, log);
      if (!description) {
        description = extractHeaders(content);
        log?.(`  ${f.name} — distill failed, using headers only (NOT cached)`);
        // Don't cache failed distills — next run will retry
        result.push({ filePath: f.filePath, name: f.name, description, content });
        continue;
      }
      writeDistilledFile(f.name, description, hash);
      log?.(`  ${f.name} → .distilled/${f.name}`);
      result.push({ filePath: f.filePath, name: f.name, description, content });
    } else {
      // Small file — full content judged directly by selection LLM, no distill
      const description = extractHeaders(content);
      log?.(`  ${f.name} — small (${content.length} chars), full content to selection`);
      result.push({ filePath: f.filePath, name: f.name, description, content });
    }
  }

  return result;
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

async function selectRelevantFile(
  userPrompt: string,
  file: { name: string; description: string; content?: string },
  log?: (msg: string) => void
): Promise<boolean> {
  const tmpDir = os.tmpdir();
  const promptFile = path.join(tmpDir, `ki-select-${Date.now()}.md`);

  // Build file content section - use full content for small files, distilled summary for large
  const fileContent = file.content && file.content.length <= TOKEN_THRESHOLD
    ? file.content
    : file.description;

  const prompt = `TASK: ${userPrompt}

FILE: ${file.name}
${fileContent}

1. What technology does this file cover?
2. What technology does the task require?
3. Are they the same domain?

Answer YES only if the file's technology is needed for the task.
Otherwise NO.`;

  fs.writeFileSync(promptFile, prompt, "utf8");
  log?.(`  ${file.name} — evaluating...`);

  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
      { timeout: SUB_PI_TIMEOUT }
    );
    const reply = (stdout || "").trim().toUpperCase();

    // Parse response - default to NO (conservative: user can always add files manually)
    const isYes = reply.includes("YES") && !reply.includes("NO");
    log?.(`  ${file.name} — LLM replied: "${reply.slice(0, 50)}" → ${isYes ? "YES" : "NO"}`);
    return isYes;
  } catch (err: any) {
    log?.(`  ${file.name} — selection error: ${err.message}, skipping`);
    return false; // Default to exclude on error
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

async function selectRelevantFiles(
  userPrompt: string,
  files: Array<{ name: string; description: string; content?: string }>,
  log?: (msg: string) => void
): Promise<string[]> {
  if (files.length === 0) return [];

  const selected: string[] = [];

  // Evaluate each file independently - small models handle one decision better than batch
  for (const file of files) {
    const isRelevant = await selectRelevantFile(userPrompt, file, log);
    if (isRelevant) {
      selected.push(file.name);
    }
  }

  return selected;
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  let firstTurnHandled = false;
  let lastUserPrompt = "";
  let knowledgeAcknowledged = false;

  let knowledgeDone = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (!isEnabled()) {
      ctx.ui.notify("knowledge-injector disabled (use /piforge enable knowledge-injector)", "info");
      return;
    }

    // IMPORTANT: Don't restore from manifest on session_start.
    // The session-manager may not have created the new session yet,
    // so .think/ might still point to an OLD session's manifest.
    // Fresh selection happens in "input" handler after user's first prompt.

    const files = listKnowledgeFiles();
    const msg = files.length > 0
      ? `knowledge-injector ready — ${files.length} files in ./knowledge/ (selection on first prompt)`
      : "knowledge-injector active — no ./knowledge/ folder found";
    console.log(`\n ${msg}`);
    ctx.ui.notify(msg, "info");
  });

  // input: user typed first prompt — do ALL LLM work here (distill + select)
  // LM Studio is idle, Pi hasn't started its turn yet
  // By this point, session-manager has already created a fresh .think/ folder
  pi.on("input", async (event: any, ctx: any) => {
    lastUserPrompt = event.text ?? "";

    if (knowledgeDone) return;
    knowledgeDone = true;

    if (!isEnabled()) return;

    // IMMEDIATELY clear old manifest before any async work
    // This prevents turn_start from reading stale data during selection
    try { fs.unlinkSync(manifestPath()); } catch {}
    try { fs.unlinkSync(contentPath()); } catch {}

    const rawFiles = listKnowledgeFiles();
    if (rawFiles.length === 0) {
      knowledgeAcknowledged = true;
      return;
    }

    const log = (msg: string) => {
      const line = `knowledge-injector: ${msg}`;
      console.log(`\n ${line}`);
      ctx.ui.notify(line, "info");
    };

    // Step 1: distill large files (sequential pi subprocess calls)
    log(`scanning ${rawFiles.length} knowledge files...`);
    const files = await buildDescriptions(rawFiles, log);

    // Step 2: select relevant files (one pi subprocess call per file)
    log(`selecting relevant files for task...`);
    const selected = await selectRelevantFiles(lastUserPrompt, files, log);

    // Log per-file selection result
    for (const f of files) {
      const picked = selected.includes(f.name);
      log(`  ${picked ? "✓" : "✗"} ${f.name}${picked ? " — selected" : " — skipped"}`);
    }

    if (selected.length === 0) {
      log("selection result: none relevant for this task");
      knowledgeAcknowledged = true;
      return;
    }

    log(`selected ${selected.length}/${files.length} files`);

    writeManifest(selected.map((n) => n.replace(".md", "")));
    rebuildContent();

    log(`manifest → ${manifestPath()}`);
    log(`content  → ${contentPath()}`);
    for (const name of selected) {
      log(`  loaded: ${path.join(KNOWLEDGE_DIR, name)}`);
    }
  });

  // turn_start: NO LLM calls — just inject already-selected content
  pi.on("turn_start", async (_event: any, _ctx: any) => {
    if (!isEnabled() || firstTurnHandled) return;
    firstTurnHandled = true;

    const active = readManifest();
    if (active.length === 0) {
      knowledgeAcknowledged = true;
      return;
    }

    const content = buildSteerContent();
    if (content) {
      await pi.sendMessage(
        {
          customType: "knowledge_inject",
          content: `[knowledge-injector] Relevant failure patterns for this task:\n\n${content}\n\nApply these. Write .think/_knowledge.md acknowledgment before writing any code.`,
          display: { label: "knowledge-injector", content: `Loaded: ${active.join(", ")}` },
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
      const guidePath = path.join(os.homedir(), ".pi", "piforge-self.md");
      if (!fs.existsSync(guidePath)) {
        ctx.ui.notify("knowledge-injector: piforge-self.md not found in ~/.pi/", "error");
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
