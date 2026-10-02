/**
 * View 2 — Application & AWS topology (how it's deployed).
 * Box fill = resource type; the top accent stripe = owning CDK stack (ADR-008).
 * Source: cdk/lib/*-stack.ts, cdk/bin/sps-infra.ts, docs/architecture-overview.md.
 */
import { A } from "../lib.mjs";

const nodes = {
  // ── Edge (outside AWS VPC) ──
  inet:  { x: 40, y: 40, w: 210, h: 72, kind: "ext", title: "Internet", sub: ["WCM-network visitors", "others → branded block page"] },
  cf:    { x: 560, y: 36, w: 310, h: 72, kind: "edge", title: "CloudFront + AWS WAF", sub: ["WCM-only IP allowlist · rate-limit 429", "managed + Bot Control (count)"], badge: "EdgeStack" },
  s3web: { x: 960, y: 36, w: 250, h: 72, kind: "data", title: "S3 · static + ISR cache", sub: ["/_next/static/* · OAC (EdgeStack)", "next-isr-cache/ · 7-day (AppStack)"] },
  ns:    { x: 615, y: 140, w: 200, h: 54, kind: "ext", title: "WCM NetScaler", sub: ["HTTPS origin front"] },

  // ── Left column: secrets, identity, AWS + ReCiter services the app calls ──
  sm:      { x: 40, y: 236, w: 220, h: 56, kind: "aws", title: "Secrets Manager", sub: ["env injected at task start"], badge: "SecretsStack" },
  saml:    { x: 40, y: 312, w: 220, h: 54, kind: "ext", title: "WCM SAML IdP", sub: ["login-proxy"] },
  ldap:    { x: 40, y: 386, w: 220, h: 54, kind: "ext", title: "WCM ED + Cornell LDAP", sub: ["LDAPS · authz · directory members"] },
  bedrock: { x: 40, y: 460, w: 220, h: 70, kind: "aws", title: "Amazon Bedrock", sub: ["Claude Opus 4.8 + Sonnet 4.x", "IAM-scoped, no Haiku"] },
  ddb:     { x: 40, y: 550, w: 220, h: 70, kind: "ext", title: "ReCiter DynamoDB", sub: ["Analysis · GoldStandard read", "core-claim + submission write"] },

  // ── Inside the shared VPC ──
  albp:  { x: 605, y: 250, w: 220, h: 70, kind: "net", title: "Public ALB · sps-public", sub: ["HTTPS :443 · X-Origin-Verify", "else default 403"], badge: "AppStack" },
  ecs:   { x: 560, y: 370, w: 310, h: 80, kind: "app", title: "ECS Fargate · sps-app", sub: ["Next.js (Node 22) + OTel sidecar"], badge: "AppStack" },
  ialb:  { x: 920, y: 370, w: 200, h: 56, kind: "net", title: "Internal ALB", sub: ["POST /api/revalidate"], badge: "AppStack" },
  aur:   { x: 470, y: 510, w: 200, h: 72, kind: "data", title: "Aurora MySQL", sub: ["Serverless v2 · writer+reader", "scholars + scholars_audit"], badge: "DataStack" },
  os:    { x: 690, y: 510, w: 180, h: 72, kind: "data", title: "OpenSearch 2.19", sub: ["5 aliases: people · pubs", "funding · opportunities · trials"], badge: "DataStack" },
  audit: { x: 890, y: 510, w: 200, h: 72, kind: "data", title: "scholars_audit DB", sub: ["append-only B03 audit", "same Aurora cluster"], badge: "DataStack" },
  mig:   { x: 312, y: 616, w: 200, h: 76, kind: "app", title: "Deploy one-shot tasks", sub: ["db-bootstrap → migrate →", "verify-grants · search canary"], badge: "AppStack" },
  etlt:  { x: 560, y: 616, w: 310, h: 84, kind: "app", title: "ECS Fargate · sps-etl", sub: ["sps-etl + per-secret task families:", "sources · ldap · reciter-api · ctsc", "bulk-data-rule (Python)"], badge: "EtlStack" },

  // ── Right column: ETL control plane + ETL-side buckets ──
  eb:    { x: 1165, y: 236, w: 215, h: 52, kind: "aws", title: "EventBridge", sub: ["crons + 5-min reconcilers"], badge: "EtlStack" },
  sfn:   { x: 1165, y: 304, w: 215, h: 100, kind: "aws", title: "Step Functions", sub: ["nightly · weekly · annual", "heartbeat · honors · grants-export", "reconcile + cdn-reconcile (5 min)", "staging only: backup · ED bridge"], badge: "EtlStack" },
  bkts:  { x: 1165, y: 620, w: 215, h: 72, kind: "data", title: "S3 · ETL buckets", sub: ["SES inbound mail (clips · funding)", "grants export · curation backup"] },

  // ── Below the VPC ──
  dr:    { x: 440, y: 750, w: 200, h: 62, kind: "ext", title: "DR backup vault", sub: ["us-west-2 · cross-region"], badge: "DrVault" },
  obs:   { x: 700, y: 750, w: 300, h: 100, kind: "aws", title: "Observability", sub: ["alarms → 3 SNS topics → relay λ → Teams", "edge-origin probe λ (5 min) · relay DLQ", "reliability dashboard · cost guards (prod)", "OTLP traces → X-Ray + New Relic"], badge: "Observability" },

  // Usage-analytics plane (Sps-Analytics, ADR-008 9th stack) — off-request, nightly.
  cflog:  { x: 300, y: 904, w: 250, h: 62, kind: "data", title: "CloudFront access logs", sub: ["S3 · cf/<env>/ · 90-day TTL"], badge: "EdgeStack" },
  rollup: { x: 620, y: 904, w: 264, h: 62, kind: "app", title: "Usage rollup Lambda", sub: ["sps-cf-usage-rollup", "EventBridge -> Athena INSERT"], chip: { tone: "nightly", text: "nightly" }, badge: "Analytics" },
  usage:  { x: 954, y: 904, w: 286, h: 62, kind: "data", title: "daily_usage (durable S3)", sub: ["Glue + Athena · aggregates only"], badge: "Analytics" },
};

const groups = [
  { x: 300, y: 226, w: 836, h: 492, kind: "net", title: "AWS · shared VPC (staging + prod)", fo: 0.06 },
  { x: 280, y: 880, w: 978, h: 108, kind: "aws", title: "Usage analytics · CloudFront logs (off-request)", fo: 0.05 },
];
const [gvpc] = groups;

const edges = [
  // Request path: CloudFront (WAF) → NetScaler → public ALB :443 → app.
  { p0: A(nodes.inet, "r"), p1: A(nodes.cf, "l"), color: "maroon", label: "HTTPS" },
  { p0: A(nodes.cf, "b"), p1: A(nodes.ns, "t"), color: "maroon", label: "HTTPS + X-Origin-Verify" },
  { p0: A(nodes.ns, "b"), p1: A(nodes.albp, "t"), color: "maroon", label: "HTTPS :443", lp: { x: 715, y: 212 } },
  { p0: A(nodes.albp, "b"), p1: A(nodes.ecs, "t"), color: "indigo" },
  { p0: A(nodes.cf, "r"), p1: A(nodes.s3web, "l"), color: "maroon", dash: true, label: "static" },
  { p0: A(nodes.ecs, "t", 0.12), p1: A(nodes.cf, "b", 0.12), color: "gray", dash: true, route: "straight", label: "invalidate", lp: { x: 597, y: 345 } },
  { p0: A(nodes.ecs, "r", 0.1), p1: A(nodes.s3web, "b", 0.16), color: "amber", label: "ISR cache", lp: { x: 895, y: 250 },
    points: [{ x: 895, y: 378 }, { x: 895, y: 130 }, { x: 1000, y: 130 }] },

  // App-side dependencies on the left.
  { p0: A(nodes.sm, "r"), p1: A(nodes.ecs, "l", 0.1), color: "violet", dash: true, label: "valueFrom" },
  { p0: A(nodes.saml, "r"), p1: A(nodes.ecs, "l", 0.3), color: "gray", label: "SAML" },
  { p0: A(nodes.ldap, "r"), p1: A(nodes.ecs, "l", 0.5), color: "gray", label: "LDAPS" },
  { p0: A(nodes.ecs, "l", 0.7), p1: A(nodes.bedrock, "r"), color: "violet", dash: true, label: "InvokeModel" },
  { p0: A(nodes.ecs, "l", 0.9), p1: A(nodes.ddb, "r"), color: "gray", label: "Get / Update / Put" },

  // App → data.
  { p0: A(nodes.ecs, "b", 0.1), p1: A(nodes.aur, "t", 0.6), color: "amber", label: "db r/w" },
  { p0: A(nodes.ecs, "b", 0.65), p1: A(nodes.os, "t", 0.4), color: "amber", label: "search" },
  { p0: A(nodes.ecs, "b", 0.95), p1: A(nodes.audit, "t", 0.2), color: "amber", label: "audit (same tx)" },
  { p0: A(nodes.mig, "t", 0.85), p1: A(nodes.aur, "b", 0.06), color: "gray", dash: true, label: "migrate" },

  // ETL plane.
  { p0: A(nodes.eb, "b"), p1: A(nodes.sfn, "t"), color: "green" },
  { p0: A(nodes.sfn, "l", 0.5), p1: A(nodes.etlt, "r", 0.35), color: "green", label: "invoke", lp: { x: 1148, y: 520 },
    points: [{ x: 1148, y: 354 }, { x: 1148, y: 645.4 }] },
  { p0: A(nodes.etlt, "t", 0.1), p1: A(nodes.aur, "b", 0.6), color: "green", label: "upsert" },
  { p0: A(nodes.etlt, "t", 0.7), p1: A(nodes.os, "b", 0.48), color: "green", label: "alias swap" },
  { p0: A(nodes.etlt, "r", 0.15), p1: A(nodes.ialb, "b", 0.95), color: "green", label: "revalidate", lp: { x: 1110, y: 470 },
    points: [{ x: 1110, y: 628.6 }] },
  { p0: A(nodes.etlt, "r", 0.6), p1: A(nodes.bkts, "l", 0.644), color: "green", dash: true, route: "straight", label: "export / backup", lp: { x: 985, y: 666.4 } },
  { p0: A(nodes.bkts, "l", 0.92), p1: A(nodes.etlt, "r", 0.85), color: "green", dash: true, route: "straight", label: "read mail", lp: { x: 1070, y: 687 } },

  // DR, telemetry.
  { p0: A(nodes.aur, "b", 0.33), p1: A(nodes.dr, "t", 0.48), color: "gray", dash: true, route: "straight", label: "AWS Backup daily → copy", lp: { x: 536, y: 734 } },
  { p0: A(gvpc, "b", (850 - 300) / 836), p1: A(nodes.obs, "t", 0.5), color: "gray", dash: true, label: "telemetry", lp: { x: 850, y: 734 } },

  // Usage-analytics plane: CloudFront delivers access logs to S3; a nightly Lambda
  // runs Athena to roll them into the durable, aggregates-only daily_usage table,
  // which the app reads for /edit/usage.
  { p0: A(nodes.cf, "t", 0.1), p1: A(nodes.cflog, "l", 0.5), color: "gray", dash: true, label: "access logs", lp: { x: 160, y: 18 },
    points: [{ x: 591, y: 18 }, { x: 22, y: 18 }, { x: 22, y: 935 }] },
  { p0: A(nodes.cflog, "r", 0.5), p1: A(nodes.rollup, "l", 0.5), color: "violet", label: "scan" },
  { p0: A(nodes.rollup, "r", 0.5), p1: A(nodes.usage, "l", 0.5), color: "violet", label: "INSERT" },
  { p0: A(nodes.ecs, "r", 0.9), p1: A(nodes.usage, "r", 0.5), color: "violet", dash: true, label: "Athena read · /edit/usage", lp: { x: 1272, y: 442 },
    points: [{ x: 1390, y: 442 }, { x: 1390, y: 935 }] },
];

export const spec = { id: "app-aws-topology", vb: [1400, 1010], groups, nodes, edges };

export const meta = {
  nav: "② App &amp; AWS topology",
  kicker: "View 2 · how it's deployed",
  heading: "Application &amp; AWS topology",
  dot: "#0ca678",
  blurb:
    "The runtime: <b>CloudFront + WAF (WCM-only) → NetScaler → ALB :443 → ECS Fargate → Aurora + " +
    "OpenSearch</b>, with <code>/_next/static</code> and a shared ISR cache on S3 and Claude via Bedrock. " +
    "Also shown: the staff write-path (SAML + LDAP authz, append-only audit) and the off-request-path ETL " +
    "plane (Step Functions → per-secret Fargate task families). Box <b>fill</b> encodes resource type; the " +
    "<b>top accent stripe</b> names the owning CDK stack. A separate nightly plane rolls CloudFront access " +
    "logs into a durable, aggregates-only usage table that <code>/edit/usage</code> reads.",
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
    ["NetworkStack", "imports shared VPC · per-env SGs"], ["DataStack", "Aurora, OpenSearch, AWS Backup"],
    ["SecretsStack", "Secrets Manager, rotation"], ["AppStack", "ECR, ECS, ALBs, deploy tasks, ISR cache"],
    ["EtlStack", "Step Functions, schedules, ETL buckets"], ["EdgeStack", "CloudFront, WAF, static-asset bucket"],
    ["Observability", "alarms, SNS, on-call relay, dashboard, cost guardrails"], ["DrVault", "us-west-2 backup vault"],
    ["Analytics", "Glue, Athena, usage rollup"],
  ],
  footnote:
    "Staging and prod share one VPC, isolated by per-env security groups. A 10th stack, " +
    "<b>Sps-InboundMail</b> (account-wide singleton, declared by the prod app), owns the SES receipt rules, " +
    "Route 53 zone and the inbound-mail bucket that both envs' ETL reads. Not drawn: the app's outbound " +
    "<code>ses:SendEmail</code> (one From address), the ETL's own Bedrock Sonnet grant (NCI Table 2A import), " +
    "and the <code>cdn-reconcile</code> ETL task's CloudFront invalidations (every 5 min, alongside the app's own).",
  source: "cdk/lib/*-stack.ts · cdk/bin/sps-infra.ts · docs/architecture-overview.md · OTel→X-Ray/New Relic (B24) · autoscaling (#596) · Sps-Analytics + reliability dashboard (#619) · NetScaler HTTPS origin (#1507) · S3 static (#700) + ISR cache (#1503) · Sps-InboundMail (#2740)",
};
