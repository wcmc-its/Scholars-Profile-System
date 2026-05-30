/**
 * View 4 — Edge topology decision (cloud-team deep-dive on the #502 fork).
 * Expands the "NetScaler ✗ open" card from View 3 into a side-by-side
 * replace-vs-front comparison. Self-contained SVG (title + footer baked in) so
 * the PNG/SVG export stands alone in the meeting deck.
 * Source: docs/network-security-topology.md, waf-request-RITM0792011.md, #502.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- Option A: NetScaler replaces CloudFront + WAF ----
  iA:   { x: 80, y: 200, w: 170, h: 38, kind: "ext", title: "Internet" },
  nsA:  { x: 80, y: 270, w: 170, h: 38, kind: "ext", title: "NetScaler" },
  albA: { x: 80, y: 340, w: 170, h: 38, kind: "net", title: "Public ALB" },
  ecsA: { x: 80, y: 410, w: 170, h: 40, kind: "app", title: "ECS app" },
  impA: { x: 286, y: 198, w: 372, h: 102, kind: "ext", title: "Implications",
          sub: ["·  Lose AWS WAF + CloudFront caching", "·  #461 WCM-only gate moves to NetScaler", "·  Edge failover / DR becomes on-prem"] },
  openA:{ x: 286, y: 326, w: 372, h: 64, kind: "open", title: "Open · RITM0792011",
          sub: ["NetScaler->ALB port + :80 default-403 exception"] },
  // ---- Option B: NetScaler fronts CloudFront + WAF ----
  iB:   { x: 800, y: 184, w: 170, h: 36, kind: "ext", title: "Internet" },
  nsB:  { x: 800, y: 248, w: 170, h: 36, kind: "ext", title: "NetScaler" },
  cfB:  { x: 800, y: 312, w: 170, h: 36, kind: "edge", title: "CloudFront + WAF" },
  albB: { x: 800, y: 376, w: 170, h: 36, kind: "net", title: "Public ALB" },
  ecsB: { x: 800, y: 440, w: 170, h: 40, kind: "app", title: "ECS app" },
  impB: { x: 1006, y: 198, w: 358, h: 102, kind: "ext", title: "Implications",
          sub: ["·  Keep AWS WAF + CloudFront caching", "·  Origin guard unchanged (CDN fronts ALB)", "·  Confirm fronting a CDN is intended"] },
  openB:{ x: 1006, y: 326, w: 358, h: 64, kind: "open", title: "Open · #502",
          sub: ["Is 'front' = NetScaler->CloudFront, or ->ALB?"] },
};

const groups = [
  { x: 40, y: 120, w: 640, h: 412, kind: "edge", title: "Option A · Replace the AWS edge", fo: 0.06 },
  { x: 720, y: 120, w: 644, h: 412, kind: "net", title: "Option B · Front the AWS edge", fo: 0.06 },
];

const edges = [
  // Option A flow
  { p0: A(nodes.iA, "b"), p1: A(nodes.nsA, "t"), color: "gray", label: "HTTPS" },
  { p0: A(nodes.nsA, "b"), p1: A(nodes.albA, "t"), color: "red", label: ":? port · :80->403" },
  { p0: A(nodes.albA, "b"), p1: A(nodes.ecsA, "t"), color: "gray", label: ":443" },
  // Option B flow
  { p0: A(nodes.iB, "b"), p1: A(nodes.nsB, "t"), color: "gray", label: "HTTPS" },
  { p0: A(nodes.nsB, "b"), p1: A(nodes.cfB, "t"), color: "red", label: "path? (CDN front)" },
  { p0: A(nodes.cfB, "b"), p1: A(nodes.albB, "t"), color: "gray", label: "X-Origin-Verify" },
  { p0: A(nodes.albB, "b"), p1: A(nodes.ecsB, "t"), color: "gray", label: ":443" },
];

const decos = [
  `<text x="40" y="40" font-size="12.5" font-weight="700" fill="#7d1c1c" letter-spacing="0.5">EDGE TOPOLOGY DECISION · RITM0792011 · #502</text>`,
  `<text x="40" y="74" font-size="22" font-weight="800" fill="#1f2933">Does NetScaler replace the AWS edge, or front it?</text>`,
  `<rect x="1188" y="34" width="176" height="28" rx="14" fill="#fceced" stroke="#e7b9bf"/><text x="1276" y="52" font-size="11" font-weight="700" fill="#a12e3a" text-anchor="middle">DECISION REQUIRED</text>`,
  `<text x="64" y="166" font-size="11.5" fill="#6b7280">NetScaler instead of CloudFront + WAF</text>`,
  `<text x="744" y="166" font-size="11.5" fill="#6b7280">NetScaler in front of CloudFront + WAF</text>`,
  `<rect x="40" y="548" width="1324" height="46" rx="8" fill="#fbf7f0" stroke="#ece2cf"/>`,
  `<text x="58" y="568" font-size="11" fill="#5b4a20">#461 WCM-only WAF gate stays until resolved · the :80 default-403 origin guard currently 403s NetScaler (RITM0792011).</text>`,
  `<text x="58" y="585" font-size="11" fill="#5b4a20">Pin down what "fronting" means (NetScaler to ALB vs NetScaler to CloudFront) before the meeting — it changes the origin-guard story.</text>`,
];

export const spec = { id: "edge-topology-fork", vb: [1400, 612], groups, nodes, edges, decos };

export const meta = {
  nav: "④ Edge decision",
  kicker: "View 4 · the edge decision (#502)",
  heading: "Edge topology — replace or front?",
  dot: "#7d1c1c",
  blurb:
    "A deep-dive on the one open item most likely to drive the cloud-team meeting: whether the " +
    "on-prem <b>NetScaler replaces</b> the AWS edge (CloudFront + WAF) or <b>sits in front</b> of " +
    "it. Each path has a different origin-guard story — the <code>:80</code> default-403 guard 403s " +
    "NetScaler today, so the answer changes what has to be reconfigured.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "On-prem / external" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "AWS edge (CloudFront + WAF)" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "Load balancer" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Compute" },
    { fill: "#fff0f0", stroke: "#e03131", label: "Open question" },
  ],
  source: "docs/network-security-topology.md · docs/waf-request-RITM0792011.md · #502",
};
