// acceptance-guard.ts
// Makes "done" a HARNESS verdict instead of a model opinion.
//
// The problem this fixes: PiForge's completion signal is the model writing
// "## Status: complete" into .think/_state.md. Nothing checks whether the code
// works. completion-guard TRUSTS that line (it only enforces stopping after
// it), and execution-guard — the strictest existing check — only verifies that
// SOME process was spawned since the last code change: its EXEC_COMMAND regex
// is satisfied by `node --version`. Exit codes and output are never inspected.
// So the strongest guarantee available today is "the model ran something."
//
// This guard adds the missing oracle. The model must supply
// .think/_acceptance.sh — a command that exits 0 only if the task is genuinely
// done. When the model then declares completion, THIS EXTENSION RUNS IT and the
// exit code decides. Nonzero → the completion write is blocked and the real
// failure output is fed back. The model does not get a vote.
//
// Why an oracle the model wrote itself still helps: it's authored BEFORE the
// model is invested in an approach, when it has no sunk cost and states the
// requirement plainly. By the end of a task it is motivated to declare victory,
// which is exactly why end-of-task self-assessment cannot work. The
// must-fail-first check below is what keeps a self-authored test honest.
//
// Scoping (mirrors execution-guard, deliberately, to avoid false positives):
//   - Arms ONLY when a code-like file (CODE_EXTENSIONS) is written/edited.
//     Doc-only, research, and read-only sessions never arm and never see a gate.
//   - Gives up after MAX_BLOCKS_PER_SESSION and hands control to the human
//     rather than looping — a model that cannot make the test pass must not be
//     trapped against it forever.
// Supersedes execution-guard — "the test passes" is strictly stronger than
// "something ran". Leave execution-guard disabled when this is on.
//
// Install: copy to ~/.pi/agent/extensions/acceptance-guard.ts
// Toggle:  /piforge enable acceptance-guard | /piforge disable acceptance-guard

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "piforge.json");

// ---------- TUNABLES ----------
// The oracle. Relative to the project root; .think/ is a per-session symlink,
// so each Pi tab gets its own acceptance test.
const ACCEPTANCE_PATH = ".think/_acceptance.sh";

// Hard kill for a hanging test. A local model will happily write an acceptance
// script that waits on stdin forever.
const TEST_TIMEOUT_MS = 60000;

// Stop insisting after this many blocked completions — safety valve against a
// block loop when the model genuinely cannot satisfy its own test.
const MAX_BLOCKS_PER_SESSION = 3;

// How much test output to feed back. Enough for a stack trace, not enough to
// blow the context of a 27B model.
const OUTPUT_TAIL_CHARS = 1500;

// Require .think/_acceptance.sh to exist BEFORE the first code write.
// Off by default: it taxes every trivial session ("fix this typo" would have to
// author a test first). Turn it on for unattended runs (pi -p, /q queues,
// overnight) where test-first is worth the tax and nobody is watching.
const REQUIRE_TEST_BEFORE_CODE = false;

// File extensions that count as "code that can be executed/tested".
const CODE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|sh|php|pl|lua|c|cpp|h|java|cs|swift|kt)$/i;

// Completion-flavored Status lines in _state.md (mirrors completion-guard and
// execution-guard — keep these three in sync).
const COMPLETE_STATUS = /##\s*Status:\s*[^\n]*\b(complete|completed|done|finished)\b/i;

function isEnabled(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    return !(config.disabled ?? []).includes("acceptance-guard");
  } catch {
    return true;
  }
}

function isStatePath(filePath: string): boolean {
  return /\.think[\/\\]_state\.md$/.test(filePath);
}

function isAcceptancePath(filePath: string): boolean {
  return /\.think[\/\\]_acceptance\.sh$/.test(filePath);
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

function acceptanceExists(cwd: string): boolean {
  try {
    return fs.statSync(path.join(cwd, ACCEPTANCE_PATH)).size > 0;
  } catch {
    return false;
  }
}

// Run the oracle. Resolves { code, out }; code -1 means it timed out.
function runAcceptance(cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", [ACCEPTANCE_PATH], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ out: out + `\n[acceptance test timed out after ${TEST_TIMEOUT_MS}ms]`, code: -1 });
    }, TEST_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, code: code ?? -1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ out: `failed to run ${ACCEPTANCE_PATH}: ${String(err)}`, code: -1 });
    });
  });
}

const WRITE_TEST_INSTRUCTIONS =
  `Write ${ACCEPTANCE_PATH} — a bash script that exits 0 ONLY if the task is genuinely done, and nonzero otherwise. ` +
  `Rules for it: ` +
  `(1) it must EXERCISE the code (run it with real inputs and compare actual output to expected), not just check that files exist; ` +
  `(2) cover the specific cases the user asked for, including the tricky ones they named; ` +
  `(3) print what failed before exiting nonzero, so the output tells you where to look; ` +
  `(4) no network, no prompts, no reading stdin — it must finish unattended in under ${Math.round(TEST_TIMEOUT_MS / 1000)}s. ` +
  `Example shape: run the program, capture output, 'if [ "$got" != "$want" ]; then echo "FAIL case 3: got $got want $want"; exit 1; fi'.`;

export default function (pi: ExtensionAPI) {
  if (!isEnabled()) return;

  // Monotonic per-session sequence: has any code been modified yet?
  let seq = 0;
  let lastCodeModSeq = 0; // 0 = nothing modified yet (guard not armed)
  let blocksThisSession = 0;
  let gaveUp = false;
  // Set once the oracle has been vetted as non-trivial (fails pre-implementation).
  let testVetted = false;
  // Paths we already demanded a test for, so the pre-code gate nags once.
  let preCodeBlocked = false;

  pi.on("session_start", async (_event: any, ctx: any) => {
    const have = acceptanceExists(ctx.cwd);
    ctx.ui.notify(
      `acceptance-guard active — "Status: complete" is blocked unless ${ACCEPTANCE_PATH} exits 0` +
        `${have ? " (test present)" : " (no test yet — one will be required at completion)"}` +
        `${REQUIRE_TEST_BEFORE_CODE ? "; test-first REQUIRED" : ""}`,
      "info"
    );
  });

  // Track code modifications so doc-only sessions never arm the gate.
  // Modifications also arm in tool_call below — see the comment there.
  pi.on("tool_result", async (event: any, _ctx: any) => {
    const toolName = event.toolName ?? "";
    const input = (event.input as Record<string, any>) ?? {};
    seq++;
    if (toolName === "write" || toolName === "edit") {
      if (isCodePath(input.path ?? input.file_path ?? "")) lastCodeModSeq = seq;
      return;
    }
    if (toolName === "bash" && bashWritesCode(String(input.command ?? ""))) {
      lastCodeModSeq = seq;
    }
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = event.toolName ?? "";

    if (toolName === "bash") {
      if (bashWritesCode(String((event.input as any)?.command ?? ""))) {
        seq++;
        lastCodeModSeq = seq;
      }
      return;
    }

    if (toolName !== "write" && toolName !== "edit") return;

    const input = (event.input as Record<string, any>) ?? {};
    const filePath = input.path ?? input.file_path ?? "";

    // ---------- GATE 1 (opt-in): no code before there is a test ----------
    // Must run before the arming branch below, since it gates code writes.
    if (REQUIRE_TEST_BEFORE_CODE && isCodePath(filePath) && !acceptanceExists(ctx.cwd) && !preCodeBlocked && !gaveUp) {
      preCodeBlocked = true;
      return {
        block: true,
        reason:
          `BLOCKED: no acceptance test exists yet, so there is no way to tell when this task is done. ` +
          `Do NOT retry this write yet. First: ${WRITE_TEST_INSTRUCTIONS} ` +
          `Run it once to confirm it FAILS (it must — the code isn't written yet). THEN write the code.`,
      };
    }

    // Arm at CALL time as well as result time: with parallel tool calls in one
    // turn the completion write's tool_call can arrive before the code write's
    // tool_result, leaving the latch unarmed exactly when it matters (the
    // ordering execution-guard's live probe caught on 2026-07-23).
    if (isCodePath(filePath)) {
      seq++;
      lastCodeModSeq = seq;
      return;
    }

    // The oracle itself: let the write land. Vetting it here would test the OLD
    // file contents, so must-fail-first runs at turn_end instead.
    if (isAcceptancePath(filePath)) return;

    // ---------- GATE 2: the done check ----------
    if (!isStatePath(filePath)) return;

    const newContent = String(input.content ?? input.new_string ?? "");
    if (!COMPLETE_STATUS.test(newContent)) return;

    // Not armed (no code touched — doc/research session), or we gave up.
    if (lastCodeModSeq === 0 || gaveUp) return;

    // No oracle: demand one now. Far less intrusive than gate 1 — it fires once,
    // at the end, only in sessions that actually changed code.
    if (!acceptanceExists(ctx.cwd)) {
      if (blocksThisSession >= MAX_BLOCKS_PER_SESSION) {
        gaveUp = true;
        ctx.ui.notify(
          `acceptance-guard: giving up after ${blocksThisSession} blocks — completion allowed UNVERIFIED. Check the work yourself.`,
          "warn"
        );
        return;
      }
      blocksThisSession++;
      return {
        block: true,
        reason:
          `BLOCKED: you are declaring the task complete, but there is no ${ACCEPTANCE_PATH}, ` +
          `so "complete" is just your opinion — it has not been checked against anything. ` +
          `Do NOT retry this write yet. First: ${WRITE_TEST_INSTRUCTIONS} ` +
          `Then RUN it yourself with bash and fix whatever it reports. Only after it exits 0, write Status: complete.`,
      };
    }

    // The oracle exists — run it. The exit code, not the model, decides.
    ctx.ui.notify(`acceptance-guard: running ${ACCEPTANCE_PATH} to verify completion…`, "info");
    const result = await runAcceptance(ctx.cwd);

    if (result.code === 0) {
      ctx.ui.notify(`✓ acceptance-guard: ${ACCEPTANCE_PATH} passed — completion verified.`, "info");
      return; // allow the completion write
    }

    if (blocksThisSession >= MAX_BLOCKS_PER_SESSION) {
      gaveUp = true;
      ctx.ui.notify(
        `acceptance-guard: ${ACCEPTANCE_PATH} still failing (exit ${result.code}) after ${blocksThisSession} blocks — ` +
          `giving up and allowing completion UNVERIFIED. Human review needed.`,
        "warn"
      );
      return;
    }

    blocksThisSession++;
    const tail = result.out.slice(-OUTPUT_TAIL_CHARS);
    return {
      block: true,
      reason:
        `BLOCKED: you are NOT done. Your own acceptance test ${ACCEPTANCE_PATH} ` +
        `${result.code === -1 ? "did not complete (timed out or failed to run)" : `exited ${result.code}`}. ` +
        `The harness ran it — this is the real output:\n` +
        `\`\`\`\n${tail}\n\`\`\`\n` +
        `Do NOT retry this write, and do NOT edit the test to make it pass. Instead: ` +
        `(1) read the output above and identify the ONE failing case, ` +
        `(2) fix the cause in the source, ` +
        `(3) run 'bash ${ACCEPTANCE_PATH}' yourself to confirm it now passes, ` +
        `(4) only then write Status: complete. ` +
        `Attempt ${blocksThisSession}/${MAX_BLOCKS_PER_SESSION} — after that the task is handed back to the user unverified.`,
    };
  });

  // Vet a freshly written oracle at the turn boundary, when its contents are on
  // disk. Pre-implementation only: a test that passes before any code exists
  // tests nothing, and would hand out a free "complete" later.
  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (testVetted || gaveUp || lastCodeModSeq !== 0) return;
    if (!acceptanceExists(ctx.cwd)) return;

    const result = await runAcceptance(ctx.cwd);
    testVetted = true;
    if (result.code !== 0) return; // fails pre-implementation, as it should

    ctx.ui.notify(
      `acceptance-guard: ${ACCEPTANCE_PATH} PASSES before any code was written — it tests nothing. Steering for a real test.`,
      "warn"
    );
    await pi.sendMessage(
      {
        customType: "acceptance_guard_fake_test",
        content:
          `[acceptance-guard] AUTOMATED HARNESS MESSAGE — not written by the user. Do not reply to it; act on it.\n` +
          `The harness ran ${ACCEPTANCE_PATH} and it EXITED 0 before you have written any code. ` +
          `That means it does not test the task — it would hand you a free "complete" later.\n` +
          `1. Rewrite ${ACCEPTANCE_PATH} so it actually runs the code and compares real output to expected values.\n` +
          `2. Assert the specific cases the user asked for — a test that cannot fail is worse than no test.\n` +
          `3. Run 'bash ${ACCEPTANCE_PATH}' and confirm it FAILS now (the code doesn't exist yet).\n` +
          `4. Then implement until it passes.`,
        display: {
          label: "acceptance-guard",
          content: `${ACCEPTANCE_PATH} passes with no implementation — demanding a real test`,
        },
      },
      { deliverAs: "steer" }
    );
  });

  pi.registerCommand("acceptance", {
    description: "Show acceptance-guard status, or run the acceptance test now",
    handler: async (args: any, ctx: any) => {
      const arg = String(args ?? "").trim();
      const have = acceptanceExists(ctx.cwd);

      if (arg === "run") {
        if (!have) {
          ctx.ui.notify(`acceptance-guard: no ${ACCEPTANCE_PATH} in this project.`, "info");
          return;
        }
        const result = await runAcceptance(ctx.cwd);
        ctx.ui.notify(
          `acceptance-guard: ${ACCEPTANCE_PATH} exit ${result.code}\n${result.out.slice(-OUTPUT_TAIL_CHARS)}`,
          result.code === 0 ? "info" : "warn"
        );
        return;
      }

      ctx.ui.notify(
        `acceptance-guard: test ${have ? `present (${ACCEPTANCE_PATH})` : "MISSING — will be demanded at completion"} | ` +
          `${lastCodeModSeq > 0 ? "armed (code modified)" : "not armed (no code modified)"} | ` +
          `blocks used ${blocksThisSession}/${MAX_BLOCKS_PER_SESSION}${gaveUp ? " — GAVE UP, completion unverified" : ""} | ` +
          `test-first ${REQUIRE_TEST_BEFORE_CODE ? "required" : "optional"}. ` +
          `'/acceptance run' to run it now.`,
        "info"
      );
    },
  });
}
