// FUNCTIONAL test: drives the REAL code-research pipeline end-to-end with no
// LLM — a throwaway project provides the corpus, and a fake `pi` executable on
// PATH plays every sub-Pi call (decompose / findings / gap-check / report).
// Verifies the coded procedure: pure-node search finds the right files, the
// gap-check follow-up chases an identifier only mentioned in round 1, findings
// carry file references, the distill L2 concept index pulls in a file whose
// identifiers never match, and both entry points (command steer + tool return)
// deliver the report.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-coderesearch-")));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, "src"), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ── throwaway project: auth flow split across files ────────────────────────
fs.writeFileSync(path.join(PROJ, "src", "auth.ts"), `import { EventBus } from "./bus";
export function authenticate(token: string): boolean {
  if (!token) return false;
  EventBus.publish("auth.attempt", token);
  return token.startsWith("valid-");
}
`);
// the hop target: only findable by searching "EventBus" (round 2)
fs.writeFileSync(path.join(PROJ, "src", "bus.ts"), `export const EventBus = {
  publish(topic: string, payload: unknown): void {
    console.log(topic, payload);
  },
};
`);
// concept-index target: no identifier overlap, but its distill summary
// mentions caching. Deliberately L1-only (no L2) — proves the fallback,
// since most projects only ever run /distill once.
fs.writeFileSync(path.join(PROJ, "src", "store.ts"), `export const memo = new Map<string, unknown>();
`);
const L1 = path.join(PROJ, ".think", "distill", "L1", "src");
fs.mkdirSync(L1, { recursive: true });
fs.writeFileSync(path.join(L1, "store.ts.md"), "# store.ts\nCaches authenticate results in a memo map.\n");
// noise that must NOT outrank real matches
fs.writeFileSync(path.join(PROJ, "src", "unrelated.ts"), `export const nothing = 1;\n`);

// ── fake `pi` on PATH — answers by prompt kind ──────────────────────────────
const BIN = path.join(TMP, "bin");
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "pi"), `#!/bin/zsh
for a in "$@"; do case "$a" in @*) pf="\${a#@}";; esac; done
p="$(cat "$pf")"
case "$p" in
  *"Decompose it into"*)
    echo "How is a token validated | authenticate token"
    echo "Where are results cached | caches memo"
    ;;
  *"reviewing codebase findings"*)
    if [ -f "${TMP}/gaps-asked" ]; then echo "COMPLETE"; else
      touch "${TMP}/gaps-asked"
      echo "What does the event bus do with auth attempts | EventBus publish"
    fi
    ;;
  *"Write a report answering"*)
    echo "# Report"
    echo "## Answer"
    echo "Tokens are validated in src/auth.ts:2 by authenticate() and published to the EventBus (src/bus.ts:2). Results are cached in the memo map (src/store.ts:1). This answer is long enough to pass the report length check."
    ;;
  *)
    echo "The excerpts show authenticate() validating tokens at src/auth.ts:2 and publishing via EventBus [src/auth.ts:4]. Version details are explicit in the code."
    ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${BIN}:${process.env.PATH}`;

// ── import the REAL extension ───────────────────────────────────────────────
process.chdir(PROJ);
const SRC = path.join(REPO_ROOT, "extensions", "code-research.ts");
const stripped = path.join(TMP, "code-research.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8")
  .replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

const commands = {};
const tools = {};
const steers = [];
mod.default({
  on: () => {},
  registerCommand: (name, def) => { commands[name] = def; },
  registerTool: (def) => { tools[def.name] = def; },
  sendMessage: (msg, opts) => { steers.push({ msg, opts }); },
});

console.log("code-research functional:");
check("registers /ask", !!commands.ask);
check("registers code_research tool (auto-pick by the model)", !!tools.code_research);

// ── full pipeline via the command ───────────────────────────────────────────
const notes = [];
const ctx = { cwd: PROJ, ui: { notify: (m) => notes.push(m) } };
await commands.ask.handler("how does authentication work end to end --rounds 3", ctx);

const dir = path.join(PROJ, ".think", "code-research", "how-does-authentication-work-end-to-end");
check("plan.md written with parsed sub-questions",
  fs.existsSync(path.join(dir, "plan.md")) &&
  fs.readFileSync(path.join(dir, "plan.md"), "utf8").split("\n").filter((l) => l.includes("|")).length === 2);

const q1 = path.join(dir, "round-1", "q1.md");
check("round-1 findings written", fs.existsSync(q1) && fs.existsSync(path.join(dir, "round-1", "q2.md")));
check("search located the right file", fs.existsSync(q1) && fs.readFileSync(q1, "utf8").includes("src/auth.ts"));
check("noise file not consulted", !fs.existsSync(q1) || !fs.readFileSync(q1, "utf8").includes("unrelated.ts"));
check("distill concept index (L1 fallback, no L2) pulled in store.ts",
  fs.existsSync(path.join(dir, "round-1", "q2.md")) &&
  fs.readFileSync(path.join(dir, "round-1", "q2.md"), "utf8").includes("src/store.ts"));
check("banner names the level actually used", notes.some((m) => m.includes("distill L1 summaries as concept index")));

const hop = path.join(dir, "round-2", "q1.md");
check("gap-check hop investigated EventBus in round 2",
  fs.existsSync(hop) && fs.readFileSync(hop, "utf8").includes("src/bus.ts"));

check("report.md written", fs.existsSync(path.join(dir, "report.md")));
check("report delivered exactly once as steer", steers.length === 1 && steers[0].opts?.deliverAs === "steer");
check("steer starts with mandatory harness prefix",
  steers.length === 1 && steers[0].msg.content.startsWith("[code-research] AUTOMATED HARNESS MESSAGE"));

// ── tool path: reuses the existing report, returns it as the tool result ───
const updates = [];
const toolResult = await tools.code_research.execute(
  "id1", { question: "how does authentication work end to end" }, null,
  (u) => updates.push(u), { cwd: PROJ }
);
check("tool returns the report text",
  toolResult?.content?.[0]?.text?.includes("src/auth.ts") &&
  toolResult.content[0].text.includes("## Answer"));
check("tool reused the report instead of re-running", steers.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
