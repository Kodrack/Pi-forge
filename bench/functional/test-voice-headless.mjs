// FUNCTIONAL test: voice-input must stay out of screenless `pi -p` jobs.
//
// Origin: 2026-11-04, Dory's ingest job crashed with "This extension ctx is
// stale after session replacement or reload" thrown from voice-input's
// background setup (status() → ctx.ui), which outlived the `pi -p` session that
// started it. An uncaught throw there kills the whole pi process — any
// background job (Dory jobs, research sub-Pis) and a /dory session could hit it.
//
// Loads the REAL extension against a mock Pi. Does NOT run the real setup
// (that would create a venv and download models).
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC_PATH = path.join(REPO, "extensions", "voice-input.ts");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-voicehl-")));
process.env.HOME = TMP; // isolate ~/.pi/piforge.json etc.

const src = fs.readFileSync(SRC_PATH, "utf-8");
const stripped = path.join(TMP, "voice-input.ts");
fs.writeFileSync(stripped, src
  .replace(/^import type .*$/gm, "// (type import stripped)")
  .replace(/^import \{ CustomEditor[^}]*\} from "@mariozechner\/pi-coding-agent";$/m, "class CustomEditor { handleInput() {} }"));
const mod = await import(stripped);

const checks = [];
const check = (label, ok) => checks.push([label, !!ok]);

// ---- 1. no screen → the extension does nothing at all ----
{
  const handlers = {};
  mod.default({ on: (ev, fn) => { handlers[ev] = fn; }, registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {}, getFlag: () => undefined, sendUserMessage: () => {} });
  let uiTouched = 0;
  // A stale/absent UI: any access throws, exactly like Pi's stale ctx.
  const ctx = { hasUI: false, get ui() { uiTouched++; throw new Error("This extension ctx is stale"); } };
  let threw = null;
  try { await handlers.session_start?.({}, ctx); } catch (e) { threw = e; }
  await new Promise((r) => setTimeout(r, 50)); // let any fire-and-forget work run
  check("no-screen session (pi -p): session_start doesn't throw", threw === null);
  check("no-screen session: the UI is never touched (no editor hook, no setup, no status)", uiTouched === 0);
}

// ---- 2. source: every UI call in the background setup is guarded ----
{
  const i = src.indexOf("async function doSetup(");
  const j = src.indexOf("// Same as transcribe()", i);
  const setup = src.slice(i, j);
  const raw = (setup.match(/ctx\.ui\./g) ?? []).length;
  const guarded = (setup.match(/safeUi\(\(\) => ctx\.ui\./g) ?? []).length;
  check(`background setup: all ${raw} ctx.ui calls go through safeUi()`, raw > 0 && raw === guarded);
  check("status() (the footer, called from background setup) is guarded", /function status\([\s\S]*?safeUi\(\(\) => ctx\.ui\.setStatus/.test(src));
  check("session_start bails out without a screen", /session_start[\s\S]{0,400}if \(!ctx\.hasUI\) return;/.test(src));
}

fs.rmSync(TMP, { recursive: true, force: true });
let failed = 0;
for (const [label, ok] of checks) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; }
console.log(`test-voice-headless (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
