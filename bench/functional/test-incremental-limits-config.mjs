// FUNCTIONAL test: drives the REAL incremental-guard with its limits coming
// from a machine-local ~/.pi/piforge.json, under a throwaway HOME.
//
// The limits are shipped as code DEFAULTS; a machine tunes them in
// ~/.pi/piforge.json → "limits" → "incremental-guard" instead of editing the
// extension. This checks that the override actually changes what gets blocked,
// that bad values can't silently loosen or break the guard, and that a changed
// file is picked up on the next session_start (/reload).
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-limits-")));
const HOME = path.join(TMP, "home");
fs.mkdirSync(path.join(HOME, ".pi"), { recursive: true });
process.env.HOME = HOME; // os.homedir() → the guard reads HOME/.pi/piforge.json
const CONFIG = path.join(HOME, ".pi", "piforge.json");
const setConfig = (obj) => fs.writeFileSync(CONFIG, JSON.stringify(obj));

// Node can't resolve the Pi package here — strip its imports (types + an unused helper).
const SRC = path.join(REPO_ROOT, "extensions", "incremental-guard.ts");
const stripped = path.join(TMP, "incremental-guard.ts");
fs.writeFileSync(
  stripped,
  fs.readFileSync(SRC, "utf-8").replace(/^import .*"@mariozechner\/pi-coding-agent";$/gm, "// (pi import stripped)")
);
const mod = await import(stripped);

const handlers = {};
mod.default({
  on: (ev, h) => { handlers[ev] = h; },
  registerCommand: () => {},
  sendMessage: async () => {},
});
const notes = [];
const ctx = { ui: { notify: (msg, level) => notes.push({ msg, level }) } };
const startSession = async () => { notes.length = 0; await handlers.session_start({}, ctx); };
const write = (n) => handlers.tool_call(
  { toolName: "write", input: { path: path.join(TMP, "f.js"), content: Array(n).fill("x").join("\n") } }, ctx);
const blocked = async (n) => (await write(n))?.block === true;

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

// 1. No config file → shipped defaults.
const D = mod.loadLimits(path.join(TMP, "missing.json")).limits;
await startSession();
check(`no piforge.json → default write cap ${D.maxLinesPerWrite}: ${D.maxLinesPerWrite + 1} lines blocked`, await blocked(D.maxLinesPerWrite + 1));
check(`no piforge.json → ${D.maxLinesPerWrite} lines allowed`, !(await blocked(D.maxLinesPerWrite)));

// 2. Override raises the write cap; the block message states the ACTIVE limit.
setConfig({ disabled: [], limits: { "incremental-guard": { maxLinesPerWrite: 200 } } });
await startSession();
check("override maxLinesPerWrite=200 → 150 lines now allowed", !(await blocked(150)));
check("override maxLinesPerWrite=200 → 201 lines blocked", await blocked(201));
check("block reason quotes the active limit (200), not the default", (await write(201)).reason.includes("(200 lines /"));
check("banner reports the override", notes.some((n) => n.msg.includes("overrides from ~/.pi/piforge.json: maxLinesPerWrite=200")));
check("other limits keep their defaults", mod.loadLimits(CONFIG).limits.maxLinesPerEdit === D.maxLinesPerEdit);

// 3. Bad values are ignored (defaults stay) and reported — never applied.
setConfig({ limits: { "incremental-guard": { maxLinesPerWrite: "200", maxCharsPerWrite: -5, maxLinesPerEdit: 1.5, maxLinesPerWrit: 999 } } });
const bad = mod.loadLimits(CONFIG);
check("string / negative / fractional values ignored → defaults kept",
  bad.limits.maxLinesPerWrite === D.maxLinesPerWrite && bad.limits.maxCharsPerWrite === D.maxCharsPerWrite && bad.limits.maxLinesPerEdit === D.maxLinesPerEdit);
check("all 4 bad entries reported (incl. the misspelled key)", bad.ignored.length === 4 && bad.ignored.some((x) => x.startsWith("maxLinesPerWrit (unknown key)")));
await startSession();
check("bad values → a warning in the banner", notes.some((n) => n.level === "warning" && n.msg.includes("ignored")));
check("bad values → guard still enforces the default cap", await blocked(D.maxLinesPerWrite + 1));

// 4. Unreadable JSON → defaults, no crash.
fs.writeFileSync(CONFIG, "{ not json");
await startSession();
check("malformed piforge.json → defaults, session still starts", await blocked(D.maxLinesPerWrite + 1));

// 5. Editing the file takes effect on the next session_start (/reload), not mid-session.
setConfig({ limits: { "incremental-guard": { maxLinesPerWrite: 300 } } });
check("before /reload the old limits stay active", await blocked(250));
await startSession();
check("after /reload the new limit (300) is active", !(await blocked(250)));

// 6. /piforge enable|disable rewrites piforge.json — it must keep the limits section.
const mgrSrc = path.join(REPO_ROOT, "extensions", "piforge-manager.ts");
const mgrStripped = path.join(TMP, "piforge-manager.ts");
fs.writeFileSync(mgrStripped, fs.readFileSync(mgrSrc, "utf-8").replace(/^import .*"@mariozechner\/pi-coding-agent";$/gm, "// (pi import stripped)"));
const mgr = await import(mgrStripped);
const cmds = {};
mgr.default({ on: () => {}, registerCommand: (name, def) => { cmds[name] = def; }, sendMessage: async () => {} });
setConfig({ disabled: [], limits: { "incremental-guard": { maxLinesPerWrite: 200 } } });
await cmds.piforge.handler("disable plan-clarify", ctx);
const after = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
check("/piforge disable keeps limits.incremental-guard in piforge.json",
  after.disabled.includes("plan-clarify") && after.limits?.["incremental-guard"]?.maxLinesPerWrite === 200);

fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-incremental-limits-config (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);