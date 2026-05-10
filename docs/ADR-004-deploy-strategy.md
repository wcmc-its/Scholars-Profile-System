# docs/ADR-004 — Deploy strategy: ECS rolling

**Status:** Accepted
**Date:** 2026-05-10
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

Production traffic for `scholars.weill.cornell.edu` is served by an ECS service behind an Application Load Balancer, fronted by CloudFront. Mutating traffic is confined to `/api/edit*` and `/api/revalidate*`; everything else is read-only and cached at the edge for 24 hours. Aurora MySQL is the primary store; OpenSearch and Redis-style caches are the only other request-path dependencies.

A new app version ships through the deploy pipeline described in [`PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy): build → push to ECR → run one-shot `prisma migrate deploy` task → update the ECS service. The schema-migration policy is **additive-only**: every migration is backwards-compatible with the currently-running app version, so the previous image keeps working against the new schema until the rollout completes.

The open question this ADR closes is how the ECS service update itself shifts traffic from the old task set to the new one. Two options were considered: ECS rolling deploys (managed by the ECS service scheduler) and blue/green deploys (managed by AWS CodeDeploy with paired ALB target groups).

## Decision

**The deploy strategy is ECS rolling.** The ECS service is updated in place by registering a new task definition revision and letting the service scheduler replace tasks according to the deployment configuration:

- `minimumHealthyPercent: 100` — never drop below the steady-state task count.
- `maximumPercent: 200` — allow doubling during the rollout so old and new run side-by-side until new tasks pass ALB health checks.
- ALB health checks gate task registration: a new task is only added to the target group after `/api/health` returns 200, and the matching old task is drained before termination.
- Circuit breaker is enabled (`deploymentCircuitBreaker: { enable: true, rollback: true }`): if more than the threshold of new tasks fail to reach healthy, the service automatically reverts to the previous task definition without operator action.

Rollback when the circuit breaker does not fire (e.g. functional regression that passes health checks but produces 5xx in real traffic): operator-driven, by pointing the service at the previous task definition revision. The single paste-able command is documented in [`docs/rollback-runbook.md`](./rollback-runbook.md).

## Consequences

**Positive outcomes:**

The deploy is a single AWS API call (`UpdateService`) operating on a single resource (the ECS service). There is no ALB target-group pair to keep in sync, no CodeDeploy deployment group to provision, and no second listener rule per service. CDK / IaC stays small and reviewable.

The additive-only migration rule already gives a clean rollback path: rolling the ECS service back to the previous task definition works because the previous image is, by policy, compatible with the new schema. Blue/green's marquee feature — "1-click revert without re-deploying" — collapses to the same operation (point the service at the previous revision), only with more moving parts.

The deployment circuit breaker handles the most common failure mode (new tasks fail to start, fail health checks, or crash on boot) automatically. Operator intervention is only needed for behavioral regressions that pass health checks, which neither strategy detects automatically.

Local mental model is simpler: one task definition revision active at a time, except briefly during the rollout. Logs, metrics, and X-Ray traces all key off the task definition revision; there is no concept of "which target group is currently live" to reason about.

**Negative outcomes and mitigations:**

No staged-traffic shifting. Blue/green via CodeDeploy supports `CodeDeployDefault.ECSCanary10Percent5Minutes` and similar progressive shifts; ECS rolling does not. For a public read-mostly site with strong CDN caching, the practical value of canary traffic is limited — CloudFront's 24-hour cache means most user sessions don't even touch the new task set during the first hour of a rollout, so a canary of "10% of origin traffic" is a small fraction of a small fraction. If a future requirement makes progressive traffic shifting load-bearing (e.g. a high-RPS write path), this ADR can be revisited.

No automated test traffic against the new task set before it serves production traffic. ALB health checks gate registration but only verify that `/api/health` returns 200; they do not exercise the read endpoints. Mitigation: staging environment (B13 #112) gates the production deploy; smoke tests run against staging before promotion.

No automatic detection of behavioral regressions (5xx spikes, p95 increases) beyond the deployment circuit breaker's task-health check. The runbook documents the manual detect-and-rollback workflow; CloudWatch alarms (B22 #121) will eventually trigger SNS → on-call (B23 #122) for the same conditions, but that wiring is downstream of this ADR.

**Operational implications:**

Deployments take longer than blue/green (rolling replacement vs all-at-once swap). With `maximumPercent: 200` and a 30-second ALB health check grace period, a 4-task service typically rolls in 4–6 minutes. This is acceptable for a non-emergency deploy cadence; emergency hotfix rollouts are rare and the rollback command is paste-able.

The deployment circuit breaker's auto-rollback only triggers on task-health failures during the rollout itself. It does not protect against regressions detected after the rollout completes. The rollback runbook is the safety net for that case.

## Alternatives Considered

**Blue/green via CodeDeploy.** Rejected for this app at this scale. The benefits — staged traffic shifting, automated test traffic, 1-click revert without re-deploying — either don't apply (CDN caching limits the value of canary), or are achievable with rolling at lower operational complexity (the additive-migration rule makes "re-deploy the previous image" the same operation as "swap target groups"). Costs include: paired ALB target groups, a CodeDeploy deployment group and application, an extra IAM role, the AppSpec `appspec.yml` file in the repo, and a more complex CDK stack. None of these costs are prohibitive, but none of the benefits justify them at this scale today.

**Single all-at-once deploy (no rolling, no canary).** Rejected. ECS supports this with `minimumHealthyPercent: 0`, `maximumPercent: 100`, but it accepts a brief window of zero healthy tasks during the rollout. For a read-mostly site behind a 24-hour CDN cache, the user-visible impact is small, but there is no upside to giving up the rolling-deploy safety net.

**External traffic-shifting (e.g. CloudFront origin-failover for blue/green at the edge).** Rejected as out-of-pattern for ECS deploys and as a poor fit for `/api/edit*` / `/api/revalidate*`, which are explicitly not cached by CloudFront. The mutating endpoints would not benefit from edge-level traffic shifting, and the read endpoints already have strong CDN caching that masks origin behavior during a rollout.

## References

- [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy) — the additive-migration rule that makes image-rollback a clean operation under rolling deploys.
- [`docs/rollback-runbook.md`](./rollback-runbook.md) — the operator-facing detect-and-rollback procedure.
- B12 (#111) — the production-readiness backlog item this ADR closes.
- B09 (#108) — migration pipeline; the upstream operation this deploy strategy attaches to.
- B13 (#112) — staging environment; a full rollback drill against staging is a remaining acceptance criterion of B12.
- B22 (#121) / B23 (#122) — SLOs/alarms and on-call routing; downstream of this ADR.
