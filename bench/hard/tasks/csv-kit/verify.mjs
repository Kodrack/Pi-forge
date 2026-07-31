// Hidden verifier for csv-kit. Usage: node verify.mjs <trial-dir>
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const dir = process.argv[2];
const cli = path.join(dir, "cli.js");

const IN1 = [
  'name,age,city',
  '"Smith, John",34,Berlin',
  "O'Neil,28,\"New York\"",
  '"He said ""hi""",99,Rome',
  'Anna,17,"Line1',
  'Line2"',
].join("\n");

const IN2 = ['a,b,c', '1,,3', ',,', 'x,"",z'].join("\n");

const in1 = path.join(dir, "__v1.csv");
const in2 = path.join(dir, "__v2.csv");
fs.writeFileSync(in1, IN1);
fs.writeFileSync(in2, IN2);

function run(args) {
  try {
    return execFileSync("node", [cli, ...args], { timeout: 5000, encoding: "utf-8" }).replace(/\r/g, "").trim();
  } catch {
    return "(error/timeout)";
  }
}

const CHECKS = [
  {
    name: "select two cols (quoting preserved)",
    args: ["select", "name,city", in1],
    want: ['name,city', '"Smith, John",Berlin', "O'Neil,New York", '"He said ""hi""",Rome', 'Anna,"Line1', 'Line2"'].join("\n"),
  },
  {
    name: "select reorder",
    args: ["select", "age,name", in1],
    want: ['age,name', '34,"Smith, John"', "28,O'Neil", '99,"He said ""hi"""', '17,Anna'].join("\n"),
  },
  {
    name: "where numeric value",
    args: ["where", "age=34", in1],
    want: ['name,age,city', '"Smith, John",34,Berlin'].join("\n"),
  },
  {
    name: "where value with space",
    args: ["where", "city=New York", in1],
    want: ['name,age,city', "O'Neil,28,New York"].join("\n"),
  },
  { name: "sum age", args: ["sum", "age", in1], want: "178" },
  {
    name: "select with empty fields",
    args: ["select", "a,c", in2],
    want: ['a,c', '1,3', ',', 'x,z'].join("\n"),
  },
  { name: "sum of empty column", args: ["sum", "b", in2], want: "0" },
];

let score = 0;
const max = CHECKS.length + 1;

const haveFiles = ["csv.js", "ops.js", "cli.js"].every((f) => fs.existsSync(path.join(dir, f)));
if (haveFiles) score++;
else console.log("  x missing one of csv.js / ops.js / cli.js");

if (!fs.existsSync(cli)) {
  console.log(`SCORE ${score}/${max}`);
  process.exit(1);
}

for (const c of CHECKS) {
  const got = run(c.args);
  if (got === c.want) score++;
  else console.log(`  x ${c.name}: got ${JSON.stringify(got.slice(0, 80))}`);
}
console.log(`SCORE ${score}/${max}`);
process.exit(score === max ? 0 : 1);
