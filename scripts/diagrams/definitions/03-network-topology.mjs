/**
 * View 3 — Network topology (for cloud-team review).
 * VPC + subnet tiers + default-deny SGs + VPC endpoints + the WCM connectivity
 * path and its open items. One representative VPC; per-env values in the panel.
 * Source: cdk/lib/network-stack.ts, cdk/lib/config.ts, docs/network-security-topology.md.
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
  dns:    { x: 1098, y: 192, w: 266, h: 92, kind: "good", title: "DNS  ✓ codified", sub: ["R53 Resolver — 3 fwd rules", "weill / med / wcmc.ad.net", "RAM-shared · acct 091981818184"] },
  tgw:    { x: 1098, y: 312, w: 266, h: 104, kind: "open", title: "Routing  ✗ open", sub: ["Central Services Transit GW", "-> WCM firewall (open for CIDR)", "-> ED 10.63.215.108, InfoEd, COI"] },
  ns:     { x: 1098, y: 444, w: 266, h: 92, kind: "open", title: "Edge / NetScaler  ✗ open", sub: ["on-prem NetScaler SG in VPC", "blocked by :80 default-403", "RITM0792011 · #502"] },
};

const groups = [
  { x: 40, y: 150, w: 1010, h: 528, kind: "net", title: "VPC   10.x.0.0/16   ·   2 AZs (us-east-1a / 1b)   ·   1 NAT", fo: 0.05 },
  { x: 70, y: 230, w: 950, h: 108, kind: "net", title: "Public subnets — /24 per AZ", fo: 0.12 },
  { x: 70, y: 372, w: 950, h: 296, kind: "net", title: "Private-with-egress subnets · /22 per AZ", fo: 0.12 },
  { x: 1078, y: 150, w: 306, h: 412, kind: "ext", title: "WCM connectivity", fo: 0.12 },
];
const [gvpc] = groups;

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
  { p0: A(nodes.nat, "r", 0.5), p1: A(nodes.tgw, "l", 0.5), color: "red", dash: true, label: "route (times out)", points: [{ x: 1060, y: 290 }, { x: 1060, y: 364 }] },
  { p0: A(gvpc, "r", 0.16), p1: A(nodes.dns, "l", 0.5), color: "gray", dash: true, label: "resolver assoc" },
];

export const spec = { id: "network-topology", vb: [1400, 720], groups, nodes, edges };

export const meta = {
  nav: "③ Network topology",
  kicker: "View 3 · for the cloud team",
  heading: "Network topology",
  dot: "#4263eb",
  blurb:
    "The review-ready network picture: VPC, subnet tiers, the three default-deny security groups " +
    "(SG-to-SG only), VPC endpoints, and — the part that matters for the meeting — the <b>WCM " +
    "connectivity</b> path and its open items. Drawn for one representative VPC; per-env values " +
    "differ only where noted.",
  legend: [
    { fill: "#e7ecff", stroke: "#4263eb", label: "VPC / subnet / ALB" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "ECS task" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data (private ENI)" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "VPC endpoint" },
    { fill: "#ebfbee", stroke: "#2f9e44", label: "In place" },
    { fill: "#fff0f0", stroke: "#e03131", label: "Open / blocked" },
  ],
  extraHtml: `
    <div class="grid2">
      <div class="panel agenda">
        <h3>⚑ Cloud-team agenda — open items</h3>
        <ol class="agenda">
          <li><b>WCM routing (TGW + firewall).</b> DNS resolution is codified (3 RAM-shared resolver
            rules), but reaching the resolved IPs needs the Central Services <b>Transit Gateway</b>
            attachment + WCM-side <b>firewall</b> opened for our VPC CIDR — today traffic <b>times out</b>.
            Owner + ETA? Possible <b>CIDR overlap</b> of <code>10.20.0.0/16</code> with other WCM nets.
            <span class="tag open">gates ETL · #443</span></li>
          <li><b>Edge topology fork.</b> Does the on-prem <b>NetScaler replace</b> CloudFront+WAFv2, or
            <b>sit in front</b> of it? If fronting: NetScaler→ALB port, and an exception to the
            <code>:80</code> default-403 origin guard (it 403s NetScaler today).
            <span class="tag open">RITM0792011 · #502</span></li>
          <li><b>Firewall ownership.</b> Confirm who opens the WCM firewall for the SPS VPC CIDR(s) in
            staging <i>and</i> prod, and the change path. <span class="tag open">external team</span></li>
          <li><b>Single NAT in prod.</b> Account is at its EIP cap — one NAT gateway, so an AZ failure
            costs outbound for the other AZ. Raise EIP quota → 2nd NAT post-launch. <span class="tag open">accepted</span></li>
          <li><b>WAF gate.</b> Keep the WCM-only access gate (#461) in place until the edge topology is
            confirmed. <span class="tag done">in place</span></li>
        </ol>
      </div>
      <div class="panel">
        <h3>Per-environment values</h3>
        <table class="env">
          <tr><th>&nbsp;</th><th>Staging</th><th>Production</th></tr>
          <tr><td class="k">AWS account</td><td>separate</td><td>separate</td></tr>
          <tr><td class="k">VPC CIDR</td><td>10.20.0.0/16</td><td>10.10.0.0/16</td></tr>
          <tr><td class="k">AZs</td><td>1a, 1b</td><td>1a, 1b</td></tr>
          <tr><td class="k">NAT gateways</td><td>1</td><td>1 (EIP-capped)</td></tr>
          <tr><td class="k">App tasks</td><td>1 × .5/1GB</td><td>2 × 1/2GB</td></tr>
          <tr><td class="k">Aurora</td><td>0.5–2 ACU, writer</td><td>1–8 ACU, +1 reader</td></tr>
          <tr><td class="k">OpenSearch</td><td>1× t3.small</td><td>2× m6g.large</td></tr>
          <tr><td class="k">ETL schedules</td><td>enabled</td><td>disabled at deploy</td></tr>
        </table>
        <p class="foot">Resolver rules (RAM-shared from acct <b>091981818184</b>):
          weill.cornell.edu · med.cornell.edu · wcmc.ad.net — identical ids in both envs.</p>
      </div>
    </div>`,
  source: "cdk/lib/network-stack.ts · cdk/lib/config.ts · docs/network-security-topology.md · TGW/NetScaler ids per SPS connectivity records",
};
