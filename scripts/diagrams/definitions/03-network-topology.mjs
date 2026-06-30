/**
 * View 3 — Network topology (for cloud-team review).
 * VPC + subnet tiers + default-deny SGs + VPC endpoints + the ETL connectivity
 * migration (relocate the cadence to a TGW-attached VPC + peer back) and its open
 * items. One representative VPC; per-env values in the panel.
 * Source: cdk/lib/network-stack.ts, cdk/lib/config.ts, docs/network-security-topology.md,
 * docs/etl-vpc-migration-handoff.md, docs/etl-onprem-connectivity-gap.md.
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
  ecsetl: { x: 110, y: 490, w: 220, h: 58, kind: "app", title: "ECS ETL tasks", sub: ["SG: etl"], chip: { tone: "planned", text: "relocates" } },
  ialb:   { x: 110, y: 578, w: 220, h: 56, kind: "net", title: "Internal ALB", sub: ["SG: alb · /api/revalidate"] },
  aur:    { x: 410, y: 402, w: 210, h: 58, kind: "data", title: "Aurora MySQL", sub: ["SG: aurora"] },
  os:     { x: 410, y: 490, w: 210, h: 58, kind: "data", title: "OpenSearch", sub: ["SG: opensearch · private ENI"] },
  vpce:   { x: 410, y: 578, w: 300, h: 80, kind: "aws", title: "VPC endpoints", sub: ["Secrets Mgr · :443 (from app, etl)", "S3 gateway · ECR layers"] },
  // ETL connectivity migration (docs/etl-vpc-migration-handoff.md): the Sps VPC can't be
  // TGW-attached (10.20/10.10 overlaps WCM nets — Fabrice 2026-06-30), so BOTH envs' ETL
  // relocate into the shared TGW-attached lts-reciter-vpc01 for source reads and VPC-peer
  // back for datastore writes, isolated by per-env SGs (not network). #1229 merged flag-off;
  // peering #1310. Both flags OFF. Plan: docs/etl-shared-vpc-migration-plan.md.
  srcvpc: { x: 1098, y: 188, w: 266, h: 100, kind: "good", title: "Shared ETL VPC", sub: ["lts-reciter-vpc01 · TGW-attached", "10.46.134/.160 · both envs' ETL", "staging-ETL-SG · prod-ETL-SG"], chip: { tone: "planned", text: "flag OFF" } },
  onprem: { x: 1098, y: 312, w: 266, h: 64, kind: "ext", title: "On-prem + 10.46 sources", sub: ["ED-LDAP 10.63 · ReciterDB · ASMS", "COI · Jenzabar — reached via TGW"] },
  pcx:    { x: 1098, y: 400, w: 266, h: 104, kind: "open", title: "VPC peering ×2", sub: ["per env: ↔ Sps-staging 10.20", "+ ↔ Sps-prod 10.10 · same acct", "datastore admits its ETL-SG only"], chip: { tone: "planned", text: "flag OFF" } },
  ns:     { x: 1098, y: 528, w: 266, h: 80, kind: "open", title: "Edge / NetScaler  ✗ open", sub: ["NetScaler replace vs front CF?", "RITM0792011 · #502"] },
};

const groups = [
  { x: 40, y: 150, w: 1010, h: 528, kind: "net", title: "VPC   10.x.0.0/16   ·   2 AZs (us-east-1a / 1b)   ·   1 NAT", fo: 0.05 },
  { x: 70, y: 230, w: 950, h: 108, kind: "net", title: "Public subnets — /24 per AZ", fo: 0.12 },
  { x: 70, y: 372, w: 950, h: 296, kind: "net", title: "Private-with-egress subnets · /22 per AZ", fo: 0.12 },
  { x: 1078, y: 150, w: 306, h: 478, kind: "ext", title: "ETL connectivity → WCM / on-prem", fo: 0.12 },
];

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
  // Target ETL path (both gated OFF today): reads to on-prem/10.46 via the TGW from the
  // relocated VPC (proven <10ms); writes back to the Sps datastores over the VPC peer (pcx).
  { p0: A(nodes.srcvpc, "b", 0.35), p1: A(nodes.onprem, "t", 0.5), color: "teal", label: "TGW ✓ reads" },
  { p0: A(nodes.pcx, "l", 0.4), p1: A(nodes.aur, "r", 0.5), color: "violet", dash: true, label: "per-env SG-ref → writes", lp: { x: 845, y: 410 }, points: [{ x: 1040, y: 420 }, { x: 660, y: 432 }] },
];

export const spec = { id: "network-topology", vb: [1400, 720], groups, nodes, edges };

export const meta = {
  nav: "③ Network topology",
  kicker: "View 3 · for the cloud team",
  heading: "Network topology",
  dot: "#4263eb",
  blurb:
    "The review-ready network picture: VPC, subnet tiers, the three default-deny security groups " +
    "(SG-to-SG only), and VPC endpoints. The headline is the <b>ETL connectivity migration</b>: the " +
    "Sps VPC can't join the Transit Gateway (its 10.20/10.10 space overlaps WCM nets), so " +
    "<b>both envs' ETL relocates into the one shared, TGW-attached <code>lts-reciter-vpc01</code></b> " +
    "for source reads and <b>VPC-peers back</b> to reach Aurora / OpenSearch / the internal ALB. " +
    "Staging/prod isolation is by <b>per-env security group</b> (cross-VPC SG-reference, not CIDR) — " +
    "each env's datastores admit only its own ETL SG. Both flags OFF until the peer is up and probed.",
  legend: [
    { fill: "#e7ecff", stroke: "#4263eb", label: "VPC / subnet / ALB" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS task" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data (private ENI)" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "VPC endpoint" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "Proven / in place" },
    { fill: "#fff0f0", stroke: "#e03131", label: "Open · gated" },
  ],
  extraHtml: `
    <div class="grid2">
      <div class="panel agenda">
        <h3>⚑ Decided 2026-06-30, and what's left for networking</h3>
        <ol class="agenda">
          <li><b>Decided:</b> both envs' ETL relocate into the shared <code>lts-reciter-vpc01</code>
            (TGW-attached, same account <code>665083158573</code>, us-east-1); staging/prod isolation by
            <b>per-env SG</b> (cross-VPC SG-reference, not CIDR). Same account + region → peering
            <b>auto-accepts</b>. <span class="tag done">locked</span></li>
          <li><b>lts-side routes + SG creation.</b> Networking adds <code>10.20/16 → pcx</code> (staging)
            and <code>10.10/16 → pcx</code> (prod) on the lts-reciter side, and pre-creates
            <code>staging-ETL-SG</code> / <code>prod-ETL-SG</code> (SPS imports the ids). Need owner +
            SLA + the SG ids. <span class="tag open">G9</span></li>
          <li><b>SG-refs + DNS must be live or it silently fails.</b> Confirm "Allow referenceable
            security groups" is enabled on both peers, and that the Aurora/OpenSearch/ALB hostnames
            resolve to <code>10.20.x</code>/<code>10.10.x</code> from inside lts-reciter. Else the ingress
            rules build but never match. <span class="tag open">G3 · G4/G5</span></li>
          <li><b>Egress + IP capacity.</b> Does lts-reciter reach ECR / Logs / Secrets Mgr / S3 / DynamoDB
            (NAT or endpoints), and is there free subnet IP for the task ENIs alongside ReCiter RDS?
            <span class="tag open">G6 · G7</span></li>
          <li><b>Flag order (peer-then-move).</b> <code>etlVpcPeeringEnabled</code> first → deploy → probe
            Aurora/OS reach <i>from lts-reciter</i> → then <code>etlCadenceVpcRelocated</code> (synth blocks
            relocation without peering). Staging first. <span class="tag open">rollout</span></li>
          <li><b>Parked:</b> InfoEd (<code>10.20.91.8</code>, third-party, overlaps 10.20/16) excluded
            until WCM re-IP/NAT; NetScaler edge fork (RITM0792011 · #502).
            <span class="tag open">out of scope</span></li>
        </ol>
      </div>
      <div class="panel">
        <h3>Per-environment values</h3>
        <table class="env">
          <tr><th>&nbsp;</th><th>Staging</th><th>Production</th></tr>
          <tr><td class="k">Sps VPC CIDR</td><td>10.20.0.0/16</td><td>10.10.0.0/16</td></tr>
          <tr><td class="k">Shared ETL VPC</td><td>lts-reciter-vpc01</td><td>lts-reciter-vpc01</td></tr>
          <tr><td class="k">Per-env ETL SG</td><td>staging-ETL-SG</td><td>prod-ETL-SG</td></tr>
          <tr><td class="k">Peer return CIDR</td><td>10.46.134/.160</td><td>10.46.134/.160</td></tr>
          <tr><td class="k">Peering flag</td><td>OFF</td><td>OFF</td></tr>
          <tr><td class="k">Cadence relocated</td><td>OFF</td><td>OFF</td></tr>
          <tr><td class="k">ETL schedules</td><td>enabled</td><td>disabled</td></tr>
        </table>
        <p class="foot">Shared VPC + <b>per-env security groups</b>: each env's datastores admit only its
          own ETL SG by cross-VPC SG-reference over the peer (not a CIDR — both envs share
          <code>10.46.x</code>, so a CIDR can't tell them apart). Same account + us-east-1 → peering
          auto-accepts. Plan: <code>docs/etl-shared-vpc-migration-plan.md</code>.</p>
      </div>
    </div>`,
  source: "cdk/lib/network-stack.ts · cdk/lib/config.ts · docs/etl-shared-vpc-migration-plan.md · docs/etl-onprem-connectivity-gap.md · docs/network-security-topology.md",
};
