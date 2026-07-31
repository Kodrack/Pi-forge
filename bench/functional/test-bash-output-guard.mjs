// FUNCTIONAL test: drives the REAL bash-output-guard against tool results
// shaped like the 2026-07-30 incident.
//
// That case: `grep -ri "ocra" .` in a .NET/Blazor repo → 610 lines / 48 MB.
// ~250 lines were real .razor/.cs matches; 38 MB was six SVGs that are base64
// JPEG payloads on one line (8.8 MB for a 329x159 image). The fixture below
// reproduces that shape at 1/100 scale — same structure, instant to run.
//
// The assertions that matter are the pass-through ones. A result guard that
// rewrites everything would destroy ordinary output, which is far worse than
// the problem it fixes.
//
//   bash bench/run-functional.sh

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piforge-fn-outguard-")));

const SRC = path.join(REPO_ROOT, "extensions", "bash-output-guard.ts");
const stripped = path.join(TMP, "bash-output-guard.ts");
fs.writeFileSync(stripped, fs.readFileSync(SRC, "utf-8").replace(/^import type .*$/m, "// (type-only import stripped)"));
const mod = await import(stripped);

const handlers = {};
const commands = {};
mod.default({
  on: (ev, h) => { handlers[ev] = h; },
  registerCommand: (n, s) => { commands[n] = s; },
  sendMessage: async () => {},
});
const onResult = handlers["tool_result"];

const notices = [];
const ctx = { ui: { notify: (m) => notices.push(String(m)) } };
const run = (toolName, text, input = {}) =>
  onResult({ toolName, input, isError: false, content: [{ type: "text", text }] }, ctx);

const results = [];
const check = (label, ok) => results.push([label, ok]);
const textOf = (r) => r?.content?.[0]?.text ?? "";

// ---------- fixtures ----------
const b64 = (n) => "/9j/4AAQSkZJRgABAQ".repeat(Math.ceil(n / 18)).slice(0, n);
const REAL_MATCHES = Array.from({ length: 40 }, (_, i) =>
  `./Web/platform-web-dashboard-v2/src/HabitusHealthWeb.Blazor/Components/Pages/ManualAssessment/ocra/OcraReport.razor:    <td>@ocraScore.Value</td> line ${i}`,
).join("\n");
const SVG_BOMB = [
  `./Web/habitushealth.web.design/assets/img/quick-tips.svg:<svg width="329" height="159"><image xlink:href="data:image/jpeg;base64,${b64(90000)}"/></svg>`,
  `./Web/habitushealth.web.design/assets/img/db/upload-image.svg:<svg><image xlink:href="data:image/jpeg;base64,${b64(60000)}"/></svg>`,
].join("\n");
const GREP_BOMB = `${REAL_MATCHES}\n${SVG_BOMB}`;

// ---------- pass-through: the common path must be untouched ----------
{
  const r = await run("bash", "ok\n3 files changed\n");
  check("small bash result → untouched (handler returns nothing)", r === undefined);
}
{
  const r = await run("bash", "x".repeat(7999));
  check("just under the threshold → untouched", r === undefined);
}
{
  const r = await run("write", GREP_BOMB, { path: "a.ts" });
  check("non-guarded tool (write) → untouched even when huge", r === undefined);
}
{
  const r = await onResult(
    { toolName: "bash", input: {}, isError: false, content: [{ type: "image", data: "…" }] },
    ctx,
  );
  check("image content → untouched", r === undefined);
}
{
  const r = await onResult({ toolName: "bash", input: {}, isError: false, content: [] }, ctx);
  check("empty content → untouched", r === undefined);
}

// ---------- the incident ----------
{
  const r = await run("bash", GREP_BOMB, { command: 'grep -ri "ocra" .' });
  const out = textOf(r);
  check("48MB-shaped grep result → replaced", !!r && out.length > 0);
  check(`  ...context SHRINKS (${GREP_BOMB.length} → ${out.length} chars)`, out.length < GREP_BOMB.length);
  check("  ...summary respects its own hard cap (2600)", out.length <= 2600);
  check("  ...names the heaviest file (quick-tips.svg)", out.includes("quick-tips.svg"));
  check("  ...warns that the match was inside base64", /base64|binary/i.test(out));
  check("  ...keeps real matches visible in the excerpt", out.includes("OcraReport.razor"));
  check("  ...tells the model not to re-run unchanged", /do NOT re-run/i.test(out));
  check("  ...recommends rg + max-columns", out.includes("rg") && out.includes("max-columns"));
  check("  ...echoes the offending command", out.includes("grep -ri"));
  check("  ...no single line of the summary is a blob", out.split("\n").every((l) => l.length <= 700));
  check("  ...preserves isError", r.isError === false);
}

// ---------- the find/bin-obj case ----------
{
  const findBomb = Array.from({ length: 400 }, (_, i) =>
    `./Services/habitushealth.services.questionnaires/service/bin/Debug/net${i % 2 ? 6 : 8}.0/HabitusHealth.Services.API.ActionCentre.Contracts${i}.dll`,
  ).join("\n");
  const out = textOf(await run("bash", findBomb, { command: 'find . | grep -i "action.*cent"' }));
  check("find-style output → replaced", out.length > 0);
  check("  ...groups by directory (bin/Debug)", out.includes("bin/Debug"));
  check("  ...suggests excluding build output", out.includes("!**/bin/**"));
  check("  ...stays under the cap", out.length <= 2600);
}

// ---------- log path is reused, not duplicated ----------
{
  const withLog = `${GREP_BOMB}\n[Full output: /var/folders/cn/x/T/pi-bash-41b796fc17b3cadc.log]`;
  const out = textOf(await run("bash", withLog, { command: "grep -ri ocra ." }));
  check("existing pi-bash log path is surfaced", out.includes("pi-bash-41b796fc17b3cadc.log"));
}

// ---------- grep/find/ls are guarded too ----------
for (const tool of ["grep", "find", "ls"]) {
  const out = textOf(await run(tool, "y".repeat(20000)));
  check(`${tool} results are guarded`, out.length > 0 && out.length <= 2600);
}

// ---------- live progress heartbeat ----------
// The recorded case: a `find` ran 5+ minutes at ~0% CPU while the TUI showed a
// bare spinner and LM Studio sat idle, so the session looked dead. The heartbeat
// must (a) fire, (b) say the model is not being called, (c) cost zero context.
{
  const SLOW = /const SLOW_COMMAND_SECONDS = (\d+)/.exec(fs.readFileSync(SRC, "utf-8"))[1];
  const BEAT = /const HEARTBEAT_SECONDS = (\d+)/.exec(fs.readFileSync(SRC, "utf-8"))[1];
  const PATH = /const PATHOLOGICAL_SECONDS = (\d+)/.exec(fs.readFileSync(SRC, "utf-8"))[1];
  check(`heartbeat thresholds are sane (${SLOW}s first, every ${BEAT}s, ${PATH}s pathological)`,
    +SLOW > 0 && +BEAT > 0 && +PATH > +SLOW);

  // NOTE ON SCOPE: the timer FIRING is not wall-clock tested — the first beat is
  // at 20s and a bench suite must stay instant. What is tested is the tracking
  // lifecycle (which is where a leak or a stuck entry would come from) and the
  // content of the messages. `/output-guard` reports live entries, so it doubles
  // as the observable for whether tracking started and stopped.
  const liveLine = async () => {
    notices.length = 0;
    await commands["output-guard"].handler("", ctx);
    return notices.join("\n");
  };

  notices.length = 0;
  const cmd = 'find . -type f -exec grep -il "vera" {} +';
  await handlers["tool_execution_start"]({ toolCallId: "t1", toolName: "bash", args: { command: cmd } }, ctx);
  check("starting a bash command emits nothing immediately", notices.length === 0);
  check("...but it IS tracked as running", (await liveLine()).includes("Running now"));

  await handlers["tool_execution_update"]({ toolCallId: "t1", toolName: "bash", partialResult: { output: "a\nb\nc\n" } });
  check("partial output is absorbed without throwing", true === true);

  notices.length = 0;
  await handlers["tool_execution_end"]({ toolCallId: "t1", toolName: "bash", result: {}, isError: false }, ctx);
  check("a fast command produces no 'finished after' noise", !notices.some((n) => /finished after/.test(n)));
  check("tracking is released on end (no leaked entry)", !(await liveLine()).includes("Running now"));
  check("end handler is safe for an unknown id", (await handlers["tool_execution_end"]({ toolCallId: "nope", toolName: "bash" }, ctx)) === undefined);
}
{
  // A non-guarded tool must never be tracked.
  await handlers["tool_execution_start"]({ toolCallId: "t3", toolName: "write", args: {} }, ctx);
  notices.length = 0;
  await commands["output-guard"].handler("", ctx);
  check("non-guarded tool is not tracked", !notices.join("\n").includes("Running now"));
}
{
  const src = fs.readFileSync(SRC, "utf-8");
  const beat = src.slice(src.indexOf("tool_execution_start"), src.indexOf("tool_execution_end"));
  check("heartbeat never calls sendMessage (zero context cost)", !beat.includes("sendMessage"));
  check("heartbeat tells the user the model is NOT being called", src.includes("model is NOT being called"));
  check("heartbeat says Ctrl-C is safe", src.includes("Ctrl-C is safe"));
}

// ---------- command registered ----------
check("/output-guard registered", !!commands["output-guard"]);

// ---------- report ----------
let failed = 0;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
console.log(`test-bash-output-guard (functional): ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
