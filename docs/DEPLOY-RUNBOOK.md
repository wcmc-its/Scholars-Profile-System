# Deploy runbook

This is the operator reference for shipping a build of the Scholars Profile System to staging or production. It pairs with `.github/workflows/deploy.yml`, which automates the same deploy pipeline. Read this end-to-end once; thereafter, use it as the lookup for emergencies and the prod pre-deploy checklist.

Closes the documentation half of [#108](https://github.com/wcmc-its/Scholars-Profile-System/issues/108) (B09 deploy-workflow) and [#111](https://github.com/wcmc-its/Scholars-Profile-System/issues/111) (B12 deploy strategy + rollback). Companion to [`docs/PRODUCTION_ADDENDUM.md` § AppStack](./PRODUCTION_ADDENDUM.md#appstack), [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](./PRODUCTION_ADDENDUM.md#schema-migration-policy), [`docs/STAGING.md`](./STAGING.md), and [`ADR-004` Deploy strategy](./ADR-004-deploy-strategy.md).

## Normal path

A typical end-to-end deploy looks like this:

| Step | Owner | Duration | What happens |
|---|---|---|---|
| 1 | Developer | — | PR merges to `master`. |
| 2 | `deploy.yml` | ~30 s | OIDC handshake; assume `sps-deploy-staging`; query `Sps-App-staging` outputs. |
| 3 | `deploy.yml` | ~3 min | `docker build` of the Next.js standalone image. |
| 4 | `deploy.yml` | ~30 s | Push to `scholars-app-staging:${sha}` + `:latest`. |
| 5 | `deploy.yml` | ~30 s (no-op typical) | Run `sps-migrate-staging` Fargate task; wait for stopped; assert `exitCode == 0`. |
| 6 | `deploy.yml` | ~3 min | `ecs update-service --force-new-deployment` triggers rolling replacement. |
| 7 | `deploy.yml` | ~5 min worst-case | `ecs wait services-stable` polls every 15 s until `runningCount == desiredCount` and the older deployment count drops to zero. |
| 8 | `deploy.yml` | ~10 s | Curl `/api/health` against the public ALB DNS; retry up to 5 times with 5 s gap. |

Total wall-clock for a staging deploy with no pending migrations: ~7-9 minutes. A migration adds whatever Prisma needs to apply it. The 3-minute rolling-replacement step is the constant cost of zero-downtime for ECS Fargate.

To promote a tested build to **production**:

1. Open `Actions -> Deploy` in the GitHub UI.
2. Click `Run workflow`. Pick **branch `master`** (the OIDC sub-claim enforces this) and **env `prod`**.
3. Click the green `Run workflow` button. The job lands in `Awaiting approval` state.
4. The `prod` GitHub Environment's required reviewer (you) gets the approval prompt; click `Approve and deploy`.
5. The same deploy pipeline runs against `Sps-App-prod`, the prod ECR repo, and the prod ECS service.

The CLI equivalent of step 2 is `gh workflow run deploy.yml --ref master -f env=prod`. Approval still gates the run.

## Why rolling, not blue/green

The deploy is rolling: ECS replaces old tasks one (or two) at a time, with `minHealthy=100% / maxHealthy=200%`. We deliberately did not implement blue/green via `aws ecs create-deployment` with a CodeDeploy traffic shift. Four reasons:

1. **Small fleet.** Staging runs 1 task, prod runs 2. The "extra task during deploy" cost (1 -> 2 briefly; 2 -> 3 briefly) is trivial. A blue/green pattern needs a second, idle task-set that doubles steady-state cost for no operational benefit at this scale.
2. **Additive-only migrations.** Per `CONTRIBUTING.md` § "No rollback. Fix forward.", every migration is backwards-compatible with the previous app version. The previous version reads the old shape; the new column is unused until the next deploy makes it active. That property is what makes a rolling deploy safe: at any moment during the rolling window, both versions are running against a schema they can both read.
3. **Circuit-breaker covers the failure mode.** `cdk/lib/app-stack.ts` sets `circuitBreaker: { rollback: true }` on the service. If new tasks fail health-checks during the rolling window, ECS auto-rolls back to the previous task-set without operator intervention. That is the failure mode a blue/green setup would protect against; we get it from the service config.
4. **Operational simplicity.** Rolling = one workflow file, one IAM role, no CodeDeploy hook Lambdas, no traffic-shift policies to maintain.

Revisit the decision when **any** of:

- Steady-state fleet exceeds 4 tasks per env (the "extra task" cost stops being trivial).
- Sustained traffic exceeds 100 RPS to the public ALB (so a 3-minute rolling window has user-visible impact on a few tens of thousands of requests).
- p99 latency budget tightens below 200 ms (a draining task's in-flight requests have a longer tail than 200 ms; rolling replacement starts showing up in p99).
- An external compliance requirement mandates atomic traffic shifts.
- A multi-AZ failure-isolation requirement appears (blue/green can pin task-sets to specific AZs).

None of these are true today. If two become true, open a workstream to implement CodeDeploy blue/green; the AppStack outputs are already shaped to feed it.

## The deploy pipeline contract

Lifted from `docs/PRODUCTION_ADDENDUM.md` § "Where migrations run" and codified in `.github/workflows/deploy.yml`. Steps 3 and 4 self-skip (with a warning) until their task families are deployed; once present they are fail-closed gates that run **before** migrate and the service roll:

```
1. build image
2. push to ECR (app image + ETL batch image)
3. db-bootstrap task (#493)
     provisions scholars_audit + the app-rw INSERT grant, as the least-priv
     sps_bootstrap user; idempotent
     exit 0 -> continue; non-zero -> fail the deploy, do not roll the service
4. verify-grants task (ADR-009)
     asserts every managed DB role's live grants == its pinned golden list;
     read-only; fails closed on ANY drift (excess or missing)
     exit 0 -> continue; non-zero -> fail the deploy, do not roll the service
5. run migration task
     image:   same image as the new app version
     command: prisma migrate deploy
     secret:  scholars/{env}/db/app-rw (writer DSN, injected via task-execution role)
     exit 0 -> continue; non-zero -> fail the deploy, do not roll the service
6. update ECS service -> rolling deploy of the new image
7. wait for stability + smoke test
```

This order is load-bearing. db-bootstrap runs first so the audit schema + grant exist; verify-grants then confirms the whole DB role model is intact before any credential is used to migrate; the migration runs **before** the service updates because the schema must be ready when the new app version starts; the previous app version is still serving traffic throughout (additive-only rule makes this safe). If any gate (3, 4, 5) fails, step 6 never fires and the previous app version continues serving against the unchanged schema.

Any out-of-band deploy (e.g. an operator running `aws ecs update-service` manually because the workflow is broken) MUST follow the same order: db-bootstrap and verify-grants MUST exit 0, then the migration task MUST exit 0, before the service is rolled. Skipping the migration step risks shipping a new app version against an old schema; skipping verify-grants risks rolling on a drifted/over-privileged DB role model; skipping the ordering risks shipping a new schema before the app that needs it.

## Bootstrap two-step (first deploy of an env)

On the first deploy of `Sps-App-${env}`, ECR is empty and the ECS service can't pull an image. The first workflow run will fail at step "Build image" or "Push image" if the repo doesn't exist yet, or at step "Wait for service to stabilize" if ECR is empty. This is one-time setup per env, manual:

```sh
# 1. Deploy AppStack with desiredCount=0 so the service doesn't loop on
#    failed pulls.
cd cdk
npx cdk deploy --exclusively Sps-App-${env} -c env=${env} -c appDesiredCount=0

# 2. Build + push a bootstrap image so :latest exists in the ECR repo.
ecr_uri=$(aws cloudformation describe-stacks \
  --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcrRepoUri`].OutputValue' --output text)

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$ecr_uri"

cd ..  # repo root
docker build --tag "$ecr_uri:bootstrap" --tag "$ecr_uri:latest" .
docker push "$ecr_uri:bootstrap"
docker push "$ecr_uri:latest"

# 3. Optionally run the migration task once to prove the wiring.
cluster=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsClusterName`].OutputValue' --output text)
service=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsServiceName`].OutputValue' --output text)
mig_family=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsMigrationTaskFamily`].OutputValue' --output text)
netcfg=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].networkConfiguration' --output json)
aws ecs run-task --cluster "$cluster" \
  --task-definition "$mig_family" \
  --launch-type FARGATE \
  --network-configuration "$netcfg"

# 4. Re-deploy with desiredCount back to env default.
cd cdk
npx cdk deploy --exclusively Sps-App-${env} -c env=${env}
```

After step 4, the workflow can succeed on subsequent runs. Repeat the two-step for each env on its very first AppStack deploy. Subsequent CDK deploys (config changes, etc.) do not need it.

## One-time GitHub Environment setup

Before the workflow can enforce the prod approval gate, the `prod` GitHub Environment must exist with at least one required reviewer. This is a repo-settings UI action, not a workflow-file action:

1. Repository `Settings -> Environments -> New environment`.
2. Name: `prod` (must match the `inputs.env` choice exactly).
3. Configure `Required reviewers`: add at least one reviewer (the account owner).
4. Optional: configure `Deployment branches and tags -> Selected branches -> master` (defense-in-depth alongside the OIDC sub-claim).
5. Save.
6. Repeat for `staging` with no required reviewer (still useful so the Environment shows in the Actions UI alongside `prod`).

Until this is done, a `workflow_dispatch env=prod` run will execute without approval. The OIDC sub-claim still pins prod to `refs/heads/master`, so the deploy can only originate from master; but the explicit human click is the additional in-band safeguard this runbook expects.

## Emergency procedures

### Bad image, app returning 5xx

First check the ECS service event log:

```sh
aws ecs describe-services --cluster sps-cluster-${env} --services sps-app-${env} \
  --query 'services[0].events[:5]' --output table
```

If the circuit-breaker has already rolled back, you'll see `service ... rolled back to deployment ...` events. Investigate the failed image at leisure; production is back on the previous version.

If the new tasks are running but returning 5xx (e.g. a config bug that doesn't surface in the health-check path), the rollback is **operator-driven**:

```sh
# 1. Identify the previous known-good image tag.
aws ecr describe-images --repository-name scholars-app-${env} \
  --query 'reverse(sort_by(imageDetails,&imagePushedAt))[:5].{tags:imageTags,pushed:imagePushedAt}' \
  --output table

# 2. Repoint :latest to a prior known-good sha.
prior_sha="<git sha of the prior good build>"
aws ecr batch-get-image --repository-name scholars-app-${env} \
  --image-ids imageTag="$prior_sha" \
  --query 'images[].imageManifest' --output text \
  | aws ecr put-image --repository-name scholars-app-${env} \
      --image-tag latest --image-manifest file:///dev/stdin

# 3. Force a new deployment of the same task definition; new tasks pull the
#    now-repointed :latest.
aws ecs update-service --cluster sps-cluster-${env} \
  --service sps-app-${env} --force-new-deployment
```

Do NOT trigger the workflow from a prior commit as your rollback path: that re-runs the migration step, and if the bad commit included a migration, you'll re-run an already-applied migration (no-op, slow) or attempt a downgrade-via-expand pattern that doesn't fit a hot rollback.

### Bad migration, schema is now in a bad state

There is no migration rollback. See `CONTRIBUTING.md` § "No rollback. Fix forward." for the policy. Operationally:

1. **Stop the bleeding.** If the app is still running against the old schema (migration succeeded but the new app code crashes on it), see "Bad image" above to roll the app back. The schema stays as the new shape; that's fine because migrations are additive — the previous app version reads the columns it already knew about and ignores the new ones.
2. **If the migration itself failed mid-way.** Prisma's `_prisma_migrations` table records partial applies. Check its `finished_at` and `applied_steps_count`. Do NOT run `prisma migrate resolve --rolled-back` against live traffic — it'll desync `_prisma_migrations` from the actual schema. Open a fix-forward PR that adds a new expand migration repairing whatever the partial migration broke; ship it through the normal pipeline.
3. **If the migration succeeded but caused a data integrity problem.** Backfill via a `scripts/backfills/` script (see below). Backfills are not migrations; they read and write rows under app-level invariants.

### Kill switch

When data damage is actively in progress (e.g. a runaway ETL writing bad rows, a leaked credential being exploited), drop the app to zero tasks:

```sh
aws ecs update-service --cluster sps-cluster-${env} \
  --service sps-app-${env} --desired-count 0
```

This drains all tasks within ~30 seconds (drain timeout). The app is now offline. Restore by setting `--desired-count` back to the env default (1 staging, 2 prod) once the root cause is contained.

Kill-switching prod is a P0 action. Notify any active operators before doing it; the user-visible symptom is a CloudFront `503 Service Unavailable` for every request.

## Backfill task invocation

Backfills are one-shot data jobs that run AFTER a successful deploy of the expand migration that created the column they populate. They are not migrations and they don't gate deploys. Per `scripts/backfills/README.md`:

```sh
# Build + push an image containing the backfill script (normal deploy
# pipeline does this).

# Run the backfill as a one-shot task using the app task family (NOT the
# migration task family -- backfills need the full app code, not just Prisma).
cluster=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsClusterName`].OutputValue' --output text)
service=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsServiceName`].OutputValue' --output text)
app_family=$(aws cloudformation describe-stacks --stack-name Sps-App-${env} \
  --query 'Stacks[0].Outputs[?OutputKey==`EcsAppTaskFamily`].OutputValue' --output text)
netcfg=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
  --query 'services[0].networkConfiguration' --output json)

backfill_script="2026-05-21-populate-author-orcid.ts"

aws ecs run-task --cluster "$cluster" \
  --task-definition "$app_family" \
  --launch-type FARGATE \
  --network-configuration "$netcfg" \
  --overrides "$(jq -nc \
    --arg script "$backfill_script" \
    '{containerOverrides:[{name:"app",command:["node","-r","tsx/cjs",("scripts/backfills/"+$script),"--dry-run"]}]}')"
```

Run with `--dry-run` first. Inspect logs at `/aws/ecs/sps-app-${env}`. Re-run without `--dry-run` once satisfied. Re-runnability of the script (idempotent `WHERE` predicates, row-limit flag) is the script's responsibility, per the convention in `scripts/backfills/README.md`.

## Pre-deploy checklist (production)

Before clicking `Approve and deploy` on a prod run:

- [ ] `cdk diff --exclusively Sps-App-prod -c env=prod` is clean against the currently-deployed state, OR the diff has been reviewed and approved separately. (Unintended infra drift surfaces as a diff; the deploy workflow does NOT run `cdk diff`.)
- [ ] Same commit SHA has successfully deployed to staging within the last 72 hours. The "staging-mirrors-prod" rule (`docs/STAGING.md` § Smoke-test target) means a stale staging deploy is no warranty for prod.
- [ ] No Prisma migrations in the diff that haven't been previewed against staging. If there are migrations, the [Schema migration checklist](../.github/PULL_REQUEST_TEMPLATE.md) was completed on the originating PR.
- [ ] On-call coverage confirmed for the next 30 minutes. Rolling deploy is ~5 minutes; circuit-breaker rollback is automatic but post-incident root-cause is faster with a human paying attention.
- [ ] You can reach the AWS Console + the CloudWatch log groups (`/aws/ecs/sps-app-prod`, `/aws/ecs/sps-migrate-prod`) without re-auth. A blocked-on-MFA-renewal moment during a bad deploy is avoidable.

If any box is unchecked, fix it before clicking `Approve and deploy`.

## Reference

### AWS resources consumed

Read from `Sps-App-${env}` CloudFormation outputs (see [`docs/PRODUCTION_ADDENDUM.md` § Outputs surfaced for downstream stacks](./PRODUCTION_ADDENDUM.md#outputs-surfaced-for-downstream-stacks)):

| Output | Used by deploy.yml step | What it carries |
|---|---|---|
| `EcrRepoUri` | Build, Push | `docker push` destination |
| `EcsClusterName` | Migrate, Update, Wait | `aws ecs` cluster arg |
| `EcsServiceName` | Update, Wait | `aws ecs update-service` target |
| `EcsMigrationTaskFamily` | Migrate | `aws ecs run-task --task-definition` |
| `PublicAlbDns` | Smoke test | `curl http://{dns}/api/health` |

### OIDC trust shape

See [`docs/PRODUCTION_ADDENDUM.md` § GitHub Actions OIDC role](./PRODUCTION_ADDENDUM.md#github-actions-oidc-role-provisioned-unused-until-b09b12) for the trust policy. Summary: prod admits `repo:wcmc-its/Scholars-Profile-System:ref:refs/heads/master` only; staging admits any ref in the repo. Audience pinned to `sts.amazonaws.com`. The workflow's `Refuse prod from non-master ref` step is defense-in-depth on top of this AWS-side check.

### IAM permissions assumed (sps-deploy-${env})

ECR push on the SPS repo only; `ecs:RunTask` on the migration task family ARN; `ecs:UpdateService` + `DescribeServices` on the SPS service ARN; `ecs:DescribeTasks` + `ListTasks` on `cluster/sps-cluster-${env}/*`; `iam:PassRole` on the two task-side roles (conditioned to `iam:PassedToService=ecs-tasks.amazonaws.com`); `ecr:GetAuthorizationToken` (account-scoped — the one exception to the "no `*` Resource" rule). Asserted by `cdk/test/app-stack.test.ts`.

### Things to check if a deploy is wedged

1. **AssumeRole fails** (step "Configure AWS credentials"). Most often: prod from a non-master branch (the OIDC sub-claim refuses). Check `github.ref` in the failure log. Less often: the OIDC provider was removed or recreated; reconcile by re-deploying AppStack.
2. **Discover AppStack outputs returns nothing** (step "Discover AppStack outputs", `jq -e` exits non-zero). AppStack hasn't been deployed to that env yet. Run the bootstrap two-step.
3. **Build hangs > 10 min.** Check actions runner storage; if the Next.js build OOM'd, it usually exits not hangs. Re-run the workflow.
4. **Migration task hangs at `wait tasks-stopped`.** The task is stuck in `PROVISIONING` or `PENDING`. Likely missing subnet/SG config; check that `aws ecs describe-services --query services[0].networkConfiguration` returns non-empty.
5. **`wait services-stable` times out.** Either new tasks aren't passing health checks (check `/aws/ecs/sps-app-${env}` logs) or the circuit-breaker fired. `describe-services` event log will say which.
6. **Smoke test fails with HTTP 000.** Public ALB DNS not resolving, or curl can't reach :80. Usually: AppStack's public-ALB SG ingress is missing `0.0.0.0/0:80`; verify with `aws ec2 describe-security-groups --filters Name=group-name,Values=*public*`.
7. **Smoke test fails with HTTP 503.** New tasks haven't registered with the target group yet; the workflow may have raced ahead. Re-run; not a real defect.
8. **`verify-grants` task exits 1** (step "Run verify-grants task"; service NOT rolled). A managed DB role's live grants no longer equal its golden list (ADR-009). Read `/aws/ecs/sps-verify-grants-${env}` — the failure names the role and the EXCESS / MISSING grant tokens. EXCESS (e.g. `scholars.* ALL PRIVILEGES`) = a role was widened out-of-band; `REVOKE` the extra and re-run. MISSING = a grant was dropped, or a deliberate change to the role model wasn't reflected in the golden list (`scripts/verify-db-grants.ts` `ROLES`) — reconcile, then re-run. This gate is **not** retryable by re-running alone; the underlying grant drift must be fixed first.
