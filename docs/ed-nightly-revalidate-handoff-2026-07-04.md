# ED nightly unblock + Revalidate fixes — handoff

**Date:** 2026-07-04 (~05:35 UTC) · **Env:** staging (prod fully gated #475)
**Parent:** `docs/ed-appointment-collision-fix-handoff.md`, memory `project_etl_reliability_audit`

## TL;DR

The staging nightly (`scholars-nightly-staging`) had been failing every night since ~06-24. Root cause was **four masked layers**, each fix unmasking the next. All code fixes are **merged to master** (3 PRs) and the ED blocker is **validated end-to-end** (post-fix nightly ran clean through every spine step). One backlog was flushed operationally.

⚠️ **Current staging state is REVERTED** by an unrelated `feat/usage-dashboard` branch→staging deploy (see "State as of this handoff"). The ED fixes survived it; the Revalidate fixes did not.

## The four layers (all diagnosed via read-only in-VPC ECS probes: `run-task` on `sps-etl-staging`, LDAP + Aurora + step-fn traces)

| # | Problem | Fix | Status |
|---|---|---|---|
| 1 | **#1448 P2002** — `refreshEdAppointments` per-cwid reconcile vs global-unique `external_id` | already merged `641b0143` | ✅ validated (ED cleared appointments, no crash) |
| 2 | **ED removed top-level `ou=students`** → `fetchDoctoralStudents` got 0 students → soft-delete guard tripped | **PR #1456 `b85280a9`** — repoint `DEFAULT_STUDENT_SEARCH_BASE` → `ou=students,ou=sors` + filter `(&(objectClass=weillCornellEduSORRecord)(weillCornellEduDegreeCode=PHD))` | ✅ shipped + validated ("ED returned 690 doctoral students") |
| 3 | **377-scholar soft-delete guard trip** = genuine faculty-appointment-expiration BACKLOG (accumulated while nightly failed) | one-time `ETL_GUARD_BYPASS=ed:scholar-soft-delete` run (`soft-deleted=377, updated=9402`) | ✅ flushed; post-flush nightly ran CLEAN through all spine steps |
| 4 | **Revalidate enricher hung 4h ×2 retries** (2 bugs) | **PR #1473 `c358bf35`** — (a) disconnect `db.write` (only step that leaked it); (b) allowlist the CDK-auto-named internal ALB `internal-Sps-Ap-Inter-*`; (c) 15s per-request AbortController | ✅ merged; validated pre-revert (exit ~76s, 0 skips) |
| 4b | **Topic-page 400s** — `/topics/{id}` uses underscores, path allowlist `SLUG_RE_SOURCE` is hyphen-only (surfaced once 4 re-enabled the POSTs) | **PR #1474 `b006423d`** — `TOPIC_SLUG_RE_SOURCE` (allows `_`), applied only to `/topics/` | ✅ merged; logic-verified + CI-green; **runtime unvalidated** (see below) |

### How #2 was diagnosed (for reference)
Live LDAP probe: directory root now exposes only `ou=People` + `ou=Groups`; `ou=students,dc=…` → `noSuchObject`. The 690 PhD **person** records moved to `ou=students,ou=sors` as `weillCornellEduSORRecord` entries (dept via `weillCornellEduOrgUnitCode;level1`, name via `givenName`+`sn`). Count split: 690 person + 1992 nested `SORRoleRecord` = 2682 (why the objectClass pin matters). `projectEntries` already maps everything — no logic change needed.

### How #3 was diagnosed
Reproduced `departed=377` exactly (read-only fetch+DB diff). Broad role mix (affiliated 154, full-time 79, non-faculty-academic 74, fellow 43, postdoc 26, instructor 1), **0 students**, all created 2026-05/updated 2026-06. LDAP spot-check 12/12 → all `faculty:expired`, none active-academic → genuine offboarding, safe to prune.

## State as of this handoff ⚠️

**Staging (app AND ETL images) is on `b854b2ca` = `feat/usage-dashboard`**, deployed ~23:05–23:07 EDT via `gh workflow run deploy.yml --ref feat/usage-dashboard -f env=staging`. That branch last merged master **18:32 EDT**, so:

- ✅ **Includes** #1448 + #1456 (ED fixes merged before 18:32)
- ❌ **Missing** #1473 + #1474 (revalidate fixes merged after 18:32)

**Empirically confirmed:** a standalone `etl:revalidate` run just now (on the reverted image) **skipped all revalidations and hung** (pre-#1473 behavior) — I stopped it.

**Implication for the 07:00 UTC 07-04 nightly** (runs on `scholars-etl-staging:latest` = `b854b2ca`):
- **Ed + all spine steps: OK** (ED fixes present) — no ou=students / P2002 / 377-backlog regression (backlog already flushed in the DB).
- **Revalidate: will hang again** (4h ×2 retries). It's an **enricher** (tier=continue) → after retries it warns + continues to Integrity, so the nightly **won't fail**, just drags ~12h; ISR relies on its 6h TTL for one night. **Non-fatal.**

**Nothing was clobbered.** The `feat/usage-dashboard` deploy is someone else's active work; I did not redeploy or re-tag staging images.

## Key learning
`gh workflow run deploy.yml --ref <branch> -f env=staging` rebuilds **both** `scholars-app-staging:latest` **and** `scholars-etl-staging:latest` from that branch — it silently reverts any master-only ETL fixes on staging, not just the app. (Prior memory framed branch→staging as "rolls IMAGE only" re the app; note it hits the ETL image too.)

## Open follow-ups (none blocking)

1. **Realign staging to master.** Options: (a) let `feat/usage-dashboard` merge current master (past #1474) + redeploy — cleanest; (b) `gh workflow run deploy.yml --ref master -f env=staging` to force master onto staging now — **reverts their feature deploy**, coordinate first. Until then #1473/#1474 aren't on staging.
2. **Runtime-validate #1474** once staging app is back on master: run standalone `etl:revalidate`, expect **0** `/topics/… -> 400` (route logs failures only; silent = 200) and fast exit. Overrides file: `scratchpad/overrides_reval.json` (`npm run etl:revalidate`).
3. **#10-infra (cleaner ALB fix):** restore a stable custom `loadBalancerName sps-internal-{env}` on the app internal ALB in the CDK app-stack (ALB replacement) instead of the allowlist band-aid shipped in #1473. Investigate why the cutover app-stack lost the custom name.
4. **ED heads-up:** confirm with the enterprise-directory owner that top-level `ou=students` removal was intended (the SOR repoint is correct regardless; flag if accidental). Not yet drafted.

## Resolution (2026-07-04 ~18:00 UTC) — all four follow-ups closed

1. **Staging realigned to master.** `feat/usage-dashboard` merged (#1472/#1477), so redeploying master reverted nothing. Deploy run [28714271817](https://github.com/wcmc-its/Scholars-Profile-System/actions/runs/28714271817) green; both `scholars-app-staging:latest` and `scholars-etl-staging:latest` = `b0d446f2` = origin/master (ancestor-checked for #1473 + #1474); `sps-app-staging` stable on task-def :113.
2. **#1474 runtime-VALIDATED** (and #1473 reconfirmed): standalone `etl:revalidate` on the new image — exit 0, **13s** container runtime (vs 4h pre-fix hang), **0** `-> 400` lines, 0 skips, all 103 paths (68 topics + 31 depts + / + /browse + /sitemap.xml) 2xx. Pre-fix stream same day had 67 `/topics/*_*` 400s — clean before/after.
3. **ALB cleaner fix → issue #1478.** Root cause found: name loss was deliberate (`sharedReplaceName` G15 in app-stack.ts returns undefined `loadBalancerName` under `useSharedVpc` for create-before-delete); issue also captures the pre-#1473 regex missing the `internal-` DNS prefix, and the SSM/`SCHOLARS_BASE_URL` repoint sequencing (Sps-Etl redeploy after App).
4. **ED heads-up drafted** (in that day's session output) — awaiting user send; no named ED owner found, route via WCM Identity/IAM team.

Also: the 07-04 nightly SUCCEEDED (07:00→16:26 UTC, ~9.5h — dragged by the predicted pre-fix Revalidate hang, per-step continue absorbed it). Next nightly runs fully fixed.

## Verify / commands

```bash
# staging ETL image commit (is it back on master?)
aws ecr describe-images --repository-name scholars-etl-staging --image-ids imageTag=latest \
  --query 'imageDetails[0].imageTags' --output json
# is a given fix in the deployed image X? (X = the non-'latest' tag above)
git merge-base --is-ancestor b006423d <X> && echo "has #1474" || echo "missing #1474"

# rerun just the ED step (validates ED end-to-end)
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:665083158573:stateMachine:scholars-nightly-staging \
  --name "check-$(date -u +%Y%m%dT%H%M%SZ)" --input '{"startFrom":"Ed"}'

# read ETL logs
#   log group /aws/ecs/sps-etl-staging, stream etl/etl/<taskId>
```

## PRs
- #1456 `b85280a9` — ED doctoral students from `ou=students,ou=sors`
- #1473 `c358bf35` — Revalidate: disconnect `db.write` + allowlist internal ALB + request timeout
- #1474 `b006423d` — Revalidate: allow underscore topic ids in path allowlist
