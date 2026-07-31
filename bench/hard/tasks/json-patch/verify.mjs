// Hidden verifier for json-patch. Usage: node verify.mjs <trial-dir>
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const dir = process.argv[2];
const sol = path.join(dir, "patch.js");

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq(a[k], b[k]));
}

const CASES = [
  ["add object key", { a: 1 }, [{ op: "add", path: "/b", value: 2 }], { a: 1, b: 2 }],
  ["replace nested array elem", { a: { b: [1, 2] } }, [{ op: "replace", path: "/a/b/1", value: 9 }], { a: { b: [1, 9] } }],
  ["add array insert shifts", { x: [1, 3] }, [{ op: "add", path: "/x/1", value: 2 }], { x: [1, 2, 3] }],
  ["add array append with -", { x: [1] }, [{ op: "add", path: "/x/-", value: 2 }], { x: [1, 2] }],
  ["remove array element", { x: [1, 2, 3] }, [{ op: "remove", path: "/x/0" }], { x: [2, 3] }],
  ["remove object key", { a: 1, b: 2 }, [{ op: "remove", path: "/a" }], { b: 2 }],
  ["move object to object", { a: { b: 1 }, c: {} }, [{ op: "move", from: "/a/b", path: "/c/d" }], { a: {}, c: { d: 1 } }],
  ["move within array", { x: [1, 2, 3] }, [{ op: "move", from: "/x/0", path: "/x/2" }], { x: [2, 3, 1] }],
  ["copy subtree", { a: { b: 1 } }, [{ op: "copy", from: "/a", path: "/c" }], { a: { b: 1 }, c: { b: 1 } }],
  ["test pass then add", { a: 1 }, [{ op: "test", path: "/a", value: 1 }, { op: "add", path: "/b", value: 2 }], { a: 1, b: 2 }],
  ["test fail aborts", { a: 1 }, [{ op: "test", path: "/a", value: 2 }, { op: "add", path: "/b", value: 2 }], "ERROR"],
  ["remove nonexistent", { a: 1 }, [{ op: "remove", path: "/nope" }], "ERROR"],
  ["escaped slash key", { "a/b": 1 }, [{ op: "replace", path: "/a~1b", value: 2 }], { "a/b": 2 }],
  ["escaped tilde key", { "m~n": 1 }, [{ op: "test", path: "/m~0n", value: 1 }, { op: "remove", path: "/m~0n" }], {}],
  ["array index out of bounds", { x: [1] }, [{ op: "add", path: "/x/5", value: 9 }], "ERROR"],
  ["replace whole document", { a: 1 }, [{ op: "replace", path: "", value: { q: 1 } }], { q: 1 }],
];

if (!fs.existsSync(sol)) {
  console.log("patch.js missing");
  console.log(`SCORE 0/${CASES.length}`);
  process.exit(1);
}

let score = 0;
let n = 0;
for (const [name, doc, patch, want] of CASES) {
  const docF = path.join(dir, `__vd${n}.json`);
  const patF = path.join(dir, `__vp${n}.json`);
  n++;
  fs.writeFileSync(docF, JSON.stringify(doc));
  fs.writeFileSync(patF, JSON.stringify(patch));
  let out;
  try {
    out = execFileSync("node", [sol, docF, patF], { timeout: 5000, encoding: "utf-8" }).trim();
  } catch (e) {
    out = String(e.stdout ?? "").trim() || "(error/timeout)";
  }
  let ok;
  if (want === "ERROR") ok = out === "ERROR";
  else {
    try {
      ok = deepEq(JSON.parse(out), want);
    } catch {
      ok = false;
    }
  }
  if (ok) score++;
  else console.log(`  x ${name}: got ${JSON.stringify(out.slice(0, 80))}`);
}
console.log(`SCORE ${score}/${CASES.length}`);
process.exit(score === CASES.length ? 0 : 1);
