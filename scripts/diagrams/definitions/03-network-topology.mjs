/**
 * View 3 — Network topology (for cloud-team review).
 * Deployed state: both envs run in ONE shared, TGW-attached its-reciter-vpc01
 * (consolidation cut over staging 2026-07-02 #1419, prod 2026-07-05/06 #1492;
 * useSharedVpc: true for both envs). NetworkStack imports the VPC by attributes
 * and owns no VPC, subnets, NAT, IGW or VPC endpoints. Placement uses three
 * its-reciter tiers (dmz / app2 / db). Env isolation is per-env security groups:
 * app / etl / alb pre-provisioned out-of-band and imported by id; aurora /
 * opensearch / internal-alb CDK-owned. Edge: CloudFront + WAF → NetScaler VIP →
 * public ALB :443 (live staging 2026-07-21, prod 2026-07-24).
 *
 * PUBLIC VERSION: internal network ranges (VPC/subnet CIDRs), SG / subnet ids and
 * hostnames are generalized here because this repo is public — masks only. Keep
 * specific ranges OUT of this file — same norm as the #461 campus allowlist (SSM,
 * not source).
 * Source: cdk/lib/network-stack.ts, cdk/lib/config.ts, cdk/lib/app-stack.ts,
 * cdk/lib/data-stack.ts, cdk/lib/edge-stack.ts, docs/network-security-topology.md.
 */
import { A } from "../lib.mjs";

const nodes = {
  // Outside the VPC — the request path and the egress destinations.
  inet:   { x: 40, y: 36, w: 120, h: 50, kind: "ext", title: "Internet", sub: ["public"] },
  cf:     { x: 180, y: 30, w: 250, h: 66, kind: "edge", title: "CloudFront + AWS WAF", sub: ["rate-limit · managed rules", "WCM-only gate (#461)"] },
  ns:     { x: 600, y: 30, w: 270, h: 66, kind: "good", title: "NetScaler VIP", sub: ["WCM-run VPX · decision #502", "see View ④"], chip: { tone: "live", text: "live" } },
  egress: { x: 1040, y: 30, w: 340, h: 82, kind: "ext", title: "Outbound internet (via NAT)", sub: ["X-Ray · Bedrock · Secrets Mgr", "NIH RePORTER · NSF · MeSH · PubMed · CT.gov", "ORCID · Gates · POPS · CTL · newsroom · honors"] },
  igw:    { x: 865, y: 126, w: 150, h: 44, kind: "net", title: "IGW (shared VPC)", sub: [] },
  // dmz tier (public, IGW-routed).
  albp:   { x: 610, y: 222, w: 230, h: 64, kind: "net", title: "Public ALB", sub: ["internet-facing · SG: alb", ":443 live (:80 unused)"] },
  nat:    { x: 860, y: 222, w: 160, h: 64, kind: "net", title: "NAT (shared VPC)", sub: ["egress · incl.", "Secrets Mgr"] },
  // app2 tier · /25 — app service, every ETL task ENI, the internal ALB.
  ecsapp: { x: 520, y: 382, w: 210, h: 58, kind: "app", title: "ECS app tasks", sub: ["SG: app · per-env, imported"] },
  ecsetl: { x: 520, y: 470, w: 210, h: 58, kind: "app", title: "ECS ETL tasks", sub: ["SG: etl · per-env, imported"] },
  ialb:   { x: 790, y: 462, w: 220, h: 74, kind: "net", title: "Internal ALB", sub: ["SG: internal-alb (own)", ":80 from etl · /api/revalidate"] },
  // db tier · /27 — data plane, CDK-owned SGs.
  aur:    { x: 100, y: 382, w: 270, h: 58, kind: "data", title: "Aurora MySQL", sub: ["SG: aurora · CDK-owned"] },
  os:     { x: 100, y: 470, w: 270, h: 58, kind: "data", title: "OpenSearch", sub: ["SG: opensearch · private ENI"] },
  // Shared-VPC-owned endpoints (SPS creates none when useSharedVpc is on).
  vpce:   { x: 520, y: 600, w: 290, h: 64, kind: "aws", title: "VPC endpoints (shared VPC)", sub: ["S3 + DynamoDB gateway · Lambda interface"] },
  // Beyond the VPC — WCM / on-prem, reached over the shared VPC's TGW attachment.
  onprem: { x: 1098, y: 240, w: 266, h: 84, kind: "ext", title: "On-prem + WCM sources", sub: ["ED-LDAP · ReciterDB · ASMS · InfoEd", "COI + FRT (SQL Server) · Jenzabar", "via shared-VPC TGW (#443 closed)"] },
  edbr:   { x: 1098, y: 410, w: 266, h: 84, kind: "ext", title: "ED bridge export task", sub: ["separate TGW-attached VPC", "staging only (prod wired, off)", "NDJSON → S3 → SPS import task"] },
};

const groups = [
  { x: 40, y: 150, w: 1010, h: 540, kind: "net", title: "Deployed · shared its-reciter-vpc01 (TGW-attached) · 2 AZs · both envs", fo: 0.05 },
  { x: 70, y: 196, w: 960, h: 106, kind: "net", title: "dmz tier · public (IGW)", fo: 0.12 },
  { x: 450, y: 340, w: 580, h: 220, kind: "net", title: "app2 tier · /25", fo: 0.12 },
  { x: 70, y: 340, w: 340, h: 220, kind: "data", title: "db tier · /27", fo: 0.12 },
  { x: 1078, y: 196, w: 306, h: 320, kind: "ext", title: "Beyond the VPC · WCM side", fo: 0.10 },
];
const [gVpc] = groups;

const edges = [
  { p0: A(nodes.inet, "r"), p1: A(nodes.cf, "l"), color: "maroon" },
  { p0: A(nodes.cf, "r"), p1: A(nodes.ns, "l"), color: "maroon", label: "HTTPS · X-Origin-Verify", route: "straight" },
  { p0: A(nodes.ns, "b", 0.46), p1: A(nodes.albp, "t", 0.5), color: "maroon", label: ":443", lp: { x: 724, y: 122 }, route: "straight" },
  { p0: A(nodes.albp, "b", 0.5), p1: A(nodes.ecsapp, "t", 0.84), color: "indigo" },
  // app + ETL SGs both reach Aurora and OpenSearch (SG-to-SG) — two horizontals + one crossing.
  { p0: A(nodes.ecsapp, "l", 0.3), p1: A(nodes.aur, "r", 0.3), color: "indigo", label: "app", lp: { x: 430, y: 399 } },
  { p0: A(nodes.ecsetl, "l", 0.7), p1: A(nodes.os, "r", 0.7), color: "indigo", label: "etl", lp: { x: 430, y: 511 } },
  { p0: A(nodes.ecsapp, "l", 0.7), p1: A(nodes.os, "r", 0.3), color: "indigo" },
  { p0: A(nodes.ecsetl, "l", 0.3), p1: A(nodes.aur, "r", 0.7), color: "indigo" },
  { p0: A(nodes.ecsetl, "r", 0.5), p1: A(nodes.ialb, "l", 0.5), color: "green", label: ":80", route: "straight" },
  { p0: A(nodes.ecsetl, "b", 0.5), p1: A(nodes.vpce, "t", (625 - 520) / 290), color: "violet", label: "S3 gateway", lp: { x: 625, y: 580 }, route: "straight" },
  { p0: A(nodes.ecsapp, "r", 0.3), p1: A(nodes.nat, "b", 0.5), color: "gray", label: "egress", lp: { x: 884, y: 321 } },
  { p0: A(nodes.nat, "t", 0.5), p1: A(nodes.igw, "b", 0.5), color: "gray", route: "straight" },
  { p0: A(nodes.igw, "r", 0.5), p1: A(nodes.egress, "b", 0.2), color: "gray", dash: true },
  // TGW: the shared VPC reaches WCM/on-prem natively.
  { p0: A(gVpc, "r", (282 - 150) / 540), p1: A(nodes.onprem, "l", 0.5), color: "teal", label: "TGW", route: "straight" },
  { p0: A(nodes.edbr, "t", 0.5), p1: A(nodes.onprem, "b", 0.5), color: "gray", dash: true, label: "LDAPS :636", route: "straight" },
];

const decos = [
  `<text x="40" y="722" font-size="11" fill="#8a94a6">Public overview — internal network ranges, SG ids and hostnames generalized (masks only). A more detailed version is available on request.</text>`,
];

export const spec = { id: "network-topology", vb: [1400, 735], groups, nodes, edges, decos };

export const meta = {
  nav: "③ Network topology",
  kicker: "View 3 · for the cloud team",
  heading: "Network topology",
  dot: "#4263eb",
  blurb:
    "The review-ready network picture as deployed. <b>Consolidated</b> (staging 2026-07-02, prod 2026-07-05): " +
    "both envs run in the shared, TGW-attached <code>its-reciter-vpc01</code> with <b>no VPC peering</b>, " +
    "placed in three tiers — <b>dmz</b> (public ALB), <b>app2 /25</b> (app, every ETL task, internal ALB) and " +
    "<b>db /27</b> (Aurora, OpenSearch). Env isolation is by <b>per-env security groups</b>: app / etl / alb " +
    "pre-provisioned in the shared VPC and imported by id (allow-all egress); aurora / opensearch CDK-owned " +
    "with SG-to-SG ingress only. The NAT, IGW and VPC endpoints belong to the shared VPC — SPS creates none. " +
    "The front door is <b>CloudFront + WAF → NetScaler → ALB :443</b> (live; View ④), and WCM / on-prem " +
    "sources are reached <b>natively over the TGW</b> (#443 closed).",
  legend: [
    { fill: "#e7ecff", stroke: "#4263eb", label: "VPC / subnet tier / ALB / gateway" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS task" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data (db tier, private ENI)" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "VPC endpoint (shared-VPC-owned)" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "NetScaler (WCM-run, live)" },
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "External / WCM side" },
  ],
  extraHtml: `
    <div class="grid2">
      <div class="panel">
        <h3>Consolidated (staging 2026-07-02 · prod 2026-07-05)</h3>
        <ul class="agenda">
          <li>The two per-env Sps VPCs were replaced by one shared, TGW-attached
            <code>its-reciter-vpc01</code>; the whole estate (<b>App + Data + ETL</b>, both envs)
            moved in. <b>No VPC peering.</b> NetworkStack imports the VPC and owns no VPC, subnets,
            NAT, IGW or endpoints.</li>
          <li>Env isolation is by <b>per-env security groups</b> inside the one shared VPC:
            app / etl / alb pre-provisioned and imported by id; aurora / opensearch and the
            internal ALB's SG are CDK-owned, SG-to-SG ingress only.</li>
          <li>WCM / on-prem sources (ED-LDAP, ReciterDB, ASMS, InfoEd, COI + FRT on SQL Server,
            Jenzabar) are reached <b>natively over the shared VPC's TGW attachment</b> — #443 closed.</li>
          <li>Edge front door = <b>NetScaler</b> (CloudFront + WAF → NetScaler VIP → ALB :443 → Fargate;
            View ④), live staging 2026-07-21 / prod 2026-07-24. The ALB's :80 listener still exists
            but is not the live path; the WCM-only gate (#461) stays.</li>
          <li>Data tier restored from freeze-time snapshots into a new Aurora cluster and a fresh
            OpenSearch domain; the pre-cutover tier is retained, not deleted.</li>
          <li>The ED email-visibility bridge export runs in a separate WCM-built TGW-attached VPC
            (LDAPS :636 → NDJSON to S3 → import task in the SPS VPC) — staging only; wired but off in prod.</li>
        </ul>
      </div>
      <div class="panel">
        <h3>Before → deployed now</h3>
        <table class="env">
          <tr><th>&nbsp;</th><th>Before (pre-07-02)</th><th>Deployed now</th></tr>
          <tr><td class="k">VPC</td><td>per-env Sps VPCs</td><td>shared its-reciter-vpc01</td></tr>
          <tr><td class="k">Subnet tiers</td><td>public /24 · private /22</td><td>dmz · app2 /25 · db /27</td></tr>
          <tr><td class="k">Cross-network</td><td>—</td><td>none — all intra-VPC SG-to-SG</td></tr>
          <tr><td class="k">Env isolation</td><td>separate VPC / CIDR</td><td>per-env security groups</td></tr>
          <tr><td class="k">NAT / IGW / endpoints</td><td>SPS-owned</td><td>shared-VPC-owned</td></tr>
          <tr><td class="k">WCM / on-prem reach</td><td>blocked (#443)</td><td>native via TGW (#443 closed)</td></tr>
          <tr><td class="k">Old Sps VPCs</td><td>in use</td><td>retired (old data tier retained)</td></tr>
          <tr><td class="k">Edge front door</td><td>CloudFront → ALB</td><td>CloudFront + WAF → NetScaler → ALB (live 07-21 staging / 07-24 prod)</td></tr>
        </table>
        <p class="foot">Env isolation by <b>per-env security groups</b>: both envs share
          one VPC, so isolation is SG-reference (SG-to-SG), not CIDR. Consolidation superseded
          the earlier VPC-peering design (#1229 / #1310). See <code>docs/network-security-topology.md</code>.</p>
      </div>
    </div>`,
  source: "cdk/lib/network-stack.ts · cdk/lib/config.ts · cdk/lib/app-stack.ts · cdk/lib/data-stack.ts · cdk/lib/edge-stack.ts · docs/network-security-topology.md",
};
