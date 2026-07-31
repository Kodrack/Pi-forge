// Hidden verifier for regex-lite. Usage: node verify.mjs <trial-dir>
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const dir = process.argv[2];
const sol = path.join(dir, "regex.js");

const CASES = [
  ["abc", "abc", true], ["abc", "abx", false], ["abc", "ab", false],
  ["", "", true], ["", "a", false],
  ["a.c", "abc", true], ["a.c", "ac", false],
  ["a*", "", true], ["a*", "aaaa", true], ["a*b", "b", true], ["a*b", "aab", true],
  ["a+", "", false], ["a+", "aaa", true],
  ["ab?c", "ac", true], ["ab?c", "abc", true], ["ab?c", "abbc", false],
  ["a|b", "b", true], ["a|b|c", "c", true], ["a|b", "d", false],
  ["(ab)+", "ababab", true], ["(ab)+", "aba", false],
  ["(a|b)*c", "abbac", true], ["(a|b)*c", "abd", false],
  ["(a|ab)*c", "ababc", true],
  ["a*a*a*b", "aaab", true], ["a*a*b", "aaa", false],
  ["[abc]+", "cab", true], ["[a-z]+", "hello", true], ["[a-z]+", "heLlo", false],
  ["[^0-9]+", "abc!", true], ["[^0-9]+", "ab1", false],
  ["((a|b)c)+", "acbc", true],
  [".*", "x9!z", true],
  ["(a+)(b+)", "aabbb", true], ["(a+)(b+)", "ba", false],
];

if (!fs.existsSync(sol)) {
  console.log("regex.js missing");
  console.log(`SCORE 0/${CASES.length}`);
  process.exit(1);
}

// Cheating check: built-in regex use is an automatic fail (stated in the prompt).
// Strip comments and string/template literals first so prose like "no RegExp
// used" or output strings can't false-positive.
const raw = fs.readFileSync(sol, "utf-8");
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
if (/RegExp|\.test\s*\(|\.exec\s*\(|\.matchAll\s*\(|\.match\s*\(|\.search\s*\(/.test(stripped)) {
  console.log("regex.js uses built-in regex facilities — automatic fail");
  console.log(`SCORE 0/${CASES.length}`);
  process.exit(1);
}

let score = 0;
for (const [p, t, want] of CASES) {
  let out;
  try {
    out = execFileSync("node", [sol, p, t], { timeout: 5000, encoding: "utf-8" }).trim();
  } catch {
    out = "(error/timeout)";
  }
  const expected = want ? "match" : "no-match";
  if (out === expected) score++;
  else console.log(`  x ${JSON.stringify(p)} on ${JSON.stringify(t)}: wanted ${expected}, got ${out.slice(0, 60)}`);
}
console.log(`SCORE ${score}/${CASES.length}`);
process.exit(score === CASES.length ? 0 : 1);
