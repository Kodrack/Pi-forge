// FUNCTIONAL test: the per-machine config surface, end to end, against the REAL
// code — /piforge limits|set|reset (piforge-manager.ts), the guard that reads
// the result (incremental-guard.ts), and the update-time migration
// (migrate-config.mjs) — all under a throwaway HOME.
//
// Contract being checked: machine tuning lives ONLY in ~/.pi/piforge.json,
// every change made from /piforge lands there (never in code), bad input never
// gets saved, and updating PiForge never loses a machine's tuning.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-config-")));
const HOME = path.join(TMP, "home");
fs.mkdirSync(path.join(HOME, ".pi"), { recursive: true });
process.env.HOME = HOME;
const CONFIG = path.join(HOME, ".pi", "piforge.json");
const read = () => JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
const setConfig = (obj) => fs.writeFileSync(CONFIG, JSON.stringify(obj));

async function load(name) {
  const stripped = path.join(TMP, name);
  fs.writeFileSync(
    stripped,
    fs.readFileSync(path.join(REPO_ROOT, "extensions", name), "utf-8")
      .replace(/^import .*"@mariozechner\/pi-coding-agent";$/gm, "// (pi import stripped)")
  );
  return import(stripped);
}
const mgr = await load("piforge-manager.ts");
const guard = await load("incremental-guard.ts");

const cmds = {};
mgr.default({ on: () => {}, registerCommand: (n, d) => { cmds[n] = d; }, sendMessage: async () => {} });
const notes = [];
const ctx = { ui: { notify: (msg, level) => notes.push({ msg, level }) } };
const piforge = async (args) => { notes.length = 0; await cmds.piforge.handler(args, ctx); return notes.map((n) => n.msg).join("\n"); };

const checks = [];
const check = (label, ok) => checks.push([label, ok]);

// ---- 0. /piforge's registry must match the guard's real defaults (no drift) ----
const guardSrc = fs.readFileSync(path.join(REPO_ROOT, "extensions", "incremental-guard.ts"), "utf-8");
const CONST = { maxLinesPerWrite: "MAX_LINES_PER_WRITE", maxCharsPerWrite: "MAX_CHARS_PER_WRITE", maxLinesPerEdit: "MAX_LINES_PER_EDIT",
  maxCharsPerEdit: "MAX_CHARS_PER_EDIT", maxLinesPerBash: "MAX_LINES_PER_BASH", maxCharsPerBash: "MAX_CHARS_PER_BASH" };
const guardDefaults = guard.loadLimits(path.join(TMP, "none.json")).limits;
const regIG = mgr.SETTINGS.filter((s) => s.ext === "incremental-guard");
check("every incremental-guard limit is settable from /piforge (same key set)",
  regIG.length === Object.keys(guardDefaults).length && regIG.every((s) => s.key in guardDefaults));
check("/piforge defaults == the guard's constants (no drift)",
  regIG.every((s) => s.def === guardDefaults[s.key] && new RegExp(`const\\s+${CONST[s.key]}\\s*=\\s*${s.def}\\b`).test(guardSrc)));

// ---- 1. limits listing ----
setConfig({ disabled: ["plan-clarify"] });
let out = await piforge("limits");
check("/piforge limits lists every setting with its default", regIG.every((s) => out.includes(`incremental-guard.${s.key}`)) && out.includes("100"));

// ---- 2. set → saved to piforge.json, other sections kept, guard sees it ----
out = await piforge("set incremental-guard.maxLinesPerWrite 200");
check("/piforge set saves the value to ~/.pi/piforge.json", read().limits?.["incremental-guard"]?.maxLinesPerWrite === 200);
check("/piforge set keeps the disabled list", read().disabled.includes("plan-clarify"));
check("/piforge set says it was saved and needs /reload", out.includes("saved to ~/.pi/piforge.json") && out.includes("/reload"));
check("the guard picks the saved value up", guard.loadLimits(CONFIG).limits.maxLinesPerWrite === 200);
out = await piforge("limits");
check("/piforge limits shows the override next to its default", /maxLinesPerWrite\s+200\s+\(default 100\)/.test(out));
out = await piforge("");
check("/piforge status mentions overridden limits", out.includes("1 overridden"));

// ---- 3. bad input never reaches the file ----
const before = fs.readFileSync(CONFIG, "utf-8");
for (const bad of ["set incremental-guard.maxLinesPerWrite abc", "set incremental-guard.maxLinesPerWrite 0",
  "set incremental-guard.maxLinesPerWrite -5", "set incremental-guard.maxLinesPerWrite 1.5",
  "set incremental-guard.maxLinesPerWrite", "set incremental-guard.maxLinesPerWrit 300", "set nope 3"]) await piforge(bad);
check("invalid values / unknown keys / missing value → file unchanged", fs.readFileSync(CONFIG, "utf-8") === before);

// ---- 4. setting the default value removes the override instead of pinning it ----
await piforge("set incremental-guard.maxLinesPerEdit 80");
await piforge("set incremental-guard.maxLinesPerEdit 60");
check("set to the default → override removed", !("maxLinesPerEdit" in (read().limits?.["incremental-guard"] ?? {})));

// ---- 5. reset: one key, whole extension, all — and the file is tidied ----
await piforge("set incremental-guard.maxCharsPerBash 9000");
await piforge("reset incremental-guard.maxCharsPerBash");
check("reset <ext>.<key> drops just that key", read().limits["incremental-guard"].maxLinesPerWrite === 200 && !("maxCharsPerBash" in read().limits["incremental-guard"]));
await piforge("set incremental-guard.maxCharsPerBash 9000");
await piforge("reset incremental-guard");
check("reset <ext> drops all of its overrides and prunes empty sections", read().limits === undefined && read().disabled.includes("plan-clarify"));
await piforge("set incremental-guard.maxLinesPerWrite 200");
await piforge("reset all");
check("reset all → back to defaults", read().limits === undefined);

// ---- 6. robustness: limits-only file, missing file ----
setConfig({ limits: { "incremental-guard": { maxLinesPerWrite: 200 } } });
await piforge("disable plan-clarify");
check("file with no 'disabled' key: toggling works and keeps limits",
  read().disabled.includes("plan-clarify") && read().limits["incremental-guard"].maxLinesPerWrite === 200);
fs.rmSync(CONFIG);
await piforge("set incremental-guard.maxLinesPerWrite 150");
check("no piforge.json yet → /piforge set creates it", read().limits["incremental-guard"].maxLinesPerWrite === 150);

// ---- 7. update-time migration (migrate-config.mjs) ----
const MIG = path.join(REPO_ROOT, "migrate-config.mjs");
const REPO_GUARD = path.join(REPO_ROOT, "extensions", "incremental-guard.ts");
const TEMPLATE = path.join(REPO_ROOT, "config", "piforge.json");
const INSTALLED = path.join(TMP, "installed-guard.ts");
const migrate = () => execFileSync("node", [MIG, INSTALLED, REPO_GUARD, CONFIG, TEMPLATE], { encoding: "utf-8" });
const customGuard = guardSrc.replace(/const MAX_LINES_PER_WRITE = \d+;/, "const MAX_LINES_PER_WRITE = 250;")
  .replace(/const MAX_CHARS_PER_EDIT\s+= \d+;/, "const MAX_CHARS_PER_EDIT  = 4000;");

fs.rmSync(CONFIG, { force: true });
let msg = migrate();
check("fresh machine (nothing installed) → no-op", msg === "" && !fs.existsSync(CONFIG));

fs.writeFileSync(INSTALLED, guardSrc);
msg = migrate();
check("installed copy at defaults → no-op", msg === "" && !fs.existsSync(CONFIG));

fs.writeFileSync(INSTALLED, customGuard);
msg = migrate();
let c = read();
check("hand-edited installed copy + no piforge.json → values moved into a new piforge.json",
  c.limits["incremental-guard"].maxLinesPerWrite === 250 && c.limits["incremental-guard"].maxCharsPerEdit === 4000 && msg.includes("kept your custom"));
check("…and the new piforge.json starts from the template's disabled list",
  JSON.stringify(c.disabled) === JSON.stringify(JSON.parse(fs.readFileSync(TEMPLATE, "utf-8")).disabled));
check("only the edited limits are written (defaults not pinned)", Object.keys(c.limits["incremental-guard"]).length === 2);

setConfig({ disabled: ["x"], limits: { "incremental-guard": { maxLinesPerWrite: 180 } } });
msg = migrate();
c = read();
check("an explicit piforge.json setting wins over the installed file",
  c.limits["incremental-guard"].maxLinesPerWrite === 180 && c.limits["incremental-guard"].maxCharsPerEdit === 4000 && c.disabled[0] === "x");

fs.writeFileSync(CONFIG, "{ broken");
msg = migrate();
check("broken piforge.json → left untouched, user told what to set by hand",
  fs.readFileSync(CONFIG, "utf-8") === "{ broken" && msg.includes("NOT migrating") && msg.includes("maxLinesPerWrite=250"));

fs.rmSync(INSTALLED);
fs.symlinkSync(REPO_GUARD, INSTALLED);
setConfig({ disabled: [] });
migrate();
check("dev-linked (symlinked) guard → no-op", read().limits === undefined);

fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-piforge-config (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
