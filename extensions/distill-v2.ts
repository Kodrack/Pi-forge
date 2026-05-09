// distill-v2.ts
// Multi-level codebase distillation with uniform compression.
//
// Every level has the same files in the same folder structure.
// Each level is ~N% of the previous level's size (configurable via --ratio).
//
// L1 reads source → writes compressed summaries to .think/distill/L1/
// L2 reads L1 → writes further compressed to .think/distill/L2/
// L3 reads L2 → writes further compressed to .think/distill/L3/
// ...
//
// Usage:
//   /distill [path]                      — L1 distillation (default: .)
//   /distill [path] --ratio 30           — compress to 30% instead of default 50%
//   /distill [path] --purpose "question" — take notes during L1
//   /distill --level 2                   — compress L1 into L2
//   /distill --level 2 --ratio 60        — L2 at 60% of L1
//   /distill --resume                    — resume interrupted distillation
//
// Install: copy to ~/.pi/agent/extensions/distill-v2.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── CONFIG ──────────────────────────────────────────────────────────────────

const DEFAULT_RATIO = 50;
const CONTEXT_WINDOW_CHARS = 128000;
const CHUNK_SIZE_CHARS = Math.floor(CONTEXT_WINDOW_CHARS * 0.20);
const CONTEXT_THRESHOLD_CHARS = Math.floor(CONTEXT_WINDOW_CHARS * 0.80);
const SUB_PI_TIMEOUT = 300000;
const MAX_FILE_SIZE_BYTES = 512 * 1024;

const INCLUDE_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".cpp", ".c",
  ".css", ".scss", ".sass", ".less",
  ".html", ".vue", ".svelte", ".razor",
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

const ENTRY_POINT_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "main.ts", "main.tsx", "main.js", "main.py",
  "app.ts", "app.tsx", "app.js", "app.jsx",
  "server.ts", "server.js",
  "__init__.py", "mod.rs",
]);

// ── TYPES ───────────────────────────────────────────────────────────────────

interface FileEntry {
  relPath: string;
  lines: number;
  sizeKB: number;
  content: string;
}

interface LevelState {
  total: number;
  done: number;
  ratio: number;
}

interface Manifest {
  rootArg: string;
  rootDir: string;
  purpose?: string;
  files: string[];
  levels: Record<string, LevelState>;
  startedAt: string;
  updatedAt: string;
}

// ── LOGGING ─────────────────────────────────────────────────────────────────

function appendLog(logFile: string, msg: string): void {
  if (!logFile) return;
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync(logFile, `[${ts}] ${msg}\n`, "utf8"); } catch {}
}

// ── MANIFEST ────────────────────────────────────────────────────────────────

function loadManifest(distillDir: string): Manifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(distillDir, "manifest.json"), "utf8"));
  } catch { return null; }
}

function saveManifest(distillDir: string, manifest: Manifest): void {
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(distillDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

// ── CRAWL ───────────────────────────────────────────────────────────────────

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

// ── IMPORT GRAPH ────────────────────────────────────────────────────────────

function extractImports(content: string): string[] {
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
    const imports = extractImports(f.content);
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
    for (const dep of [...(reverseGraph.get(node) ?? [])].sort()) {
      const nd = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, nd);
      if (nd === 0) { queue.push(dep); queue.sort(); }
    }
  }
  const sortedSet = new Set(sorted);
  for (const rp of relPaths.sort()) if (!sortedSet.has(rp)) sorted.push(rp);
  return sorted;
}

// ── ORDERING ────────────────────────────────────────────────────────────────

function buildOrderedFileList(files: FileEntry[], topoOrder: string[]): string[] {
  const ordered: string[] = [];
  const queued = new Set<string>();
  for (const rp of topoOrder) {
    if (ENTRY_POINT_NAMES.has(path.basename(rp)) && !queued.has(rp)) {
      ordered.push(rp); queued.add(rp);
    }
  }
  for (const rp of topoOrder) {
    if (!queued.has(rp)) { ordered.push(rp); queued.add(rp); }
  }
  return ordered;
}

// ── PROMPTS ─────────────────────────────────────────────────────────────────

function buildL1Prompt(content: string, relPath: string, ratio: number, purpose?: string): string {
  let guide: string;
  if (ratio <= 30) {
    guide = "Be aggressive: keep only purpose, key function signatures, critical logic, and integration points. Strip everything else.";
  } else if (ratio <= 50) {
    guide = "Keep: purpose, function/method signatures with types, key logic flow, business rules, integration points. Remove: boilerplate, repetitive patterns, obvious code.";
  } else {
    guide = "Keep most detail: signatures, logic, patterns, edge cases, integration points. Only remove obvious boilerplate and whitespace.";
  }

  let prompt = `Summarize the following source file. Write a structured summary, NOT condensed code.
Target roughly ${ratio}% of the original file's length in summary text.
${guide}
Output ONLY the summary, nothing else.

--- FILE: ${relPath} ---
${content}
--- END FILE ---

Format:
# ${path.basename(relPath)}
## Purpose
[What this file does — one sentence]
## Key Exports
[Classes, functions, types — include method signatures with param types and return types]
## Dependencies
[Imports — internal and external]
## Key Logic
[Important business rules, algorithms, edge cases — be specific with function names and behavior]
## Integration Points
[Events emitted/consumed, API endpoints exposed, pub/sub topics subscribed/published, SignalR hubs, queue names, webhooks — anything another file could connect to]
## Cross-References
[Files this file imports from, and if apparent, what other files would use this one — note the connection type (imports, calls, event listener, etc.)]
## Data Model
[Key interfaces/types/dataclasses and their fields with types]
## Summary
[2-3 sentences covering the overall design]

Rules:
- Be specific. Include actual function names, parameter types, return types
- Under 150 lines
- If this file references other files (imports, calls, event names), note those connections explicitly
- If auto-generated/trivial: output "# ${relPath}\\nAuto-generated — skipped"`;

  if (purpose) {
    prompt += `

ADDITIONAL TASK: If this file contains anything relevant to the following question, add a "## Notes" section at the very end:
Purpose: "${purpose}"
Include specific function names, logic paths, patterns relevant to this purpose.
If nothing relevant, do NOT add a Notes section.`;
  }

  return prompt;
}

function buildLNPrompt(content: string, relPath: string, ratio: number): string {
  let guide: string;
  if (ratio <= 30) {
    guide = "Keep only the essence: purpose, most critical exports/logic, and integration points.";
  } else if (ratio <= 50) {
    guide = "Keep the most important information: purpose, key functions, critical logic. Drop less important details but preserve integration points.";
  } else {
    guide = "Lightly compress: merge similar points, tighten wording, keep most detail.";
  }

  return `Condense the following summary to roughly ${ratio}% of its length.
${guide}
Output ONLY the condensed version, nothing else.

--- FILE: ${relPath} ---
${content}
--- END FILE ---

Rules:
- Preserve the most critical information
- ALWAYS preserve: Integration Points (events, topics, endpoints) and Cross-References sections — these are essential for navigation
- Preserve method signatures and their types
- Output roughly ${ratio}% of input length
- Minimum 3 lines
- If already minimal, output unchanged`;
}

// ── NOTES EXTRACTION ────────────────────────────────────────────────────────

function extractNotes(output: string, relPath: string): { summary: string; notes: string | null } {
  const idx = output.indexOf("## Notes");
  if (idx === -1) return { summary: output, notes: null };
  const summary = output.slice(0, idx).trim();
  const notesBody = output.slice(idx + "## Notes".length).trim();
  const notes = `### ${relPath}\n${notesBody}\n\n`;
  return { summary, notes };
}

function writeNotes(notes: string, purpose: string, distillDir: string): void {
  const slug = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const notesFile = path.join(distillDir, "notes", `${slug}.md`);
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.appendFileSync(notesFile, notes, "utf8");
}

// ── LARGE FILE CHUNKING (L1 only) ──────────────────────────────────────────

async function processLargeFile(
  relPath: string,
  content: string,
  outputDir: string,
  ratio: number,
  cwd: string,
  ctx: any,
  index: number,
  total: number,
  tmpDir: string,
  logFile: string,
  purpose?: string,
  distillDir?: string
): Promise<void> {
  const lines = content.split("\n");
  const avgLineLen = content.length / lines.length;
  const chunkLines = Math.max(50, Math.floor(CHUNK_SIZE_CHARS / avgLineLen));
  const chunks: string[] = [];

  for (let i = 0; i < lines.length; i += chunkLines) {
    chunks.push(lines.slice(i, i + chunkLines).join("\n"));
  }

  ctx.ui.notify(`distill L1 [${index + 1}/${total}] 📦 ${relPath} → ${chunks.length} chunks`, "info");
  appendLog(logFile, `L1 [${index + 1}/${total}] — ${relPath} (${chunks.length} chunks)`);

  const chunkSummaries: string[] = [];

  for (let k = 0; k < chunks.length; k++) {
    const prompt = `This is chunk ${k + 1}/${chunks.length} of file ${relPath}.
Condense to roughly ${ratio}% of its length. Keep function signatures, key logic.
Output ONLY the condensed version.

--- CHUNK ${k + 1}/${chunks.length} of ${relPath} ---
${chunks[k]}
--- END CHUNK ---`;

    const pf = path.join(tmpDir, `chunk-${String(index + 1).padStart(4, "0")}-${k + 1}.md`);
    fs.writeFileSync(pf, prompt, "utf8");

    try {
      const { stdout } = await execAsync(
        `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${pf} < /dev/null`,
        { cwd, timeout: SUB_PI_TIMEOUT }
      );
      chunkSummaries.push((stdout || "").trim());
      ctx.ui.notify(`distill L1 [${index + 1}/${total}] chunk ${k + 1}/${chunks.length} ✓`, "info");
    } catch (e: any) {
      const salvaged = (e.stdout || "").trim();
      chunkSummaries.push(salvaged.length > 20 ? salvaged : `[Chunk ${k + 1} failed]`);
    } finally {
      try { fs.unlinkSync(pf); } catch {}
    }
  }

  // Merge chunks
  const merged = chunkSummaries.join("\n\n");
  let mergePrompt = `These are condensed chunks of ${relPath}. Merge into one cohesive condensed file.
Eliminate redundancy. Maintain logical flow.
Output ONLY the merged result.

${merged}`;

  if (purpose) {
    mergePrompt += `\n\nADDITIONAL TASK: If relevant to "${purpose}", add a "## Notes" section at the end.`;
  }

  const mf = path.join(tmpDir, `merge-${String(index + 1).padStart(4, "0")}.md`);
  fs.writeFileSync(mf, mergePrompt, "utf8");

  const outFile = path.join(outputDir, relPath + ".md");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${mf} < /dev/null`,
      { cwd, timeout: SUB_PI_TIMEOUT }
    );
    let output = (stdout || "").trim();

    if (purpose && distillDir) {
      const { summary, notes } = extractNotes(output, relPath);
      output = summary;
      if (notes) writeNotes(notes, purpose, distillDir);
    }

    fs.writeFileSync(outFile, output, "utf8");
    appendLog(logFile, `  ✓ merged (${output.length} chars)`);
    ctx.ui.notify(`distill L1 [${index + 1}/${total}] ✓ merged: ${relPath}`, "info");
  } catch (e: any) {
    fs.writeFileSync(outFile, `# ${relPath}\nChunk merge failed: ${(e.message || "").slice(0, 200)}\n`, "utf8");
    appendLog(logFile, `  ✗ merge failed`);
  } finally {
    try { fs.unlinkSync(mf); } catch {}
  }
}

// ── PROCESS SINGLE FILE ────────────────────────────────────────────────────

async function processFile(
  relPath: string,
  inputDir: string,
  outputDir: string,
  level: number,
  ratio: number,
  cwd: string,
  ctx: any,
  index: number,
  total: number,
  logFile: string,
  purpose?: string,
  distillDir?: string
): Promise<void> {
  const inputFile = level === 1
    ? path.join(inputDir, relPath)
    : path.join(inputDir, relPath + ".md");
  const outFile = path.join(outputDir, relPath + ".md");
  const tmpDir = distillDir ? path.join(distillDir, "tmp") : path.join(path.dirname(outputDir), "tmp");

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // Skip if already processed (resume support)
  try {
    const stat = fs.statSync(outFile);
    if (stat.size > 20) {
      ctx.ui.notify(`distill L${level} [${index + 1}/${total}] ⏭ exists: ${relPath}`, "info");
      return;
    }
  } catch {}

  // Read input
  let content: string;
  try {
    content = fs.readFileSync(inputFile, "utf8");
  } catch {
    fs.writeFileSync(outFile, `# ${relPath}\nCould not read input.\n`, "utf8");
    appendLog(logFile, `L${level} [${index + 1}/${total}] ✗ missing: ${relPath}`);
    return;
  }

  const lineCount = content.split("\n").length;

  // Tiny files — copy as-is
  if (lineCount < 10) {
    fs.writeFileSync(outFile, content, "utf8");
    ctx.ui.notify(`distill L${level} [${index + 1}/${total}] ⏭ tiny: ${relPath}`, "info");
    return;
  }

  // Large file chunking (L1 only)
  if (level === 1 && content.length > CONTEXT_THRESHOLD_CHARS) {
    await processLargeFile(relPath, content, outputDir, ratio, cwd, ctx, index, total, tmpDir, logFile, purpose, distillDir);
    return;
  }

  // Build prompt
  const prompt = level === 1
    ? buildL1Prompt(content, relPath, ratio, purpose)
    : buildLNPrompt(content, relPath, ratio);

  const promptFile = path.join(tmpDir, `p-L${level}-${String(index + 1).padStart(4, "0")}.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");

  const pct = Math.round(((index + 1) / total) * 100);
  ctx.ui.notify(`distill L${level} [${index + 1}/${total}] (${pct}%) ⏳ ${relPath} (${lineCount} lines)`, "info");
  appendLog(logFile, `L${level} [${index + 1}/${total}] — ${relPath} (${lineCount} lines)`);

  const startTime = Date.now();
  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
      { cwd, timeout: SUB_PI_TIMEOUT }
    );
    let output = (stdout || "").trim();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const outLines = output.split("\n").length;

    if (output.length > 20) {
      let hasNotes = false;
      if (purpose && distillDir) {
        const { summary, notes } = extractNotes(output, relPath);
        output = summary;
        if (notes) { writeNotes(notes, purpose, distillDir); hasNotes = true; }
      }
      fs.writeFileSync(outFile, output, "utf8");
      const compression = Math.round((outLines / lineCount) * 100);
      const noteTag = hasNotes ? " 📝" : "";
      appendLog(logFile, `  ✓ ${outLines} lines (${compression}%) in ${elapsed}s${noteTag}`);
      ctx.ui.notify(`distill L${level} [${index + 1}/${total}] (${pct}%) ✓ ${relPath} — ${lineCount}→${outLines} lines (${compression}%) ${elapsed}s${noteTag}`, "info");
    } else {
      fs.writeFileSync(outFile, `# ${relPath}\nEmpty output from sub-Pi.\n`, "utf8");
      appendLog(logFile, `  ✗ empty in ${elapsed}s`);
      ctx.ui.notify(`distill L${level} [${index + 1}/${total}] (${pct}%) ✗ empty: ${relPath} (${elapsed}s)`, "warn");
    }
  } catch (e: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stdout = (e.stdout || "").trim();
    if (stdout.length > 50) {
      fs.writeFileSync(outFile, stdout, "utf8");
      appendLog(logFile, `  ⚠ salvaged ${stdout.length} chars in ${elapsed}s`);
      ctx.ui.notify(`distill L${level} [${index + 1}/${total}] (${pct}%) ⚠ partial: ${relPath} (${elapsed}s)`, "warn");
    } else {
      fs.writeFileSync(outFile, `# ${relPath}\nSub-Pi failed: ${(e.message || "").slice(0, 200)}\n`, "utf8");
      appendLog(logFile, `  ✗ FAILED in ${elapsed}s`);
      ctx.ui.notify(`distill L${level} [${index + 1}/${total}] (${pct}%) ✗ failed: ${relPath} (${elapsed}s)`, "warn");
    }
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

// ── DISTILL LEVEL ──────────────────────────────────────────────────────────

async function distillLevel(
  level: number,
  ratio: number,
  manifest: Manifest,
  distillDir: string,
  ctx: any
): Promise<void> {
  const inputDir = level === 1
    ? manifest.rootDir
    : path.join(distillDir, `L${level - 1}`);
  const outputDir = path.join(distillDir, `L${level}`);
  const logFile = path.join(distillDir, "distill.log");
  const purpose = level === 1 ? manifest.purpose : undefined;
  const files = manifest.files;
  const total = files.length;
  const levelKey = `L${level}`;

  fs.mkdirSync(outputDir, { recursive: true });
  appendLog(logFile, `=== L${level} START — ${total} files, ratio ${ratio}% ===`);

  if (!manifest.levels[levelKey]) {
    manifest.levels[levelKey] = { total, done: 0, ratio };
  }

  for (let i = 0; i < total; i++) {
    await processFile(
      files[i], inputDir, outputDir, level, ratio,
      ctx.cwd, ctx, i, total, logFile, purpose, distillDir
    );
    manifest.levels[levelKey].done = i + 1;
    if ((i + 1) % 10 === 0) saveManifest(distillDir, manifest);
  }

  saveManifest(distillDir, manifest);
  appendLog(logFile, `=== L${level} COMPLETE ===`);
}

// ── PURPOSE EXPANSION ──────────────────────────────────────────────────────

async function runExpansion(
  purpose: string,
  distillDir: string,
  cwd: string,
  ctx: any,
  logFile: string,
  pi: ExtensionAPI
): Promise<void> {
  const slug = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const notesFile = path.join(distillDir, "notes", `${slug}.md`);

  if (!fs.existsSync(notesFile)) {
    ctx.ui.notify("distill: no relevant notes found for this purpose.", "info");
    appendLog(logFile, "EXPANSION: no notes file found");
    return;
  }

  const notes = fs.readFileSync(notesFile, "utf8").trim();
  if (notes.length < 20) {
    ctx.ui.notify("distill: notes too sparse for expansion.", "info");
    return;
  }

  const tmpDir = path.join(distillDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  let notesContent = notes;
  if (notesContent.length > CONTEXT_THRESHOLD_CHARS) {
    notesContent = notesContent.slice(0, CONTEXT_THRESHOLD_CHARS) + "\n\n[... truncated due to length ...]";
    appendLog(logFile, `EXPANSION: notes truncated from ${notes.length} to ${CONTEXT_THRESHOLD_CHARS} chars`);
  }

  const expansionPrompt = `You were asked to investigate a codebase with this question:
"${purpose}"

During the investigation, these notes were gathered from relevant files across the entire codebase:

${notesContent}

Based on these notes, provide a comprehensive answer to the original question.
- Be specific: cite file names, function names, class names
- Explain the flow/architecture relevant to the question
- If there are multiple relevant areas, organize by topic
- Highlight any concerns, patterns, or gaps you notice

Output ONLY the answer.`;

  const promptFile = path.join(tmpDir, "expansion.md");
  fs.writeFileSync(promptFile, expansionPrompt, "utf8");

  ctx.ui.notify("distill: running expansion on gathered notes...", "info");
  appendLog(logFile, `EXPANSION: starting (${notesContent.length} chars of notes)`);

  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
      { cwd, timeout: SUB_PI_TIMEOUT }
    );
    const answer = (stdout || "").trim();

    if (answer.length > 20) {
      const answerFile = path.join(distillDir, "notes", `${slug}-answer.md`);
      fs.writeFileSync(answerFile, `# ${purpose}\n\n${answer}\n`, "utf8");
      appendLog(logFile, `EXPANSION: complete (${answer.length} chars)`);
      ctx.ui.notify("distill: expansion complete.", "info");

      pi.sendMessage(
        `Distillation with purpose complete. The codebase was fully scanned for: "${purpose}"\n\n` +
        `Here's what was found:\n\n${answer}\n\n` +
        `Full notes: .think/distill/notes/${slug}.md\n` +
        `Full answer: .think/distill/notes/${slug}-answer.md`,
        { deliverAs: "steer" }
      );
    } else {
      ctx.ui.notify("distill: expansion produced empty result.", "warn");
      appendLog(logFile, "EXPANSION: empty output");
    }
  } catch (e: any) {
    const salvaged = (e.stdout || "").trim();
    if (salvaged.length > 50) {
      const answerFile = path.join(distillDir, "notes", `${slug}-answer.md`);
      fs.writeFileSync(answerFile, `# ${purpose}\n\n${salvaged}\n`, "utf8");
      ctx.ui.notify("distill: expansion partially completed (timeout). Answer saved.", "warn");
    } else {
      ctx.ui.notify("distill: expansion failed, but notes are saved.", "warn");
    }
    appendLog(logFile, `EXPANSION: failed — ${(e.message || "").slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
}

// ── EXTENSION ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: any, ctx: any) => {
    const distillDir = path.join(ctx.cwd, ".think", "distill");
    const manifest = loadManifest(distillDir);
    if (!manifest) return;

    for (const [key, state] of Object.entries(manifest.levels)) {
      if (state.done < state.total) {
        ctx.ui.notify(
          `distill: ${key} incomplete (${state.done}/${state.total}). Run /distill --resume.`,
          "warn"
        );
        return;
      }
    }
  });

  pi.registerCommand("distill", {
    description: "Multi-level codebase distillation. Usage: /distill [path] [--ratio N] [--purpose \"...\"] [--level N] [--resume]",
    handler: async (args: any, ctx: any) => {
      const argStr = args?.trim() ?? "";

      ctx.ui.notify(
        `╭─ /distill ─────────────────────────────────────╮\n` +
        `│ /distill [path]              L1 distillation   │\n` +
        `│ --ratio N        compression % (default 50)    │\n` +
        `│ --purpose        ask what you're looking for   │\n` +
        `│ --purpose "..."  purpose-driven + expansion    │\n` +
        `│ --level N        distill LN-1 → LN             │\n` +
        `│ --resume         continue interrupted run      │\n` +
        `╰───────────────────────────────────────────────╯`,
        "info"
      );

      // ── Parse flags ──
      const isResume = argStr.includes("--resume");
      const levelMatch = argStr.match(/--level\s+(\d+)/);
      const ratioMatch = argStr.match(/--ratio\s+(\d+)/);
      const purposeMatch = argStr.match(/--purpose\s+"([^"]*)"/);

      const requestedLevel = levelMatch ? parseInt(levelMatch[1]) : 1;
      const ratio = ratioMatch
        ? Math.max(10, Math.min(90, parseInt(ratioMatch[1])))
        : DEFAULT_RATIO;
      const purpose = purposeMatch?.[1]?.trim() || undefined;
      const hasPurposeFlag = /--purpose(?:\s|$)/.test(argStr);

      if (hasPurposeFlag && !purpose) {
        const extras = ratioMatch ? ` --ratio ${ratio}` : "";
        pi.sendMessage(
          `The user wants to run /distill with a purpose-driven investigation. ` +
          `Ask them: "What are you looking for in this codebase?" ` +
          `Once they answer, run exactly: /distill --purpose "their answer"${extras}`,
          { deliverAs: "steer" }
        );
        return;
      }

      const cleanedArgs = argStr
        .replace(/--resume/g, "")
        .replace(/--level\s+\d+/g, "")
        .replace(/--ratio\s+\d+/g, "")
        .replace(/--purpose\s+"[^"]*"/g, "")
        .trim();
      const targetArg = cleanedArgs || ".";

      const distillDir = path.join(ctx.cwd, ".think", "distill");

      // ── RESUME ──
      if (isResume) {
        const manifest = loadManifest(distillDir);
        if (!manifest) {
          ctx.ui.notify("distill: no manifest found. Run /distill [path] first.", "warn");
          return;
        }
        const levelKeys = Object.keys(manifest.levels).sort();
        for (const key of levelKeys) {
          const state = manifest.levels[key];
          if (state.done < state.total) {
            const lvl = parseInt(key.replace("L", ""));
            ctx.ui.notify(
              `distill --resume: ${key} is ${state.done}/${state.total} — resuming at ${state.ratio}%...`,
              "info"
            );
            await distillLevel(lvl, state.ratio, manifest, distillDir, ctx);
            ctx.ui.notify(`distill: ${key} complete.`, "info");
            return;
          }
        }
        ctx.ui.notify("distill: all levels complete. Use --level N for deeper compression.", "info");
        return;
      }

      // ── LEVEL N > 1 ──
      if (requestedLevel > 1) {
        const manifest = loadManifest(distillDir);
        if (!manifest) {
          ctx.ui.notify("distill: no manifest found. Run /distill first.", "warn");
          return;
        }
        const prevKey = `L${requestedLevel - 1}`;
        const prevState = manifest.levels[prevKey];
        if (!prevState || prevState.done < prevState.total) {
          ctx.ui.notify(`distill: ${prevKey} not complete. Finish it first.`, "warn");
          return;
        }
        const levelKey = `L${requestedLevel}`;
        const existingState = manifest.levels[levelKey];
        if (existingState && existingState.done >= existingState.total) {
          ctx.ui.notify(`distill: ${levelKey} already complete. Use --level ${requestedLevel + 1} or delete .think/distill/${levelKey}/ to redo.`, "info");
          return;
        }
        ctx.ui.notify(`distill: starting L${requestedLevel} at ${ratio}% compression (${manifest.files.length} files)...`, "info");
        await distillLevel(requestedLevel, ratio, manifest, distillDir, ctx);
        ctx.ui.notify(`distill: L${requestedLevel} complete.`, "info");
        return;
      }

      // ── FRESH L1 ──
      const existingManifest = loadManifest(distillDir);
      if (existingManifest) {
        const l1 = existingManifest.levels["L1"];
        if (l1 && l1.done >= l1.total) {
          ctx.ui.notify(
            "distill: L1 already complete. Use --level 2 for deeper compression, or delete .think/distill/ to restart.",
            "info"
          );
          return;
        }
        if (l1 && l1.done > 0) {
          ctx.ui.notify(
            `distill: L1 in progress (${l1.done}/${l1.total}). Use --resume to continue.`,
            "info"
          );
          return;
        }
      }

      const rootDir = path.resolve(ctx.cwd, targetArg);
      if (!fs.existsSync(rootDir)) {
        ctx.ui.notify(`distill: path not found: ${rootDir}`, "warn");
        return;
      }
      if (!fs.statSync(rootDir).isDirectory()) {
        ctx.ui.notify(`distill: not a directory: ${rootDir}`, "warn");
        return;
      }

      ctx.ui.notify(`distill: crawling ${rootDir}...`, "info");
      const files = crawl(rootDir, rootDir);

      if (files.length === 0) {
        ctx.ui.notify("distill: no source files found.", "warn");
        return;
      }

      ctx.ui.notify(`distill: ${files.length} files. Building import graph...`, "info");
      const graph = buildImportGraph(files);
      const topoOrder = topoSort(files, graph);
      const orderedFiles = buildOrderedFileList(files, topoOrder);

      fs.mkdirSync(distillDir, { recursive: true });

      const manifest: Manifest = {
        rootArg: targetArg,
        rootDir,
        purpose,
        files: orderedFiles,
        levels: {},
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveManifest(distillDir, manifest);

      ctx.ui.notify(
        `distill: starting L1 — ${orderedFiles.length} files at ${ratio}%${purpose ? ` (purpose: "${purpose.slice(0, 40)}...")` : ""}...`,
        "info"
      );
      await distillLevel(1, ratio, manifest, distillDir, ctx);
      ctx.ui.notify("distill: L1 complete.", "info");

      if (purpose) {
        const logFile = path.join(distillDir, "distill.log");
        await runExpansion(purpose, distillDir, ctx.cwd, ctx, logFile, pi);
      }
    },
  });
}
