#!/usr/bin/env node
// Flag-parity gate: every env key consumed by app/etl code must be either
// wired in the cdk stacks (app-stack / etl-stack, read from their committed
// jest snapshots, which the cdk CI job keeps in sync with the source) or
// explicitly registered in flag-parity-allowlist.txt. This makes the silent
// failure mode impossible: a flag turned on in .env.local but never wired
// into cdk can no longer merge unnoticed (the SEARCH_PEOPLE_MATCH_EXPLAIN bug).
//
// Usage:
//   node scripts/release/flag-parity.mjs                 # CI check (exit 1 on violations)
//   node scripts/release/flag-parity.mjs --dump staging  # JSON of app-container env synthesized for an env
//
// Run from the repo root. No dependencies.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SNAPS = [
  "cdk/test/__snapshots__/app-stack.test.ts.snap",
  "cdk/test/__snapshots__/etl-stack.test.ts.snap",
];
const ALLOWLIST = "scripts/release/flag-parity-allowlist.txt";
const CODE_DIRS = ["app", "components", "lib", "etl"];
const KEY = /^[A-Z][A-Z0-9_]+$/;

// --- wired keys: literal env vars + secret names in the cdk snapshots ---
// Jest snapshots serialize CFN templates; literal container env entries appear
// as {"Name": "KEY", "Value": "literal"} and secrets as {"Name": ..., "ValueFrom": <string|object>}.
// For wired-ness the name alone counts (ValueFrom is usually a CFN object);
// the dump map keeps only literal string Values — the set flags live in.
const WIRED_ENTRY = /"Name": "([A-Z][A-Z0-9_]+)",\n\s+"Value(?:From)?":/g;
const LITERAL_ENTRY = /"Name": "([A-Z][A-Z0-9_]+)",\n\s+"Value": "((?:[^"\\]|\\.)*)"/g;

function snapshotBlocks(snapPath) {
  const text = readFileSync(join(ROOT, snapPath), "utf8");
  const blocks = {};
  const re = /^exports\[`\w+ (prod|staging) matches the snapshot 1`\] = `/gm;
  let m;
  const hits = [];
  while ((m = re.exec(text))) hits.push({ env: m[1], start: m.index });
  hits.forEach((h, i) => {
    blocks[h.env] = text.slice(h.start, hits[i + 1]?.start ?? text.length);
  });
  return blocks;
}

// String-aware scan of one JSON-ish array: from the char after '[', walk to
// the matching ']' (quotes and escapes respected — env values contain brackets).
function arraySlice(text, openBracket) {
  let depth = 1, inStr = false;
  for (let i = openBracket + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return text.slice(openBracket, i + 1);
  }
  return text.slice(openBracket);
}

// The app container is the Environment array with by far the most literal
// entries (sidecars and one-off task defs have a handful each).
function appContainerEnv(block) {
  let best = {};
  let at = -1;
  while ((at = block.indexOf('"Environment": [', at + 1)) !== -1) {
    const slice = arraySlice(block, at + '"Environment": '.length);
    const map = {};
    let m;
    LITERAL_ENTRY.lastIndex = 0;
    while ((m = LITERAL_ENTRY.exec(slice))) map[m[1]] = m[2];
    if (Object.keys(map).length > Object.keys(best).length) best = map;
  }
  return best;
}

const perEnv = { staging: {}, prod: {} };
const wired = new Set();
for (const snap of SNAPS) {
  const blocks = snapshotBlocks(snap);
  for (const env of ["staging", "prod"]) {
    if (!blocks[env]) continue;
    // dump map = app container only (from app-stack); wired = every container in every stack
    if (snap === SNAPS[0]) perEnv[env] = appContainerEnv(blocks[env]);
    let m;
    WIRED_ENTRY.lastIndex = 0;
    while ((m = WIRED_ENTRY.exec(blocks[env]))) wired.add(m[1]);
  }
}

// Dockerfile ARG/ENV are a legitimate wiring path for build-time keys.
for (const f of readdirSync(ROOT).filter((f) => f.startsWith("Dockerfile"))) {
  for (const line of readFileSync(join(ROOT, f), "utf8").split("\n")) {
    const m = line.match(/^\s*(?:ARG|ENV)\s+([A-Z][A-Z0-9_]+)/);
    if (m) wired.add(m[1]);
  }
}

// --- dump mode ---
const dumpAt = process.argv.indexOf("--dump");
if (dumpAt !== -1) {
  const env = process.argv[dumpAt + 1];
  if (!perEnv[env]) {
    console.error(`usage: flag-parity.mjs --dump <staging|prod>`);
    process.exit(2);
  }
  console.log(JSON.stringify(perEnv[env], null, 2));
  process.exit(0);
}

// --- consumed keys: process.env.X and resolver-style env.X reads in code ---
const consumed = new Set();
const READ = /(?:process\.env|(?<![\w.$])env)\.([A-Z][A-Z0-9_]+)/g;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      walk(p);
    } else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) {
      let m;
      const s = readFileSync(p, "utf8");
      while ((m = READ.exec(s))) consumed.add(m[1]);
    }
  }
}
for (const d of CODE_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d));

// --- allowlist ---
const allow = new Set(
  readFileSync(join(ROOT, ALLOWLIST), "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => KEY.test(l)),
);

const unwired = [...consumed].filter((k) => !wired.has(k) && !allow.has(k)).sort();
const stale = [...allow].filter((k) => !consumed.has(k) || wired.has(k)).sort();

let failed = false;
if (unwired.length) {
  failed = true;
  console.error(`FLAG PARITY: ${unwired.length} env key(s) consumed in code but neither wired in cdk (app-stack/etl-stack) nor registered in ${ALLOWLIST}:`);
  for (const k of unwired) console.error(`  ${k}`);
  console.error(`Wire the key per-env in cdk/lib/app-stack.ts (then regenerate the snapshot: cd cdk && npm test -- -u), or add it to the allowlist with a category comment.`);
}
if (stale.length) {
  failed = true;
  console.error(`FLAG PARITY: ${stale.length} stale allowlist entr(ies) — no longer consumed by code, or now wired in cdk. Remove from ${ALLOWLIST}:`);
  for (const k of stale) console.error(`  ${k}`);
}

// --- local advisory: .env.local vs deployed wiring (never runs in CI) ---
if (existsSync(join(ROOT, ".env.local"))) {
  const localKeys = readFileSync(join(ROOT, ".env.local"), "utf8")
    .split("\n")
    .map((l) => l.match(/^([A-Z][A-Z0-9_]+)=/)?.[1])
    .filter(Boolean);
  const localOnly = localKeys.filter((k) => consumed.has(k) && !wired.has(k));
  if (localOnly.length) {
    console.error(`\nADVISORY (.env.local): ${localOnly.length} key(s) set locally and consumed by code but not wired in cdk — local behavior will differ from deployed:`);
    for (const k of localOnly) console.error(`  ${k}${allow.has(k) ? "  (allowlisted code-default)" : ""}`);
  }
}

if (failed) process.exit(1);
console.log(`flag-parity OK: ${consumed.size} consumed, ${wired.size} wired, ${allow.size} allowlisted, staging/prod app env parsed (${Object.keys(perEnv.staging).length}/${Object.keys(perEnv.prod).length} literal keys).`);
