// incremental-guard.ts
// Hard-enforces the "small calls" workflow on local LLMs.
// Rejects oversized `write`, `edit`, and `bash` tool calls, forcing the model
// to replan and split the work into multiple smaller calls. The bash cap closes
// the heredoc side door (cat > file <<EOF with a whole file inline) while
// leaving the chunked-append workflow (small cat >> calls) untouched.
//
// Soft layer (the incremental-codegen skill + AGENTS.md) tells the model HOW
// to split. This extension makes ignoring those rules impossible — when the
// model emits a giant `write` anyway, we block it with a clear error and the
// model has to retry with a smaller call.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as nodePath from "path";

// ---------- LIMITS (tune these as needed) ----------
const MAX_LINES_PER_WRITE = 100;      // skeleton scaffold cap
const MAX_LINES_PER_EDIT  = 60;       // single-feature edit cap
const MAX_CHARS_PER_WRITE = 6000;     // ~1500 tokens for new files
const MAX_CHARS_PER_EDIT  = 3000;     // ~750 tokens — forces small targeted edits
const MAX_LINES_PER_BASH  = 100;      // bash heredoc/append chunk cap (mirrors write)
const MAX_CHARS_PER_BASH  = 6000;     // a >6000-char bash command is always an inline file write

// Files exempt from the cap (config files, lockfiles, etc. that legitimately
// need to be written wholesale). Add more globs here if needed.
const EXEMPT_PATH_PATTERNS = [
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /pnpm-lock\.yaml$/i,
  /\.lock$/i,
  /\.svg$/i,        // SVGs are often a single big blob
];

function isExempt(path?: string): boolean {
  if (!path) return false;
  return EXEMPT_PATH_PATTERNS.some((re) => re.test(path));
}

function lineCount(s?: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

function charCount(s?: string): number {
  return s?.length ?? 0;
}

// When a "recovery" write/edit leaves the file at less than this fraction of
// the blocked attempt's size, steer: the file is probably truncated.
const TRUNCATION_WARN_FRACTION = 0.5;
// Consider the original goal reached at this fraction (stop tracking the path).
const TRUNCATION_DONE_FRACTION = 0.8;

// ---------- EXTENSION ENTRY POINT ----------
export default function (pi: ExtensionAPI) {
  // path → line count of the biggest oversized write we blocked for it.
  const blockedAttemptLines = new Map<string, number>();
  // paths already warned about (one steer per path per session).
  const truncationWarned = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `incremental-guard active (write: ${MAX_LINES_PER_WRITE} lines/${MAX_CHARS_PER_WRITE} chars, edit: ${MAX_LINES_PER_EDIT} lines/${MAX_CHARS_PER_EDIT} chars, bash: ${MAX_LINES_PER_BASH} lines/${MAX_CHARS_PER_BASH} chars)`,
      "info"
    );
  });

  pi.on("tool_call", async (event, _ctx) => {
    // ---------- BASH ----------
    // Block oversized bash commands. A command past these caps is effectively
    // always an inline file write (heredoc / >> redirect) smuggling a whole
    // file around the write/edit caps — proven by benchmark: 150-line heredocs
    // sailed through 5/5 before this branch existed. Small appends stay allowed;
    // the LM Studio system prompt teaches that exact chunked-append workflow.
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      const command = input.command ?? "";
      const lines = lineCount(command);
      const chars = charCount(command);

      if (lines > MAX_LINES_PER_BASH || chars > MAX_CHARS_PER_BASH) {
        return {
          block: true,
          reason:
            `bash rejected: command is ${lines} lines / ${chars} chars ` +
            `(limit ${MAX_LINES_PER_BASH} lines / ${MAX_CHARS_PER_BASH} chars). ` +
            `You are writing a whole file inline — that defeats the incremental workflow. ` +
            `Do NOT retry with the same payload. Instead split the content into MULTIPLE ` +
            `bash calls, each appending one chunk under the limit: ` +
            `cat >> <file> << 'CHUNK' ... CHUNK. ` +
            `One section per call. For new files, prefer the 'write' tool for a small ` +
            `skeleton first, then append/edit in small pieces.`,
        };
      }
    }

    // ---------- WRITE ----------
    // Block any `write` call whose `content` exceeds limits.
    // `write` is for new files only — we let the model use it for skeletons,
    // but never for big initial blobs.
    if (event.toolName === "write") {
      const input = event.input as { path?: string; content?: string; file_path?: string };
      const path = input.path ?? input.file_path;
      const content = input.content ?? "";

      if (isExempt(path)) return; // skip cap for lockfiles etc.

      const lines = lineCount(content);
      const chars = charCount(content);

      if (lines > MAX_LINES_PER_WRITE || chars > MAX_CHARS_PER_WRITE) {
        // Remember the attempted size so we can warn if the "recovery" write
        // leaves the file at a fraction of what the model meant to produce.
        if (path) blockedAttemptLines.set(path, Math.max(lines, blockedAttemptLines.get(path) ?? 0));
        return {
          block: true,
          reason:
            `write rejected: ${lines} lines / ${chars} chars exceeds limit ` +
            `(${MAX_LINES_PER_WRITE} lines / ${MAX_CHARS_PER_WRITE} chars). ` +
            `Your ${lines}-line file is NOT lost — you still know what goes in it. Rebuild it in chunks: ` +
            `(1) list every section of those ${lines} lines as a numbered checklist in .think/_plan.md, ` +
            `(2) 'write' ONLY the first chunk (under ${MAX_LINES_PER_WRITE} lines), ` +
            `(3) append each remaining chunk with a SEPARATE small bash call: cat >> <file> << 'CHUNK' ... CHUNK, ` +
            `(4) check off each chunk in _plan.md as you append it. ` +
            `The file is NOT DONE until every chunk from your checklist is in it — a fragment that ` +
            `references functions you never appended is a broken file, not a finished one. ` +
            `Do NOT retry the full payload in one call, and NEVER dump the remaining code into chat.`,
        };
      }
    }

    // ---------- EDIT ----------
    // Block any `edit` whose new_string exceeds limits, and also any edit
    // that effectively rewrites the file (huge old_string → huge new_string).
    if (event.toolName === "edit") {
      const input = event.input as {
        path?: string;
        file_path?: string;
        old_string?: string;
        new_string?: string;
      };
      const path = input.path ?? input.file_path;
      const oldS = input.old_string ?? "";
      const newS = input.new_string ?? "";

      if (isExempt(path)) return;

      const newLines = lineCount(newS);
      const newChars = charCount(newS);

      if (newLines > MAX_LINES_PER_EDIT || newChars > MAX_CHARS_PER_EDIT) {
        return {
          block: true,
          reason:
            `edit rejected: replacement is ${newLines} lines / ${newChars} chars ` +
            `(limit ${MAX_LINES_PER_EDIT} lines / ${MAX_CHARS_PER_EDIT} chars). ` +
            `Do NOT retry with the same payload. Split this change into multiple ` +
            `smaller 'edit' calls — one feature/section per call. ` +
            `If you're tempted to rewrite a whole file, you're doing it wrong: ` +
            `make a list of the discrete changes, then apply them one at a time.`,
        };
      }

      // Catch the "rewrite the entire file via edit" trick (e.g., old_string
      // is the whole file, new_string is the whole file).
      const oldLines = lineCount(oldS);
      if (oldLines > MAX_LINES_PER_EDIT * 2) {
        return {
          block: true,
          reason:
            `edit rejected: old_string is ${oldLines} lines, which suggests you're ` +
            `replacing a huge region (likely the whole file). ` +
            `Use targeted edits: pick the smallest unique snippet that identifies ` +
            `the section to change, and replace only that. ` +
            `Multiple small edits beat one big one.`,
        };
      }
    }
  });

  // Truncated-recovery watchdog. Benchmark-observed failure: a blocked
  // 206/265-line write gets "recovered" as a 29/53-line fragment (write
  // OVERWRITES), the rest never appended, and the model moves on with a file
  // that references functions that don't exist. When a write/edit to a
  // previously-blocked path executes and the on-disk file is still far smaller
  // than the blocked attempt, steer ONCE: the file is probably incomplete.
  pi.on("tool_result", async (event: any, ctx: any) => {
    const toolName = event.toolName ?? "";
    if (toolName !== "write" && toolName !== "edit" && toolName !== "bash") return;
    if (blockedAttemptLines.size === 0) return;

    const input = (event.input as Record<string, any>) ?? {};
    let filePath: string | undefined = input.path ?? input.file_path;
    if (toolName === "bash") {
      // Follow appends into tracked files (cat >> file << 'EOF').
      const m = String(input.command ?? "").match(/>>?\s*([^\s;|&]+)/);
      filePath = m?.[1];
    }
    if (!filePath || !blockedAttemptLines.has(filePath) || truncationWarned.has(filePath)) return;

    const attempted = blockedAttemptLines.get(filePath)!;
    let actual = 0;
    try {
      const abs = nodePath.isAbsolute(filePath) ? filePath : nodePath.join(ctx.cwd, filePath);
      actual = fs.readFileSync(abs, "utf-8").split(/\r?\n/).length;
    } catch {
      return; // file not readable yet — nothing to judge
    }

    if (actual >= attempted * TRUNCATION_DONE_FRACTION) {
      blockedAttemptLines.delete(filePath); // goal effectively reached
      return;
    }
    if (actual >= attempted * TRUNCATION_WARN_FRACTION) return; // in progress — keep watching

    truncationWarned.add(filePath);
    ctx.ui.notify(
      `incremental-guard: ${filePath} has ${actual} lines but the blocked attempt had ${attempted} — steering (likely truncated)`,
      "warn"
    );
    await pi.sendMessage(
      {
        customType: "incremental_guard_truncation",
        content:
          `[incremental-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
          `${filePath} currently has ${actual} lines, but your blocked write attempted ${attempted} lines — ` +
          `the file is likely INCOMPLETE (missing functions/sections you planned).\n` +
          `1. Read the file and compare it against your plan/checklist in .think/_plan.md.\n` +
          `2. Append every missing section in small chunks: cat >> ${filePath} << 'CHUNK' ... CHUNK (one section per call).\n` +
          `3. Then execute the file to prove it loads (e.g. node ${filePath}).\n` +
          `Do NOT declare the task complete with the file in this state.`,
        display: {
          label: "incremental-guard",
          content: `${filePath}: ${actual}/${attempted} lines after blocked write — truncation warning`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  // Optional: register a /guard command to inspect/disable at runtime.
  pi.registerCommand("guard", {
    description: "Show or toggle incremental-guard limits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `incremental-guard: write ≤ ${MAX_LINES_PER_WRITE} lines/${MAX_CHARS_PER_WRITE} chars, ` +
          `edit ≤ ${MAX_LINES_PER_EDIT} lines/${MAX_CHARS_PER_EDIT} chars, ` +
          `bash ≤ ${MAX_LINES_PER_BASH} lines/${MAX_CHARS_PER_BASH} chars. ` +
          `Edit ~/.pi/agent/extensions/incremental-guard.ts to change.`,
        "info"
      );
    },
  });
}
