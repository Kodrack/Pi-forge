// incremental-guard.ts
// Hard-enforces the "small calls" workflow on local LLMs.
// Rejects oversized `write` and `edit` tool calls, forcing the model to
// replan and split the work into multiple smaller calls.
//
// Soft layer (the incremental-codegen skill + AGENTS.md) tells the model HOW
// to split. This extension makes ignoring those rules impossible — when the
// model emits a giant `write` anyway, we block it with a clear error and the
// model has to retry with a smaller call.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// ---------- LIMITS (tune these as needed) ----------
const MAX_LINES_PER_WRITE = 100;      // skeleton scaffold cap
const MAX_LINES_PER_EDIT  = 60;       // single-feature edit cap
const MAX_CHARS_PER_WRITE = 6000;     // ~1500 tokens for new files
const MAX_CHARS_PER_EDIT  = 3000;     // ~750 tokens — forces small targeted edits

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

// ---------- EXTENSION ENTRY POINT ----------
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `incremental-guard active (write: ${MAX_LINES_PER_WRITE} lines/${MAX_CHARS_PER_WRITE} chars, edit: ${MAX_LINES_PER_EDIT} lines/${MAX_CHARS_PER_EDIT} chars)`,
      "info"
    );
  });

  pi.on("tool_call", async (event, _ctx) => {
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
        return {
          block: true,
          reason:
            `write rejected: ${lines} lines / ${chars} chars exceeds limit ` +
            `(${MAX_LINES_PER_WRITE} lines / ${MAX_CHARS_PER_WRITE} chars). ` +
            `Do NOT retry with the same payload. Instead: ` +
            `(1) write a SHORT plan to _plan.md listing each feature as a numbered TODO, ` +
            `(2) write a SKELETON file with empty <!-- TODO: name --> markers (under ${MAX_LINES_PER_WRITE} lines), ` +
            `(3) implement ONE TODO per turn using the 'edit' tool. ` +
            `Stop after each step and wait for the user.`,
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

  // Optional: register a /guard command to inspect/disable at runtime.
  pi.registerCommand("guard", {
    description: "Show or toggle incremental-guard limits",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `incremental-guard: write ≤ ${MAX_LINES_PER_WRITE} lines/${MAX_CHARS_PER_WRITE} chars, ` +
          `edit ≤ ${MAX_LINES_PER_EDIT} lines/${MAX_CHARS_PER_EDIT} chars. ` +
          `Edit ~/.pi/agent/extensions/incremental-guard.ts to change.`,
        "info"
      );
    },
  });
}
