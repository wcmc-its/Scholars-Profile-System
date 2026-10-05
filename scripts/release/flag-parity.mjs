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
//   node scripts/release/flag-parity.mjs --write-inventory  # regenerate lib/diagnostics/flag-inventory.generated.ts
//   node scripts/release/flag-parity.mjs --drift <env> -     # running app task def (stdin) vs cdk source (#1765)
//   node scripts/release/flag-parity.mjs --etl-drift <env> - # deployed ETL state machines (stdin) vs cdk source (#1987)
//   node scripts/release/flag-parity.mjs --selfcheck         # self-test of the two drift classifiers
//
// Run from the repo root. No dependencies.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
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
  return blocksFromText(readFileSync(join(ROOT, snapPath), "utf8"));
}

function blocksFromText(text) {
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

// --- effective-flag inventory (#1765): the allowlist behind GET /api/edit/effective-flags ---
// The runtime endpoint reports process.env[name] ONLY for names in this list,
// never by dumping process.env. The list is the app container's LITERAL env
// (union of staging + prod; secrets arrive via ValueFrom and never appear here),
// narrowed to flag-shaped entries: config-ish names (URLs, ARNs, group CNs,
// allowlists, ids) are dropped by name, and anything whose value is not a
// short token (on/off/true/false/number/one word) is dropped by value, so a
// hostname or resource name can never leak through a new key. Secret-looking
// names are refused outright. The committed file must match this computation;
// the CI check below fails on drift with the regenerate command.
const INVENTORY_FILE = "lib/diagnostics/flag-inventory.generated.ts";
const NON_FLAG_NAMES = new Set(["NODE_ENV", "PORT"]);
const NON_FLAG_SUFFIX = /(_URL|_ORIGIN|_ARN|_CN|_ID|_ENDPOINT|_REGION|_WORKGROUP|_DATABASE|_ALARM|_FROM|_NAME|_ATTRIBUTE|_SCOPES|_PROPAGATORS|_ALLOWLIST|_CWIDS|_CIDRS)$/;
const SECRET_LIKE = /SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|_KEY$|CREDENTIAL|PRIVATE|CWID|CIDR|DSN/;
const FLAG_VALUE = /^(on|off|true|false|-?\d+(\.\d+)?|[A-Za-z][A-Za-z0-9]{0,31})$/;

function flagInventory() {
  const names = new Set([...Object.keys(perEnv.staging), ...Object.keys(perEnv.prod)]);
  return [...names]
    .filter((k) => !NON_FLAG_NAMES.has(k) && !NON_FLAG_SUFFIX.test(k) && !SECRET_LIKE.test(k))
    .filter((k) => ["staging", "prod"].every((e) => !(k in perEnv[e]) || FLAG_VALUE.test(perEnv[e][k])))
    .sort();
}

function renderInventory(names) {
  return [
    "// GENERATED by `node scripts/release/flag-parity.mjs --write-inventory` — do not edit by hand.",
    "// The explicit allowlist of feature-flag env names GET /api/edit/effective-flags",
    "// reports (#1765). Derived from the app container's literal env in the cdk",
    "// app-stack snapshot; see flagInventory() in scripts/release/flag-parity.mjs.",
    "export const FLAG_INVENTORY: readonly string[] = [",
    ...names.map((n) => `  "${n}",`),
    "];",
    "",
  ].join("\n");
}

if (process.argv.includes("--write-inventory")) {
  const names = flagInventory();
  writeFileSync(join(ROOT, INVENTORY_FILE), renderInventory(names));
  console.log(`wrote ${INVENTORY_FILE} (${names.length} flags)`);
  process.exit(0);
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

// --- drift mode: synthesized app env vs a RUNNING task definition (#1765) ---
// The mirror of the flag-parity gate above: CD ships a new `:latest` image on
// every merge WITHOUT registering a new task definition, but env vars live in
// the task def — so a merged flag stays DARK (undefined at runtime) until its
// own `cdk deploy Sps-App-<env>`. Nothing else diffs the two. Feed the running
// task def in and this fails when it's behind cdk source:
//   aws ecs describe-task-definition --task-definition sps-app-staging \
//     | node scripts/release/flag-parity.mjs --drift staging -
// Select the app container by `name === "app"`, NEVER containerDefinitions[0]:
// the otel-collector sidecar reorders between revisions, so [0] silently reads
// the sidecar's env and every flag looks "missing".
// The jest snapshot synthesizes with the placeholder account 123456789012, so
// any literal ARN in the source env (e.g. HONORS_STATE_MACHINE_ARN) differs
// from the running value only by account id. Normalize the 12-digit account
// field on both sides so that is not reported as drift.
const normAccount = (v) => (typeof v === "string" ? v.replace(/:\d{12}:/g, ":ACCOUNT:") : v);

function classifyDrift(synth, containers) {
  const app = Array.isArray(containers) ? containers.find((c) => c.name === "app") : undefined;
  if (!app) return { appFound: false, names: (containers ?? []).map((c) => c.name) };
  const running = Object.fromEntries((app.environment ?? []).map((e) => [e.name, e.value]));
  const missing = []; // in cdk source, absent from running  → merged-but-dark
  const diff = [];    // in both, value differs              → flipped-but-stale
  for (const [k, v] of Object.entries(synth)) {
    if (!(k in running)) missing.push(k);
    else if (normAccount(running[k]) !== normAccount(v)) diff.push({ key: k, running: running[k], source: v });
  }
  const extra = Object.keys(running).filter((k) => !(k in synth)).sort(); // removed from source
  return { appFound: true, missing: missing.sort(), diff, extra };
}

const driftAt = process.argv.indexOf("--drift");
if (driftAt !== -1) {
  const env = process.argv[driftAt + 1];
  const src = process.argv[driftAt + 2];
  if (!perEnv[env] || !src) {
    console.error("usage: flag-parity.mjs --drift <staging|prod> <taskdef.json|->  (JSON from `aws ecs describe-task-definition`)");
    process.exit(2);
  }
  let td;
  try {
    td = JSON.parse(src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8"));
  } catch {
    console.error("drift: input is not valid JSON");
    process.exit(2);
  }
  const containers = (td.taskDefinition ?? td).containerDefinitions;
  const r = classifyDrift(perEnv[env], containers);
  if (!r.appFound) {
    console.error(`drift: no container named "app" (found: ${(r.names ?? []).join(", ") || "none"})`);
    process.exit(2);
  }
  if (r.missing.length || r.diff.length) {
    console.error(`FLAG DRIFT (${env}): the running task definition is behind cdk source — a merged flag is DARK until \`cdk deploy Sps-App-${env}\`.`);
    if (r.missing.length) {
      console.error(`  missing from running (${r.missing.length}):`);
      for (const k of r.missing) console.error(`    ${k} = ${JSON.stringify(perEnv[env][k])}`);
    }
    if (r.diff.length) {
      console.error(`  value drift (${r.diff.length}):`);
      for (const d of r.diff) console.error(`    ${d.key}: running=${JSON.stringify(d.running)} source=${JSON.stringify(d.source)}`);
    }
    if (r.extra.length) console.error(`  (informational) ${r.extra.length} running-only key(s) removed from source: ${r.extra.join(", ")}`);
    process.exit(1);
  }
  console.log(`flag-drift OK (${env}): running app container matches synthesized env (${Object.keys(perEnv[env]).length} literal keys)${r.extra.length ? `; ${r.extra.length} extra running-only: ${r.extra.join(", ")}` : ""}.`);
  process.exit(0);
}

// --- ETL drift mode: deployed state machines vs the etl-stack snapshot (#1987) ---
// ETL changes ship only on a manual `cdk deploy Sps-Etl-<env>`, so a step merged
// to etl-stack.ts can sit undeployed with nothing alarming (TaskNewsWeekly,
// TaskRosterProminenceNightly). This compares the per-env set of "Task<Id>"
// state ids in the committed etl-stack jest snapshot against the UNION of the
// deployed `scholars-*-<env>` state-machine definitions. It sees added/removed
// steps only; a changed command or env on an existing step is invisible.
// Feed it a JSON array of {name, definition} (describe-state-machine output):
//   aws stepfunctions list-state-machines \
//     --query "stateMachines[?starts_with(name,'scholars-') && ends_with(name,'-staging')].stateMachineArn" --output text \
//     | tr '\t' '\n' | while read -r arn; do aws stepfunctions describe-state-machine \
//         --state-machine-arn "$arn" --query '{name:name,definition:definition}' --output json; done \
//     | jq -s . | node scripts/release/flag-parity.mjs --etl-drift staging -
// Definitions in the snapshot are compact JSON (Fn::Join fragments), so a state
// key always reads `"TaskX":{`; pretty-printed CFN logical ids read `"TaskX": {`
// and are not matched. Deployed definitions are re-serialized compactly first.
const TASK_STATE = /"(Task[A-Za-z0-9_]+)":\{/g;

function taskStateIds(text) {
  const ids = new Set();
  let m;
  TASK_STATE.lastIndex = 0;
  while ((m = TASK_STATE.exec(text))) ids.add(m[1]);
  return ids;
}

function compactDefinition(def) {
  if (typeof def !== "string") return JSON.stringify(def ?? "");
  try {
    return JSON.stringify(JSON.parse(def));
  } catch {
    return def;
  }
}

function classifyEtlDrift(sourceIds, machines, env) {
  const nameRe = new RegExp(`^scholars-.+-${env}$`);
  const used = (Array.isArray(machines) ? machines : []).filter((m) => nameRe.test(m?.name ?? ""));
  const deployed = new Set();
  for (const m of used) for (const id of taskStateIds(compactDefinition(m.definition))) deployed.add(id);
  return {
    machines: used.map((m) => m.name).sort(),
    sourceCount: sourceIds.size,
    deployedCount: deployed.size,
    missing: [...sourceIds].filter((id) => !deployed.has(id)).sort(), // merged, not deployed
    extra: [...deployed].filter((id) => !sourceIds.has(id)).sort(),   // deployed, gone from source
  };
}

const etlDriftAt = process.argv.indexOf("--etl-drift");
if (etlDriftAt !== -1) {
  const env = process.argv[etlDriftAt + 1];
  const src = process.argv[etlDriftAt + 2];
  if (!["staging", "prod"].includes(env) || !src) {
    console.error("usage: flag-parity.mjs --etl-drift <staging|prod> <machines.json|->  (JSON array of {name, definition})");
    process.exit(2);
  }
  let machines;
  try {
    machines = JSON.parse(src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8"));
  } catch {
    console.error("etl-drift: input is not valid JSON");
    process.exit(2);
  }
  const block = snapshotBlocks(SNAPS[1])[env];
  const sourceIds = taskStateIds(block ?? "");
  if (!sourceIds.size) {
    console.error(`etl-drift: no "Task<Id>" states found in the ${env} block of ${SNAPS[1]} (snapshot format changed?)`);
    process.exit(2);
  }
  const r = classifyEtlDrift(sourceIds, machines, env);
  if (!r.machines.length) {
    console.error(`etl-drift: no scholars-*-${env} state machines in the input`);
    process.exit(2);
  }
  const head = `(${env}) source=${r.sourceCount} deployed=${r.deployedCount} across ${r.machines.length} state machines (${r.machines.join(", ")})`;
  if (r.missing.length || r.extra.length) {
    console.error(`ETL DRIFT ${head}: the deployed Step Functions definitions differ from cdk source -- run \`cdk diff Sps-Etl-${env}\` then \`cdk deploy Sps-Etl-${env}\` from master.`);
    if (r.missing.length) console.error(`  in source, not deployed (${r.missing.length}): ${r.missing.join(", ")}`);
    if (r.extra.length) console.error(`  deployed, not in source (${r.extra.length}): ${r.extra.join(", ")}`);
    process.exit(1);
  }
  console.log(`etl-drift OK ${head}: no step-id drift.`);
  process.exit(0);
}

// --- self-check for the drift classifiers (no framework): node flag-parity.mjs --selfcheck ---
if (process.argv.includes("--selfcheck")) {
  const assert = (cond, msg) => { if (!cond) { console.error(`selfcheck FAIL: ${msg}`); process.exit(1); } };
  // otel sidecar deliberately FIRST — proves selection is by name, not [0].
  const containers = [
    { name: "otel-collector", environment: [{ name: "OTEL_ONLY", value: "1" }] },
    { name: "app", environment: [{ name: "A", value: "on" }, { name: "B", value: "old" }, { name: "GONE", value: "1" }] },
  ];
  const synth = { A: "on", B: "new", C: "off" };
  const r = classifyDrift(synth, containers);
  assert(r.appFound, "should select the container named 'app', not the [0] sidecar");
  assert(JSON.stringify(r.missing) === JSON.stringify(["C"]), `missing should be [C], got ${JSON.stringify(r.missing)}`);
  assert(r.diff.length === 1 && r.diff[0].key === "B", `diff should be [B], got ${JSON.stringify(r.diff)}`);
  assert(JSON.stringify(r.extra) === JSON.stringify(["GONE"]), `extra should be [GONE], got ${JSON.stringify(r.extra)}`);
  // no false positives when running matches source exactly
  const clean = classifyDrift({ A: "on" }, [{ name: "app", environment: [{ name: "A", value: "on" }] }]);
  assert(clean.missing.length === 0 && clean.diff.length === 0, "identical env must report no drift");
  // missing 'app' container is a hard error, not a silent pass
  assert(!classifyDrift(synth, [{ name: "otel-collector", environment: [] }]).appFound, "no 'app' container must be flagged");
  // the jest placeholder account in a source ARN is not drift (#1765 false positive)...
  const arn = (acct) => `arn:aws:states:us-east-1:${acct}:stateMachine:scholars-honors-staging`;
  const acct = classifyDrift({ X_ARN: arn("123456789012") }, [{ name: "app", environment: [{ name: "X_ARN", value: arn("000000000000") }] }]);
  assert(acct.diff.length === 0, `account-only ARN difference must not be drift, got ${JSON.stringify(acct.diff)}`);
  // ...but a real difference elsewhere in the ARN still is
  const realArn = classifyDrift({ X_ARN: arn("123456789012") }, [{ name: "app", environment: [{ name: "X_ARN", value: arn("000000000000").replace("staging", "prod") }] }]);
  assert(realArn.diff.length === 1, "an ARN differing beyond the account id must still be drift");

  // ETL drift: a fixture shaped like the jest serializer's etl-stack snapshot.
  const fixture = [
    "exports[`EtlStack prod matches the snapshot 1`] = `",
    '  "TaskRoleABC123": {',
    '    "Type": "AWS::IAM::Role",',
    '  "DefinitionString": {"Fn::Join": ["", [',
    '    "{"StartAt":"TaskEd","States":{"TaskEd":{"Next":"TaskNew","Resource":"arn:aws:states:::ecs:runTask.sync"},"TaskNew":{"End":true}}}",',
    "`;",
    "exports[`EtlStack staging matches the snapshot 1`] = `",
    '    "{"StartAt":"TaskEd","States":{"TaskEd":{"End":true}}}",',
    "`;",
  ].join("\n");
  const fb = blocksFromText(fixture);
  const prodIds = taskStateIds(fb.prod);
  assert(JSON.stringify([...prodIds].sort()) === JSON.stringify(["TaskEd", "TaskNew"]), `fixture prod ids should be [TaskEd, TaskNew] (not the pretty-printed TaskRoleABC123), got ${JSON.stringify([...prodIds])}`);
  assert(JSON.stringify([...taskStateIds(fb.staging)]) === JSON.stringify(["TaskEd"]), "fixture staging block must not bleed into prod");
  const deployedProd = [
    // pretty-printed JSON proves deployed definitions are compacted before matching
    { name: "scholars-nightly-prod", definition: JSON.stringify({ StartAt: "TaskEd", States: { TaskEd: { End: true } } }, null, 2) },
    { name: "scholars-weekly-prod", definition: '{"States":{"TaskOld":{"End":true}}}' },
    // other env and non-SPS machines are ignored
    { name: "scholars-nightly-staging", definition: '{"States":{"TaskNew":{"End":true}}}' },
    { name: "reciterai-hot-path", definition: '{"States":{"TaskNew":{"End":true}}}' },
  ];
  const e = classifyEtlDrift(prodIds, deployedProd, "prod");
  assert(JSON.stringify(e.machines) === JSON.stringify(["scholars-nightly-prod", "scholars-weekly-prod"]), `machines filter wrong: ${JSON.stringify(e.machines)}`);
  assert(JSON.stringify(e.missing) === JSON.stringify(["TaskNew"]), `etl missing should be [TaskNew], got ${JSON.stringify(e.missing)}`);
  assert(JSON.stringify(e.extra) === JSON.stringify(["TaskOld"]), `etl extra should be [TaskOld], got ${JSON.stringify(e.extra)}`);
  const etlClean = classifyEtlDrift(prodIds, [{ name: "scholars-nightly-prod", definition: '{"States":{"TaskEd":{"Next":"TaskNew"},"TaskNew":{"End":true}}}' }], "prod");
  assert(!etlClean.missing.length && !etlClean.extra.length, "matching definitions must report no ETL drift");
  // the committed snapshot still parses (guards a jest-serializer format change)
  const real = snapshotBlocks(SNAPS[1]);
  for (const env of ["staging", "prod"]) {
    const ids = taskStateIds(real[env] ?? "");
    assert(ids.size > 10 && ids.has("TaskEd"), `committed etl-stack ${env} snapshot yielded ${ids.size} Task ids (expected >10 incl. TaskEd)`);
  }
  console.log("flag-parity drift selfcheck OK");
  process.exit(0);
}

// --- consumed keys: process.env.X, resolver-style env.X, and
// requireEnv("X")/optionalEnv("X") helper reads in code ---
const consumed = new Set();
const READ = /(?:process\.env|(?<![\w.$])env)\.([A-Z][A-Z0-9_]+)/g;
const HELPER_READ = /\b(?:requireEnv|optionalEnv)\(\s*["']([A-Z][A-Z0-9_]+)["']/g;
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
      while ((m = HELPER_READ.exec(s))) consumed.add(m[1]);
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

const inventoryPath = join(ROOT, INVENTORY_FILE);
const committedInventory = existsSync(inventoryPath) ? readFileSync(inventoryPath, "utf8") : "";
if (committedInventory !== renderInventory(flagInventory())) {
  failed = true;
  console.error(`FLAG PARITY: ${INVENTORY_FILE} is out of date with the cdk app-stack snapshot (the /api/edit/effective-flags allowlist, #1765). Regenerate: node scripts/release/flag-parity.mjs --write-inventory`);
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
