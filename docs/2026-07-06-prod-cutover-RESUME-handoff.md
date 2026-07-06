# Prod ETL/SPS cutover — MID-WINDOW RESUME handoff (2026-07-06)

**The prod item-3 VPC-consolidation cutover is PAUSED mid-window at a safe, reversible point.**
The old data tier is still serving the live app; the new tier is stood up but not yet cut to.
Resume from **step 9 (FGAC recreate)** below. Plan/step-detail source of truth:
`docs/cutover-item3-prod-window-runbook.md` (this doc = current position + deltas from it).
Tracker **#1458**.

> ⚠️ **FREEZE IS HELD.** No `/edit` curator writes may land until the cutover completes — the
> freeze snapshot `sps-data-prod-cutover-final-20260706t024926z` is the App-cut data source, and
> a post-snapshot write would be lost. Pre-launch, so no real edit traffic expected. If the pause
> runs long and you're unsure, re-take the snapshot at resume (no writes ⇒ current one is valid).

---

## DONE (this window) — do NOT redo

| Step | What | Result |
|---|---|---|
| Phase A prep | 3 prod SGs + config wire (#1489), OS `node` seeded | merged/inert |
| B1 quiesce | ETL cadences + `sps-reconcile-prod` + `sps-cdn-reconcile-prod` **DISABLED** | freeze anchored |
| B2 snapshot | **`sps-data-prod-cutover-final-20260706t024926z`** (available) | freeze data source |
| B4/5 sever (config #1, **PR #1491** `6934d7c1`) | `openSearchNodeFromSecret`+`observabilityMetricsByName` on; deployed **Etl → Observability → App** (see ORDER note) | 3 stacks `UPDATE_COMPLETE`; App task-def `:27`, svc 2/2; App ALB/TG exports severed |
| B6/7 flip (config #2, **PR #1492** `3b9deb82` = master HEAD) | `useSharedVpc:true` + `auroraSnapshotIdentifier` | — |
| B7 Data deploy | `Sps-Data-prod` `UPDATE_COMPLETE` | NEW cluster+domain up; OLD **orphaned/RETAINED** |
| B8 DSN reseed | all 5 `scholars/prod/db/*` → new cluster host | prod `@'%'` ⇒ host swap only, no re-grant |

**⚠️ RUNBOOK CORRECTION (the runbook has these wrong):**
1. **Sever deploy order is `Etl → Observability → App`** (consumer-before-producer), NOT the runbook's
   `App → Etl → Observability`. App-first hits `Cannot delete export …TargetGroupFullName… in use by
   Sps-Observability-prod`. Etl first (creates `EtlPageTopic` export), then Observability (switches to
   literal metrics = stops importing App's ALB/TG + Data's Aurora/OS; subscribes to EtlPageTopic), then
   App (safe to drop the now-unused exports).
2. **OS master rotation DEFERRED to post-cutover** (NOT in-window as the runbook's step 3 says). Rotating
   `scholars/prod/opensearch/master` mid-window would split old/new-domain creds across AWSCURRENT/
   AWSPREVIOUS and break the step-9 FGAC read of the OLD domain. Use current creds throughout; rotate BOTH
   `scholars/{prod,staging}/opensearch/master` after cutover (fresh prod domain is VPC-internal meanwhile).
   ⚠️ Those two master values were leaked to a session transcript 2026-07-05 — rotate regardless.

## Live state / identifiers (grounded 2026-07-06)

- **NEW Aurora** `sps-data-prod-auroraclusterfromsnapshot7b6a45d8-ylbuldcja7bm` (available, writer+reader)
  - writer `…-ylbuldcja7bm.cluster-cetg9yc1lyuf.us-east-1.rds.amazonaws.com`
  - reader `…-ylbuldcja7bm.cluster-ro-cetg9yc1lyuf.us-east-1.rds.amazonaws.com`
  - transitional master secret = `scholars/prod/db/master-its`
- **NEW OS domain** `opensearchshare-hr8gdfznbeww` → `vpc-opensearchshare-hr8gdfznbeww-334reqz4u3odxj3solzfle3hxu.us-east-1.es.amazonaws.com` (Active). Master user `sps_master` (pw from `scholars/prod/opensearch/master`). **FGAC internal users app/etl NOT yet created.**
- **OLD (retained, still serving):** Aurora `…auroracluster23d869c0-naxambgndood`; OS `opensearch58799-fquptd67j2so`.
- **Secrets now:** `scholars/prod/db/*` = NEW cluster ✅. `scholars/prod/opensearch/app` node = **OLD domain** (unchanged — app still reads old). `scholars/prod/opensearch/etl` node = **OLD domain** (must reseed → new before reindex, step 10).
- **Prod shared SGs:** app `sg-098a71afdd462d988`, etl `sg-03babbb300ddb3b95`, alb `sg-06422c1b27dc4e17d`.
- **Deploy tree:** `~/worktrees/sps-deploy-prod` (detached at master `3b9deb82`). `cd cdk && npm ci` done.
- **App reads OS via** `OPENSEARCH_USER`/`OPENSEARCH_PASS` (FGAC user), node via secret. Search auth = FGAC user, so app/etl users MUST exist on the new domain before reindex + app-cut.

**In-VPC task launcher** (shared VPC; reaches the new tier):
```bash
runjs() { aws ecs run-task --cluster sps-cluster-prod --task-definition sps-etl-prod --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-0c6593fb9c9a165c3,subnet-070cbc242efbddc3c],securityGroups=[sg-03babbb300ddb3b95],assignPublicIp=DISABLED}' \
  --overrides "{\"containerOverrides\":[{\"name\":\"etl\",\"command\":$1}]}" --started-by prod-cutover; }
```

---

## RESUME HERE — remaining steps (in order)

### Step 9 — FGAC recreate on the new OS domain (reversible; redo if wrong)
The etl task role has NO `opensearch/master` access (scoped). Staging-proven pattern:
1. **Temp-grant** the etl task-EXECUTION role `secretsmanager:GetSecretValue` on `scholars/prod/opensearch/master` (find role via `aws ecs describe-task-definition --task-definition sps-etl-prod --query …executionRoleArn`).
2. **Register a one-off task-def** cloned from `sps-etl-prod` adding `opensearch/master` as an injected secret (raw-string → env, e.g. `OS_MASTER_PASS`), command = a `fetch`-based node/tsx that GETs `_plugins/_security/api/internalusers` + `…/rolesmapping` (+ `…/roles` if custom) from the OLD domain (basic auth `sps_master:$OS_MASTER_PASS`) and PUTs the app/etl users to the NEW domain. App/etl user passwords come from `scholars/prod/opensearch/{app,etl}`.
3. **run-task** in the shared VPC (launcher above but with the one-off task-def).
4. **Verify** app+etl internal users exist on new domain (GET `_security/api/internalusers`).
5. **Cleanup:** deregister the one-off task-def; **revoke** the temp exec-role grant.

### Step 10 — Reindex the new domain (long; ~178k pubs)
1. Reseed `scholars/prod/opensearch/etl` node → NEW domain endpoint (so `search:index` writes new). Leave `opensearch/app` node = OLD (app still serves old until step 12).
2. `runjs '["npm","run","search:index"]'` — watch `/aws/ecs/sps-etl-prod`.
3. Verify doc counts on new domain match a fresh build (staging ref: ~8937 people / 177255 pubs / 4858 funding / 1150 opps) + alias on fresh index, BEFORE the app-cut.

### Step 11 — App-cut (Phase C) ← **POINT OF NO EASY RETURN**
`cd ~/worktrees/sps-deploy-prod && git checkout --detach origin/master` (fetch first) → `cdk diff Sps-App-prod --exclusively -c env=prod` (confirm shared-VPC, auto-named ALB **create-before-delete**, ECS service **update not replace**, no surprise) → `cdk deploy Sps-App-prod --exclusively -c env=prod --require-approval never`. App now on new cluster (SOR) + new OS (via app node — see step 12) + shared VPC. Validate internal ALB w/ `X-Origin-Verify` (`scholars/prod/edge/origin-shared-secret`); confirm an edit write lands in new cluster. **Then redeploy `Sps-Observability-prod`** swapping the step-4 transitional identifiers to the NEW cluster/domain/auto-named-ALB+TG names.

### Step 12 — Edge repoint (Phase D)
Reseed `scholars/prod/opensearch/app` node → NEW domain; redeploy App/Etl so the live app reads the new domain. Then repoint CloudFront origin — **`--strict` diff FIRST** (only origin/SSM-param may change; any WAF/cert/alias delta = STOP):
```
cdk deploy Sps-Edge-prod --exclusively -c env=prod \
  -c edgeCustomDomain=scholars.weill.cornell.edu \
  -c edgeCertArn=arn:aws:acm:us-east-1:665083158573:certificate/95f77e69-4abc-4d2c-b081-b8b5b8572fd6 \
  -c edgeAllowedCidrs=140.251.0.0/16,157.139.0.0/16
```
Re-assert `https://scholars.weill.cornell.edu/` 200.

### Step 13 — ETL cutover (Phase E) + lift freeze
`cdk deploy Sps-Etl-prod --exclusively -c env=prod`. After one clean manual run, **re-enable** `sps-reconcile-prod` + `sps-cdn-reconcile-prod` (`aws events enable-rule`). Leave nightly disabled until a supervised pass. Confirm `aws cloudformation list-imports` empty for old Data/App exports. **Lift the write-freeze.**

### Then Phase F soak (days) → Phase G decommission (old tier, 35-day retention, Sps-Network-prod LAST). Rotate the 2 OS master secrets.

---

## Rollback from HERE (pre-App-cut = clean)
Nothing is cut. To abort: leave the old tier serving (it is). Optionally revert `scholars/prod/db/*`
DSNs to the OLD cluster host (`…auroracluster23d869c0-naxambgndood`) so a task restart can't reach the
new cluster, then delete the new `Sps-Data-prod` resources (or `cdk` revert config #1/#2 and redeploy).
Old Aurora + OS are RETAINED + deletion-protected. Zero data loss (freeze held ⇒ new == old).
