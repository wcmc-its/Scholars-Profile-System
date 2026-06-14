# SPS Operations Runbook

> **This is a consolidated index.** It pulls the operationally-essential facts into one place and links out to the
> authoritative deep docs for detail. Where this doc and a linked doc disagree, **the linked doc wins** — and the
> CDK code (`cdk/lib/*`) wins over any doc.

## Start here: triage decision tree

> **Golden rule first:** almost all displayed data is a *derived snapshot* from a scheduled ETL. An upstream outage
> makes data **stale**, not the site **down**. If the page *renders* (even with old/missing data), it's a freshness
> problem (ETL/cache), **not** an availability incident — don't roll back or scale for it.

Find your symptom, do the first step, then jump to the cited section.

```
What's the problem?
│
├─ SITE IS DOWN  — 5xx, "Something went wrong", blank pages, no healthy hosts
│    ├─ Started right after a deploy?  ── YES → roll back app to prev task-def ......... §2 "Roll back"
│    └─ Else → check Aurora / CloudFront, decide rollback vs fix-forward .............. §4 #6
│         (need to take it offline now? kill switch = scale to 0; prod = P0) .......... §2 "Kill switch"
│
├─ SITE IS UP but DATA IS STALE / WRONG  (page renders, content old or missing)
│    ├─ A whole profile section is old/missing → that ETL source stalled ............. §4 #2, #3
│    ├─ Stale only after an edit / reindex / ETL run → bust the edge cache ............ §4 #1
│    │     (surgical = POST /api/revalidate, NOT cloudfront create-invalidation)
│    ├─ Retracted paper still showing ............................................... §4 #5
│    └─ Home "Selected research" empty / wrong authors / bad links .................. §4 #10
│
├─ SEARCH IS WRONG  — no results, too few, or stale after a data/mapping change
│    ├─ Recall problem (e.g. covid19→9 but covid-19→1,425; tylenol→0) .............. §4 #4
│    └─ Stale/missing after a load or analyzer/mapping change → reindex .............. §4 #9
│
├─ AN ALARM FIRED / a Teams card arrived
│    ├─ Card names an ETL alarm (sps-etl-*-status/-cadence/-heartbeat) .............. §4 #3
│    ├─ 5xx / latency / unhealthy-hosts / task-shortfall ........................... §4 #6
│    ├─ Alarm fired but NO Teams card within 5 min (paging path broken) ............. §4 #8
│    └─ Any other alarm → map it via "Quick alarm → entry index" ............ end of §4
│
├─ STAFF CAN'T LOG IN to /edit  (SAML/SSO: idp_status_error, no_cwid, Responder…)
│    └─ SAML IdP / Enterprise Directory issue ...................................... §4 #7
│         ⚠️ Hard cert deadline 2026-08-19 — both certs must be trusted ............. §5 deadlines
│
├─ DB DATA LOSS / CORRUPTION  (data wrong at the source, not an app bug)
│    └─ Aurora PITR or DR-vault restore (RPO ≤ 24 h, RTO ≤ 4 h) ..................... §4 #11
│
├─ /api/revalidate RETURNS 401 / 500  (cache-bust webhook failing)
│    └─ Token unset / wrong / mid-rotation ......................................... §4 #12
│
└─ PLANNED OPERATION  — I need to deploy, scale, roll back, or bust cache on purpose
     ├─ Deploy code vs infra/flag vs CloudFront (know which mechanism!) ............. §2 "deploy split"
     ├─ Scale / start / stop / restart the service ................................. §2 "Scale"
     ├─ Roll back an app deploy ..................................................... §2 "Roll back"
     └─ Revalidate / cache-bust .................................................... §2 "Revalidate"
```

**Routing table (same map, for fast lookup):**

| You're seeing… | Go to |
|---|---|
| Site down — 5xx, blank, no healthy hosts | §4 #6 → roll back (§2) / kill switch (§2) |
| Page renders but a section is stale/missing | §4 #2, §4 #3 (ETL) |
| Stale only after edit/reindex/ETL | §4 #1 (edge cache → `POST /api/revalidate`) |
| Retracted paper showing | §4 #5 |
| "Selected research" / spotlight wrong | §4 #10 |
| Search returns nothing / too few | §4 #4 |
| Search stale after a load/mapping change | §4 #9 (reindex) |
| ETL alarm / Teams card | §4 #3 |
| Alarm fired, no Teams card | §4 #8 |
| Can't log in to `/edit` (SAML) | §4 #7 (⚠️ cert deadline §5) |
| DB data loss / corruption | §4 #11 (PITR / DR) |
| `/api/revalidate` 401/500 | §4 #12 |
| Deploy / scale / roll back / revalidate (planned) | §2 |

## What this is

The **Scholars Profile System (SPS)** is a read-mostly **Next.js 15 (App Router)** app that renders ~9,000 public WCM
scholar profiles. It runs on **AWS ECS Fargate** behind two ALBs, fronted by **CloudFront + WAF**, backed by **Aurora
MySQL** (primary store) and **Amazon OpenSearch** (search/autocomplete only). Every page is a *derived snapshot* — almost
all displayed data is produced by a scheduled **Step Functions ETL** that pulls from WCM source systems; an upstream
outage makes data *stale*, not the site *down*. All infrastructure is **AWS CDK (TypeScript)** under `cdk/`.

| At a glance | Value |
|---|---|
| Prod URL | `https://scholars.weill.cornell.edu` (staging: `scholars-staging.weill.cornell.edu`) |
| AWS region / DR region | `us-east-1` / `us-west-2` |
| Compute | ECS Fargate — `next start`, Node 22 (+ OTel sidecar); prod 2 tasks (1024/2048), max 6 |
| DB / Search | Aurora MySQL Serverless v2 (`VER_3_08_0`) / OpenSearch 2.19 |
| Operator contact | `paa2013@med.cornell.edu` (alarm email) / GitHub `paulalbert1` (prod deploy approver) — **post-launch ownership TBD** |

> **Two cross-doc facts every operator must internalize:**
> 1. **Account model.** ADR-008's *decision* is staging and prod in **separate AWS accounts**, but the actual deployment
>    is a documented **single-account deviation**: both envs share account **`665083158573`** in `us-east-1`, isolated
>    by env-prefix. Confirm the live topology with `aws sts get-caller-identity` per env before assuming separate accounts.
> 2. **Stack count.** ADR-008 says "six stacks"; `cdk/bin/sps-infra.ts` instantiates **nine**. Trust the bin file (table in §2).

## 1. Services used

### AWS service inventory (per env; sizes from `../cdk/lib/config.ts`)

| Service | Role in SPS | Resource name / pattern | Prod size | Staging size |
|---|---|---|---|---|
| **CloudFront** | CDN/edge; per-route HTML cache (24 h scholars, 6 h others); injects `X-Origin-Verify` | dist id: prod `E28NKDFXC7K2ZL`, staging `E17NRWINXLP3B3` | 1 dist | 1 dist |
| **AWS WAF (WAFv2)** | Edge filter on the distribution: rate rule (1000 req / 5 min / IP) + AWS Managed Rules; WCM-only gate | attached to CloudFront | — | — |
| **ECS Fargate (app)** | Runs Next.js + OTel sidecar; 24×7 + autoscale | svc/family `sps-app-${env}`, cluster `sps-cluster-${env}` | 2 × (1024/2048), min 2 / max 6 | 1 × (512/1024), min 1 / max 3 |
| **ECS Fargate (ETL)** | Runs `npm run etl:<source>` per Step Functions step | family `sps-etl-${env}` | per-run 2048 / 8192 | same |
| **ECS Fargate (migration)** | One-shot `npx prisma migrate deploy` in deploy pipeline | family `sps-migrate-${env}` | 512 / 1024 | same |
| **ECS Fargate (db-bootstrap)** | One-shot `db-bootstrap.ts` (creates `scholars_audit`, grants) before migrate (#493) | family `sps-db-bootstrap-${env}` | — | — |
| **Application Load Balancers** | Two ALBs, same target group: public (CloudFront origin) + internal (`/api/revalidate`) | `sps-public-${env}`, `sps-internal-${env}` | 2 | 2 |
| **Aurora MySQL Serverless v2** | Primary store; all page reads + `/api/edit` writes; holds `scholars_audit` DB; `VER_3_08_0`; RETAIN + deletion-protected | CDK-generated under `Sps-Data-${env}` | 1–8 ACU, writer + 1 reader | 0.5–2 ACU, writer-only |
| **Amazon OpenSearch** | `/search` + suggest autocomplete only; alias `scholars` → `scholars_v{ts}` (atomic swap); OpenSearch 2.19 | prod `opensearch58799-fquptd67j2so`, staging `opensearch58799-9dwko5mxr7bu` | 2 × `m6g.large.search` (multi-AZ) | 1 × `t3.medium.search` |
| **AWS Backup** | Daily plan + cross-region (us-west-2) copy | vault `sps-backup-vault-${env}`, plan `sps-aurora-daily-${env}` | 35-day archive (PITR 14 d) | 14-day |
| **Step Functions** | Orchestrates ETL; one Standard state machine per cadence | `scholars-{nightly,weekly,annual,heartbeat}-${env}` | — | — |
| **EventBridge** | Cron rules firing the state machines | `sps-etl-{nightly,weekly,annual}-${env}` | `false` on first deploy (operator-driven) | `true` |
| **Secrets Manager** | DB/OpenSearch/SAML/ETL/edge/revalidate creds; injected via exec role only (~11/env) | `scholars/...` (see §6) | ~11 | ~11 |
| **ECR** | Image registry (app + ETL repos, #454) | `scholars-app-${env}`, `scholars-etl-${env}` | app + ETL | same |
| **SNS** | Alarm fan-out (page) + cost/notify | page `sps-alarms-${env}`, notify `sps-notify-${env}`, ETL `etl-failures-${env}` | — | — |
| **Lambda** | (1) on-call Teams relay; (2) Aurora rotation; (3) nightly CloudFront usage-rollup | `sps-oncall-relay-${env}` (nodejs22.x, 256 MB) + RDS rotation + analytics rollup | — | — |
| **DynamoDB** | **Upstream input only** (legacy ReciterAI `reciterai` table); SPS provisions **no** table | external `reciterai` | — | — |
| **S3** | CloudFront access logs (90-day lifecycle); `.next/static` assets; Glue/Athena analytics; Backup; reads ReciterAI artifacts | logs `sps-edge-${env}-logsbucket…` | — | — |
| **Glue + Athena** | Roll CloudFront logs into durable `daily_usage` table (aggregates only) | AnalyticsStack | — | — |
| **NAT Gateway** | Outbound internet for in-VPC tasks (ETL pulls, SES, X-Ray) | 1 per env | 1 | 1 |
| **VPC Endpoints** | Keep AWS traffic off NAT | Secrets Manager (interface) + S3 (gateway); OpenSearch intentionally NOT an endpoint | — | — |
| **X-Ray** | Tracing from OTel sidecar (5% + 100% errors/slow) | — | — | — |
| **Amazon SES** | "Request a change" / slug-request mailer (low volume, flagged) | — | — | — |
| **CloudWatch** | Alarms + logs + reliability dashboard | log groups `/aws/ecs/sps-app-${env}` etc.; 9 platform alarms | logs 3 mo | logs 1 mo |
| **AWS Budgets / Cost Anomaly** | Account-wide cost guardrails (**prod only**) | `sps-monthly-budget` ($600/mo), `sps-anomaly-monitor` ($50/day) → notify | yes | none |

### The CDK stacks (`../cdk/bin/sps-infra.ts`)

Nine stacks, each `Sps-{X}-${env}` (e.g. `Sps-App-prod`). Selected via `-c env=staging|prod`; account via `-c <envName>Account=<id>` (never committed). `DataStack` and `NetworkStack` carry `RemovalPolicy.RETAIN` + deletion protection so a bad `AppStack` deploy can't tear down the database.

| Stack | Provisions |
|---|---|
| **NetworkStack** | VPC, public + private-with-egress subnets (2 AZs), base SGs, Route 53 Resolver FORWARD rules for WCM DNS |
| **DrBackupVaultStack** | us-west-2 DR BackupVault that DataStack's copyAction writes into (B10) |
| **DataStack** | Aurora MySQL Serverless v2 (writer + reader, PITR, RETAIN) + OpenSearch domain + AWS Backup plan/vault |
| **SecretsStack** | Secrets Manager secret *definitions* (empty) + RDS rotation Lambda |
| **AppStack** | ECR (app + ETL), ECS cluster/service/tasks, public + internal ALBs, VPC endpoints, migration + db-bootstrap tasks, deploy/OIDC IAM roles |
| **EtlStack** | Step Functions (nightly/weekly/annual), EventBridge schedules, ETL Fargate family, `etl-failures-${env}` SNS, cadence/status alarms |
| **ObservabilityStack** | 9 platform alarms, `sps-alarms`/`sps-notify` SNS, on-call relay Lambda, reliability dashboard, **prod-only** budget + cost-anomaly |
| **EdgeStack** | CloudFront fronting the public ALB, WAF, `sps-security-headers-${env}` policy, legacy-VIVO 301 redirects, access-log bucket |
| **AnalyticsStack** | Glue + Athena over CloudFront logs + nightly usage-rollup Lambda → durable `daily_usage` table |

> **Stack files:** [`../cdk/bin/sps-infra.ts`](../cdk/bin/sps-infra.ts), [`../cdk/lib/config.ts`](../cdk/lib/config.ts), [`../cdk/lib/app-stack.ts`](../cdk/lib/app-stack.ts), [`../cdk/lib/data-stack.ts`](../cdk/lib/data-stack.ts).

### External upstreams (data freshness, not live request path)

**Live request-path** (outage = user-visible now): CloudFront+WAF, Aurora, OpenSearch, WCM SAML IdP (`/edit` login only), WCM Enterprise Directory LDAPS (live `/edit/*` authz).

**ETL-path** (outage = stale data, site stays up): Enterprise Directory LDAPS (nightly → Scholar/Appointment/org units), ReciterDB MariaDB (nightly → Publications/MeSH/citations, heavy ~5 min), InfoEd MS SQL (nightly → Grant), COI Portal MySQL (nightly → CoiActivity), ASMS MS SQL (nightly → Education), Jenzabar MS SQL (weekly → PhD mentoring), ReciterAI DynamoDB+S3 (Topic/Score/Spotlight/tools), NIH RePORTER + NSF (weekly), NLM MeSH (annual). WCM-internal reachability depends on **TGW + WCM firewall owned by Central Services account `091981818184`, not SPS**.

Method/tool taxonomy and spotlight data are published by ReciterAI as **JSON on S3** (`s3://wcmc-reciterai-artifacts/tools/latest/...`, `.../spotlight/latest/spotlight.json`), **not** DynamoDB; SPS ETL ingests into Aurora.

## 2. Starting & stopping the app

### Production / staging lifecycle

#### The deploy split (the central footgun)

There are **two** deploy mechanisms — confusing them is the #1 operator mistake:

| Change type | Mechanism | Trigger |
|---|---|---|
| App **code / image** | `deploy.yml` re-rolls the container image | Auto on push to `master` (staging); manual `workflow_dispatch` (prod) |
| **Infra / flag / env-var** (`cdk/lib/*`) | Manual `cdk deploy Sps-App-<env>` | **Human only — never CI** |
| **CloudFront / EdgeStack** | Manual `cdk deploy Sps-Edge-<env>` only | **Human only — deliberately not in `deploy.yml`** |

Consequence: pushing to `master` deploys only the **staging app image**. It does **not** update CloudFront and does **not** apply CDK/flag changes. **Prod lags master** until a human dispatches a prod deploy. A flag wired only in `.env.local` but not in `app-stack.ts` ships silently **off**.

#### Ship to staging (automatic)

Merge to `master` → `deploy.yml` runs against staging. Pipeline order (load-bearing): build image → push ECR (app + ETL) → sync `.next/static` → S3 → **db-bootstrap** → **verify-grants** → **prisma migrate deploy** → `ecs update-service --force-new-deployment` → wait services-stable. Steps 3–5 are **fail-closed gates** (non-zero exit halts; service is not rolled). Wall-clock with no migration: **~7–9 min**.

#### Promote to prod (gated, manual)

```sh
gh workflow run deploy.yml --ref master -f env=prod
```
Or UI: `Actions → Deploy → Run workflow`, branch **`master`**, env **`prod`** → run lands in *Awaiting approval* → required reviewer (`paulalbert1`) clicks *Approve and deploy*. Three controls gate prod: the `prod` GitHub Environment (master-only + required reviewer), the workflow's "refuse prod from non-master ref" step, and the OIDC sub-claim (`...:environment:prod`).

**Pre-deploy checklist (prod)** — all must hold:
- `cd cdk && npx cdk diff --exclusively Sps-App-prod -c env=prod` is clean (the workflow does **not** run `cdk diff`).
- Same commit SHA deployed to staging within last 72 h.
- No un-previewed Prisma migrations in the diff.
- On-call coverage for next 30 min.
- Log groups `/aws/ecs/sps-app-prod`, `/aws/ecs/sps-migrate-prod` reachable without re-auth.

#### Apply an infra / feature-flag change (manual cdk)

```sh
cd cdk
npx cdk diff   --exclusively Sps-App-<env> -c env=<env>   # confirm delta is intended
npx cdk deploy --exclusively Sps-App-<env> -c env=<env>
```
Adding a new flag to `app-stack.ts` also requires regenerating the snapshot or the `cdk` CI gate fails:
```sh
cd cdk && npm ci && npm test -- -u   # commit only the .snap
```

**EdgeStack (CloudFront) — a bare `cdk deploy` STRIPS the WAF + cert + custom domain.** Always diff `--strict` with all context flags and confirm **no destroy** of WebACL/IPSet/Aliases/ViewerCertificate first:
```sh
npx cdk diff --strict --exclusively Sps-Edge-<env> \
  -c env=<env> -c edgeCustomDomain=<domain> \
  -c edgeCertArn=<acm-arn-us-east-1> \
  -c edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16
# verify NO destroy/Removed, then:
npx cdk deploy --require-approval never --exclusively Sps-Edge-<env> <same -c flags>
```
**Ordering** when a new cross-stack ref is added: deploy `Sps-App-<env>` **first**, then `Sps-Edge-<env>`.

#### Scale / "start" / "stop" the running app

Cluster `sps-cluster-<env>`, service `sps-app-<env>`. Floor/ceiling: staging desired 1 / max 3 (512/1024); prod desired 2 / max 6 (1024/2048).

**Kill switch / "stop" (scale to zero)** — drains all tasks in ~30 s; CloudFront then returns `503`. **Killing prod is a P0 — notify active operators first.**
```sh
aws ecs update-service --cluster sps-cluster-<env> --service sps-app-<env> --desired-count 0
```
**Restore ("start")** — set desired-count back to env default (1 staging / 2 prod):
```sh
aws ecs update-service --cluster sps-cluster-<env> --service sps-app-<env> --desired-count <1|2>
```
**Restart in place (re-roll same image):**
```sh
aws ecs update-service --cluster sps-cluster-<env> --service sps-app-<env> --force-new-deployment
```

**Autoscaling (#596):** attached only when `desiredCount > 0`. Two target-tracking policies — CPU **60%** util and ALB **1000 requests/target** on the public TG (scaleOut cooldown 60 s, scaleIn 300 s). *Both thresholds are conservative placeholders pending #554 load-test numbers.* **Rolling deploy:** `minHealthyPercent 100`, `maxHealthyPercent 200`, `healthCheckGracePeriod 120 s`, `circuitBreaker { rollback: true }` (auto-rolls back if new tasks fail health checks — no operator action).

#### Roll back (app code → previous task-def revision)

**No migration rollback — fix forward** (migrations are additive-only). Roll back when, sustained ≥ 5 min: ALB target-group 5xx ≥ 1% **or** p95 ≥ 2× pre-deploy baseline.

```bash
aws ecs update-service \
  --cluster <CLUSTER> \
  --service <SERVICE> \
  --task-definition <FAMILY>:<PREVIOUS_TASK_DEF_REVISION> \
  --force-new-deployment
```
Find `<PREVIOUS_TASK_DEF_REVISION>` from `aws ecs describe-services → deployments[].taskDefinition` (the entry that was `PRIMARY` before this deploy). Expected ~**4–6 min** for a 4-task service. **Do NOT** roll back by re-triggering the workflow from a prior commit — it re-runs the migration step. Rollback does **not** cover: migration rollback (fix forward), Aurora PITR (§5), CloudFront invalidation (use `/api/revalidate`), OpenSearch alias swap.

#### Revalidate webhook / cache-bust

`POST /api/revalidate` (`Authorization: Bearer`) busts the ISR cache after an ETL run. Token in `scholars/revalidate-token` → `SCHOLARS_REVALIDATE_TOKEN`. The app caches accepted tokens for the process lifetime; **only a redeploy/cold-start re-reads them**. One-time CloudFront flush after deploying the HTML-TTL clamp:
```sh
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/about" "/about/*"
```

### Local dev (developers only — not for ops on the running app)

Prereqs: Node 22+, Docker (≥4 GB), **host** MariaDB 11 on `127.0.0.1:3306` (not Dockerized MySQL), npm 10+.

```bash
npm install
cp .env.example .env.local
npm run db:up          # OpenSearch via docker compose (MariaDB runs on the host)
npm run db:check       # confirm DATABASE_URL target + grant sanity
npm run db:migrate     # apply Prisma migrations (dev)
npm run dev            # Next.js dev server (Turbopack) → http://localhost:3000
# stop / reset:
npm run db:down        # stop local docker containers (OpenSearch)
npm run db:reset       # drop + recreate local DB and re-run migrations
```
Search index (local): `npm run search:index` (all three) or `:people` / `:publications` / `:funding`.
ETL (local, reads prod sources over VPN): `npm run etl:daily` (chain head `etl:ed` must succeed first) / `npm run etl:revalidate`.

> Deeper: [`./DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), [`./rollback-runbook.md`](./rollback-runbook.md), [`./staging-cutover.md`](./staging-cutover.md), [`./revalidate-token-rotation.md`](./revalidate-token-rotation.md), [`../README.md`](../README.md).

## 3. What to monitor

### SLOs (measured at the public ALB, 28-day rolling)

| SLO | Target | Error budget |
|---|---|---|
| **Availability** | 99.5% of target-side requests return 2xx/3xx (`(2XX+3XX)/RequestCount`; **4xx excluded**) | 3 h 22 min of failed-request time / window |
| **Latency** | p99 of ALB `TargetResponseTime` < 1.5 s | alarmed at threshold breach |

**Error-budget policy** (policy, *not* enforced): if > 50% of the 28-day budget burns in any rolling 7-day sub-window, prod deploys pause. Non-SLO "normal" brackets: CloudFront cache hit > 85% healthy / < 50% incident signal; Aurora connections alarm at 80.

### Alarm catalog — 9 alarms/env → **page** topic `sps-alarms-${env}` (`../cdk/lib/observability-stack.ts`)

| Alarm | Threshold | Eval | Catches |
|---|---|---|---|
| `sps-alb-5xx-rate-${env}` | > 1% (gated by ≥ 5 absolute 5xx first) | 5m, 2/2 | Availability SLO burn |
| `sps-alb-unhealthy-hosts-${env}` | `UnHealthyHostCount` > 0 | 1m, 5/5 | Zero healthy targets |
| `sps-alb-latency-p99-${env}` | p99 > 1.5 s | 5m, 3/3 | Latency SLO burn |
| `sps-ecs-task-shortfall-${env}` | desired − running > 0 | 1m, 5/5 | Tasks died, not replaced |
| `sps-aurora-cpu-${env}` | > 80% | 5m, 3/3 | Hot query loop |
| `sps-aurora-connections-${env}` | > 80 | 5m, 3/3 | Connection-pool exhaustion |
| `sps-opensearch-jvm-pressure-${env}` | > 85% | 5m, 3/3 | GC pressure → query latency |
| `sps-opensearch-cluster-red-${env}` | `ClusterStatus.red` > 0 | 1m, 1/1 | Shards unassigned |
| `sps-edit-authz-denied-${env}` | `edit_authz_denied` > 10 | 5m, 2/2 | Edit-surface 403 burst / probing |

> **Count note:** `SLOs.md` says "eight"; the 9th (`sps-edit-authz-denied`, B02 #101) is real in code. **Code is authoritative — 9 alarms.**

A separate **relay watchdog** `sps-oncall-relay-errors-${env}` (Lambda `Errors` ≥ 1/min, 1m 1/1) routes to the **notify** topic (email), not page — because the page topic flows through the relay Lambda itself.

### Alerting path

| Topic | AWS name | Subscriber | What publishes |
|---|---|---|---|
| **Page** | `sps-alarms-${env}` | `sps-oncall-relay-${env}` Lambda → Teams | The 9 CloudWatch alarms |
| **Notify** | `sps-notify-${env}` | `paa2013@med.cornell.edu` (email) + relay-errors alarm | budget thresholds + cost-anomaly (prod) + relay-Lambda failure |

The **B27 relay Lambda** (nodejs22.x, 256 MB) reads the Teams workflow URL from `scholars/${env}/oncall/teams-webhook-url` at cold start and POSTs an **Adaptive Card as `application/json`** — because Power Automate **rejects** SNS's direct `x-www-form-urlencoded` delivery with HTTP 400. **Never** `aws sns subscribe --protocol https` against the workflow URL — it's a permanent trap. **Off-hours gap (accepted):** Teams + email only — no SMS, no phone, no ack-tracking.

**Cost guardrails (prod-only, account-wide):** `sps-monthly-budget` $600/mo (notify at 50%/80% forecast, 100% actual); `sps-anomaly-monitor` $50/day → notify.

### ETL freshness (all → `etl-failures-${env}` → relay → Teams)

State machines `scholars-{nightly,weekly,annual,heartbeat}-${env}`; EventBridge rules `sps-etl-<cadence>-${env}`. Four signals:

| Signal | Source | Catches |
|---|---|---|
| Per-step failure | `NotifyX` SnsPublish in each step's `Catch` | A specific step that threw |
| Status alarm `sps-etl-<cadence>-status-${env}` | `ExecutionsFailed` > 0 | Any failed execution |
| Cadence alarm `sps-etl-<cadence>-cadence-${env}` | `ExecutionsStarted` < 1 over window (`treatMissingData: BREACHING`) | Schedule never fired |
| Freshness heartbeat | `etl:freshness` exits non-zero → its status alarm | **Green-but-stale** |

Schedules (UTC): nightly `cron(0 7 * * ? *)`, weekly `cron(0 8 ? * SUN *)`, annual `cron(0 9 1 7 ? *)`, heartbeat `cron(0 13 * * ? *)`. Cadence windows: nightly 30 h, weekly 7 d, heartbeat 30 h; **annual has no cadence alarm** (exceeds CloudWatch max window — caught by calendar). The heartbeat compares each source's last `status='success'` against its SLA (nightly 30 h, weekly 8 d, annual ~400 d) by reading the in-VPC `etl_run` table.

> **Prod caveat:** prod cadences **and** the heartbeat ship **disabled** (`etlSchedulesEnabled=false`) until launch — both activate together. The `etl-failures → relay` subscription is always active.
>
> **Not freshness-tracked** (failures still caught, staleness not): `revalidate`, `reporter`, `nsf`, `gates`, `nih-profile`, `search:index`. `rows_processed = 0` is not yet flagged.

### Where logs live

| Log group | Contents | Retention |
|---|---|---|
| `/aws/ecs/sps-app-${env}` | Main app — structured single-line JSON | prod 3 mo / staging 1 mo |
| `/aws/ecs/sps-migrate-${env}` | `prisma migrate deploy` per deploy | prod 3 mo / staging 1 mo |
| `/aws/ecs/sps-etl-${env}` | ETL task runs (confirm exact name in synth) | EtlStack default |
| `/aws/lambda/sps-oncall-relay-${env}` | Relay Lambda (`oncall_relay` events) | 30 days |
| CloudFront access logs → S3 `cf/${env}/` | Edge request logs | 90-day lifecycle |

Key structured events to search: `profile_view` (`duration_ms`), `search_degraded`, `edit_authz_denied`, `saml_callback_failed`, `superuser_check_failed`, `edit_write_failed`, `oncall_relay`. Day-to-day dashboard: **`sps-reliability-${env}`** (ALB / CloudFront / ECS / Aurora). New Relic is the live APM; CloudWatch is the durable long-horizon mirror.

### Periodic health check

1. Open dashboard `sps-reliability-${env}`: ALB p99 < 1.5 s, 5xx flat, ECS running = desired, Aurora connections < 80, CF cache hit > 85%.
2. No alarms in ALARM:
   ```bash
   aws cloudwatch describe-alarms --alarm-name-prefix "sps-" --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text
   ```
3. Data freshness (query the oracle, don't grep logs):
   ```sql
   SELECT source, status, completed_at, rows_processed FROM etl_run ORDER BY started_at DESC LIMIT 20;
   ```
   Or confirm `sps-etl-heartbeat-status-${env}` is `OK`.
4. Paging path alive — fire a non-customer-visible test alarm and confirm a Teams card (prod: prefer the connections alarm over the 5xx-rate alarm):
   ```bash
   aws cloudwatch set-alarm-state --alarm-name "sps-aurora-connections-${ENV}" --state-value ALARM --state-reason "health-check dry-run"
   ```
5. No card? → run the §8/diagnostics sequence in the errors section below.

> Deeper: [`./SLOs.md`](./SLOs.md), [`./oncall.md`](./oncall.md), [`./etl-monitoring.md`](./etl-monitoring.md), [`./logging-reference.md`](./logging-reference.md), [`./tracing.md`](./tracing.md), [`./performance-baseline.md`](./performance-baseline.md).

## 4. Common error messages & fixes

`${env}` / `$ENV` = `staging` or `prod`. This is the section operators use most.

| # | Symptom | Likely cause | Fix / where to look |
|---|---|---|---|
| 1 | Page shows old content after an edit/ETL run; or fixed page still looks broken | Edge cache: scholar/dept/center/topic pages cache 24 h (max 1 y); `/about` etc. clamped to 60 s; `/_next/static/*` up to 1 y | Surgical bust = **`POST /api/revalidate`** (bearer), **not** `aws cloudfront create-invalidation` (emergencies only). Reindex does **not** yet POST revalidate (#479/#353) → data can lag by the TTL. → [`./cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) |
| 2 | A profile section is stale (renders, old data, not blank) | That section's **ETL source** stopped refreshing — SPS serves last good snapshot | Check last good run: `SELECT source,status,completed_at,rows_processed,error_message FROM etl_run WHERE source='<Source>' ORDER BY started_at DESC LIMIT 5;` then re-run per-source `npm run etl:<ed\|reciter\|infoed\|coi\|asms\|jenzabar\|dynamodb\|spotlight>` (idempotent; `etl:ed` head first). "Topics updating" placeholder is benign (30-min `reciter→dynamodb` window). → [`./dependency-outage-matrix.md`](./dependency-outage-matrix.md), [`./data-population-runbook.md`](./data-population-runbook.md) |
| 3 | Teams card naming an ETL alarm (`sps-etl-*-status/-cadence/-heartbeat-status-${env}`) | Step threw / schedule never ran / green-but-stale | Read card → Step Functions console `scholars-<cadence>-${env}` newest execution (red state names step + cause) → log group `/aws/ecs/sps-etl-${env}` → confirm impact via `etl_run`. Common: WCM source unreachable (not fixable from SPS alone), EventBridge rule disabled, no-op source. Resume mid-chain: `aws stepfunctions start-execution … --input '{"startFrom":"<StepId>"}'`. **Prod schedules disabled until launch.** → [`./etl-monitoring.md`](./etl-monitoring.md) |
| 4 | Search returns nothing / too few people (`covid19`→9 but `covid-19`→1,425; `tylenol`→0) | (A) alphanumeric tokenization #725 fuses `covid19`; (B) MeSH concept resolution is ranking-only #726 (never admits a doc) | A = `alnum_delimiter` analyzer **+ reindex together** (glued terms regress until rebuilt). B = admit on `publicationMeshUi` when lexical sparse. Reproduce: `curl -s -G localhost:3002/api/search --data-urlencode q=<term> --data-urlencode type=people` → `.total`. Then reindex (#9 below). → [`./search-recall.md`](./search-recall.md) |
| 5 | Retracted paper showing (or a paper vanished) | The retraction **notice** is hidden; the **original article** keeps `Journal Article` type until restamped | Nightly `PubMedRetractions` step stamps the retracted PMID set → `publicationType='Retraction'` (then #63 hides). Manual: `npm run etl:pubmed-retractions` **+ reindex**. **Prod schedules disabled** → won't auto-run yet. → [`./retracted-publications.md`](./retracted-publications.md) |
| 6 | `sps-alb-5xx-rate-${env}` fired / "Something went wrong" | CloudFront/Aurora outage (cache-cold pages 5xx) or a render throw; 5xx is never edge-cached | Check Edge+App dashboards + `sps-alb-5xx-rate`/`sps-aurora-*`. Roll back app code if 5xx ≥ 1% **or** p95 ≥ 2× baseline sustained 5 min (command in §2 Roll back). **Do NOT roll back migrations — fix forward.** → [`./rollback-runbook.md`](./rollback-runbook.md), [`./error-handling-spec.md`](./error-handling-spec.md), [`./dependency-outage-matrix.md`](./dependency-outage-matrix.md) |
| 7 | Staff can't start `/edit`; callback errors `idp_status_error`/`invalid_saml_response`/`no_cwid`; `superuser_check_failed` | SAML IdP or Enterprise Directory (LDAPS, **fail-closed**) unreachable; or IdP cert rotated / wrong `SAML_IDP_CERT`; `no_cwid` = IdP not releasing `CWID`; `Responder` = `SAML_SP_ENTITY_ID` mismatch | **⚠️ Hard deadline 2026-08-19** (see §6): trust **both** certs in `SAML_IDP_CERT` (concat PEM, secret `scholars/<env>/saml/idp-cert`). Rollover = env-var change + ECS rolling deploy, no code. Diagnose via `saml_callback_failed`/`superuser_check_failed` events; validate via staging smoke (non-prod uses prod IdP). → [`./saml-sp.md`](./saml-sp.md) |
| 8 | Alarm fired but no Teams card within 5 min | Break in SNS → relay Lambda → Power Automate (stale URL secret, disabled/offboarded workflow, or alarm never reached ALARM) | (1) `aws cloudwatch describe-alarms --alarm-names "sps-oncall-relay-errors-${ENV}" --query 'MetricAlarms[0].StateValue'` — ALARM = Lambda broken (email is the page). (2) `aws logs tail "/aws/lambda/sps-oncall-relay-${ENV}" --since 10m --follow` for `oncall_relay` (`delivered status:202` = Teams-side; `upstream_error 4xx/5xx` = workflow rejected). (3) Power Automate Run history. (4) `aws secretsmanager get-secret-value --secret-id "scholars/${ENV}/oncall/teams-webhook-url"`. (5) verify alarm hit ALARM (INSUFFICIENT_DATA = no-op). (6) `aws sns list-subscriptions-by-topic` — exactly one `Protocol: lambda`. **Never** `aws sns subscribe --protocol https`. → [`./oncall.md`](./oncall.md) |
| 9 | Search stale/missing/wrong after a mapping/analyzer change or data load | Index needs an out-of-band rebuild (atomic alias swap, so a failed rebuild never blanks the live index) | In-VPC run-task (subnets/SG from `Sps-Network-$ENV`): `aws ecs run-task --cluster sps-cluster-$ENV --task-definition sps-etl-$ENV --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED}' --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","search:index"]}]}'` — watch `/aws/ecs/sps-etl-$ENV`. → [`./data-population-runbook.md`](./data-population-runbook.md) |
| 10 | Home "Selected research" empty/hidden/wrong authors/404 links | Spotlight ETL no-op / floor / author join / wrong link shape | `EtlRun` most-recent `Spotlight` row: `status="success"` & `rows_processed>0` (`0` = sha256-unchanged short-circuit). `SELECT COUNT(*) FROM spotlight` (≤25). Floor `SPOTLIGHT_FLOOR=6` hides if < 6 survive. Authors render only `cwid IS NOT NULL`. Browse links must be `/topics/{parent}?subtopic={sub}`. Re-publish upstream in ReciterAI (`python3 backfill_spotlight.py --publish`) then `npm run etl:spotlight`. → [`./spotlight-runbook.md`](./spotlight-runbook.md) |
| 11 | DB data loss / corruption (not app code) | Outside app-rollback scope — Aurora PITR | Targets **RPO ≤ 24 h, RTO ≤ 4 h**. Variant A — PITR `aws rds restore-db-cluster-to-point-in-time … --use-latest-restorable-time` then add a `db.serverless` writer (~20–40 min). Variant B — snapshot restore from DR vault `sps-dr-backup-vault-${env}` (us-west-2). → [`./restore-drill-runbook.md`](./restore-drill-runbook.md) |
| 12 | `POST /api/revalidate` returns 401 / 500 | 401 = no/wrong token or non-Bearer scheme; 500 `server misconfigured` = `SCHOLARS_REVALIDATE_TOKEN` unset; mid-rotation 401 = old process cached old token | During rotation stage **both** `SCHOLARS_REVALIDATE_TOKEN` (new) + `SCHOLARS_REVALIDATE_TOKEN_PREVIOUS` (old) in `scholars/revalidate-token`, redeploy app to re-read, roll ETL callers, verify both 200, drop previous after ≥24 h + redeploy. → [`./revalidate-token-rotation.md`](./revalidate-token-rotation.md) |

**Quick alarm → entry index:** 5xx-rate / unhealthy-hosts / ecs-task-shortfall → #6; latency-p99 → #1/#6; aurora-cpu / aurora-connections → #2/#6; opensearch-red / jvm-pressure → #4/#9; etl-*-status/-cadence/-heartbeat → #3; oncall-relay-errors → #8; budget/anomaly (notify, email) = cost guardrail, not a service incident.

## 5. Host, contacts & access

### Operator / on-call & escalation

- **Current named operator:** `paa2013@med.cornell.edu` (notify-topic email + budget/cost recipient) / GitHub `paulalbert1` (prod deploy required reviewer). **⚠️ Post-launch ownership is an explicit open question** (likely owner: ITS management) — until resolved, on-call defaults to this single operator.
- **WCM ops model:** no automated paging (no PagerDuty/Opsgenie/SMS/ack-tracking). Pattern = **ServiceNow** (tickets + CI escalation groups) + **Teams channels** (chat signal) + **phone calls from Ops** (manual MI escalation). SPS today (B23 phase 1): AWS alarms → Teams (relay Lambda) + email; **off-hours wake-up is an accepted gap**. Future (B23 follow-on, unsized): register SPS as a ServiceNow CI in an escalation group.
- **Workflow-owner fragility:** the Teams Power Automate workflow is tied to its creator's Microsoft account — if they offboard, alerting silently stops. Quarterly-review check: "Is the Workflow URL holder still at WCM and still owns the workflow?"

### Who can deploy

- Push to `master` auto-deploys **staging only**; prod is `workflow_dispatch`-only. Two-belt prod gate: OIDC sub-claim (prod admits only `…:ref:refs/heads/master`) **and** the `prod` GitHub Environment required reviewer (`paulalbert1`).
- **Setup caveat:** until the `prod` Environment has ≥1 required reviewer, a `workflow_dispatch env=prod` runs **without** approval (OIDC master-pin still holds).
- **⚠️ Footgun:** `gh api -X PUT .../environments/<name>` **full-replaces** config — always re-send `deployment_branch_policy` or it wipes the master-only policy.
- `cdk deploy` / `cdk diff` / secret provisioning are owned by the account holder, run with their AWS creds; **`cdk deploy` is never run autonomously**.

### Who can edit what (RBAC — 3 independent layers; full detail in [`./access-control-rbac.md`](./access-control-rbac.md))

**Layer 1 — Application RBAC** (public read = no login; editing = WCM SSO via SAML):

| Role | Source of truth | Can do |
|---|---|---|
| **Self** | `session.cwid == target.cwid` | Edit own overview; hide own scholar/grant/education/appointment; revoke own suppression |
| **Superuser** | ED group `ITS:Library:Scholars/superuser-role` (LDAPS, re-checked every `/edit/*` GET + POST, never session-cached) | Everything — any field incl. `slug`, whole-pub takedown, grant/revoke unit roles, view suppressed data |
| **Unit Owner** | `unit_admin` `role=owner` | Edit unit + manage access in owned subtree; proxy-edit in-scope scholars |
| **Unit Curator** | `unit_admin` `role=curator` | Edit the unit only; cannot delegate |
| **Proxy editor** | `scholar_proxy` row | Self-edit scope on the one granted scholar |

Properties: **fail-closed** (a directory error denies; an ED outage blocks all editing but never affects public reads); dept grants cascade to divisions but not upward; roster membership never confers edit rights. **Break-glass:** no SSO-bypass exists (a security property) — emergency superuser = add the CWID to the ED group; kill switch = scale service to 0 (P0 in prod).

**Layer 2 — AWS IAM:** `sps-task-exec-${env}` (pulls image, injects enumerated secret ARNs) vs `sps-task-${env}` (running app — **zero attached secret perms**). Pipeline: `sps-deploy-${env}` (OIDC), `sps-migrate-${env}`, `sps-db-bootstrap`.

**Layer 3 — Database roles:** `scholars/db/app-ro` (read-only), `app-rw` (read/write + INSERT-only on `scholars_audit.manual_edit_audit`), `etl` (ETL tables), `bootstrap`/`sps_bootstrap` (create audit schema + grant only).

### AWS account / secrets context

- Region `us-east-1`, DR `us-west-2`. Account IDs are passed at deploy time as CDK context (`-c <envName>Account=<id>`) per ADR-008's "never commit account IDs" rule; in practice the single-account deviation's ID below also appears in several committed docs and `cdk/lib/*` — confirm the live value with `aws sts get-caller-identity`, don't trust a hardcoded one.
- **⚠️ Account model:** ADR-008 says separate accounts; `PRODUCTION_ADDENDUM.md` documents a single-account deviation, **`665083158573`**. **Confirm live with `aws sts get-caller-identity` per env — do not assume separate accounts.**
- Secrets (Secrets Manager, referenced by ARN under `secrets:`, never `environment:`): `scholars/db/{app-rw,app-ro,etl,bootstrap}`, `scholars/opensearch/{app,etl}`, `scholars/revalidate-token`, `scholars/etl/{source}`, `scholars/<env>/saml/idp-cert`, `scholars/${env}/oncall/teams-webhook-url`, `scholars/${env}/edge/origin-shared-secret`. **DB creds rotate automatically** (RDS rotation Lambda); the account holder owns quarterly calendar rotation of OpenSearch, `revalidate-token`, and per-source ETL secrets.

### Dated deadlines (do not miss)

| Deadline | What |
|---|---|
| **2026-08-05** | Reminder: verify `SAML_IDP_CERT` carries **both** certs and IdP still signs with expected cert |
| **2026-08-19** | Active WCM IdP signing cert (CN `login-proxy.weill.cornell.edu`, issued 2016-08-19) **expires** — every SSO login breaks unless both certs are trusted beforehand. Successor (2026-03-27→2036-03-27) already in IdP metadata |
| **2026-08-26** | Reminder: drop the expired cert from `SAML_IDP_CERT` |
| Within **3 days** of an Observability deploy | Confirm the notify-topic email subscription from `paa2013@med.cornell.edu`'s inbox or it expires |
| **2036-03-27** | Successor IdP cert expiry (next rollover horizon) |

**Governance gaps:** no formal access-recertification cadence (superuser group / `unit_admin`); no standing emergency-superuser account (elevation depends on ED reachability); post-launch operations ownership unresolved.

## 6. Where to find more (doc index)

[`./DOCUMENTATION-REGISTRY.md`](./DOCUMENTATION-REGISTRY.md) is the **master index**, keyed by the question an operator would ask. The highest-value docs:

| For… | See |
|---|---|
| How it's deployed | [`./DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) |
| How to roll back | [`./rollback-runbook.md`](./rollback-runbook.md), [`./restore-drill-runbook.md`](./restore-drill-runbook.md) |
| SLOs, alarms, dashboards | [`./SLOs.md`](./SLOs.md) |
| On-call routing / paging diagnostics | [`./oncall.md`](./oncall.md) |
| ETL freshness & failure SOP | [`./etl-monitoring.md`](./etl-monitoring.md), [`./data-population-runbook.md`](./data-population-runbook.md) |
| What breaks when an upstream is down | [`./dependency-outage-matrix.md`](./dependency-outage-matrix.md) |
| Who can edit / deploy what (RBAC) | [`./access-control-rbac.md`](./access-control-rbac.md) |
| Login / SAML / cert rollover | [`./saml-sp.md`](./saml-sp.md) |
| Edge cache behavior | [`./cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) |
| Logs / events / Logs Insights | [`./logging-reference.md`](./logging-reference.md) |
| Tracing a slow request | [`./tracing.md`](./tracing.md) |
| VPC / network / WAF | [`./network-security-topology.md`](./network-security-topology.md) |
| Architecture overview | [`./architecture-overview.md`](./architecture-overview.md) |
| **Master index** (the "where do I find X" doc) | [`./DOCUMENTATION-REGISTRY.md`](./DOCUMENTATION-REGISTRY.md) |

*Last reviewed: 2026-06-14 (consolidated from existing runbooks).*
