// FUNCTIONAL test: drives the REAL context-monitor code with a fake
// ExtensionAPI, focused on the post-compaction AUTO-CONTINUE behavior.
//
// Pi's compact() aborts the agent loop, so the AGENTS.md reinjection must be
// sent with triggerTurn: true or the session stalls until the user types.
// The test asserts: triggerTurn fires on a normal compaction, is withheld when
// .think/_state.md says Status: complete, stops after MAX_AUTO_CONTINUES
// consecutive auto-turns, and the budget resets on real user input only.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-cm-"));
const PROJ = path.join(TMP, "proj");
fs.mkdirSync(path.join(PROJ, ".think"), { recursive: true });
process.chdir(PROJ); // stateSaysComplete() and readProjectAgentsMd() read from cwd

const SRC = path.join(REPO_ROOT, "extensions", "context-monitor.ts");
const stripped = path.join(TMP, "context-monitor.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

const src = fs.readFileSync(SRC, "utf-8");
const MAX = Number(src.match(/const\s+MAX_AUTO_CONTINUES\s*=\s*([0-9]+)/)[1]);

function harness() {
  const handlers = {}, notices = [], sent = [];
  mod.default({
    on: (ev, h) => { handlers[ev] = h; },
    registerCommand: () => {},
    sendMessage: async (m, opts) => sent.push({ message: m, opts: opts ?? {} }),
  });
  const ctx = { ui: { notify: (m) => notices.push(m) }, getContextUsage: () => undefined };
  return { handlers, ctx, notices, sent };
}

const results = [];
const check = (label, ok) => results.push([label, ok]);
const setState = (s) => fs.writeFileSync(path.join(PROJ, ".think", "_state.md"), s);
const last = (h) => h.sent[h.sent.length - 1];

// ---- normal compaction mid-task → reinjection auto-triggers a turn ----
{
  setState("## Status: in-progress\nworking");
  const h = harness();
  await h.handlers.session_compact({}, h.ctx);
  check("compaction mid-task → one reinjection sent", h.sent.length === 1);
  check("reinjection is delivered as steer", last(h).opts.deliverAs === "steer");
  check("reinjection auto-triggers a turn (triggerTurn: true)", last(h).opts.triggerTurn === true);
  check("reinjection still tells the model to read _state.md and continue",
    last(h).message.content.includes("read .think/_state.md and continue"));
}

// ---- Status: complete → message sent, but NO auto-turn ----
{
  setState("## Status: complete\ndone");
  const h = harness();
  await h.handlers.session_compact({}, h.ctx);
  check("Status: complete → reinjection still sent", h.sent.length === 1);
  check("Status: complete → triggerTurn withheld", last(h).opts.triggerTurn === false);
}

// ---- other completion words acceptance-guard recognizes also stop it ----
{
  setState("## Status: DONE\nfinished up");
  const h = harness();
  await h.handlers.session_compact({}, h.ctx);
  check("Status: done (case-insensitive) → triggerTurn withheld", last(h).opts.triggerTurn === false);
}

// ---- the cap: MAX auto-continues, then it hands back to the user ----
{
  setState("## Status: in-progress\nworking");
  const h = harness();
  for (let i = 0; i < MAX + 2; i++) await h.handlers.session_compact({}, h.ctx);
  const triggered = h.sent.filter((s) => s.opts.triggerTurn === true).length;
  check(`cap: exactly ${MAX} auto-continues out of ${MAX + 2} compactions`, triggered === MAX);
  check("capped compactions still send the reinjection", h.sent.length === MAX + 2);
}

// ---- real user input resets the budget; extension input does not ----
{
  setState("## Status: in-progress\nworking");
  const h = harness();
  for (let i = 0; i < MAX; i++) await h.handlers.session_compact({}, h.ctx);
  await h.handlers.session_compact({}, h.ctx);
  check("budget spent → triggerTurn withheld", last(h).opts.triggerTurn === false);

  await h.handlers.input({ source: "extension", text: "injected" }, h.ctx);
  await h.handlers.session_compact({}, h.ctx);
  check("extension input does NOT reset the budget", last(h).opts.triggerTurn === false);

  await h.handlers.input({ source: "interactive", text: "continue" }, h.ctx);
  await h.handlers.session_compact({}, h.ctx);
  check("interactive input resets the budget → auto-continue resumes", last(h).opts.triggerTurn === true);
}

// ---- read-only Dory stage: no reinjection at all ----
// Only asserted when the source carries the Dory stand-down wiring (it may
// land in a separate commit from the auto-continue fix).
if (/doryReadonlyStage/.test(src)) {
  setState("## Status: in-progress\nworking");
  process.env.DORY_STAGE = "chat";
  const h = harness();
  await h.handlers.session_compact({}, h.ctx);
  check("dory read-only stage → no reinjection, no auto-turn", h.sent.length === 0);
  delete process.env.DORY_STAGE;
}

process.chdir(os.tmpdir()); // release PROJ so the cleanup below can delete it
fs.rmSync(TMP, { recursive: true, force: true });

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-context-monitor (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
