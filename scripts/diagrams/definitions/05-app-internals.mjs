/**
 * View 5 — Application internals (C4 component level).
 * Zooms inside the single Next.js container: rendering surfaces, the API route
 * handlers grouped by purpose, and the internal libraries they share — wired to
 * the data tier and external systems.
 * Source: app/ (routes), lib/db.ts, lib/search.ts, lib/edit/*, lib/headshot.ts, middleware.ts.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- inbound (outside the app) ----
  inb:    { x: 36, y: 38, w: 250, h: 48, kind: "ext", title: "CloudFront / public ALB", sub: ["HTTPS"] },
  etlInb: { x: 1166, y: 38, w: 250, h: 48, kind: "ext", title: "ETL · internal ALB", sub: ["POST /api/revalidate"] },
  // ---- middleware + rendering surfaces ----
  mw:     { x: 540, y: 124, w: 400, h: 48, kind: "app", title: "middleware.ts", sub: ["auth gate · /edit, /api/edit"] },
  pages:  { x: 64, y: 200, w: 430, h: 66, kind: "app", title: "Public pages — RSC / ISR", sub: ["scholars · topics · depts · centers", "browse · search · about"] },
  editui: { x: 986, y: 200, w: 430, h: 66, kind: "app", title: "/edit UI — RSC (staff)", sub: ["scholar · publication · unit editors", "slug-requests"] },
  // ---- API route handlers ----
  searchapi: { x: 64, y: 308, w: 216, h: 56, kind: "net", title: "Search API", sub: ["/api/search · /suggest"] },
  authapi:   { x: 296, y: 308, w: 216, h: 56, kind: "net", title: "Auth / SAML API", sub: ["/api/auth/* · session"] },
  editapi:   { x: 528, y: 308, w: 216, h: 56, kind: "net", title: "Edit / write API", sub: ["/api/edit/* · grant · suppress"] },
  dataapi:   { x: 760, y: 308, w: 216, h: 56, kind: "net", title: "Public-data API", sub: ["/api/scholars · publications"] },
  opsapi:    { x: 992, y: 308, w: 216, h: 56, kind: "net", title: "Ops API", sub: ["/api/revalidate · health"] },
  // ---- internal libraries ----
  searchcli: { x: 64, y: 414, w: 200, h: 66, kind: "aws", title: "Search client", sub: ["lib/search"] },
  authn:     { x: 296, y: 414, w: 200, h: 66, kind: "aws", title: "AuthN", sub: ["SAML assertion + session"] },
  authz:     { x: 528, y: 414, w: 200, h: 66, kind: "aws", title: "AuthZ + audit", sub: ["RBAC · append-only"] },
  dal:       { x: 760, y: 414, w: 200, h: 66, kind: "aws", title: "Data access", sub: ["Prisma · db.read / db.write"] },
  override:  { x: 992, y: 414, w: 200, h: 66, kind: "aws", title: "Override-merge", sub: ["ADR-005 · read-time"] },
  headshot:  { x: 1216, y: 414, w: 200, h: 66, kind: "aws", title: "Headshot", sub: ["lib/headshot · URL only"] },
  // ---- external systems (outside the app) ----
  opensearch: { x: 64, y: 694, w: 200, h: 60, kind: "data", title: "OpenSearch", sub: ["alias: scholars"] },
  idp:        { x: 296, y: 694, w: 200, h: 60, kind: "ext", title: "WCM SAML IdP", sub: ["login-proxy"] },
  ldap:       { x: 528, y: 694, w: 200, h: 60, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS"] },
  aurora:     { x: 760, y: 694, w: 200, h: 60, kind: "data", title: "Aurora MySQL", sub: ["reader + writer"] },
  directory:  { x: 1216, y: 694, w: 200, h: 60, kind: "ext", title: "WCM directory", sub: ["headshot img (browser)"] },
};

const groups = [{ x: 36, y: 112, w: 1416, h: 526, kind: "app", title: "Next.js application — ECS Fargate task (sps-app)", fo: 0.03 }];

const edges = [
  // inbound
  { p0: A(nodes.inb, "r"), p1: A(nodes.mw, "l", 0.3), color: "maroon", label: "HTTPS" },
  { p0: A(nodes.etlInb, "b"), p1: A(nodes.opsapi, "t", 0.6), color: "green", label: "revalidate" },
  // middleware -> surfaces
  { p0: A(nodes.mw, "b", 0.2), p1: A(nodes.pages, "t", 0.62), color: "gray" },
  { p0: A(nodes.mw, "b", 0.85), p1: A(nodes.editui, "t", 0.38), color: "gray" },
  // clean vertical columns: API -> lib -> external
  { p0: A(nodes.searchapi, "b"), p1: A(nodes.searchcli, "t"), color: "indigo", label: "query" },
  { p0: A(nodes.authapi, "b"), p1: A(nodes.authn, "t"), color: "violet", label: "verify" },
  { p0: A(nodes.editapi, "b"), p1: A(nodes.authz, "t"), color: "violet", label: "authorize" },
  { p0: A(nodes.dataapi, "b"), p1: A(nodes.dal, "t", 0.7), color: "indigo", label: "read" },
  { p0: A(nodes.searchcli, "b"), p1: A(nodes.opensearch, "t"), color: "indigo" },
  { p0: A(nodes.authn, "b"), p1: A(nodes.idp, "t"), color: "violet", label: "SAML" },
  { p0: A(nodes.authz, "b"), p1: A(nodes.ldap, "t"), color: "violet", label: "RBAC check" },
  { p0: A(nodes.dal, "b"), p1: A(nodes.aurora, "t"), color: "amber", label: "r / w" },
  { p0: A(nodes.headshot, "b"), p1: A(nodes.directory, "t"), color: "violet", dash: true, label: "browser GET" },
  // edit / write path
  { p0: A(nodes.editui, "b", 0.4), p1: A(nodes.editapi, "t", 0.6), color: "indigo", label: "writes", lp: { x: 860, y: 288 }, points: [{ x: 1110, y: 288 }, { x: 644, y: 288 }] },
  { p0: A(nodes.editapi, "b", 0.7), p1: A(nodes.dal, "t", 0.3), color: "indigo", label: "write", lp: { x: 700, y: 392 } },
  // read path (RSC pages compose DAL + override + live headshot) — routed in the clear band
  { p0: A(nodes.pages, "b", 0.78), p1: A(nodes.dal, "t", 0.4), color: "teal", label: "read (RSC)", lp: { x: 600, y: 384 }, points: [{ x: 408, y: 384 }, { x: 812, y: 384 }] },
  { p0: A(nodes.pages, "b", 0.5), p1: A(nodes.headshot, "t", 0.5), color: "teal", dash: true, label: "headshot URL", lp: { x: 1040, y: 396 }, points: [{ x: 372, y: 396 }, { x: 1316, y: 396 }] },
  { p0: A(nodes.override, "l", 0.5), p1: A(nodes.dal, "r", 0.5), color: "teal", dash: true, label: "merge" },
];

export const spec = { id: "app-internals", vb: [1480, 820], groups, nodes, edges };

export const meta = {
  nav: "⑤ App internals",
  kicker: "View 5 · inside the app (C4 component)",
  heading: "Application internals",
  dot: "#0ca678",
  blurb:
    "Inside the single Next.js container: the public pages and staff <b>/edit</b> UI (React Server " +
    "Components), the <b>API route handlers</b> grouped by purpose, and the <b>internal libraries</b> " +
    "they share — wired to Aurora (reader/writer), OpenSearch, the SAML IdP, and the WCM directory " +
    "(LDAP authz + live headshots). <code>middleware.ts</code> gates every <code>/edit</code> path.",
  legend: [
    { fill: "#e3faf3", stroke: "#0ca678", label: "Rendering (RSC) / middleware" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "API route handler" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "Internal library" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "External system" },
  ],
  source: "app/ (routes) · lib/db.ts · lib/search.ts · lib/edit/* · lib/headshot.ts · middleware.ts",
};
