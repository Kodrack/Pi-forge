// probe.ts — benchmark instrumentation extension (LIVE suite only, never installed).
// Loaded per-run via `pi -e bench/live/probe.ts`; logs to $PROBE_LOG as JSONL:
//   {ev:"call", id, tool, path, lines, chars}  every tool_call attempt
//   {ev:"result", id, tool}                    tool_result — a call whose id never
//                                              gets a result was BLOCKED by a guard
//   {ev:"turn_end", extractedLen}              what loop-guard's thinking-aware extractText sees
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";

const LOG = process.env.PROBE_LOG ?? "/tmp/piforge-bench-probe.jsonl";

function extractText(message: any): string {
  if (!message?.content) return "";
  return (message.content as any[])
    .filter((b) => b?.type === "text" || b?.type === "thinking")
    .map((b) => b?.text ?? b?.thinking ?? "")
    .join(" ")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event: any) => {
    const input = event.input ?? {};
    const content = input.content ?? input.new_string ?? input.command ?? "";
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        ev: "call",
        id: event.toolCallId ?? null,
        tool: event.toolName,
        path: input.path ?? input.file_path ?? null,
        lines: String(content).split(/\r?\n/).length,
        chars: String(content).length,
      }) + "\n"
    );
  });
  pi.on("tool_result", async (event: any) => {
    fs.appendFileSync(
      LOG,
      JSON.stringify({ ev: "result", id: event.toolCallId ?? null, tool: event.toolName }) + "\n"
    );
  });
  pi.on("turn_end", async (event: any) => {
    fs.appendFileSync(
      LOG,
      JSON.stringify({ ev: "turn_end", extractedLen: extractText(event.message).length }) + "\n"
    );
  });
}
