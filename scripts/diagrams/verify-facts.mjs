/**
 * Fact verifier — tier 3 of the four-tier check (see scripts/diagrams/README.md).
 * Asserts the constants hand-typed into the diagrams still match their REAL
 * sources, failing loud when a source constant can't be located at all.
 *
 * Scope: the grant-matching views (06-08) bake the most drift-prone constants
 * (crons, metric/alarm values, index + flag names, engine export names); the
 * older views (01-05) cite prose-level facts their meta.source lines cover.
 *
 * Cross-repo facts (ReciterAI's schedule + task sizing) are checked best-effort:
 * when a sibling ReciterAI checkout exists locally we assert against its
 * origin/main; when it doesn't (e.g. CI checks out only this repo), we emit a
 * WARN line rather than a failure — those constants are re-verified whenever the
 * diagrams are rebuilt on a machine that has both repos.
 *
 *   node scripts/diagrams/verify-facts.mjs   # standalone (exit 1 on mismatch)
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const RECITERAI = [
  process.env.RECITERAI_DIR,
  join(REPO, "..", "ReciterAI"),
  join(process.env.HOME || "", "Dropbox", "GitHub", "ReciterAI"),
].filter(Boolean).find(existsSync);

function diagramText(it) {
  const nodes = Object.values(it.spec.nodes).flatMap((n) => [n.title, ...(n.sub || [])]);
  const meta = [it.meta.heading, it.meta.blurb, it.meta.footnote, it.meta.extraHtml].filter(Boolean);
  return [...nodes, ...meta].join("  ");
}

function src(relPath) {
  try { return readFileSync(join(REPO, relPath), "utf8"); }
  catch (e) { return null; }
}

export function verifyFacts(items) {
  const problems = [];
  const grantViews = items.filter((it) =>
    ["grant-matching-context", "opportunity-pipeline", "matching-engines"].includes(it.spec.id));
  if (grantViews.length === 0) return problems; // nothing to guard
  const hay = grantViews.map(diagramText).join("  ");
  const has = (s) => hay.includes(s);

  // One probe per (sourceFile, mustContain, alsoShownInDiagrams) triple. The
  // source assertion fails loud if the constant moved; the hay assertion fails
  // if a diagram stopped showing a constant this file still guards.
  const probes = [
    ["cdk/lib/etl-stack.ts", "cron(0 7 * * ? *)", "cron(0 7 * * ? *)"],
    ["cdk/lib/etl-stack.ts", 'metricName: "OpportunityCorpusIngestAgeDays"', "OpportunityCorpusIngestAgeDays"],
    ["cdk/lib/etl-stack.ts", "threshold: 21", ">= 21 days"],
    ["lib/search.ts", 'OPPORTUNITIES_INDEX = "scholars-opportunities"', "scholars-opportunities"],
    ["cdk/lib/app-stack.ts", 'SELF_EDIT_GRANT_RECS: env === "staging" ? "on" : "off"', "SELF_EDIT_GRANT_RECS"],
    ["cdk/lib/app-stack.ts", 'GRANT_MATCHA: "on"', "GRANT_MATCHA"],
    ["cdk/lib/app-stack.ts", 'MATCHA_ADMIN: env === "staging" ? "on" : "off"', "MATCHA_ADMIN"],
    ["cdk/lib/app-stack.ts", 'OPPORTUNITY_URL_INTAKE: "on"', null],
    ["lib/api/matcha-spine-run.ts", "export async function rankResearchersForDescriptionSpine", "rankResearchersForDescriptionSpine"],
    ["lib/api/matcha-grants-spine.ts", "export async function rankGrantsForDescriptionSpine", "rankGrantsForDescriptionSpine"],
    ["lib/api/match-opportunities.ts", "export async function matchOpportunitiesForScholar", "matchOpportunitiesForScholar"],
    ["lib/api/reason-agg-cache.ts", "export function cachedReasonAgg", "cachedReasonAgg"],
    ["prisma/schema.prisma", "suppressedAt", "suppress"],
    ["etl/search-index/index.ts", "OPPORTUNITY_INDEX_WHERE", "OPPORTUNITY_INDEX_WHERE"],
  ];
  for (const [file, mustContain, shown] of probes) {
    const txt = src(file);
    if (txt === null) { problems.push(`verify-facts: could not read ${file}`); continue; }
    if (!txt.includes(mustContain)) {
      problems.push(`verify-facts: "${mustContain}" not found in ${file} (moved/renamed? update the diagrams AND this probe)`);
    }
    if (shown && !has(shown)) {
      problems.push(`verify-facts: diagrams no longer show "${shown}" though ${file} still carries it (stale probe or dropped fact)`);
    }
  }

  // Cross-repo (best-effort): ReciterAI's schedule + task family, read from its
  // origin/main so a stale working tree can't fake a pass.
  if (RECITERAI) {
    const gitShow = (p) => {
      try { return execFileSync("git", ["-C", RECITERAI, "show", `origin/main:${p}`], { encoding: "utf8" }); }
      catch { return null; }
    };
    const evb = gitShow("infra/eventbridge.json");
    const td = gitShow("infra/grants_task_definition.json");
    if (evb === null || td === null) {
      console.warn("verify-facts WARN: ReciterAI checkout present but infra specs unreadable — cross-repo probes skipped");
    } else {
      if (!evb.includes("cron(0 3 * * ? *)")) problems.push("verify-facts: ReciterAI eventbridge.json no longer has cron(0 3 * * ? *) — update views 6/7");
      if (!evb.includes("reciterai-grants-daily")) problems.push("verify-facts: rule reciterai-grants-daily missing from ReciterAI eventbridge.json");
      if (!td.includes('"reciterai-grants"')) problems.push("verify-facts: family reciterai-grants missing from ReciterAI grants_task_definition.json");
      if (!has("cron(0 3 * * ? *)")) problems.push('verify-facts: diagrams no longer show "cron(0 3 * * ? *)"');
    }
  } else {
    console.warn("verify-facts WARN: sibling ReciterAI checkout not found — cross-repo probes (03:00 cron, reciterai-grants family) skipped");
  }

  return problems;
}

// Standalone runner
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const defs = (await import("node:fs")).readdirSync(join(here, "definitions")).filter((f) => f.endsWith(".mjs"));
  const items = [];
  for (const f of defs) {
    const m = await import(join(here, "definitions", f));
    items.push({ spec: m.spec, meta: m.meta });
  }
  const problems = verifyFacts(items);
  if (problems.length) { problems.forEach((p) => console.error("✗ " + p)); process.exit(1); }
  console.log(`✓ verify-facts: ${items.length} view(s) checked, no drift`);
}
