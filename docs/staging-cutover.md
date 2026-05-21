# Staging cutover runbook -- first AppStack deploy

This is the operator reference for the *first ever* `cdk deploy --exclusively Sps-App-${env}` against a fresh AWS account, plus the recovery recipe for a rolled-back AppStack create that left RETAIN-policy resources behind. Subsequent deploys (config changes, image bumps, etc.) follow [`docs/DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), not this file.

Companions:

- [`docs/DEPLOY-RUNBOOK.md` § Bootstrap two-step](./DEPLOY-RUNBOOK.md#bootstrap-two-step-first-deploy-of-an-env) -- the empty-ECR / `appDesiredCount=0` step that follows the first successful create.
- [`docs/PRODUCTION_ADDENDUM.md` § AppStack](./PRODUCTION_ADDENDUM.md#appstack) -- ADR-008 deviations and rationale.
- [Issue #415](https://github.com/wcmc-its/Scholars-Profile-System/issues/415) -- the orphan-cleanup style this runbook follows: read-only verification first, destructive call second.

The 2026-05-21 staging first-deploy attempt surfaced four sequential blockers; three were operational, one was code (resolved in #431). This runbook captures the operational class so the next first-deploy (prod, or a fresh dev account) doesn't burn the same hour.

## Pre-flight: upstream stacks are at master

AppStack depends on outputs from `Sps-Network-${env}`, `Sps-Data-${env}`, and `Sps-Secrets-${env}`. If any upstream is stale relative to master (e.g. predates a Footgun fix), AppStack's `Fn::ImportValue` calls resolve against an exported shape that no longer matches what the upstream stack would now emit -- and the create fails mid-way with a cross-stack reference error. The 2026-05-21 instance: a stale `Sps-Network-staging` missing the public-subnet exports added in PR #410.

For each upstream stack, run `cdk diff --exclusively` and inspect the output:

```sh
cd cdk

for stack in \
  Sps-Network-${env} \
  Sps-Data-${env} \
  Sps-Secrets-${env}; do
  echo "=== $stack ==="
  npx cdk diff --exclusively "$stack" -c env=${env}
done
```

Three states are possible:

| State | What it means | Action |
|---|---|---|
| `There were no differences` | Stack is at master. | Continue. |
| Diff is purely additive (new outputs, new IAM resources) | Stack predates a recent additive change. | Refresh: `npx cdk deploy --exclusively <stack> -c env=${env}`. Additive changes are safe at any time. |
| Diff modifies an existing resource (Type or Replace) | Stack predates a destructive or replacement change. | STOP. Read the diff carefully. Refresh requires a maintenance window; do not refresh mid-cutover. |

After each refresh, re-run `cdk diff` until the stack reports no differences. Repeat for the next upstream. Only then move to AppStack.

Sanity check that the data plane is actually populated -- the synth doesn't catch a `Sps-Secrets-${env}` whose entries are all placeholders:

```sh
for name in \
  scholars/${env}/db/app-rw \
  scholars/${env}/db/app-ro \
  scholars/${env}/opensearch/app \
  scholars/${env}/revalidate-token \
  scholars/saml-sp/${env}/private-key \
  scholars/${env}/edge/origin-shared-secret; do
  status=$(aws secretsmanager describe-secret --secret-id "$name" \
    --query 'Name' --output text 2>&1)
  echo "$status"
done
```

All six must exist. Placeholder *values* are acceptable for the first deploy (the task definition only resolves them at task-start, and `appDesiredCount=0` keeps tasks from starting). Missing *entries* fail the AppStack create.

## First AppStack deploy

After pre-flight passes:

```sh
cd cdk
npx cdk deploy --exclusively Sps-App-${env} \
  -c env=${env} \
  -c appDesiredCount=0 \
  --output cdk.out.${env} \
  --require-approval never
```

`appDesiredCount=0` is critical: ECR is empty, the service can't pull `:latest`, and a non-zero desired count puts the service in a 15-minute backoff loop on every cdk deploy retry. The `--output` flag isolates the cloud-assembly per env so a concurrent prod sanity-synth doesn't trample staging artifacts.

The expected timeline is ~10-12 minutes end-to-end. The slow resources are the two ALBs (~3 minutes each, parallel), the ECS service (~2 minutes; lands at the end because of the listener-dependency fix from #431), and the OIDC provider Lambda (~1 minute the first time). If the create exceeds 20 minutes without progress events, something is wrong -- check `aws cloudformation describe-stack-events --stack-name Sps-App-${env}` for the latest failure.

On success, AppStack reaches `CREATE_COMPLETE` with `desiredCount=0`. Continue to [`docs/DEPLOY-RUNBOOK.md` § Bootstrap two-step](./DEPLOY-RUNBOOK.md#bootstrap-two-step-first-deploy-of-an-env) to push the bootstrap image and re-deploy with the env-default `appDesiredCount`.

## RETAIN-policy orphan cleanup (rollback recovery)

If the first deploy *fails* and rolls back, four AppStack resources survive the rollback by design -- they carry `RemovalPolicy.RETAIN` so that a re-rolled deploy doesn't lose log history or container images. On the next create attempt CFN tries to create them again and collides:

| Resource | Logical id | AWS-side name | Type |
|---|---|---|---|
| ECR repository | `EcrRepository` | `scholars-app-${env}` | `AWS::ECR::Repository` |
| App log group | `AppLogGroup` | `/aws/ecs/sps-app-${env}` | `AWS::Logs::LogGroup` |
| Migration log group | `MigrationLogGroup` | `/aws/ecs/sps-migrate-${env}` | `AWS::Logs::LogGroup` |
| Otel-collector log group | `OtelCollectorLogGroup` | `/aws/ecs/sps-otel-${env}` | `AWS::Logs::LogGroup` |

The error in the CFN events looks like one of:

- `Repository scholars-app-${env} already exists.`
- `Log group /aws/ecs/sps-app-${env} already exists.`

Recovery is manual delete. Always verify each resource is empty *before* deleting -- the RETAIN policy exists specifically so that a real prior deploy's data isn't lost. Skip the "verify empty" step at your peril.

### Step 1: verify each retained resource is empty (read-only)

```sh
# ECR -- count tagged + untagged images. Expect zero.
aws ecr describe-images --repository-name scholars-app-${env} \
  --query 'length(imageDetails)' --output text

# Log groups -- count log streams (each running task creates one). Expect zero.
for name in \
  /aws/ecs/sps-app-${env} \
  /aws/ecs/sps-migrate-${env} \
  /aws/ecs/sps-otel-${env}; do
  count=$(aws logs describe-log-streams --log-group-name "$name" \
    --query 'length(logStreams)' --output text)
  echo "$name: $count streams"
done
```

If every count is `0`, the resources are safe to delete -- this is a first-deploy rollback artifact, not real prior data.

If any count is `> 0`, STOP. The resource is from a real prior deploy. Decide whether to preserve before deleting:

- ECR with images: copy each image with `aws ecr batch-get-image | aws ecr put-image` to a backup repo, OR accept the loss and continue.
- Log group with streams: export to S3 with `aws logs create-export-task` before deleting, OR accept the loss.

Once you're sure nothing of value will be lost, continue.

### Step 2: delete the orphans (destructive)

```sh
# ECR repo. `--force` is required because RETAIN means CFN can't auto-empty it.
aws ecr delete-repository \
  --repository-name scholars-app-${env} \
  --force

# Log groups.
for name in \
  /aws/ecs/sps-app-${env} \
  /aws/ecs/sps-migrate-${env} \
  /aws/ecs/sps-otel-${env}; do
  aws logs delete-log-group --log-group-name "$name"
done
```

Each command returns silently on success. AWS returns `ResourceNotFoundException` if the resource was already gone (e.g. a partial prior cleanup) -- safe to ignore.

### Step 3: verify everything is gone (read-only)

```sh
aws ecr describe-repositories \
  --repository-names scholars-app-${env} 2>&1 | grep -q 'RepositoryNotFoundException' \
  && echo "ECR: gone" || echo "ECR: STILL PRESENT"

for name in \
  /aws/ecs/sps-app-${env} \
  /aws/ecs/sps-migrate-${env} \
  /aws/ecs/sps-otel-${env}; do
  count=$(aws logs describe-log-groups --log-group-name-prefix "$name" \
    --query "logGroups[?logGroupName=='$name'] | length(@)" --output text)
  if [ "$count" = "0" ]; then echo "$name: gone"; else echo "$name: STILL PRESENT"; fi
done
```

Every line should report "gone". Now re-run the first-AppStack-deploy command above.

## Confirming the cleanup state at the end of a session

If the cutover session ends with the deploy *intentionally rolled back* (e.g. a verification pass that's expected to leave no state behind, as in #431), the four RETAIN resources have to be removed manually -- otherwise the next deploy hits the same collision. Use the [Step 1 -> Step 2 -> Step 3] sequence above, then confirm the stack itself is gone:

```sh
aws cloudformation describe-stacks --stack-name Sps-App-${env} 2>&1 \
  | grep -E '(does not exist|Stack with id)' \
  && echo "Stack: gone" || echo "Stack: STILL PRESENT"
```

`does not exist` is the success signal. If the stack is still present in `DELETE_FAILED` state, look at `aws cloudformation describe-stack-events --stack-name Sps-App-${env}` for the resource that blocked the delete -- almost always a RETAIN resource that wasn't cleaned up first.

## Known sharp edges

- **Single-account staging+prod.** Account 665083158573 hosts both envs. Every AppStack resource carries the env literal in its name (Footgun #4). The cleanup recipe is parametric on `${env}` for exactly this reason -- never run the staging cleanup with `env=prod` substituted, even by accident.
- **OIDC provider is account-scoped.** AppStack creates one `token.actions.githubusercontent.com` provider on first deploy; the second AppStack-env deploy must reuse it via `-c githubOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/...`. AppStack auto-detects the absence of the context flag and creates a new provider, which fails on the second env with `EntityAlreadyExists`. The context-flag mechanism is the deviation; the cdk synth doesn't enforce it.
- **VPC endpoint service names are deploy-only-validated.** CDK accepts any string; AWS rejects unknown service names only at create time. Issue #429 / PR #430 closed the OpenSearch instance of this (the `es` service doesn't exist in us-east-1; `aos` does). The synth-time guard in `cdk/test/app-stack.test.ts` blocks the regex `\.es$`. If a future endpoint addition uses a service name unfamiliar to the team, verify with `aws ec2 describe-vpc-endpoint-services --service-names com.amazonaws.us-east-1.<svc>` *before* synth.
