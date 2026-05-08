// distill.ts
// Registers /distill [path] and /distill --resume commands.
// Crawls a codebase, builds an import graph, topologically sorts files
// (entry points first), clusters similar patterns, batches tiny files,
// then injects a bottom-up distillation workflow into the model.
//
// Smart ordering:
//   1. Entry points (index.ts, main.py, app.js …) — read first
//   2. Topological order by import graph — dependencies before dependents
//   3. Similarity clusters (*.controller.ts, *.service.ts …) grouped
//   4. Small files (< 30 lines) batched up to 5 per turn
//
// Install: copy to ~/.pi/agent/extensions/distill.ts
// Usage:   /distill src/   |  /distill .   |  /distill --resume

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

// ---------- CONFIG ----------

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

// Files that are treated as entry points (read first, top of queue).
const ENTRY_POINT_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "main.ts", "main.tsx", "main.js", "main.py",
  "app.ts", "app.tsx", "app.js", "app.jsx",
  "server.ts", "server.js",
  "__init__.py", "mod.rs",
]);

// Similarity clusters — files matching a pattern are grouped together.
// Order matters: more specific patterns first.
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
  content: string; // kept in memory only during manifest build, then discarded
}

// Turn entry used in the manifest — one turn = one or more files.
interface TurnEntry {
  files: string[];   // relPaths
  label?: string;    // e.g. "batch (small files)" or "cluster: controllers"
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
      } catch {
        // skip unreadable files silently
      }
    }
  }

  return results;
}

// ---------- IMPORT GRAPH ----------

// Extract imported relative paths from a file's content.
// Handles: import ... from './x', require('./x'), import('./x'), from 'x/y'.
// Only keeps relative paths (starts with ./ or ../).
function extractImports(content: string, ext: string): string[] {
  const imports: string[] = [];
  const patterns = [
    // ES import / export … from '…'
    /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    // require('…')
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // import('…')
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // Python: from .x import, import .x
    /from\s+([.\w/]+)\s+import/g,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const raw = m[1];
      if (raw.startsWith(".")) {
        imports.push(raw);
      }
    }
  }
  return imports;
}

// Resolve a relative import path to the relPath used in FileEntry, if possible.
function resolveImport(
  importerRelPath: string,
  importedRaw: string,
  fileIndex: Map<string, FileEntry>
): string | null {
  const importerDir = path.dirname(importerRelPath);
  const base = path.normalize(path.join(importerDir, importedRaw));

  // Try the raw path first, then common extensions.
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

// Build adjacency: file → set of files it imports.
function buildImportGraph(
  files: FileEntry[]
): Map<string, Set<string>> {
  const fileIndex = new Map<string, FileEntry>();
  for (const f of files) {
    fileIndex.set(f.relPath.replace(/\\/g, "/"), f);
  }

  const graph = new Map<string, Set<string>>();
  for (const f of files) {
    graph.set(f.relPath, new Set());
  }

  for (const f of files) {
    const ext = path.extname(f.relPath).toLowerCase();
    const imports = extractImports(f.content, ext);
    for (const raw of imports) {
      const resolved = resolveImport(f.relPath, raw, fileIndex);
      if (resolved && resolved !== f.relPath) {
        graph.get(f.relPath)!.add(resolved);
      }
    }
  }

  return graph;
}

// Topological sort (Kahn's algorithm). Files imported by others come first.
// Returns sorted relPaths. Cycles fall back to alphabetical.
function topoSort(
  files: FileEntry[],
  graph: Map<string, Set<string>>
): string[] {
  const relPaths = files.map((f) => f.relPath);
  const inDegree = new Map<string, number>();
  // inDegree = number of files that import THIS file (reverse edges)
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

  // Start with files that import nothing (leaf dependencies).
  const queue: string[] = relPaths
    .filter((rp) => (inDegree.get(rp) ?? 0) === 0)
    .sort(); // stable alphabetical within same level

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    const dependents = [...(reverseGraph.get(node) ?? [])].sort();
    for (const dep of dependents) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        queue.push(dep);
        queue.sort(); // keep sorted
      }
    }
  }

  // Any nodes not yet in sorted (cycles) — append alphabetically.
  const sortedSet = new Set(sorted);
  for (const rp of relPaths.sort()) {
    if (!sortedSet.has(rp)) sorted.push(rp);
  }

  return sorted;
}

// ---------- SMART ORDERING ----------

// Assign a cluster label to a file, or null if it doesn't match any cluster.
function getCluster(relPath: string): string | null {
  const base = path.basename(relPath);
  for (const cp of CLUSTER_PATTERNS) {
    if (cp.regex.test(base)) return cp.label;
  }
  return null;
}

// Build the ordered list of TurnEntry items.
// Strategy:
//   1. Entry points (by name) — one per turn, put first
//   2. Remaining files in topo order:
//      a. Small files (< threshold lines) — batched up to BATCH_SIZE per turn
//      b. Cluster files — grouped by cluster, one cluster per turn (or multi if large)
//      c. Unclustered files — one per turn
function buildTurnQueue(
  files: FileEntry[],
  topoOrder: string[]
): TurnEntry[] {
  const fileMap = new Map<string, FileEntry>();
  for (const f of files) fileMap.set(f.relPath, f);

  const turns: TurnEntry[] = [];
  const queued = new Set<string>();

  // Phase 1: entry points first (in topo order within entry points).
  const entryPoints = topoOrder.filter(
    (rp) => ENTRY_POINT_NAMES.has(path.basename(rp))
  );
  for (const rp of entryPoints) {
    if (!queued.has(rp)) {
      turns.push({ files: [rp], label: "entry point" });
      queued.add(rp);
    }
  }

  // Phase 2: cluster files grouped.
  // Collect by cluster label in topo order.
  const clusterBuckets = new Map<string, string[]>();
  for (const rp of topoOrder) {
    if (queued.has(rp)) continue;
    const cl = getCluster(rp);
    if (cl) {
      if (!clusterBuckets.has(cl)) clusterBuckets.set(cl, []);
      clusterBuckets.get(cl)!.push(rp);
    }
  }
  for (const [label, rps] of clusterBuckets.entries()) {
    for (const rp of rps) {
      if (!queued.has(rp)) {
        // Group up to 3 cluster files of the same type per turn.
        const last = turns[turns.length - 1];
        if (
          last &&
          last.label === `cluster: ${label}` &&
          last.files.length < 3
        ) {
          last.files.push(rp);
        } else {
          turns.push({ files: [rp], label: `cluster: ${label}` });
        }
        queued.add(rp);
      }
    }
  }

  // Phase 3: small files batched.
  const smallBatch: string[] = [];
  for (const rp of topoOrder) {
    if (queued.has(rp)) continue;
    const f = fileMap.get(rp)!;
    if (f.lines < SMALL_FILE_LINE_THRESHOLD) {
      smallBatch.push(rp);
    }
  }
  for (let i = 0; i < smallBatch.length; i += SMALL_FILE_BATCH_SIZE) {
    const batch = smallBatch.slice(i, i + SMALL_FILE_BATCH_SIZE);
    for (const rp of batch) queued.add(rp);
    turns.push({ files: batch, label: "batch (small files)" });
  }

  // Phase 4: remaining files — one per turn in topo order.
  for (const rp of topoOrder) {
    if (!queued.has(rp)) {
      turns.push({ files: [rp] });
      queued.add(rp);
    }
  }

  return turns;
}

// ---------- MANIFEST ----------

function buildManifest(
  turns: TurnEntry[],
  fileMap: Map<string, FileEntry>,
  targetPath: string
): string {
  const now = new Date().toISOString().split("T")[0];
  const totalFiles = turns.reduce((s, t) => s + t.files.length, 0);
  const totalLines = [...fileMap.values()].reduce((s, f) => s + f.lines, 0);
  const totalKB = Math.round([...fileMap.values()].reduce((s, f) => s + f.sizeKB, 0));

  let out = `# Distillation Manifest\n`;
  out += `Generated: ${now}\n`;
  out += `Root: ${targetPath}\n`;
  out += `Total: ${totalFiles} files — ${totalLines.toLocaleString()} lines — ${totalKB}KB\n`;
  out += `Turns: ${turns.length} (smart-ordered by import graph + clusters)\n\n`;
  out += `---\n\n`;
  out += `## Phase 1 — File summaries\n`;
  out += `Mark [✓] when each turn's summary is written to .think/distill/files/\n\n`;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const turnLabel = t.label ? ` *(${t.label})*` : "";
    if (t.files.length === 1) {
      const f = fileMap.get(t.files[0])!;
      out += `- [ ] \`${f.relPath}\` (${f.lines} lines, ${f.sizeKB}KB)${turnLabel}\n`;
    } else {
      out += `- [ ] **Turn ${i + 1}**${turnLabel}:\n`;
      for (const rp of t.files) {
        const f = fileMap.get(rp)!;
        out += `  - \`${f.relPath}\` (${f.lines} lines, ${f.sizeKB}KB)\n`;
      }
    }
  }

  // Collect unique directories for phase 2.
  const dirs = new Set<string>();
  for (const f of fileMap.values()) {
    dirs.add(path.dirname(f.relPath) || ".");
  }

  out += `\n---\n\n`;
  out += `## Phase 2 — Module summaries\n`;
  out += `After all files done, summarize each directory:\n\n`;
  for (const dir of [...dirs].sort()) {
    out += `- [ ] \`${dir}/\` → .think/distill/modules/${dir.replace(/\//g, "_")}.md\n`;
  }

  out += `\n---\n\n`;
  out += `## Phase 3 — Final outputs\n`;
  out += `- [ ] .think/distill/architecture.md — system overview, entry points, data flow\n`;
  out += `- [ ] .think/distill/index.md — "to answer X, read files Y, Z"\n`;

  return out;
}

// ---------- WORKFLOW MESSAGE ----------

function buildWorkflow(turns: TurnEntry[], targetPath: string): string {
  const totalFiles = turns.reduce((s, t) => s + t.files.length, 0);
  return `[distill] Manifest ready → .think/distill/manifest.md (${totalFiles} files / ${turns.length} turns in ${targetPath})

Files are ordered by import graph (dependencies first, entry points first).
Similar files are clustered. Small files (<30 lines) are batched up to 5 per turn.

## Phase 1 — File summaries

For each unchecked entry in the manifest (one turn at a time):

**Single file:**
1. Read the source file
2. Write .think/distill/files/<filepath-with-slashes-as-dashes>.md:

\`\`\`markdown
# <filepath>
## Purpose
[One sentence: what this file does]
## Exports
[Key functions / classes / constants exported]
## Dependencies
[What it imports — internal and external]
## Patterns
[Notable logic, design decisions, or gotchas worth knowing]
## Summary
[2–3 sentences max]
\`\`\`

**Batched turn (multiple small files):**
1. Read ALL files in the batch
2. Write ONE combined .think/distill/files/<batch-NNN>.md covering all of them
3. List each file under its own ## heading

**After writing the summary file:**
3. Edit manifest.md — change \`- [ ]\` to \`- [✓]\` for that entry
4. Update .think/_state.md: "distilling: X / ${totalFiles} done"
5. STOP. Wait for next turn.

> If a file is auto-generated or has no meaningful logic: write
> \`## Purpose: auto-generated — skipped\` and mark [✓] immediately.

## Phase 2 — Module summaries

After ALL files are [✓]:
- For each directory: read its file summaries, write .think/distill/modules/<name>.md
- Include: directory purpose, key files, public interface, internal patterns

## Phase 3 — Architecture + Index

- .think/distill/architecture.md: system overview, entry points, data flow, key patterns, gotchas
- .think/distill/index.md: a lookup table — "if you need to understand X, read Y"

## Hard rules
- One TURN per response — do not process multiple turns in one response
- Keep every summary under 400 words
- Never paraphrase the code verbatim — synthesize what it DOES and WHY
- Batched small files share one summary file, not separate ones

Start Phase 1 now. Read manifest.md, pick the first unchecked entry, go.`;
}

// ---------- RESUME ----------

// Count already-checked items in an existing manifest.
function countChecked(manifestPath: string): { done: number; total: number } {
  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    const total = (content.match(/^- \[/gm) ?? []).length;
    const done = (content.match(/^- \[✓\]/gm) ?? []).length;
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

// ---------- EXTENSION ----------

export default function (pi: ExtensionAPI) {
  pi.registerCommand("distill", {
    description: "Crawl a codebase and build a .think/distill/ knowledge base. Usage: /distill [path] | /distill --resume",
    handler: async (args, ctx) => {
      const argStr = args?.trim() ?? "";
      const isResume = argStr === "--resume" || argStr.startsWith("--resume ");

      const distillDir = path.join(ctx.cwd, ".think", "distill");
      const manifestPath = path.join(distillDir, "manifest.md");

      // ── RESUME MODE ──────────────────────────────────────────────────────
      if (isResume) {
        if (!fs.existsSync(manifestPath)) {
          ctx.ui.notify(
            "distill: no manifest found — run /distill [path] first to start a distillation.",
            "warn"
          );
          return;
        }
        const { done, total } = countChecked(manifestPath);
        ctx.ui.notify(
          `distill --resume: manifest found (${done}/${total} done). Re-injecting workflow …`,
          "info"
        );
        await pi.sendMessage(
          {
            customType: "distill_resume",
            content: `[distill --resume] Continuing distillation. Progress: ${done}/${total} turns done.

Read .think/distill/manifest.md, find the first unchecked entry [ ], and continue from there.
Follow the same workflow: one turn per response, mark [✓] when done, update _state.md.`,
            display: {
              label: "distill --resume",
              content: `Resuming distillation (${done}/${total} turns done).`,
            },
          },
          { deliverAs: "steer" }
        );
        return;
      }

      // ── FRESH CRAWL ──────────────────────────────────────────────────────
      const targetArg = argStr || ".";
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
        ctx.ui.notify(
          `distill: no source files found in ${rootDir}. Check the path or supported extensions.`,
          "warn"
        );
        return;
      }

      ctx.ui.notify(`distill: ${files.length} files found — building import graph …`, "info");

      // Build graph and sort.
      const graph = buildImportGraph(files);
      const topoOrder = topoSort(files, graph);
      const turns = buildTurnQueue(files, topoOrder);

      ctx.ui.notify(
        `distill: ${files.length} files → ${turns.length} turns (smart-ordered). Writing manifest …`,
        "info"
      );

      // Create output directories.
      fs.mkdirSync(path.join(distillDir, "files"), { recursive: true });
      fs.mkdirSync(path.join(distillDir, "modules"), { recursive: true });

      // Build file map for manifest (drop content to save memory).
      const fileMap = new Map<string, FileEntry>();
      for (const f of files) fileMap.set(f.relPath, f);

      const manifest = buildManifest(turns, fileMap, targetArg);
      fs.writeFileSync(manifestPath, manifest, "utf8");

      ctx.ui.notify(
        `distill: manifest written (${turns.length} turns). Injecting workflow …`,
        "info"
      );

      await pi.sendMessage(
        {
          customType: "distill_workflow",
          content: buildWorkflow(turns, targetArg),
          display: {
            label: "distill",
            content: `${files.length} files / ${turns.length} turns ready. Distillation workflow injected.`,
          },
        },
        { deliverAs: "steer" }
      );
    },
  });
}
