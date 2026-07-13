# Service Level Objectives

This doc is the policy half of [B22 (#121)](https://github.com/wcmc-its/Scholars-Profile-System/issues/121). It states what the Scholars Profile System holds itself to, how each target is measured, what happens when the budget burns, and what we deliberately are *not* committing to yet. Companion to [`docs/PRODUCTION_ADDENDUM.md` § ObservabilityStack](./PRODUCTION_ADDENDUM.md#observabilitystack) (resource catalog), [`docs/DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) (deploy-freeze procedure), and [ADR-008](./ADR-008-infrastructure-as-code.md) (where ObservabilityStack sits in the six-stack arrangement).

## SLO targets

Two SLOs, both measured at the public ALB, both windowed over 28 rolling days. The window choice is deliberate: long enough that a single bad deploy does not consume the entire budget, short enough that operational improvements show up within a quarter.

| SLO | Target | Window | Error budget |
|---|---|---|---|
| **Availability** | 99.5% of target-side requests return 2xx or 3xx | 28-day rolling | 3 h 22 min of allowed failed-request time per window |
| **Latency** | p99 of `TargetResponseTime` < 1.5 s | 28-day rolling | No explicit minute-budget; alarmed at threshold breach |

99.5% is chosen for a pre-launch academic profile system with no revenue-critical path and no SLA commitment to external customers. 99.9% would force architectural choices (Aurora multi-AZ failover budget, OpenSearch HA cluster sizing) that are not yet warranted; 99% would be loose enough that real degradations go unaddressed. The target tightens during the first SLO review after 30 days of post-launch traffic if the observed availability is materially above 99.5%.

1.5 s on p99 latency allows headroom for an Aurora B-tree index miss + Next.js cold render + ALB round trip. It is the operational tail, not the user-perceived response time at the CloudFront edge (which is EdgeStack's concern once B07+B14 ships). The right p99 SLO for end-user perceived latency is set after EdgeStack lands and the CloudFront `OriginLatency` metric is observable.

## Service Level Indicators (how each SLO is measured)

The SLO numbers above are derived from CloudWatch metrics on the public ALB; both alarm definitions in `cdk/lib/observability-stack.ts` reference the same metrics.

### Availability SLI

```
availability = (HTTPCode_Target_2XX_Count + HTTPCode_Target_3XX_Count) / RequestCount
```

evaluated over the 28-day rolling window. 4xx responses are explicitly excluded from the failure count: a client sending a malformed request is not the service failing the SLO. The alarm uses a 5-minute aggregation looking for sustained 5xx rate > 1% over 2 consecutive datapoints (10 minutes total) before paging; the SLO itself is the 28-day aggregate.

The 4xx exclusion has one caveat: a CloudFront WAF rule or a misbehaving middleware that surfaces server-side errors *as* 4xx (e.g. a misconfigured auth path returning 400 instead of 503) will not burn the availability budget but will absolutely degrade the service. The SLO doc explicitly does not catch this; the WAF + middleware code review is the actual safeguard.

### Latency SLI

```
latency_sli = p99(TargetResponseTime over 5m bucket)
```

evaluated continuously. `TargetResponseTime` is the time from the moment ALB sends a request to the ECS task to the moment it receives the last byte of the response. It excludes ALB front-end queueing and excludes the CloudFront edge round trip. The alarm fires when 3 consecutive 5m datapoints exceed 1.5 s; the SLO target is the 28-day p99.

## Error budget policy

99.5% availability over 28 days = 3 h 22 min of allowed 5xx response time per window.

The error-budget policy is **deploy-freeze on sustained burn**:

- If > 50% of the 28-day budget is burned in any rolling 7-day sub-window, deploys to prod pause until either the SLO recovers or an explicit override-with-reason is documented in the deploy runbook by the operator.
- Sub-window choice (7-day inside 28-day) catches the case where a single bad week is masked by three good weeks of aggregate; the latter is technically within SLO but is the on-call's actual problem.

The freeze is a **policy**, not enforcement. No automation gates deploys against budget burn; the gate is the deploy runbook's prod pre-deploy checklist (`docs/DEPLOY-RUNBOOK.md § Pre-deploy checklist`). Enforced gating is a deliberate non-goal until the freeze policy has been exercised against real traffic and tuned -- automating a wrong threshold is worse than the manual gate it would replace.

## Log retention policy

AppStack (`cdk/lib/app-stack.ts:180-185`) already sets log-group retention: 3 months for prod, 1 month for staging. Applied to both `/aws/ecs/sps-app-${env}` and `/aws/ecs/sps-migrate-${env}`.

The convention any new SPS-owned log group MUST follow:

- **Prod retention: 3 months.** Long enough to bisect an incident the user did not report until ~quarterly review; short enough that CloudWatch storage is bounded.
- **Staging retention: 1 month.** Staging is for current-deploy debugging, not historical forensics.
- **Migration logs:** same convention. Migrations are infrequent; the value of a year-long migration audit trail does not justify the storage cost when migrations themselves are git-recoverable via the `prisma/migrations/` directory plus AWS Backup retention on `_prisma_migrations`.

Log groups owned by other stacks (ReCiter, ReciterAI, etc.) are out of scope for this convention.

## Alarm catalog

Ten simple alarms per env plus one composite, all defined in `cdk/lib/observability-stack.ts`, split across two on-call **tiers** so the page channel carries only customer-facing problems:

- **P1 (page)** publishes to the **page** SNS topic `sps-alarms-${env}` -- the Teams on-call channel, via the B27 relay Lambda.
- **P2 (warn)** publishes to the **warn** SNS topic `sps-warn-${env}` -- the same relay posts these to a separate, quieter Teams channel, falling back to the page channel if that channel's webhook (`scholars/${env}/oncall/teams-webhook-url-warn`) is not yet provisioned, so demoting an alarm never silently drops it. P2 = leading indicators and operational signals that warrant attention but are not "wake on-call": resource pressure, the security-probe counter, and (in `cdk/lib/etl-stack.ts`, topic `etl-failures-${env}`) every ETL/reconciler data-freshness alarm.

The operator email rides the sibling **notify** topic (`sps-notify-${env}`), used for cost-guardrail fan-out and the B27 relay-failure alarm. Teams matches the WCM-native ops pattern (chat surface + ServiceNow tickets + manual Ops phone escalation); a dedicated paging tool was considered and rejected. See [`docs/oncall.md`](./oncall.md) for the full topology, the warn-channel provisioning runbook, alternates rationale, and the rollout runbook.

| # | Alarm name | Tier | Metric source | Threshold | Eval | What it catches |
|---|---|---|---|---|---|---|
| 1 | `sps-alb-5xx-rate-${env}` | P1 † | Public ALB `HTTPCode_Target_5XX_Count / RequestCount` | > 1% | 5m, 2 datapoints | Availability SLO burn. |
| 2 | `sps-alb-unhealthy-hosts-${env}` | P1 † | Target group `UnHealthyHostCount` | > 0 | 1m, 5 of 5 datapoints | Zero healthy targets sustained 5 minutes -- circuit-breaker did not catch it. |
| 3 | `sps-alb-latency-p99-${env}` | P1 | Public ALB `TargetResponseTime` p99 | > 1.5 s | 5m, 3 datapoints | Latency SLO burn. |
| 4 | `sps-ecs-task-shortfall-${env}` | P1 † | ECS `DesiredTaskCount - RunningTaskCount` | > 0 | 1m, 5 of 5 datapoints | Tasks died and are not being replaced. |
| 5 | `sps-aurora-cpu-${env}` | P2 | Aurora `CPUUtilization` | > 80% | 5m, 3 datapoints | Hot query loop or runaway analytic (leading indicator). |
| 6 | `sps-aurora-connections-${env}` | P2 | Aurora `DatabaseConnections` | > 70 | 5m, 2 datapoints | Connection-pool exhaustion or unintended fan-out (leading indicator). Normal peak is 60; each leaked Prisma pool is exactly +15; the cluster caps near 90. Retuned 2026-07-13 from `> 80 / 3 datapoints`, which sat *above* the leak's 75 plateau and demanded *longer* sustain than the spikes lasted -- it was blind to both. Budget + runbook: [`performance-baseline.md`](./performance-baseline.md). |
| 6b | `sps-db-pool-timeout-${env}` | **P1** | Log metric `SPS/Data DbPoolTimeout` | >= 1 | 5m, 1 datapoint | A request could not get a DB connection -- users are getting 500s **now**. The harm, where #6 is the leading indicator. `active=0 idle=0` in the log line means the **cluster** is at its cap, so recycling the app will not help. |
| 7 | `sps-opensearch-jvm-pressure-${env}` | P2 | OpenSearch `JVMMemoryPressure` | > 85% | 5m, 3 datapoints | GC pressure cascading into query latency (leading indicator). |
| 8 | `sps-opensearch-cluster-red-${env}` | P1 | OpenSearch `ClusterStatus.red` | >= 1 | 1m, 1 datapoint | Shards unassigned -- searches affected. |
| 9 | `sps-edit-authz-denied-${env}` | P2 | Log metric `SPS/Auth EditAuthzDenied` | > 10 | 5m, 2 datapoints | Sustained edit-surface 403s -- predicate bug or active probing. |
| C | `sps-app-unavailable-${env}` | P1 | Composite: `ALARM(#1) OR ALARM(#2) OR ALARM(#4)` | any child in ALARM | -- | The serving cascade. Single P1 page when 5xx-burst / zero-healthy-hosts / task-shortfall fire together from one root cause. |

† These three serving-failure symptoms carry **no direct action** -- they feed the `sps-app-unavailable-${env}` composite (row C), which is the single P1 page for a serving cascade. Without the composite, one root cause (e.g. Aurora connection exhaustion) posted three separate page cards for one incident. The children still evaluate, so the reliability dashboard and the composite rule see them.

Threshold values are calibrated for the current 1-2-task-per-env scale. Re-tune at the first SLO review after EdgeStack ships and CloudFront traffic is in the picture.

## Cost guardrail

Account-wide, not per-env, because most AWS line items (Aurora storage, OpenSearch instance hours, ECR registry storage) don't tag-isolate cleanly between staging and prod and the account is single-tenant for SPS per [project context](https://github.com/wcmc-its/Scholars-Profile-System/issues/121#issuecomment-).

Deployed only by `Sps-Observability-prod` (synth-time guard asserts staging contains zero `AWS::Budgets::Budget` resources, zero `AWS::CE::*` resources).

| Resource | Threshold | Notification |
|---|---|---|
| `sps-monthly-budget` | $600/mo | SNS to `sps-notify-prod` at 50% **forecast**, 80% **forecast**, 100% **actual** |
| `sps-anomaly-monitor` | $50 daily impact, dimension=SERVICE | SNS to `sps-notify-prod`, frequency=DAILY |

$600/mo is ~40% headroom above the audited Phase 0+1 baseline (~$425/mo combined across both envs). The next two phases (EdgeStack B07+B14, EtlStack B08+B20) will add cost; the budget gets revised when each lands rather than pre-emptively loose-set now.

$50 daily impact for the anomaly monitor is calibrated against ~$14/day baseline: a 4x spike (the kind we want to catch -- typically a runaway OpenSearch reshard, an ECS scale-out loop, or an accidental NAT-traffic explosion) is above $50; a 1.5x bumpy day is well below.

## Review cadence

Quarterly, with two opportunistic triggers:

1. **30 days after EdgeStack (B07+B14) lands.** CloudFront introduces a new latency surface (edge round trip) and a new cost surface (per-request pricing). Both the latency SLO and the cost-budget headroom need to be re-examined with traffic shape data.
2. **First time an SLO budget is fully burned in a 28-day window.** The freeze fires and the SLO doc is the artifact under review: is the target right, are the alarms calibrated, is the freeze policy enforceable.

Review is a written doc-update PR, not a meeting. Each review revises the targets, the alarm thresholds, and the freeze policy with explicit before/after numbers and the rationale.

**Alarm actionability (the standing guard against page-channel re-bloat).** Each review also pulls the per-alarm fire count for the period -- from CloudWatch `DescribeAlarmHistory` and the relay's structured `oncall_relay` log lines (which carry `severity` + `channel`) -- and asks, for every alarm that fired: *did anyone do anything?* Any alarm that fires repeatedly without ever driving an action is demoted (P1 -> P2) or deleted. "Fast and furious but meaningless" is how a page channel trains people to ignore it; this line item is what keeps the channel trustworthy after the initial tiering.

## Out of scope (for the next at least one quarter)

- **Burn-rate alerts** (multi-window / multi-burn-rate setup à la Google SRE Workbook). Deferred until >= 30 days of post-launch SLI data; pre-launch corpus does not give a real burn-rate distribution to tune against.
- **Per-route SLOs.** `/api/edit` writes and `/search` reads have very different latency profiles, but neither has the traffic to support an independent SLO yet. Revisit once a top-5 endpoint list emerges from real traffic.
- **ECS `SERVICE_DEPLOYMENT_FAILED` alarm via EventBridge.** Worth shipping once the rolling-deploy circuit-breaker has fired in anger at least once; pre-launch there is no signal to tune the suppression window. Filed as a B22.x follow-on.
- **Synthetic monitoring** (Route53 health checks, CloudWatch Synthetics canaries). Out of scope until traffic justifies a synthetic prober.
- **Distributed tracing instrumentation** for trace-driven latency attribution. That is [B24](https://github.com/wcmc-its/Scholars-Profile-System/issues/123) and orthogonal to CloudWatch metric-based alarming.
- **Per-env cost budgets** via tag allocation. The account is single-tenant for SPS, so the account-wide budget *is* the SPS budget.

## Operational hand-off

On-call topology, provider choice (Teams channel webhook; ServiceNow integration as a follow-on), per-env rollout, and the un-subscribe / rollback flow live in [`docs/oncall.md`](./oncall.md). The relevant SLO-side handles are:

- **Page topic** `sps-alarms-${env}` (CFN output `AlarmTopicArn`) -- the P1 alarms in the catalog above publish here (the `sps-app-unavailable-${env}` composite, latency-p99, cluster-red); the B27 relay Lambda is subscribed (CDK-managed `SnsEventSource`) and posts to the primary Teams channel.
- **Warn topic** `sps-warn-${env}` (CFN output `WarnTopicArn`) -- the P2 alarms publish here; the same relay Lambda is subscribed and posts to a separate, quieter Teams channel, falling back to the primary channel until `scholars/${env}/oncall/teams-webhook-url-warn` is provisioned (see `oncall.md` § Severity tiers). Keeps leading-indicator and data-freshness noise off the on-call channel.
- **Notify topic** `sps-notify-${env}` (CFN output `NotifyTopicArn`) -- account-wide budget thresholds and Cost Anomaly Detection publish here; the operator's work address (`paa2013@med.cornell.edu`) is subscribed by email. The split keeps a forecasted-budget tap off the page channel.
- Email subscriptions on each env's `sps-notify-${env}` require manual confirmation within 3 days of first deploy; AWS sends the confirmation request to the operator address. An unconfirmed subscription expires and cost notifications fire into the void.
