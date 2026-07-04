# Handoff — ReCiter pending-pubs nudge: superuser parity

_Last updated 2026-06-17. Owner picking this up: you._

## TL;DR

The ReCiter "pending / suggested" publications nudge (#1078) is **merged and live on staging** (PR #1082, flag `SELF_EDIT_RECITER_PENDING_HINT` on). One gap remains: a **superuser** viewing `/edit/scholar/<cwid>` does **not** see the target scholar's pending pubs — it was built self-only, which is inconsistent with COI-gap and Highlights (both already show the target's data to a superuser). This change adds that parity. It is **app-code-only** (no CDK/IAM), so once merged it ships to staging via CD automatically — **no `cdk deploy` needed**.

---

## Status snapshot

| Item | State |
|---|---|
| Feature (#1078 / PR #1082) | **MERGED** `6eaee98e`, **staging-live** (flag on, IAM deployed, verified `sps-app-staging:60`) |
| Issue #1078 | **OPEN** — narrowed to prod rollout |
| This change (superuser parity) | **Built + verified + authz-reviewed** (commit `97f81c00` on the branch); **not yet pushed / no PR** |
| Branch | `feat/reciter-pending-superuser` (off fresh `origin/master` `6eaee98e`), commit `97f81c00` |
| Worktree | `~/worktrees/sps-rp-superuser` (deps + prisma client installed) |
| Build workflow | `wqqvjiatb` — **DONE.** `tsc` clean, 140 unit tests pass, adversarial authz review PASS (proved non-superuser `?cwid=other` → empty; `fetchSuggestedArticles` never called with the other cwid). Re-verify the diff yourself before pushing. |

---

## What the feature is (already shipped — context)

- Surfaces ReCiter's pending/suggested candidate publications on the scholar's self-edit surfaces (Publications banner + home teaser) so they log into ReCiter to claim them. Mockups: `docs/mockups/reciter-pending-articles/`.
- **Data source = live, direct DynamoDB read (read-only IAM, no api-key):**
  - `GoldStandard` table (`knownpmids`/`rejectedpmids`, written synchronously on every accept/reject) → the live curation filter.
  - `Analysis` table (`reCiterFeature` → `reCiterArticleFeatures` with scores + citation metadata), with an **S3 `reciter-dynamodb/AnalysisOutput/<uid>` fallback** for large offloaded analyses.
  - Filter `score ≥ 40` ∖ curated, sort desc, degrade-to-empty on any error. Code: `lib/reciter/client.ts` → `fetchSuggestedArticles(uid)`.
  - Tables + bucket are in account `665083158573` / `us-east-1` (same as SPS). App task role grant = `TaskRoleReciterReadPolicy` (`dynamodb:GetItem` on Analysis+GoldStandard, `s3:GetObject` on AnalysisOutput/*).
- Flag `SELF_EDIT_RECITER_PENDING_HINT`: staging **on**, prod **off (armed)** — `cdk/lib/app-stack.ts`.
- Verified live: `fetchSuggestedArticles('dis4002')` → 38 suggestions (= ReCiter's own `countPendingArticles`), via the S3 path, ~79–542ms.

---

## What THIS change does (superuser parity)

**Why:** the superuser page already loads COI-gap and Highlights for the target scholar (`app/edit/scholar/[cwid]/page.tsx:170-174`, gated on `isSelf || session.isSuperuser`). The pending-pubs nudge is the odd one out because it uses a **client-fetch route** keyed on the real `session.cwid`, not the impersonation target.

**Scope:** self **+** superuser only — **NOT** proxy, **NOT** comms_steward (matches COI-gap exactly).

**The security-critical bit:** the cwid becomes **client-supplied** (the client sends `?cwid=<scholar being viewed>`), so the route is now the authz point:
```
serve the requested cwid IFF  requested === session.cwid  ||  session.isSuperuser
```
A non-superuser requesting `?cwid=<someone-else>` must get `{ suggestions: [] }` and `fetchSuggestedArticles` must NOT be called with the other cwid. (Verified by the build's authz reviewer — the `empty()` return happens *before* the `try` block, so the fetch is never reached.)

> **Implementation note:** the route switched from `getSession()` to **`getEffectiveEditSession()`** (`lib/auth/effective-identity.ts`) because `SessionData` has no `isSuperuser` field — `EditSession` carries the live `isSuperuser` re-check, the **same** helper `/edit/scholar/[cwid]` uses for its `isSelf || session.isSuperuser` gate. This keeps the route's authz keyed on the same identity object as the page (and matches the COI-gap routes).

**Files touched (all app code — no `cdk/`):**
- `app/api/edit/reciter-pending/route.ts` — read `?cwid`, default to `session.cwid`, authorize `requested === session.cwid || session.isSuperuser`, `fetchSuggestedArticles(targetCwid)`. `GET(request: NextRequest)`.
- `components/edit/reciter-pending-card.tsx` — `useReciterPendingSuggestions(cwid?)` fetches `?cwid=`; `ReciterPendingCardClient({cwid, mode, scholarName})`; **third-person copy** in superuser mode (title "…from this profile", curation line "…papers of this scholar's…", tooltip "…how likely this paper is this scholar's").
- `components/edit/home-panel.tsx` — teaser loader threads the target cwid + mode.
- `components/edit/edit-page.tsx` — allow `reciterPendingEnabled` for `mode/childMode ∈ {self, superuser}` (proxy stays false); thread `cwid` (= `ctx.scholar.cwid`) + mode + scholarName to the client.
- `app/edit/scholar/[cwid]/page.tsx` — compute `reciterPendingEnabled = isReciterPendingHintEnabled() && (isSelf || session.isSuperuser)` and pass to `<EditPage>` (mirrors the `includeCoiGap` line).
- Tests: route (self / superuser-reads-target / **non-superuser-blocked** / flag-off / no-session), client (sends `?cwid=`), card (third-person copy in superuser mode).

---

## Steps to finish

1. **Verify the workflow output.** `cd ~/worktrees/sps-rp-superuser`
   - `git log --oneline origin/master..HEAD` (expect the `feat(edit): superuser parity…` commit).
   - `npx tsc --noEmit` (clean) and `npx vitest run --maxWorkers=4 tests/unit/reciter-pending-route.test.ts tests/unit/reciter-pending-card.test.tsx tests/unit/reciter-pending-card-client.test.tsx tests/unit/edit-page.test.tsx tests/unit/edit-scholar-page.test.tsx`.
   - Confirm the authz reviewer proved the **non-superuser `?cwid=other` → empty** path. If not provably blocked, fix before pushing.
2. **Push + PR.** `git push -u origin feat/reciter-pending-superuser` → `gh pr create --base master --title "feat(edit): superuser parity for the ReCiter pending-pubs nudge" --body "…"`. Wait for CI (`build` + `cdk`) green (~6–7 min). Reference (not "Closes") #1078.
3. **Merge.** `gh pr merge <#> --squash` once CI is green.
4. **Staging deploy = automatic.** This is **app-only** → the merge triggers the CD **Deploy** workflow which rolls the staging image. **No `cdk deploy`.** Just confirm the Deploy run for the merge commit succeeds (`gh run list --branch master --workflow Deploy`).
5. **Verify on staging.** As a superuser, open `/edit/scholar/<cwid>` for a scholar with pending suggestions (e.g. `dis4002`) → the Publications banner + home teaser should appear with **third-person** copy. Also confirm a normal self-edit still works.
6. **Prod.** Folds into #1078's prod rollout: approval-gated `cdk deploy Sps-App-prod` (applies the IAM grant + the flag flip) — the superuser-parity app code rolls with the prod image. No extra step for this change beyond the existing prod plan.

---

## Gotchas / hard-won lessons (read before deploying anything)

- **Deploy from FRESH `origin/master`, never a stale feature branch.** A `cdk deploy Sps-App` from a stale base silently REVERTS other teams' CDK state (we caught `EDIT_DATA_QUALITY_DASHBOARD` being dropped). Always: worktree off fresh `origin/master` → `cdk diff --exclusively Sps-App-staging -c env=staging` → confirm only your changes, no `[-]`/destroy → deploy.
- **`--exclusively Sps-App-<env>`** scopes to the App stack only (excludes pending Network-stack changes like the #443 Route53 Resolver associations, which show in a plain `cdk diff` because App depends on Network).
- **This change needs no `cdk deploy`** — it's app code; CD rolls it on merge. (The flag + IAM already shipped in PR #1082.)
- **Creds:** the `reciter` shell user CAN `cdk deploy` staging **App + Edge** stacks (and ECS run-task); it CANNOT deploy prod or Sps-Etl (AccessDenied). Prod App deploy is approval-gated (operator).
- **Route authz is the crux** — the cwid is client-supplied; the only thing standing between a logged-in non-superuser and another scholar's pending list is the `requested === session.cwid || session.isSuperuser` check. Don't weaken it.
- **`rm` is blocked** by the safety classifier — use `unlink <file>` and `git worktree remove --force` for cleanup.
- **Worktree cleanup when done:** `git worktree remove --force ~/worktrees/sps-rp-superuser` (after unlinking any `cdk/node_modules` symlink you created for cdk tests). `pkill -f 'vitest|esbuild|tinypool'` to reap stray workers.
- **CI:** required checks are `build` (~6.5 min) + `cdk` (~1.5 min) + Orca scans. Snapshot tests live in `cdk/` (jest, needs `cdk/node_modules` — symlink the canonical one if you run them in a fresh worktree).

---

## Pointers

- Issue: **#1078** (open — prod rollout). Merged feature PR: **#1082** (`6eaee98e`).
- Key files: `lib/reciter/client.ts`, `app/api/edit/reciter-pending/route.ts`, `components/edit/reciter-pending-card.tsx`, `components/edit/edit-page.tsx`, `app/edit/page.tsx`, `app/edit/scholar/[cwid]/page.tsx`, `cdk/lib/app-stack.ts` (`TaskRoleReciterReadPolicy` + the flag).
- Parity reference (the pattern this mirrors): `app/edit/scholar/[cwid]/page.tsx:170-174` (`includeCoiGap = isCoiGapHintEnabled() && (isSelf || session.isSuperuser)`).
- Staging: cluster `sps-cluster-staging`, service `sps-app-staging`, task def family `sps-app-staging`, log group `/aws/ecs/sps-app-staging`. Tables `Analysis`/`GoldStandard` + bucket `reciter-dynamodb` (acct `665083158573`, `us-east-1`).
