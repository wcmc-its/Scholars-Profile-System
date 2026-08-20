/**
 * View 7 — Opportunity corpus pipeline & freshness guardrails.
 * The supply-chain detail behind view 6: the daily Fargate task's internal
 * stages (fetch -> dedupe -> gates -> LLM judge -> persist -> drain), the two
 * corpus stores, and the two independent guardrails (log-error alarm on the
 * producer, per-source freshness alarm on the consumer side).
 * Source: ReciterAI pipeline_grants/{ingest,ingest_spin,ingest_submissions,
 *         denoise,dedupe,exclusions,persist}.py · infra/grants_task_definition.json ·
 *         infra/eventbridge.json (cross-repo, applied + verified live 2026-08-20) —
 *         SPS: cdk/lib/etl-stack.ts · etl/dynamodb/grant-opportunity-etl.ts ·
 *         lib/search.ts (OPPORTUNITY_INDEX_WHERE).
 */
import { A } from "../lib.mjs";

const nodes = {
  // ----- sources -----
  gg:   { x: 40, y: 168, w: 288, h: 56, kind: "ext", title: "Grants.gov API", sub: ["public POST · paginated to hitCount"], chip: { tone: "nightly", text: "daily" } },
  spin: { x: 40, y: 244, w: 288, h: 62, kind: "ext", title: "SPIN ProgramSearch", sub: ["113 target funders (spon_code)", "creds are query params — never logged"], chip: { tone: "ondemand", text: "manual" } },
  csv:  { x: 40, y: 326, w: 288, h: 56, kind: "ext", title: "WCM funding-DB CSV", sub: ["ingest_curated · source frozen"], chip: { tone: "ondemand", text: "frozen" } },

  // ----- the daily task's internal stages -----
  f:    { x: 420, y: 168, w: 320, h: 56, kind: "app", title: "fetch + normalize", sub: ["one opportunity shape from any source"] },
  d:    { x: 420, y: 244, w: 320, h: 56, kind: "app", title: "dedupe + exclusions", sub: ["corpus-key index · excluded_opportunities"] },
  g:    { x: 420, y: 320, w: 320, h: 56, kind: "app", title: "noise gates", sub: ["project_type allow-list · geo non-US"] },
  j:    { x: 420, y: 396, w: 320, h: 62, kind: "aws", title: "Bedrock judge / scorer", sub: ["is_research · biomedical relevance · topics"] },
  p:    { x: 420, y: 482, w: 320, h: 56, kind: "app", title: "persist", sub: ["incremental DynamoDB flush, per item"] },
  dr:   { x: 420, y: 558, w: 320, h: 62, kind: "app", title: "submission drain", sub: ["ingest_submissions · DynamoDB-only", "never publishes the S3 artifact"] },

  // ----- corpus stores + producer guardrail -----
  ddb:  { x: 830, y: 168, w: 300, h: 84, kind: "data", title: "DynamoDB · reciterai", sub: ["GRANT# corpus items", "SUBMISSION intake queue (from SPS /edit)"] },
  s3:   { x: 830, y: 300, w: 300, h: 72, kind: "data", title: "S3 · grants/latest", sub: ["sweep-only publish · shrink guard refuses", "a >20% count drop (force=True escape)"] },
  al:   { x: 830, y: 470, w: 300, h: 78, kind: "aws", title: "Log-error alarm", sub: ["reciterai-grants-ingest-errors", "ERROR / Traceback / ShrinkError lines", "-> SNS email topic (confirmed subscribers)"] },

  // ----- SPS consumer + freshness guardrail -----
  proj: { x: 1192, y: 168, w: 296, h: 56, kind: "app", title: "SPS nightly projection", sub: ["etl:dynamodb · cron(0 7 * * ? *)"], chip: { tone: "nightly", text: "07:00 UTC" } },
  aur:  { x: 1192, y: 262, w: 296, h: 56, kind: "data", title: "Aurora · opportunity", sub: ["upsert never names suppress* columns"] },
  osi:  { x: 1192, y: 356, w: 296, h: 62, kind: "data", title: "scholars-opportunities", sub: ["rebuilt nightly · OPPORTUNITY_INDEX_WHERE", "drops suppressed + non-research rows"] },
  met:  { x: 1192, y: 496, w: 296, h: 62, kind: "aws", title: "Per-source age metric", sub: ["SPS/ETL · OpportunityCorpusIngestAgeDays", "{Env} corpus-wide + {Env, Source} dims"] },
  al21: { x: 1192, y: 586, w: 296, h: 56, kind: "aws", title: "Alarm >= 21 days", sub: ["corpus-wide MAX -> etl-failures topic"] },
};

const groups = [
  { x: 26, y: 118, w: 320, h: 288, kind: "ext", title: "Sources" },
  { x: 400, y: 118, w: 360, h: 526, kind: "app", title: "Fargate · reciterai-grants (daily 03:00 UTC)", fo: 0.05 },
  { x: 810, y: 118, w: 340, h: 278, kind: "data", title: "Shared corpus stores", fo: 0.08 },
  { x: 810, y: 438, w: 340, h: 134, kind: "aws", title: "Producer guardrail", fo: 0.05 },
  { x: 1172, y: 118, w: 336, h: 324, kind: "edge", title: "SPS · nightly ETL" },
  { x: 1172, y: 462, w: 336, h: 204, kind: "aws", title: "Freshness guardrail · SPS etl-stack", fo: 0.05 },
];
const gSrc = groups[0], gTask = groups[1];

const edges = [
  { p0: A(gSrc, "r", 0.35), p1: A(nodes.f, "l", 0.5), color: "teal", label: "fetch" },
  { p0: A(nodes.f, "b", 0.5), p1: A(nodes.d, "t", 0.5), color: "teal" },
  { p0: A(nodes.d, "b", 0.5), p1: A(nodes.g, "t", 0.5), color: "teal" },
  { p0: A(nodes.g, "b", 0.5), p1: A(nodes.j, "t", 0.5), color: "teal", label: "survivors" },
  { p0: A(nodes.j, "b", 0.5), p1: A(nodes.p, "t", 0.5), color: "violet", label: "judged" },
  { p0: A(nodes.p, "b", 0.5), p1: A(nodes.dr, "t", 0.5), color: "gray", dash: true, label: "'; then'" },
  { p0: A(nodes.p, "r", 0.4), p1: A(nodes.ddb, "l", 0.8), color: "amber", label: "GRANT# rows", lp: { x: 776, y: 400 }, points: [{ x: 776, y: 510 }, { x: 776, y: 240 }] },
  { p0: A(nodes.p, "r", 0.8), p1: A(nodes.s3, "l", 0.5), color: "amber", dash: true, label: "sweep publish", lp: { x: 776, y: 458 } },
  { p0: A(nodes.dr, "r", 0.5), p1: A(nodes.ddb, "b", 0.85), color: "indigo", label: "statuses + GRANT#", lp: { x: 1000, y: 589 }, points: [{ x: 1158, y: 589 }, { x: 1158, y: 280 }] },
  { p0: A(nodes.ddb, "r", 0.9), p1: A(nodes.dr, "r", 0.8), color: "indigo", dash: true, label: "pending SUBMISSIONs", lp: { x: 1080, y: 608 }, points: [{ x: 1146, y: 244 }, { x: 1146, y: 608 }] },
  { p0: A(gTask, "b", 0.5), p1: A(nodes.al, "l", 0.5), color: "gray", dash: true, label: "CloudWatch logs · metric filter", lp: { x: 640, y: 686 }, points: [{ x: 580, y: 672 }, { x: 776, y: 672 }, { x: 776, y: 509 }] },
  { p0: A(nodes.ddb, "r", 0.5), p1: A(nodes.proj, "l", 0.5), color: "teal" },
  { p0: A(nodes.proj, "b", 0.5), p1: A(nodes.aur, "t", 0.5), color: "teal", label: "upsert" },
  { p0: A(nodes.aur, "b", 0.5), p1: A(nodes.osi, "t", 0.5), color: "teal", label: "rebuild" },
  { p0: A(nodes.proj, "l", 0.8), p1: A(nodes.met, "l", 0.3), color: "gray", dash: true, label: "emit ingest age", lp: { x: 1164, y: 336 }, points: [{ x: 1164, y: 212 }, { x: 1164, y: 515 }] },
  { p0: A(nodes.met, "b", 0.5), p1: A(nodes.al21, "t", 0.5), color: "violet" },
];

export const spec = { id: "opportunity-pipeline", vb: [1540, 720], groups, nodes, edges };

export const meta = {
  nav: "⑦ Corpus pipeline",
  kicker: "View 7 · supply chain + guardrails",
  heading: "Opportunity corpus pipeline & freshness",
  dot: "#f08c00",
  blurb:
    "Inside the daily corpus run: every source funnels through one normalize → dedupe → gate → " +
    "<b>LLM judge</b> → persist chain in the <code>reciterai-grants</code> Fargate task, with the " +
    "SPS submission drain chained after it. Two independent guardrails watch it: a <b>log-error " +
    "alarm</b> on the producer (the <code>;</code> chain means a grants.gov failure never reaches the " +
    "exit code) and the <b>per-source freshness metric</b> + ≥21-day alarm on the SPS side.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Source" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Pipeline stage" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "AWS managed / LLM / alarm" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "SPS boundary" },
  ],
  edgeLegend: [
    { color: "teal", label: "corpus flow" },
    { color: "amber", label: "persist / publish" },
    { color: "indigo", label: "submission queue round-trip" },
    { color: "violet", label: "LLM-judged output" },
    { color: "gray", dash: true, label: "telemetry / sequencing" },
  ],
  footnote:
    "<b>Why two alarms:</b> the freshness metric's corpus-wide series goes green when <i>any</i> " +
    "source lands a fresh row (a manual drain once masked three 45-60-day-stale feeds), so the " +
    "<b>per-source</b> dimensions exist for per-feed alarms once each cadence proves out; the " +
    "log-error alarm covers failures the exit code can't (the <code>;</code> chain deliberately " +
    "lets the drain run after a grants.gov crash). <b>Drain is DynamoDB-only</b>: on 2026-08-20 the " +
    "old drain-side publish clobbered <code>grants/latest</code> with a 65-item subset — exactly what " +
    "the shrink guard exists to refuse — so the drain no longer publishes at all; SPS reads the " +
    "corpus from DynamoDB, never the artifact. <b>SPIN</b> runs manually until the license check on " +
    "scheduled pulls clears (weekly rule spec'd, deliberately unshipped). The 03:00→07:00 UTC gap " +
    "is a <b>launch</b> gap; first-tick wall-clock vs 07:00 is a monitored assumption, and Fargate " +
    "has no task timeout — a hung run runs until noticed.",
  seeAlso: [
    { id: "grant-matching-context", label: "⑥ Grant matching · context" },
    { id: "matching-engines", label: "⑧ Matching surfaces & engines" },
  ],
  source:
    "ReciterAI: pipeline_grants/* · infra/{grants_task_definition,grants_task_iam_policy,eventbridge}.json · infra/README.md §Grants ingest launch path (cross-repo) — SPS: cdk/lib/etl-stack.ts:2073-2101 (metric + ≥21d alarm) · etl/dynamodb/grant-opportunity-etl.ts · etl/search-index/index.ts · lib/search.ts:102",
};
