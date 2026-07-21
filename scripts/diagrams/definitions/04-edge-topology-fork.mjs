/**
 * View 4 — Edge topology. NetScaler is now LIVE on staging (2026-07-21).
 * The staging CloudFront distribution sends all dynamic behaviours + the default
 * through the NetScaler VIP → app ALB: the origin leg is HTTPS-only (an HTTP
 * origin behind the VIP's HTTP→HTTPS upgrade loops forever — the original
 * ERR_TOO_MANY_REDIRECTS bug), and NetScaler dials the ALB on :80, forwarding the
 * X-Origin-Verify header CloudFront injects. Durable in CDK via the #1507
 * origin-flip (PR #1852). Prod is still pending: its NetScaler VIP does not exist
 * yet — a NetScaler-team task (follow-up Fri 2026-07-24) — so prod's :80-only ALB
 * and edge config are unchanged.
 * Self-contained SVG (title + footer baked in) so the export stands alone in a deck.
 * Source: docs/network-security-topology.md § Edge & WAF, #502, #1507, PR #1852.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- Left: the live request path (staging) top -> bottom ----
  iT:   { x: 140, y: 170, w: 320, h: 40, kind: "ext",  title: "Internet" },
  cfT:  { x: 140, y: 238, w: 320, h: 56, kind: "edge", title: "CloudFront + AWS WAF",
          sub: ["WCM-only gate (#461) · caching · managed rules"] },
  nsT:  { x: 140, y: 322, w: 320, h: 56, kind: "ext",  title: "NetScaler VIP",
          sub: ["AWS VPX · WCM edge layer"], chip: { tone: "live", text: "staging live" } },
  albT: { x: 140, y: 406, w: 320, h: 56, kind: "net",  title: "Public ALB",
          sub: [":80 listener · X-Origin-Verify guard"], chip: { tone: "live", text: "stays" } },
  ecsT: { x: 140, y: 490, w: 320, h: 40, kind: "app",  title: "ECS Fargate app" },

  // ---- Right: where each environment stands ----
  today: { x: 632, y: 196, w: 696, h: 104, kind: "good", title: "Staging — cut over & live (2026-07-21)",
           sub: ["CloudFront routes all dynamic behaviours + the default through the NetScaler VIP → app ALB.",
                 "Origin leg is HTTPS-only — an HTTP origin behind the VIP's HTTP→HTTPS upgrade loops forever.",
                 "Durable in CDK: the #1507 origin-flip is seeded for staging (PR #1852, merged)."] },
  plan:  { x: 632, y: 340, w: 696, h: 108, kind: "ext", title: "Prod — pending NetScaler VIP",
           sub: ["The prod VIP does not exist yet; prod still points straight at its :80-only ALB.",
                 "NetScaler team stands up the prod VIP — follow-up meeting Fri 2026-07-24 (RITM0801140).",
                 "Then mirror staging: VIP origin HTTPS-only, repoint behaviours, seed CDK. Edge deploy gated on #1856."] },
};

const groups = [
  { x: 40, y: 120, w: 520, h: 410, kind: "good", title: "Live request path · staging 2026-07-21", fo: 0.05 },
  { x: 600, y: 120, w: 760, h: 410, kind: "net", title: "Where each environment stands", fo: 0.04 },
];

const edges = [
  { p0: A(nodes.iT, "b"),  p1: A(nodes.cfT, "t"),  color: "gray",   label: "HTTPS" },
  { p0: A(nodes.cfT, "b"), p1: A(nodes.nsT, "t"),  color: "maroon", label: "origin · HTTPS-only" },
  { p0: A(nodes.nsT, "b"), p1: A(nodes.albT, "t"), color: "gray",   label: ":80 · X-Origin-Verify" },
  { p0: A(nodes.albT, "b"),p1: A(nodes.ecsT, "t"), color: "gray",   label: "to app" },
];

const decos = [
  `<text x="40" y="40" font-size="12.5" font-weight="700" fill="#6a40c9" letter-spacing="0.5">EDGE TOPOLOGY · STAGING LIVE 2026-07-21 · PR #1852 · #502</text>`,
  `<text x="40" y="74" font-size="22" font-weight="800" fill="#1f2933">Live (staging): CloudFront + WAF → NetScaler → ALB → Fargate</text>`,
  `<rect x="1204" y="34" width="156" height="28" rx="14" fill="#f3eeff" stroke="#d6c9f0"/><text x="1282" y="52" font-size="11" font-weight="700" fill="#6a40c9" text-anchor="middle">STAGING LIVE</text>`,
  `<text x="64" y="150" font-size="11.5" fill="#6b7280">Origin leg HTTPS-only · NetScaler → ALB on :80 forwarding X-Origin-Verify</text>`,
  `<text x="632" y="150" font-size="11.5" fill="#6b7280">Prod mirrors staging once the NetScaler team stands up its VIP</text>`,
  `<rect x="40" y="548" width="1320" height="46" rx="8" fill="#fbf7f0" stroke="#ece2cf"/>`,
  `<text x="58" y="568" font-size="11" fill="#5b4a20">#461 WCM-only WAF gate stays until NetScaler enforces equivalent filtering · the ALB :443 listener is an unused origin guard (the live path is :80).</text>`,
  `<text x="58" y="585" font-size="11" fill="#5b4a20">Do not deploy the Edge stack (either env) until #1856 — its WAF allow-list sources a missing SSM param, so a deploy would strip the live IPSet.</text>`,
];

export const spec = { id: "edge-topology-fork", vb: [1400, 612], groups, nodes, edges, decos };

export const meta = {
  nav: "④ Edge topology",
  kicker: "View 4 · edge topology — staging live (#502)",
  heading: "Edge topology — staging live, prod pending",
  dot: "#2f9e44",
  blurb:
    "NetScaler is <b>live on staging</b> (2026-07-21). The staging CloudFront distribution sends all " +
    "dynamic behaviours plus the default through the <b>NetScaler VIP → app ALB</b>: the origin leg is " +
    "<b>HTTPS-only</b> (an HTTP origin behind the VIP's HTTP→HTTPS upgrade loops forever — the original " +
    "<code>ERR_TOO_MANY_REDIRECTS</code> bug), and NetScaler dials the ALB on <b>:80</b>, forwarding the " +
    "<b>X-Origin-Verify</b> header CloudFront injects. It is durable in CDK via the #1507 origin-flip " +
    "(PR #1852). <b>Prod is still pending</b> — its NetScaler VIP does not exist yet (a NetScaler-team task, " +
    "follow-up Fri 2026-07-24), after which prod mirrors staging. The prod Edge deploy is gated on #1856.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Internet / on-prem" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "CloudFront + WAF (kept)" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "Load balancer (kept)" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS Fargate" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "Live (staging)" },
    { fill: "#f3eeff", stroke: "#6a40c9", label: "NetScaler now in path" },
  ],
  source: "docs/network-security-topology.md § Edge & WAF · PR #1852 · #502 · #1507",
};
