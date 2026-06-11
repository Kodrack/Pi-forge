// web-search.ts
// Web search with sub-pi synthesis. Queries a local SearXNG instance for
// results, fetches the top pages, extracts content, spawns an isolated sub-pi
// to synthesize, and returns only the summary.
//
// The main pi context only sees the final summary, not raw web content.
//
// BACKEND: self-hosted SearXNG (keyless, no browser). Start it with
//   bash searxng-up.sh        (runs SearXNG in Docker on :8888)
// Override the URL with the SEARXNG_URL env var if you run it elsewhere.
//
// (Previously scraped DuckDuckGo's HTML endpoint, which now returns HTTP 202
//  bot walls to all raw-HTTP requests — hence the switch to SearXNG.)
//
// Install: copy to ~/.pi/agent/extensions/web-search.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";

const execAsync = promisify(exec);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");
const SEARXNG_URL = (process.env.SEARXNG_URL || "http://localhost:8888").replace(/\/$/, "");
const SEARXNG_CONF = process.env.SEARXNG_CONF || path.join(os.homedir(), "searxng");
const SEARXNG_CONTAINER = "searxng";
const MAX_PAGES = 3;              // fewer pages → smaller synthesis prompt → fits the timeout on slow local models
const PAGE_TIMEOUT = 8000;
const SUB_PI_TIMEOUT = 180000;    // local Q2 models are slow; ~31s for a tiny prompt, scales with input size
const MAX_CONTENT_PER_PAGE = 1500; // trim per-page content so the sub-pi has less to chew on

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(PIFORGE_CONFIG, "utf-8"));
    return !(config.disabled ?? []).includes("web-search");
  } catch {
    return true;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hashQuery(q: string): string {
  let h = 0;
  for (let i = 0; i < q.length; i++) h = ((h << 5) - h + q.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

// Simple HTTP GET with timeout
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

// Query the local SearXNG instance for web results (JSON API, keyless).
// Throws a descriptive error if SearXNG isn't reachable so the caller can
// tell the user to start it.
async function searxngSearch(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
  let raw: string;
  try {
    raw = await fetchUrl(url);
  } catch (e: any) {
    throw new Error(
      `SearXNG not reachable at ${SEARXNG_URL} (${e.message}). ` +
      `Start it with: bash searxng-up.sh  (or set SEARXNG_URL).`
    );
  }

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `SearXNG at ${SEARXNG_URL} did not return JSON. ` +
      `Ensure 'json' is in search.formats in its settings.yml (searxng-up.sh sets this).`
    );
  }

  const results: Array<{ title: string; url: string; snippet: string }> = (data.results ?? [])
    .map((r: any) => ({
      url: r.url ?? "",
      title: (r.title ?? "").trim(),
      snippet: (r.content ?? "").trim(),
    }))
    .filter((r: { url: string }) => r.url);

  return results.slice(0, MAX_PAGES);
}

// ---------- SearXNG lifecycle (embedded so it works from any project dir) ----------

function searxngPort(): string {
  try { return new URL(SEARXNG_URL).port || "8888"; } catch { return "8888"; }
}

// Only auto-manage a container when pointing at localhost — a remote
// SEARXNG_URL is someone else's instance, leave it alone.
function searxngIsLocal(): boolean {
  try {
    const h = new URL(SEARXNG_URL).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch { return false; }
}

async function dockerRunning(): Promise<boolean> {
  try { await execAsync("docker info", { timeout: 8000 }); return true; } catch { return false; }
}

// True if SearXNG answers a JSON query.
async function searxngReachable(): Promise<boolean> {
  try {
    const raw = await fetchUrl(`${SEARXNG_URL}/search?q=ping&format=json`, 5000);
    JSON.parse(raw);
    return true;
  } catch { return false; }
}

// Write the config once. JSON format is DISABLED in SearXNG by default — we
// must enable it, and we turn the limiter off for local single-user use.
function ensureSearxngConfig(): void {
  fs.mkdirSync(SEARXNG_CONF, { recursive: true });
  const settings = path.join(SEARXNG_CONF, "settings.yml");
  if (fs.existsSync(settings)) return;
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(
    settings,
    `use_default_settings: true\n` +
      `server:\n` +
      `  secret_key: "${secret}"\n` +
      `  bind_address: "0.0.0.0"\n` +
      `  limiter: false\n` +
      `  image_proxy: false\n` +
      `search:\n` +
      `  formats:\n` +
      `    - html\n` +
      `    - json\n`
  );
}

// Bring the container up (idempotent) and wait for the JSON endpoint.
async function startSearxng(notify: (msg: string) => void): Promise<boolean> {
  if (!searxngIsLocal()) {
    notify(`web-search: SEARXNG_URL is remote (${SEARXNG_URL}) — not auto-starting a container.`);
    return false;
  }
  if (!(await dockerRunning())) {
    notify("web-search: Docker daemon not running. Start Docker Desktop (open -a Docker), then retry.");
    return false;
  }
  try {
    ensureSearxngConfig();
    notify("web-search: starting SearXNG (first run pulls the image, ~30-60s)...");
    await execAsync(`docker rm -f ${SEARXNG_CONTAINER}`, { timeout: 20000 }).catch(() => {});
    await execAsync(
      `docker run -d --name ${SEARXNG_CONTAINER} -p ${searxngPort()}:8080 ` +
        `-v "${SEARXNG_CONF}:/etc/searxng" --restart unless-stopped searxng/searxng:latest`,
      { timeout: 300000 } // allow time for image pull on first run
    );
  } catch (e: any) {
    notify(`web-search: failed to start SearXNG — ${e.message}`);
    return false;
  }
  for (let i = 0; i < 30; i++) {
    if (await searxngReachable()) { notify("web-search: SearXNG ready."); return true; }
    await sleep(2000);
  }
  notify("web-search: SearXNG container started but not answering JSON yet — try the search again shortly.");
  return false;
}

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Extract readable content from HTML (basic, no cheerio dependency)
function extractContent(html: string): string {
  // Remove scripts, styles, nav, header, footer
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Get content from article, main, or body
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (articleMatch) text = articleMatch[1];
  else if (mainMatch) text = mainMatch[1];

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode entities
  text = decodeHTMLEntities(text);
  // Normalize whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text.slice(0, MAX_CONTENT_PER_PAGE);
}

// Read purpose from _purpose.md
function readPurpose(cwd: string): string {
  try {
    return fs.readFileSync(path.join(cwd, ".think", "_purpose.md"), "utf-8").trim();
  } catch {
    return "";
  }
}

// Core search logic, shared by the LLM tool and the /web-search command.
// `notify` receives human-readable progress lines (mapped to onUpdate for the
// tool, ctx.ui.notify for the command). Returns a plain result object.
async function performSearch(
  query: string,
  cwd: string,
  notify: (msg: string) => void
): Promise<
  | { success: true; query: string; pagesSearched?: number; synthesisPath?: string; synthesis?: string; message?: string; snippets?: Array<{ title: string; url: string; snippet: string }> }
  | { success: false; error: string }
> {
  const purpose = readPurpose(cwd);

  notify(`web-search: searching "${query}"...`);

  // Setup directories
  const searchDir = path.join(cwd, ".think", "web-search", hashQuery(query));
  ensureDir(searchDir);

  try {
    // 0. Ensure the SearXNG backend is up (auto-start on demand)
    if (!(await searxngReachable())) {
      const started = await startSearxng(notify);
      if (!started) {
        return { success: false, error: `SearXNG backend unavailable at ${SEARXNG_URL}. Use /searxng up, or start Docker.` };
      }
    }

    // 1. Search via local SearXNG (keyless, no browser)
    const results = await searxngSearch(query);

    if (results.length === 0) {
      return { success: false, error: "No search results found (SearXNG returned an empty result set)" };
    }

    notify(`web-search: found ${results.length} results, fetching pages...`);

    // 2. Fetch pages in parallel
    const pageContents: Array<{ title: string; url: string; content: string }> = [];

    await Promise.all(
      results.map(async (r, i) => {
        try {
          const html = await fetchUrl(r.url);
          const content = extractContent(html);
          if (content.length > 100) {
            pageContents.push({ title: r.title, url: r.url, content });
            notify(`web-search: fetched [${i + 1}/${results.length}] ${r.title.slice(0, 40)}...`);
          }
        } catch (e) {
          // Skip failed pages
        }
      })
    );

    if (pageContents.length === 0) {
      // Couldn't fetch any full page — return SearXNG snippets instead
      return snippetResult(query, searchDir, results, "Could not fetch full pages, but found snippets.");
    }

    // 3. Save raw content
    pageContents.forEach((p, i) => {
      fs.writeFileSync(
        path.join(searchDir, `page-${i + 1}.md`),
        `# ${p.title}\nURL: ${p.url}\n\n${p.content}`
      );
    });

    // 4. Build prompt for sub-pi synthesis
    const combinedContent = pageContents
      .map((p, i) => `## Page ${i + 1}: ${p.title}\nURL: ${p.url}\n\n${p.content}`)
      .join("\n\n---\n\n");

    const promptContent = `You are a research assistant. The web page content is ALREADY included below — it is not a file and there is nothing to open. You have NO tools. Do NOT try to read files, call functions, or emit any tags. Respond with the synthesis text ONLY, starting immediately.

SEARCH QUERY: ${query}
MAIN TASK CONTEXT: ${purpose || "General research"}

## Web page content:

${combinedContent}

---

Write a clear, actionable summary (max 400 words) using ONLY the content above. Include specific version numbers, dates, commands, or code if present. Cite page numbers. Begin the summary now:`;

    const promptFile = path.join(searchDir, "_prompt.md");
    fs.writeFileSync(promptFile, promptContent);

    notify("web-search: synthesizing with sub-pi...");

    // 5. Run sub-pi for synthesis. If it times out or errors on a slow local
    // model, DON'T fail — fall back to the SearXNG snippets. The whole point is
    // that the main model never has to fetch/read raw pages itself.
    let rawOut = "";
    try {
      const { stdout } = await execAsync(
        `pi --no-session --no-extensions --no-tools --thinking off --offline -p "@${promptFile}" < /dev/null`,
        { cwd: searchDir, timeout: SUB_PI_TIMEOUT }
      );
      rawOut = (stdout || "").trim();
    } catch (synthErr: any) {
      // execAsync attaches partial output on timeout/kill — salvage it if usable
      rawOut = (synthErr.stdout || "").trim();
      if (rawOut.length < 40) {
        notify(`web-search: synthesis unavailable (${synthErr.message.split("\n")[0]}) — returning snippets instead`);
        return snippetResult(query, searchDir, results, "Synthesis step failed; returning raw search snippets.");
      }
      notify("web-search: synthesis timed out — using partial result");
    }

    // The local model sometimes emits thinking traces or punts to a fake file-read
    // tool instead of synthesizing. Clean the trace; if it never produced real
    // prose, fall back to the clean SearXNG snippets.
    const synthesis = cleanSynthesis(rawOut);
    if (puntedToTool(rawOut) || synthesis.length < 40) {
      notify("web-search: sub-pi didn't produce a usable summary — returning snippets instead");
      return snippetResult(query, searchDir, results, "Synthesis was unusable; returning raw search snippets.");
    }

    // 6. Save synthesis
    fs.writeFileSync(path.join(searchDir, "synthesis.md"), synthesis);

    notify("web-search: complete!");

    return {
      success: true,
      query,
      pagesSearched: pageContents.length,
      synthesisPath: path.join(searchDir, "synthesis.md"),
      synthesis,
    };

  } catch (e: any) {
    notify(`web-search: error — ${e.message}`);
    return { success: false, error: e.message };
  }
}

// Strip reasoning traces and stray tool/XML tags that thinking models (Qwen3)
// emit even with --thinking off, so only the prose synthesis remains.
function cleanSynthesis(raw: string): string {
  let s = raw;
  s = s.replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/gi, ""); // closed thinking blocks
  s = s.replace(/<think(ing)?>[\s\S]*$/gi, "");                  // unclosed trailing thinking
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  s = s.replace(/<\/?[a-z_][a-z0-9_]*(\s[^>]*)?\/?>/gi, "");      // stray xml-ish tags (<file_read .../> etc.)
  return s.trim();
}

// True when the model punted to a (nonexistent) tool instead of synthesizing.
function puntedToTool(raw: string): boolean {
  return /<file_read|<read_file|<tool_call|I['’]?ll read the file|let me read the file|read the file first/i.test(raw);
}

// Build a snippet-only success result (used when page fetch or synthesis fails).
function snippetResult(
  query: string,
  searchDir: string,
  results: Array<{ title: string; url: string; snippet: string }>,
  message: string
): { success: true; query: string; message: string; snippets: Array<{ title: string; url: string; snippet: string }> } {
  const snippetContent = results.map((r) => `## ${r.title}\nURL: ${r.url}\n${r.snippet}`).join("\n\n");
  try { fs.writeFileSync(path.join(searchDir, "snippets.md"), snippetContent); } catch {}
  return {
    success: true,
    query,
    message,
    snippets: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
  };
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify("web-search active — use web_search() tool for web research", "info");
  });

  // Register the web_search tool
  (pi as any).registerTool({
    name: "web_search",
    description: `Search the web and synthesize results. Use this BEFORE implementing when:
- Working with a library/API you're unsure about
- User mentions versions, "latest", or recent dates
- Debugging error messages you don't recognize
- Anything that might have changed since your training

Returns a synthesized summary, not raw pages. Example: web_search("svelte 5 runes tutorial")`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    // Pi tool signature: (toolCallId, params, signal, onUpdate, ctx).
    // Progress goes through onUpdate; results are returned as { content: [...] }.
    execute: async (
      _toolCallId: string,
      params: { query: string },
      _signal: AbortSignal,
      onUpdate: (content: any) => void,
      ctx: any
    ): Promise<any> => {
      const fmt = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
      const notify = (msg: string) => {
        try { onUpdate({ content: [{ type: "text" as const, text: msg }] }); } catch {}
      };
      const query = params?.query;
      if (!query) return fmt("web_search error: missing 'query' parameter.");
      const cwd = ctx?.cwd || process.cwd();

      const result = await performSearch(query, cwd, notify);

      if (!result.success) return fmt(`web_search failed: ${result.error}`);
      if (result.synthesis) return fmt(result.synthesis);
      if (result.snippets) {
        const text = result.snippets.map(s => `## ${s.title}\nURL: ${s.url}\n${s.snippet}`).join("\n\n");
        return fmt(`${result.message ?? ""}\n\n${text}`.trim());
      }
      return fmt("web_search: no results.");
    },
  });

  // /searxng — manage the local search backend container
  pi.registerCommand("searxng", {
    description: "Manage the SearXNG backend. Usage: /searxng [status|up|down|rm]",
    handler: async (args: any, ctx: any) => {
      const sub = (args ?? "").trim().toLowerCase();
      const notify = (m: string, level: string = "info") => ctx.ui.notify(m, level);

      if (sub === "" || sub === "status") {
        const up = await searxngReachable();
        notify(
          up
            ? `searxng: UP at ${SEARXNG_URL} (use /searxng down to stop)`
            : `searxng: DOWN. Use /searxng up to start it.`
        );
        return;
      }
      if (sub === "up" || sub === "start" || sub === "restart") {
        await startSearxng((m) => notify(m));
        return;
      }
      if (sub === "down" || sub === "stop") {
        try {
          await execAsync(`docker stop ${SEARXNG_CONTAINER}`, { timeout: 20000 });
          notify("searxng: stopped (kept for fast restart — /searxng up to resume, /searxng rm to delete).");
        } catch (e: any) {
          notify(`searxng: stop failed — ${e.message}`, "error");
        }
        return;
      }
      if (sub === "rm" || sub === "kill" || sub === "remove") {
        try {
          await execAsync(`docker rm -f ${SEARXNG_CONTAINER}`, { timeout: 20000 });
          notify("searxng: container removed. Config kept at " + SEARXNG_CONF + ".");
        } catch (e: any) {
          notify(`searxng: remove failed — ${e.message}`, "error");
        }
        return;
      }
      notify("usage: /searxng [status|up|down|rm]");
    },
  });

  // /web-search command for manual use
  pi.registerCommand("web-search", {
    description: "Search web manually. Usage: /web-search <query>",
    handler: async (args: any, ctx: any) => {
      const query = (args ?? "").trim();
      if (!query) {
        ctx.ui.notify("Usage: /web-search <query>", "info");
        return;
      }
      const cwd = ctx?.cwd || process.cwd();
      const result = await performSearch(query, cwd, (msg) => ctx.ui.notify(msg, "info"));
      if (result.success && result.synthesis) {
        ctx.ui.notify(`\n${result.synthesis}`, "info");
      } else if (result.success && result.snippets) {
        const text = result.snippets.map(s => `## ${s.title}\nURL: ${s.url}\n${s.snippet}`).join("\n\n");
        ctx.ui.notify(`\n${result.message ?? ""}\n\n${text}`, "info");
      } else if (!result.success) {
        ctx.ui.notify(`web-search failed: ${result.error}`, "error");
      }
    },
  });
}
