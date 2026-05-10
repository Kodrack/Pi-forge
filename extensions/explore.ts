// explore.ts
// Navigate a distilled codebase knowledge base to answer questions.
// Uses the multi-level summaries built by /distill (distill-v2.ts).
//
// Starts at the deepest (most compressed) level, scans broadly,
// then zooms into shallower levels for specific files.
//
// Usage:
//   /explore "how does authentication work?"
//   /explore "where are MQTT messages handled?"
//
// Install: copy to ~/.pi/agent/extensions/explore.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("explore");
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
  startedAt: string;
  updatedAt: string;
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  pi.registerCommand("explore", {
    description: 'Navigate distilled codebase knowledge. Usage: /explore "your question"',
    handler: async (args: any, ctx: any) => {
      const question = (args?.trim() ?? "").replace(/^["']|["']$/g, "");
      if (!question) {
        ctx.ui.notify('explore: provide a question. Usage: /explore "how does auth work?"', "warn");
        return;
      }

      const distillDir = path.join(ctx.cwd, ".think", "distill");
      if (!fs.existsSync(distillDir)) {
        ctx.ui.notify("explore: no distill output found. Run /distill first.", "warn");
        return;
      }

      // Load manifest
      let manifest: Manifest | null = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(distillDir, "manifest.json"), "utf8"));
      } catch {}

      // Find available levels
      const levels: number[] = [];
      for (let l = 1; l <= 10; l++) {
        const levelDir = path.join(distillDir, `L${l}`);
        if (fs.existsSync(levelDir)) {
          try {
            const files = fs.readdirSync(levelDir, { recursive: true }) as string[];
            if (files.some((f: string) => f.endsWith(".md"))) levels.push(l);
          } catch {}
        }
      }

      if (levels.length === 0) {
        ctx.ui.notify("explore: no distillation levels found. Run /distill first.", "warn");
        return;
      }

      const deepest = Math.max(...levels);
      const shallowest = Math.min(...levels);

      // Build level descriptions
      let levelDesc = "";
      for (const l of levels) {
        const levelState = manifest?.levels?.[`L${l}`];
        const ratio = levelState?.ratio || 50;
        const cumulative = Math.round(Math.pow(ratio / 100, l) * 100);
        let detail: string;
        if (l === shallowest) detail = "most detail — read for specific files";
        else if (l === deepest) detail = "most compressed — scan broadly here first";
        else detail = "moderate detail";
        levelDesc += `  L${l}: ~${cumulative}% of source size (${detail})\n`;
        levelDesc += `    Path: .think/distill/L${l}/ (same folder structure as source, files have .md extension)\n`;
      }

      // Check for notes
      const notesDir = path.join(distillDir, "notes");
      let notesContext = "";
      if (fs.existsSync(notesDir)) {
        const noteFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith(".md"));
        if (noteFiles.length > 0) {
          notesContext = "\nPre-computed notes from previous distillations (check these first — may contain direct answers):\n";
          for (const nf of noteFiles) {
            notesContext += `  - .think/distill/notes/${nf}\n`;
          }
        }
      }

      // Build top-level directory listing for orientation
      let dirListing = "";
      const topLevelDir = path.join(distillDir, `L${deepest}`);
      try {
        const topDirs = fs.readdirSync(topLevelDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort();
        if (topDirs.length > 0) {
          dirListing = `\nTop-level directories in the codebase:\n`;
          for (const d of topDirs) {
            dirListing += `  - ${d}/\n`;
          }
        }
      } catch {}

      const prompt = `You have a multi-level distilled knowledge base of this codebase at .think/distill/
All levels have the SAME files in the SAME folder structure — just different compression levels.
Each file in the distill folders has a .md extension appended (e.g., source file Controllers/Auth.cs → L1/Controllers/Auth.cs.md).

Available levels:
${levelDesc}
${notesContext}${dirListing}
Question: "${question}"

Strategy:
1. ${notesContext ? "Check notes files first for quick answers.\n2. " : ""}Start at L${deepest} (most compressed) — list directories, then read files in areas relevant to the question.
${notesContext ? "3" : "2"}. When you identify relevant files, zoom to L${shallowest} for those specific files to get more detail.
${notesContext ? "4" : "3"}. If L${shallowest} summaries aren't detailed enough, read the actual source file at: ${manifest?.rootDir || ctx.cwd}/<path>

Be efficient: use directory and file names to guide your search. Don't read everything.
When you find the answer, cite which files you examined.

Start now.`;

      ctx.ui.notify(
        `explore: navigating ${levels.length} level${levels.length > 1 ? "s" : ""} for "${question.slice(0, 50)}${question.length > 50 ? "..." : ""}"`,
        "info"
      );

      await pi.sendMessage(
        {
          customType: "explore_query",
          content: prompt,
          display: {
            label: "explore",
            content: `Exploring: "${question.slice(0, 80)}" across ${levels.length} level${levels.length > 1 ? "s" : ""}`,
          },
        },
        { deliverAs: "steer" }
      );
    },
  });

  // ── REGISTER AS LLM-CALLABLE TOOL ──────────────────────────────────────

  try {
    (pi as any).registerTool({
      name: "explore_codebase",
      description:
        "Answer questions about the codebase using pre-distilled summaries at .think/distill/. " +
        "Much faster than reading source files individually. " +
        "Requires distill_codebase to have been run first. " +
        "Returns navigation instructions for reading the relevant distilled files. " +
        "Use for broad questions: architecture, data flow, how things work, where things are defined.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to answer about the codebase.",
          },
        },
        required: ["question"],
      },
      execute: async (
        toolCallId: string,
        params: any,
        signal: AbortSignal,
        onUpdate: (content: string) => void,
        ctx: any
      ): Promise<any> => {
        const fmt = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
        try {
        const question = params?.question;
        if (!question) return fmt("Please provide a question.");

        const cwd = ctx?.cwd || process.cwd();
        const distillDir = path.join(cwd, ".think", "distill");

        if (!fs.existsSync(distillDir))
          return fmt("No distilled data found. Run distill_codebase first.");

        let manifest: Manifest | null = null;
        try {
          manifest = JSON.parse(
            fs.readFileSync(path.join(distillDir, "manifest.json"), "utf8")
          );
        } catch {}

        const levels: number[] = [];
        for (let l = 1; l <= 10; l++) {
          const ld = path.join(distillDir, `L${l}`);
          if (fs.existsSync(ld)) {
            try {
              const files = fs.readdirSync(ld, { recursive: true }) as string[];
              if (files.some((f: string) => f.endsWith(".md"))) levels.push(l);
            } catch {}
          }
        }

        if (levels.length === 0)
          return fmt("No distillation levels found. Run distill_codebase first.");

        const deepest = Math.max(...levels);
        const shallowest = Math.min(...levels);

        let levelDesc = "";
        for (const l of levels) {
          const ls = manifest?.levels?.[`L${l}`];
          const r = ls?.ratio || 50;
          const cum = Math.round(Math.pow(r / 100, l) * 100);
          let detail: string;
          if (l === shallowest) detail = "most detail";
          else if (l === deepest) detail = "most compressed — scan here first";
          else detail = "moderate detail";
          levelDesc += `  L${l}: ~${cum}% of source (${detail})\n`;
          levelDesc += `    Path: .think/distill/L${l}/\n`;
        }

        const notesDir = path.join(distillDir, "notes");
        let notesCtx = "";
        if (fs.existsSync(notesDir)) {
          const nf = fs.readdirSync(notesDir).filter((f) => f.endsWith(".md"));
          if (nf.length > 0) {
            notesCtx = "\nPre-computed notes:\n";
            for (const f of nf) notesCtx += `  - .think/distill/notes/${f}\n`;
          }
        }

        let dirList = "";
        try {
          const dirs = fs
            .readdirSync(path.join(distillDir, `L${deepest}`), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
          if (dirs.length > 0) {
            dirList = "\nTop-level directories:\n";
            for (const d of dirs) dirList += `  - ${d}/\n`;
          }
        } catch {}

        try { onUpdate({ content: [{ type: "text" as const, text: `Exploring: "${question.slice(0, 50)}..."` }] } as any); } catch {}

        return fmt(`Navigate the distilled knowledge base to answer: "${question}"

Available levels:
${levelDesc}${notesCtx}${dirList}
Strategy:
1. ${notesCtx ? "Check notes files first.\n2. " : ""}Start at L${deepest} — list directories, read relevant files.
${notesCtx ? "3" : "2"}. Zoom to L${shallowest} for specific files needing more detail.
${notesCtx ? "4" : "3"}. If summaries aren't enough, read source at: ${manifest?.rootDir || cwd}/<path>

Each distilled file has .md appended (e.g., Controllers/Auth.cs → L1/Controllers/Auth.cs.md).
Be efficient. Cite files examined.`);
        } catch (err: any) {
          return fmt(`explore_codebase error: ${(err?.message || String(err)).slice(0, 500)}`);
        }
      },
    });
  } catch {}
}
