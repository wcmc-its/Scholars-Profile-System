# PROD ETL Tier-1 — ordered runbook (manual, gated)

Execute-in-order checklist derived from `docs/prod-etl-next-steps-handoff.md`. Runs the **no-WCM**
backfills that back the flags the item-3 cutover turned on. Every step has a verify gate; **stop at the
first gate that fails.** Nothing is automated — you run each command.

**Scope:** account `665083158573`, us-east-1, cluster `sps-cluster-prod`. Writes to prod Aurora +
OpenSearch. Do this in a maintenance window.

## ✅ EXECUTED 2026-07-01 (steps 1→3, verified live prod `665083158573`)
Driven as one-off ECS run-tasks on `sps-cluster-prod`. All exit 0.
- **Step 0** — IDs/netcfgs resolved: cluster `sps-cluster-prod`, app svc `sps-app-prod`, migrate
  `sps-migrate-prod`. APP netcfg SG `sg-01f2e3ff2033bd4d7`; ETL netcfg SG `sg-0c788d972c34ab444`;
  both in subnets `subnet-0bebda86d22ad986e` + `subnet-0d3cb02f6a1069c7f`.
- **Step 1 migrate** — pre-scan of 40 pending SQLs = clean (17 CreateTable / 17 AlterTable additive /
  8 FK / enum-widen / nullable-relax; the 1 DropColumn on `center_program` targets cols created empty
  earlier in the same batch → **verified 0 data loss**, cols absent on prod pre-run). `migrate deploy`
  applied **33** migrations (`20260609140000`→`20260621170000`) — NOT the Jun 26–29 ones, because the
  migrate task uses the same **Jun-22 app image** (`:latest` = `bb7b13f4`), so the DB is now synced to
  the running app, not to master. 4 bridge tables created (count 0).
- **Step 2 bridge imports** — all 4 exit 0; counts now match staging exactly:
  `mentee_copublication`=950, `aoc_mentee`=1055, `mentee_copublication_pub`=3803,
  `publication_citing`=172279 (citing: 172,279 upserted in 45s).
- **Step 3 reindex** (`search:index`) — Indexed 8937 scholars, 177255 publications, 4918 funding,
  0 opportunities; smoke checks passed. `wcmAuthorDepartments` coverage **0 → 174,126 (98%)**;
  Dept facet has real buckets (N1280=53718, N1520=13849, …).
- **Step 4 funding refresh** — `etl:dynamodb` exit 0 (170s): topic=68, publication_topic=77116,
  topic_assignment=13279, publication_impact=9735, opportunity=1121, core=1, publication_core=2883,
  scholar_tool=11791. Followed by a **full `search:index` reconcile** (not just funding — DDB refresh
  touched impact/topics/opportunities that feed the publications index): 8937 scholars / 177255 pubs /
  4918 funding / **1121 opportunities** (was 0); smoke passed. Backs the funding tab / prestige +
  opportunity match.
- **Tier-2 (nightly enable / WCM) untouched, as planned** — blocked on VPC-consolidation + WCM.

## Correction vs the handoff (read once)
The handoff said "run the migrate task `sps-migrate-prod` / `prisma migrate deploy`" without the shape.
Verified against `.github/workflows/deploy.yml` (origin/master):
- Migrate is the ECS task family **`sps-migrate-prod`** (CFN output `EcsMigrationTaskFamily` on
  `Sps-App-prod`). Its entrypoint is `npx prisma migrate deploy`, baked into the image — **there is no
  npm script**, you run the task def bare (no command override).
- It reuses the **app service's** networkConfiguration (app private subnets + app SG — needs DB +
  Secrets Manager), **not** the ETL Step-Functions network config. The ETL scripts in steps 2–3 use
  the ETL config. Two different netcfgs — don't cross them.
- `npm run db:migrate` = `prisma migrate dev` and `db:reset` = `migrate reset --force` are **dev-only
  and destructive. NEVER run either against prod.**

---

## Step 0 — capture identifiers + the two network configs
```bash
# App stack outputs: migrate task family, cluster, service
aws cloudformation describe-stacks --region us-east-1 --stack-name Sps-App-prod \
  --query "Stacks[0].Outputs[?contains(OutputKey,'Ecs')||contains(OutputKey,'Cluster')||contains(OutputKey,'Service')]" \
  --output table

# App service netcfg — for the migrate task (step 1). Reuse it verbatim.
APP_NETCFG=$(aws ecs describe-services --region us-east-1 \
  --cluster sps-cluster-prod --services <APP_SERVICE_NAME> \
  --query 'services[0].networkConfiguration' --output json)

# ETL netcfg — for the ETL scripts (steps 2–3). Pull from the live SF def, not hardcoded.
ETL_NETCFG=$(aws stepfunctions describe-state-machine --region us-east-1 \
  --state-machine-arn <arn:...:scholars-nightly-prod> \
  --query 'definition' --output text | python3 -c 'import json,sys;d=json.load(sys.stdin);\
print(json.dumps(next(s["Parameters"]["NetworkConfiguration"] for s in d["States"].values() if "Parameters" in s and "NetworkConfiguration" in s["Parameters"])))')
```
Known literals from the handoff (sanity-check against the above): cluster `sps-cluster-prod`, ETL task
def `sps-etl-prod`, ETL SG `sg-0c788d972c34ab444`.

**Gate:** both `APP_NETCFG` and `ETL_NETCFG` are non-empty JSON with subnets + security groups.

---

## Step 1 — migrate prod DB  ▸ backs everything downstream (tables don't exist yet)
Prod is missing `mentee_copublication`, `aoc_mentee`, `mentee_copublication_pub`, `publication_citing`
(verified 2026-07-01) — the schema migration never ran on prod. The step-2 imports **hard-fail
("table does not exist")** until this runs.
```bash
task_arn=$(aws ecs run-task --region us-east-1 \
  --cluster sps-cluster-prod \
  --task-definition sps-migrate-prod \
  --launch-type FARGATE \
  --network-configuration "$APP_NETCFG" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region us-east-1 --cluster sps-cluster-prod --tasks "$task_arn"
aws ecs describe-tasks --region us-east-1 --cluster sps-cluster-prod --tasks "$task_arn" \
  --query 'tasks[0].containers[0].exitCode' --output text        # must be 0
# logs on failure: /aws/ecs/sps-migrate-prod
```
**Gate:** exit code `0`, AND the four tables now exist (verify with the read-only probe below —
`information_schema` or a `db.read.<model>.count()` that returns `0`, not "table does not exist").
If exit ≠ 0 → **STOP**, read the log, do not proceed.

---

## Step 2 — mentoring / citation bridge imports  ▸ backs `MENTORING_COPUB_BRIDGE` + `PUBLICATION_CITING_BRIDGE`
S3 sources confirmed present (`s3://wcmc-reciterai-artifacts/mentoring/*` + `/citations/*`); ETL role
S3 grant went live in pass-2. Each is a truncate-load. Run on `sps-etl-prod` with `$ETL_NETCFG`:
```bash
for script in \
  etl:mentoring:import-copubs \
  etl:mentoring:import-aoc \
  etl:mentoring:import-copub-list \
  etl:mentoring:import-citing ; do          # import-citing pulls a 310MB ndjson — slowest
  echo "== $script =="
  arn=$(aws ecs run-task --region us-east-1 --cluster sps-cluster-prod \
    --task-definition sps-etl-prod --launch-type FARGATE \
    --network-configuration "$ETL_NETCFG" \
    --overrides "{\"containerOverrides\":[{\"name\":\"etl\",\"command\":[\"npm\",\"run\",\"$script\"]}]}" \
    --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --region us-east-1 --cluster sps-cluster-prod --tasks "$arn"
  aws ecs describe-tasks --region us-east-1 --cluster sps-cluster-prod --tasks "$arn" \
    --query 'tasks[0].containers[0].exitCode' --output text      # must be 0 before next
done
```
**Gate:** all four exit `0`, AND `COUNT(*) > 0` on `mentee_copublication`, `aoc_mentee`,
`mentee_copublication_pub`, `publication_citing` (staging refs: 950 / 1,055 / 3,803 / 172,279).
Until run, both features honest-degrade (blank co-pub chips / "Citation list temporarily
unavailable") — no errors — so a partial failure is safe to stop on.

---

## Step 3 — reindex  ▸ backs `SEARCH_PUB_DEPARTMENT_FILTER`
Prod's index has 177,255 docs but **0** with `wcmAuthorDepartments` (built pre-#837). A reindex
populates it from `scholar.deptCode`.
```bash
# Pre-check: scholar.deptCode coverage on prod must be nonzero, else the facet stays empty.
# Then full reindex (people + publications + funding):
arn=$(aws ecs run-task --region us-east-1 --cluster sps-cluster-prod \
  --task-definition sps-etl-prod --launch-type FARGATE \
  --network-configuration "$ETL_NETCFG" \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","search:index"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region us-east-1 --cluster sps-cluster-prod --tasks "$arn"
aws ecs describe-tasks --region us-east-1 --cluster sps-cluster-prod --tasks "$arn" \
  --query 'tasks[0].containers[0].exitCode' --output text        # must be 0
```
**Gate:** exit `0`, AND `/search` Publications tab shows a populated Department facet (nonzero
buckets). Until run, the facet renders empty (graceful, not a 500).

---

## Step 4 (optional) — funding  ▸ only if funding features are expected current on prod
```bash
# etl:dynamodb  (reciterai DDB -> prod DB), then:
# search:index:funding  (reindex funding axis)
```
Same run-task shape as step 2 (`$ETL_NETCFG`). Prestige detail:
`ReciterAI/docs/funding-prestige-rollout-handoff.md`. If you run this, a final `search:index`
reconciles everything.

---

## Read-only verify probe (for the gates)
Prod has no bastion/ECS-Exec. Run a SELECT-only one-off on `sps-etl-prod` (mariadb + `DATABASE_URL`
baked). `@/lib/db` exports `db = { read, write }` (mariadb adapter) — use `db.read.<model>.count()`;
`new PrismaClient()` bare THROWS and `db.$queryRawUnsafe` doesn't exist. Ref:
`project_sps_prod_db_readonly_query`, and the probe script in the prior session's scratchpad.

---

## DO NOT (Tier-2 — the systemic gap; needs WCM, do not rush)
- **Do NOT enable `sps-etl-nightly-prod`.** With the WCM gap the nightly aborts at `TaskEd`
  (abort-on-first-failure), exactly like staging's failing runs.
- **Do NOT touch staging** — it's fully backed (bridges populated, departments indexed). Its failing
  nightly is the same Tier-2 WCM issue, separate from this.
- The real unblock is the ETL→its-reciter VPC consolidation (pass-3 / Scope-B) + WCM firewall.
  Refs: `project_etl_cadence_vpc_relocation`, `project_sps_vpc_wcm_connectivity`.

## Decisions / open questions
- ✅ **DECIDED 2026-07-01 — which Tier-1 to run now:** steps **1 → 2 → 3** (migrate, bridge imports,
  reindex). Step 4 (funding) optional. They back flags already ON and user-visible.
- ❓ Was `sps-etl-nightly-prod` left DISABLED deliberately (pre-go-live) or never enabled? (needs human)
- ❓ WCM reachability from **prod** ETL specifically (staging's failure ≠ prod's state) — probe
  `etl:ed`/`etl:reciter` `:probe` scripts before any Tier-2 run. (needs human; Tier-2 only)
- ⚠️ Confirm the two network configs in step 0 resolved correctly before executing step 1.
