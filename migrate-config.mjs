#!/usr/bin/env node
// migrate-config.mjs — keep a machine's tuning when PiForge is updated.
//
// Before per-machine limits existed, the only way to tune incremental-guard was
// to edit the constants in the INSTALLED copy (~/.pi/agent/extensions/
// incremental-guard.ts). Updating PiForge (install.sh copies, dev-link.sh
// symlinks) replaces that file and would silently throw those edits away.
//
// This runs first in install.sh and dev-link.sh. If the installed guard is a
// real file whose limit constants differ from the shipped defaults, each
// differing value is written to ~/.pi/piforge.json → limits.incremental-guard,
// unless that key is already set there (an explicit setting always wins).
// A symlinked or missing guard, or one with default values, is left alone.
//
// usage: node migrate-config.mjs <installed-guard.ts> <repo-guard.ts> <piforge.json> <template-piforge.json>

import * as fs from "fs";

const [installedGuard, repoGuard, configPath, templatePath] = process.argv.slice(2);
if (!installedGuard || !repoGuard || !configPath || !templatePath) {
  console.error("usage: node migrate-config.mjs <installed-guard.ts> <repo-guard.ts> <piforge.json> <template-piforge.json>");
  process.exit(2);
}

// constant in incremental-guard.ts → key in piforge.json limits.incremental-guard
const KEYS = {
  MAX_LINES_PER_WRITE: "maxLinesPerWrite",
  MAX_CHARS_PER_WRITE: "maxCharsPerWrite",
  MAX_LINES_PER_EDIT: "maxLinesPerEdit",
  MAX_CHARS_PER_EDIT: "maxCharsPerEdit",
  MAX_LINES_PER_BASH: "maxLinesPerBash",
  MAX_CHARS_PER_BASH: "maxCharsPerBash",
};

function constants(src) {
  const out = {};
  for (const name of Object.keys(KEYS)) {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([0-9]+)`));
    if (m) out[name] = Number(m[1]);
  }
  return out;
}

let stat;
try {
  stat = fs.lstatSync(installedGuard);
} catch {
  process.exit(0); // nothing installed yet — fresh install
}
if (stat.isSymbolicLink()) process.exit(0); // dev-linked: already the repo's code, nothing customised

const installed = constants(fs.readFileSync(installedGuard, "utf-8"));
const defaults = constants(fs.readFileSync(repoGuard, "utf-8"));
const custom = Object.keys(KEYS).filter((n) => n in installed && n in defaults && installed[n] !== defaults[n]);
if (custom.length === 0) process.exit(0);

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
} catch {
  config = fs.existsSync(configPath) ? null : JSON.parse(fs.readFileSync(templatePath, "utf-8"));
}
if (!config || typeof config !== "object" || Array.isArray(config)) {
  console.log(`  ⚠ ${configPath} is not valid JSON — NOT migrating your custom incremental-guard limits.`);
  console.log(`    Your installed copy had: ${custom.map((n) => `${KEYS[n]}=${installed[n]}`).join(", ")}`);
  console.log(`    Fix the file, then set them with /piforge set incremental-guard.<key> <value>`);
  process.exit(0);
}

config.limits ??= {};
config.limits["incremental-guard"] ??= {};
const section = config.limits["incremental-guard"];
const moved = [];
const kept = [];
for (const n of custom) {
  const key = KEYS[n];
  if (key in section) kept.push(`${key}=${section[key]}`);
  else {
    section[key] = installed[n];
    moved.push(`${key}=${installed[n]}`);
  }
}
if (moved.length) {
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, configPath);
  console.log(`  ✓ kept your custom incremental-guard limits → ~/.pi/piforge.json: ${moved.join(", ")}`);
  console.log(`    (they were edited into the installed extension, which this update replaces; see /piforge limits)`);
}
if (kept.length) {
  console.log(`  • ~/.pi/piforge.json already sets ${kept.join(", ")} — kept that over the installed file's value`);
}