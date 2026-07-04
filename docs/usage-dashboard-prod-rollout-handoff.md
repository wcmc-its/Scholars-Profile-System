# Usage dashboard — prod rollout handoff

**Status (2026-07-04):** `/edit/usage` in-app Usage dashboard is **MERGED** (PR #1472, `281a5691`) and **fully live + verified on STAGING** (both cdk stacks deployed, `daily_usage` backfilled). **PROD is not yet rolled out.** This doc is the turnkey release plan for a focused prod session.

## What the feature is

`/edit/usage` — a viewer-friendly, in-app view of the CloudFront usage aggregates (previously Athena-console only). Pageviews-by-day (SVG bar graph), top profiles (linked to the live page), search terms, referrers, geo, device — last 30 days, read live from the `daily_usage` Athena rollup and cached ~daily. Audience: a **superuser OR any unit admin (owner/curator)**, global (site-wide) view. Aggregates only — no PII; the per-URL `sps-perf-*` performance queries stay Athena/operator-only. See `docs/OPERATIONS-RUNBOOK.md` §3.

## Rollup bug fixed in the same PR (affects prod data too)

Profiles are served at a **root vanity slug** (`app/(public)/[slug]`, e.g. `/carl-f-nathan`), **not** `/scholar/<cwid>`. The old rollup counted the nonexistent `/scholar/<cwid>` path, so the `pageviews` and `profile` metrics summed to **0**. Fixed in `cdk/lambda/cf-usage-rollup/queries.ts`: a profile pageview is now a single-segment, dot-free root path minus a reserved-route list (`about, browse, centers, cores, departments, methods, scholars, search, topics, api, edit, healthz, og, readiness, sitemap`). The `profile` dimension is the slug.

**This fix affects every usage consumer** (the saved Athena queries too), so **prod's `daily_usage` is currently wrong (pageviews = 0)** until prod's rollup Lambda is redeployed + backfilled — independent of the dashboard.

## Why this is a deliberate release (not a dashboard side-effect)

The dashboard *code* ships in the app **image**. A prod image deploy releases **all** app changes merged since prod's last release — many unrelated features — and is **#475 reviewer-gated** (paulalbert1 approval). That is a release decision, so cut it deliberately with fresh attention.

## Rollout chain (order is locked by a cross-stack dependency)

Deploy cdk from a fresh `origin/master` worktree (never a feature branch):
```
git worktree add --detach ~/worktrees/sps-prod-release origin/master
cd ~/worktrees/sps-prod-release/cdk && npm ci
```
Prod write-cred is in the shell env. **Diff before every step.**

1. **`cdk deploy --exclusively Sps-App-prod -c env=prod`**
   Adds `SPS_USAGE_WORKGROUP` / `SPS_USAGE_DATABASE` / `SPS_USAGE_REGION` env vars + a `TaskRole` CFN export; rolls the ECS service (zero-downtime).
   **Diff VERIFIED CLEAN 2026-07-04** — no IAM changes, no resource changes beyond the task-def revision. It also reconciles 3 drift flags that are **fully retired** (0 active `process.env` reads: `ACCOUNT_CONSOLE_NAV_RESTRUCTURE`, `OVERVIEW_FAITHFULNESS_PASS`, `SEARCH_PEOPLE_MATCH_PROVENANCE`) and sets `SEARCH_PEOPLE_PHRASE_BOOST=off` (its prod value). No behavior change. **Re-run the diff at release time** in case master moved.

2. **`cdk deploy --exclusively Sps-Analytics-prod -c env=prod`**
   The workgroup-scoped Athena/Glue/S3 grant on the app task role (**imports the App export → must follow step 1**) + the **fixed rollup Lambda**. Least privilege: `daily_usage` table only, rollup + athena-results S3 prefixes only, never the raw `cf_access_logs` / `cf/` logs.

3. **Backfill prod `daily_usage`** (repopulate with the fixed profile logic):
   ```
   aws lambda invoke --function-name sps-cf-usage-rollup-prod \
     --payload '{"backfillFrom":"<today-30>","backfillTo":"<yesterday>"}' \
     --cli-binary-format raw-in-base64-out --cli-read-timeout 600 out.json
   ```
   Verify: `SELECT metric, SUM(cnt) FROM daily_usage WHERE metric IN ('pageviews','profile') GROUP BY 1` in workgroup `sps-usage-prod` → totals **> 0**.

4. **Prod app image** — deploy master's image to prod (the `/edit/usage` page). **#475-gated**; approve in GitHub. This is the full-app release.

## Verification (after step 4)

- `curl -4 -sI https://scholars.weill.cornell.edu/edit/usage` → `302` (SAML), health `200`.
- Sign in as a superuser → `/edit/usage` shows the bar graph with real bars, top profiles linked, all six metrics populated (not "unavailable").
- The **Usage** tab appears in the admin sub-nav.

## Rollback

- Steps 1–2 are additive/inert to the *current* prod image (env vars unread, grant unused) — low risk; revert by redeploying the prior stack if needed.
- Step 4 (image) rolls back via the standard app rollback (`docs/rollback-runbook.md`).
- The backfill is idempotent (delete-then-insert per day); re-running is safe.

## References

- Runbook: `docs/OPERATIONS-RUNBOOK.md` §3 (Usage & performance analytics)
- Prod App deploy hazards: `docs/prod-etl-tier1-runbook.md`, ADR-008
- Feature PR: #1472
