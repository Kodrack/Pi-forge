// deep-research.ts
// /research <topic> — multi-round deep research as a CODED procedure, not a prompt.
//
// The pipeline is a deterministic TypeScript loop; the LLM (isolated sub-Pi
// calls, same pattern as distill.ts) only does the cognitive steps:
//   1. decompose the topic into sub-questions + search queries  → plan.md
//   2. per sub-question: SearXNG search → fetch pages → synthesize → round-1/qN.md
//   3. gap-check: sub-Pi reads all findings, emits follow-up queries or COMPLETE
//   4. follow-up round(s) for the gaps (hard cap MAX_ROUNDS)
//   5. final synthesis across all findings, with source URLs      → report.md
//
// The main session context receives ONLY the final report (as a steer message).
// Raw pages, per-question findings and prompts live under .think/research/<slug>/.
// Searches are paced (SEARCH_PACING_MS) — engines like yahoo suspend on bursts.
//
// Requires the SearXNG backend from web-search.ts to be reachable; this
// extension does NOT duplicate the docker lifecycle — it tells you to run
// /searxng up (or bash searxng-up.sh) if the backend is down.
//
// Resume: /research with the same topic reuses plan.md and any finished
// findings files, so an interrupted run continues where it stopped.
// Redo from scratch: delete .think/research/<slug>/.
//
// Install: copy to ~/.pi/agent/extensions/deep-research.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as https from "https";
import * as http from "http";
import { promisify } from "util";

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── CONFIG ──────────────────────────────────────────────────────────────────

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8888").replace(/\/$/, "");

const MAX_SUBQUESTIONS = 5;       // decompose cap — more drowns a local model
const MAX_ROUNDS = 3;             // hard cap incl. round 1 (--rounds can lower it)
const DEFAULT_ROUNDS = 2;
const MAX_FOLLOWUPS = 3;          // follow-up queries per gap-check
const PAGES_PER_QUERY = 3;        // pages fetched per search
const MAX_CONTENT_PER_PAGE = 1500; // chars of page text fed to the sub-Pi
const PAGE_TIMEOUT = 10000;
const SUB_PI_TIMEOUT = 240000;    // local models are slow; scales with input size
const SEARCH_PACING_MS = 6000;    // gap between SearXNG queries (yahoo bursts → suspension)

// Pin the sub-Pi to the SAME provider/model as the main session (see distill.ts
// for why: a silent fallback could route work to a paid cloud model).
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
    return !(config.disabled ?? []).includes("deep-research");
  } catch {
    return true;
  }
}

// ── LOGGING ─────────────────────────────────────────────────────────────────

function appendLog(logFile: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  try { fs.appendFileSync(logFile, `[${ts}] ${msg}\n`, "utf8"); } catch {}
}

// ── HTTP / SEARXNG (self-contained copies of the web-search.ts helpers) ────

function fetchUrl(url: string, timeout = PAGE_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req = proto.get(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function searxngReachable(): Promise<boolean> {
  try {
    JSON.parse(await fetchUrl(`${SEARXNG_URL}/search?q=ping&format=json`, 5000));
    return true;
  } catch { return false; }
}

interface SearchResult { title: string; url: string; snippet: string }

async function searxngSearch(query: string): Promise<SearchResult[]> {
  const raw = await fetchUrl(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`);
  const data = JSON.parse(raw);
  return (data.results ?? [])
    .map((r: any) => ({
      url: r.url ?? "",
      title: (r.title ?? "").trim(),
      snippet: (r.content ?? "").trim(),
    }))
    .filter((r: SearchResult) => r.url)
    .slice(0, PAGES_PER_QUERY);
}

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function extractContent(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) text = articleMatch[1];
  else if (mainMatch) text = mainMatch[1];
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHTMLEntities(text);
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_PER_PAGE);
}

// ── SUB-PI ──────────────────────────────────────────────────────────────────

// Strip reasoning traces and stray tags thinking models emit even with
// --thinking off (same cleanup as web-search.ts).
function cleanOutput(raw: string): string {
  let s = raw;
  s = s.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, "");
  s = s.replace(/<think(ing)?>[\s\S]*$/gi, "");
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  s = s.replace(/<\/?[a-z_][a-z0-9_]*(\s[^>]*)?\/?>/gi, "");
  return s.trim();
}

// One isolated LLM call. Returns cleaned output, or "" on failure — the
// pipeline treats "" as a skippable step, never a crash.
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

// Common preamble so a toolless sub-Pi never punts to fake file reads.
const NO_TOOLS_PREAMBLE =
  `All content you need is ALREADY included below — there are no files to open. ` +
  `You have NO tools. Do NOT emit tags or tool calls. Respond with plain text ONLY, starting immediately.\n\n`;

// ── PIPELINE STEPS ──────────────────────────────────────────────────────────

interface SubQuestion { question: string; query: string }

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "topic";
}

// Step 1 — decompose the topic. Falls back to the topic itself as a single
// query if the model's output doesn't parse — the pipeline must never die here.
async function decompose(topic: string, dir: string, cwd: string, logFile: string): Promise<SubQuestion[]> {
  const planFile = path.join(dir, "plan.md");
  if (fs.existsSync(planFile)) {
    const reparsed = parsePlan(fs.readFileSync(planFile, "utf8"));
    if (reparsed.length > 0) return reparsed; // resume: reuse existing plan
  }
  const prompt = NO_TOOLS_PREAMBLE +
    `Decompose this research topic into ${MAX_SUBQUESTIONS} or fewer sub-questions covering distinct angles ` +
    `(definitions/mechanisms, practical how-to, comparisons/alternatives, pitfalls, recent developments).\n\n` +
    `TOPIC: ${topic}\n\n` +
    `Output EXACTLY one line per sub-question, no headers, no numbering, no extra prose, in this format:\n` +
    `<sub-question> | <web search query for it>\n\n` +
    `Make each search query short and concrete (3-8 words). Begin now:`;
  const out = await subPi(prompt, path.join(dir, "tmp"), "decompose", cwd, logFile);
  let subs = parsePlan(out);
  if (subs.length === 0) {
    appendLog(logFile, `decompose: unparseable output, falling back to topic as single query`);
    subs = [{ question: topic, query: topic }];
  }
  subs = subs.slice(0, MAX_SUBQUESTIONS);
  fs.writeFileSync(
    planFile,
    `# Research plan: ${topic}\n\n` + subs.map((s, i) => `${s.question} | ${s.query}`).join("\n") + "\n",
    "utf8"
  );
  return subs;
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
    .filter((s) => s.question.length > 3 && s.query.length > 2);
}

// Conversational filler that keyword-matching engines (stackexchange, github,
// hackernews) can't handle — a query like "static analysis versus LLM code
// review" returns nothing while its bare keywords match fine.
const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "with", "and", "or",
  "versus", "vs", "vs.", "compared", "comparison", "between", "how", "why",
  "what", "which", "does", "do", "is", "are", "should", "best", "about",
]);

function simplifyQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((w) => !QUERY_STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9.]/g, "")))
    .join(" ")
    .trim();
}

// Step 2 — one investigation: search → fetch → synthesize → findings file.
// Skips work already on disk (resume). Returns true if a findings file exists.
async function investigate(
  q: SubQuestion,
  outFile: string,
  dir: string,
  cwd: string,
  logFile: string,
  notify: (msg: string) => void
): Promise<boolean> {
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
    notify(`research: ⏭ already done — "${q.query}"`);
    return true;
  }

  let results: SearchResult[];
  try {
    results = await searxngSearch(q.query);
    // Empty result set → retry once with the query stripped to bare keywords.
    if (results.length === 0) {
      const simplified = simplifyQuery(q.query);
      if (simplified && simplified !== q.query) {
        appendLog(logFile, `no results for "${q.query}" — retrying as "${simplified}"`);
        notify(`research: no results for "${q.query}" — retrying as "${simplified}"`);
        await sleep(SEARCH_PACING_MS);
        results = await searxngSearch(simplified);
      }
    }
  } catch (e: any) {
    appendLog(logFile, `search failed for "${q.query}": ${e.message}`);
    notify(`research: ✗ search failed for "${q.query}" — skipping`);
    return false;
  }
  if (results.length === 0) {
    appendLog(logFile, `no results for "${q.query}" (even simplified)`);
    notify(`research: ✗ no results for "${q.query}" — skipping`);
    return false;
  }

  // Fetch pages in parallel; fall back to SearXNG snippets when nothing fetches.
  const pages: Array<{ title: string; url: string; content: string }> = [];
  await Promise.all(
    results.map(async (r) => {
      try {
        const content = extractContent(await fetchUrl(r.url));
        if (content.length > 100) pages.push({ title: r.title, url: r.url, content });
      } catch {}
    })
  );
  const sources = (pages.length > 0 ? pages : results).map((p) => p.url);
  const body = (pages.length > 0 ? pages : results.map((r) => ({ title: r.title, url: r.url, content: r.snippet })))
    .map((p, i) => `## Source ${i + 1}: ${p.title}\nURL: ${p.url}\n\n${p.content}`)
    .join("\n\n---\n\n");

  const prompt = NO_TOOLS_PREAMBLE +
    `You are researching this question: ${q.question}\n` +
    `(part of the broader topic — stay focused on the question)\n\n` +
    `## Source material:\n\n${body}\n\n---\n\n` +
    `Write focused findings (max 300 words) answering the question using ONLY the sources above. ` +
    `Include concrete facts: names, versions, dates, numbers, commands. ` +
    `After each claim, cite its source in brackets like [1]. ` +
    `If the sources don't answer the question, say exactly what is missing. Begin now:`;

  const findings = await subPi(prompt, path.join(dir, "tmp"), `find-${path.basename(outFile, ".md")}`, cwd, logFile);
  if (findings.length < 40) {
    appendLog(logFile, `unusable findings for "${q.query}" (${findings.length} chars)`);
    notify(`research: ✗ synthesis unusable for "${q.query}" — skipping`);
    return false;
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(
    outFile,
    `# ${q.question}\n\nQuery: \`${q.query}\`\n\nSources:\n` +
      sources.map((u, i) => `${i + 1}. ${u}`).join("\n") +
      `\n\n## Findings\n\n${findings}\n`,
    "utf8"
  );
  notify(`research: ✓ "${q.query}" (${sources.length} sources)`);
  return true;
}

// Step 3 — gap-check: emits follow-up queries or COMPLETE.
async function gapCheck(topic: string, allFindings: string, dir: string, cwd: string, logFile: string, round: number): Promise<SubQuestion[]> {
  const prompt = NO_TOOLS_PREAMBLE +
    `You are reviewing research findings on: ${topic}\n\n${allFindings}\n\n---\n\n` +
    `Decide if anything important is still missing to give a useful, complete answer on the topic. ` +
    `If the findings are sufficient, output exactly: COMPLETE\n` +
    `Otherwise output up to ${MAX_FOLLOWUPS} lines, one per missing angle, in this format:\n` +
    `<what is missing> | <web search query for it>\n` +
    `No other text. Begin now:`;
  const out = await subPi(prompt, path.join(dir, "tmp"), `gaps-r${round}`, cwd, logFile);
  if (/^\s*COMPLETE\s*$/im.test(out) || out.length === 0) return [];
  return parsePlan(out).slice(0, MAX_FOLLOWUPS);
}

// Step 4 — final synthesis over every findings file.
async function synthesizeReport(topic: string, dir: string, cwd: string, logFile: string): Promise<string> {
  const findingsFiles = collectFindings(dir);
  if (findingsFiles.length === 0) return "";
  let combined = findingsFiles
    .map((f) => `### From ${path.relative(dir, f)}\n\n${fs.readFileSync(f, "utf8")}`)
    .join("\n\n===\n\n");
  const MAX_COMBINED = 90000; // stay well inside a 128k-char context sub-Pi call
  if (combined.length > MAX_COMBINED) {
    combined = combined.slice(0, MAX_COMBINED) + "\n\n[... truncated ...]";
    appendLog(logFile, `report: combined findings truncated to ${MAX_COMBINED} chars`);
  }
  const prompt = NO_TOOLS_PREAMBLE +
    `Write a research report on: ${topic}\n\n` +
    `Use ONLY the findings below (each block lists its source URLs).\n\n${combined}\n\n---\n\n` +
    `Structure the report as:\n` +
    `# ${topic}\n` +
    `## Key Findings\n[organized by theme, concrete facts with source URLs in brackets]\n` +
    `## Practical Recommendations\n[actionable, based on the findings]\n` +
    `## Open Questions\n[what the research could not settle]\n` +
    `## Sources\n[deduplicated list of every URL cited]\n\n` +
    `Max 700 words. Keep every claim traceable to a listed source. Begin now:`;
  return await subPi(prompt, path.join(dir, "tmp"), "report", cwd, logFile);
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

// ── ORCHESTRATOR ────────────────────────────────────────────────────────────

async function runResearch(topic: string, rounds: number, cwd: string, ctx: any, pi: ExtensionAPI): Promise<void> {
  const notify = (m: string, level: string = "info") => ctx.ui.notify(m, level);
  const dir = path.join(cwd, ".think", "research", slugify(topic));
  const logFile = path.join(dir, "research.log");
  fs.mkdirSync(dir, { recursive: true });
  appendLog(logFile, `=== START "${topic}" (max ${rounds} rounds) ===`);

  if (!(await searxngReachable())) {
    notify(`research: SearXNG backend not reachable at ${SEARXNG_URL}. Start it with /searxng up (or bash searxng-up.sh), then retry.`, "error");
    return;
  }

  const reportFile = path.join(dir, "report.md");
  if (fs.existsSync(reportFile) && fs.statSync(reportFile).size > 100) {
    notify(`research: report already exists — injecting it. Delete ${path.relative(cwd, dir)}/ to redo.`);
    deliverReport(topic, fs.readFileSync(reportFile, "utf8"), dir, cwd, pi);
    return;
  }

  // 1. Decompose
  notify(`research: decomposing "${topic}"...`);
  const subs = await decompose(topic, dir, cwd, logFile);
  notify(`research: plan — ${subs.length} sub-questions:\n` + subs.map((s, i) => `  ${i + 1}. ${s.question}`).join("\n"));
  appendLog(logFile, `plan: ${subs.length} sub-questions`);

  // 2..N. Investigation rounds. Round 1 runs the plan; later rounds run
  // whatever the gap-check asked for. The loop and caps are code — the model
  // cannot extend or forget them.
  let queue: SubQuestion[] = subs;
  let done = 0;
  for (let round = 1; round <= rounds && queue.length > 0; round++) {
    notify(`research: round ${round} — ${queue.length} investigation(s)...`);
    for (let i = 0; i < queue.length; i++) {
      const outFile = path.join(dir, `round-${round}`, `q${i + 1}.md`);
      if (await investigate(queue[i], outFile, dir, cwd, logFile, notify)) done++;
      if (i < queue.length - 1) await sleep(SEARCH_PACING_MS); // engine burst protection
    }
    if (round === rounds) break; // no gap-check after the last allowed round
    const allFindings = collectFindings(dir).map((f) => fs.readFileSync(f, "utf8")).join("\n\n===\n\n");
    if (allFindings.length === 0) break;
    notify(`research: round ${round} done — checking for gaps...`);
    queue = await gapCheck(topic, allFindings, dir, cwd, logFile, round);
    if (queue.length === 0) {
      notify(`research: gap-check says findings are sufficient.`);
      break;
    }
    notify(`research: gaps found:\n` + queue.map((s) => `  → ${s.question}`).join("\n"));
  }

  if (done === 0) {
    notify(`research: every investigation failed — nothing to synthesize. See ${path.relative(cwd, logFile)}.`, "error");
    return;
  }

  // Final report
  notify(`research: synthesizing final report from ${collectFindings(dir).length} findings file(s)...`);
  const report = await synthesizeReport(topic, dir, cwd, logFile);
  if (report.length < 100) {
    notify(`research: report synthesis failed — findings are saved under ${path.relative(cwd, dir)}/`, "error");
    return;
  }
  fs.writeFileSync(reportFile, report + "\n", "utf8");
  appendLog(logFile, `=== COMPLETE — report.md (${report.length} chars) ===`);
  notify(`research: complete — ${path.relative(cwd, reportFile)}`);
  deliverReport(topic, report, dir, cwd, pi);
}

// Hand the report to the main model as a steer message — the only research
// content that ever enters the main context.
function deliverReport(topic: string, report: string, dir: string, cwd: string, pi: ExtensionAPI): void {
  pi.sendMessage(
    {
      customType: "deep_research_report",
      content:
        `[deep-research] AUTOMATED HARNESS MESSAGE — not written by the user; act on it.\n\n` +
        `Deep research on "${topic}" is complete. The report below was synthesized from web sources ` +
        `(per-question findings with source URLs: ${path.relative(cwd, dir)}/round-*/).\n` +
        `Use it to answer the user or continue the task. Do not re-search what it already covers.\n\n${report}`,
      display: {
        label: "research",
        content: `Report ready: "${topic.slice(0, 60)}" → ${path.relative(cwd, dir)}/report.md`,
      },
    },
    { deliverAs: "steer" }
  );
}

// ── EXTENSION ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify("deep-research active — /research <topic> for multi-round web research", "info");
  });

  pi.registerCommand("research", {
    description: 'Deep multi-round web research. Usage: /research <topic> [--rounds N]',
    handler: async (args: any, ctx: any) => {
      const argStr = (args ?? "").trim();
      if (!argStr) {
        ctx.ui.notify(
          `usage: /research <topic> [--rounds N]\n` +
          `Decomposes the topic, searches per sub-question, gap-checks, and writes a\n` +
          `sourced report to .think/research/<topic>/report.md (default ${DEFAULT_ROUNDS} rounds, max ${MAX_ROUNDS}).`,
          "info"
        );
        return;
      }
      const roundsMatch = argStr.match(/--rounds\s+(\d+)/);
      const rounds = roundsMatch ? Math.max(1, Math.min(MAX_ROUNDS, parseInt(roundsMatch[1]))) : DEFAULT_ROUNDS;
      const topic = argStr.replace(/--rounds\s+\d+/g, "").trim();
      if (!topic) {
        ctx.ui.notify("research: missing topic. Usage: /research <topic> [--rounds N]", "warn");
        return;
      }
      await runResearch(topic, rounds, ctx.cwd, ctx, pi);
    },
  });
}
