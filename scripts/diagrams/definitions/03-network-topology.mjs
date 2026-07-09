/**
 * View 3 — Network topology (for cloud-team review).
 * Left: the VPC deployed today (subnet tiers + default-deny SGs + VPC endpoints).
 * Right: the SETTLED direction — full consolidation of the whole SPS estate into
 * one shared, TGW-attached its-reciter-vpc01 (no VPC peering; env isolation by
 * per-env security groups), which closes the #443 WCM-connectivity gap. Cutover
 * is flag-gated and reversible (pending).
 *
 * PUBLIC VERSION: internal network ranges (VPC/subnet CIDRs) are generalized here
 * because this repo is public. A fuller internal version with the concrete CIDRs
 * is available on request. Keep specific ranges OUT of this file — same norm as
 * the #461 campus allowlist (SSM, not source).
 * Source: cdk/lib/network-stack.ts, cdk/lib/config.ts, docs/sps-vpc-consolidation-plan.md,
 * docs/network-security-topology.md.
 */
import { A } from "../lib.mjs";

const nodes = {
  inet:   { x: 40, y: 42, w: 160, h: 50, kind: "ext", title: "Internet", sub: ["public"] },
  cf:     { x: 300, y: 36, w: 300, h: 62, kind: "edge", title: "CloudFront + AWS WAF", sub: ["rate-limit · managed rules", "WCM-only gate (#461)"] },
  egress: { x: 660, y: 54, w: 330, h: 46, kind: "ext", title: "Outbound internet", sub: ["via NAT: X-Ray · NIH · NSF · MeSH"] },
  igw:    { x: 470, y: 128, w: 150, h: 44, kind: "net", title: "Internet gateway", sub: [] },
  albp:   { x: 110, y: 262, w: 250, h: 56, kind: "net", title: "Public ALB", sub: ["internet-facing · SG: alb"] },
  nat:    { x: 430, y: 262, w: 200, h: 56, kind: "net", title: "NAT gateway", sub: ["egress only"] },
  ecsapp: { x: 110, y: 402, w: 220, h: 58, kind: "app", title: "ECS app tasks", sub: ["SG: app"] },
  ecsetl: { x: 110, y: 490, w: 220, h: 58, kind: "app", title: "ECS ETL tasks", sub: ["SG: etl"] },
  ialb:   { x: 110, y: 578, w: 220, h: 56, kind: "net", title: "Internal ALB", sub: ["SG: alb · /api/revalidate"] },
  aur:    { x: 410, y: 402, w: 210, h: 58, kind: "data", title: "Aurora MySQL", sub: ["SG: aurora"] },
  os:     { x: 410, y: 490, w: 210, h: 58, kind: "data", title: "OpenSearch", sub: ["SG: opensearch · private ENI"] },
  vpce:   { x: 410, y: 578, w: 300, h: 80, kind: "aws", title: "VPC endpoints", sub: ["Secrets Mgr · :443 (from app, etl)", "S3 gateway · ECR layers"] },
  // Settled direction (docs/sps-vpc-consolidation-plan.md, 2026-06-30 "full
  // consolidation, no peering" decision): the two per-env Sps VPCs are replaced
  // by ONE shared, TGW-attached its-reciter-vpc01 that hosts the whole estate
  // (App + Data + ETL, both envs). Env isolation is by per-env security groups in
  // one shared CIDR — no peering, no network boundary. WCM/on-prem sources become
  // natively reachable over the TGW (closes #443). Cutover flag-gated + reversible.
  sharedvpc: { x: 1098, y: 200, w: 266, h: 120, kind: "good", title: "Shared VPC", sub: ["its-reciter-vpc01 · TGW-attached", "App + Data + ETL · private subnets", "per-env SGs · no peering"], chip: { tone: "planned", text: "cutover pending" } },
  onprem:    { x: 1098, y: 356, w: 266, h: 84, kind: "ext", title: "On-prem + WCM sources", sub: ["ED-LDAP · ReciterDB · ASMS", "COI · Jenzabar", "native via TGW (closes #443)"] },
  ns:        { x: 1098, y: 478, w: 266, h: 90, kind: "good", title: "Edge / NetScaler ✓ decided", sub: ["CF+WAF → NetScaler → ALB", "insert as follow-on · #502 (View ④)"] },
};

const groups = [
  { x: 40, y: 150, w: 1010, h: 528, kind: "net", title: "Deployed today · per-env Sps VPCs · 2 AZs", fo: 0.05 },
  { x: 70, y: 230, w: 950, h: 108, kind: "net", title: "Public subnets — /24 per AZ", fo: 0.12 },
  { x: 70, y: 372, w: 950, h: 296, kind: "net", title: "Private-with-egress subnets · /22 per AZ", fo: 0.12 },
  { x: 1078, y: 150, w: 306, h: 478, kind: "good", title: "Settled direction · consolidation", fo: 0.06 },
];
const [gVpc] = groups;

const edges = [
  { p0: A(nodes.inet, "r"), p1: A(nodes.cf, "l"), color: "maroon", label: "HTTPS" },
  { p0: A(nodes.cf, "b"), p1: A(nodes.albp, "t", 0.5), color: "maroon", label: "X-Origin-Verify", points: [{ x: 450, y: 128 }, { x: 235, y: 206 }] },
  { p0: A(nodes.albp, "b", 0.5), p1: A(nodes.ecsapp, "t", 0.55), color: "indigo" },
  // app + ETL SGs both reach Aurora and OpenSearch — two clean horizontals + one crossing.
  { p0: A(nodes.ecsapp, "r", 0.3), p1: A(nodes.aur, "l", 0.3), color: "indigo", label: "app", lp: { x: 370, y: 414 } },
  { p0: A(nodes.ecsetl, "r", 0.7), p1: A(nodes.os, "l", 0.7), color: "indigo", label: "etl", lp: { x: 370, y: 536 } },
  { p0: A(nodes.ecsapp, "r", 0.7), p1: A(nodes.os, "l", 0.3), color: "indigo" },
  { p0: A(nodes.ecsetl, "r", 0.3), p1: A(nodes.aur, "l", 0.7), color: "indigo" },
  // Secrets-Manager VPC endpoint (:443). Reachability is on the node sub; one edge keeps it legible.
  { p0: A(nodes.ecsetl, "b", 0.72), p1: A(nodes.vpce, "l", 0.45), color: "violet", label: ":443", lp: { x: 338, y: 584 } },
  { p0: A(nodes.ecsetl, "b", 0.32), p1: A(nodes.ialb, "t", 0.5), color: "green", label: ":80" },
  { p0: A(nodes.ecsapp, "t", 0.2), p1: A(nodes.nat, "b", 0.25), color: "gray", label: "egress", lp: { x: 405, y: 348 }, points: [{ x: 154, y: 348 }, { x: 488, y: 348 }] },
  { p0: A(nodes.nat, "t", 0.5), p1: A(nodes.igw, "b", 0.5), color: "gray" },
  { p0: A(nodes.igw, "t", 0.5), p1: A(nodes.egress, "b", 0.5), color: "gray", dash: true, label: "to internet" },
  // Settled: the whole deployed estate consolidates into the shared VPC (dashed = pending),
  // which reaches WCM/on-prem natively over the TGW.
  { p0: A(gVpc, "r", 0.08), p1: A(nodes.sharedvpc, "l", 0.35), color: "teal", dash: true, label: "consolidate", lp: { x: 1066, y: 214 } },
  { p0: A(nodes.sharedvpc, "b", 0.5), p1: A(nodes.onprem, "t", 0.5), color: "teal", label: "TGW · native reads" },
];

const decos = [
  `<text x="40" y="712" font-size="11" fill="#8a94a6">Public overview — internal network ranges generalized. A more detailed version is available on request.</text>`,
];

export const spec = { id: "network-topology", vb: [1400, 720], groups, nodes, edges, decos };

export const meta = {
  nav: "③ Network topology",
  kicker: "View 3 · for the cloud team",
  heading: "Network topology",
  dot: "#4263eb",
  blurb:
    "The review-ready network picture: VPC, subnet tiers, the three default-deny security groups " +
    "(SG-to-SG only), and VPC endpoints. The <b>settled direction</b> (2026-06-30 decision) is " +
    "<b>full consolidation</b>: the two per-env Sps VPCs are replaced by one shared, TGW-attached " +
    "<code>its-reciter-vpc01</code> that hosts the whole estate — App + Data + ETL, both envs — with " +
    "<b>no VPC peering</b>, env isolation by <b>per-env security groups</b> in one shared CIDR, and " +
    "WCM / on-prem sources reached <b>natively over the TGW</b> (closing the #443 gap). The edge front " +
    "door is <b>NetScaler</b> (View ④). Cutover is flag-gated and reversible — pending.",
  legend: [
    { fill: "#e7ecff", stroke: "#4263eb", label: "VPC / subnet / ALB" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS task" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data (private ENI)" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "VPC endpoint" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "Settled direction / TGW-native" },
  ],
  extraHtml: `
    <div class="grid2">
      <div class="panel">
        <h3>Settled direction — full consolidation (2026-06-30)</h3>
        <ul class="agenda">
          <li>The two per-env Sps VPCs are replaced by one
            shared, TGW-attached <code>its-reciter-vpc01</code>; the whole estate
            (<b>App + Data + ETL</b>, both envs) moves in. <b>No VPC peering.</b></li>
          <li>Env isolation is by <b>per-env security groups</b> inside the one shared VPC
            — no network boundary, SG-to-SG only.</li>
          <li>WCM / on-prem sources (ED-LDAP, ReciterDB, ASMS, COI, Jenzabar) are reached
            <b>natively over the shared VPC's TGW attachment</b> — this closes the #443 connectivity gap.</li>
          <li>Edge front door = <b>NetScaler</b> (CloudFront + WAF → NetScaler → ALB → Fargate; View ④),
            inserted as a follow-on decoupled from this move.</li>
          <li>Cutover is <b>flag-gated and reversible</b> (data moves by snapshot-restore into a fresh
            cluster alongside the live one) — pending. Plan: <code>docs/sps-vpc-consolidation-plan.md</code>.</li>
        </ul>
      </div>
      <div class="panel">
        <h3>Today → settled</h3>
        <table class="env">
          <tr><th>&nbsp;</th><th>Deployed today</th><th>Settled (consolidation)</th></tr>
          <tr><td class="k">VPC</td><td>per-env Sps VPCs</td><td>shared its-reciter-vpc01</td></tr>
          <tr><td class="k">Cross-network</td><td>—</td><td>none — all intra-VPC SG-to-SG</td></tr>
          <tr><td class="k">Env isolation</td><td>separate VPC / CIDR</td><td>per-env security groups</td></tr>
          <tr><td class="k">WCM / on-prem reach</td><td>blocked (#443)</td><td>native via TGW</td></tr>
          <tr><td class="k">Old Sps VPCs</td><td>in use</td><td>decommissioned (last)</td></tr>
          <tr><td class="k">Edge front door</td><td>CloudFront → ALB</td><td>CloudFront → NetScaler → ALB</td></tr>
        </table>
        <p class="foot">Env isolation by <b>per-env security groups</b>: both envs share
          one VPC, so isolation is SG-reference (SG-to-SG), not CIDR. Consolidation supersedes
          the earlier VPC-peering design (#1229 / #1310). Plan: <code>docs/sps-vpc-consolidation-plan.md</code>.</p>
      </div>
    </div>`,
  source: "cdk/lib/network-stack.ts · cdk/lib/config.ts · docs/sps-vpc-consolidation-plan.md · docs/network-security-topology.md",
};
