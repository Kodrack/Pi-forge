// bash-output-guard.ts
// Makes a shell command's cost visible and bounded — while it runs, and after.
//
//   1. LIVE PROGRESS — a heartbeat for commands that run long, so a blocked
//      session is distinguishable from a dead one. To the user only.
//   2. RESULT CAPPING — replaces an oversized result with a summary naming the
//      files that caused it, before it reaches the model.
//
// Part 2 is the original purpose and the rest of this header describes it.
//
// Every other guard here polices what goes INTO a tool — incremental-guard caps
// the command at 100 lines/6000 chars so a heredoc can't smuggle a file write.
// Nothing polices what comes BACK. Pi truncates a bash result at 50KB and that
// is the entire defence. 50KB is ~12k tokens: a quarter of a 50k window, spent
// in one call, on content nobody chose.
//
// The recorded case (2026-07-30): `grep -ri "ocra" .` in a .NET/Blazor repo
// returned 610 lines / 48 MB in 19s. The real matches were ~250 lines of
// .razor and .cs. The other 38 MB came from six SVGs that are base64 JPEG
// payloads on a single line — an 8.8 MB "line" for a 329x159 image. "ocra"
// occurs inside base64 by chance (its alphabet is A-Za-z0-9+/, and -i accepts
// 16 case spellings), and grep prints the WHOLE matching line. The model would
// then have spent its next turn reading base64.
//
// HOW THIS AVOIDS BECOMING THE PROBLEM IT SOLVES:
//   - Under MAX_RESULT_CHARS the result is passed through UNTOUCHED. Not
//     inspected-and-reattached: untouched. A normal session never pays anything.
//   - Over it, the result is REPLACED, not annotated. Context strictly shrinks
//     — 50KB becomes ~2KB. This extension can only ever reduce the token count.
//   - Our own replacement is hard-capped at MAX_SUMMARY_CHARS and asserted
//     against that cap before being returned.
//
// Nothing is lost: the full output already exists on disk (Pi writes it and
// names the path in the result; we reuse that path rather than duplicating it),
// and the summary says which files produced the bulk, so the next command can
// be aimed instead of re-run blind.
//
// Uses `pi.on("tool_result")` returning `{ content }` — Pi's documented result
// replacement. This is the only extension here that rewrites a result; the rest
// block a call or inject a steer.
//
// Install: copy to ~/.pi/agent/extensions/bash-output-guard.ts
// Toggle:  /piforge disable bash-output-guard

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// Pass-through threshold. Sized for a 50k-context model: ~2k tokens is a large
// but survivable tool result. Below this, nothing happens at all.
const MAX_RESULT_CHARS = 8000;

// A single line longer than this is a data blob, not a line of output —
// minified JS, a base64 payload, a packed JSON manifest.
const MAX_LINE_CHARS = 400;

// How much real output survives into the summary.
const HEAD_LINES = 12;
const TAIL_LINES = 8;

// Hard ceiling on what THIS extension emits. Enforced, not aspirational.
const MAX_SUMMARY_CHARS = 2600;

// Tools whose output is an unbounded list and can therefore detonate. `read` is
// deliberately absent: reading a big file is an explicit choice, and Pi bounds
// it already.
const GUARDED_TOOLS = ["bash", "grep", "find", "ls"];

// ---------- LIVE PROGRESS ----------
// Pi waits SYNCHRONOUSLY for a bash child. While it waits, the TUI shows a bare
// "Working..." spinner and the model is not called at all — so LM Studio sits
// idle and the session looks dead. Recorded 2026-07-31: a
// `find . -type f -exec grep -il "vera" {} +` walked a Python .venv for 5+
// minutes at ~0% CPU (I/O bound). Everything looked frozen; nothing was.
//
// These heartbeats go to ctx.ui.notify ONLY — the user, never the model. They
// cost exactly zero context tokens. Telling the model "your command is slow"
// would be both useless (it cannot intervene; it is blocked) and harmful (it is
// permanent context). The person watching is the one who can hit Ctrl-C.
const SLOW_COMMAND_SECONDS = 20;
const HEARTBEAT_SECONDS = 30;

// Past this, the command is not slow, it is wrong — say so.
const PATHOLOGICAL_SECONDS = 120;

// Directory names that mean "you are scanning dependencies, not your code".
const JUNK_DIRS = [".venv", "site-packages", "node_modules", "/obj/", "/bin/Debug", "/bin/Release", ".git/objects", "dist-info"];

// ---------- HELPERS ----------
function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("bash-output-guard");
  } catch {
    return true;
  }
}

function fmtBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// NOTHING below is allowed to see a full line. Every analysis step works on a
// clipped `head` plus the original `len`, so cost is O(lines x ANALYZE_LINE_CAP)
// no matter how big the input is.
//
// This is not a micro-optimization, it is the difference between working and
// hanging. The first version ran `text.match(/(\/[^\s"']*pi-bash-[a-f0-9]+\.log)/)`
// over the whole result. On the real 48 MB log that never returned: `[^\s"']*`
// greedily eats an 8.8 MB base64 run (base64 contains no spaces or quotes), then
// backtracks one character at a time looking for `pi-bash-` — and `/` is IN the
// base64 alphabet, so there are millions of starting positions. An extension
// that hangs on exactly the input it exists to handle is worse than no
// extension, so every string operation here is now bounded by construction.
const ANALYZE_LINE_CAP = 2000;

type Line = { head: string; len: number };

function toLines(text: string): Line[] {
  return text.split("\n").map((raw) => ({
    head: raw.length > ANALYZE_LINE_CAP ? raw.slice(0, ANALYZE_LINE_CAP) : raw,
    len: raw.length,
  }));
}

function clip(l: Line): string {
  if (l.len <= MAX_LINE_CHARS) return l.head;
  return `${l.head.slice(0, MAX_LINE_CHARS)} …[+${fmtBytes(l.len - MAX_LINE_CHARS)} more on this line]`;
}

// Pi already spills the full output to a temp log and names it in the result.
// Reuse that path — writing our own copy would duplicate 48 MB to disk.
// Searched only in the tail (Pi appends it last) with a BOUNDED quantifier;
// see the note above for why an unbounded one is not an option here.
function existingLogPath(text: string): string | null {
  const tail = text.length > 4000 ? text.slice(-4000) : text;
  const m = tail.match(/(\/[^\s"']{0,300}pi-bash-[a-f0-9]+\.log)/);
  return m ? m[1] : null;
}

// Base64 payloads are the classic cause: a huge line drawn from [A-Za-z0-9+/=].
function looksBase64(l: Line): boolean {
  if (l.len < 512) return false;
  const sample = l.head;
  if (sample.length === 0) return false;
  let n = 0;
  for (const ch of sample) {
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "+" || ch === "/" || ch === "=") n++;
  }
  return n / sample.length > 0.95;
}

// `grep -r` prefixes every line with `path:`. Attributing BYTES (not line count)
// to each path is what turns "48 MB of noise" into "these six SVGs".
function heavyPaths(lines: Line[]): Array<{ file: string; bytes: number }> {
  const bytes = new Map<string, number>();
  for (const l of lines) {
    // A path prefix: up to the first colon, if it looks like a path and not
    // like prose that happens to contain one.
    const idx = l.head.indexOf(":");
    if (idx <= 0 || idx > 200) continue;
    const file = l.head.slice(0, idx);
    if (!/[\/\\]/.test(file) || /\s{2,}/.test(file)) continue;
    bytes.set(file, (bytes.get(file) ?? 0) + l.len); // l.len: the TRUE weight
  }
  return [...bytes.entries()]
    .map(([file, b]) => ({ file, bytes: b }))
    .sort((a, b) => b.bytes - a.bytes);
}

// For `find`-style output (no colons): which directory is generating the volume.
// Catches bin/obj/node_modules sprawl, where one DLL appears once per target
// framework per configuration.
function heavyDirs(lines: Line[]): Array<{ dir: string; count: number }> {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const t = l.head.trim();
    const cut = t.lastIndexOf("/");
    if (cut <= 0) continue;
    const dir = t.slice(0, cut);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count);
}

// A 130-char .NET path spends the whole budget saying "Services/…/service".
// The tail is the informative end, so keep that.
function shortPath(p: string, max = 72): string {
  return p.length <= max ? p : `…${p.slice(-(max - 1))}`;
}

// ---------- THE SUMMARY ----------
// Built in PRIORITY ORDER, not in reading order. The diagnosis and the recovery
// instructions are what make the next command better, so they claim the budget
// FIRST; the raw excerpt gets whatever is left and shrinks line by line to fit.
// Doing it the other way round — which this originally did — let a long excerpt
// push the instructions off the end, so the model got a wall of truncated
// output and no idea what to do about it. bench caught that.
function summarize(text: string, toolName: string, command: string): string {
  const lines = toLines(text);
  const longest = lines.reduce((m, l) => Math.max(m, l.len), 0);
  const blobLines = lines.filter(looksBase64).length;

  // ---- fixed section: always present ----
  const fixed: string[] = [];
  fixed.push(
    `[bash-output-guard] This ${toolName} result was ${fmtBytes(text.length)} across ${lines.length} lines — ` +
    `too large to put in context, so it was replaced by this summary. The output itself was NOT lost.`,
  );

  // WHY it was big. This is what lets the next command be aimed.
  //
  // Bytes decide, not line counts: context cost is bytes, and the pathological
  // case is a handful of lines carrying megabytes. Grouping the real incident by
  // directory line-count ranked the six multi-MB SVGs BELOW a folder with 182
  // ordinary matches, i.e. it hid the actual culprit. Files win whenever the top
  // few carry a real share of the weight; directory counts are the fallback for
  // output that is uniformly sized (find/ls), where no single file stands out.
  const byFile = heavyPaths(lines);
  const topFileBytes = byFile.slice(0, 5).reduce((s, f) => s + f.bytes, 0);
  if (byFile.length > 0 && topFileBytes > text.length * 0.4) {
    const top = byFile.slice(0, 5);
    fixed.push(
      `\nMost of the volume came from these files:\n` +
      top.map((f) => `  ${fmtBytes(f.bytes).padStart(9)}  ${shortPath(f.file)}`).join("\n") +
      (byFile.length > top.length ? `\n  …and ${byFile.length - top.length} more` : ""),
    );
  } else {
    const byDir = heavyDirs(lines);
    if (byDir.length > 0 && byDir[0].count > 3) {
      const top = byDir.slice(0, 5);
      fixed.push(
        `\nMost of the lines came from these directories:\n` +
        top.map((d) => `  ${String(d.count).padStart(5)} lines  ${shortPath(d.dir)}`).join("\n") +
        (byDir.length > top.length ? `\n  …and ${byDir.length - top.length} more` : ""),
      );
    }
  }

  if (blobLines > 0 || longest > MAX_LINE_CHARS * 10) {
    fixed.push(
      `\nWARNING: ${blobLines > 0 ? `${blobLines} line(s) are base64/binary data` : `the longest line is ${fmtBytes(longest)}`}. ` +
      `You matched inside encoded data, not source. Re-run excluding it — do NOT try to read it.`,
    );
  }

  const log = existingLogPath(text);
  if (log) fixed.push(`\nFull output on disk: ${log}`);

  fixed.push(
    `\nWHAT TO DO NEXT: do NOT re-run this command unchanged — it will be summarized again. ` +
    `Narrow it first: use \`rg\` instead of \`grep -r\` (skips binary files, honours .gitignore), ` +
    `add \`--max-columns=200\` so a data blob cannot print megabytes, exclude build output ` +
    `(\`-g '!**/bin/**' -g '!**/obj/**' -g '!**/node_modules/**'\`), and \`| head -50\` when a sample will do.` +
    (command ? `\nThe command was: ${command.slice(0, 160)}` : ""),
  );

  const fixedText = fixed.join("\n");

  // ---- variable section: the excerpt, fitted to whatever budget remains ----
  const budget = MAX_SUMMARY_CHARS - fixedText.length - 40;
  if (budget < 120) {
    // Diagnosis alone already fills the cap — that is the correct trade.
    return fixedText.length > MAX_SUMMARY_CHARS
      ? `${fixedText.slice(0, MAX_SUMMARY_CHARS - 40)}\n…[diagnosis truncated]`
      : fixedText;
  }

  const excerpt: string[] = [];
  let used = 0;
  const take = (label: string, src: Line[]) => {
    const kept: string[] = [];
    for (const raw of src) {
      const line = clip(raw);
      if (used + line.length + 1 > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length) excerpt.push(`\n${label} (${kept.length} of ${lines.length} lines):\n${kept.join("\n")}`);
  };

  take("First lines", lines.slice(0, HEAD_LINES));
  if (lines.length > HEAD_LINES + TAIL_LINES) take("Last lines", lines.slice(-TAIL_LINES));

  return `${fixedText}${excerpt.join("\n")}`;
}

// ---------- EXTENSION ----------
export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  let trimmed = 0;
  let bytesSaved = 0;

  // Live progress state, keyed by toolCallId (tool calls can run in parallel).
  type Running = { started: number; command: string; timer: any; bytes: number; lines: number; beats: number };
  const running = new Map<string, Running>();

  function fmtElapsed(ms: number): string {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }

  function stopTracking(id: string): Running | undefined {
    const r = running.get(id);
    if (r?.timer) clearInterval(r.timer);
    running.delete(id);
    return r;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `bash-output-guard active (results over ${MAX_RESULT_CHARS} chars summarized; commands over ${SLOW_COMMAND_SECONDS}s report progress)`,
      "info",
    );
  });

  // ---------- live progress: the user can see a slow command is alive ----------
  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "");
    if (!GUARDED_TOOLS.includes(toolName)) return;

    const id = String(event?.toolCallId ?? "");
    if (!id || running.has(id)) return;

    const command = String(event?.args?.command ?? event?.args?.pattern ?? toolName);
    const state: Running = { started: Date.now(), command, timer: null, bytes: 0, lines: 0, beats: 0 };

    state.timer = setInterval(() => {
      const el = Date.now() - state.started;
      if (el < SLOW_COMMAND_SECONDS * 1000) return;
      state.beats++;

      const seen = state.bytes > 0 ? ` · ${state.lines} lines / ${fmtBytes(state.bytes)} so far` : " · no output yet";
      ctx.ui.notify(
        `${toolName} still running (${fmtElapsed(el)})${seen} · ${state.command.slice(0, 110)}`,
        el >= PATHOLOGICAL_SECONDS * 1000 ? "warning" : "info",
      );

      // Once, when it crosses into "this is wrong, not slow".
      if (el >= PATHOLOGICAL_SECONDS * 1000 && state.beats === Math.ceil(PATHOLOGICAL_SECONDS / HEARTBEAT_SECONDS)) {
        const junk = JUNK_DIRS.filter((d) => state.command.includes(d));
        ctx.ui.notify(
          `  ↳ over ${PATHOLOGICAL_SECONDS}s. Pi blocks on the shell while this runs — the model is NOT being called, ` +
          `which is why nothing is generating. Ctrl-C is safe. ` +
          (junk.length === 0
            ? `The command excludes none of ${JUNK_DIRS.slice(0, 4).join(", ")} — a dependency tree is the usual cause.`
            : `It already excludes ${junk.join(", ")}; something else is deep.`),
          "warning",
        );
      }
    }, HEARTBEAT_SECONDS * 1000);

    running.set(id, state);
  });

  pi.on("tool_execution_update", async (event: any) => {
    const state = running.get(String(event?.toolCallId ?? ""));
    if (!state) return;
    // partialResult shape varies by tool; measure whatever text is in it.
    const p = event?.partialResult;
    const text = typeof p === "string" ? p : String(p?.output ?? p?.stdout ?? p?.text ?? "");
    if (text.length > state.bytes) {
      state.bytes = text.length;
      state.lines = text.length === 0 ? 0 : text.split("\n").length;
    }
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    const id = String(event?.toolCallId ?? "");
    const state = stopTracking(id);
    if (!state) return;
    const el = Date.now() - state.started;
    if (el >= SLOW_COMMAND_SECONDS * 1000) {
      ctx.ui.notify(`${event?.toolName ?? "bash"} finished after ${fmtElapsed(el)}`, "info");
    }
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "");
    if (!GUARDED_TOOLS.includes(toolName)) return;

    const content = event?.content;
    if (!Array.isArray(content) || content.length === 0) return;

    // Only text parts are ours to shrink; an image result is intentional.
    if (content.some((c: any) => c?.type && c.type !== "text")) return;

    const text = content.map((c: any) => String(c?.text ?? "")).join("");
    if (text.length <= MAX_RESULT_CHARS) return; // ← the common path: untouched

    const command = String((event?.input as any)?.command ?? (event?.input as any)?.pattern ?? "");
    const summary = summarize(text, toolName, command);

    trimmed++;
    bytesSaved += text.length - summary.length;
    ctx.ui.notify(
      `bash-output-guard: ${toolName} returned ${fmtBytes(text.length)} — replaced with a ${fmtBytes(summary.length)} summary`,
      "warning",
    );

    return {
      content: [{ type: "text", text: summary }],
      isError: event?.isError ?? false,
    };
  });

  pi.registerCommand("output-guard", {
    description: "Show bash-output-guard limits and what it has trimmed this session",
    handler: async (_args: any, ctx: any) => {
      ctx.ui.notify(
        `bash-output-guard: ${trimmed} result(s) summarized this session, ${fmtBytes(bytesSaved)} kept out of context.\n` +
        `Threshold ${MAX_RESULT_CHARS} chars; guards ${GUARDED_TOOLS.join(", ")}; summary capped at ${MAX_SUMMARY_CHARS} chars.\n` +
        `Progress heartbeat after ${SLOW_COMMAND_SECONDS}s, then every ${HEARTBEAT_SECONDS}s (user-facing only, 0 context cost).\n` +
        (running.size > 0
          ? `Running now: ${[...running.values()].map((r) => `${fmtElapsed(Date.now() - r.started)} ${r.command.slice(0, 60)}`).join("; ")}\n`
          : "") +
        `Edit ~/.pi/agent/extensions/bash-output-guard.ts to change limits, then /reload.`,
        "info",
      );
    },
  });
}
