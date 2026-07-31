# Rollback runbook — production ECS service

Operator-facing procedure for rolling the production ECS service back to the previous task definition revision. Pairs with [`ADR-004 — Deploy strategy: ECS rolling`](./ADR-004-deploy-strategy.md).

This runbook is for **app-code rollback only**. There is no migration rollback — see [`PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy) and `CONTRIBUTING.md` § Schema migrations. The additive-only migration rule means rolling the image back is safe; rolling the schema back is not.

## When to roll back

Roll back when **either** of the following holds for the post-deploy service, sustained over 5 minutes (i.e. not a single outlier minute):

- 5xx rate at the ALB target group ≥ 1% of requests, or
- p95 latency at the ALB target group ≥ 2× the pre-deploy steady-state baseline.

Both signals are visible on the ALB target-group CloudWatch dashboard. The deployment circuit breaker (configured per ADR-004) handles task-startup failures automatically; this runbook covers regressions that pass health checks but degrade real traffic.

## The paste-able rollback command

Every deploy registers a new, digest-pinned task-definition revision for `sps-app-<env>` (and the migrate/db-bootstrap/verify-grants families it depends on) instead of force-new-deploying the same revision against a mutable `:latest` tag (`.github/workflows/deploy.yml`, the "Pin task-definition revisions to this deploy's images" step, #2121). Every revision in the family history is therefore a genuinely distinct, immutable image — selecting a previous revision **does** roll code back.

Rollback is one command. `<env>` is `staging` or `prod`.

```bash
# 1. Identify the previous known-good revision (each is pinned to one image digest).
aws ecs list-task-definitions --family-prefix sps-app-<env> --sort DESC --max-items 5
aws ecs describe-task-definition --task-definition sps-app-<env>:<REVISION> \
  --query 'taskDefinition.containerDefinitions[?name==`app`].image' --output text

# 2. Point the service at that revision. This starts a new rolling deployment.
aws ecs update-service --cluster sps-cluster-<env> \
  --service sps-app-<env> --task-definition sps-app-<env>:<PREVIOUS_REVISION>
```

The service scheduler rolls the tasks using the same `minimumHealthyPercent: 100` / `maximumPercent: 200` configuration as a forward deploy, gated by the same circuit breaker. Expected duration: 4–6 minutes for a 4-task service.

**Do not re-run the deploy workflow from a prior commit as your rollback path.** It re-runs the migration step. If the bad commit carried a migration you will either re-apply an applied migration (no-op, slow) or attempt a downgrade-via-expand that does not fit a hot rollback. The command above only moves the app service; it does not touch the migrate/db-bootstrap/verify-grants task definitions, matching this runbook's app-code-only scope.

The identical procedure appears in [`DEPLOY-RUNBOOK.md` § Bad image](./DEPLOY-RUNBOOK.md); that document is the operational source of truth for the deploy pipeline. Keep the two in sync, or collapse this section into a pointer.

## Verifying the rollback

1. Watch `aws ecs describe-services --cluster sps-cluster-<env> --services sps-app-<env>` until `deployments` contains a single entry with `status: PRIMARY` and `runningCount == desiredCount`. The revision number is now a real rollback signal: confirm it matches `<PREVIOUS_REVISION>` from step 1.
2. Confirm the ALB target-group 5xx rate returns to baseline within 5 minutes of the new tasks reaching healthy.
3. Tail CloudWatch Logs for the service and confirm new task IDs are emitting normal log lines (no boot-time errors).

## Blast radius

Read endpoints: small. CloudFront serves cached responses for 24 hours, so most users see no change during the rollback window. Affected requests are origin-misses (uncached paths or expired cache entries) that hit the new bad code; rolling back stops new misses from hitting it.

Write endpoints (`/api/edit*`, `/api/revalidate*`): rollback is immediate from the user's perspective once the new tasks register. In-flight requests against the bad version may have already written; the audit log (B03 #102) records the actor and the before/after values for any successful edit, so the scope of any bad writes is recoverable.

ETL: not affected. ETL Lambdas write to MySQL and trigger `/api/revalidate` independently of the request-path service revision.

## What this runbook does *not* cover

- **Migration rollback.** Don't. Fix forward with another expand migration. See `CONTRIBUTING.md`.
- **Aurora point-in-time recovery.** Different runbook (B10 #109). Use only when data corruption originates in the database itself, not in the app code.
- **CloudFront cache invalidation.** Use `/api/revalidate` (B04 #103) for surgical invalidation; `aws cloudfront create-invalidation` only for emergencies after an app-code rollback that changed cacheable response shapes.
- **OpenSearch alias swap.** Different system, different runbook (B18 #117). The request-path service rollback does not affect the search index.

## Drill cadence

Per ADR-004 acceptance criteria, a full rollback drill must be executed against staging before the runbook is considered validated. Re-run the drill at least quarterly thereafter, or after any change to the deploy pipeline, ECS service definition, or CDK stack.
