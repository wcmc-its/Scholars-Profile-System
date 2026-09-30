/**
 * View 6 — Grant matching: system context.
 * Funding-opportunity sources -> ReciterAI's pipeline_grants -> the account-shared
 * corpus stores -> SPS's nightly projection + matching surfaces -> who uses them.
 * One-glance view of the whole grant-matching subsystem; the supply-chain detail
 * lives in view 7, the engines in view 8.
 * Source: ReciterAI pipeline_grants/* + infra/*.json (cross-repo) ·
 *         cdk/lib/etl-stack.ts · etl/dynamodb/grant-opportunity-etl.ts ·
 *         app/edit/grant-matcha/page.tsx · components/edit/grant-recs-card.tsx.
 */
import { A } from "../lib.mjs";

const SW = 288, SH = 56; // source node width/height

const nodes = {
  // ----- left: where opportunities come from -----
  gg:   { x: 40, y: 168, w: SW, h: SH, kind: "ext", title: "Grants.gov", sub: ["public API · federal opportunities"], chip: { tone: "nightly", text: "daily 03:00 UTC" } },
  spin: { x: 40, y: 236, w: SW, h: SH, kind: "ext", title: "SPIN (InfoEd)", sub: ["licensed API · 113 target funders"], chip: { tone: "ondemand", text: "manual · ToS-gated" } },
  fdb:  { x: 40, y: 304, w: SW, h: SH, kind: "ext", title: "WCM funding DB", sub: ["curated CSV · crawler retired"], chip: { tone: "ondemand", text: "frozen" } },
  staff:{ x: 40, y: 402, w: SW, h: SH, kind: "ext", title: "Development-office staff", sub: ["paste opportunity URLs into /edit"] },

  // ----- center-left: ReciterAI produces the corpus -----
  evb:  { x: 402, y: 150, w: 296, h: 54, kind: "aws", title: "EventBridge", sub: ["reciterai-grants-daily · cron(0 3 * * ? *)"] },
  task: { x: 402, y: 244, w: 296, h: 78, kind: "app", title: "Fargate · reciterai-grants", sub: ["pipeline_grants.ingest ;", "pipeline_grants.ingest_submissions"], chip: { tone: "nightly", text: "daily" } },
  judge:{ x: 402, y: 362, w: 296, h: 56, kind: "aws", title: "Bedrock judge / scorer", sub: ["is_research · relevance · topic scores"] },

  // ----- center: the account-shared corpus stores -----
  ddb:  { x: 792, y: 190, w: 288, h: 72, kind: "data", title: "DynamoDB · reciterai", sub: ["GRANT# corpus items", "SUBMISSION intake queue"] },
  s3:   { x: 792, y: 314, w: 288, h: 64, kind: "data", title: "S3 · wcmc-reciterai-artifacts", sub: ["grants/latest — sweep-only publish"] },

  // ----- center-right: SPS consumes + serves -----
  proj: { x: 1170, y: 150, w: 306, h: 56, kind: "app", title: "SPS nightly projection", sub: ["etl:dynamodb · cron(0 7 * * ? *)"], chip: { tone: "nightly", text: "07:00 UTC" } },
  aur:  { x: 1170, y: 244, w: 306, h: 56, kind: "data", title: "Aurora · opportunity", sub: ["suppressedAt survives every upsert"] },
  osi:  { x: 1170, y: 338, w: 306, h: 54, kind: "data", title: "scholars-opportunities", sub: ["OpenSearch · matching retrieval"] },
  gm:   { x: 1170, y: 470, w: 306, h: 72, kind: "app", title: "/edit/grant-matcha", sub: ["Browse + suppress · Submissions intake", "seeded Matcha ask + fact rail"] },
  recs: { x: 1170, y: 578, w: 306, h: 56, kind: "app", title: "Grants-for-me card", sub: ["/edit/scholar · self-service"], chip: { tone: "planned", text: "staging-only flag" } },

  // ----- freshness guardrail -----
  fresh:{ x: 792, y: 472, w: 288, h: 72, kind: "aws", title: "Corpus freshness alarm", sub: ["OpportunityCorpusIngestAgeDays", ">= 21 days -> etl-failures topic"] },
};

const groups = [
  { x: 26, y: 118, w: 320, h: 262, kind: "ext", title: "Funding-opportunity sources" },
  { x: 26, y: 380, w: 320, h: 96, kind: "ext", title: "Human intake" },
  { x: 384, y: 118, w: 332, h: 318, kind: "app", title: "ReciterAI · pipeline_grants" },
  { x: 772, y: 118, w: 328, h: 278, kind: "data", title: "Shared corpus stores", fo: 0.08 },
  { x: 1148, y: 118, w: 352, h: 292, kind: "edge", title: "Scholars Profile System" },
  { x: 1148, y: 434, w: 352, h: 216, kind: "net", title: "Matching surfaces" },
  { x: 772, y: 438, w: 328, h: 118, kind: "aws", title: "Guardrail · SPS etl-stack", fo: 0.05 },
];
const gSrc = groups[0];

const edges = [
  { p0: A(gSrc, "r", 0.5), p1: A(nodes.task, "l", 0.4), color: "teal", label: "fetch" },
  { p0: A(nodes.evb, "b", 0.5), p1: A(nodes.task, "t", 0.5), color: "violet", label: "RunTask" },
  { p0: A(nodes.task, "b", 0.5), p1: A(nodes.judge, "t", 0.5), color: "violet", label: "per item" },
  { p0: A(nodes.task, "r", 0.35), p1: A(nodes.ddb, "l", 0.5), color: "amber", label: "persist GRANT#" },
  { p0: A(nodes.task, "r", 0.8), p1: A(nodes.s3, "l", 0.5), color: "amber", label: "sweep publish", dash: true },
  // Staff intake loop: SPS panel writes the SUBMISSION queue; the daily drain consumes it.
  { p0: A(nodes.staff, "r", 0.5), p1: A(nodes.gm, "b", 0.15), color: "indigo", label: "paste URL (Submissions tab)", lp: { x: 620, y: 700 }, points: [{ x: 620, y: 682 }, { x: 1520, y: 682 }, { x: 1520, y: 560 }] },
  { p0: A(nodes.gm, "l", 0.75), p1: A(nodes.ddb, "b", 0.72), color: "indigo", label: "SUBMISSION queue", lp: { x: 1010, y: 610 }, dash: true, points: [{ x: 1122, y: 520 }, { x: 1122, y: 300 }] },
  { p0: A(nodes.ddb, "r", 0.35), p1: A(nodes.proj, "l", 0.5), color: "teal", label: "project" },
  { p0: A(nodes.proj, "b", 0.5), p1: A(nodes.aur, "t", 0.5), color: "teal", label: "upsert" },
  { p0: A(nodes.aur, "b", 0.5), p1: A(nodes.osi, "t", 0.5), color: "teal", label: "index rebuild" },
  { p0: A(nodes.proj, "l", 0.85), p1: A(nodes.fresh, "t", 0.6), color: "gray", dash: true, label: "emit age metric", lp: { x: 1130, y: 340 }, points: [{ x: 1130, y: 230 }, { x: 1130, y: 452 }] },
  { p0: A(nodes.osi, "b", 0.5), p1: A(nodes.gm, "t", 0.35), color: "maroon", label: "retrieve", lp: { x: 1352, y: 446 } },
  { p0: A(nodes.aur, "r", 0.5), p1: A(nodes.gm, "r", 0.3), color: "maroon", dash: true, label: "browse + detail", lp: { x: 1436, y: 421 }, points: [{ x: 1502, y: 272 }, { x: 1502, y: 492 }] },
  { p0: A(nodes.gm, "b", 0.5), p1: A(nodes.recs, "t", 0.5), color: "gray" },
];

export const spec = { id: "grant-matching-context", vb: [1540, 730], groups, nodes, edges };

export const meta = {
  nav: "⑥ Grant matching · context",
  kicker: "View 6 · the grant-matching subsystem at a glance",
  heading: "Grant matching — system context",
  dot: "#0ca678",
  blurb:
    "How a funding opportunity travels from its source to a researcher's screen: <b>ReciterAI's " +
    "pipeline_grants</b> fetches, judges, and persists the corpus into <b>account-shared stores</b> " +
    "(DynamoDB <code>reciterai</code> + S3), SPS's <b>nightly projection</b> mirrors it into Aurora and " +
    "the <code>scholars-opportunities</code> index, and the <b>Grant Matcha surfaces</b> serve it — with " +
    "a staff intake loop feeding URLs back into the same pipeline, and a freshness alarm watching the " +
    "whole supply chain.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Source / actor" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Compute / pipeline" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "AWS managed / LLM" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "SPS boundary" },
  ],
  edgeLegend: [
    { color: "teal", label: "corpus flow (fetch / project / index)" },
    { color: "amber", label: "persist" },
    { color: "indigo", label: "staff intake loop" },
    { color: "maroon", label: "read path to surfaces" },
    { color: "violet", label: "schedule / LLM call" },
  ],
  footnote:
    "<b>Cadences:</b> the ReciterAI ingest runs daily at 03:00 UTC (EventBridge → Fargate, " +
    "<code>reciterai-grants</code>, shipped 2026-08-20 closing ReciterAI#269's gap); SPS projects at " +
    "07:00 UTC — a 4-hour launch gap, measured on first tick. <b>SPIN</b> is manual-only until the " +
    "license question on scheduled bulk pulls clears (its weekly rule is spec'd but deliberately " +
    "unshipped). <b>WCM funding DB</b> is frozen — its one-off crawler left no code; SPIN overlap is " +
    "being measured before deciding rebuild vs retire. The <b>submission drain is DynamoDB-only</b>: " +
    "it never publishes the S3 artifact (a per-run publish would trip the sweep's shrink guard). " +
    "<b>Suppression</b> is a soft-delete the nightly upsert can never resurrect — the upsert's column " +
    "list simply never names the three <code>suppress*</code> columns. The <b>grants-for-me card</b> " +
    "rides <code>SELF_EDIT_GRANT_RECS</code> (staging-on, prod-off).",
  seeAlso: [
    { id: "opportunity-pipeline", label: "⑦ Corpus pipeline & freshness" },
    { id: "matching-engines", label: "⑧ Matching surfaces & engines" },
    { id: "system-context", label: "① System context" },
  ],
  source:
    "ReciterAI: pipeline_grants/{ingest,ingest_spin,ingest_submissions}.py · infra/grants_task_definition.json · infra/eventbridge.json (cross-repo, verified 2026-08-20) — SPS: cdk/lib/etl-stack.ts (07:00 cron, ≥21d alarm) · etl/dynamodb/grant-opportunity-etl.ts · app/edit/grant-matcha/page.tsx · components/edit/grant-recs-card.tsx · cdk/lib/app-stack.ts (flags)",
};
