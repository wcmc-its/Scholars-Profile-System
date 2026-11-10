# SPS Rollback Runbook

Rolling the app back to the previous version · Scholars Profile System

| | | | |
|---|---|---|---|
| **Last updated** | **2026-11-09** | **Version** | 2.0 |
| **Owner** | Paul Albert, SPS service owner (paa2013@med.cornell.edu) | **Last drill** | 2026-11-10 00:48 UTC, staging: **Pass** |
| **Audience** | Whoever is handling a bad production deploy | **Next drill due** | By 2027-02-10 (quarterly), or after any pipeline, ECS or CDK change |

> [!IMPORTANT]
> **Use this runbook when**
>
> A deploy went out and the app is now misbehaving for real users: more errors or slower pages, even though the new tasks passed their health checks. Rolling back points the service at the previous app version. It takes about 3 to 6 minutes and touches nothing else.

> [!WARNING]
> **Never roll back by re-running the deploy workflow from an older commit**
>
> That re-runs the database migration step: if the bad commit carried a migration, it either re-applies an applied migration or attempts a downgrade that doesn't fit a hot rollback. Use the command in [Step 2](#step-2-roll-back) instead: it moves only the app service.

| **Not this problem?** | **Go to** |
|---|---|
| New tasks fail to start or fail health checks | Nothing to do: ECS rolls back on its own (deployment circuit breaker) |
| A database migration went wrong | Don't roll it back. Fix forward with another additive migration ([`CONTRIBUTING.md`](../CONTRIBUTING.md) § Schema migrations) |
| Data in the database is wrong or lost | [`restore-drill-runbook.md`](./restore-drill-runbook.md) (Aurora restore) |
| Pages still show old or wrong content | Operations Runbook, Playbook 6 (caches) |
| Search results are wrong | Operations Runbook, Playbook 14 (rebuild the index) |

**Contents**

- [Step 1. Decide whether to roll back](#step-1-decide-whether-to-roll-back)
- [Step 2. Roll back](#step-2-roll-back)
- [Step 3. Confirm it worked](#step-3-confirm-it-worked)
- [Step 4. After the rollback](#step-4-after-the-rollback)
- [What users experience](#what-users-experience)
- [Drills](#drills)
- [How it works](#how-it-works)
- [Revision history](#revision-history)

## Step 1. Decide whether to roll back

Roll back if **either** of these has held for 5 minutes or more since the deploy (not just one bad minute):

| **Signal** | **Threshold** |
|---|---|
| Error rate at the load balancer (ALB target group 5xx) | **1% or more** of requests |
| Response time at the load balancer (ALB target group p95) | **At least twice** the steady-state level before the deploy |

Both are on the `sps-reliability-<env>` dashboard and the ALB target-group metrics in CloudWatch. The `sps-app-unavailable-<env>` and `sps-alb-latency-p99-<env>` alarms usually fire first.

> [!NOTE]
> **Is the deploy really the cause?**
>
> If the problem started at the same time as an upstream outage or a database alarm, check the Operations Runbook triage table before rolling back. Stale data is never a reason to roll back.

## Step 2. Roll back

Set the environment first: `export ENV=prod` (or `staging`). Every deploy registers a new numbered revision of task definition `sps-app-<env>`, each pinned to one exact image, so picking the previous revision really does bring back the previous code.

1. See which revision is running now:

   ```bash
   aws ecs describe-services --cluster sps-cluster-$ENV --services sps-app-$ENV \
     --query 'services[0].deployments[].[status,taskDefinition,createdAt]' --output table
   ```

2. List the most recent revisions:

   ```bash
   aws ecs list-task-definitions --family-prefix sps-app-$ENV --sort DESC --max-items 5
   ```

3. Check which image a candidate revision runs. Pick the last one that was known to be good, usually the one just before the current revision:

   ```bash
   aws ecs describe-task-definition --task-definition sps-app-$ENV:<REVISION> \
     --query 'taskDefinition.containerDefinitions[?name==`app`].image' --output text
   ```

4. Point the service at that revision. This starts a normal rolling deployment:

   ```bash
   aws ecs update-service --cluster sps-cluster-$ENV \
     --service sps-app-$ENV --task-definition sps-app-$ENV:<PREVIOUS_REVISION>
   ```

5. Wait for it to settle (about 3 to 6 minutes):

   ```bash
   aws ecs wait services-stable --cluster sps-cluster-$ENV --services sps-app-$ENV
   ```

The rollout keeps every existing task serving until replacements are healthy (minimum 100%, maximum 200%), and the same circuit breaker protects it as on a forward deploy.

## Step 3. Confirm it worked

1. The service shows a single deployment, marked `PRIMARY`, with running tasks equal to desired, on the revision you chose:

   ```bash
   aws ecs describe-services --cluster sps-cluster-$ENV --services sps-app-$ENV \
     --query 'services[0].{deployments:deployments[].[status,taskDefinition,runningCount,desiredCount]}'
   ```

2. Within 5 minutes of the new tasks becoming healthy, the ALB 5xx rate is back to its normal level.

3. The new tasks are logging normally, with no startup errors:

   ```bash
   aws logs tail /aws/ecs/sps-app-$ENV --since 10m
   ```

> [!TIP]
> **If it didn't help**
>
> The deploy probably wasn't the cause. Roll forward again to the newer revision (same command, newer number) and work through the Operations Runbook triage table.

## Step 4. After the rollback

- **Prod now runs older code than master.** The next prod deploy will bring the bad change back unless it is fixed first. Fix forward: merge the fix to master, let it reach staging, then dispatch a prod deploy (Operations Runbook, Part 3).
- **Edits made by the bad version** are in the audit log (`scholars_audit.manual_edit_audit`), with who made them and the before and after values, so any bad writes can be found and corrected.
- **Cached pages.** If the bad version changed what cached pages look like, invalidate them surgically through `/api/revalidate`; use `aws cloudfront create-invalidation` only in an emergency. Otherwise the edge refreshes within minutes on its own.
- Tell active operators and record what happened (incident ticket, Teams thread).

## What users experience

| **Area** | **Effect of the rollback** |
|---|---|
| Public pages | Small. CloudFront and the origin page cache keep serving pages they already have. Only requests that miss the cache reach the app, so rolling back stops new misses from hitting the bad code. |
| Edits and cache refreshes (`/api/edit*`, `/api/revalidate*`) | Switch to the old code as soon as the new tasks register. Requests already handled by the bad version may have written data; see the audit log note in [Step 4](#step-4-after-the-rollback). |
| ETL | Not affected. ETL runs as separate ECS tasks under Step Functions and doesn't depend on which app revision is serving. |

## Drills

Run a drill on staging **every quarter**, and after any change to the deploy pipeline, the ECS service definition or the CDK app stack.

**How to run a drill (staging)**

1. Note the current revision (call it N) and confirm the previous revision runs a different image.
2. Roll back to N−1 using [Step 2](#step-2-roll-back). Time how long until the service is stable, and check `/api/health` returns 200.
3. Roll forward to N the same way. Time it and check `/api/health` again.
4. Confirm a single deployment with running equal to desired after each step, then add a row to the log below.

| **Date (UTC)** | **Env** | **Revisions** | **Rollback stable** | **Roll-forward stable** | **Outcome** |
|---|---|---|---|---|---|
| 2026-11-10 00:48 | staging | `:1028` → `:1027` → `:1028` (different images) | 170 s, health 200 | 219 s, health 200 | **Pass.** One deployment, running = desired after each step. First logged drill. |

## How it works

- Each deploy (`.github/workflows/deploy.yml`, step "Pin task-definition revisions to this deploy's images") registers new revisions of `sps-app-<env>` and of the migrate, db-bootstrap and verify-grants families, each pinned to an image digest rather than the moving `:latest` tag. Every revision in the history is a distinct, unchangeable image.
- The rollback command moves only the app service. It doesn't touch the migration, bootstrap or grant-check task definitions, so the database is left as it is.
- Migrations are additive only, which is why running older app code against the newer schema is safe, and why migrations are never rolled back.
- The same procedure appears in [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) § Bad image, app returning 5xx, which is the source of truth for the deploy pipeline. Keep the two in sync.

Related: [`ADR-004-deploy-strategy.md`](./ADR-004-deploy-strategy.md) · [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) · [`PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy) · [`OPERATIONS-RUNBOOK.md`](./OPERATIONS-RUNBOOK.md)

## Revision history

| **Version** | **Date** | **Changes** |
|---|---|---|
| 2.0 | 2026-11-09 | Rewritten as a step-by-step procedure with a decision step, verification, after-care and a drill procedure. Corrections:<br>• CloudFront no longer caches pages for 24 hours (edge limit is now 60 seconds, plus a 6-hour origin page cache).<br>• ETL runs as ECS tasks under Step Functions, not Lambda functions.<br>• Rollback timing based on the measured drill rather than a 4-task service (prod runs 2 tasks).<br>• Added a wait command and a log check to verification. |
| 1.0 | Earlier | Original runbook, including the first staging drill. |
