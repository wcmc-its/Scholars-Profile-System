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

Rollback when the circuit breaker does not fire (e.g. functional regression that passes health checks but produces 5xx in real traffic): operator-driven, by pointing the service at the previous, digest-pinned task-definition revision (see Amendment 1 below — this superseded an earlier `:latest`-tag-repoint procedure). The paste-able command sequence is documented in [`docs/rollback-runbook.md`](./rollback-runbook.md).

**Note on the image contract (fixed, see Amendment 1).** The task definition's CDK-synthesized template still pins the image by mutable tag (`cdk/lib/app-stack.ts`, first-deploy bootstrap value only) — but as of Amendment 1 below, the deploy workflow itself registers a genuinely new, digest-pinned task-definition revision every deploy, so the revision *is* the deploy unit in practice, and the circuit breaker's `rollback: true` reverts to a distinct, immutable previous image.

## Consequences

**Positive outcomes:**

The deploy is a single AWS API call (`UpdateService`) operating on a single resource (the ECS service). There is no ALB target-group pair to keep in sync, no CodeDeploy deployment group to provision, and no second listener rule per service. CDK / IaC stays small and reviewable.

The additive-only migration rule already gives a clean rollback path: restoring the previous image works because that image is, by policy, compatible with the new schema. Blue/green's marquee feature — "1-click revert without re-deploying" — collapses to roughly the same operation, only with more moving parts. The caveat is that under the mutable-tag contract above, our version of that operation is an ECR tag repoint rather than a revision selection, so it mutates shared state and is a few commands rather than one.

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

---

## Amendment 1 (2026-07-31) — Image contract fixed: digest-pinned revisions

**Status:** Accepted
**Date:** 2026-07-31
**Implementation:** #2121
**Amends:** § Decision ("Note on the image contract"), § Consequences (positive: "one task definition revision active at a time").
**Driver:** #2111 corrected this ADR and `rollback-runbook.md` to document the tag-repoint workaround honestly (the mutable-`:latest` gap described in the pre-amendment "Note on the image contract" above), rather than leaving a rollback procedure that silently didn't work. #2121 is the real fix the correction pointed at.

The deploy workflow (`.github/workflows/deploy.yml`, the "Pin task-definition revisions to this deploy's images" step) now clones each of the `sps-app` / `sps-migrate` / `sps-db-bootstrap` / `sps-verify-grants` families' current active revision, repoints only the running container's `image` field to that deploy's immutable `<repo>@sha256:...` digest, and registers it as a new revision — mirroring the digest-pinning discipline already applied to the otel sidecar (`cdk/lib/app-stack.ts`, asserted at `cdk/test/app-stack.test.ts` with an explicit `not.toMatch(/:latest/)`). Every run-task / update-service call in the same deploy targets that exact revision, never a bare family name.

Two consequences of the original ADR text this amendment supersedes:

- **The revision is now a real rollback signal.** `aws ecs update-service --task-definition <FAMILY>:<PREVIOUS>` (`docs/rollback-runbook.md`) genuinely rolls code back, replacing the ECR tag-repoint procedure #2111 introduced as the honest description of the previous, broken state.
- **The circuit breaker is a real recovery for a bad image**, not just for a task that fails to start for reasons outside the image (env change, secret, IAM). This closes the gap the original "Note on the image contract" flagged.

**Scope note.** This amendment covers the four families the deploy workflow drives directly (`sps-app`, `sps-migrate`, `sps-db-bootstrap`, `sps-verify-grants`). The six ETL-stack families invoked by Step Functions `EcsRunTask` states (`sps-etl` + `sources`/`ldap`/`reciter-api`/`reconcile`/`cdn-reconcile`) resolve a task-definition ARN baked into each state machine's ASL definition at `cdk deploy` time, not a bare family name at execution time — the deploy-workflow mechanism above is a no-op for them. Pinning those is separate follow-up work (different mechanism: a CDK-context digest thread plus a `cdk deploy EtlStack-<env>`, not `deploy.yml` surgery), scoped out of #2121 given the nightly/weekly ETL pipeline's recent incident history.
