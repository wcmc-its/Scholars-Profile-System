# Data population + search index runbook (Staging Session B / Prod cutover)

Brings an environment from "app serves (empty)" to "app serves real data + search."
Written for **staging** (#443); the **prod** mirror (#445) differs only in the
values called out in [§6](#6-prod-differences).

> **⚠️ Interim path in effect (#483).** §2 below runs the ETL *in-VPC*, which
> requires the SPS VPC to reach the WCM sources (ED/LDAP, InfoEd, ASMS, COI,
> ReciterDB). That connectivity is **not in place** — the cross-account TGW route
> + WCM firewall rule for the SPS CIDR are pending an external team. Until they
> land, populate Aurora via the **interim path in [§7](#7-interim-population-firewall-pending-483)**:
> run the source ETLs from a host that already reaches WCM (a developer laptop on
> VPN — the documented local-dev pattern), then load the result into Aurora over a
> short-lived SSM tunnel. The in-VPC `search:index` ([§3](#3-build-the-opensearch-index))
> and verification ([§4](#4-re-verify)) steps are unchanged. §1–§6 are the
> steady-state procedure for once the firewall is in place.

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

---

## 7. Interim population (firewall pending) — #483

Use this section **instead of [§2](#2-run-the-etl-pipelines)** until the SPS VPC
can reach the WCM sources. Everything else (§1 OpenSearch FGAC, §3 `search:index`,
§4 verification) is unchanged — only *where the source ETLs run* changes.

### 7.0 Why this is needed

The eight foundational ETLs — **ED** (LDAPS), **ASMS** / **InfoEd** / **Jenzabar**
(MSSQL), **ReciterDB-reciter** / **COI** (MySQL), **ED-student-programs**, and
**RePORTER** (reads ReciterDB) — pull from WCM-internal hosts. They produce the
rows everything else hangs off: `Scholar`, `Department`, `Division`,
`Appointment`, `Education`, `Grant`, `Publication`, `PublicationAuthor`,
`PublicationScore`. From the SPS VPC these **time out** (DNS resolves — the three
resolver rules are associated — but there is no TGW return route and no WCM
firewall allowance for `10.20.0.0/16`).

The remaining ETLs (**DynamoDB** topics, **Hierarchy**/**Spotlight** from S3,
**NSF**/**NIH-Profile**/**Gates** public APIs, **Mesh-Descriptors** from NLM, and
the **Mesh-Coverage**/**Completeness**/**Search-Index** local-only steps) are
already reachable from any host with internet + AWS creds — but they *enrich* the
foundation and need it present first.

**The fix: run the whole pipeline where WCM access already exists, then ship the
result into Aurora.** The documented local-dev pattern already does exactly this —
`.env.example` (lines 61–115) notes the ETL reads the *production* WCM sources
read-only over VPN. So a developer laptop on VPN can produce a complete dataset;
we load it into Aurora over a short-lived SSM tunnel and build the index in-VPC.
The transport step disappears once the firewall lands and §2 runs in-VPC again.

> **Verify reachability first** (on the WCM-connected host):
> ```bash
> npm run etl:reciter:probe   # connects + SELECTs; prints sample rows, no secrets
> ```
> Sample `identity.cwid` / `personIdentifier` rows = WCM is reachable. A hang or
> `ETIMEDOUT`/`ENOTFOUND` = VPN is down; fix that before continuing.

### 7.1 Produce the dataset on the WCM-connected host

Point a **local** MySQL/MariaDB at the Prisma-migrated schema and run the source
ETLs into it. (Confirm `DATABASE_URL` in `.env.local` resolves to the local DB —
`npm run db:check` — **not** an Aurora endpoint.)

```bash
# Schema must match the Aurora target. If the local DB is fresh:
npx prisma migrate deploy

# Run the source ETLs. etl:daily runs the full chain (ED head -> sources ->
# search -> completeness -> revalidate). The trailing search:index + revalidate
# steps target LOCAL OpenSearch / a local app and are irrelevant here -- the real
# index is built in-VPC in §3 -- so either let them no-op/fail harmlessly, or run
# the sources individually and skip them:
npm run etl:ed                     # chain head -- must succeed first
npm run etl:reciter
npm run etl:asms
npm run etl:infoed
npm run etl:jenzabar
npm run etl:ed:student-programs
npm run etl:reporter
npm run etl:coi
npm run etl:nsf
npm run etl:nih-profile
npm run etl:gates
npm run etl:dynamodb
npm run etl:hierarchy
npm run etl:spotlight
npm run etl:identity
npm run etl:mesh                   # MeshDescriptor -- needed before mesh-coverage
npm run etl:mesh-coverage
# (skip search:index here -- built in-VPC in §3)
```

Spot-check the result before dumping (Prisma maps models to snake_case tables;
`grant` is a reserved word, hence the backticks):
```bash
mysql -h127.0.0.1 -uscholars -p scholars -e \
  'SELECT (SELECT COUNT(*) FROM scholar) scholars,
          (SELECT COUNT(*) FROM publication) pubs,
          (SELECT COUNT(*) FROM `grant`) grants,
          (SELECT COUNT(*) FROM appointment) appts,
          (SELECT COUNT(*) FROM education) edu;'
```

> **Skipping the re-run:** if a recent local ETL run already populated this DB,
> dump it as-is rather than re-running — note the snapshot age from
> `SELECT source, MAX(started_at) FROM etl_run GROUP BY source`. The interim goal
> is "populated now," not "freshest possible."
>
> **Schema parity:** the dump is data-only and assumes the Aurora target carries
> the repo's migrations (`prisma migrate deploy`, run by the `sps-migrate-$ENV`
> task). The local dev DB can *lag* the repo (`_prisma_migrations` drift is
> common here) — that's fine, since `--complete-insert` lets Aurora's extra
> columns default. The reverse (a column the local DB has but Aurora lacks) makes
> the load fail loudly with `Unknown column`; if that happens, bring Aurora to
> repo HEAD first. Confirm parity quickly over the tunnel:
> `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;`
> against Aurora should be ≥ the repo's newest `prisma/migrations/` dir.

### 7.2 Dump (data-only, FK-safe, idempotent)

`scripts/interim-populate/dump-local.sh` writes a gzip data-only dump with a
`FOREIGN_KEY_CHECKS=0` + per-table `TRUNCATE` preamble (so a reload fully replaces
target data) and **excludes `_prisma_migrations`** (Aurora's migration history is
authoritative — never clobber it). It dumps *data only*; the Aurora schema is
already Prisma-migrated, which also sidesteps MariaDB→MySQL DDL differences.

```bash
scripts/interim-populate/dump-local.sh \
  'mysql://scholars:scholars@127.0.0.1:3306/scholars' \
  /tmp/sps-data.sql.gz
```

### 7.3 Load into Aurora over a short-lived SSM tunnel

Aurora is private to the SPS VPC and there is **no in-VPC bastion** (every
SSM-managed host in the account is in the ReCiter VPC `vpc-08a1873fc8eebae28`,
which cannot reach SPS Aurora). Launch a throwaway micro instance in an SPS
**private** subnet with the **EtlSecurityGroup** (Aurora already trusts it) and an
instance profile carrying `AmazonSSMManagedInstanceCore`, then port-forward to the
Aurora writer. Tear it down when done.

```bash
export ENV=staging   # then repeat for prod -- see §7.4

# SPS VPC private subnets (us-east-1a / 1b) and the EtlSecurityGroup:
SUBNET=subnet-019afebef588ee4b3        # Sps-Network-$ENV/Vpc/privateSubnet1
ETL_SG=$(aws cloudformation describe-stack-resources --stack-name Sps-Network-${ENV} \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup' && contains(LogicalResourceId,'Etl')].PhysicalResourceId" \
  --output text)   # staging today: sg-09b494047547ea148

# Launch the bastion (AL2023; SSM agent is preinstalled). The instance profile
# must allow SSM -- reuse an existing AmazonSSMManagedInstanceCore profile or
# create one first. Confirm a NAT/S3+SSM-endpoint egress path exists in the
# private subnet (standard for this VPC).
BASTION=$(aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.micro --subnet-id "$SUBNET" --security-group-ids "$ETL_SG" \
  --iam-instance-profile Name=<ssm-instance-profile> \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=sps-interim-load-'"$ENV"'}]' \
  --query 'Instances[0].InstanceId' --output text)

# Wait until SSM registers it (PingStatus Online), then forward Aurora:3306 -> :13306
AURORA=$(aws rds describe-db-clusters \
  --query "DBClusters[?starts_with(DBClusterIdentifier,'sps-data-${ENV}')].Endpoint" --output text)
aws ssm start-session --target "$BASTION" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host="$AURORA",portNumber=3306,localPortNumber=13306 &
```

With the tunnel up, load from the WCM-connected host (it has the dump + AWS creds).
`load-aurora.sh` reads the `scholars/$ENV/db/master` secret (full DDL/TRUNCATE
rights), refuses to touch prod without `CONFIRM_PROD=yes`, and streams the dump in:

```bash
scripts/interim-populate/load-aurora.sh "$ENV" 127.0.0.1 13306 /tmp/sps-data.sql.gz
```

Then stop the session (Ctrl-C) and **terminate the bastion**:
```bash
aws ec2 terminate-instances --instance-ids "$BASTION"
```

### 7.4 Build the index, then re-verify

- **Staging:** run [§3](#3-build-the-opensearch-index) as-is — the `sps-etl-staging`
  Fargate task reads the now-populated Aurora and builds the OpenSearch indices.
  Then [§4](#4-re-verify).
- **Prod:** the **`Sps-Etl-prod` stack is not deployed** (only `Sps-Etl-staging`
  exists), so there is no `sps-etl-prod` task family to run `search:index`. Before
  the prod index build, **deploy `Sps-Etl-prod`** (it ships the task family + state
  machines; `appDesiredCount` is irrelevant to it). Then run §3 with `ENV=prod`.
  Prod ETL schedules ship disabled, which is fine — the index build is a manual
  `run-task`, not a scheduled run.

Repeat 7.1–7.4 per environment. **Do prod only after staging verifies**, and gate
the prod `load-aurora.sh` behind `CONFIRM_PROD=yes` — it **TRUNCATEs then reloads**
every data table in the target.

> **Caveat — AUTO_INCREMENT:** data-only inserts carry explicit PK values, so
> Aurora's per-table AUTO_INCREMENT counters are not advanced by the load. MySQL 8
> recovers the counter to `MAX(id)+1` on the next insert/restart, and the durable
> in-VPC ETL (post-firewall) upserts by natural key — so this self-heals. No
> manual `ALTER TABLE ... AUTO_INCREMENT` is needed for read-serving.

### 7.5 Done criteria (#483)

- [ ] Reachability probe passes on the WCM-connected host (§7.0)
- [ ] Local ETL run populates `Scholar` / `Publication` / `Grant` / `Appointment` / `Education` / topics (§7.1)
- [ ] **Staging** Aurora loaded; `search:index` built `scholars-people`/`-publications`/`-funding`; scholar + dept pages + search return 200 with data (unblocks #443)
- [ ] **Prod** Aurora loaded (after `Sps-Etl-prod` deploy + index build); `/edit/scholar/{cwid}` and `/scholars/{slug}` resolve for a real scholar (unblocks #474)
- [ ] Bastion instances terminated in both envs
- [ ] Escalate the durable fix in parallel — TGW route + WCM firewall rule for the SPS CIDR ([[project_sps_vpc_wcm_connectivity]])
