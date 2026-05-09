// distill.ts
// Registers /distill [path] and /distill --resume commands.
// Crawls a codebase, builds an import graph, topologically sorts files
// (entry points first), clusters similar patterns, batches tiny files.
//
// Phase 1 is fully programmatic: for each file, a fresh pi --no-session
// subprocess is spawned, summarizes the file in isolation, and writes the
// result. The main session context never loads source files.
//
// Phase 2 + 3 are LLM-driven (module summaries, architecture, index).
//
// Smart ordering:
//   1. Entry points (index.ts, main.py, app.js …) — read first
//   2. Topological order by import graph — dependencies before dependents
//   3. Similarity clusters (*.controller.ts, *.service.ts …) grouped
//   4. Small files (< 30 lines) batched up to 5 per turn
//
// Install: copy to ~/.pi/agent/extensions/distill.ts
// Usage:   /distill [path] | /distill --resume | /distill [path] --understanding "purpose"

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { promisify } from "util";

const execAsync = promisify(exec);

// ---------- CONFIG ----------

const PAGE_SIZE = 50;
const UNDERSTANDING_BATCH_SIZE = 40;

const INCLUDE_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".cpp", ".c",
  ".css", ".scss", ".sass", ".less",
  ".html", ".vue", ".svelte",
  ".sql",
  ".md",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".cache", "coverage", ".turbo", "vendor", "tmp",
  ".idea", ".vscode", "target", "bin", "obj",
]);

const SKIP_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.d\.ts$/,
  /\.lock$/,
  /\.map$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

const MAX_FILE_SIZE_BYTES = 80 * 1024;

const ENTRY_POINT_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "main.ts", "main.tsx", "main.js", "main.py",
  "app.ts", "app.tsx", "app.js", "app.jsx",
  "server.ts", "server.js",
  "__init__.py", "mod.rs",
]);

const CLUSTER_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "tests",       regex: /\.(test|spec)\.(ts|tsx|js|jsx|py)$/ },
  { label: "controllers", regex: /\.controller\.(ts|js)$/ },
  { label: "services",    regex: /\.service\.(ts|js)$/ },
  { label: "models",      regex: /\.model\.(ts|js)$/ },
  { label: "routes",      regex: /\.routes?\.(ts|js)$/ },
  { label: "middleware",  regex: /\.middleware\.(ts|js)$/ },
  { label: "utils",       regex: /\.(util|utils|helper|helpers)\.(ts|js|py)$/ },
  { label: "types",       regex: /\.(types?|interfaces?)\.(ts|js)$/ },
  { label: "config",      regex: /\.(config|conf|settings)\.(ts|js|py)$/ },
  { label: "styles",      regex: /\.(css|scss|sass|less)$/ },
];

const SMALL_FILE_LINE_THRESHOLD = 30;
const SMALL_FILE_BATCH_SIZE = 5;

// ---------- TYPES ----------

interface FileEntry {
  relPath: string;
  lines: number;
  sizeKB: number;
  content: string;
}

interface TurnEntry {
  files: string[];
  label?: string;
}

interface TurnsState {
  turns: TurnEntry[];
  rootArg: string; // the path arg originally passed to /distill (relative to cwd)
  totalFiles: number;
}

// ---------- CRAWL ----------

function shouldSkipFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return SKIP_PATTERNS.some((p) => p.test(name));
}

function crawl(dir: string, rootDir: string): FileEntry[] {
  const results: FileEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        results.push(...crawl(fullPath, rootDir));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!INCLUDE_EXTENSIONS.has(ext)) continue;
      if (shouldSkipFile(fullPath)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n").length;
        const sizeKB = Math.round((stat.size / 1024) * 10) / 10;
        results.push({ relPath, lines, sizeKB, content });
      } catch {}
    }
  }

  return results;
}

// ---------- IMPORT GRAPH ----------

function extractImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+([.\w/]+)\s+import/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      if (m[1].startsWith(".")) imports.push(m[1]);
    }
  }
  return imports;
}

function resolveImport(
  importerRelPath: string,
  importedRaw: string,
  fileIndex: Map<string, FileEntry>
): string | null {
  const importerDir = path.dirname(importerRelPath);
  const base = path.normalize(path.join(importerDir, importedRaw));
  const candidates = [
    base,
    base + ".ts", base + ".tsx", base + ".js", base + ".jsx",
    base + ".py", base + ".go",
    path.join(base, "index.ts"), path.join(base, "index.tsx"),
    path.join(base, "index.js"), path.join(base, "__init__.py"),
  ];
  for (const c of candidates) {
    const normalized = c.replace(/\\/g, "/");
    if (fileIndex.has(normalized)) return normalized;
  }
  return null;
}

function buildImportGraph(files: FileEntry[]): Map<string, Set<string>> {
  const fileIndex = new Map<string, FileEntry>();
  for (const f of files) fileIndex.set(f.relPath.replace(/\\/g, "/"), f);

  const graph = new Map<string, Set<string>>();
  for (const f of files) graph.set(f.relPath, new Set());

  for (const f of files) {
    const ext = path.extname(f.relPath).toLowerCase();
    const imports = extractImports(f.content, ext);
    for (const raw of imports) {
      const resolved = resolveImport(f.relPath, raw, fileIndex);
      if (resolved && resolved !== f.relPath) graph.get(f.relPath)!.add(resolved);
    }
  }
  return graph;
}

function topoSort(files: FileEntry[], graph: Map<string, Set<string>>): string[] {
  const relPaths = files.map((f) => f.relPath);
  const inDegree = new Map<string, number>();
  const reverseGraph = new Map<string, Set<string>>();

  for (const rp of relPaths) {
    inDegree.set(rp, 0);
    reverseGraph.set(rp, new Set());
  }
  for (const [importer, deps] of graph.entries()) {
    for (const dep of deps) {
      if (reverseGraph.has(dep)) {
        reverseGraph.get(dep)!.add(importer);
        inDegree.set(importer, (inDegree.get(importer) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = relPaths.filter((rp) => (inDegree.get(rp) ?? 0) === 0).sort();
  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    const dependents = [...(reverseGraph.get(node) ?? [])].sort();
    for (const dep of dependents) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) { queue.push(dep); queue.sort(); }
    }
  }

  const sortedSet = new Set(sorted);
  for (const rp of relPaths.sort()) if (!sortedSet.has(rp)) sorted.push(rp);
  return sorted;
}

// ---------- SMART ORDERING ----------

function getCluster(relPath: string): string | null {
  const base = path.basename(relPath);
  for (const cp of CLUSTER_PATTERNS) if (cp.regex.test(base)) return cp.label;
  return null;
}

function buildTurnQueue(files: FileEntry[], topoOrder: string[]): TurnEntry[] {
  const fileMap = new Map<string, FileEntry>();
  for (const f of files) fileMap.set(f.relPath, f);

  const turns: TurnEntry[] = [];
  const queued = new Set<string>();

  const entryPoints = topoOrder.filter((rp) => ENTRY_POINT_NAMES.has(path.basename(rp)));
  for (const rp of entryPoints) {
    if (!queued.has(rp)) { turns.push({ files: [rp], label: "entry point" }); queued.add(rp); }
  }

  const clusterBuckets = new Map<string, string[]>();
  for (const rp of topoOrder) {
    if (queued.has(rp)) continue;
    const cl = getCluster(rp);
    if (cl) { if (!clusterBuckets.has(cl)) clusterBuckets.set(cl, []); clusterBuckets.get(cl)!.push(rp); }
  }
  for (const [label, rps] of clusterBuckets.entries()) {
    for (const rp of rps) {
      if (!queued.has(rp)) {
        const last = turns[turns.length - 1];
        if (last && last.label === `cluster: ${label}` && last.files.length < 3) {
          last.files.push(rp);
        } else {
          turns.push({ files: [rp], label: `cluster: ${label}` });
        }
        queued.add(rp);
      }
    }
  }

  const smallBatch: string[] = [];
  for (const rp of topoOrder) {
    if (queued.has(rp)) continue;
    if (fileMap.get(rp)!.lines < SMALL_FILE_LINE_THRESHOLD) smallBatch.push(rp);
  }
  for (let i = 0; i < smallBatch.length; i += SMALL_FILE_BATCH_SIZE) {
    const batch = smallBatch.slice(i, i + SMALL_FILE_BATCH_SIZE);
    for (const rp of batch) queued.add(rp);
    turns.push({ files: batch, label: "batch (small files)" });
  }

  for (const rp of topoOrder) {
    if (!queued.has(rp)) { turns.push({ files: [rp] }); queued.add(rp); }
  }

  return turns;
}

// ---------- MANIFEST ----------

function pageName(pageNum: number): string {
  return `manifest-page-${String(pageNum).padStart(3, "0")}.md`;
}

function buildManifestPages(
  turns: TurnEntry[],
  fileMap: Map<string, FileEntry>,
  targetPath: string,
  distillDir: string
): number {
  const now = new Date().toISOString().split("T")[0];
  const totalFiles = turns.reduce((s, t) => s + t.files.length, 0);
  const totalLines = [...fileMap.values()].reduce((s, f) => s + f.lines, 0);
  const totalKB = Math.round([...fileMap.values()].reduce((s, f) => s + f.sizeKB, 0));
  const totalPages = Math.ceil(turns.length / PAGE_SIZE);

  let index = `# Distillation Manifest\n`;
  index += `Generated: ${now}\n`;
  index += `Root: ${targetPath}\n`;
  index += `Total: ${totalFiles} files — ${totalLines.toLocaleString()} lines — ${totalKB}KB\n`;
  index += `Turns: ${turns.length} across ${totalPages} pages (${PAGE_SIZE} turns/page)\n\n`;
  index += `## Phase 1 pages\n`;
  for (let p = 1; p <= totalPages; p++) {
    const s = (p - 1) * PAGE_SIZE + 1;
    const e = Math.min(p * PAGE_SIZE, turns.length);
    index += `- ${pageName(p)} (turns ${s}–${e})\n`;
  }

  const dirs = new Set<string>();
  for (const f of fileMap.values()) dirs.add(path.dirname(f.relPath) || ".");
  index += `\n---\n\n## Phase 2 — Module summaries\nAfter Phase 1 is complete:\n\n`;
  for (const dir of [...dirs].sort()) {
    index += `- [ ] \`${dir}/\` → .think/distill/modules/${dir.replace(/\//g, "_")}.md\n`;
  }
  index += `\n---\n\n## Phase 3 — Final outputs\n`;
  index += `- [ ] .think/distill/architecture.md\n`;
  index += `- [ ] .think/distill/index.md\n`;
  fs.writeFileSync(path.join(distillDir, "manifest.md"), index, "utf8");

  for (let p = 1; p <= totalPages; p++) {
    const start = (p - 1) * PAGE_SIZE;
    const end = Math.min(p * PAGE_SIZE, turns.length);
    let page = `# Distillation — Page ${p}/${totalPages} (Turns ${start + 1}–${end})\n\n`;
    for (let i = start; i < end; i++) {
      const t = turns[i];
      const label = t.label ? ` *(${t.label})*` : "";
      if (t.files.length === 1) {
        const f = fileMap.get(t.files[0])!;
        page += `- [ ] \`${f.relPath}\` (${f.lines} lines, ${f.sizeKB}KB)${label}\n`;
      } else {
        page += `- [ ] **Turn ${i + 1}**${label}:\n`;
        for (const rp of t.files) {
          const f = fileMap.get(rp)!;
          page += `  - \`${f.relPath}\` (${f.lines} lines, ${f.sizeKB}KB)\n`;
        }
      }
    }
    fs.writeFileSync(path.join(distillDir, pageName(p)), page, "utf8");
  }

  return totalPages;
}

// ---------- PHASE 1 — PROGRAMMATIC SUB-PI PROCESSING ----------

// Mark the first unchecked [ ] entry in the manifest page for this turn index as done.
function markTurnDone(turnIndex: number, distillDir: string): void {
  const pageNum = Math.floor(turnIndex / PAGE_SIZE) + 1;
  const pageFile = path.join(distillDir, pageName(pageNum));
  try {
    let content = fs.readFileSync(pageFile, "utf8");
    content = content.replace("- [ ]", "- [✓]"); // first unchecked = current turn
    fs.writeFileSync(pageFile, content, "utf8");
  } catch {}
}

// Returns the 0-based turn index of the first unchecked entry, or -1 if all done.
function findFirstUncheckedTurnIndex(distillDir: string): number {
  try {
    const pages = fs.readdirSync(distillDir)
      .filter((f) => /^manifest-page-\d+\.md$/.test(f))
      .sort();
    let globalIndex = 0;
    for (const p of pages) {
      const content = fs.readFileSync(path.join(distillDir, p), "utf8");
      for (const line of content.split("\n")) {
        if (/^- \[ \]/.test(line)) return globalIndex;
        if (/^- \[✓\]/.test(line)) globalIndex++;
      }
    }
  } catch {}
  return -1;
}

// Spawn a fresh pi subprocess to summarize one turn (single file or batch).
async function processFileTurn(
  relPaths: string[],
  rootDir: string,
  distillDir: string,
  turnIndex: number,
  totalTurns: number,
  cwd: string,
  ctx: any
): Promise<void> {
  const tmpDir = path.join(distillDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const isBatch = relPaths.length > 1;
  const outFileName = isBatch
    ? `batch-${String(turnIndex + 1).padStart(3, "0")}.md`
    : relPaths[0].replace(/[\\/]/g, "-") + ".md";
  const outFile = path.join(distillDir, "files", outFileName);
  const logFile = path.join(distillDir, "distill.log");
  const timestamp = () => new Date().toISOString().slice(11, 19);
  const log = (msg: string) => {
    try { fs.appendFileSync(logFile, `[${timestamp()}] ${msg}\n`, "utf8"); } catch {}
  };
  const fileLabel = isBatch
    ? `${relPaths[0]} +${relPaths.length - 1} more`
    : relPaths[0];

  // Read file content(s) programmatically — sub-Pi won't need tools
  let fileContents = "";
  for (const rp of relPaths) {
    const fullPath = path.join(rootDir, rp);
    try {
      const content = fs.readFileSync(fullPath, "utf8");
      fileContents += `\n--- FILE: ${rp} ---\n${content}\n--- END FILE ---\n`;
    } catch {
      fileContents += `\n--- FILE: ${rp} ---\n[Could not read file]\n--- END FILE ---\n`;
    }
  }

  let prompt: string;
  if (!isBatch) {
    prompt = `Summarize the following source file. Output ONLY the summary in the format below, nothing else.
${fileContents}
# ${relPaths[0]}
## Purpose
[One sentence: what this file does]
## Exports
[Key functions / classes / constants exported]
## Dependencies
[What it imports — internal and external]
## Patterns
[Notable logic, design decisions, or gotchas]
## Summary
[2–3 sentences max]

Under 400 words. Synthesize what it DOES and WHY.
If auto-generated, output only: # ${relPaths[0]}\n## Purpose: auto-generated — skipped`;
  } else {
    prompt = `Summarize the following batch of small source files. Output ONLY the summaries, nothing else.
${fileContents}
For each file output:
# <filepath>
## Purpose: [one sentence]
## Key exports: [brief]
## Summary: [1–2 sentences]

Under 600 words total.`;
  }

  const promptFile = path.join(tmpDir, `prompt-${String(turnIndex + 1).padStart(4, "0")}.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");

  log(`TURN ${turnIndex + 1}/${totalTurns} — ${fileLabel}`);
  ctx.ui.notify(`distill [${turnIndex + 1}/${totalTurns}] ⏳ summarizing: ${fileLabel}`, "info");

  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
      { cwd, timeout: 300000 }
    );
    const summary = (stdout || "").trim();
    if (summary.length > 20) {
      fs.writeFileSync(outFile, summary, "utf8");
      log(`  ✓ done (${summary.length} chars)`);
      ctx.ui.notify(`distill [${turnIndex + 1}/${totalTurns}] ✓ done: ${fileLabel} (${summary.length} chars)`, "info");
    } else {
      fs.writeFileSync(outFile, `# ${relPaths.join(", ")}\n## Error\nSub-Pi returned empty/short output: "${summary}"\n`, "utf8");
      log(`  ✗ empty output`);
      ctx.ui.notify(`distill [${turnIndex + 1}/${totalTurns}] ✗ empty output: ${fileLabel}`, "warn");
    }
  } catch (e: any) {
    const errMsg = e.message || "unknown error";
    const stderr = (e.stderr || "").slice(0, 300);
    const stdout = (e.stdout || "").trim();
    log(`  ✗ FAILED — ${errMsg}`);
    log(`  stderr: ${stderr.replace(/\n/g, " ")}`);
    // If there's usable stdout despite the error, save it anyway
    if (stdout.length > 50) {
      fs.writeFileSync(outFile, stdout, "utf8");
      log(`  salvaged stdout (${stdout.length} chars)`);
      ctx.ui.notify(`distill [${turnIndex + 1}/${totalTurns}] ⚠ partial: ${fileLabel}`, "warn");
    } else {
      fs.writeFileSync(outFile, `# ${relPaths.join(", ")}\n## Error\nSub-Pi failed: ${errMsg}\n`, "utf8");
      ctx.ui.notify(`distill [${turnIndex + 1}/${totalTurns}] ✗ failed: ${fileLabel}`, "warn");
    }
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

// Run all turns programmatically, optionally starting from a specific turn index.
async function processAllFiles(
  turns: TurnEntry[],
  rootDir: string,
  distillDir: string,
  ctx: any,
  startFrom = 0
): Promise<void> {
  const stateFile = path.join(ctx.cwd, ".think", "_state.md");
  const logFile = path.join(distillDir, "distill.log");
  const totalTurns = turns.length;
  const totalPages = Math.ceil(totalTurns / PAGE_SIZE);

  fs.mkdirSync(path.join(distillDir, "files"), { recursive: true });
  try { fs.appendFileSync(logFile, `\n=== DISTILL START — ${totalTurns} turns, starting from ${startFrom} ===\n`, "utf8"); } catch {}

  for (let i = startFrom; i < totalTurns; i++) {
    const turn = turns[i];
    const pageNum = Math.floor(i / PAGE_SIZE) + 1;
    const preview = turn.files[0] + (turn.files.length > 1 ? ` +${turn.files.length - 1} more` : "");
    ctx.ui.notify(
      `distill: turn ${i + 1}/${totalTurns} (page ${pageNum}/${totalPages}) — ${preview} …`,
      "info"
    );
    await processFileTurn(turn.files, rootDir, distillDir, i, totalTurns, ctx.cwd, ctx);
    markTurnDone(i, distillDir);
    try {
      fs.writeFileSync(
        stateFile,
        `distilling: ${i + 1} / ${totalTurns} done (page ${pageNum}/${totalPages})\n`,
        "utf8"
      );
    } catch {}
  }
}

// ---------- PHASE 2 + 3 WORKFLOW MESSAGE ----------

function buildPhase23Workflow(distillDir: string): string {
  let actualFiles = 0;
  try {
    actualFiles = fs.readdirSync(path.join(distillDir, "files")).filter((f) => f.endsWith(".md")).length;
  } catch {}
  return `[distill] Phase 1 complete — ${actualFiles} file summaries in .think/distill/files/

## Phase 2 — Module summaries

For each directory listed in manifest.md with an unchecked [ ]:
1. Read all relevant .think/distill/files/ summaries for that directory
2. Write .think/distill/modules/<dirname>.md

Format:
# <directory>
## Overview
[What this module/directory does as a whole]
## Key files
[Most important files and their role]
## Patterns
[Shared patterns or conventions across this module]
## Summary
[2–3 sentences]

3. Mark [✓] in manifest.md for that directory entry
4. STOP — wait for next turn

## Phase 3 — Architecture + Index

After ALL Phase 2 entries are [✓]:

**.think/distill/architecture.md**
- Entry points and how the system starts
- Data flow between modules
- Key design patterns and decisions
- External dependencies
- Non-obvious gotchas

**.think/distill/index.md**
A lookup table: "if you need to understand X, read Y"
One line per concept. Cover features, patterns, models, APIs, config.

Mark [✓] in manifest.md when each Phase 3 file is done.

Start Phase 2 now.`;
}

// ---------- RESUME ----------

function countChecked(distillDir: string): { done: number; total: number } {
  let done = 0, total = 0;
  try {
    const pages = fs.readdirSync(distillDir).filter((f) => /^manifest-page-\d+\.md$/.test(f)).sort();
    for (const p of pages) {
      const c = fs.readFileSync(path.join(distillDir, p), "utf8");
      total += (c.match(/^- \[/gm) ?? []).length;
      done  += (c.match(/^- \[✓\]/gm) ?? []).length;
    }
  } catch {}
  return { done, total };
}

// ---------- UNDERSTANDING PHASE ----------

function askPurpose(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("What is the purpose of this distillation? (what are you trying to understand): ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatFileTree(files: FileEntry[]): string {
  const tree: Record<string, string[]> = {};
  for (const f of files) {
    const dir = path.dirname(f.relPath).replace(/\\/g, "/") || ".";
    if (!tree[dir]) tree[dir] = [];
    tree[dir].push(`${path.basename(f.relPath)} (${f.lines} lines)`);
  }
  let result = "";
  for (const [dir, names] of Object.entries(tree).sort()) {
    result += `${dir}/\n`;
    for (const name of names.sort()) result += `  ${name}\n`;
  }
  return result;
}

async function runUnderstandingBatch(
  batch: FileEntry[],
  batchIndex: number,
  totalBatches: number,
  purpose: string,
  distillDir: string,
  cwd: string
): Promise<string[]> {
  const tmpDir = path.join(distillDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const outFile = path.join(tmpDir, `understanding-batch-${String(batchIndex + 1).padStart(3, "0")}.md`);
  const promptFile = path.join(tmpDir, `understanding-prompt-${String(batchIndex + 1).padStart(3, "0")}.md`);

  const prompt = `Purpose: ${purpose}

You are reviewing batch ${batchIndex + 1}/${totalBatches} of files from a codebase.
Select which files are worth analyzing in detail to understand the codebase relative to the stated purpose.

Keep files that contain: business logic, core functionality, APIs, models, services, or logic directly relevant to the purpose.
Skip files that are: auto-generated, vendor, pure config, styles/CSS, test fixtures, static assets, or clearly unrelated to the purpose.

Files in this batch:
${formatFileTree(batch)}

Write ONLY the relative paths of the selected files to:
${outFile}

One path per line. No explanation, no markdown, no other text — just the paths.`;

  fs.writeFileSync(promptFile, prompt, "utf8");
  try {
    await execAsync(`pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`, { cwd, timeout: 300000 });
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }

  try {
    const content = fs.readFileSync(outFile, "utf8");
    return content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

async function runUnderstandingPhase(
  files: FileEntry[],
  purpose: string,
  distillDir: string,
  ctx: any
): Promise<Set<string>> {
  const selected = new Set<string>();
  const totalBatches = Math.ceil(files.length / UNDERSTANDING_BATCH_SIZE);

  ctx.ui.notify(`distill --understanding: reviewing ${files.length} files in ${totalBatches} batches …`, "info");

  for (let i = 0; i < totalBatches; i++) {
    const batch = files.slice(i * UNDERSTANDING_BATCH_SIZE, (i + 1) * UNDERSTANDING_BATCH_SIZE);
    ctx.ui.notify(`distill --understanding: batch ${i + 1}/${totalBatches} …`, "info");
    const batchSelected = await runUnderstandingBatch(batch, i, totalBatches, purpose, distillDir, ctx.cwd);
    for (const p of batchSelected) selected.add(p);
  }

  let summary = `# Understanding Phase — Selected Files\n`;
  summary += `Purpose: ${purpose}\n`;
  summary += `Selected: ${selected.size} / ${files.length} files\n\n`;
  for (const p of [...selected].sort()) summary += `- ${p}\n`;
  fs.writeFileSync(path.join(distillDir, "selected-files.md"), summary, "utf8");

  ctx.ui.notify(
    `distill --understanding: selected ${selected.size}/${files.length} files. Building manifest …`,
    "info"
  );

  return selected;
}

// ---------- EXTENSION ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const distillDir = path.join(ctx.cwd, ".think", "distill");
    if (!fs.existsSync(path.join(distillDir, "manifest.md"))) return;

    const { done, total } = countChecked(distillDir);
    if (total === 0) return;

    if (done < total) {
      ctx.ui.notify(
        `distill: Phase 1 incomplete (${done}/${total} done). Run /distill --resume to continue.`,
        "warn"
      );
      return;
    }

    // Phase 1 done — check if Phase 2/3 still need work
    const manifestContent = fs.readFileSync(path.join(distillDir, "manifest.md"), "utf8");
    if (!/^- \[ \]/m.test(manifestContent)) return;

    ctx.ui.notify("distill: Phase 2/3 incomplete. Run /distill --resume to continue.", "warn");
  });

  pi.registerCommand("distill", {
    description: "Crawl a codebase and build a .think/distill/ knowledge base. Usage: /distill [path] | /distill --resume | /distill [path] --understanding \"purpose\"",
    handler: async (args: any, ctx: any) => {
      const argStr = args?.trim() ?? "";
      const isResume = argStr === "--resume" || argStr.startsWith("--resume ");

      const distillDir = path.join(ctx.cwd, ".think", "distill");
      const turnsFile = path.join(distillDir, "turns.json");

      // ── RESUME MODE ──────────────────────────────────────────────────────
      if (isResume) {
        if (!fs.existsSync(path.join(distillDir, "manifest.md"))) {
          ctx.ui.notify("distill: no manifest found — run /distill [path] first.", "warn");
          return;
        }
        const { done, total } = countChecked(distillDir);

        if (done < total) {
          if (!fs.existsSync(turnsFile)) {
            ctx.ui.notify("distill: turns.json missing — re-run /distill to restart.", "warn");
            return;
          }
          const state: TurnsState = JSON.parse(fs.readFileSync(turnsFile, "utf8"));
          const rootDir = path.resolve(ctx.cwd, state.rootArg);
          const firstUnchecked = findFirstUncheckedTurnIndex(distillDir);
          ctx.ui.notify(`distill --resume: Phase 1 ${done}/${total} done — resuming from turn ${firstUnchecked + 1} …`, "info");
          await processAllFiles(state.turns, rootDir, distillDir, ctx, firstUnchecked);
          ctx.ui.notify("distill: Phase 1 complete. Injecting Phase 2 + 3 workflow …", "info");
          await pi.sendMessage(
            {
              customType: "distill_resume_phase23",
              content: buildPhase23Workflow(distillDir),
              display: { label: "distill --resume", content: `Phase 1 complete. Starting Phase 2 + 3.` },
            },
            { deliverAs: "steer" }
          );
        } else {
          ctx.ui.notify("distill --resume: Phase 1 complete. Re-injecting Phase 2 + 3 workflow …", "info");
          const state: TurnsState = fs.existsSync(turnsFile)
            ? JSON.parse(fs.readFileSync(turnsFile, "utf8"))
            : { totalFiles: total };
          await pi.sendMessage(
            {
              customType: "distill_resume_phase23",
              content: buildPhase23Workflow(distillDir),
              display: { label: "distill --resume", content: `Resuming Phase 2 + 3.` },
            },
            { deliverAs: "steer" }
          );
        }
        return;
      }

      // ── FRESH CRAWL ──────────────────────────────────────────────────────

      const isUnderstanding = argStr.includes("--understanding");
      const understandingMatch = argStr.match(/--understanding\s+"([^"]*)"/);
      let understandingPurpose: string | null = null;
      if (isUnderstanding) {
        understandingPurpose = understandingMatch?.[1]?.trim() || await askPurpose();
      }
      const cleanedArgs = argStr
        .replace(/--understanding\s+"[^"]*"/, "")
        .replace("--understanding", "")
        .trim();

      const targetArg = cleanedArgs || ".";
      const rootDir = path.resolve(ctx.cwd, targetArg);

      if (!fs.existsSync(rootDir)) {
        ctx.ui.notify(`distill: path not found: ${rootDir}`, "warn");
        return;
      }
      if (!fs.statSync(rootDir).isDirectory()) {
        ctx.ui.notify(`distill: ${rootDir} is not a directory`, "warn");
        return;
      }

      ctx.ui.notify(`distill: crawling ${rootDir} …`, "info");
      const files = crawl(rootDir, rootDir);

      if (files.length === 0) {
        ctx.ui.notify(`distill: no source files found in ${rootDir}.`, "warn");
        return;
      }

      ctx.ui.notify(`distill: ${files.length} files found …`, "info");

      // Understanding phase: filter files by purpose before distilling.
      let filteredFiles = files;
      if (understandingPurpose) {
        fs.mkdirSync(path.join(distillDir, "files"), { recursive: true });
        const selected = runUnderstandingPhase(files, understandingPurpose, distillDir, ctx);
        filteredFiles = files.filter((f) => selected.has(f.relPath.replace(/\\/g, "/")));
        ctx.ui.notify(
          `distill: understanding phase complete — ${filteredFiles.length} files selected.`,
          "info"
        );
      }

      // Build import graph and smart ordering.
      ctx.ui.notify("distill: building import graph …", "info");
      const graph = buildImportGraph(filteredFiles);
      const topoOrder = topoSort(filteredFiles, graph);
      const turns = buildTurnQueue(filteredFiles, topoOrder);
      const totalFiles = turns.reduce((s, t) => s + t.files.length, 0);

      ctx.ui.notify(
        `distill: ${filteredFiles.length} files → ${turns.length} turns. Writing manifest …`,
        "info"
      );

      fs.mkdirSync(path.join(distillDir, "files"), { recursive: true });
      fs.mkdirSync(path.join(distillDir, "modules"), { recursive: true });

      const fileMap = new Map<string, FileEntry>();
      for (const f of filteredFiles) fileMap.set(f.relPath, f);

      buildManifestPages(turns, fileMap, targetArg, distillDir);

      // Save turns state for resume support.
      const state: TurnsState = { turns, rootArg: targetArg, totalFiles };
      fs.writeFileSync(turnsFile, JSON.stringify(state, null, 2), "utf8");

      // Phase 1 — fully programmatic, blocks until complete.
      ctx.ui.notify(`distill: starting Phase 1 — ${turns.length} turns via sub-Pi …`, "info");
      await processAllFiles(turns, rootDir, distillDir, ctx);
      ctx.ui.notify("distill: Phase 1 complete. Injecting Phase 2 + 3 workflow …", "info");

      // Phase 2 + 3 — LLM driven.
      await pi.sendMessage(
        {
          customType: "distill_workflow",
          content: buildPhase23Workflow(distillDir),
          display: {
            label: "distill",
            content: `Phase 1 complete (${totalFiles} files). Starting Phase 2 + 3.`,
          },
        },
        { deliverAs: "steer" }
      );
    },
  });
}
