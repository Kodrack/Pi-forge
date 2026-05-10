// distill-query.ts
// Query commands for distilled codebase levels.
// /l1 "question" — Pi answers using only .think/distill/L1/ files
// /l2 "question" — Pi answers using only .think/distill/L2/ files
// /l3 "question" — Pi answers using only .think/distill/L3/ files
//
// Shows distill coverage on session start.
// Install: copy to ~/.pi/agent/extensions/distill-query.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("distill-query");
  } catch {
    return true;
  }
}

interface Manifest {
  rootArg: string;
  rootDir: string;
  files: string[];
  levels: Record<string, { total: number; done: number; ratio: number }>;
}

function loadManifest(distillDir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(distillDir, "manifest.json"), "utf8"));
  } catch { return null; }
}

function countSourceFiles(rootDir: string): number {
  let count = 0;
  const skip = new Set(["node_modules", ".git", "bin", "obj", "dist", "build", ".think"]);
  try {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith(".")) {
          walk(path.join(dir, e.name));
        } else if (e.isFile()) count++;
      }
    };
    walk(rootDir);
  } catch {}
  return count;
}

function countMdFiles(levelDir: string): number {
  let count = 0;
  try {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.isFile() && e.name.endsWith(".md")) count++;
      }
    };
    walk(levelDir);
  } catch {}
  return count;
}

function buildCoverageString(distillDir: string, manifest: Manifest | null): string {
  const parts: string[] = [];
  for (let l = 1; l <= 3; l++) {
    const key = `L${l}`;
    const levelDir = path.join(distillDir, key);
    if (manifest?.levels?.[key]) {
      const state = manifest.levels[key];
      const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
      parts.push(`L${l} ${state.done}/${state.total} (${pct}%)`);
    } else if (fs.existsSync(levelDir)) {
      const count = countMdFiles(levelDir);
      const total = manifest?.files?.length || count;
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      parts.push(`L${l} ${count}/${total} (${pct}%)`);
    }
  }
  return parts.length > 0 ? parts.join(" | ") : "";
}

function listDirs(levelDir: string): string {
  try {
    const dirs = fs.readdirSync(levelDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    if (dirs.length > 0) return "\nDirectories: " + dirs.join(", ");
  } catch {}
  return "";
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  // ── SESSION START: show coverage ──
  pi.on("session_start", async (_event: any, ctx: any) => {
    const distillDir = path.join(ctx.cwd, ".think", "distill");
    const manifest = loadManifest(distillDir);
    const coverage = buildCoverageString(distillDir, manifest);
    if (coverage) {
      ctx.ui.notify(`distill levels: ${coverage}`, "info");
    }
  });

  // ── /l1, /l2, /l3 commands ──
  for (const level of [1, 2, 3]) {
    pi.registerCommand(`l${level}`, {
      description: `Query distilled level ${level}. Usage: /l${level} "your question"`,
      handler: async (args: any, ctx: any) => {
        const question = (args?.trim() ?? "").replace(/^["']|["']$/g, "");
        if (!question) {
          ctx.ui.notify(`Usage: /l${level} "your question"`, "warn");
          return;
        }

        const distillDir = path.join(ctx.cwd, ".think", "distill");
        const levelDir = path.join(distillDir, `L${level}`);

        if (!fs.existsSync(levelDir)) {
          ctx.ui.notify(`L${level} not found. Run /distill first.`, "warn");
          return;
        }

        const fileCount = countMdFiles(levelDir);
        if (fileCount === 0) {
          ctx.ui.notify(`L${level} is empty. Run /distill first.`, "warn");
          return;
        }

        const manifest = loadManifest(distillDir);
        const coverage = buildCoverageString(distillDir, manifest);
        const dirs = listDirs(levelDir);

        ctx.ui.notify(`L${level}: ${fileCount} files — answering from distilled level ${level}`, "info");

        await pi.sendMessage(
          {
            customType: "distill_query",
            content: `Answer the following question using ONLY the distilled summaries at .think/distill/L${level}/
The folder mirrors the source code structure. Each file has a .md extension appended.
${dirs}

Coverage: ${coverage}

RULES:
1. Read ONLY from .think/distill/L${level}/ — do NOT read source files.
2. Use directory names to guide your search — don't read everything.
3. Cite which files you read in your answer.
4. If L${level} summaries aren't detailed enough to answer, say so and suggest /l${level > 1 ? level - 1 : level} for more detail.

Question: "${question}"

Start by listing the directories, then read the most relevant files.`,
            display: {
              label: `L${level} query`,
              content: `Answering from L${level}: "${question.slice(0, 60)}"`,
            },
          },
          { deliverAs: "steer" }
        );
      },
    });
  }

  // ── /distill-status command ──
  pi.registerCommand("distill-status", {
    description: "Show distill coverage per level",
    handler: async (_args: any, ctx: any) => {
      const distillDir = path.join(ctx.cwd, ".think", "distill");
      const manifest = loadManifest(distillDir);

      if (!manifest && !fs.existsSync(distillDir)) {
        ctx.ui.notify("No distilled data. Run /distill <folder> to create.", "info");
        return;
      }

      const coverage = buildCoverageString(distillDir, manifest);
      if (coverage) {
        ctx.ui.notify(`distill levels: ${coverage}`, "info");
        if (manifest?.rootArg) {
          ctx.ui.notify(`source: ${manifest.rootArg} (${manifest.files?.length || "?"} files)`, "info");
        }
      } else {
        ctx.ui.notify("Distill directory exists but no levels found.", "info");
      }
    },
  });
}
