# Prod cutover — NEXT STEPS handoff (2026-07-06)

**The prod VPC-consolidation cutover is COMPLETE.** App, search, DB, edge, ETL, and
monitoring are all on the shared consolidated tier (`vpc-08a1873fc8eebae28`). This doc =
what's LEFT. Full execution log + identifiers: `docs/2026-07-06-prod-cutover-RESUME-handoff.md`
(UPDATE block). Tracker **#1458**.

## Done (do NOT redo)
- Steps 9–13: FGAC provisioned, reindex (people 8937 / pubs 177255 / funding 4858 / opps 1121),
  App-cut (shared VPC + new Aurora SOR + new OS), edge repoint, ETL convergence, reconcile
  re-enabled, old exports drained, **write-freeze LIFTED**.
- Observability re-pointed to new resources (**PR #1494 merged + deployed**, alarms verified OK).

## Live tier (going-forward)
- **Aurora (SOR):** `sps-data-prod-auroraclusterfromsnapshot7b6a45d8-ylbuldcja7bm`
- **OpenSearch:** `opensearchshare-hr8gdfznbeww` (FGAC users `sps_master`/`scholars-app`/`scholars-etl`)
- **Public ALB:** `Sps-Ap-Publi-dZ0soKIosV6j-1850770008…` · CloudFront `E28NKDFXC7K2ZL`
- **Shared VPC:** `vpc-08a1873fc8eebae28`; app SG `sg-098a71afdd462d988`, etl SG `sg-03babbb300ddb3b95`
- **Deploy tree:** `~/worktrees/sps-deploy-prod` (on `docs/prod-cutover-resume-handoff`). For any
  `cdk deploy`: `git fetch origin && git checkout --detach origin/master` first, `cdk diff` before deploy.

---

## NEXT STEPS (priority order)

### 1. Human-vantage verifications (do first — cheap, closes confidence gaps)
Neither is doable from the dev sandbox (edge WAF blocks non-WCM IPs by design).
1. From the **WCM network**: `https://scholars.weill.cornell.edu/` → **200**, load a profile +
   run a search. (CF→ALB→app chain is already proven green server-side.)
2. Authenticated **`/edit` write** by a curator → confirm it lands in the new cluster
   (`…ylbuldcja7bm`). Write path is config-verified (`scholars/prod/db/app-rw` → new cluster, grants
   preserved via snapshot restore); this is the end-to-end confirmation.

### 2. Rotate the leaked OpenSearch master secrets (security)
`scholars/prod/opensearch/master` + `scholars/staging/opensearch/master` were leaked to a session
transcript 2026-07-05. New prod domain is VPC-internal (bounded exposure) but rotate regardless.
Post-cutover this is now SAFE (mid-window it would have split old/new creds — no longer a concern).

**Mechanism** (per env; rotating `sps_master` does NOT affect app/etl auth — separate internal users):
- The `_security` admin API is in-VPC only, so use the **step-9 one-off-task pattern** (clone
  `sps-etl-<env>`, KMS-inject `opensearch/master`, temp-grant the exec role, revoke after).
- A same-name `update-domain-config MasterUserOptions` is a **NO-OP** on an internal-DB domain (AWS
  can't diff a password) — so rotate via the internal-users API, not update-domain-config:
  `PUT _plugins/_security/api/internalusers/sps_master {"password":"<new>"}` (auth = current
  `sps_master`), then `put-secret-value scholars/<env>/opensearch/master` = the **same** new value.
  Do both in the same task so they never diverge. Never echo the password.
- **Verify:** a fresh GET `_plugins/_security/api/internalusers` with the NEW master cred returns 200.
- Fallback if the API path is blocked: the username-swap trick (update-domain-config MasterUserName →
  `sps_master_v2` + new secret → wait Processing → optionally back). See `docs/data-population-runbook.md` §1.
- The OLD prod domain (`opensearch58799-fquptd67j2so`) still holds the old master value — fine, it's
  being decommissioned; don't bother rotating it.

### 3. Deferred nightly ETL — one supervised pass, then re-enable cadences
Nightly/weekly/annual EventBridge rules are **DISABLED** (`sps-etl-{nightly,weekly,annual}-prod`).
Only the 5-min reconcilers are live. Before re-enabling:
- Manually run `scholars-nightly-prod` once, **supervised**, and watch `/aws/ecs/sps-etl-prod`.
- Known interaction (memory): the nightly's DDB pass reverts `scholar_tool` content but launch-fields
  persist (Path B / #1458 interim) — expected, not a failure. "Clean" = the state machine reaches its
  success terminal (per-step abort→notify→continue retiering is now active, so a single source failure
  pages + continues rather than aborting the whole run).
- Confirm all WCM sources reachable from the shared VPC (proven 07-02 G6 probe: ED/ReciterDB/ASMS/
  InfoEd/COI/Jenzabar). ReCiter API is intra-VPC — needs the ReCiter ELB SG to allow `:5000` from the
  SPS app SG (app-side `/edit`+`etl:reciter-refresh` only, NOT nightly).
- Once a supervised pass is clean: `aws events enable-rule --name sps-etl-{nightly,weekly,annual}-prod`.

### 4. Phase F — soak (days)
Let the new tier run under the re-enabled reconcilers (+ nightly once step 3 is done). Watch the
re-pointed Observability alarms (`sps-alb-5xx-rate-prod`, `sps-aurora-cpu-prod`,
`sps-opensearch-*-prod`, ReliabilityDashboard). Canary: a known scholar's `publicationCount > 0`.
Old tier stays retained/deletion-protected throughout (rollback available).

### 5. Phase G — decommission the OLD tier (only after soak passes)
Retained + deletion-protected, safe to drop once confident:
- OLD Aurora `sps-data-prod-auroracluster23d869c0-naxambgndood` (disable deletion-protection → delete)
- OLD OpenSearch `opensearch58799-fquptd67j2so`
- **Delete the datastores FIRST**, then `cdk deploy Sps-Network-prod` **LAST** (it tears down the old
  standalone VPC `vpc-0d0209cbfd298c892` / 10.10.0.0/16). The #1385 config already ARMS the
  shared-import synth, so deploying `Sps-Network-prod` before the datastores are gone will fail on the
  in-use ENIs. 35-day snapshot retention covers the window.
- Optional cleanup afterward: transitional secret `scholars/prod/db/master-its` (used only for the
  snapshot restore); confirm nothing references it before removing.

---

## Rollback (still available until Phase G)
Old Aurora + OS are RETAINED + deletion-protected. If a soak-blocking issue appears, the fastest
revert is to repoint the app back: reseed `scholars/prod/db/*` + `opensearch/{app,etl}` node → OLD
host/domain and redeploy `Sps-App-prod` to the old VPC (config revert). This gets progressively less
clean as data diverges post-cutover — prefer forward-fix once real `/edit` writes land in the new
cluster. After Phase G it is gone.
