/**
 * View 2 — Application & AWS topology (how it's deployed).
 * Box fill = resource type; the top accent stripe = owning CDK stack (ADR-008).
 * Source: cdk/lib/*-stack.ts, docs/architecture-overview.md.
 */
import { A } from "../lib.mjs";

const nodes = {
  inet:  { x: 40, y: 46, w: 170, h: 50, kind: "ext", title: "Internet", sub: ["visitors · crawlers"] },
  cf:    { x: 560, y: 40, w: 310, h: 62, kind: "edge", title: "CloudFront + AWS WAF", sub: ["rate-limit · managed rules · #461"], badge: "EdgeStack" },
  sm:    { x: 40, y: 246, w: 220, h: 56, kind: "aws", title: "Secrets Manager", sub: ["env injected at task start"], badge: "SecretsStack" },
  saml:  { x: 40, y: 338, w: 220, h: 54, kind: "ext", title: "WCM SAML IdP", sub: ["login-proxy"] },
  ldap:  { x: 40, y: 416, w: 220, h: 54, kind: "ext", title: "Enterprise Directory", sub: ["LDAPS · authz re-check"] },
  albp:  { x: 560, y: 176, w: 310, h: 56, kind: "net", title: "Public ALB · sps-public", sub: ["X-Origin-Verify gate"], badge: "AppStack" },
  mig:   { x: 330, y: 286, w: 180, h: 60, kind: "app", title: "Migration task", sub: ["prisma migrate deploy"], badge: "AppStack" },
  ecs:   { x: 560, y: 286, w: 310, h: 64, kind: "app", title: "ECS Fargate · sps-app", sub: ["Next.js (Node 22) + OTel sidecar"], badge: "AppStack" },
  ialb:  { x: 920, y: 286, w: 200, h: 56, kind: "net", title: "Internal ALB", sub: ["POST /api/revalidate"], badge: "AppStack" },
  aur:   { x: 404, y: 430, w: 212, h: 64, kind: "data", title: "Aurora MySQL", sub: ["Serverless v2 · writer+reader"], badge: "DataStack" },
  os:    { x: 640, y: 430, w: 186, h: 64, kind: "data", title: "OpenSearch", sub: ["alias: scholars"], badge: "DataStack" },
  audit: { x: 852, y: 430, w: 236, h: 64, kind: "data", title: "scholars_audit DB", sub: ["append-only B03 audit"], badge: "DataStack" },
  etlt:  { x: 560, y: 520, w: 310, h: 60, kind: "app", title: "ECS Fargate · sps-etl", sub: ["npm run etl:<source>"], badge: "EtlStack" },
  xray:  { x: 404, y: 636, w: 200, h: 60, kind: "aws", title: "X-Ray + New Relic", sub: ["OTLP traces (sidecar)"] },
  obs:   { x: 760, y: 636, w: 220, h: 60, kind: "aws", title: "Observability", sub: ["alarms->SNS->Lambda->Teams"], badge: "Observability" },
  eb:    { x: 1180, y: 198, w: 180, h: 52, kind: "aws", title: "EventBridge", sub: ["cron schedules"], badge: "EtlStack" },
  sfn:   { x: 1180, y: 282, w: 180, h: 60, kind: "aws", title: "Step Functions", sub: ["nightly/weekly/annual"], badge: "EtlStack" },
  dr:    { x: 1180, y: 430, w: 180, h: 62, kind: "ext", title: "DR backup vault", sub: ["us-west-2 · cross-region"], badge: "DrVault" },
};

const groups = [{ x: 300, y: 140, w: 840, h: 468, kind: "net", title: "AWS · VPC (us-east-1)", fo: 0.06 }];
const [gvpc] = groups;

const edges = [
  { p0: A(nodes.inet, "r"), p1: A(nodes.cf, "l"), color: "maroon", label: "HTTPS" },
  { p0: A(nodes.cf, "b"), p1: A(nodes.albp, "t"), color: "maroon", label: "X-Origin-Verify" },
  { p0: A(nodes.albp, "b"), p1: A(nodes.ecs, "t"), color: "indigo" },
  { p0: A(nodes.sm, "r"), p1: A(nodes.ecs, "l", 0.28), color: "violet", dash: true, label: "valueFrom" },
  { p0: A(nodes.saml, "r"), p1: A(nodes.ecs, "l", 0.62), color: "gray", label: "SAML" },
  { p0: A(nodes.ldap, "r"), p1: A(nodes.ecs, "l", 0.85), color: "gray", label: "LDAPS" },
  { p0: A(nodes.ecs, "b", 0.3), p1: A(nodes.aur, "t", 0.55), color: "amber", label: "db r/w" },
  { p0: A(nodes.ecs, "b", 0.55), p1: A(nodes.os, "t", 0.5), color: "amber", label: "search" },
  { p0: A(nodes.ecs, "b", 0.82), p1: A(nodes.audit, "t", 0.35), color: "amber", label: "audit (same tx)" },
  { p0: A(nodes.mig, "b"), p1: A(nodes.aur, "t", 0.15), color: "gray", dash: true, label: "migrate" },
  { p0: A(nodes.eb, "b"), p1: A(nodes.sfn, "t"), color: "green" },
  { p0: A(nodes.sfn, "l"), p1: A(nodes.etlt, "r", 0.25), color: "green", label: "invoke", points: [{ x: 1155, y: 312 }, { x: 1155, y: 558 }, { x: 882, y: 558 }] },
  { p0: A(nodes.etlt, "t", 0.32), p1: A(nodes.aur, "b", 0.5), color: "green", label: "upsert" },
  { p0: A(nodes.etlt, "t", 0.6), p1: A(nodes.os, "b", 0.5), color: "green", label: "alias swap" },
  { p0: A(nodes.etlt, "r", 0.4), p1: A(nodes.ialb, "b", 0.95), color: "green", label: "revalidate", points: [{ x: 1110, y: 544 }, { x: 1110, y: 360 }] },
  { p0: A(nodes.audit, "r", 0.4), p1: A(nodes.dr, "l", 0.4), color: "gray", dash: true, label: "backup copy" },
  { p0: A(gvpc, "b", 0.243), p1: A(nodes.xray, "t", 0.5), color: "gray", dash: true, label: "traces" },
  { p0: A(gvpc, "b", 0.679), p1: A(nodes.obs, "t", 0.5), color: "gray", dash: true, label: "telemetry" },
];

export const spec = { id: "app-aws-topology", vb: [1400, 740], groups, nodes, edges };

export const meta = {
  nav: "② App &amp; AWS topology",
  kicker: "View 2 · how it's deployed",
  heading: "Application &amp; AWS topology",
  dot: "#0ca678",
  blurb:
    "The runtime: <b>CloudFront + WAF → ALB → ECS Fargate → Aurora + OpenSearch</b>, the staff " +
    "write-path (SAML + LDAP authz, append-only audit), and the off-request-path ETL plane. Box " +
    "<b>fill</b> encodes resource type; the <b>top accent stripe</b> names the owning CDK stack.",
  legend: [
    { fill: "#f1f3f5", stroke: "#adb5bd", label: "External" },
    { fill: "#fbeaea", stroke: "#7d1c1c", label: "Edge / CDN" },
    { fill: "#e7ecff", stroke: "#4263eb", label: "Load balancer" },
    { fill: "#e3faf3", stroke: "#0ca678", label: "Compute (Fargate)" },
    { fill: "#fff4d6", stroke: "#f08c00", label: "Data store" },
    { fill: "#f0ebff", stroke: "#7048e8", label: "AWS managed service" },
  ],
  // rendered as a second legend row; keyed by STACKC
  stackLegend: [
    ["NetworkStack", "VPC, subnets, SGs, endpoints"], ["DataStack", "Aurora, OpenSearch"],
    ["SecretsStack", "Secrets Manager, rotation"], ["AppStack", "ECR, ECS, ALBs, migration"],
    ["EtlStack", "Step Functions, schedules"], ["EdgeStack", "CloudFront, WAF"],
    ["Observability", "alarms, SNS, on-call"], ["DrVault", "us-west-2 backup vault"],
  ],
  source: "cdk/lib/*-stack.ts · docs/architecture-overview.md · OTel→X-Ray/New Relic (B24) · autoscaling (#596)",
};
