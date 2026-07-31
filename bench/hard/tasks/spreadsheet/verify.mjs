// Hidden verifier for spreadsheet. Usage: node verify.mjs <trial-dir>
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const dir = process.argv[2];
const sol = path.join(dir, "sheet.js");

const CASES = [
  ["basic chain", ["A1 = 5", "B1 = A1*2", "C1 = B1+A1"], ["A1 = 5", "B1 = 10", "C1 = 15"]],
  ["precedence and parens", ["A1 = 2+3*4", "B1 = (2+3)*4", "C1 = 20-8/4"], ["A1 = 14", "B1 = 20", "C1 = 18"]],
  ["forward reference", ["A1 = B1+1", "B1 = 4"], ["A1 = 5", "B1 = 4"]],
  ["diamond dependency", ["A1 = 2", "B1 = A1*3", "C1 = A1+4", "D1 = B1+C1"], ["A1 = 2", "B1 = 6", "C1 = 6", "D1 = 12"]],
  ["undefined ref is 0", ["A1 = Z9+7"], ["A1 = 7"]],
  ["self cycle", ["A1 = A1+1", "B1 = 2"], ["A1 = CYCLE", "B1 = 2"]],
  [
    "three-cycle plus dependent",
    ["A1 = B1+1", "B1 = C1+1", "C1 = A1+1", "D1 = A1*2", "E1 = 5"],
    ["A1 = CYCLE", "B1 = CYCLE", "C1 = CYCLE", "D1 = CYCLE", "E1 = 5"],
  ],
  ["two-digit cells and division", ["Z99 = 100", "B2 = Z99/4+Z99"], ["Z99 = 100", "B2 = 125"]],
];

if (!fs.existsSync(sol)) {
  console.log("sheet.js missing");
  console.log(`SCORE 0/${CASES.length}`);
  process.exit(1);
}

const src = fs.readFileSync(sol, "utf-8");
if (/\beval\s*\(|new\s+Function|Function\s*\(/.test(src)) {
  console.log("sheet.js uses eval/Function — automatic fail");
  console.log(`SCORE 0/${CASES.length}`);
  process.exit(1);
}

let score = 0;
let n = 0;
for (const [name, input, want] of CASES) {
  const f = path.join(dir, `__vs${n++}.txt`);
  fs.writeFileSync(f, input.join("\n") + "\n");
  let out;
  try {
    out = execFileSync("node", [sol, f], { timeout: 5000, encoding: "utf-8" }).replace(/\r/g, "").trim();
  } catch {
    out = "(error/timeout)";
  }
  if (out === want.join("\n")) score++;
  else console.log(`  x ${name}: got ${JSON.stringify(out.slice(0, 80))}`);
}
console.log(`SCORE ${score}/${CASES.length}`);
process.exit(score === CASES.length ? 0 : 1);
