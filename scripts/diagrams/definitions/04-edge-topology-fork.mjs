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
 * Source: docs/network-security-topology.md § Edge & WAF, #502, #1507, PR #1852, #1937.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- Left: the live request path (staging) top -> bottom ----
  iT:   { x: 140, y: 170, w: 320, h: 40, kind: "ext",  title: "Internet" },
  cfT:  { x: 140, y: 238, w: 320, h: 56, kind: "edge", title: "CloudFront + AWS WAF",
          sub: ["WCM-only gate (#461) · caching · managed rules"] },
  nsT:  { x: 140, y: 322, w: 320, h: 56, kind: "ext",  title: "NetScaler VIP",
          sub: ["AWS VPX · WCM edge layer"], chip: { tone: "live", text: "both envs live" } },
  albT: { x: 140, y: 406, w: 320, h: 56, kind: "net",  title: "Public ALB",
          sub: [":443 listener · X-Origin-Verify guard"], chip: { tone: "live", text: "stays" } },
  ecsT: { x: 140, y: 490, w: 320, h: 40, kind: "app",  title: "ECS Fargate app" },

  // ---- Right: where each environment stands ----
  today: { x: 632, y: 196, w: 696, h: 104, kind: "good", title: "Staging — cut over & live (2026-07-21)",
           sub: ["CloudFront routes all dynamic behaviours + the default through the NetScaler VIP → app ALB.",
                 "Origin leg is HTTPS-only; NetScaler dials the ALB on :443 forwarding X-Origin-Verify.",
                 "Durable in CDK: the #1507 origin-flip is seeded for staging (PR #1852, merged)."] },
  plan:  { x: 632, y: 340, w: 696, h: 108, kind: "good", title: "Prod — cut over & live (2026-07-24)",
           sub: ["Same shape as staging: VIP origin HTTPS-only, all 34 behaviours + default repointed.",
                 "Prod VIP stood up by the WCM network team (RITM0801140); dials the ALB on :443.",
                 "Durable in CDK via #1926. Its :443 listener carries the #1929 TLS pin; staging does not yet — #1937."] },
};

const groups = [
  { x: 40, y: 120, w: 520, h: 410, kind: "good", title: "Live request path · both envs", fo: 0.05 },
  { x: 600, y: 120, w: 760, h: 410, kind: "net", title: "Where each environment stands", fo: 0.04 },
];

const edges = [
  { p0: A(nodes.iT, "b"),  p1: A(nodes.cfT, "t"),  color: "gray",   label: "HTTPS" },
  { p0: A(nodes.cfT, "b"), p1: A(nodes.nsT, "t"),  color: "maroon", label: "origin · HTTPS-only" },
  { p0: A(nodes.nsT, "b"), p1: A(nodes.albT, "t"), color: "gray",   label: ":443 · X-Origin-Verify" },
  { p0: A(nodes.albT, "b"),p1: A(nodes.ecsT, "t"), color: "gray",   label: "to app" },
];

const decos = [
  `<text x="40" y="40" font-size="12.5" font-weight="700" fill="#6a40c9" letter-spacing="0.5">EDGE TOPOLOGY · BOTH ENVS LIVE · staging 2026-07-21 · prod 2026-07-24 · #502</text>`,
  `<text x="40" y="74" font-size="22" font-weight="800" fill="#1f2933">Live (both envs): CloudFront + WAF → NetScaler → ALB → Fargate</text>`,
  `<rect x="1204" y="34" width="156" height="28" rx="14" fill="#f3eeff" stroke="#d6c9f0"/><text x="1282" y="52" font-size="11" font-weight="700" fill="#6a40c9" text-anchor="middle">BOTH ENVS LIVE</text>`,
  `<text x="64" y="150" font-size="11.5" fill="#6b7280">Origin leg HTTPS-only · NetScaler → ALB on :443 forwarding X-Origin-Verify</text>`,
  `<text x="632" y="150" font-size="11.5" fill="#6b7280">Same shape in both envs; the open delta is the :443 TLS policy (#1937)</text>`,
  `<rect x="40" y="548" width="1320" height="46" rx="8" fill="#fbf7f0" stroke="#ece2cf"/>`,
  `<text x="58" y="568" font-size="11" fill="#5b4a20">#461 WCM-only WAF gate stays until NetScaler enforces equivalent filtering · :443 is the live origin leg in BOTH envs; the :80 listener remains but takes only scanner noise.</text>`,
  `<text x="58" y="585" font-size="11" fill="#5b4a20">Do not deploy the Edge stack (either env) until #1856 — its WAF allow-list sources a missing SSM param, so a deploy would strip the live IPSet.</text>`,
];

export const spec = { id: "edge-topology-fork", vb: [1400, 612], groups, nodes, edges, decos };

export const meta = {
  nav: "④ Edge topology",
  kicker: "View 4 · edge topology — both envs live (#502)",
  heading: "Edge topology — NetScaler live in both environments",
  dot: "#2f9e44",
  blurb:
    "NetScaler is <b>live in both environments</b> (staging 2026-07-21, prod 2026-07-24). CloudFront sends all " +
    "dynamic behaviours plus the default through the <b>NetScaler VIP → app ALB</b>: the origin leg is " +
    "<b>HTTPS-only</b> (an HTTP origin behind the VIP's HTTP→HTTPS upgrade loops forever — the original " +
    "<code>ERR_TOO_MANY_REDIRECTS</code> bug), and NetScaler dials the ALB on <b>:443</b>, forwarding the " +
    "<b>X-Origin-Verify</b> header CloudFront injects. Durable in CDK via the #1507 origin-flip " +
    "(PR #1852 staging, #1926 prod). <b>Port corrected 2026-07-25</b> — this view previously said <b>:80</b> " +
    "and called the ALB <code>:443</code> listener an unused guard; re-measurement (VPC flow logs + a timed " +
    "causal probe) showed <code>:443</code> is the live leg in both envs. The one remaining delta is the " +
    "<code>:443</code> TLS policy: prod carries the #1929 AEAD-only pin, staging does not yet (<b>#1937</b>).",
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
