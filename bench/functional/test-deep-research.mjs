// FUNCTIONAL test: drives the REAL deep-research pipeline end-to-end with no
// LLM and no network — a local HTTP stub plays SearXNG (+ the result pages),
// and a fake `pi` executable on PATH plays every sub-Pi call, answering by
// recognizing which pipeline prompt it was given (decompose / findings /
// gap-check / report). Verifies the CODED procedure: plan.md, per-question
// findings with source URLs, gap-check handling, report.md, and the final
// steer message with the mandatory harness prefix.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-research-")));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(PROJ, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ── stub SearXNG + result pages ─────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/search") {
    const q = u.searchParams.get("q") ?? "";
    if (q === "ping") { res.end(JSON.stringify({ results: [] })); return; }
    // conversational queries return nothing (mirrors keyword-only engines) —
    // exercises the simplify-and-retry path
    if (/\bversus\b/i.test(q)) { res.end(JSON.stringify({ results: [] })); return; }
    const base = `http://localhost:${server.address().port}`;
    res.end(JSON.stringify({
      results: [
        { url: `${base}/page-a`, title: `About ${q}`, content: `snippet about ${q}` },
        { url: `${base}/page-b`, title: `${q} guide`, content: `guide snippet` },
      ],
    }));
    return;
  }
  // result pages — long enough to survive the >100 char content filter
  res.end(`<html><body><article>${"Detailed reference content about the topic. ".repeat(10)}</article></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.SEARXNG_URL = `http://localhost:${server.address().port}`;

// ── fake `pi` on PATH — answers by prompt kind ──────────────────────────────
const BIN = path.join(TMP, "bin");
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "pi"), `#!/bin/zsh
# fake sub-Pi: find the @promptfile arg, answer based on prompt content
for a in "$@"; do case "$a" in @*) pf="\${a#@}";; esac; done
p="$(cat "$pf")"
case "$p" in
  *"Decompose this research topic"*)
    echo "What is the topic fundamentally | topic basics"
    echo "How does it compare | topic versus the alternatives"
    ;;
  *"reviewing research findings"*)
    if [ -f "${TMP}/gaps-already-asked" ]; then echo "COMPLETE"; else
      touch "${TMP}/gaps-already-asked"
      echo "What are the known pitfalls | topic pitfalls"
    fi
    ;;
  *"Write a research report"*)
    echo "# Report"
    echo "## Key Findings"
    echo "The topic is well documented [http://example.com]. This report is long enough to pass the minimum length check applied by the pipeline before it writes report.md and delivers the steer message."
    ;;
  *)
    echo "Findings: the sources say the topic works as described [1]. Version 2.0 was released and the guide covers usage end to end [2]."
    ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

// ── import the REAL extension ───────────────────────────────────────────────
process.chdir(PROJ);
const SRC = path.join(REPO_ROOT, "extensions", "deep-research.ts");
const stripped = path.join(TMP, "deep-research.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8")
  .replace(/^import type .*$/m, "// (type-only import stripped)")
  // keep the suite instant: no pacing sleeps between stubbed searches
  .replace(/const SEARCH_PACING_MS = \d+/, "const SEARCH_PACING_MS = 0"));
const mod = await import(stripped);

const commands = {};
const steers = [];
mod.default({
  on: () => {},
  registerCommand: (name, def) => { commands[name] = def; },
  sendMessage: (msg, opts) => { steers.push({ msg, opts }); },
});

console.log("deep-research functional:");
check("registers /research", !!commands.research);

// ── full pipeline run ───────────────────────────────────────────────────────
const notes = [];
const ctx = { cwd: PROJ, ui: { notify: (m) => notes.push(m) } };
await commands.research.handler("How PiForge test topics work --rounds 3", ctx);

const dir = path.join(PROJ, ".think", "research", "how-piforge-test-topics-work");
check("plan.md written with parsed sub-questions",
  fs.existsSync(path.join(dir, "plan.md")) &&
  fs.readFileSync(path.join(dir, "plan.md"), "utf8").split("\n").filter((l) => l.includes("|")).length === 2);

const q1 = path.join(dir, "round-1", "q1.md");
check("round-1 findings written for each sub-question",
  fs.existsSync(q1) && fs.existsSync(path.join(dir, "round-1", "q2.md")));
check("findings carry source URLs", fs.existsSync(q1) && /Sources:\n1\. http/.test(fs.readFileSync(q1, "utf8")));
check("zero-result query retried with simplified keywords",
  notes.some((m) => m.includes('retrying as "topic alternatives"')) &&
  fs.existsSync(path.join(dir, "round-1", "q2.md")));
check("gap-check follow-up ran as round 2", fs.existsSync(path.join(dir, "round-2", "q1.md")));
check("report.md written", fs.existsSync(path.join(dir, "report.md")));

check("report delivered exactly once as steer",
  steers.length === 1 && steers[0].opts?.deliverAs === "steer");
check("steer starts with mandatory harness prefix",
  steers.length === 1 && steers[0].msg.content.startsWith("[deep-research] AUTOMATED HARNESS MESSAGE"));

// ── resume: second run must inject the existing report, not re-research ────
const before = notes.length;
await commands.research.handler("How PiForge test topics work", ctx);
check("existing report is reused (no re-run)",
  steers.length === 2 && notes.slice(before).some((m) => m.includes("report already exists")));

// ── backend-down path: clear error, no crash ────────────────────────────────
server.close();
await new Promise((r) => server.on("close", r));
const notes2 = [];
await commands.research.handler("another brand new topic", { cwd: PROJ, ui: { notify: (m) => notes2.push(m) } });
check("SearXNG down → actionable error, no throw",
  notes2.some((m) => m.includes("not reachable") && m.includes("/searxng up")));

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
