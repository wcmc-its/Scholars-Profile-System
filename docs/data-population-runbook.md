# Data population + search index runbook (Staging Session B / Prod cutover)

Brings an environment from "app serves (empty)" to "app serves real data + search."
Written for **staging** (#443); the **prod** mirror (#445) differs only in the
values called out in [§6](#6-prod-differences).

All values below are for the single SPS account `665083158573`, region
`us-east-1`. Set once:

```bash
export ENV=staging
export ACCOUNT=665083158573
export REGION=us-east-1
```

> **zsh note:** these commands brace every variable (`${ACCOUNT}` not `$ACCOUNT`).
> In zsh an unbraced `$ACCOUNT:role` / `$ACCOUNT:stateMachine` parses `:r` / `:s`
> as a history modifier and mangles the ARN. Keep the braces when editing.

## 0. Preconditions (verify before starting)

| Check | Command | Expected |
|---|---|---|
| Stacks deployed | `aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Sps-') && contains(StackName,'$ENV') && StackStatus=='CREATE_COMPLETE' || StackStatus=='UPDATE_COMPLETE'].StackName"` | Network, Secrets, Data, App, **Etl**, Observability |
| App is serving | `aws ecs describe-services --cluster sps-cluster-$ENV --services sps-app-$ENV --query "services[0].{desired:desiredCount,running:runningCount}"` | desired ≥ 1, running ≥ 1 |
| Source + db secrets populated | `for s in db/etl etl/ed etl/asms etl/infoed etl/coi etl/reciter etl/dynamodb etl/spotlight etl/hierarchy; do aws secretsmanager describe-secret --secret-id scholars/$ENV/$s --query "{n:Name,v:VersionIdsToStages}"; done` | each has an `AWSCURRENT` version |
| Aurora schema migrated | (one-shot `sps-migrate-$ENV` task already run) | tables exist |
| ETL image present (#454) | `aws ecr describe-images --repository-name scholars-etl-$ENV --image-ids imageTag=latest --query "imageDetails[0].imageTags"` | `["latest", ...]` |

The ETL runs the dedicated `scholars-etl-$ENV` image, **not** the standalone app
image — the `tsx`-based `etl/*` + `search:index` scripts need the full dep tree
and source the app image doesn't ship (#454).

As of 2026-05-22 staging: all of the above hold, **including** `opensearch/etl`
and the OpenSearch FGAC roles/users/mappings — §1 has already been run on
staging (see the note in §1).

---

## 1. OpenSearch FGAC provisioning (the gap)

The domain runs **fine-grained access control + the internal user database**
(`cdk/lib/data-stack.ts`). Every client authenticates with HTTP **basic auth**
(`lib/search.ts` reads `OPENSEARCH_USER`/`OPENSEARCH_PASS`) — there is **no IAM
master and no SigV4**. The **master is the internal user `sps_master`**, whose
password is the `scholars/$ENV/opensearch/master` secret (CDK consumes it as the
raw secret string; seeded out-of-band before the domain deploy). The `_security`
admin API is reachable only with the master credential, **from inside the VPC**
(the domain endpoint is `vpc-...`, private).

> **Staging is already provisioned (2026-05-22).** The `sps_etl`/`sps_app` roles,
> their internal users, the role mappings, and the
> `scholars/staging/opensearch/{etl,app}` secrets all exist (domain
> `opensearch58799-j7tli0rlgtyz`, cluster green). The steps below are the
> reference procedure — re-run them for **prod** (#445) or after a domain
> recreate. The #443 comment dated 2026-05-22 documents the surgical
> recreate that produced the current staging domain.

Run §1 from an in-VPC host (a short-lived SSM-session bastion / VPN). No
`awscurl` needed — plain `curl` with the master basic-auth credential.

```bash
export OS_ENDPOINT=$(aws cloudformation describe-stacks --stack-name Sps-Data-${ENV} \
  --query "Stacks[0].Outputs[?OutputKey=='OpenSearchDomainEndpoint'].OutputValue" --output text)

# Master password (raw secret string). Read on the bastion; never echo it.
MASTER_PW=$(aws secretsmanager get-secret-value --secret-id scholars/${ENV}/opensearch/master \
  --query SecretString --output text)

osput() { curl -s -u "sps_master:${MASTER_PW}" -H 'Content-Type: application/json' \
  -X PUT "https://${OS_ENDPOINT}/$1" -d "$2"; }
```

### 1a. Roles (least privilege on `scholars-*`)

```bash
# ETL / indexer: read + write + create/swap indices and aliases.
osput "_plugins/_security/api/roles/sps_etl" '{
  "cluster_permissions": ["cluster_composite_ops", "cluster_monitor"],
  "index_permissions": [
    { "index_patterns": ["scholars-*"], "allowed_actions": ["indices_all"] }
  ]
}'

# App: read + suggest only.
osput "_plugins/_security/api/roles/sps_app" '{
  "cluster_permissions": ["cluster_composite_ops_ro"],
  "index_permissions": [
    { "index_patterns": ["scholars-*"], "allowed_actions": ["read", "indices:data/read/*"] }
  ]
}'
```

### 1b. Internal users

The **app** user secret (`scholars/$ENV/opensearch/app`) is already populated.
Confirm the matching internal user exists; if not, create it with the username
+ password **stored in that secret** (read the secret on the bastion — never
print it into a shared log):

```bash
# Only if the app internal user is missing. Read creds from the secret first.
# osput "_plugins/_security/api/internalusers/<app-username-from-secret>" '{"password":"<from-secret>"}'
```

The **etl** user does not exist yet. Generate a strong password, create the
user, and store the credential — do not echo `$PW`:

```bash
ETL_USER=sps-etl
PW=$(openssl rand -base64 30 | tr -d '/+=' | head -c 32)   # alnum, 32 chars
osput "_plugins/_security/api/internalusers/$ETL_USER" "{\"password\":\"$PW\"}"
```

### 1c. Role mappings

```bash
osput "_plugins/_security/api/rolesmapping/sps_etl" "{\"users\":[\"$ETL_USER\"]}"
# App mapping (use the app username from its secret):
# osput "_plugins/_security/api/rolesmapping/sps_app" '{"users":["<app-username>"]}'
```

### 1d. Store the ETL credential

```bash
aws secretsmanager put-secret-value --secret-id scholars/$ENV/opensearch/etl \
  --secret-string "$(jq -nc --arg u "$ETL_USER" --arg p "$PW" '{username:$u,password:$p}')"
unset PW
```

> The ETL task definition injects `OPENSEARCH_USER`/`OPENSEARCH_PASS` from this
> secret (keys `username`/`password`). The secret must hold exactly those two
> keys.

**Verify** (basic auth, still in-VPC):
```bash
curl -s -u "$ETL_USER:<pw>" "https://$OS_ENDPOINT/_cluster/health?pretty"   # expect "status":"green"|"yellow"
```

---

## 2. Run the ETL pipelines

Trigger the state machines (they run the `etl:<source>` scripts as Fargate
tasks in-VPC). Order: **nightly** (ED chain head + Reciter/ASMS/InfoEd/COI),
then **weekly** (DynamoDB topics + Completeness + Spotlight), then **annual**
(Hierarchy, behind a manual approval gate).

Each machine starts with a top-level Choice on `$.startFrom` (so operators can
skip ahead). Pass the **head step** explicitly — `--input '{}'` is **not**
reliable here (an absent `$.startFrom` does not cleanly fall through the
Choice). Run nightly to `SUCCEEDED` first, then weekly:

```bash
# nightly: ED -> Reciter -> ASMS -> InfoEd -> COI -> mesh-coverage -> search:index
aws stepfunctions start-execution \
  --state-machine-arn "arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:scholars-nightly-${ENV}" \
  --input '{"startFrom":"Ed"}'

# after nightly SUCCEEDED -- weekly: DynamoDB -> Completeness -> Spotlight -> search:index
aws stepfunctions start-execution \
  --state-machine-arn "arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:scholars-weekly-${ENV}" \
  --input '{"startFrom":"Dynamodb"}'
```

Monitor:
```bash
aws stepfunctions list-executions --state-machine-arn "arn:aws:states:${REGION}:${ACCOUNT}:stateMachine:scholars-nightly-${ENV}" --max-results 1
# task logs: /aws/ecs/sps-etl-$ENV    state machine logs: /aws/states/nightly-$ENV
```

**Annual** (optional for first population) emits an approval SNS message and
waits; approve with `aws stepfunctions send-task-success --task-token <token>`
(token is in the SNS message / `etl-failures-$ENV` topic).

> Failures publish to the `etl-failures-$ENV` SNS topic and trip the per-cadence
> CloudWatch alarms. Staging schedules are **enabled** (nightly auto-fires 07:00
> UTC), so a manual run before the first auto-fire is the cleanest validation.

---

## 3. Build the OpenSearch index

The nightly and weekly cadences now close with a real `search:index` step
(#451), so steady-state index refresh is automatic. This manual one-off is for
the **initial bootstrap** (before the first cadence run) or an ad-hoc rebuild.
It reuses the ETL task definition, so it runs in-VPC with `OPENSEARCH_NODE` +
the `opensearch/etl` basic-auth creds injected:

```bash
aws ecs run-task --cluster sps-cluster-$ENV \
  --task-definition sps-etl-$ENV \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","search:index"]}]}'
```

(Subnets = the two `private` subnets; SG = `EtlSecurityGroup`. Re-derive for a
fresh env: `aws cloudformation describe-stack-resources --stack-name Sps-Network-$ENV` for the SG, and `aws ec2 describe-subnets` filtered to the `private` subnet-name tag.)

Watch the task's `/aws/ecs/sps-etl-$ENV` log stream to completion (the indexer
logs people/publication/funding counts and the alias swap).

> Steady-state re-index is automatic: both cadences run `search:index` as their
> closing step (#451). Open follow-on: the cadences do not yet POST
> `/api/revalidate` to bust the ISR cache after a run — ISR refreshes on its TTL
> meanwhile (tracked in #479, alongside #353).

---

## 4. Re-verify

App service is already at desired=1. Confirm real data renders:

#432's origin-verify gate has landed: the public ALB **403s** without the
`X-Origin-Verify` header (the 64-char `scholars/$ENV/edge/origin-shared-secret`).
CloudFront injects this header in front of the ALB; a direct ALB call must
supply it. Send it on every verification request:

```bash
export ALB=$(aws cloudformation describe-stacks --stack-name Sps-App-${ENV} \
  --query "Stacks[0].Outputs[?OutputKey=='PublicAlbDns'].OutputValue" --output text)
export OV=$(aws secretsmanager get-secret-value --secret-id scholars/${ENV}/edge/origin-shared-secret \
  --query SecretString --output text)

curl -si -H "X-Origin-Verify: ${OV}" "http://${ALB}/" | head -1                        # 200 (403 without the header)
curl -si -H "X-Origin-Verify: ${OV}" "http://${ALB}/api/search?q=cardiology" | head -1  # 200 + results once §3 done
```

- A scholar profile page and a department page return **200 with content**.
- Search returns hits (after §3).

> The header gate is the only access path to the ALB now; omit it and you get a
> 403 (not a routing/data failure). When the named TLS URL + CloudFront front
> ship, verification can move to that URL — CloudFront adds `X-Origin-Verify`
> automatically, so the manual header is only for direct-ALB checks like these.

---

## 5. Done criteria (#443)

- [ ] `opensearch/etl` populated; `sps_etl`/`sps_app` roles + users + mappings exist; `_cluster/health` reachable with basic auth
- [ ] nightly + weekly executions `SUCCEEDED`; Aurora has people/orgs/pubs/topics/grants
- [ ] `search:index` task built `scholars-people` / `scholars-publications` / `scholars-funding`
- [ ] scholar + department pages and search return 200 **with data**

---

## 6. Prod differences

- `ENV=prod`; stacks `Sps-*-prod`; cluster `sps-cluster-prod`; OpenSearch master is the internal user `sps_master` with its password in `scholars/prod/opensearch/master` (no IAM master).
- Prod ETL schedules ship **disabled** (`etlSchedulesEnabled=false`) — there is no auto-fire; every run in §2 is manual until the schedules are deliberately enabled.
- Prod secrets are partially pre-staged; **`scholars/prod/etl/ed` is still unset** — populate it before running the nightly chain (ED is the chain head and aborts the cascade on failure).
- Run §1 against the prod domain endpoint using the `sps_master` basic-auth credential; store `scholars/prod/opensearch/etl` (and confirm `opensearch/app`).
