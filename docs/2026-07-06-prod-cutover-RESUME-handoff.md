# Prod ETL/SPS cutover — MID-WINDOW RESUME handoff (2026-07-06)

**The prod item-3 VPC-consolidation cutover is PAUSED mid-window at a safe, reversible point.**
The old data tier is still serving the live app; the new tier is stood up but not yet cut to.
Resume from **step 9 (FGAC recreate)** below. Plan/step-detail source of truth:
`docs/cutover-item3-prod-window-runbook.md` (this doc = current position + deltas from it).
Tracker **#1458**.

> ### UPDATE 2026-07-06 (continued session) — **CUTOVER COMPLETE ✅ (steps 9–13 done); FREEZE LIFTED**
> **All in-window steps done + verified. App/search/DB/edge/ETL on the new consolidated tier.**
> Remaining = post-cutover follow-ups only (Observability config PR, OS-master rotation, soak/decommission)
> + two human-vantage verifications (see bottom).
> - **Step 9 FGAC recreate — DONE ✅** (reversible, verified). Provisioned NEW OS domain
>   `opensearchshare-hr8gdfznbeww` from runbook §1a–§1d via a one-off ETL task (clone of
>   `sps-etl-prod` + `node -e`, master/app secrets KMS-injected). All 6 PUTs `201 CREATED`;
>   verify: internalusers `scholars-etl,sps_master,scholars-app`; rolesmappings `sps_etl→scholars-etl`,
>   `sps_app→scholars-app`. **Cleanup done:** temp exec-role grant `tmp-cutover-fgac-os` REVOKED;
>   one-off task-def `sps-etl-fgac-oneoff-prod:1` deregistered (INACTIVE).
> - **Step 10 reindex — DONE ✅** (task `2a090a35…`, ~8 min, exit 0). `scholars/prod/opensearch/etl`
>   node reseeded → NEW domain (app node still OLD ✅). `search:index` built + alias-swapped all 4
>   indices on NEW domain; counts match staging ref: **people 8937 / pubs 177255 / funding 4858 /
>   opps 1121** (pre-swap gates passed, N-vs-0-live). Non-blocking smoke: opps prestige.score 0%
>   (ReciterAI producer track), 2 MeSH descriptors missing tree-numbers. NEW domain =
>   `m6g.large.search`×2 + base td `NODE_OPTIONS=7168`/8GB ⇒ both #485 gotchas were pre-mitigated.
> - **Step 11 App-cut — DONE ✅ + VALIDATED** (deploy `UPDATE_COMPLETE`, 705s). User-approved
>   "fold OS node in" ⇒ reseeded `opensearch/app` node → NEW **before** the single App deploy (app
>   came up already reading NEW OS; reachability pre-checked: NEW OS SG `sg-092aa345…` allows both
>   etl+app SGs). Post-cut: ECS `sps-app-prod` **2/2 COMPLETED in shared VPC** `vpc-08a1873…`
>   (subnets `0c6593…/070cbc…`, SG `sg-098a71…`); new `Sps-Ap-Publi-*`+`Sps-Ap-Inter-*` TGs healthy;
>   old ALBs/TGs/listeners + 3 old-VPC endpoints DELETED. E2E via new public ALB
>   `Sps-Ap-Publi-dZ0soKIosV6j-1850770008…` + `X-Origin-Verify`: `/api/health` **200**
>   `{ok,warmed}`, `/api/search?q=cancer` **200 total=1941**, pubs **438**, no-header **403**. New
>   internal ALB `internal-Sps-Ap-Inter-CvgsekjiZ9oN-484088083…` (sg `sg-0006fda123a38e654`).
> - **Step 12 edge repoint — DONE ✅ + VALIDATED** (deploy 93s). Origin source =
>   `ssm.valueForStringParameter('/sps/prod/app/public-alb-dns')` ⇒ App-cut updated that SSM param to
>   the new ALB, and the Description em-dash change forced the re-resolve. `--strict` diff = **Description
>   only, NO WAF/cert/alias delta** (3 ctx flags supplied). CloudFront `E28NKDFXC7K2ZL`: **Deployed**,
>   origin now `Sps-Ap-Publi-dZ0soKIosV6j…`, alias `scholars.weill.cornell.edu` + WebACL
>   `sps-edge-prod-wcm-only` INTACT. Chain CF→new ALB→app 200. ⚠️ Literal `https://scholars.weill.cornell.edu/`
>   200 STILL NEEDS a **WCM-network vantage** (edge WAF blocks the sandbox IP by design).
>   NOTE: step-12's "reseed app node + redeploy App" was **folded into step 11** — already done.
> - **Step 13 ETL cutover + freeze lift — DONE ✅.**
>   - `cdk deploy Sps-Etl-prod` `UPDATE_COMPLETE` (15:09Z): all 6 state machines
>     (Nightly/Weekly/Annual/Heartbeat/Reconcile/CdnReconcile) task network-configs → shared VPC
>     literals (`0c6593…/070cbc…`, etl SG `sg-03babbb…`); per-step abort→notify→continue retiering now
>     active. No resource add/remove, no IAM change.
>   - **Manual reconcile runs — both SUCCEEDED clean** against new tier: `scholars-reconcile-prod`
>     (`search:reconcile`, ~1.5m) + `scholars-cdn-reconcile-prod` (`cdn:reconcile`, ~1.5m).
>   - **Re-enabled** `sps-reconcile-prod` + `sps-cdn-reconcile-prod` (both ENABLED, rate 5min).
>     Nightly/weekly/annual cadences REMAIN **DISABLED** (runbook-deferred — full nightly = separate
>     supervised pass; NOT run here).
>   - **Old exports DRAINED** — `list-imports` empty for every `Sps-Network-prod:*` + `Sps-Data-prod-*`
>     export (old VPC/subnets/RTs/SGs + old OS endpoint). Severance complete ⇒ old tier decommissionable.
>   - **WRITE-FREEZE LIFTED** — freeze was OPERATIONAL (no technical flag: app env has no
>     MAINTENANCE/READ_ONLY/FREEZE). Purpose satisfied (app on new cluster = SOR; snapshot→app-cut window
>     closed). App write path config-verified: `scholars/prod/db/app-rw` → NEW cluster `…ylbuldcja7bm`,
>     grants preserved via snapshot restore. Curator `/edit` writes may resume.
>   - NOTE: the "two `Sps-Ap-Publi-*` ALBs in the shared VPC" = prod (`dZ0soKIosV6j`) + **staging**
>     (`28Px8J5FO9hH`, stack `Sps-App-staging`) co-tenancy — **NOT a stray**.
>
> - **POST-CUTOVER FOLLOW-UPS (not done here):**
>   1. **Observability config PR** (monitoring-only; alarms currently point at the deleted old ALB/TG).
>      Turnkey values → set env-config for prod:
>      - `publicAlbFullName = app/Sps-Ap-Publi-dZ0soKIosV6j/a43ae4ad91d52643`
>      - `publicTargetGroupFullName = targetgroup/Sps-Ap-Publi-TL07SCGAWNJM/4cc4b1d7b17c0f8c`
>      - `auroraClusterIdentifier = sps-data-prod-auroraclusterfromsnapshot7b6a45d8-ylbuldcja7bm`
>      - `opensearchDomainName = opensearchshare-hr8gdfznbeww`
>      then `cdk deploy Sps-Observability-prod --exclusively -c env=prod`.
>   2. **Rotate** `scholars/{prod,staging}/opensearch/master` (leaked to transcript 07-05; new domain is
>      VPC-internal so exposure is bounded but rotate regardless). Use the runbook §1 master-reset trick.
>   3. Phase F soak (days) → Phase G decommission OLD tier (Aurora `…naxambgndood`, OS
>      `opensearch58799-fquptd67j2so`, 35-day retention; `Sps-Network-prod` LAST).
>
> - **⚠️ TWO HUMAN-VANTAGE VERIFICATIONS still open (sandbox can't do them):**
>   1. `https://scholars.weill.cornell.edu/` → **200** from the **WCM network** (edge WAF allows only
>      140.251/157.139; the CF→ALB→app chain is otherwise proven green).
>   2. A real authenticated **`/edit` write** lands in the new cluster (write path is config-verified;
>      a browser write from a curator confirms end-to-end).

> ✅ **FREEZE LIFTED 2026-07-06** (cutover complete — see UPDATE block above). `/edit` writes may resume;
> they land in the new cluster `…ylbuldcja7bm` (SOR). *(Historical: the freeze protected the
> snapshot `sps-data-prod-cutover-final-20260706t024926z`→App-cut window; that window is now closed.)*

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
