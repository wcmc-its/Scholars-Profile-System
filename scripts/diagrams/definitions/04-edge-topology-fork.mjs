/**
 * View 4 — Edge topology, RESOLVED (the #502 fork is decided).
 * Fabrice confirmed 2026-07-02 (docs/cutover-item3-execution-runbook.md §1):
 * the target is CloudFront + WAF -> NetScaler -> ALB -> Fargate. CloudFront and
 * the WAF stay; the AWS ALB stays because the app is ECS Fargate. NetScaler is
 * NOT in the path today (both distributions point straight at their ALB), so
 * reaching the target is a NetScaler-insertion change orthogonal to the item-3
 * VPC move. The only remaining choice is sequencing (insert decoupled vs coupled).
 * Self-contained SVG (title + footer baked in) so the export stands alone in a deck.
 * Source: docs/cutover-item3-execution-runbook.md, network-security-topology.md,
 * waf-request-RITM0792011.md, #502, #1400.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ---- Left: the DECIDED target path (top -> bottom) ----
  iT:   { x: 140, y: 170, w: 320, h: 40, kind: "ext",  title: "Internet" },
  cfT:  { x: 140, y: 238, w: 320, h: 56, kind: "edge", title: "CloudFront + AWS WAF",
          sub: ["WCM-only gate (#461) · caching · managed rules"] },
  nsT:  { x: 140, y: 322, w: 320, h: 56, kind: "ext",  title: "NetScaler",
          sub: ["AWS VPX · inserted edge layer (WCM)"], chip: { tone: "planned", text: "to insert" } },
  albT: { x: 140, y: 406, w: 320, h: 56, kind: "net",  title: "Public ALB",
          sub: ["X-Origin-Verify origin guard"], chip: { tone: "live", text: "stays" } },
  ecsT: { x: 140, y: 490, w: 320, h: 40, kind: "app",  title: "ECS Fargate app" },

  // ---- Right: where it stands + the plan ----
  today: { x: 632, y: 196, w: 696, h: 104, kind: "ext", title: "Today (as deployed)",
           sub: ["Both CloudFront distributions point straight at their ALB — NetScaler is not in the path yet.",
                 "Inserting it is a WCM edge change, orthogonal to the item-3 VPC move (no CDK change).",
                 "The :80 default-403 origin guard still 403s a NetScaler not yet sending X-Origin-Verify."] },
  plan:  { x: 632, y: 340, w: 696, h: 108, kind: "good", title: "Insertion — decoupled follow-on",
           sub: ["Repoint the CloudFront origin to the new ALB in-window — SPS-only, no WCM dependency.",
                 "Then WCM inserts NetScaler in front of the ALB as a separate follow-on step.",
                 "Requested 2026-07-08 · RITM0801140 · prod+staging, staging-first."] },
};

const groups = [
  { x: 40, y: 120, w: 520, h: 410, kind: "good", title: "Decided target path · Fabrice 2026-07-02", fo: 0.05 },
  { x: 600, y: 120, w: 760, h: 410, kind: "net", title: "Where it stands + how it lands", fo: 0.04 },
];

const edges = [
  { p0: A(nodes.iT, "b"),  p1: A(nodes.cfT, "t"),  color: "gray",   label: "HTTPS" },
  { p0: A(nodes.cfT, "b"), p1: A(nodes.nsT, "t"),  color: "maroon", label: "origin" },
  { p0: A(nodes.nsT, "b"), p1: A(nodes.albT, "t"), color: "gray",   label: "X-Origin-Verify" },
  { p0: A(nodes.albT, "b"),p1: A(nodes.ecsT, "t"), color: "gray",   label: ":443" },
];

const decos = [
  `<text x="40" y="40" font-size="12.5" font-weight="700" fill="#256f33" letter-spacing="0.5">EDGE TOPOLOGY · RESOLVED 2026-07-02 · RITM0792011 · #502</text>`,
  `<text x="40" y="74" font-size="22" font-weight="800" fill="#1f2933">Decided: CloudFront + WAF → NetScaler → ALB → Fargate</text>`,
  `<rect x="1224" y="34" width="136" height="28" rx="14" fill="#ebfbee" stroke="#b7dfc0"/><text x="1292" y="52" font-size="11" font-weight="700" fill="#256f33" text-anchor="middle">DECIDED</text>`,
  `<text x="64" y="150" font-size="11.5" fill="#6b7280">CloudFront and the WAF stay · the ALB stays because the app is Fargate</text>`,
  `<text x="632" y="150" font-size="11.5" fill="#6b7280">Getting there = inserting NetScaler as a decoupled follow-on</text>`,
  `<rect x="40" y="548" width="1320" height="46" rx="8" fill="#fbf7f0" stroke="#ece2cf"/>`,
  `<text x="58" y="568" font-size="11" fill="#5b4a20">#461 WCM-only WAF gate stays until NetScaler enforces equivalent filtering · the :80 default-403 origin guard is unchanged (the ALB is kept).</text>`,
  `<text x="58" y="585" font-size="11" fill="#5b4a20">NetScaler insertion is decoupled from the item-3 VPC move: repoint the CloudFront origin to the new ALB now, then add NetScaler in front as a follow-on.</text>`,
];

export const spec = { id: "edge-topology-fork", vb: [1400, 612], groups, nodes, edges, decos };

export const meta = {
  nav: "④ Edge decision",
  kicker: "View 4 · the edge decision — resolved (#502)",
  heading: "Edge topology — resolved",
  dot: "#2f9e44",
  blurb:
    "The edge front door is <b>decided</b>. Fabrice confirmed (2026-07-02) the target is " +
    "<b>CloudFront + WAF → NetScaler → ALB → Fargate</b>: CloudFront and the WAF <b>stay</b>, and the AWS " +
    "<b>ALB is kept</b> because the app is ECS Fargate. NetScaler is <b>not in the path today</b> — both " +
    "distributions point straight at their ALB — so reaching the target is a NetScaler-<b>insertion</b> " +
    "change, orthogonal to the item-3 VPC move. It lands as a <b>decoupled follow-on</b>: repoint the " +
    "CloudFront origin to the new ALB now, then WCM inserts NetScaler in front as a separate step.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "Internet / on-prem" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "CloudFront + WAF (kept)" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "Load balancer (kept)" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS Fargate" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "Decided / recommended" },
    { fill: "#fff0f0", stroke: "#e03131", label: "Open · sequencing only" },
  ],
  source: "docs/cutover-item3-execution-runbook.md (§1 edge · Fabrice 2026-07-02, #1400) · docs/network-security-topology.md · docs/waf-request-RITM0792011.md · #502",
};
