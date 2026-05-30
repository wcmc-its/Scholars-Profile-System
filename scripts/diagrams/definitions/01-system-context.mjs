/**
 * View 1 — System context (the combined landscape).
 * Upstream sources -> scheduled ETL -> platform stores -> public + staff editors.
 * Source: docs/architecture-overview.md, docs/dependency-outage-matrix.md.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ----- left: WCM source systems -----  (chip = real ETL cadence per cdk/lib/etl-stack.ts)
  ed:     { x: 50, y: 128, w: 310, h: 54, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS · person types, appointments, headshots"], chip: { tone: "nightly", text: "nightly" } },
  infoed: { x: 50, y: 188, w: 310, h: 54, kind: "ext", title: "InfoEd", sub: ["MS SQL · grants (funding)"], chip: { tone: "nightly", text: "nightly" } },
  coi:    { x: 50, y: 248, w: 310, h: 54, kind: "ext", title: "COI Portal", sub: ["MySQL · disclosures"], chip: { tone: "nightly", text: "nightly" } },
  asms:   { x: 50, y: 308, w: 310, h: 54, kind: "ext", title: "ASMS", sub: ["MS SQL · education, degrees"], chip: { tone: "nightly", text: "nightly" } },
  jenz:   { x: 50, y: 368, w: 310, h: 54, kind: "ext", title: "Jenzabar", sub: ["MS SQL · grad-school mentoring"], chip: { tone: "ondemand", text: "on-demand" } },
  hr:     { x: 50, y: 428, w: 310, h: 54, kind: "ext", title: "Human Resources", sub: ["employer / employee mentees"], chip: { tone: "planned", text: "planned" } },
  rdb:    { x: 50, y: 488, w: 310, h: 54, kind: "ext", title: "ReciterDB", sub: ["MariaDB · publications, MeSH"], chip: { tone: "nightly", text: "nightly" } },
  rai:    { x: 50, y: 548, w: 310, h: 54, kind: "ext", title: "ReciterAI", sub: ["DynamoDB + S3 · topics, spotlights"], chip: { tone: "weekly", text: "weekly" } },
  // ----- left: external (public HTTPS) -----
  nih:    { x: 50, y: 668, w: 310, h: 54, kind: "ext", title: "NIH RePORTER", sub: ["HTTPS · grant enrichment"], chip: { tone: "ondemand", text: "on-demand" } },
  nsf:    { x: 50, y: 728, w: 310, h: 54, kind: "ext", title: "NSF Awards", sub: ["HTTPS · federal awards"], chip: { tone: "ondemand", text: "on-demand" } },
  mesh:   { x: 50, y: 788, w: 310, h: 54, kind: "ext", title: "NLM MeSH", sub: ["HTTPS · taxonomy"], chip: { tone: "annual", text: "annual" } },
  // ----- center: the platform -----
  etl:    { x: 536, y: 200, w: 312, h: 54, kind: "app", title: "ETL pipeline", sub: ["Step Functions · nightly / weekly / annual"] },
  aur:    { x: 536, y: 308, w: 150, h: 60, kind: "data", title: "Aurora MySQL", sub: ["canonical store"] },
  os:     { x: 698, y: 308, w: 150, h: 60, kind: "data", title: "OpenSearch", sub: ["search + autocomplete"] },
  app:    { x: 536, y: 418, w: 312, h: 56, kind: "app", title: "Next.js application", sub: ["public profiles + /edit"] },
  ovr:    { x: 536, y: 512, w: 312, h: 52, kind: "aws", title: "Manual-override layer", sub: ["staff edits survive every rebuild"] },
  // ----- right: audiences -----
  vis:    { x: 1032, y: 200, w: 306, h: 68, kind: "ext", title: "Public & research community", sub: ["~9,000 profiles · topics, depts", "search"] },
  crawl:  { x: 1032, y: 298, w: 306, h: 54, kind: "ext", title: "Search-engine crawlers", sub: ["sitemaps · SEO discovery"] },
  staff:  { x: 1032, y: 392, w: 306, h: 56, kind: "ext", title: "WCM staff editors", sub: ["SAML SSO -> /edit writes"] },
  idp:    { x: 1032, y: 496, w: 306, h: 68, kind: "aws", title: "WCM SAML IdP + Directory", sub: ["login-proxy · authn", "Enterprise Directory · authz"] },
};

const groups = [
  { x: 30, y: 96, w: 350, h: 516, kind: "ext", title: "WCM source systems" },
  { x: 30, y: 636, w: 350, h: 216, kind: "ext", title: "External data (HTTPS)" },
  { x: 506, y: 150, w: 372, h: 448, kind: "edge", title: "Scholars Profile System" },
  { x: 1012, y: 150, w: 346, h: 448, kind: "net", title: "Who it serves" },
];
const [gWcm, gExt, gSps] = groups;

const edges = [
  { p0: A(gWcm, "r", 0.5), p1: A(nodes.etl, "l", 0.32), color: "teal", label: "ingest (20+ connectors)" },
  { p0: A(gExt, "r", 0.5), p1: A(nodes.etl, "l", 0.7), color: "teal" },
  // ED also serves the headshot — fetched live at read time, bypassing the ETL.
  { p0: A(nodes.ed, "r"), p1: A(nodes.app, "l", 0.45), color: "violet", dash: true, label: "headshot · read-time", lp: { x: 488, y: 300 }, points: [{ x: 488, y: 155 }, { x: 488, y: 443 }] },
  // ASMS -> Enterprise Directory (source-to-source link), routed up the column's left channel.
  { p0: A(nodes.asms, "l"), p1: A(nodes.ed, "l"), color: "gray", w: 1.5, points: [{ x: 44, y: 335 }, { x: 44, y: 155 }] },
  { p0: A(nodes.etl, "b", 0.3), p1: A(nodes.aur, "t", 0.5), color: "teal" },
  { p0: A(nodes.etl, "b", 0.72), p1: A(nodes.os, "t", 0.5), color: "teal" },
  { p0: A(nodes.aur, "b", 0.5), p1: A(nodes.app, "t", 0.28), color: "gray", label: "read" },
  { p0: A(nodes.os, "b", 0.5), p1: A(nodes.app, "t", 0.72), color: "gray" },
  { p0: A(nodes.ovr, "t", 0.5), p1: A(nodes.app, "b", 0.5), color: "violet", label: "merge at read" },
  { p0: A(gSps, "r", 0.22), p1: A(nodes.vis, "l", 0.5), color: "maroon", label: "HTTPS via CDN" },
  { p0: A(gSps, "r", 0.4), p1: A(nodes.crawl, "l", 0.5), color: "maroon" },
  { p0: A(nodes.staff, "l", 0.5), p1: A(gSps, "r", 0.72), color: "indigo", label: "authenticated writes" },
  { p0: A(nodes.idp, "t", 0.5), p1: A(nodes.staff, "b", 0.5), color: "gray", label: "SSO" },
];

export const spec = { id: "system-context", vb: [1380, 884], groups, nodes, edges };

export const meta = {
  nav: "① System context",
  kicker: "View 1 · the combined landscape",
  heading: "System context",
  dot: "#7d1c1c",
  blurb:
    "The one-glance picture for newcomers and stakeholders: every displayed value is " +
    "<b>derived</b> — upstream systems feed a scheduled ETL into the platform's stores, which the " +
    "app serves to the public and to authenticated staff editors. Third-party sources live " +
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
    "<b>On-demand</b> sources (Jenzabar, RePORTER, NSF) aren't on a Step Functions cadence yet; " +
    "they run via the daily prototype chain. <b>Human Resources</b> (employer/employee mentees) is " +
    "a planned source, not yet built.",
  source: "docs/architecture-overview.md · cdk/lib/etl-stack.ts · lib/headshot.ts · ETL connectors in lib/sources/",
};
