// distill-awareness.ts
// Injects awareness of distill/explore capabilities into Pi's context at session start.
// When distilled data exists: tells Pi to prefer summaries and use explore_codebase tool.
// When no distilled data + large project: tells Pi about distill_codebase tool.
// Purely additive — does not modify distill.ts or explore.ts behavior.
//
// Install: copy to ~/.pi/agent/extensions/distill-awareness.ts
// Toggle:  /piforge disable distill-awareness | /piforge enable distill-awareness

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");
const MIN_FILES_FOR_DISTILL = 30;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("distill-awareness");
  } catch {
    return true;
  }
}

interface Manifest {
  rootArg: string;
  rootDir: string;
  purpose?: string;
  files: string[];
  levels: Record<string, { total: number; done: number; ratio: number }>;
}

function loadManifest(distillDir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(distillDir, "manifest.json"), "utf8"));
  } catch { return null; }
}

function countFiles(dir: string): number {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "bin" && e.name !== "obj" && e.name !== "dist" && e.name !== "build") {
        count += countFiles(path.join(dir, e.name));
      } else if (e.isFile()) {
        count++;
      }
    }
  } catch {}
  return count;
}

export default function (pi: ExtensionAPI) {
  const notifiedFiles = new Set<string>();

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (!isEnabled()) return;
    if (event.toolName !== "read") return;

    const filePath = event.input?.path || event.input?.file_path || "";
    if (!filePath || filePath.includes(".think/distill/")) return;

    const distillDir = path.join(ctx.cwd, ".think", "distill");
    const manifest = loadManifest(distillDir);
    if (!manifest) return;

    const relPath = path.relative(manifest.rootDir, path.resolve(ctx.cwd, filePath));
    if (relPath.startsWith("..")) return;
    if (notifiedFiles.has(relPath)) return;

    const l1Summary = path.join(distillDir, "L1", relPath + ".md");
    if (fs.existsSync(l1Summary)) {
      notifiedFiles.add(relPath);
      ctx.ui?.notify?.(
        `distill: summary available at .think/distill/L1/${relPath}.md`,
        "info"
      );
    }
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    if (!isEnabled()) return;

    const distillDir = path.join(ctx.cwd, ".think", "distill");
    const manifest = loadManifest(distillDir);

    if (manifest) {
      const completedLevels: string[] = [];
      const incompleteLevels: string[] = [];

      for (const [key, state] of Object.entries(manifest.levels)) {
        if (state.done >= state.total) {
          completedLevels.push(`${key} (${state.total} files, ${state.ratio}% compression)`);
        } else {
          incompleteLevels.push(`${key} (${state.done}/${state.total})`);
        }
      }

      const notesDir = path.join(distillDir, "notes");
      let notesInfo = "";
      if (fs.existsSync(notesDir)) {
        const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
        if (noteFiles.length > 0) {
          notesInfo = `\nPurpose-driven notes available: ${noteFiles.map(f => f.replace(".md", "")).join(", ")}`;
        }
      }

      const deepestLevel = completedLevels.length > 0 ? completedLevels[completedLevels.length - 1].split(" ")[0] : "L1";

      await pi.sendMessage(
        {
          customType: "distill_awareness",
          content: `[distill-awareness] Distilled knowledge base available for this project.

Completed levels: ${completedLevels.join(", ")}
${incompleteLevels.length > 0 ? `Incomplete: ${incompleteLevels.join(", ")} — use distill_codebase tool with resume=true` : ""}
${notesInfo}

HOW TO USE DISTILLED DATA:
1. Always do your own research first — read source files, search, explore the codebase normally.
2. AFTER you've formed your answer, cross-reference with .think/distill/${deepestLevel}/ to check if you missed anything. Distilled summaries cover every file in the project.
3. If you notice gaps in your research (areas you didn't explore), read the distilled summaries for those areas at .think/distill/L1/<path>.md
4. For broad architectural questions, skim distilled summaries to get the full picture after your initial research.
5. Always prefer source files for specific code, edits, or implementation detail — distilled data may be outdated.

AVAILABLE TOOLS:
- distill_codebase — create/resume distillation (also available as /distill command)
- explore_codebase — answer questions using distilled knowledge (also available as /explore command)`,
          display: {
            label: "distill-awareness",
            content: `Distilled data available (${Object.keys(manifest.levels).length} level${Object.keys(manifest.levels).length > 1 ? "s" : ""})`,
          },
        },
        { deliverAs: "steer" }
      );
    } else {
      const fileCount = countFiles(ctx.cwd);
      if (fileCount >= MIN_FILES_FOR_DISTILL) {
        await pi.sendMessage(
          {
            customType: "distill_awareness",
            content: `[distill-awareness] This project has ~${fileCount} files and NO distilled knowledge base.

You have the distill_codebase tool available. Use it when:
- The user asks a broad question about the codebase architecture, data flow, or how things work
- You need to understand many files to answer a question
- Reading 10+ source files would be needed

After distilling, use explore_codebase to efficiently navigate the summaries.
For simple questions about 1-3 specific files, just read those directly.`,
            display: {
              label: "distill-awareness",
              content: `~${fileCount} files, no distilled data — distill_codebase tool available`,
            },
          },
          { deliverAs: "steer" }
        );
      }
    }
  });
}
