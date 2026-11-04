#!/usr/bin/env node
// fake-pi.mjs — stands in for `pi` in Dory engine tests (config.json → pi_bin).
//
// The engine runs `pi --mode json … -p @<promptfile>` with DORY_STAGE=<job kind>
// in the environment. This script answers from a scripted scenario instead of a
// model, so the REAL engine (dory.mjs) can be driven end to end in seconds:
//
//   FAKE_PI_SCENARIO=<file.json>   [{ "stage": "plan", "match": "# CARD T-001",
//                                     "out": "<<<BRIEF>>>…", "files": {"a.txt": "A"} }, …]
//   FAKE_PI_LOG=<file.jsonl>       one line per call: { stage, prompt, rule }
//
// The first unused rule whose stage matches and whose `match` text appears in
// the prompt is consumed. `files` are written relative to the cwd (the project),
// which is how a scripted "executor" makes the acceptance test pass.
// Output is a single assistant message_end event, the shape runPi() parses.

import * as fs from "fs";
import * as path from "path";

const args = process.argv.slice(2);
const p = args[args.indexOf("-p") + 1] ?? "";
const prompt = p.startsWith("@") ? fs.readFileSync(p.slice(1), "utf-8") : p;
const stage = process.env.DORY_STAGE ?? "";
const scenarioPath = process.env.FAKE_PI_SCENARIO;
const usedPath = scenarioPath + ".used";

const rules = JSON.parse(fs.readFileSync(scenarioPath, "utf-8"));
const used = new Set(fs.existsSync(usedPath) ? JSON.parse(fs.readFileSync(usedPath, "utf-8")) : []);
const idx = rules.findIndex((r, i) => !used.has(i) && r.stage === stage && prompt.includes(r.match));

if (process.env.FAKE_PI_LOG) {
  fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ stage, prompt, rule: idx }) + "\n");
}

let out = `(fake-pi: no scripted answer for stage "${stage}")`;
if (idx >= 0) {
  used.add(idx);
  fs.writeFileSync(usedPath, JSON.stringify([...used]));
  const rule = rules[idx];
  for (const [file, content] of Object.entries(rule.files ?? {})) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, content);
  }
  out = rule.out ?? "";
}
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: out }] } }) + "\n");
