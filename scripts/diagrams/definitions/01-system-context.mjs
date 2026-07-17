/**
 * View 1 — System context (the combined landscape).
 * Upstream sources -> scheduled ETL -> platform stores -> public + staff editors.
 * Sources laid out in TWO columns so the whole landscape fits one window.
 * Source: docs/architecture-overview.md, docs/dependency-outage-matrix.md.
 */
import { A } from "../lib.mjs";

// Two source columns (col A / col B) so the left rail is ~5 rows tall, not ~14.
const AX = 40, BX = 350, SW = 300, SH = 52; // col-A x, col-B x, source width, height

const nodes = {
  // ----- left: WCM source systems (2 cols × 5 rows) -----  (chip = ETL cadence)
  // Row pairs keep the source-to-source lineage arrows short & horizontal
  // (ASMS→ED on row 1, OnCore→ReciterDB on row 3).
  ed:     { x: AX, y: 150, w: SW, h: SH, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS · person types, appointments, headshots"], chip: { tone: "nightly", text: "nightly" } },
  asms:   { x: BX, y: 150, w: SW, h: SH, kind: "ext", title: "ASMS", sub: ["MS SQL · education, degrees"], chip: { tone: "nightly", text: "nightly" } },
  infoed: { x: AX, y: 210, w: SW, h: SH, kind: "ext", title: "InfoEd", sub: ["MS SQL · grants (funding)"], chip: { tone: "nightly", text: "nightly" } },
  coi:    { x: BX, y: 210, w: SW, h: SH, kind: "ext", title: "COI Portal", sub: ["MySQL · disclosures"], chip: { tone: "nightly", text: "nightly" } },
  rdb:    { x: AX, y: 270, w: SW, h: SH, kind: "ext", title: "ReciterDB", sub: ["MariaDB · publications, MeSH, clinical trials"], chip: { tone: "nightly", text: "nightly" } },
  onc:    { x: BX, y: 270, w: SW, h: SH, kind: "ext", title: "OnCore (CTMS)", sub: ["clinical-trial mgmt · investigators, status"], chip: { tone: "ondemand", text: "manual export" } },
  rai:    { x: AX, y: 330, w: SW, h: SH, kind: "ext", title: "ReciterAI", sub: ["DynamoDB + S3 · topics, spotlights"], chip: { tone: "weekly", text: "weekly" } },
  jenz:   { x: BX, y: 330, w: SW, h: SH, kind: "ext", title: "Jenzabar", sub: ["MS SQL · grad-school mentoring"], chip: { tone: "nightly", text: "nightly" } },
  hr:     { x: AX, y: 390, w: SW, h: SH, kind: "ext", title: "Human Resources", sub: ["employer / employee mentees"], chip: { tone: "planned", text: "planned" } },
  pops:   { x: BX, y: 390, w: SW, h: SH, kind: "ext", title: "POPS directory", sub: ["HTTPS · board certs, specialties, expertise"], chip: { tone: "nightly", text: "nightly" } },
  // ----- left: external (public HTTPS) (2 cols × 2 rows) -----
  ctgov:  { x: AX, y: 514, w: SW, h: SH, kind: "ext", title: "ClinicalTrials.gov", sub: ["HTTPS API v2 · NCT trial enrichment"], chip: { tone: "weekly", text: "weekly" } },
  nih:    { x: BX, y: 514, w: SW, h: SH, kind: "ext", title: "NIH RePORTER", sub: ["HTTPS · grant enrichment"], chip: { tone: "ondemand", text: "on-demand" } },
  nsf:    { x: AX, y: 574, w: SW, h: SH, kind: "ext", title: "NSF Awards", sub: ["HTTPS · federal awards"], chip: { tone: "ondemand", text: "on-demand" } },
  mesh:   { x: BX, y: 574, w: SW, h: SH, kind: "ext", title: "NLM MeSH", sub: ["HTTPS · taxonomy"], chip: { tone: "annual", text: "annual" } },
  ctl:    { x: AX, y: 634, w: SW, h: SH, kind: "ext", title: "CTL portfolio", sub: ["HTTPS · WCM licensable technologies"], chip: { tone: "weekly", text: "weekly" } },
  // ----- center: the platform -----
  etl:    { x: 738, y: 172, w: 320, h: 54, kind: "app", title: "ETL pipeline", sub: ["Step Functions · nightly / weekly / annual"] },
  aur:    { x: 738, y: 284, w: 154, h: 60, kind: "data", title: "Aurora MySQL", sub: ["canonical store"] },
  os:     { x: 904, y: 284, w: 154, h: 60, kind: "data", title: "OpenSearch", sub: ["search + autocomplete"] },
  app:    { x: 738, y: 400, w: 320, h: 56, kind: "app", title: "Next.js application", sub: ["public profiles + /edit"] },
  ovr:    { x: 738, y: 498, w: 320, h: 52, kind: "aws", title: "Manual-override layer", sub: ["staff edits survive every rebuild"] },
  // ----- right: audiences -----
  vis:    { x: 1162, y: 172, w: 326, h: 68, kind: "ext", title: "Public & research community", sub: ["~9,000 profiles · topics, depts", "search"] },
  crawl:  { x: 1162, y: 268, w: 326, h: 54, kind: "ext", title: "Search-engine crawlers", sub: ["sitemaps · SEO discovery"] },
  staff:  { x: 1162, y: 360, w: 326, h: 56, kind: "ext", title: "WCM staff editors", sub: ["SAML SSO -> /edit writes"] },
  idp:    { x: 1162, y: 468, w: 326, h: 68, kind: "aws", title: "WCM SAML IdP + Directory", sub: ["login-proxy · authn", "Enterprise Directory · authz"] },
};

const groups = [
  { x: 26, y: 118, w: 640, h: 344, kind: "ext", title: "WCM source systems" },
  { x: 26, y: 484, w: 640, h: 210, kind: "ext", title: "External data (HTTPS)" },
  { x: 706, y: 136, w: 384, h: 436, kind: "edge", title: "Scholars Profile System" },
  { x: 1138, y: 136, w: 372, h: 436, kind: "net", title: "Who it serves" },
];
const [gWcm, gExt, gSps] = groups;

const edges = [
  { p0: A(gWcm, "r", 0.5), p1: A(nodes.etl, "l", 0.3), color: "teal", label: "ingest" },
  { p0: A(gExt, "r", 0.5), p1: A(nodes.etl, "l", 0.72), color: "teal" },
  // ED also serves the headshot — fetched live at read time, bypassing the ETL.
  // Routed up-and-over the source rail (col-A nodes are boxed in by col B).
  { p0: A(nodes.ed, "t", 0.5), p1: A(nodes.app, "l", 0.4), color: "violet", dash: true, label: "headshot · read-time", lp: { x: 388, y: 100 }, points: [{ x: 190, y: 106 }, { x: 690, y: 106 }, { x: 690, y: 422 }] },
  // Clinical-trial lineage: ClinicalTrials.gov's NCT pull stages into reciterdb tables
  // (clinical_trials_enriched) that the ETL reads — it never flows straight to the ETL
  // like the other external sources, so a dashed arrow up the far-left channel corrects
  // its path (SPS never calls it; ReciterAI pulls it upstream). OnCore likewise stages
  // via reciterdb (footnote) — its own arrow is dropped in the 2-col layout because a
  // same-row connector is too short to read; the footnote carries that lineage.
  { p0: A(nodes.ctgov, "l", 0.5), p1: A(nodes.rdb, "l", 0.3), color: "gray", w: 1.5, dash: true, points: [{ x: 18, y: 540 }, { x: 18, y: 286 }] },
  { p0: A(nodes.etl, "b", 0.3), p1: A(nodes.aur, "t", 0.5), color: "teal" },
  { p0: A(nodes.etl, "b", 0.72), p1: A(nodes.os, "t", 0.5), color: "teal" },
  { p0: A(nodes.aur, "b", 0.5), p1: A(nodes.app, "t", 0.28), color: "gray", label: "read" },
  { p0: A(nodes.os, "b", 0.5), p1: A(nodes.app, "t", 0.72), color: "gray" },
  { p0: A(nodes.ovr, "t", 0.5), p1: A(nodes.app, "b", 0.5), color: "violet", label: "merge at read" },
  { p0: A(gSps, "r", 0.22), p1: A(nodes.vis, "l", 0.5), color: "maroon", label: "HTTPS via CDN" },
  { p0: A(gSps, "r", 0.42), p1: A(nodes.crawl, "l", 0.5), color: "maroon" },
  { p0: A(nodes.staff, "l", 0.5), p1: A(gSps, "r", 0.72), color: "indigo", label: "authenticated writes" },
  { p0: A(nodes.idp, "t", 0.5), p1: A(nodes.staff, "b", 0.5), color: "gray", label: "SSO" },
];

export const spec = { id: "system-context", vb: [1540, 724], groups, nodes, edges };

export const meta = {
  nav: "① System context",
  kicker: "View 1 · the combined landscape",
  heading: "System context",
  dot: "#7d1c1c",
  blurb:
    "The one-glance picture for newcomers and stakeholders: every displayed value is " +
    "<b>derived</b> — <b>20+ upstream connectors</b> feed a scheduled ETL into the platform's stores, " +
    "which the app serves to the public and to authenticated staff editors. Third-party sources live " +
    "<b>here</b>, in context, rather than in a diagram of their own.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Source / external actor" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Compute / pipeline" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "Override / identity" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "Platform boundary" },
  ],
  cadenceLegend: {
    title: "ETL refresh cadence — deployed Step Functions schedule (cdk/lib/etl-stack.ts)",
    items: [
      { tone: "nightly", label: "07:00 UTC daily" },
      { tone: "weekly", label: "Sun 08:00 UTC" },
      { tone: "annual", label: "Jul 1 + manual gate" },
      { tone: "ondemand", label: "not yet scheduled" },
      { tone: "planned", label: "planned · not yet built" },
    ],
  },
  footnote:
    "<b>Headshots</b> load live at read time straight from the WCM directory " +
    "(<code>directory.weill.cornell.edu</code>) — never stored, never via the ETL. " +
    "<b>On-demand</b> sources (RePORTER, NSF) aren't on a Step Functions cadence yet; " +
    "they run via the daily prototype chain. <b>Human Resources</b> (employer/employee mentees) is " +
    "a planned source, not yet built. <b>POPS</b> (the public <code>weillcornell.org</code> physician " +
    "directory) enriches clinical scholars with board certifications, specialties, and expertise " +
    "(<code>etl/pops/index.ts</code>) — it runs after Enterprise Directory (it keys off the " +
    "clinical-profile flag ED sets) and feeds the people search index; it rides the daily chain, not " +
    "yet a standalone Step Functions step. <b>Clinical trials</b> originate in <b>OnCore</b> (the CTMS — a " +
    "<b>manual</b> institutional export, static until the next export lands) and " +
    "are enriched against the <b>ClinicalTrials.gov</b> registry (API v2); both stage into reciterdb " +
    "tables (<code>clinical_trials</code> / <code>clinical_trials_enriched</code>, the latter pulled " +
    "upstream by ReciterAI) that the nightly ETL reads — SPS never calls ClinicalTrials.gov directly. " +
    "<b>CTL portfolio</b> (available technologies) is WCM's own Center for Technology Licensing, " +
    "scraped weekly from its public portal (<code>innovation.weill.cornell.edu</code>).",
  source: "docs/architecture-overview.md · cdk/lib/etl-stack.ts · lib/headshot.ts · ETL connectors in lib/sources/ · etl/pops/index.ts · docs/pops-clinical-search-spec.md · etl/clinical-trials/* · docs/clinical-trials-source-spec.md",
};
