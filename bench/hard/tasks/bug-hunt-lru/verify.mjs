// Hidden verifier for bug-hunt-lru. Usage: node verify.mjs <trial-dir>
// Scoring: test.js untouched (gate, not scored) + provided suite passes (4 pts)
// + 6 hidden edge-case checks (1 pt each) = 10.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const dir = process.argv[2];
const here = path.dirname(fileURLToPath(import.meta.url));
const MAX = 10;
let score = 0;

// Gate: test.js must be byte-identical to the shipped one.
const pristine = fs.readFileSync(path.join(here, "setup", "test.js"), "utf-8");
let current = "";
try {
  current = fs.readFileSync(path.join(dir, "test.js"), "utf-8");
} catch {}
if (current !== pristine) {
  console.log("test.js was modified or deleted — automatic fail");
  console.log(`SCORE 0/${MAX}`);
  process.exit(1);
}

// Provided suite (4 pts).
let suiteOut = "";
try {
  suiteOut = execFileSync("node", ["test.js"], { cwd: dir, timeout: 5000, encoding: "utf-8" });
} catch (e) {
  suiteOut = String(e.stdout ?? "");
}
if (suiteOut.includes("ALL TESTS PASSED")) score += 4;
else console.log("  x provided suite still failing");

// Hidden checks (1 pt each), run in-process against the fixed lru.js.
const HIDDEN = `
const LRUCache = require("./lru.js");
const out = [];
function check(name, fn) { try { out.push([name, !!fn()]); } catch { out.push([name, false]); } }

check("capacity 1", () => {
  const c = new LRUCache(1);
  c.set("a", 1); c.set("b", 2);
  return c.get("a") === undefined && c.get("b") === 2 && c.size === 1;
});
check("update at capacity does not evict", () => {
  const c = new LRUCache(2);
  c.set("a", 1); c.set("b", 2); c.set("a", 9);
  return c.get("a") === 9 && c.get("b") === 2 && c.size === 2;
});
check("delete then refill", () => {
  const c = new LRUCache(2);
  c.set("a", 1); c.delete("a"); c.set("b", 2); c.set("c", 3);
  return c.size === 2 && c.has("a") === false && c.get("b") === 2 && c.get("c") === 3;
});
check("keys order after mixed ops", () => {
  const c = new LRUCache(3);
  c.set("a", 1); c.set("b", 2); c.set("c", 3);
  c.get("b"); c.set("d", 4); // evicts a; order: c, b, d
  return JSON.stringify(c.keys()) === JSON.stringify(["c", "b", "d"]);
});
check("re-set refreshes TTL", () => {
  let t = 0;
  const c = new LRUCache(10, 100, () => t);
  t = 0; c.set("a", 1);
  t = 80; c.set("a", 1);
  t = 150; if (c.get("a") !== 1) return false;
  t = 181; return c.get("a") === undefined;
});
check("size correct after expiry purge", () => {
  let t = 0;
  const c = new LRUCache(10, 100, () => t);
  t = 0; c.set("a", 1); c.set("b", 2);
  t = 101; c.get("a"); c.get("b");
  return c.size === 0;
});
console.log(JSON.stringify(out));
`;
const hiddenFile = path.join(dir, "__hidden_check.js");
fs.writeFileSync(hiddenFile, HIDDEN);
try {
  const raw = execFileSync("node", [hiddenFile], { cwd: dir, timeout: 5000, encoding: "utf-8" }).trim();
  for (const [name, ok] of JSON.parse(raw.split("\n").pop())) {
    if (ok) score++;
    else console.log(`  x hidden: ${name}`);
  }
} catch {
  console.log("  x hidden checks crashed");
}

console.log(`SCORE ${score}/${MAX}`);
process.exit(score === MAX ? 0 : 1);
