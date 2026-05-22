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

## 0. Preconditions (verify before starting)

| Check | Command | Expected |
|---|---|---|
| Stacks deployed | `aws cloudformation list-stacks --query "StackSummaries[?contains(StackName,'Sps-') && contains(StackName,'$ENV') && StackStatus=='CREATE_COMPLETE' || StackStatus=='UPDATE_COMPLETE'].StackName"` | Network, Secrets, Data, App, **Etl**, Observability |
| App is serving | `aws ecs describe-services --cluster sps-cluster-$ENV --services sps-app-$ENV --query "services[0].{desired:desiredCount,running:runningCount}"` | desired ≥ 1, running ≥ 1 |
| Source + db secrets populated | `for s in db/etl etl/ed etl/asms etl/infoed etl/coi etl/reciter etl/dynamodb etl/spotlight etl/hierarchy; do aws secretsmanager describe-secret --secret-id scholars/$ENV/$s --query "{n:Name,v:VersionIdsToStages}"; done` | each has an `AWSCURRENT` version |
| Aurora schema migrated | (one-shot `sps-migrate-$ENV` task already run) | tables exist |

As of 2026-05-22 staging: all of the above hold **except** `opensearch/etl`
(empty) and the OpenSearch FGAC internal users — which §1 provisions.

---

## 1. OpenSearch FGAC provisioning (the gap)

The domain runs **fine-grained access control + the internal user database**
(`cdk/lib/data-stack.ts`). Clients (app + ETL) authenticate with HTTP **basic
auth**, not SigV4 (`lib/search.ts` reads `OPENSEARCH_USER`/`OPENSEARCH_PASS`).
The **master** is the IAM role `sps-opensearch-master-$ENV` (trusts the account
root), and the `_security` admin API is reachable only with that role,
SigV4-signed, **from inside the VPC** (the domain endpoint is `vpc-...`, private).

Run §1 from an in-VPC host (bastion / SSM session / VPN) that has
[`awscurl`](https://github.com/okigan/awscurl) (`pip install awscurl`).

```bash
export OS_ENDPOINT=$(aws cloudformation describe-stacks --stack-name Sps-Data-$ENV \
  --query "Stacks[0].Outputs[?OutputKey=='OpenSearchDomainEndpoint'].OutputValue" --output text)

# Assume the FGAC master role into this shell.
eval $(aws sts assume-role \
  --role-arn arn:aws:iam::$ACCOUNT:role/sps-opensearch-master-$ENV \
  --role-session-name fgac-bootstrap \
  --query "Credentials.{AWS_ACCESS_KEY_ID:AccessKeyId,AWS_SECRET_ACCESS_KEY:SecretAccessKey,AWS_SESSION_TOKEN:SessionToken}" \
  --output text | awk '{print "export AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3}')

osput() { awscurl --service es --region $REGION -X PUT "https://$OS_ENDPOINT/$1" -d "$2"; }
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

```bash
for cad in nightly weekly; do
  aws stepfunctions start-execution \
    --state-machine-arn arn:aws:states:$REGION:$ACCOUNT:stateMachine:scholars-$cad-$ENV \
    --input '{}'
done
```

Monitor:
```bash
aws stepfunctions list-executions --state-machine-arn arn:aws:states:$REGION:$ACCOUNT:stateMachine:scholars-nightly-$ENV --max-results 1
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

The state-machine "search-index" step runs `etl:mesh-coverage` (a DB-side
coverage pass), **not** the OpenSearch index build. Build the `scholars-*`
indices with a one-off ECS task that reuses the ETL task definition (so it runs
in-VPC with `OPENSEARCH_NODE` + the `opensearch/etl` basic-auth creds injected):

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

> Known follow-up: the nightly/weekly cadences do **not** rebuild the OpenSearch
> index (they run `etl:mesh-coverage`). Ongoing index refresh is currently
> manual via this step — track separately if automated re-index is wanted.

---

## 4. Re-verify

App service is already at desired=1. Confirm real data renders:

```bash
export ALB=$(aws cloudformation describe-stacks --stack-name Sps-App-$ENV \
  --query "Stacks[0].Outputs[?OutputKey=='PublicAlbDns'].OutputValue" --output text)

curl -si "http://$ALB/" | head -1                       # 200
curl -si "http://$ALB/api/search?q=cardiology" | head -1 # 200 + results once §3 done
```

- A scholar profile page and a department page return **200 with content**.
- Search returns hits (after §3).

> Edge (CloudFront + `X-Origin-Verify`) is **not** deployed in staging yet
> (`Sps-Edge-$ENV` absent), so the public ALB answers directly. Once #432 lands
> the named TLS URL + origin-verify, verification moves to that URL with the
> `X-Origin-Verify` header from `scholars/$ENV/edge/origin-shared-secret`.

---

## 5. Done criteria (#443)

- [ ] `opensearch/etl` populated; `sps_etl`/`sps_app` roles + users + mappings exist; `_cluster/health` reachable with basic auth
- [ ] nightly + weekly executions `SUCCEEDED`; Aurora has people/orgs/pubs/topics/grants
- [ ] `search:index` task built `scholars-people` / `scholars-publications` / `scholars-funding`
- [ ] scholar + department pages and search return 200 **with data**

---

## 6. Prod differences

- `ENV=prod`; stacks `Sps-*-prod`; cluster `sps-cluster-prod`; master role `sps-opensearch-master-prod`.
- Prod ETL schedules ship **disabled** (`etlSchedulesEnabled=false`) — there is no auto-fire; every run in §2 is manual until the schedules are deliberately enabled.
- Prod secrets are partially pre-staged; **`scholars/prod/etl/ed` is still unset** — populate it before running the nightly chain (ED is the chain head and aborts the cascade on failure).
- Run §1 against the prod domain endpoint and master role; store `scholars/prod/opensearch/etl` (and confirm `opensearch/app`).
