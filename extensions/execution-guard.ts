// execution-guard.ts
// Hard-blocks "declaring done on code that was never run".
//
// Observed in the 2026-07-23 hard benchmark: two sessions wrote a source file,
// never executed ANYTHING (zero bash runs), and marked the task complete — one
// shipped a file that crashes on load. This guard makes that impossible: when
// the model writes a completion-flavored Status into .think/_state.md while a
// code file has been modified and nothing was executed afterwards, the write is
// BLOCKED with instructions to run the code first.
//
// Scoping (deliberate, to avoid false positives):
//   - Arms ONLY when a code-like file (CODE_EXTENSIONS) was written/edited,
//     including bash redirects/appends into code files (the sanctioned
//     chunked-append recovery path). Doc/config-only sessions never arm.
//   - ANY execution-ish bash call (node/python/npm test/…) after the last code
//     modification releases the latch — no specific test command demanded.
//   - Gives up after MAX_BLOCKS_PER_SESSION blocks so a weird edge case can
//     never loop forever.
//
// OFF BY DEFAULT — intended for unattended runs (pi -p, /q queues, overnight).
// Enable with: /piforge enable execution-guard
//
// Install: copy to ~/.pi/agent/extensions/execution-guard.ts
// Toggle:  /piforge enable execution-guard | /piforge disable execution-guard

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// Stop insisting after this many blocks — safety valve against block loops.
const MAX_BLOCKS_PER_SESSION = 2;

// File extensions that count as "code that can be executed/tested".
const CODE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt)$/i;

// Bash commands that count as EXECUTING something (releases the latch).
const EXEC_COMMAND = /(^|[;&|]\s*)(node|python3?|npm|npx|pnpm|yarn|bun|deno|pytest|go\s+(run|test)|cargo\s+(run|test)|ruby|php|bash\s+\S|sh\s+\S|make|\.\/\S)/;

// Completion-flavored Status lines in _state.md content (mirrors completion-guard).
const COMPLETE_STATUS = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("execution-guard");
  } catch {
    return true;
  }
}

function isStatePath(filePath: string): boolean {
  return /\.think[\/\\]_state\.md$/.test(filePath);
}

function isCodePath(filePath: string): boolean {
  return CODE_EXTENSIONS.test(filePath) && !filePath.includes(".think/") && !filePath.includes(".think\\");
}

// A bash command that REDIRECTS into a code file is a modification, not an
// execution (cat >> app.js << 'EOF' is the chunked-append recovery workflow).
function bashWritesCode(command: string): boolean {
  const m = command.match(/>>?\s*([^\s;|&]+)/);
  return !!m && isCodePath(m[1]);
}

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  // Monotonic per-session sequence numbers: what happened last, a code
  // modification or an execution?
  let seq = 0;
  let lastCodeModSeq = 0;   // 0 = nothing modified yet (guard not armed)
  let lastExecSeq = 0;
  let blocksThisSession = 0;

  pi.on("session_start", async (_event: any, ctx: any) => {
    ctx.ui.notify(
      `execution-guard active — blocks "Status: complete" while modified code was never executed`,
      "info"
    );
  });

  // Track only calls that actually EXECUTED (blocked calls never get a result).
  pi.on("tool_result", async (event: any, _ctx: any) => {
    const toolName = event.toolName ?? "";
    const input = (event.input as Record<string, any>) ?? {};
    seq++;

    if (toolName === "write" || toolName === "edit") {
      const filePath = input.path ?? input.file_path ?? "";
      if (isCodePath(filePath)) lastCodeModSeq = seq;
      return;
    }

    if (toolName === "bash") {
      const command = String(input.command ?? "");
      if (bashWritesCode(command)) {
        lastCodeModSeq = seq;
      } else if (EXEC_COMMAND.test(command)) {
        lastExecSeq = seq;
      }
    }
  });

  pi.on("tool_call", async (event: any, _ctx: any) => {
    const toolName = event.toolName ?? "";

    // Bash appends into code files also arm at call time (same parallel-call
    // ordering reasoning as below).
    if (toolName === "bash") {
      const command = String((event.input as any)?.command ?? "");
      if (bashWritesCode(command)) {
        seq++;
        lastCodeModSeq = seq;
      }
      return;
    }

    if (toolName !== "write" && toolName !== "edit") return;

    const input = (event.input as Record<string, any>) ?? {};
    const filePath = input.path ?? input.file_path ?? "";

    // Arm at CALL time too: with parallel tool calls in one turn, the
    // completion write's tool_call can arrive before the code write's
    // tool_result — waiting for results leaves the latch unarmed exactly when
    // it matters (found by live probe 2026-07-23). Executions still count only
    // at tool_result (they must have actually run).
    if (isCodePath(filePath)) {
      seq++;
      lastCodeModSeq = seq;
      return;
    }

    if (!isStatePath(filePath)) return;

    // Only care about content that declares completion.
    const newContent = String(input.content ?? input.new_string ?? "");
    if (!COMPLETE_STATUS.test(newContent)) return;

    // Not armed (no code modified), already released (executed after last
    // modification), or gave up — allow.
    if (lastCodeModSeq === 0) return;
    if (lastExecSeq > lastCodeModSeq) return;
    if (blocksThisSession >= MAX_BLOCKS_PER_SESSION) return;

    blocksThisSession++;
    return {
      block: true,
      reason:
        `BLOCKED: you are declaring the task complete, but you modified code and have NOT executed anything since. ` +
        `Untested code is not complete. Do NOT retry this write yet. Instead: ` +
        `(1) run the code you changed with the bash tool (e.g. node <file> with a real input, or the project's test command), ` +
        `(2) READ the output — if it errors or looks wrong, fix that first, ` +
        `(3) THEN write _state.md with Status: complete, mentioning what you ran and what it printed.`,
    };
  });

  pi.registerCommand("execution-guard", {
    description: "Show execution-guard status",
    handler: async (_args: any, ctx: any) => {
      const armed = lastCodeModSeq > 0;
      const released = lastExecSeq > lastCodeModSeq;
      ctx.ui.notify(
        `execution-guard: ${armed ? (released ? "armed, released (code executed after last modification)" : "armed — completion will be blocked until something is executed") : "not armed (no code modified this session)"} | ` +
          `blocks used: ${blocksThisSession}/${MAX_BLOCKS_PER_SESSION}`,
        "info"
      );
    },
  });
}
