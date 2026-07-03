# RePORTER grants v2 — activation handoff (2026-06-26)

Continue the v2 lateral-recruit matcher. **All three PRs are MERGED to master**; the `/edit` card just needs **staging activation** (one step in-flight via CD, one manual step remaining). Spec: `docs/reporter-grants-v2-matcher-spec.md`. PR-3 plan: `docs/reporter-grants-v2-pr3-plan.md`. Prior handoff: `docs/reporter-grants-v2-handoff.md`. Memory: `project_reporter_grants_backfill`.

## Shipped (all merged + the ETL side fully live on staging)

| PR | What | State |
|---|---|---|
| #1312 `8268d797` | ETL + `ReporterProfileCandidate` model | merged |
| #1313 `8bbe92af` | flag `REPORTER_MATCH_V2` + cursor-free runtime guard | merged · **deployed to staging** · **staging-verified** |
| #1314 `33dc22c0` | `/edit` "Is this you?" card + confirm/reject/revoke routes | merged |

**Staging ETL verify (2026-06-26, passed):** cohort 8283 (active 8937 − profiled 654; 4804 w/≥1 PMID). One cap-500 run → **20 auto-locked + 1 pending, 0 fetch errors**. DB confirmed: 20 `person_nih_profile` rows `resolution_source='pmid-overlap-auto'` + same-run grants; the pending one (`jos2087` "Joel Sheinfeld", K=2) has NO profile + NO grants — **it's the live fixture to confirm once the card is activated**. Auto-lock sample `kag2035` "Karuna Ganesh" K=34, 3 grants. `overlapK` persisted internal-only. Uncapped pass ≈ 3–4 h → cap covers all over ~17 nights.

## ⚠️ ACTIVATION — ONE step left (the card is INERT on staging until it lands)

Push-to-master only rolls the staging *image*; it does **not** set new task-def env vars (that's `cdk deploy`). And the audit ENUM must be widened or every confirm/reject/revoke 500s on its in-transaction audit insert.

### Step 1 — audit-DB ENUM widening ✅ DONE + VERIFIED (2026-06-26)
The merge's CD run (`deploy.yml` run `28277211883`, completed/success) ran the **`sps-db-bootstrap-staging`** task, which executed `scripts/db-bootstrap.ts` → applied `scripts/sql/audit-log.sql` (now with the 3 new `action` values + `reporter_profile_candidate` entity) as the `sps_bootstrap` DDL role. **Idempotent** (`MODIFY COLUMN` with a matching enum is a no-op). Verified from the bootstrap task log (`/aws/ecs/sps-db-bootstrap-staging`): `db_bootstrap_start` → "Applying 5 audit-schema DDL statement(s)" (CREATE DB + CREATE TABLE + 3 ENUM `MODIFY COLUMN`s) → INSERT grant verified → `db_bootstrap_ok`. Re-runs on every push-to-master, so it stays in sync; no manual action needed.

> Verify-vantage gotcha: do NOT read the audit ENUM from a `sps-etl-staging` run-task — the **`etl`** DB role has nothing on `scholars_audit` (errno 1142). Use the **`sps-db-bootstrap-staging` task log** (above) as the source of truth, or run the probe from the **app**/migrate task (`app_rw` has the audit INSERT priv → `SHOW COLUMNS` works) — but the app image may lack `tsx`.

### Step 2 — app flag deploy (MANUAL — the only remaining action)
Set `REPORTER_MATCH_V2=on` on the staging **app** task (already wired in `cdk/lib/app-stack.ts`, staging-on/prod-off). **Wait for the CD run to fully settle first** (don't collide with its `update-service` roll). Run from a clean `origin/master` checkout (NOT a feature branch — see [[feedback_cdk_deploy_from_master_not_feature_branch]]):
```
git -C <fresh-origin/master worktree or detached HEAD> ...
cd cdk && cdk diff   --exclusively Sps-App-staging -c env=staging   # expect ONLY +REPORTER_MATCH_V2=on on the app task def
       && cdk deploy --exclusively Sps-App-staging -c env=staging
```
Do NOT pass `-c <env>Account` ([[project_cdk_deploy_env_agnostic]]). Verify after:
```
aws ecs describe-task-definition --task-definition sps-app-staging \
  --query "taskDefinition.containerDefinitions[].environment[?name=='REPORTER_MATCH_V2'].value" --output text
```

### Step 3 — verify the card live
On staging `/edit/scholar/jos2087` (superuser) or as the scholar: the "Is this you?" rail item should show the pending Sheinfeld candidate. Confirm it → `person_nih_profile` row written (`resolution_source='pmid-overlap-confirmed'`) → grants appear after the next `etl:reporter-grants` nightly. Check the audit insert succeeded (no 500). Then revoke to restore state if desired.

## Staging run-task recipe (verified this session)
cluster `sps-cluster-staging` · task-def `sps-etl-staging` (or `sps-db-bootstrap-staging` for step 1) · container `etl` · launch FARGATE · subnets `subnet-019afebef588ee4b3,subnet-03de6e3dfe190288b` · SG `sg-09b494047547ea148` · `assignPublicIp=DISABLED`. Logs `/aws/ecs/sps-etl-staging` stream `etl/etl/<taskId>`. Read-probe override: `["npx","tsx","-e","<CJS async IIFE>"]` (import `db` from `./lib/db`; NOT top-level await). Net config is authoritative from the nightly state machine `scholars-nightly-staging`. AWS acct 665083158573, us-east-1, user `reciter`.

## Tunables (env, code defaults; override in etl-stack.ts when sized)
- `REPORTER_MATCH_V2_MAX_PER_RUN` (default 500 cohort/run; 0 = no cap). With 4804 PMID-bearing scholars, 500/run ≈ ≤30 min/night, full cohort in ~17 nights — tune up if you want faster coverage.
- `REPORTER_MATCH_V2_MIN_PMIDS` (default 1; raise to trim low-yield scholars).

## Landmines (don't relearn)
- **Flag is set by `cdk deploy`, not the image roll.** CD (push-to-master) rolls the image only; new task-def env needs `cdk deploy --exclusively Sps-App-<env>`. Same for the ETL flag (already deployed in #1313).
- **Audit ENUM gap = silent 500.** Any new `AuditAction`/`AuditEntityType` must be added to `scripts/sql/audit-log.sql` (CREATE + the idempotent `MODIFY COLUMN`, appended LAST to preserve ordinals) AND applied via the bootstrap task before the feature is enabled. The adversarial review caught this; don't ship audit actions without it.
- **Worktree stale-symlink false failures.** A worktree symlinking the canonical (possibly-behind) `node_modules` produces FALSE `tsc`/`vitest` failures (`vis-network` tsc; a HomePanel headshot Radix-Avatar/jsdom test). They fail on clean master source in-worktree too and pass in CI's fresh install — distinguish by checking out master's files and re-running. CI is the real gate.
- **Run the FULL `npx vitest run` before push.** A new REQUIRED `EditContext` field broke hand-built fixtures in unrelated page-auth tests (`edit-scholar-page`, `edit-self-page-guard`) that `tsc` didn't flag (untyped/partial fixtures) and a narrow workflow-verify subset missed — CI caught them. ([[feedback_run_vitest_before_push]])
- **Projection-starving.** `overlapK` must never reach the client — not selected in `loadEditContext`, not on the `EditContext` types, never rendered.
- **Authz IS-1.** All 3 routes: genuine-self OR genuine-superuser with `impersonatedCwid===null` — impersonating superuser DENIED 403.
- **Subagents must not merge/push.** Main loop only.

## Roadmap after activation
1. **Prod rollout** — after the staging soak signs off: apply the audit ENUM to the prod audit DB, flip `REPORTER_MATCH_V2=on` in `app-stack.ts` + `etl-stack.ts` for prod, `cdk deploy --exclusively Sps-App-prod` / `Sps-Etl-prod` (prod deploys pause for the `paulalbert1` reviewer gate). Decision §14-A: optionally demote auto-lock to all-`pending` at first prod flip if precision is unproven.
2. **CV-generator integration** — confirmed grants flow into the WCM CV (`docs/scholar-cv-generator-spec.md`, flag `EDIT_CV_EXPORT`); coordinate.
3. **Deferred org-label** — "via NIH RePORTER · {org}" needs `orgName` persisted on `Grant` (column + #1307 transform write). Separate from v2.

## Pointers
- Merged: #1312 `8268d797`, #1313 `8bbe92af`, #1314 `33dc22c0`. Spec §4 ETL / §5 model / §6 card / §7 routes / §11 tests / §12 audit SQL / §14 decisions.
- Read-only prod/staging Aurora recipe: [[project_sps_prod_db_readonly_query]]. CDK deploy env-agnostic: [[project_cdk_deploy_env_agnostic]].
