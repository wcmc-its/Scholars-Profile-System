/**
 * View 5 — Application internals (C4 component level).
 * Zooms inside the single Next.js container: rendering surfaces, the API route
 * handlers grouped by purpose, and the internal libraries they share — wired to
 * the data tier and external systems (left: read/auth tier below the app; right:
 * the AWS / ReCiter dependencies the /edit write path calls).
 * Source: app/ (routes), lib/db.ts, lib/search.ts, lib/edit/*, lib/llm/*,
 * lib/reciter/client.ts, lib/cache/s3-cache-handler.js, lib/headshot.ts, proxy.ts.
 */
import { A } from "../lib.mjs";

// Column grid (API → library → external stay vertically aligned).
const C = [64, 296, 528, 760, 992, 1224];
const CW = 216;

const nodes = {
  // ---- inbound + shared cache (outside the app, top) ----
  isrcache: { x: 330, y: 38, w: 230, h: 48, kind: "data", title: "S3 ISR cache", sub: ["shared cacheHandler · SWR busts"] },
  inb:      { x: 640, y: 38, w: 250, h: 48, kind: "ext", title: "CloudFront / public ALB", sub: ["HTTPS"] },
  etlInb:   { x: 1000, y: 38, w: 240, h: 48, kind: "ext", title: "ETL · internal ALB", sub: ["POST /api/revalidate"] },
  // ---- proxy + ops + rendering surfaces ----
  mw:     { x: 540, y: 128, w: 400, h: 62, kind: "app", title: "proxy.ts (Node runtime)", sub: ["SSO gate · /edit, /api/edit, /api/impersonation", "CSP headers · legacy VIVO 301s"] },
  opsapi: { x: 1000, y: 128, w: 240, h: 62, kind: "net", title: "Ops API", sub: ["/api/revalidate · health", "analytics · csp-report"] },
  pages:  { x: 64, y: 214, w: 430, h: 66, kind: "app", title: "Public pages — RSC / ISR", sub: ["scholars · topics · methods · cores", "depts · centers · browse · search · about"] },
  editui: { x: 1010, y: 214, w: 370, h: 66, kind: "app", title: "/edit UI — RSC (staff)", sub: ["scholar · unit · center · core editors", "reports · queues · roles · Matcha · ETL status · usage"] },
  // ---- API route handlers ----
  searchapi: { x: C[0], y: 322, w: CW, h: 66, kind: "net", title: "Search API", sub: ["/api/search · suggest", "suggest-methods · key-paper"] },
  authapi:   { x: C[1], y: 322, w: CW, h: 66, kind: "net", title: "Auth / SAML API", sub: ["/api/auth/* · session", "impersonation (superuser)"] },
  dataapi:   { x: C[3], y: 322, w: CW, h: 80, kind: "net", title: "Public-data API", sub: ["scholars · pubs · topics · methods", "units · NIH · opps · collab", "export (scholars cap 50)"] },
  editapi:   { x: C[4], y: 322, w: 236, h: 80, kind: "net", title: "Edit / write API", sub: ["/api/edit/* · suppress · roster", "AI: overview · biosketch · CV · Matcha", "post-commit: ISR · CDN · search"] },
  // ---- internal libraries ----
  searchcli: { x: C[0], y: 446, w: CW, h: 66, kind: "aws", title: "Search client", sub: ["lib/search · 5 entity aliases"] },
  authn:     { x: C[1], y: 446, w: CW, h: 66, kind: "aws", title: "AuthN", sub: ["SAML assertion + session"] },
  headshot:  { x: C[2], y: 446, w: CW, h: 66, kind: "aws", title: "Headshot", sub: ["lib/headshot · URL only"] },
  dal:       { x: C[3], y: 446, w: CW, h: 66, kind: "aws", title: "Data access", sub: ["Prisma · db.read / db.write", "override-merge (ADR-005)"] },
  authz:     { x: C[4], y: 446, w: CW, h: 66, kind: "aws", title: "AuthZ + audit", sub: ["LDAP roles + unit_admin grants", "audit log (append-only)"] },
  // ---- external systems (outside the app, below) ----
  opensearch: { x: C[0], y: 700, w: CW, h: 66, kind: "data", title: "OpenSearch", sub: ["scholars-people · -publications", "-funding · -opportunities · -trials"] },
  idp:        { x: C[1], y: 700, w: CW, h: 60, kind: "ext", title: "WCM SAML IdP", sub: ["login-proxy"] },
  directory:  { x: C[2], y: 700, w: CW, h: 60, kind: "ext", title: "WCM directory", sub: ["headshot img (browser)"] },
  aurora:     { x: C[3], y: 700, w: CW, h: 60, kind: "data", title: "Aurora MySQL", sub: ["reader + writer"] },
  ldap:       { x: C[4], y: 700, w: CW, h: 60, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS"] },
  // ---- edit-path dependencies (outside the app, right) ----
  awsapis: { x: 1490, y: 214, w: 252, h: 66, kind: "ext", title: "AWS APIs", sub: ["CloudFront invalidate (outbox)", "Athena · CloudWatch (usage, health)"] },
  bedrock: { x: 1490, y: 330, w: 252, h: 64, kind: "ext", title: "Amazon Bedrock", sub: ["Opus generate · Sonnet extract"] },
  reciter: { x: 1490, y: 446, w: 252, h: 66, kind: "data", title: "ReCiter · ReciterAI data", sub: ["DynamoDB + S3: suggestions (read)", "opp. intake · core claims (write)"] },
};

const groups = [{ x: 36, y: 112, w: 1430, h: 552, kind: "app", title: "Next.js application — ECS Fargate task (sps-app)", fo: 0.03 }];

const edges = [
  // inbound
  { p0: A(nodes.inb, "b", 0.5), p1: A(nodes.mw, "t", 0.5625), color: "maroon", label: "HTTPS" },
  { p0: A(nodes.etlInb, "b"), p1: A(nodes.opsapi, "t"), color: "green", label: "revalidate" },
  // proxy -> surfaces
  { p0: A(nodes.mw, "b", 0.05), p1: A(nodes.pages, "t", 0.98), color: "gray" },
  { p0: A(nodes.mw, "r", 0.8), p1: A(nodes.editui, "l", 0.3), color: "gray" },
  // shared ISR cache (all app tasks read/write it)
  { p0: A(nodes.pages, "t", (420 - 64) / 430), p1: A(nodes.isrcache, "b", (420 - 330) / 230), color: "teal", label: "ISR get / set", lp: { x: 420, y: 150 } },
  // clean vertical columns: API -> lib -> external
  { p0: A(nodes.searchapi, "b"), p1: A(nodes.searchcli, "t"), color: "indigo", label: "query" },
  { p0: A(nodes.authapi, "b"), p1: A(nodes.authn, "t"), color: "violet", label: "verify" },
  { p0: A(nodes.dataapi, "b"), p1: A(nodes.dal, "t"), color: "indigo", label: "read" },
  { p0: A(nodes.editapi, "b", 108 / 236), p1: A(nodes.authz, "t"), color: "violet", label: "authorize" },
  { p0: A(nodes.searchcli, "b"), p1: A(nodes.opensearch, "t"), color: "indigo" },
  { p0: A(nodes.authn, "b"), p1: A(nodes.idp, "t"), color: "violet", label: "SAML" },
  { p0: A(nodes.authz, "b"), p1: A(nodes.ldap, "t"), color: "violet", label: "LDAP groups" },
  { p0: A(nodes.authz, "b", 0.08), p1: A(nodes.aurora, "t", 0.9), color: "amber", label: "grants · audit", route: "straight" },
  { p0: A(nodes.dal, "b"), p1: A(nodes.aurora, "t"), color: "amber", label: "r / w" },
  { p0: A(nodes.headshot, "b"), p1: A(nodes.directory, "t"), color: "violet", dash: true, label: "browser GET" },
  // edit / write path
  { p0: A(nodes.editui, "b", 0.1), p1: A(nodes.editapi, "t", 0.2), color: "indigo", label: "writes", route: "straight" },
  { p0: A(nodes.editapi, "b", 0.07), p1: A(nodes.dal, "t", 0.85), color: "indigo", label: "write", lp: { x: 978, y: 424 }, points: [{ x: 1009, y: 424 }, { x: 944, y: 424 }] },
  { p0: A(nodes.editapi, "r", 0.5), p1: A(nodes.bedrock, "l", (362 - 330) / 64), color: "violet", label: "LLM", route: "straight" },
  { p0: A(nodes.editapi, "r", 0.85), p1: A(nodes.reciter, "l", 0.5), color: "amber", dash: true, label: "read · intake · core writeback", lp: { x: 1362, y: 438 } },
  { p0: A(nodes.editapi, "r", 0.12), p1: A(nodes.awsapis, "l", 0.8), color: "gray", dash: true, label: "invalidate", lp: { x: 1340, y: 318 } },
  { p0: A(nodes.editui, "r", 0.3), p1: A(nodes.awsapis, "l", 0.3), color: "gray", dash: true, label: "usage / health", route: "straight" },
  // read path (RSC pages compose DAL + live headshot) — routed down the empty column-3 API slot
  { p0: A(nodes.pages, "r", 0.4), p1: A(nodes.dal, "t", 0.15), color: "teal", label: "read (RSC)", lp: { x: 740, y: 424 }, points: [{ x: 690, y: 240.4 }, { x: 690, y: 424 }, { x: 792.4, y: 424 }] },
  { p0: A(nodes.pages, "r", 0.75), p1: A(nodes.headshot, "t", 72 / 216), color: "teal", dash: true, label: "headshot URL", lp: { x: 600, y: 362 }, points: [{ x: 600, y: 263.5 }] },
];

export const spec = { id: "app-internals", vb: [1770, 800], groups, nodes, edges };

export const meta = {
  nav: "⑤ App internals",
  kicker: "View 5 · inside the app (C4 component)",
  heading: "Application internals",
  dot: "#0ca678",
  blurb:
    "Inside the single Next.js container: the public pages and staff <b>/edit</b> UI (React Server " +
    "Components), the <b>API route handlers</b> grouped by purpose — the public-data surface spans " +
    "scholars, publications, topics, <b>methods</b>, <b>centers / units</b>, <b>NIH portfolio</b>, " +
    "<b>funding opportunities</b>, the <b>center-collaboration network</b>, and capped <b>exports</b> — " +
    "and the <b>internal libraries</b> they share, wired to Aurora (reader/writer), OpenSearch (five " +
    "per-entity aliases), the SAML IdP, and the WCM directory (LDAP role groups + live headshots); " +
    "scoped grants and the audit log live in Aurora. ISR output is shared across tasks through an " +
    "<b>S3 cacheHandler</b> (#1503). The <b>/edit</b> write path calls <b>Amazon Bedrock</b> for AI " +
    "generation (overview · biosketch · CV) and Matcha concept extraction; reads ReCiter suggestions and " +
    "writes opportunity submissions and core claims to ReciterAI's DynamoDB (rejects reach the ReCiter " +
    "engine through the ETL); and reflects each commit post-response — ISR revalidate, CloudFront " +
    "invalidation, OpenSearch suppression. The CV path reads clinical fields live from POPS " +
    "(<code>lib/edit/pops.ts</code>). <code>proxy.ts</code> (Node runtime) gates <code>/edit</code> and " +
    "impersonation, sets CSP on every document, and 301s legacy VIVO URLs.",
  legend: [
    { fill: "#e3faf3", stroke: "#0ca678", label: "Rendering (RSC) / proxy" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "API route handler" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "Internal library" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "External system" },
  ],
  source:
    "app/api/* (search · export · methods · centers/collaboration · units · nih-portfolio · opportunities · analytics · impersonation) · " +
    "lib/api/{match-opportunities,search-funding,center-collaboration,export-scholars,service-health,swr-cache}.ts · " +
    "lib/edit/{overview-generator,biosketch-generator,pops,revalidation,search-suppression,opportunity-submission,authz,audit}.ts · " +
    "lib/llm/{client,models}.ts · lib/reciter/client.ts · lib/cores/claim-writeback.ts · lib/analytics/athena-client.ts · " +
    "lib/cache/s3-cache-handler.js · lib/db.ts · lib/search.ts · lib/headshot.ts · proxy.ts",
};
