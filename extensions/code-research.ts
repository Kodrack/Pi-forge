// code-research.ts
// /ask <question> + code_research() tool — deep research over the CODEBASE,
// same coded-procedure pattern as deep-research.ts but grep replaces the web:
//
//   1. decompose the question into sub-questions + code search terms → plan.md
//   2. per sub-question: scan the repo (pure node, no shell) → rank files →
//      cut line-numbered excerpt windows around the hits → sub-Pi writes
//      findings citing file:line                          → round-1/qN.md
//   3. gap-check: sub-Pi reads all findings, emits follow-up search terms or
//      COMPLETE — this is the multi-hop: round 1 discovers "EventBus", round 2
//      greps EventBus and follows the chain
//   4. follow-up round(s) for the gaps (hard cap MAX_ROUNDS)
//   5. final synthesis: answer + file map + open questions   → report.md
//
// If .think/distill/ exists its summaries are searched too (L2 preferred,
// L1 fallback — summaries contain concept prose like "caches results" that
// identifier grep misses); hits map back to the source file. No distill →
// grep-only, still works.
//
// The pipeline is deterministic TypeScript; sub-Pi calls (isolated, --no-tools)
// do only the cognitive steps. The main context receives ONLY the final report.
// Registered as an LLM-callable tool so Pi picks it autonomously for
// multi-file "how does X work" questions.
//
// Resume: re-running the same question reuses plan.md and finished findings.
// Redo from scratch: delete .think/code-research/<slug>/.
//
// Install: copy to ~/.pi/agent/extensions/code-research.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── CONFIG ──────────────────────────────────────────────────────────────────

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");

const MAX_SUBQUESTIONS = 5;        // decompose cap
const MAX_ROUNDS = 3;              // hard cap incl. round 1 (--rounds can lower it)
const DEFAULT_ROUNDS = 2;
const MAX_FOLLOWUPS = 3;           // follow-up investigations per gap-check
const FILES_PER_SUBQ = 4;          // top-ranked files excerpted per sub-question
const WINDOW_LINES = 40;           // context lines kept around each match
const MAX_EXCERPT_CHARS = 3000;    // per file
const MAX_FILE_SIZE_BYTES = 512 * 1024;
const MAX_CORPUS_FILES = 5000;
const SUB_PI_TIMEOUT = 240000;

// Same corpus filter as distill.ts (self-contained copy).
const INCLUDE_EXTENSIONS = new Set([
  ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".cpp", ".c",
  ".css", ".scss", ".sass", ".less",
  ".html", ".vue", ".svelte", ".razor",
  ".sql", ".md", ".json", ".yml", ".yaml", ".sh",
]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  "__pycache__", ".cache", "coverage", ".turbo", "vendor", "tmp",
  ".idea", ".vscode", "target", "bin", "obj",
]);
const SKIP_PATTERNS = [
  /\.min\.(js|css)$/, /\.bundle\.js$/, /\.d\.ts$/, /\.lock$/, /\.map$/,
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/,
];

// Pin the sub-Pi to the SAME provider/model as the main session (see distill.ts).
function subPiModelFlags(): string {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf-8"));
    const provider = s?.defaultProvider;
    const model = s?.defaultModel;
    return provider && model ? ` --provider ${provider} --model "${model}"` : "";
  } catch {
    return "";
  }
}

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("code-research");
  } catch {
    return true;
  }
}

function appendLog(logFile: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync(logFile, `[${ts}] ${msg}\n`, "utf8"); } catch {}
}

// ── SUB-PI ──────────────────────────────────────────────────────────────────

function cleanOutput(raw: string): string {
  let s = raw;
  s = s.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  s = s.replace(/<think(ing)?>[\s\S]*$/gi, "");
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  s = s.replace(/<\/?[a-z_][a-z0-9_]*(\s[^>]*)?\/?>/gi, "");
  return s.trim();
}

async function subPi(prompt: string, tmpDir: string, tag: string, cwd: string, logFile: string): Promise<string> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const promptFile = path.join(tmpDir, `${tag}.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");
  let raw = "";
  try {
    const { stdout } = await execAsync(
      `pi --no-session --no-extensions --no-tools --thinking off --offline ${subPiModelFlags()} -p "@${promptFile}" < /dev/null`,
      { cwd, timeout: SUB_PI_TIMEOUT }
    );
    raw = (stdout || "").trim();
  } catch (e: any) {
    raw = (e.stdout || "").trim(); // salvage partial output on timeout
    appendLog(logFile, `subPi ${tag}: error — ${(e.message || "").split("\n")[0].slice(0, 150)}`);
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
  }
  return cleanOutput(raw);
}

const NO_TOOLS_PREAMBLE =
  `All content you need is ALREADY included below — there are no files to open. ` +
  `You have NO tools. Do NOT emit tags or tool calls. Respond with plain text ONLY, starting immediately.\n\n`;

// ── CORPUS (pure-node search, no shell/rg dependency) ───────────────────────

interface CorpusFile { relPath: string; lines: string[] }

function loadCorpus(cwd: string): CorpusFile[] {
  const corpus: CorpusFile[] = [];
  const walk = (dir: string) => {
    if (corpus.length >= MAX_CORPUS_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (corpus.length >= MAX_CORPUS_FILES) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(fullPath);
      } else if (entry.isFile()) {
        if (!INCLUDE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (SKIP_PATTERNS.some((p) => p.test(entry.name))) continue;
        try {
          if (fs.statSync(fullPath).size > MAX_FILE_SIZE_BYTES) continue;
          corpus.push({ relPath: path.relative(cwd, fullPath), lines: fs.readFileSync(fullPath, "utf8").split("\n") });
        } catch {}
      }
    }
  };
  walk(cwd);
  return corpus;
}

// Distill summaries as a concept index: a term hit in a summary pulls the
// SOURCE file (summary relPath minus ".md") into the candidates. Prefers L2
// (smaller to scan) but falls back to L1 — most projects only ever run
// /distill once, so L1 is usually all that exists.
function loadDistillIndex(cwd: string): { level: string; index: CorpusFile[] } {
  for (const level of ["L2", "L1"]) {
    const levelDir = path.join(cwd, ".think", "distill", level);
    if (!fs.existsSync(levelDir)) continue;
    const index: CorpusFile[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            index.push({
              relPath: path.relative(levelDir, fullPath).replace(/\.md$/, ""), // source relPath
              lines: fs.readFileSync(fullPath, "utf8").split("\n"),
            });
          } catch {}
        }
      }
    };
    walk(levelDir);
    if (index.length > 0) return { level, index };
  }
  return { level: "", index: [] };
}

// Rank files by matching lines across all terms (case-insensitive substring).
function rankFiles(terms: string[], corpus: CorpusFile[], distillIndex: CorpusFile[]): Map<string, number[]> {
  const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  const hits = new Map<string, number[]>(); // relPath → matching line numbers (1-based)
  for (const f of corpus) {
    const matched: number[] = [];
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i].toLowerCase();
      if (lowered.some((t) => line.includes(t))) matched.push(i + 1);
    }
    if (matched.length > 0) hits.set(f.relPath, matched);
  }
  // Concept hits from distill: source file joins the candidates even if the
  // identifiers never appear in it (line list empty → excerpt from file head).
  for (const s of distillIndex) {
    if (hits.has(s.relPath)) continue;
    if (s.lines.some((l) => { const ll = l.toLowerCase(); return lowered.some((t) => ll.includes(t)); })) {
      hits.set(s.relPath, []);
    }
  }
  return hits;
}

// Merge match lines into ±WINDOW_LINES ranges and emit a line-numbered excerpt.
function buildExcerpt(f: CorpusFile, matchLines: number[]): string {
  let ranges: Array<[number, number]>;
  if (matchLines.length === 0) {
    ranges = [[1, Math.min(f.lines.length, WINDOW_LINES * 2)]]; // distill concept hit: file head
  } else {
    ranges = [];
    for (const m of matchLines) {
      const start = Math.max(1, m - WINDOW_LINES);
      const end = Math.min(f.lines.length, m + WINDOW_LINES);
      const last = ranges[ranges.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
  }
  let out = "";
  for (const [start, end] of ranges) {
    if (out.length >= MAX_EXCERPT_CHARS) break;
    if (out) out += "  ...\n";
    for (let i = start; i <= end && out.length < MAX_EXCERPT_CHARS; i++) {
      out += `L${i}: ${f.lines[i - 1]}\n`;
    }
  }
  return out;
}

// ── PIPELINE ────────────────────────────────────────────────────────────────

interface SubQuestion { question: string; query: string } // query = space-separated search terms

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "question";
}

function parsePlan(text: string): SubQuestion[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s\d.\-*#]+/, "").trim())
    .filter((l) => l.includes("|"))
    .map((l) => {
      const idx = l.lastIndexOf("|");
      return { question: l.slice(0, idx).trim(), query: l.slice(idx + 1).trim() };
    })
    .filter((s) => s.question.length > 3 && s.query.length > 1);
}

async function decompose(question: string, dir: string, cwd: string, logFile: string): Promise<SubQuestion[]> {
  const planFile = path.join(dir, "plan.md");
  if (fs.existsSync(planFile)) {
    const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
    if (reparsed.length > 0) return reparsed; // resume
  }
  const prompt = NO_TOOLS_PREAMBLE +
    `A developer asked this about a codebase:\n${question}\n\n` +
    `Decompose it into ${MAX_SUBQUESTIONS} or fewer sub-questions that together answer it ` +
    `(entry points, data flow, key components, configuration, edge cases — whatever fits).\n\n` +
    `Output EXACTLY one line per sub-question, no headers, no numbering, no extra prose, in this format:\n` +
    `<sub-question> | <2-5 code search terms separated by spaces>\n\n` +
    `Search terms are matched literally against source lines — use likely identifiers, function names, ` +
    `string literals, config keys. Prefer specific terms over generic words. Begin now:`;
  const out = await subPi(prompt, path.join(dir, "tmp"), "decompose", cwd, logFile);
  let subs = parsePlan(out);
  if (subs.length === 0) {
    appendLog(logFile, `decompose: unparseable output, falling back to question words as terms`);
    subs = [{ question, query: question.split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(" ") || question }];
  }
  subs = subs.slice(0, MAX_SUBQUESTIONS);
  fs.writeFileSync(
    planFile,
    `# Investigation plan: ${question}\n\n` + subs.map((s) => `${s.question} | ${s.query}`).join("\n") + "\n",
    "utf8"
  );
  return subs;
}

async function investigate(
  q: SubQuestion,
  outFile: string,
  dir: string,
  cwd: string,
  corpus: CorpusFile[],
  distillIndex: CorpusFile[],
  logFile: string,
  notify: (msg: string) => void
): Promise<boolean> {
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
    notify(`ask: ⏭ already done — "${q.question.slice(0, 50)}"`);
    return true;
  }

  const terms = q.query.split(/\s+/).filter(Boolean);
  const hits = rankFiles(terms, corpus, distillIndex);
  if (hits.size === 0) {
    appendLog(logFile, `no files match terms "${q.query}"`);
    notify(`ask: ✗ nothing in the codebase matches "${q.query}" — skipping`);
    return false;
  }
  const top = [...hits.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, FILES_PER_SUBQ);

  const byPath = new Map(corpus.map((f) => [f.relPath, f]));
  const excerpts: string[] = [];
  const consulted: string[] = [];
  for (const [relPath, matchLines] of top) {
    const f = byPath.get(relPath);
    if (!f) continue;
    consulted.push(`${relPath} (${matchLines.length || "concept"} match${matchLines.length === 1 ? "" : "es"})`);
    excerpts.push(`## File: ${relPath}\n\n${buildExcerpt(f, matchLines)}`);
  }
  if (excerpts.length === 0) {
    appendLog(logFile, `matched files unreadable for "${q.query}"`);
    return false;
  }

  const prompt = NO_TOOLS_PREAMBLE +
    `You are investigating this question about a codebase: ${q.question}\n\n` +
    `Below are excerpts from the files that matched the search terms "${q.query}". ` +
    `Lines are prefixed with their real line numbers (L123:).\n\n` +
    excerpts.join("\n\n---\n\n") + `\n\n---\n\n` +
    `Write focused findings (max 300 words) answering the question using ONLY the excerpts. ` +
    `Cite evidence as file:line (e.g. src/auth.ts:42) for every claim. ` +
    `Name functions, types, and values precisely. ` +
    `If the excerpts don't fully answer the question, state exactly what is missing and which ` +
    `identifier or file to look for next. Begin now:`;

  const findings = await subPi(prompt, path.join(dir, "tmp"), `find-${path.basename(outFile, ".md")}`, cwd, logFile);
  if (findings.length < 40) {
    appendLog(logFile, `unusable findings for "${q.query}" (${findings.length} chars)`);
    notify(`ask: ✗ synthesis unusable for "${q.query}" — skipping`);
    return false;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `# ${q.question}\n\nSearch terms: \`${q.query}\`\n\nFiles consulted:\n` +
      consulted.map((c) => `- ${c}`).join("\n") +
      `\n\n## Findings\n\n${findings}\n`,
    "utf8"
  );
  notify(`ask: ✓ "${q.question.slice(0, 50)}" (${consulted.length} files)`);
  return true;
}

async function gapCheck(question: string, allFindings: string, dir: string, cwd: string, logFile: string, round: number): Promise<SubQuestion[]> {
  const prompt = NO_TOOLS_PREAMBLE +
    `You are reviewing codebase findings for the question: ${question}\n\n${allFindings}\n\n---\n\n` +
    `Decide if anything important is still missing for a complete, accurate answer. ` +
    `Pay attention to identifiers the findings mention but never explain (follow the chain). ` +
    `If the findings are sufficient, output exactly: COMPLETE\n` +
    `Otherwise output up to ${MAX_FOLLOWUPS} lines, one per missing piece, in this format:\n` +
    `<what is missing> | <2-5 code search terms separated by spaces>\n` +
    `No other text. Begin now:`;
  const out = await subPi(prompt, path.join(dir, "tmp"), `gaps-r${round}`, cwd, logFile);
  if (/^\s*COMPLETE\s*$/im.test(out) || out.length === 0) return [];
  return parsePlan(out).slice(0, MAX_FOLLOWUPS);
}

function collectFindings(dir: string): string[] {
  const files: string[] = [];
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const roundDir = path.join(dir, `round-${r}`);
    if (!fs.existsSync(roundDir)) continue;
    for (const f of fs.readdirSync(roundDir).sort()) {
      if (f.endsWith(".md")) files.push(path.join(roundDir, f));
    }
  }
  return files;
}

async function synthesizeReport(question: string, dir: string, cwd: string, logFile: string): Promise<string> {
  const findingsFiles = collectFindings(dir);
  if (findingsFiles.length === 0) return "";
  let combined = findingsFiles
    .map((f) => `### From ${path.relative(dir, f)}\n\n${fs.readFileSync(f, "utf8")}`)
    .join("\n\n===\n\n");
  const MAX_COMBINED = 90000;
  if (combined.length > MAX_COMBINED) {
    combined = combined.slice(0, MAX_COMBINED) + "\n\n[... truncated ...]";
    appendLog(logFile, `report: combined findings truncated to ${MAX_COMBINED} chars`);
  }
  const prompt = NO_TOOLS_PREAMBLE +
    `Write a report answering this question about a codebase: ${question}\n\n` +
    `Use ONLY the findings below (each cites file:line evidence).\n\n${combined}\n\n---\n\n` +
    `Structure the report as:\n` +
    `# ${question}\n` +
    `## Answer\n[the direct answer, with file:line citations kept]\n` +
    `## File Map\n[one line per relevant file: path — its role in this answer]\n` +
    `## Open Questions\n[what the investigation could not settle]\n\n` +
    `Max 600 words. Keep every claim traceable to a file:line. Begin now:`;
  return await subPi(prompt, path.join(dir, "tmp"), "report", cwd, logFile);
}

// ── ORCHESTRATOR ────────────────────────────────────────────────────────────

async function runCodeResearch(
  question: string,
  rounds: number,
  cwd: string,
  notify: (msg: string) => void,
  deliver: (report: string, dir: string) => void
): Promise<void> {
  const dir = path.join(cwd, ".think", "code-research", slugify(question));
  const logFile = path.join(dir, "research.log");
  fs.mkdirSync(dir, { recursive: true });
  appendLog(logFile, `=== START "${question}" (max ${rounds} rounds) ===`);

  const reportFile = path.join(dir, "report.md");
  if (fs.existsSync(reportFile) && fs.statSync(reportFile).size > 100) {
    notify(`ask: report already exists — reusing it. Delete ${path.relative(cwd, dir)}/ to redo.`);
    deliver(fs.readFileSync(reportFile, "utf8"), dir);
    return;
  }

  notify(`ask: scanning codebase...`);
  const corpus = loadCorpus(cwd);
  if (corpus.length === 0) {
    notify(`ask: no source files found under ${cwd} — nothing to investigate.`);
    return;
  }
  const { level: distillLevel, index: distillIndex } = loadDistillIndex(cwd);
  notify(`ask: ${corpus.length} files in corpus${distillIndex.length ? ` + ${distillIndex.length} distill ${distillLevel} summaries as concept index` : ""}`);

  notify(`ask: decomposing "${question}"...`);
  const subs = await decompose(question, dir, cwd, logFile);
  notify(`ask: plan — ${subs.length} sub-questions:\n` + subs.map((s, i) => `  ${i + 1}. ${s.question} [${s.query}]`).join("\n"));
  appendLog(logFile, `plan: ${subs.length} sub-questions`);

  let queue: SubQuestion[] = subs;
  let done = 0;
  for (let round = 1; round <= rounds && queue.length > 0; round++) {
    notify(`ask: round ${round} — ${queue.length} investigation(s)...`);
    for (let i = 0; i < queue.length; i++) {
      const outFile = path.join(dir, `round-${round}`, `q${i + 1}.md`);
      if (await investigate(queue[i], outFile, dir, cwd, corpus, distillIndex, logFile, notify)) done++;
    }
    if (round === rounds) break;
    const allFindings = collectFindings(dir).map((f) => fs.readFileSync(f, "utf8")).join("\n\n===\n\n");
    if (allFindings.length === 0) break;
    notify(`ask: round ${round} done — checking for gaps...`);
    queue = await gapCheck(question, allFindings, dir, cwd, logFile, round);
    if (queue.length === 0) {
      notify(`ask: gap-check says findings are sufficient.`);
      break;
    }
    notify(`ask: following the chain:\n` + queue.map((s) => `  → ${s.question} [${s.query}]`).join("\n"));
  }

  if (done === 0) {
    notify(`ask: every investigation failed — nothing to synthesize. See ${path.relative(cwd, logFile)}.`);
    return;
  }

  notify(`ask: synthesizing report from ${collectFindings(dir).length} findings file(s)...`);
  const report = await synthesizeReport(question, dir, cwd, logFile);
  if (report.length < 100) {
    notify(`ask: report synthesis failed — findings are saved under ${path.relative(cwd, dir)}/`);
    return;
  }
  fs.writeFileSync(reportFile, report + "\n", "utf8");
  appendLog(logFile, `=== COMPLETE — report.md (${report.length} chars) ===`);
  notify(`ask: complete — ${path.relative(cwd, reportFile)}`);
  deliver(report, dir);
}

// ── EXTENSION ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify("code-research active — /ask <question> or code_research() tool for deep codebase investigation", "info");
  });

  pi.registerCommand("ask", {
    description: 'Deep codebase investigation. Usage: /ask <question> [--rounds N]',
    handler: async (args: any, ctx: any) => {
      const argStr = (args ?? "").trim();
      if (!argStr) {
        ctx.ui.notify(
          `usage: /ask <question> [--rounds N]\n` +
          `Decomposes the question, searches the code per sub-question, follows the chain\n` +
          `(gap-check), and writes a file:line-cited report to .think/code-research/<q>/report.md\n` +
          `(default ${DEFAULT_ROUNDS} rounds, max ${MAX_ROUNDS}).`,
          "info"
        );
        return;
      }
      const roundsMatch = argStr.match(/--rounds\s+(\d+)/);
      const rounds = roundsMatch ? Math.max(1, Math.min(MAX_ROUNDS, parseInt(roundsMatch[1]))) : DEFAULT_ROUNDS;
      const question = argStr.replace(/--rounds\s+\d+/g, "").trim();
      if (!question) {
        ctx.ui.notify("ask: missing question. Usage: /ask <question> [--rounds N]", "warn");
        return;
      }
      await runCodeResearch(
        question, rounds, ctx.cwd,
        (m) => ctx.ui.notify(m, "info"),
        (report, dir) => {
          pi.sendMessage(
            {
              customType: "code_research_report",
              content:
                `[code-research] AUTOMATED HARNESS MESSAGE — not written by the user; act on it.\n\n` +
                `Codebase investigation of "${question}" is complete. The report below cites file:line evidence ` +
                `(full findings: ${path.relative(ctx.cwd, dir)}/round-*/).\n` +
                `Use it to answer the user or continue the task. Do not re-read files it already covers.\n\n${report}`,
              display: {
                label: "ask",
                content: `Report ready: "${question.slice(0, 60)}" → ${path.relative(ctx.cwd, dir)}/report.md`,
              },
            },
            { deliverAs: "steer" }
          );
        }
      );
    },
  });

  // LLM-callable: Pi picks this autonomously for multi-file questions.
  (pi as any).registerTool({
    name: "code_research",
    description: `Deep codebase investigation: decomposes a question into sub-questions, searches the code, reads the matching files in isolated sub-sessions, follows references across rounds, and returns a report with file:line citations. Your context only receives the report — never the raw files.

Use it when a question spans MULTIPLE files you haven't read: "how does X work", "where is Y enforced", "what happens when Z", tracing a flow end to end, or orienting in an unfamiliar codebase.
Do NOT use it when you already know the file (read it directly) or for questions .think/distill/ already answers (query /l2 first if distill exists). It is slow (several local LLM calls) — one call per question, not per file.`,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The codebase question to investigate, e.g. \"how does authentication flow from request to database?\"",
        },
        rounds: {
          type: "number",
          description: `Investigation rounds 1-${MAX_ROUNDS} (default ${DEFAULT_ROUNDS}). Use 1 for a quick single sweep.`,
        },
      },
      required: ["question"],
    },
    execute: async (
      _toolCallId: string,
      params: { question: string; rounds?: number },
      _signal: AbortSignal,
      onUpdate: (content: any) => void,
      ctx: any
    ): Promise<any> => {
      const fmt = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
      const notify = (msg: string) => {
        try { onUpdate({ content: [{ type: "text" as const, text: msg }] }); } catch {}
      };
      const question = params?.question?.trim();
      if (!question) return fmt("code_research error: missing 'question' parameter.");
      const rounds = params?.rounds ? Math.max(1, Math.min(MAX_ROUNDS, params.rounds)) : DEFAULT_ROUNDS;
      const cwd = ctx?.cwd || process.cwd();

      let delivered = "";
      await runCodeResearch(question, rounds, cwd, notify, (report) => { delivered = report; });
      if (delivered) return fmt(delivered);
      return fmt(`code_research produced no report — see .think/code-research/${slugify(question)}/research.log. Fall back to reading the relevant files directly.`);
    },
  });
}
