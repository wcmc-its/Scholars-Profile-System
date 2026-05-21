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

Eight alarms per env, all defined in `cdk/lib/observability-stack.ts`. Every alarm publishes to the **page** SNS topic `sps-alarms-${env}`, which a Microsoft Teams channel webhook is subscribed to out-of-band. The operator email no longer rides this topic -- it lives on the sibling **notify** topic (`sps-notify-${env}`) used for cost-guardrail fan-out. Teams matches the WCM-native ops pattern (chat surface + ServiceNow tickets + manual Ops phone escalation); a dedicated paging tool was considered and rejected. See [`docs/oncall.md`](./oncall.md) for the full topology, alternates rationale, and the rollout runbook.

| # | Alarm name | Metric source | Threshold | Eval | What it catches |
|---|---|---|---|---|---|
| 1 | `sps-alb-5xx-rate-${env}` | Public ALB `HTTPCode_Target_5XX_Count / RequestCount` | > 1% | 5m, 2 datapoints | Availability SLO burn. |
| 2 | `sps-alb-unhealthy-hosts-${env}` | Target group `UnHealthyHostCount` | > 0 | 1m, 5 of 5 datapoints | Zero healthy targets sustained 5 minutes -- circuit-breaker did not catch it. |
| 3 | `sps-alb-latency-p99-${env}` | Public ALB `TargetResponseTime` p99 | > 1.5 s | 5m, 3 datapoints | Latency SLO burn. |
| 4 | `sps-ecs-task-shortfall-${env}` | ECS `DesiredTaskCount - RunningTaskCount` | > 0 | 1m, 5 of 5 datapoints | Tasks died and are not being replaced. |
| 5 | `sps-aurora-cpu-${env}` | Aurora `CPUUtilization` | > 80% | 5m, 3 datapoints | Hot query loop or runaway analytic. |
| 6 | `sps-aurora-connections-${env}` | Aurora `DatabaseConnections` | > 80 | 5m, 3 datapoints | Connection-pool exhaustion or unintended fan-out. |
| 7 | `sps-opensearch-jvm-pressure-${env}` | OpenSearch `JVMMemoryPressure` | > 85% | 5m, 3 datapoints | GC pressure cascading into query latency. |
| 8 | `sps-opensearch-cluster-red-${env}` | OpenSearch `ClusterStatus.red` | >= 1 | 1m, 1 datapoint | Shards unassigned -- searches affected. |

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

## Out of scope (for the next at least one quarter)

- **Burn-rate alerts** (multi-window / multi-burn-rate setup à la Google SRE Workbook). Deferred until >= 30 days of post-launch SLI data; pre-launch corpus does not give a real burn-rate distribution to tune against.
- **Per-route SLOs.** `/api/edit` writes and `/search` reads have very different latency profiles, but neither has the traffic to support an independent SLO yet. Revisit once a top-5 endpoint list emerges from real traffic.
- **ECS `SERVICE_DEPLOYMENT_FAILED` alarm via EventBridge.** Worth shipping once the rolling-deploy circuit-breaker has fired in anger at least once; pre-launch there is no signal to tune the suppression window. Filed as a B22.x follow-on.
- **Synthetic monitoring** (Route53 health checks, CloudWatch Synthetics canaries). Out of scope until traffic justifies a synthetic prober.
- **Distributed tracing instrumentation** for trace-driven latency attribution. That is [B24](https://github.com/wcmc-its/Scholars-Profile-System/issues/123) and orthogonal to CloudWatch metric-based alarming.
- **Per-env cost budgets** via tag allocation. The account is single-tenant for SPS, so the account-wide budget *is* the SPS budget.

## Operational hand-off

On-call topology, provider choice (Teams channel webhook; ServiceNow integration as a follow-on), per-env rollout, and the un-subscribe / rollback flow live in [`docs/oncall.md`](./oncall.md). The relevant SLO-side handles are:

- **Page topic** `sps-alarms-${env}` (CFN output `AlarmTopicArn`) -- the eight alarms in the catalog above publish here; a Microsoft Teams channel webhook is subscribed via HTTPS, configured out-of-band per `oncall.md`. No CDK-declared subscriptions on this topic.
- **Notify topic** `sps-notify-${env}` (CFN output `NotifyTopicArn`) -- account-wide budget thresholds and Cost Anomaly Detection publish here; the operator's work address (`paa2013@med.cornell.edu`) is subscribed by email. The split keeps a forecasted-budget tap off the page channel.
- Email subscriptions on each env's `sps-notify-${env}` require manual confirmation within 3 days of first deploy; AWS sends the confirmation request to the operator address. An unconfirmed subscription expires and cost notifications fire into the void.
