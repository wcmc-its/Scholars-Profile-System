/**
 * View 4 — Edge topology. NetScaler is LIVE on BOTH envs (staging 2026-07-21,
 * prod 2026-07-24). CloudFront sends all dynamic behaviours + the default through
 * the NetScaler VIP → app ALB: the origin leg is HTTPS-only (an HTTP origin behind
 * the VIP's HTTP→HTTPS upgrade loops forever — the original ERR_TOO_MANY_REDIRECTS
 * bug), and NetScaler dials the ALB on :443, forwarding the X-Origin-Verify header
 * CloudFront injects. Durable in CDK via the #1507 origin-flip (PR #1852 staging,
 * #1926 prod).
 *
 * Port corrected 2026-07-25 (#1937): this view previously said NetScaler dials :80
 * and that the ALB :443 listener was an unused guard. Both were wrong for staging
 * as well as prod — re-measured via VPC flow logs on all four staging ALB ENIs plus
 * a timed causal probe. :80 carries only internet-scanner noise in both envs.
 *
 * Self-contained SVG (title + footer baked in) so the export stands alone in a deck.
 * Refreshed 2026-10-02: /_next/static/* is served from a private S3 bucket (OAC)
 * with the NetScaler/ALB origin as 403/404 fallback (#700); WAF detail (branded
 * 403, Bot Control label-only, 5000/IP → 429, WAF logs); Next 16 RSC cache key
 * (#2962/#2965); the edge purge path (#353/#828, cdn-reconcile); #1856 closed —
 * the WebACL is always built and its allow-list comes from SSM.
 *
 * Source: cdk/lib/edge-stack.ts, cdk/lib/app-stack.ts, cdk/lib/etl-stack.ts,
 * docs/network-security-topology.md § Edge & WAF, #502, #1507, PR #1852, #1937.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- Left: the live request path (both envs) top -> bottom ----
  iT:   { x: 190, y: 172, w: 300, h: 40, kind: "ext",  title: "Internet" },
  cfT:  { x: 190, y: 240, w: 300, h: 98, kind: "edge", title: "CloudFront + AWS WAF",
          sub: ["WCM-only IP gate (#461) → branded 403",
                "Managed rules enforced · Bot Control label-only",
                "5000/IP rate limit → 429 · WAF logs",
                "Cache key: _rsc + RSC/Next-Router-* (#2962)"] },
  nsT:  { x: 190, y: 384, w: 300, h: 56, kind: "ext",  title: "NetScaler VIP",
          sub: ["AWS VPX · WCM edge layer"], chip: { tone: "live", text: "both envs live" } },
  s3T:  { x: 516, y: 384, w: 166, h: 86, kind: "data", title: "S3 static assets",
          sub: ["/_next/static/* · OAC", "ALB fallback on 403/404", "14-day lifecycle"] },
  albT: { x: 190, y: 478, w: 300, h: 56, kind: "net",  title: "Public ALB",
          sub: [":443 listener · X-Origin-Verify guard"], chip: { tone: "live", text: "stays" } },
  ecsT: { x: 190, y: 568, w: 300, h: 40, kind: "app",  title: "ECS Fargate app" },

  // ---- Right: where each environment stands + edge ops ----
  today: { x: 760, y: 176, w: 580, h: 100, kind: "good", title: "Staging — cut over & live (2026-07-21)",
           sub: ["Every behaviour + the default → NetScaler VIP → app ALB,",
                 "except /_next/static/* (S3 primary, ALB fallback, #700).",
                 "Origin leg HTTPS-only; NetScaler dials the ALB on :443 with X-Origin-Verify.",
                 "Durable in CDK: #1507 origin-flip seeded for staging (PR #1852)."] },
  plan:  { x: 760, y: 304, w: 580, h: 100, kind: "good", title: "Prod — cut over & live (2026-07-24)",
           sub: ["Same shape as staging: VIP origin HTTPS-only, same behaviour routing.",
                 "Prod VIP stood up by the WCM network team (RITM0801140); dials the ALB on :443.",
                 "Durable in CDK via #1926.",
                 "Both envs' :443 carry the #1929 AEAD-only TLS pin (#1937, 2026-07-27)."] },
  purge: { x: 760, y: 432, w: 580, h: 86, kind: "app", title: "Edge cache purge — wired in both envs",
           sub: ["App task role holds only cloudfront:CreateInvalidation.",
                 "Suppress / rename / revoke writes purge inline after commit (#353/#828).",
                 "The scholars-cdn-reconcile-<env> ETL task retries any pending purges."] },
};

const groups = [
  { x: 40, y: 120, w: 660, h: 510, kind: "good", title: "Live request path · both envs", fo: 0.05 },
  { x: 740, y: 120, w: 620, h: 510, kind: "net", title: "Where each environment stands · edge ops", fo: 0.04 },
];

const edges = [
  { p0: A(nodes.iT, "b"),  p1: A(nodes.cfT, "t"),  color: "gray",   label: "HTTPS" },
  { p0: A(nodes.cfT, "b"), p1: A(nodes.nsT, "t"),  color: "maroon", label: "default + dynamic · HTTPS-only" },
  { p0: A(nodes.cfT, "r", 0.5), p1: A(nodes.s3T, "t"), color: "amber", label: "/_next/static/*",
    points: [{ x: 599, y: 289 }], lp: { x: 599, y: 336 } },
  { p0: A(nodes.nsT, "b"), p1: A(nodes.albT, "t"), color: "gray",   label: ":443 · X-Origin-Verify" },
  { p0: A(nodes.albT, "b"),p1: A(nodes.ecsT, "t"), color: "gray",   label: "to app" },
  { p0: A(nodes.ecsT, "l"), p1: A(nodes.cfT, "l", 0.5), color: "teal", dash: true, label: "CreateInvalidation",
    points: [{ x: 110, y: 588 }, { x: 110, y: 289 }], lp: { x: 110, y: 440 } },
];

const decos = [
  `<text x="40" y="40" font-size="12.5" font-weight="700" fill="#6a40c9" letter-spacing="0.5">EDGE TOPOLOGY · BOTH ENVS LIVE · staging 2026-07-21 · prod 2026-07-24 · #502</text>`,
  `<text x="40" y="74" font-size="22" font-weight="800" fill="#1f2933">Live (both envs): CloudFront + WAF → NetScaler → ALB → Fargate</text>`,
  `<rect x="1204" y="34" width="156" height="28" rx="14" fill="#f3eeff" stroke="#d6c9f0"/><text x="1282" y="52" font-size="11" font-weight="700" fill="#6a40c9" text-anchor="middle">BOTH ENVS LIVE</text>`,
  `<text x="64" y="152" font-size="11.5" fill="#6b7280">Static chunks from S3; everything else via NetScaler (HTTPS-only) → ALB :443</text>`,
  `<text x="760" y="152" font-size="11.5" fill="#6b7280">Same shape in both envs; :443 TLS policy at parity (#1937)</text>`,
  `<rect x="40" y="648" width="1320" height="62" rx="8" fill="#fbf7f0" stroke="#ece2cf"/>`,
  `<text x="58" y="668" font-size="11" fill="#5b4a20">#461 WCM-only WAF gate stays until NetScaler enforces equivalent filtering · :443 is the live origin leg in BOTH envs; the :80 listener remains but takes only scanner noise.</text>`,
  `<text x="58" y="685" font-size="11" fill="#5b4a20">WAF allow-list comes from an operator-seeded SSM StringList (#1506); the WebACL is always built, so a bare Edge deploy keeps the IPSet (#1856 closed).</text>`,
  `<text x="58" y="702" font-size="11" fill="#5b4a20">Common rule set enforced except SizeRestrictions_BODY / _QUERYSTRING (count) · cache policies key and forward _rsc, or Flight requests 307-loop (#2962/#2965).</text>`,
];

export const spec = { id: "edge-topology-fork", vb: [1400, 726], groups, nodes, edges, decos };

export const meta = {
  nav: "④ Edge topology",
  kicker: "View 4 · edge topology — both envs live (#502)",
  heading: "Edge topology — NetScaler live in both environments",
  dot: "#2f9e44",
  blurb:
    "NetScaler is <b>live in both environments</b> (staging 2026-07-21, prod 2026-07-24). CloudFront sends every " +
    "behaviour plus the default through the <b>NetScaler VIP → app ALB</b>, except <code>/_next/static/*</code>, which " +
    "an origin group serves from a <b>private S3 bucket</b> (OAC, written additively by the deploy, 14-day lifecycle) " +
    "and falls back to the ALB on 403/404 (#700). The origin leg is " +
    "<b>HTTPS-only</b> (an HTTP origin behind the VIP's HTTP→HTTPS upgrade loops forever — the original " +
    "<code>ERR_TOO_MANY_REDIRECTS</code> bug), and NetScaler dials the ALB on <b>:443</b>, forwarding the " +
    "<b>X-Origin-Verify</b> header CloudFront injects. Durable in CDK via the #1507 origin-flip " +
    "(PR #1852 staging, #1926 prod). The WAF runs the #461 WCM-only gate (branded 403), enforced AWS managed rules, " +
    "Bot Control in label-only mode and a 5000/IP rate limit (branded 429), and it writes WAF logs. The cache key carries " +
    "Next 16's <code>_rsc</code> param and the RSC/Next-Router-* headers (#2962/#2965). Writes that suppress, rename " +
    "or revoke purge the edge through <code>CreateInvalidation</code> (#353/#828), and the cdn-reconcile ETL retries any " +
    "purge still pending. <b>Port corrected 2026-07-25</b> — this view previously said <b>:80</b> " +
    "and called the ALB <code>:443</code> listener an unused guard; re-measurement (VPC flow logs + a timed " +
    "causal probe) showed <code>:443</code> is the live leg in both envs. The <code>:443</code> TLS policy is " +
    "now at <b>parity</b> — both envs carry the #1929 AEAD-only pin, staging deployed 2026-07-27 (<b>#1937</b>).",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Internet / on-prem" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "CloudFront + WAF (kept)" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "Load balancer (kept)" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "S3 static-asset origin" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS Fargate / app-side purge" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "Live (both envs)" },
    { fill: "#f3eeff", stroke: "#6a40c9", label: "NetScaler now in path" },
  ],
  edgeLegend: [
    { color: "maroon", label: "dynamic origin leg (HTTPS-only)" },
    { color: "amber", label: "static chunks → S3 (OAC)" },
    { color: "gray", label: "request path" },
    { color: "teal", dash: true, label: "edge purge (async)" },
  ],
  source: "cdk/lib/edge-stack.ts · cdk/lib/app-stack.ts · docs/network-security-topology.md § Edge & WAF · PR #1852 · #502 · #1507 · #700 · #1856",
};
