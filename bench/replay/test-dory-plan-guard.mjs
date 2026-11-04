// Replay test: dory-plan-guard's read-only enforcement for Dory's chat/plan/
// respond jobs, plus the deliverable latch that stops the drift into coding.
//
// Origin: 2026-07-25, card T-006 ("I need a website for a CRM"). The plan job
// ran in the attached /dory session (full tool set, full guard stack), emitted a
// correct <<<BRIEF>>>, then wrote .think/_state.md + .think/step-001.md under
// guard steers and started implementing crm.html — inside the PLANNING job.
//
// The mutating-bash regex is parsed LIVE from the extension source (not
// re-typed), so tuning it in the guard is reflected here automatically.
import { readExtension, parseNumericConst, requireMarker, report } from "./lib/extension-source.mjs";

const FILE = "dory-plan-guard.ts";
const src = readExtension(FILE);

const BLOCKS_BEFORE_STEER = parseNumericConst(src, "BLOCKS_BEFORE_STEER", FILE);

requireMarker(src, "if (delivered) {", FILE, "deliverable latch → block every later tool call");
requireMarker(src, "!ALLOWED_TOOLS.has(tool)", FILE, "tool allowlist check");
requireMarker(src, "bashMutates(command)", FILE, "mutating-bash check");
requireMarker(src, 'ae?.type !== "text_delta"', FILE, "mid-stream latch (a turn can emit markers THEN call tools)");
requireMarker(src, "READONLY_KINDS", FILE, "stage scoping (exec must stay untouched)");
requireMarker(src, "job.key !== jobKey", FILE, "per-JOB latch reset (consecutive jobs share one session)");
requireMarker(src, "state.pid !== process.pid", FILE, "job record is process-owned (global file, one slot)");

// --- pull the guard's own data out of the source, so the copies can't drift ---

function parseStringArray(name) {
  const m = src.match(new RegExp(`const\\s+${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
  if (!m) throw new Error(`cannot find "const ${name} = [...]" in ${FILE} — update this test.`);
  return m[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1));
}

function parseSet(name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`cannot find "const ${name} = new Set([...])" in ${FILE} — update this test.`);
  return new Set(m[1].match(/"[^"]+"/g).map((s) => s.slice(1, -1)));
}

function parseRegex(name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\n?\\s*/([\\s\\S]*?)/([gimsuy]*);`));
  if (!m) throw new Error(`cannot find "const ${name} = /.../" in ${FILE} — update this test.`);
  return new RegExp(m[1], m[2]);
}

const READONLY_KINDS = parseStringArray("READONLY_KINDS");
const ALLOWED_TOOLS = parseSet("ALLOWED_TOOLS");
const MUTATING_CMD = parseRegex("MUTATING_CMD");

// --- decision logic mirroring the guard (markers above keep it honest) ---

const stripQuoted = (c) => c.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

function hasFileRedirect(command) {
  const bare = stripQuoted(command);
  const re = />>?\s*([^\s;|&]+|&\d)/g;
  let m;
  while ((m = re.exec(bare)) !== null) {
    const target = m[1];
    if (/^&\d$/.test(target)) continue;
    if (/^\/dev\/(null|stdout|stderr|fd\/\d+)$/.test(target)) continue;
    return true;
  }
  return false;
}

const bashMutates = (command) => hasFileRedirect(command) || MUTATING_CMD.test(stripQuoted(command));

function deliverableEmitted(text) {
  if (text.includes("<<<END>>>")) return true;
  if (text.includes("<<<TEST>>>")) return true;
  const count = (marker) => text.split(marker).length - 1;
  return count("<<<BRIEF>>>") >= 2 || count("<<<REPLY>>>") >= 2;
}

// Replays a job: a list of {text} (assistant output) and {tool, command?} calls.
// Returns the indexes that the guard blocks, and how many steers it would send.
function run(events) {
  let delivered = false;
  let blocks = 0;
  let steers = 0;
  const blockedAt = [];
  events.forEach((e, i) => {
    if (e.text !== undefined) {
      if (deliverableEmitted(e.text)) delivered = true;
      return;
    }
    const blocked =
      delivered || !ALLOWED_TOOLS.has(e.tool) || (e.tool === "bash" && bashMutates(e.command ?? ""));
    if (blocked) {
      blocks++;
      blockedAt.push(i);
      if (blocks === BLOCKS_BEFORE_STEER) steers++;
    }
  });
  return { blockedAt, blocks, steers };
}

// Recorded T-006 shape: brief emitted, then the guard steers pushed it into
// .think/ writes and on into implementing crm.html.
const t006 = [
  { tool: "bash", command: "ls -la" },
  { tool: "read", path: "README.md" },
  { tool: "bash", command: 'find . -name "*.html" -o -name "*.js" | head -30' },
  { text: "<<<BRIEF>>>\n# T-006 — CRM\n## Purpose\n<<<TEST>>>\n#!/usr/bin/env bash\n<<<END>>>" },
  { tool: "write", path: ".think/step-001.md" },  // ← blocked
  { tool: "write", path: ".think/_state.md" },    // ← blocked
  { tool: "write", path: "crm.html" },            // ← blocked (the actual drift)
];

// Browsing before the brief stays fully usable.
const browsing = [
  { tool: "bash", command: "ls -la" },
  { tool: "bash", command: 'grep -n "=>" storage.js' },        // quoted > is not a redirect
  { tool: "bash", command: 'grep -rn "a > b" .' },
  { tool: "bash", command: "git log --oneline -5 && git diff --stat" },
  { tool: "bash", command: "cat index.html | head -50" },
  { tool: "bash", command: "node --version 2>&1" },            // 2>&1 is not a write
  { tool: "bash", command: "ls -la > /dev/null" },             // /dev/null is not a write
  { tool: "read", path: "style.css" },
  { tool: "grep", pattern: "customer" },
  { tool: "web_search", query: "localStorage quota 2026" },
];

// Every write side door the persona's "no bash redirection tricks" refers to.
const sideDoors = [
  { tool: "write", path: "crm.html" },
  { tool: "edit", path: "style.css" },
  { tool: "bash", command: "cat > crm.html <<'EOF'\n<html></html>\nEOF" },
  { tool: "bash", command: 'echo ".crm { color: red }" >> style.css' },
  { tool: "bash", command: "mkdir -p crm/assets" },
  { tool: "bash", command: "rm -rf test12312993" },
  { tool: "bash", command: "touch crm.js" },
  { tool: "bash", command: "sed -i '' 's/a/b/' style.css" },
  { tool: "bash", command: "cp index.html crm.html" },
  { tool: "bash", command: "mv a.md b.md" },
  { tool: "bash", command: "tee crm.js" },
  { tool: "bash", command: 'git add -A && git commit -m "wip"' },
  { tool: "bash", command: "npm install express" },
  { tool: "bash", command: "npx create-react-app crm" },
  { tool: "bash", command: `python3 -c "open('crm.html','w').write('x')"` },
  { tool: "bash", command: "curl -s https://x.dev/t.css -o style2.css" },
  { tool: "bash", command: "find . -name '*.tmp' -delete" },
];

const checks = [
  ["exec stage is out of scope (only chat/plan/respond enforced)",
    !READONLY_KINDS.includes("exec") && ["chat", "plan", "respond"].every((k) => READONLY_KINDS.includes(k))],
  ["recorded T-006 shape → all 3 post-brief writes blocked", (() => {
    const r = run(t006);
    return r.blocks === 3 && r.blockedAt.join(",") === "4,5,6";
  })()],
  ["read-only browsing before the brief → zero blocks", run(browsing).blocks === 0],
  ["every write side door blocked (write/edit/heredoc/redirect/rm/git/installers)",
    run(sideDoors).blocks === sideDoors.length],
  [`repeated write attempts steer exactly once (at ${BLOCKS_BEFORE_STEER} blocks)`, run(sideDoors).steers === 1],
  ["a plan without <<<TEST>>> or <<<END>>> does not latch early (mangled markers)", (() => {
    const partial = [
      { text: "Let me look around first." },
      { tool: "bash", command: "ls" },
      { text: "<<<BRIEF>>>\n# T-006 — CRM\n## Purpose\nbuild it" },
      { tool: "read", path: "storage.js" }, // still browsing — must NOT be blocked
    ];
    return run(partial).blocks === 0;
  })()],
  ["the observed close-with-a-second-<<<BRIEF>>> shape latches", (() => {
    const doubled = [
      { text: "<<<BRIEF>>>\n# T-006\n## Purpose\n...\n<<<BRIEF>>>" },
      { tool: "read", path: "storage.js" }, // job is over — blocked
    ];
    return run(doubled).blocks === 1;
  })()],
  ["chat reply latches on <<<END>>> too", (() => {
    const chat = [
      { text: "<<<REPLY>>>\nDrop it in Plan Queue.\n<<<END>>>" },
      { tool: "bash", command: "ls" },
    ];
    return run(chat).blocks === 1;
  })()],
];

process.exitCode = report("test-dory-plan-guard", checks) === 0 ? 0 : 1;
