// Helpers for keeping replay tests honest against the REAL extension source.
// Replay tests copy small pure functions (Node can't import .ts directly), but:
//  - numeric thresholds are parsed LIVE from the extension file, so tuning a
//    const in the guard is automatically reflected here
//  - requireMarker() greps for load-bearing logic lines; if the guard's logic
//    changes and a marker disappears, the test FAILS with "copy may be stale"
//    instead of green-lighting outdated assumptions
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function readExtension(name) {
  const p = path.join(REPO_ROOT, "extensions", name);
  return fs.readFileSync(p, "utf-8");
}

export function parseNumericConst(src, name, file) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`));
  if (!m) {
    throw new Error(`cannot find "const ${name} = <number>" in ${file} — was it renamed? Update this test.`);
  }
  return Number(m[1]);
}

export function requireMarker(src, marker, file, why) {
  if (!src.includes(marker)) {
    throw new Error(
      `marker not found in ${file}: ${JSON.stringify(marker)}\n` +
      `The guard's logic changed (${why}) — the copied logic in this replay test may be STALE. ` +
      `Update the test to match the extension, then update the marker.`
    );
  }
}

export function report(testName, checks) {
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }
  console.log(`${testName}: ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
  return failed;
}
