// web-search.ts
// Web search with sub-pi synthesis. Searches DuckDuckGo, fetches pages,
// extracts content, spawns isolated sub-pi to synthesize, returns summary.
//
// The main pi context only sees the final summary, not raw web content.
//
// Install: copy to ~/.pi/agent/extensions/web-search.ts
// Requires: npm install -g cheerio (or in ~/.pi/node_modules)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import * as https from "https";
import * as http from "http";

const execAsync = promisify(exec);

const PIFORGE_CONFIG = path.join(os.homedir(), ".pi", "piforge.json");
const MAX_PAGES = 5;
const PAGE_TIMEOUT = 8000;
const SUB_PI_TIMEOUT = 90000;
const MAX_CONTENT_PER_PAGE = 3000;

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

// Parse DuckDuckGo HTML results
function parseDDGResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // DDG HTML results are in <a class="result__a" href="...">title</a>
  // and <a class="result__snippet">snippet</a>
  const resultBlocks = html.split(/class="result__body"/gi).slice(1);

  for (const block of resultBlocks.slice(0, MAX_PAGES + 3)) {
    // Extract URL from result__a href
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/i);
    // Extract title
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</i);
    // Extract snippet
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)</i);

    if (urlMatch && titleMatch) {
      let url = urlMatch[1];
      // DDG wraps URLs, extract actual URL
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

      results.push({
        url: url,
        title: decodeHTMLEntities(titleMatch[1]).trim(),
        snippet: snippetMatch ? decodeHTMLEntities(snippetMatch[1]).trim() : "",
      });
    }
  }
  return results.slice(0, MAX_PAGES);
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
    execute: async (params: { query: string }, ctx: any) => {
      const { query } = params;
      const cwd = ctx.cwd;
      const purpose = readPurpose(cwd);

      ctx.ui.notify(`web-search: searching "${query}"...`, "info");

      // Setup directories
      const searchDir = path.join(cwd, ".think", "web-search", hashQuery(query));
      ensureDir(searchDir);

      try {
        // 1. Search DuckDuckGo
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const ddgHtml = await fetchUrl(ddgUrl);
        const results = parseDDGResults(ddgHtml);

        if (results.length === 0) {
          return { success: false, error: "No search results found" };
        }

        ctx.ui.notify(`web-search: found ${results.length} results, fetching pages...`, "info");

        // 2. Fetch pages in parallel
        const pageContents: Array<{ title: string; url: string; content: string }> = [];

        await Promise.all(
          results.map(async (r, i) => {
            try {
              const html = await fetchUrl(r.url);
              const content = extractContent(html);
              if (content.length > 100) {
                pageContents.push({ title: r.title, url: r.url, content });
                ctx.ui.notify(`web-search: fetched [${i + 1}/${results.length}] ${r.title.slice(0, 40)}...`, "info");
              }
            } catch (e) {
              // Skip failed pages
            }
          })
        );

        if (pageContents.length === 0) {
          // Fall back to snippets if page fetching failed
          const snippetContent = results.map(r => `## ${r.title}\nURL: ${r.url}\n${r.snippet}`).join("\n\n");
          fs.writeFileSync(path.join(searchDir, "snippets.md"), snippetContent);
          return {
            success: true,
            message: "Could not fetch full pages, but found snippets.",
            snippets: results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }))
          };
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

        const promptContent = `You are a research assistant synthesizing web search results.

MAIN TASK CONTEXT: ${purpose || "General research"}

SEARCH QUERY: ${query}

## Web Pages Found:

${combinedContent}

---

INSTRUCTIONS:
1. Extract ONLY information directly relevant to the search query and main task
2. Ignore navigation, ads, cookie notices, unrelated content
3. Synthesize into a clear, actionable summary
4. Include specific code examples, version numbers, or commands if found
5. Cite which page(s) information came from
6. Maximum 400 words

Write your synthesis now:`;

        const promptFile = path.join(searchDir, "_prompt.md");
        fs.writeFileSync(promptFile, promptContent);

        ctx.ui.notify("web-search: synthesizing with sub-pi...", "info");

        // 5. Run sub-pi for synthesis
        const { stdout } = await execAsync(
          `pi --no-session --no-extensions --no-tools --thinking off --offline -p @${promptFile} < /dev/null`,
          { cwd: searchDir, timeout: SUB_PI_TIMEOUT }
        );

        const synthesis = stdout.trim();

        // 6. Save synthesis
        fs.writeFileSync(path.join(searchDir, "synthesis.md"), synthesis);

        ctx.ui.notify("web-search: complete!", "info");

        return {
          success: true,
          query,
          pagesSearched: pageContents.length,
          synthesisPath: path.join(searchDir, "synthesis.md"),
          synthesis,
        };

      } catch (e: any) {
        ctx.ui.notify(`web-search: error — ${e.message}`, "error");
        return { success: false, error: e.message };
      }
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
      ctx.ui.notify(`Starting web search for: ${query}`, "info");
      // Trigger the tool
      const result = await (pi as any).callTool("web_search", { query }, ctx);
      if (result.synthesis) {
        ctx.ui.notify(`\n${result.synthesis}`, "info");
      }
    },
  });
}
