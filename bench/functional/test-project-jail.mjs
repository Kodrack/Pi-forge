// FUNCTIONAL test: drives the REAL project-jail code against a fake
// ExtensionAPI, with process.cwd() pointed at a throwaway project.
//
// Origin of the heredoc cases: 2026-07-26 false positive. The model appended
// PiForge documentation with `cat >> <file> <<'CHUNK'`; the doc body mentioned
// ~/.pi/agent/ (as PiForge docs must) and the command was blocked even though
// the target was inside the project. That collides with the chunked-append
// workflow incremental-guard forces the model into, so it had to be fixed
// WITHOUT weakening the original case this guard exists for (an executor that
// built an entire website in ~/Desktop instead of its project).
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-jail-")));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(PROJ, { recursive: true });

// project-jail reads process.cwd() as the project root.
process.chdir(PROJ);

const SRC = path.join(REPO_ROOT, "extensions", "project-jail.ts");
const stripped = path.join(TMP, "project-jail.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

let toolCall;
mod.default({
  on: (ev, h) => { if (ev === "tool_call") toolCall = h; },
  registerCommand: () => {},
  sendMessage: async () => {},
});

const bash = (command) => toolCall({ toolName: "bash", input: { command } }, {});
const write = (p) => toolCall({ toolName: "write", input: { path: p, content: "x" } }, {});

const results = [];
const check = (label, ok) => results.push([label, ok]);
const blocked = async (v) => !!(await v)?.block;

// ---- the recorded false positive: PiForge docs mentioning ~/.pi in a heredoc ----
{
  const cmd = [
    "cat >> ARCHITECTURE.md <<'CHUNK'",
    "| Extensions | Copied to ~/.pi/agent/extensions/ by install.sh |",
    "| Config | ~/.pi/piforge.json holds the disabled array |",
    "Pi loads extensions from ~/.pi/agent/extensions/, NOT from this repo.",
    "CHUNK",
  ].join("\n");
  check("heredoc body mentioning ~/.pi/agent/ → ALLOWED (recorded false positive)", !(await blocked(bash(cmd))));
}

// ---- the case the guard exists for is still caught ----
{
  const cmd = ["cat > ~/Desktop/site/index.html <<'EOF'", "<h1>hi</h1>", "EOF"].join("\n");
  check("heredoc writing INTO ~/Desktop → still blocked (opener is scanned)", await blocked(bash(cmd)));
}
check("mkdir -p ~/Desktop/site → still blocked", await blocked(bash("mkdir -p ~/Desktop/site")));
check("cp into a home path → still blocked", await blocked(bash("cp build.js ~/Desktop/out/build.js")));
check("absolute /Users mutation → still blocked", await blocked(bash(`echo x > ${path.join(os.homedir(), "notes.txt")}`)));
check("cd out of the project → still blocked", await blocked(bash("cd ~/other-project && npm test")));

// ---- reading/executing outside the project stays allowed ----
check("running a script outside the project → allowed", !(await blocked(bash("bash ~/other-repo/tests/T-001.sh"))));
check("reading an outside file → allowed", !(await blocked(bash("cat ~/other-repo/data.json"))));

// ---- ordinary in-project work stays allowed ----
check("relative chunked append → allowed", !(await blocked(bash("cat >> regex.js <<'C'\nmatch()\nC"))));
check("in-project mkdir → allowed", !(await blocked(bash("mkdir -p src/lib"))));

// ---- heredoc mechanics ----
{
  const indented = ["cat >> notes.md <<-'END'", "\tinstall to ~/.pi/agent/", "\tEND"].join("\n");
  check("<<- with indented terminator → body still stripped, allowed", !(await blocked(bash(indented))));

  const unquoted = ["cat >> notes.md <<EOF", "see ~/.pi/piforge.json", "EOF"].join("\n");
  check("unquoted heredoc tag → body stripped, allowed", !(await blocked(bash(unquoted))));

  const afterBody = ["cat >> notes.md <<'C'", "mentions ~/.pi/agent/", "C", "mkdir -p ~/Desktop/late"].join("\n");
  check("command AFTER a heredoc body is still scanned → blocked", await blocked(bash(afterBody)));

  const unterminated = ["cat >> notes.md <<'C'", "mentions ~/.pi/agent/ and never closes"].join("\n");
  check("unterminated heredoc → body still ignored, allowed", !(await blocked(bash(unterminated))));
}

// ---- write/edit path checks unchanged ----
check("write outside the project → blocked", await blocked(write(path.join(os.homedir(), "Desktop", "x.js"))));
check("write inside the project → allowed", !(await blocked(write("src/x.js"))));
check("write to /tmp → allowed", !(await blocked(write(path.join(os.tmpdir(), "scratch.js")))));

process.chdir(REPO_ROOT);
fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-project-jail (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
