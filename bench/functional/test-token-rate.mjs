// FUNCTIONAL test: token-counter's tok/s measurement, driving the REAL
// extension with a simulated stream and a temp counter file.
//
// The measurement decision under test: tok/s is the DECODE window (first
// streamed delta → last), not turn wall-clock. A turn includes tool execution,
// and on 2026-07-31 one `find` blocked a turn for five minutes — charging that
// to the model would report ~0.06 tok/s for a model that never ran. Prefill is
// reported separately as ttft.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-tokrate-")));

// Redirect the counter file into TMP: this test must never touch the real
// ~/.pi/token-counter.json, which holds 71M lifetime tokens.
const FAKE_HOME = path.join(TMP, "home");
fs.mkdirSync(path.join(FAKE_HOME, ".pi"), { recursive: true });
const COUNTER = path.join(FAKE_HOME, ".pi", "token-counter.json");

const src = fs.readFileSync(path.join(REPO_ROOT, "extensions", "token-counter.ts"), "utf-8")
  .replace(/^import type .*$/m, "// (type-only import stripped)")
  .replace(/os\.homedir\(\)/g, JSON.stringify(FAKE_HOME));
const stripped = path.join(TMP, "token-counter.ts");
fs.writeFileSync(stripped, src);

const results = [];
const check = (label, ok) => results.push([label, ok]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const mod = await import(`${stripped}?v=${Math.random()}`);
  const h = {};
  const cmds = {};
  const notices = [];
  mod.default({
    on: (ev, fn) => { h[ev] = fn; },
    registerCommand: (n, s) => { cmds[n] = s; },
    sendMessage: async () => {},
  });
  const ctx = { ui: { notify: (m) => notices.push(String(m)) }, getContextUsage: () => ({ tokens: 13300 }) };
  return { h, cmds, notices, ctx };
}

// Simulate a turn: prefill delay, then deltas spread over decodeMs, then tool time.
async function runTurn({ h, ctx }, { text, ttftMs, decodeMs, toolMs = 0, chunks = 6 }) {
  await h["turn_start"]?.({}, ctx);
  await sleep(ttftMs);
  const per = Math.max(1, Math.floor(decodeMs / chunks));
  for (let i = 0; i < chunks; i++) {
    await h["message_update"]({ assistantMessageEvent: { type: "text_delta", content: "x" } }, ctx);
    if (i < chunks - 1) await sleep(per);
  }
  await sleep(toolMs); // tool execution AFTER the stream — must not count
  await h["turn_end"]({ message: { content: [{ type: "text", text }] } }, ctx);
}

// ---- decode window excludes tool time (the whole point) ----
{
  const t = await load();
  // 1200 chars ≈ 300 tokens, decoded over ~600ms, then 1500ms of "tool time".
  await runTurn(t, { text: "y".repeat(1200), ttftMs: 120, decodeMs: 600, toolMs: 1500 });
  const line = t.notices.at(-1);
  const m = /@ ([\d.]+) tok\/s/.exec(line);
  check("turn line reports tok/s", !!m);
  if (m) {
    const tps = parseFloat(m[1]);
    // 300 tokens / 0.6s = ~500 tok/s. If tool time were counted it'd be ~140.
    check(`rate uses decode window, not wall-clock (${tps} tok/s, wall-clock would be ~140)`, tps > 250);
  }
  check("turn line reports ttft", /ttft [\d.]+s/.test(line));
  check("ttft is the prefill, not the whole turn", /ttft 0\.[12]\d?s/.test(line));
  check("original fields are still present", /turn in=13\.3K out=/.test(line) && /all-time saved/.test(line));
}

// ---- tiny turns are excluded as noise ----
// NB: the TURN rate is the `@ N tok/s` field. `| avg N tok/s` is the lifetime
// average and legitimately persists from earlier turns — assert on `@` only.
{
  fs.rmSync(COUNTER, { force: true }); // isolate: no carried-over timing
  const t = await load();
  await runTurn(t, { text: "ok", ttftMs: 50, decodeMs: 20, chunks: 2 });
  const line = t.notices.at(-1);
  check("a 2-char reply reports NO turn rate (noise suppressed)", !/@ [\d.]+ tok\/s/.test(line));
  const d = JSON.parse(fs.readFileSync(COUNTER, "utf8"));
  check("...and does not pollute the timed average", (d.timedOutputTokens ?? 0) === 0);
  check("...and no bogus avg is shown from zero samples", !/avg [\d.]+ tok\/s/.test(line));
}

// ---- thinking tokens count toward the rate ----
{
  const t = await load();
  await t.h["turn_start"]({}, t.ctx);
  await sleep(30);
  await t.h["message_update"]({ assistantMessageEvent: { type: "thinking_delta", content: "x" } }, t.ctx);
  await sleep(500);
  await t.h["message_update"]({ assistantMessageEvent: { type: "thinking_delta", content: "x" } }, t.ctx);
  await t.h["turn_end"]({ message: { content: [{ type: "thinking", thinking: "z".repeat(2000) }] } }, t.ctx);
  check("thinking-only turn still gets a rate", /tok\/s/.test(t.notices.at(-1)));
}

// ---- the all-time average accumulates and persists ----
{
  fs.rmSync(COUNTER, { force: true });
  const a = await load();
  await runTurn(a, { text: "y".repeat(1200), ttftMs: 40, decodeMs: 600 });
  const d1 = JSON.parse(fs.readFileSync(COUNTER, "utf8"));
  check("timedOutputTokens persisted", (d1.timedOutputTokens ?? 0) > 0);
  check("totalDecodeMs persisted", (d1.totalDecodeMs ?? 0) > 0);

  const b = await load(); // fresh instance = new session, reads the file
  await runTurn(b, { text: "y".repeat(1200), ttftMs: 40, decodeMs: 600 });
  const d2 = JSON.parse(fs.readFileSync(COUNTER, "utf8"));
  check("average accumulates across sessions", d2.timedOutputTokens > d1.timedOutputTokens);
  check("turn line shows the all-time average", /\| avg [\d.]+ tok\/s/.test(b.notices.at(-1)));
}

// ---- migration: an old file with no timing fields must not divide by zero ----
{
  fs.writeFileSync(COUNTER, JSON.stringify({
    totalInputTokens: 71500839, totalOutputTokens: 405432,
    totalSessions: 184, lastUpdated: "2026-07-31T11:02:12.954Z",
  }));
  const t = await load();
  await t.h["session_start"]?.({}, t.ctx);
  check("legacy file (no timing fields) loads without error", true);
  await runTurn(t, { text: "y".repeat(1200), ttftMs: 40, decodeMs: 600 });
  const line = t.notices.at(-1);
  check("legacy lifetime tokens do NOT drag the average down",
    !/avg 0\.\d/.test(line) && /avg [\d.]+ tok\/s/.test(line));
  const out = [];
  await t.cmds["tokens"].handler("", { ...t.ctx, ui: { notify: (m) => out.push(String(m)) } });
  check("/tokens shows the timed share so the average is interpretable",
    /% of output/.test(out.join("")));
  check("/tokens states the estimation caveat", /indicative/.test(out.join("")));
}

// ---- a turn with no stream at all must not crash or emit a bogus rate ----
{
  const t = await load();
  await t.h["turn_start"]({}, t.ctx);
  await t.h["turn_end"]({ message: { content: [{ type: "text", text: "y".repeat(1200) }] } }, t.ctx);
  const line = t.notices.at(-1);
  check("turn with zero deltas emits no turn rate", !/@ [\d.]+ tok\/s/.test(line));
  check("turn with zero deltas emits no ttft", !/ttft/.test(line));
  check("...but still emits the normal token/cost line", /turn in=13\.3K out=/.test(line));
}

let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-token-rate (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
