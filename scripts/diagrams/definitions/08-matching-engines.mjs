/**
 * View 8 — Matching surfaces & engines.
 * Who asks, which engine answers, and what each engine reads. Three surfaces
 * (Grant Matcha admin, the frozen /edit/matcha people search, the self-service
 * grants-for-me card) over three engines (the two Matcha spines and the
 * no-LLM forward matcher), over the retrieval, data + model plane (both
 * OpenSearch indexes, Aurora, Bedrock). The route persists each people-target
 * answer (SponsorMatchSubmission.result, #2630) and replays it with an asOf date.
 * Post-Phase-3 (2026-08-20): /edit/find-researchers and its structured
 * reverse matcher are retired; the client-side eligibility rail is the single
 * owner of researcher-eligibility gating.
 * Source: lib/api/matcha-spine-run.ts · lib/api/matcha-grants-spine.ts ·
 *         lib/api/match-opportunities.ts · lib/api/reason-agg-cache.ts (cache) ·
 *         app/api/edit/matcha/route.ts · prisma/schema.prisma (SponsorMatchSubmission.result/resultKey) ·
 *         app/edit/grant-matcha/page.tsx · components/edit/grant-matcha-panel.tsx ·
 *         components/edit/grant-recs-card.tsx · cdk/lib/app-stack.ts (flags).
 */
import { A } from "../lib.mjs";

const nodes = {
  // ----- surfaces -----
  gmB:  { x: 40, y: 168, w: 440, h: 92, kind: "app", title: "/edit/grant-matcha", sub: ["Browse + suppress · Submissions intake", "selected view: synopsis + facts line -> seeded ask", "GRANT_MATCHA on · MATCHA_ADMIN staging-only"], chip: { tone: "live", text: "admin + dev role" } },
  mat:  { x: 520, y: 168, w: 440, h: 92, kind: "app", title: "/edit/matcha", sub: ["plain-text ask -> researchers", "scope frozen (owner call 07-22):", "no targets, no toggles"] },
  recs: { x: 1000, y: 168, w: 460, h: 92, kind: "app", title: "Grants-for-me card", sub: ["/edit/scholar?attr=grant-recs", "SELF_EDIT_GRANT_RECS: staging on, prod off"], chip: { tone: "planned", text: "staging-only" } },

  // ----- interposers -----
  rail: { x: 40, y: 300, w: 440, h: 72, kind: "net", title: "Eligibility rail (client-side)", sub: ["career-stage hard gate · ESI soft boost (esiEligible)", "sole owner since the find-researchers sunset"] },
  rt:   { x: 520, y: 300, w: 440, h: 72, kind: "app", title: "POST /api/edit/matcha", sub: ["stored answer first (asOf) · miss -> cachedReasonAgg 5/30min", "Re-run = fresh:true · no expiry · people target only"], chip: { tone: "live", text: "answers persisted" } },

  // ----- engines -----
  spR:  { x: 40, y: 420, w: 440, h: 88, kind: "app", title: "rankResearchersForDescriptionSpine", sub: ["ask -> researchers · extract -> MeSH resolve", "-> cluster retrieval -> RRF fuse", "lib/api/matcha-spine-run.ts"] },
  spG:  { x: 520, y: 420, w: 440, h: 88, kind: "app", title: "rankGrantsForDescriptionSpine", sub: ["ask -> opportunities (target: grants)", "leaner sibling · lib/api/matcha-grants-spine.ts"] },
  fwd:  { x: 1000, y: 420, w: 460, h: 88, kind: "app", title: "matchOpportunitiesForScholar", sub: ["scholar -> opportunities · NO LLM", "precomputed vectors + DSL retrieval", "lib/api/match-opportunities.ts"] },

  // ----- retrieval + model plane -----
  osp:  { x: 40, y: 592, w: 330, h: 72, kind: "data", title: "scholars-people", sub: ["OpenSearch · researcher cluster", "retrieval · scholar MeSH fingerprint"] },
  aur:  { x: 400, y: 592, w: 330, h: 72, kind: "data", title: "Aurora (MySQL)", sub: ["MeSH/topics · scholar hydration · grants", "persisted answers (SponsorMatchSubmission)"] },
  bed:  { x: 760, y: 592, w: 330, h: 72, kind: "aws", title: "Bedrock · Claude Sonnet", sub: ["extraction + gloss · billed per ask", "no cheap tier"] },
  osi:  { x: 1120, y: 592, w: 330, h: 72, kind: "data", title: "scholars-opportunities", sub: ["OpenSearch · opportunity retrieval", "suppression lags one nightly"] },
};

const groups = [
  { x: 26, y: 118, w: 1454, h: 158, kind: "edge", title: "Surfaces (/edit)" },
  { x: 26, y: 282, w: 1454, h: 244, kind: "app", title: "Matching engines · lib/api", fo: 0.05 },
  { x: 26, y: 560, w: 1454, h: 186, kind: "data", title: "Retrieval & data plane", fo: 0.08 },
];

const edges = [
  // asks down
  { p0: A(nodes.gmB, "b", 0.75), p1: A(nodes.rt, "t", 0.2), color: "indigo", label: "seeded ask + eligibilitySignals", lp: { x: 470, y: 284 } },
  { p0: A(nodes.mat, "b", 0.6), p1: A(nodes.rt, "t", 0.6), color: "indigo", label: "plain ask" },
  { p0: A(nodes.rt, "l", 0.85), p1: A(nodes.spR, "t", 0.9), color: "teal", label: "people target", lp: { x: 420, y: 396 } },
  { p0: A(nodes.rt, "b", 0.85), p1: A(nodes.spG, "t", 0.6), color: "teal", dash: true, label: "grants target · not persisted · no UI consumer yet", lp: { x: 812, y: 396 } },
  { p0: A(nodes.recs, "b", 0.5), p1: A(nodes.fwd, "t", 0.5), color: "indigo", label: "GET /api/scholars/[cwid]/opportunities" },
  // results back up through the rail
  { p0: A(nodes.spR, "t", 0.15), p1: A(nodes.rail, "b", 0.15), color: "gray", label: "ranked rows + esiEligible", lp: { x: 168, y: 396 } },
  { p0: A(nodes.rail, "t", 0.5), p1: A(nodes.gmB, "b", 0.25), color: "gray", label: "gated + boosted", lp: { x: 290, y: 283 } },
  // the route's persisted answer
  { p0: A(nodes.rt, "b", 0.04), p1: { x: 500, y: 592, nx: 0, ny: -1 }, points: [{ x: 538, y: 386 }, { x: 500, y: 400 }], color: "gray", label: "stored answer: read / persist", lp: { x: 512, y: 546 } },
  // what each engine reads
  { p0: A(nodes.spR, "b", 0.5), p1: A(nodes.osp, "t", 220 / 330), color: "teal", label: "retrieveCluster", lp: { x: 260, y: 536 } },
  { p0: A(nodes.spR, "b", 0.82), p1: A(nodes.aur, "t", 0.05), color: "teal", label: "hydrate + esiEligible", lp: { x: 410, y: 576 } },
  { p0: A(nodes.spR, "b", 0.95), p1: A(nodes.bed, "t", 0.04), color: "violet", label: "extract + gloss", lp: { x: 712, y: 551 } },
  { p0: A(nodes.spG, "b", 0.65), p1: A(nodes.bed, "t", 0.14), color: "violet" },
  { p0: A(nodes.spG, "b", 0.92), p1: A(nodes.osi, "t", 0.08), color: "teal", label: "retrieveClusterGrants", lp: { x: 1000, y: 540 } },
  { p0: A(nodes.fwd, "b", 0.3), p1: A(nodes.osi, "t", 0.3), color: "teal", label: "candidate retrieval" },
  // forward matcher's scholar-side reads, bussed under the plane
  { p0: A(nodes.fwd, "r", 0.45), p1: A(nodes.aur, "b", 0.5), points: [{ x: 1500, y: 460 }, { x: 1500, y: 694 }, { x: 565, y: 694 }], color: "teal", label: "topic vector + career stage", lp: { x: 1000, y: 694 } },
  { p0: A(nodes.fwd, "r", 0.7), p1: A(nodes.osp, "b", 0.5), points: [{ x: 1516, y: 482 }, { x: 1516, y: 722 }, { x: 205, y: 722 }], color: "teal", w: 1.3, label: "MeSH fingerprint (publicationMeshUi)", lp: { x: 860, y: 722 } },
];

export const spec = { id: "matching-engines", vb: [1540, 770], groups, nodes, edges };

export const meta = {
  nav: "⑧ Matching engines",
  kicker: "View 8 · who asks, which engine answers",
  heading: "Matching surfaces & engines",
  dot: "#4263eb",
  blurb:
    "The three grant-matching surfaces and the engine each one rides: Grant Matcha's seeded ask and " +
    "/edit/matcha's plain ask share the <b>people spine</b> (LLM extraction → cluster retrieval → RRF " +
    "fuse), the dark <b>grants target</b> awaits a UI consumer, and the self-service card uses the " +
    "<b>no-LLM forward matcher</b> over the opportunities index plus the scholar's Aurora topics and " +
    "MeSH fingerprint. The route <b>persists each people-target answer</b> in Aurora and replays it " +
    "with an asOf date until Re-run. Eligibility is deliberately split: " +
    "“what a grant requires” is extracted upstream by ReciterAI; “does this researcher " +
    "qualify” is the client-side rail — the single owner since the find-researchers sunset, " +
    "fed by the <code>esiEligible</code> signal the people spine derives from Aurora on the grant-matcha path only.",
  legend: [
    { fill: "#e3faf3", stroke: "#0ca678", label: "Surface / engine" },
    { fill: "#e7f5ff", stroke: "#1c7ed6", label: "Client-side gate" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store (index / Aurora)" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "LLM (Bedrock)" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "/edit boundary" },
  ],
  edgeLegend: [
    { color: "indigo", label: "user ask / request" },
    { color: "teal", label: "engine dispatch / retrieval" },
    { color: "gray", label: "ranked results / stored answer" },
    { color: "violet", label: "LLM call" },
    { color: "teal", dash: true, label: "built, dark (no consumer)" },
  ],
  footnote:
    "<b>Retired 2026-08-20 (Phase 3):</b> <code>/edit/find-researchers</code> and its structured " +
    "reverse matcher (<code>rankResearchersForOpportunity</code> survives only for two measurement " +
    "scripts); its abstain floor (<code>GRANT_MATCHER_ABSTAIN_FLOOR</code>) is deleted outright — " +
    "the ask card's thin-match caution (from <code>assessMatchSignal</code>) is the surviving " +
    "low-signal warning. <b>Suppression semantics:</b> browse/detail hide a suppressed opportunity " +
    "immediately (Aurora reads); index-backed surfaces — both spines' retrieval and the forward " +
    "matcher — lag by one nightly rebuild, stated in the suppress dialog. <b>Cost shape:</b> every " +
    "spine ask bills Bedrock Sonnet (the task role is deliberately scoped to Opus/Sonnet only — " +
    "there is no cheap-model tier), which is why the in-RAM result cache and the persisted per-search " +
    "answer (#2630: served with an asOf date, Re-run forces a fresh run, no expiry; degraded runs are " +
    "never stored) exist. The <b>grants spine</b> serves <code>target:“grants”</code> behind " +
    "GRANT_MATCHA with its own cache namespace and is not persisted; its result-card UI was deliberately reverted " +
    "pending the convergence eval.",
  seeAlso: [
    { id: "grant-matching-context", label: "⑥ Grant matching · context" },
    { id: "opportunity-pipeline", label: "⑦ Corpus pipeline & freshness" },
    { id: "app-internals", label: "⑤ App internals" },
  ],
  source:
    "lib/api/matcha-spine-run.ts · lib/api/matcha-grants-spine.ts · lib/api/match-opportunities.ts · lib/api/reason-agg-cache.ts (cachedReasonAgg, via app/api/edit/matcha/route.ts) · prisma/schema.prisma (SponsorMatchSubmission.result/resultKey) · components/edit/grant-matcha-panel.tsx · components/edit/opportunity-browse.tsx · components/edit/grant-recs-card.tsx · cdk/lib/app-stack.ts (GRANT_MATCHA / MATCHA_ADMIN / SELF_EDIT_GRANT_RECS) · cdk/lib/app-stack.ts TaskRoleBedrockPolicy",
};
