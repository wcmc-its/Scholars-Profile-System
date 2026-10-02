/**
 * View 1 — System context (the combined landscape).
 * Upstream sources -> scheduled ETL -> platform stores -> public + staff editors.
 * Sources laid out in TWO columns so the whole landscape fits one window.
 * Source: docs/architecture-overview.md, docs/dependency-outage-matrix.md, cdk/lib/etl-stack.ts.
 */
import { A } from "../lib.mjs";

// Two source columns (col A / col B) so the left rail is ~6 rows tall, not ~12.
const AX = 40, BX = 350, SW = 300, SH = 52; // col-A x, col-B x, source width, height

const nodes = {
  // ----- left: WCM source systems (2 cols × 6 rows) -----  (chip = ETL cadence)
  // Col B holds the three sources with a second, platform-to-source edge, so each
  // of those edges is a short horizontal hop across the gap with no crossings:
  // Identity (ORCID push, row 1), ReciterAI (app write-back, row 4) and the
  // Enterprise Directory (read-time headshot, row 5, level with the app).
  rdb:    { x: AX, y: 150, w: SW, h: SH, kind: "ext", title: "ReciterDB", sub: ["MariaDB · pubs, COI stmts, trials, datasets, JIF"], chip: { tone: "nightly", text: "nightly" } },
  ident:  { x: BX, y: 150, w: SW, h: SH, kind: "ext", title: "WCM Identity (ReCiter)", sub: ["DynamoDB · ORCID iDs (read + push-back)"], chip: { tone: "nightly", text: "nightly" } },
  infoed: { x: AX, y: 210, w: SW, h: SH, kind: "ext", title: "InfoEd", sub: ["MS SQL · grants (funding)"], chip: { tone: "nightly", text: "nightly" } },
  coi:    { x: BX, y: 210, w: SW, h: SH, kind: "ext", title: "COI Portal", sub: ["MS SQL · disclosures (server shared w/ FRT)"], chip: { tone: "nightly", text: "nightly" } },
  jenz:   { x: AX, y: 270, w: SW, h: SH, kind: "ext", title: "Jenzabar", sub: ["MS SQL · grad-school mentoring"], chip: { tone: "nightly", text: "nightly" } },
  frt:    { x: BX, y: 270, w: SW, h: SH, kind: "ext", title: "Faculty Review Tool", sub: ["MS SQL (COI server) · mentee self-reports"], chip: { tone: "weekly", text: "weekly" } },
  onc:    { x: AX, y: 330, w: SW, h: SH, kind: "ext", title: "OnCore (CTMS)", sub: ["clinical-trial mgmt · investigators, status"], chip: { tone: "ondemand", text: "manual export" } },
  rai:    { x: BX, y: 330, w: SW, h: SH, kind: "ext", title: "ReciterAI", sub: ["DynamoDB + S3 · scores, topics, spotlights"], chip: { tone: "nightly", text: "nightly + weekly" } },
  asms:   { x: AX, y: 390, w: SW, h: SH, kind: "ext", title: "ASMS", sub: ["MS SQL · education, degrees"], chip: { tone: "nightly", text: "nightly" } },
  ed:     { x: BX, y: 390, w: SW, h: SH, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS · appointments, headshots, HR postdoc mentors"], chip: { tone: "nightly", text: "nightly" } },
  ctsc:   { x: AX, y: 450, w: SW, h: SH, kind: "ext", title: "CTSC roster feed", sub: ["HTTPS · CTSC center roster (not publications)"], chip: { tone: "nightly", text: "nightly" } },
  pops:   { x: BX, y: 450, w: SW, h: SH, kind: "ext", title: "POPS directory", sub: ["HTTPS · board certs, specialties, expertise"], chip: { tone: "weekly", text: "weekly" } },
  // ----- left: external (public HTTPS) (2 cols × 3 rows) -----
  ctgov:  { x: AX, y: 574, w: SW, h: SH, kind: "ext", title: "ClinicalTrials.gov", sub: ["HTTPS API v2 · live NCT enrichment"], chip: { tone: "weekly", text: "weekly" } },
  grants: { x: BX, y: 574, w: SW, h: SH, kind: "ext", title: "NIH RePORTER · NSF · Gates", sub: ["HTTPS · PI profiles, award enrichment"], chip: { tone: "weekly", text: "weekly" } },
  mesh:   { x: AX, y: 634, w: SW, h: SH, kind: "ext", title: "PubMed + NLM MeSH", sub: ["E-utils retractions · MeSH tree (on-demand)"], chip: { tone: "nightly", text: "nightly" } },
  honors: { x: BX, y: 634, w: SW, h: SH, kind: "ext", title: "Honor-society rosters", sub: ["public lists · pending curator queue"], chip: { tone: "weekly", text: "weekly (Mon)" } },
  ctl:    { x: AX, y: 694, w: SW, h: SH, kind: "ext", title: "CTL portfolio", sub: ["HTTPS · WCM licensable technologies"], chip: { tone: "weekly", text: "weekly" } },
  news:   { x: BX, y: 694, w: SW, h: SH, kind: "ext", title: "WCM Newsroom + clips", sub: ["feed.json weekly · EA clips email nightly"], chip: { tone: "weekly", text: "weekly" } },
  // ----- center: the platform -----
  etl:    { x: 738, y: 172, w: 320, h: 54, kind: "app", title: "ETL pipeline", sub: ["Step Functions · nightly/weekly/annual/honors"] },
  aur:    { x: 738, y: 284, w: 154, h: 60, kind: "data", title: "Aurora MySQL", sub: ["canonical store"] },
  os:     { x: 904, y: 284, w: 154, h: 60, kind: "data", title: "OpenSearch", sub: ["search + autocomplete"] },
  app:    { x: 738, y: 388, w: 320, h: 56, kind: "app", title: "Next.js application", sub: ["public profiles + /edit"] },
  ovr:    { x: 738, y: 498, w: 320, h: 52, kind: "aws", title: "Manual-override layer", sub: ["staff edits survive every rebuild"] },
  // ----- right: audiences -----
  vis:    { x: 1162, y: 180, w: 326, h: 68, kind: "ext", title: "Public & research community", sub: ["~9,000 profiles · topics, depts, search", "+ search-engine crawlers (sitemaps)"] },
  staff:  { x: 1162, y: 324, w: 326, h: 56, kind: "ext", title: "WCM staff editors", sub: ["SAML SSO -> /edit writes"] },
  idp:    { x: 1162, y: 444, w: 326, h: 68, kind: "aws", title: "WCM SAML IdP + Directory", sub: ["login-proxy · authn", "Enterprise Directory · authz"] },
};

const groups = [
  { x: 26, y: 118, w: 640, h: 404, kind: "ext", title: "WCM source systems" },
  { x: 26, y: 544, w: 640, h: 210, kind: "ext", title: "External data (HTTPS)" },
  { x: 706, y: 136, w: 384, h: 436, kind: "edge", title: "Scholars Profile System" },
  { x: 1138, y: 136, w: 372, h: 436, kind: "net", title: "Who it serves" },
];
// The old over-the-top headshot route needed a ~60px top margin; it is gone, so
// lift the whole layout (nodes + groups) instead of re-typing every y.
const DY = 60;
for (const b of [...Object.values(nodes), ...groups]) b.y -= DY;
const [gWcm, gExt, gSps] = groups;

const edges = [
  { p0: A(gWcm, "r", 0.5), p1: A(nodes.etl, "l", 0.35), color: "teal", label: "ingest" },
  // ClinicalTrials.gov now flows like the other HTTPS sources: the weekly
  // etl:clinical-trials step fetches each NCT live (#2769), so it rides this arrow.
  { p0: A(gExt, "r", 0.5), p1: A(nodes.etl, "l", 0.75), color: "teal" },
  // The two places data flows back UP to a source system (dashed violet), plus the
  // read-time headshot. Each is a level hop across the gap, so labels stay short.
  { p0: A(nodes.etl, "l", 0.08), p1: A(nodes.ident, "r", 0.5), color: "violet", dash: true, label: "ORCID push" },
  { p0: A(nodes.app, "l", 0.1), p1: A(nodes.rai, "r", 0.8), color: "violet", dash: true, label: "write-back", lp: { x: 694, y: 380 - DY } },
  // ED also serves the headshot — fetched live at read time, bypassing the ETL.
  { p0: A(nodes.ed, "r", 0.5), p1: A(nodes.app, "l", 0.5), color: "violet", dash: true, label: "headshot" },
  { p0: A(nodes.etl, "b", 0.3), p1: A(nodes.aur, "t", 0.5), color: "teal" },
  { p0: A(nodes.etl, "b", 0.72), p1: A(nodes.os, "t", 0.5), color: "teal" },
  { p0: A(nodes.aur, "b", 0.5), p1: A(nodes.app, "t", 0.28), color: "gray", label: "read" },
  { p0: A(nodes.os, "b", 0.5), p1: A(nodes.app, "t", 0.72), color: "gray" },
  { p0: A(nodes.ovr, "t", 0.5), p1: A(nodes.app, "b", 0.5), color: "violet", label: "merge at read" },
  { p0: A(gSps, "r", 0.22), p1: A(nodes.vis, "l", 0.5), color: "maroon", label: "via CDN" },
  { p0: A(nodes.staff, "l", 0.5), p1: A(gSps, "r", 0.6), color: "indigo", label: "edits" },
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
    "which the app serves to the public and to authenticated staff editors. Dashed violet arrows are " +
    "the few flows that run the other way. Third-party sources live " +
    "<b>here</b>, in context, rather than in a diagram of their own.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Source / external actor" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Compute / pipeline" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "Override / identity · write-back (dashed)" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "Platform boundary" },
  ],
  cadenceLegend: {
    title: "ETL refresh cadence — deployed Step Functions schedule (cdk/lib/etl-stack.ts)",
    items: [
      { tone: "nightly", label: "07:00 UTC daily (staging 07:45)" },
      { tone: "weekly", label: "Sun 12:00 UTC (honors: Mon 10:00)" },
      { tone: "ondemand", label: "manual / on-demand" },
    ],
  },
  footnote:
    "<b>Headshots</b> load live at read time straight from the WCM directory " +
    "(<code>directory.weill.cornell.edu</code>) — never stored, never via the ETL. " +
    "<b>Write-backs</b>: the nightly <code>etl:orcid-push</code> copies confirmed ORCID iDs back into " +
    "WCM Identity through the ReCiter engine API, the ETL's only write to a WCM system of record " +
    "(prod only; staging runs it as a dry run). The app writes to ReciterAI only for core-claim " +
    "mirrors and the opportunity SUBMISSION queue. " +
    "<b>ReciterAI</b> scores, topics, tools and grants refresh nightly, spotlights weekly, and the " +
    "topic hierarchy on the annual run (Jul 1, behind a manual approval gate). Some ReciterDB-side " +
    "data (ed, mentoring, citations, clinical-trials) reaches the in-VPC ETL as NDJSON bridge files " +
    "in ReciterAI's S3 bucket rather than as direct reads. " +
    "<b>Postdoc mentees</b> come from HR: Enterprise Directory carries the HR employee-SOR role records, and the nightly ED pass reads each postdoc's <code>manager</code> (the PI, or the PI named in the lab unit) into <code>postdoc_mentor_relationship</code>, alumni included. " +
    "<b>Faculty Review Tool</b> self-reported mentees are read weekly from the COI portal's SQL Server " +
    "(<code>etl/frt</code>) and feed /edit mentee suggestions. " +
    "<b>POPS</b> (the public <code>weillcornell.org</code> physician " +
    "directory) enriches clinical scholars with board certifications, specialties, and expertise " +
    "(<code>etl/pops/index.ts</code>) — it keys off the clinical-profile flag Enterprise Directory " +
    "sets, runs weekly (<code>PopsWeekly</code>) after the nightly ED pass has set that flag, and " +
    "feeds the people search index. <b>Grant enrichment</b> runs weekly: NIH RePORTER (PI profiles " +
    "from the public API, plus RePORTER-derived tables in ReciterDB), NSF awards, and the Gates " +
    "Foundation's public committed-grants CSV. <b>PubMed</b> E-utilities stamp retracted papers " +
    "nightly; the NLM MeSH descriptor download (<code>etl:mesh</code>) is on-demand, not scheduled. " +
    "<b>Clinical trials</b> originate in <b>OnCore</b> (the CTMS — a " +
    "<b>manual</b> institutional export, static until the next export lands). OnCore's export " +
    "stages into reciterdb (<code>clinical_trials</code>); the weekly <code>etl:clinical-trials</code> " +
    "reads that list and fetches each NCT live from ClinicalTrials.gov API v2, falling back to " +
    "reciterdb's <code>clinical_trials_enriched</code> row only when a batch fails. " +
    "<b>CTL portfolio</b> (available technologies) is WCM's own Center for Technology Licensing, " +
    "scraped weekly from its public portal (<code>innovation.weill.cornell.edu</code>). " +
    "<b>WCM Newsroom</b> is read weekly for articles that mention a scholar " +
    "(<code>news.weill.cornell.edu/news/feed.json</code>, <code>etl/news/*</code>) — one paginated " +
    "JSON read covers the archive back to 1997. A <code>vivo.weill.cornell.edu</code> link in the " +
    "article body publishes the mention outright; a prose name-match queues it for human review in " +
    "<code>/edit</code>. The Research office's news page " +
    "(<code>research.weill.cornell.edu/about-us/news-updates</code>) is a <b>syndication target</b> of " +
    "the newsroom, not a source — SPS scraped it until #2200/#2231. " +
    "<b>Media clips</b>: External Affairs' daily 'WCM in the News' digest is mailed to an SES inbound " +
    "address (<code>cdk/lib/inbound-mail-stack.ts</code>), and <code>etl:news-clips</code> parses it " +
    "nightly into pending mentions for comms review; the Research Dean's weekly funding digest arrives " +
    "the same way and <code>etl:funding-digest</code> feeds it to the ReciterAI submission queue " +
    "(Views 6 and 7; prod only, staging is a dry run). " +
    "<b>Honor-society rosters</b> are scraped from public lists on their own Step Functions machine " +
    "(Mon 10:00 UTC), not the Sunday weekly chain; every match is human-reviewed. Also read over public " +
    "HTTPS: the ORCID registry (weekly; advisory /edit/orcid-coverage only). " +
    "<b>CTSC roster feed</b> (the Clinical &amp; Translational Science Center's investigators-and-trainees " +
    "feed, the one the ReCiter Institutional Client reads) mirrors the <code>ctsc</code> center roster " +
    "nightly (<code>etl/ctsc-roster</code>). It is <b>not</b> a publication source: its PubMed IDs are " +
    "never read, and its CWIDs are checked against Enterprise Directory before a member is linked.",
  source: "docs/architecture-overview.md · cdk/lib/etl-stack.ts · cdk/lib/app-stack.ts · cdk/lib/inbound-mail-stack.ts · lib/headshot.ts · ETL connectors in lib/sources/ · etl/orcid-push/* · etl/frt/* · etl/pops/index.ts · docs/pops-clinical-search-spec.md · etl/clinical-trials/* · docs/clinical-trials-source-spec.md · etl/news/* · etl/news/clips.ts · docs/2026-07-18-news-mentions-plan.md · etl/gates/* · etl/pubmed-retractions/* · etl/honors/* · etl/ctsc-roster/*",
};
