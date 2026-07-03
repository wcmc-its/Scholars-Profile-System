# RePORTER grants v2 — follow-ups + staging-sweep handoff (2026-06-27)

Continues `docs/reporter-grants-v2-activation-handoff.md`. Staging activation is **done** (app task-def rev 85, `REPORTER_MATCH_V2=on`, service rolled). This handoff covers the UX/precision follow-ups (3 open PRs) and the **uncapped staging sweep** that lights up the lateral-recruit cards. Memory: `project_reporter_grants_backfill`.

## Where things stand

| Item | State |
|---|---|
| Staging activation (flag + audit ENUM) | ✅ DONE + verified 2026-06-27 (rev 85, fixture `jos2087` pending) |
| **#1318** `feat/funding-reporter-source-aware` — Funding panel source-aware | OPEN, build+cdk GREEN |
| **#1319** `feat/reporter-card-nest-and-link` — nest card under Funding + RePORTER link | OPEN, build+cdk GREEN |
| **#1321** `feat/reporter-terminal-degree-guard` — namesake precision guard | OPEN, CI running at handoff |
| **#4** uncapped staging sweep | PENDING — gated on #1321 merge + image roll (recipe below) |
| Human SSO staging verify (UI + card walkthrough) | PENDING |
| Prod rollout | PENDING (after soak) |

All three PRs are **review-only, not merged**. None adds a new flag/env, so each is **image-roll-only** (CD on push-to-master) — **no `cdk deploy` needed**.

## Step 1 — merge the 3 PRs

Independent (disjoint files); any order. For each: poll `gh pr checks <N>` until `build` + `cdk` are green, then `gh pr merge <N> --squash`. Close-cite each in the merge.

- **#1318 / #1319** are app changes → CD rolls the **app** image (`scholars-app-staging:latest`).
- **#1321** is an ETL change → CD rolls the **etl** image (`scholars-etl-staging:latest`). **The sweep (Step 2) needs this image roll done first** — otherwise the guard isn't in the running code.

After merging, confirm the relevant CD run (`gh run list --workflow=deploy.yml --branch=master`) completed before relying on the new behavior.

## Step 2 — uncapped staging sweep (#4)  ⚠️ auto-locks profiles

**Why gated on #1321:** an uncapped sweep auto-locks K≥3 matches. Run it *after* the terminal-degree guard is live, or it will auto-lock the exact namesakes the guard exists to catch.

**Pre-flight:**
1. #1321 merged and its `scholars-etl-staging:latest` image roll **completed** (check the merge's `deploy.yml` run).
2. Confirm the flag is still on the etl task: `aws ecs describe-task-definition --task-definition sps-etl-staging --query "taskDefinition.containerDefinitions[].environment[?name=='REPORTER_MATCH_V2'].value" --output text` → `on`.

**Launch (run-task; net config is authoritative from `scholars-nightly-staging`):**
```bash
aws ecs run-task \
  --cluster sps-cluster-staging \
  --task-definition sps-etl-staging \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-019afebef588ee4b3,subnet-03de6e3dfe190288b],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npx","tsx","etl/reporter-grants/index.ts"],"environment":[{"name":"REPORTER_MATCH_V2_MAX_PER_RUN","value":"0"}]}]}' \
  --query 'tasks[0].taskArn' --output text
```
- `REPORTER_MATCH_V2_MAX_PER_RUN=0` ⇒ **no cap** (whole cohort, ~3–4 h: ~4,804 PMID-bearing scholars × ~2–3 RePORTER calls @ 1 req/s). Running `etl/reporter-grants/index.ts` does the full reporter-grants ETL (v1 materialization + v2 matcher) — idempotent.
- `REPORTER_MATCH_V2=on` is already baked on the task def (don't re-set it). Optional: raise `REPORTER_MATCH_V2_MIN_PMIDS` to trim low-yield scholars.
- Logs: `/aws/ecs/sps-etl-staging`, stream `etl/etl/<taskId>` (taskId = ARN suffix). Watch for the v2 summary line: `v2 complete: N auto-locked, M pending proposals (… X skipped: grants predate terminal degree, …)`.

**Verify after (read-probe — `etl` role CAN read app tables, NOT `scholars_audit`):**
```bash
# one-off run-task on sps-etl-staging, override command:
["npx","tsx","-e","import{db}from'./lib/db';(async()=>{try{const c=await db.write.reporterProfileCandidate.groupBy({by:['status'],_count:{_all:true}});const p=await db.write.personNihProfile.count();console.log('CAND='+JSON.stringify(c));console.log('NIH_PROFILES='+p);}catch(e){console.log('ERR='+e.message)}finally{await db.write.$disconnect()}})()"]
```
- Expect candidate counts to jump well past the pre-sweep `20 confirmed + 1 pending`.
- Spot-check a known lateral chair gets a card: `rharrington` (Robert Harrington, Dean — RePORTER has `HARRINGTON, ROBERT A` with 3 HL grants) should now have a `reporterProfileCandidate` row (probe `where:{cwid:'rharrington'}`). `slr4003` (Reck-Peterson) will **not** — she's already v1-profiled (no candidate), her 5 RePORTER grants already show under Funding.
- Sanity-check `namesakeSkipped > 0` in the run log (the guard is doing something).

## Step 3 — human SSO staging verification (UI follow-ups)

On staging `/edit/scholar/<cwid>?attr=funding` as superuser:
- **#1318:** for a scholar with ≥1 RePORTER grant, the header reads **"Source: InfoEd and NIH RePORTER"**; "Request a change" on a *via NIH RePORTER* row shows the **explain-only** options (no OSRA route). Good test subject: `slr4003` (Reck-Peterson, 4 InfoEd + 5 RePORTER).
- **#1319:** "Is this you?" nests **under Funding** (indented, count badge); each match shows **"View this investigator on NIH RePORTER ↗"**. Needs a scholar with a v2 candidate (post-sweep, e.g. `rharrington`).
- **Activation card walkthrough:** confirm a pending candidate → `person_nih_profile` (`pmid-overlap-confirmed`) + audit insert (no 500) → grants appear next nightly → revoke to restore.

## Step 4 — prod rollout (after staging soak)

Per the activation handoff §Roadmap: apply the audit ENUM to the **prod** audit DB (`MODIFY COLUMN` via the prod `sps-db-bootstrap` task), flip `REPORTER_MATCH_V2=on` in `app-stack.ts` + `etl-stack.ts` for prod, `cdk deploy --exclusively Sps-App-prod` / `Sps-Etl-prod` (prod deploys pause for the `paulalbert1` reviewer gate). Decision §14-A: optionally demote auto-lock to all-`pending` at the first prod flip if precision is unproven. Roll a fresh prod image first (CD), then the flag deploys.

## Landmines (don't relearn)

- **Sweep auto-locks → run only after #1321 is the live etl image.** Capped image roll = guard not applied.
- **`publicationScores=0` is staging-wide noise** — the PMID/eligibility signal is `authorships`, not `publicationScores`. (Robert Harrington: 758 authorships, 0 publicationScores.)
- **Two paths into Funding:** v1 backfill (resolved `person_nih_profile` → grants, no card) vs v2 "Is this you?" (unresolved residual → card). A scholar with grants already showing and no card is the v1 success case, not a bug.
- **Can't read `scholars_audit` from a `sps-etl-staging` run-task** (etl/app_rw both denied SELECT, errno 1142). Verify audit DDL via the `sps-db-bootstrap-staging` task log.
- **Subagents must not merge/push.** Main loop only.
- **No `cdk deploy` for these 3 PRs** — image-roll-only; the flag is already set.

## Pointers
- PRs: #1318, #1319, #1321. Activation handoff: `docs/reporter-grants-v2-activation-handoff.md`. Spec: `docs/reporter-grants-v2-matcher-spec.md`. Verified run-task net config + read-probe pattern: same as the activation handoff.
