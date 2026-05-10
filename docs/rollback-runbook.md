# Rollback runbook — production ECS service

Operator-facing procedure for rolling the production ECS service back to the previous task definition revision. Pairs with [`ADR-004 — Deploy strategy: ECS rolling`](./ADR-004-deploy-strategy.md).

This runbook is for **app-code rollback only**. There is no migration rollback — see [`PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy) and `CONTRIBUTING.md` § Schema migrations. The additive-only migration rule means rolling the image back is safe; rolling the schema back is not.

## When to roll back

Roll back when **either** of the following holds for the post-deploy service, sustained over 5 minutes (i.e. not a single outlier minute):

- 5xx rate at the ALB target group ≥ 1% of requests, or
- p95 latency at the ALB target group ≥ 2× the pre-deploy steady-state baseline.

Both signals are visible on the ALB target-group CloudWatch dashboard. The deployment circuit breaker (configured per ADR-004) handles task-startup failures automatically; this runbook covers regressions that pass health checks but degrade real traffic.

## The paste-able rollback command

Replace `<CLUSTER>`, `<SERVICE>`, and `<PREVIOUS_TASK_DEF_REVISION>` with the values for the affected service. Find the previous revision from `aws ecs describe-services` → `deployments[].taskDefinition` (the entry with `status: PRIMARY` from before the current deploy) or from the task-definition family history.

```bash
aws ecs update-service \
  --cluster <CLUSTER> \
  --service <SERVICE> \
  --task-definition <FAMILY>:<PREVIOUS_TASK_DEF_REVISION> \
  --force-new-deployment
```

The service scheduler will roll the older revision back in using the same `minimumHealthyPercent: 100` / `maximumPercent: 200` configuration as a forward deploy. Expected duration: 4–6 minutes for a 4-task service.

## Verifying the rollback

1. Watch `aws ecs describe-services --cluster <CLUSTER> --services <SERVICE>` until `deployments` contains a single entry with `status: PRIMARY` pointing at the previous revision and `runningCount == desiredCount`.
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
