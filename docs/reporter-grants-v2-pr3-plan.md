# PR-3 plan — `/edit` "Is this you?" reporter-profile card (RePORTER grants v2)

**Status:** PLAN, awaiting approval. **Date:** 2026-06-26. **Spec:** `docs/reporter-grants-v2-matcher-spec.md` §6/§7 (approved). **Builds on:** PR-1 `#1312` (ETL + model) + PR #1313 (flag/guard, merged + staging-verified — 20 auto-locks, 1 live `pending` candidate `jos2087` waiting on this UI).

> Naming note: the spec calls this "PR-2". Since the flag/guard shipped as its own PR #1313, this is **PR-3**.

## Goal

Surface the v2 matcher's `pending` (K=2) candidates as an "Is this you?" confirm card in `/edit`, and the `confirmed` rows (incl. auto-locks) as a revocable history. Confirm → writes `person_nih_profile` (grants materialize next nightly). Reject → terminal + reason (feeds QA). Revoke → deletes the profile row (grants reconcile out next run). **Projection-starved**: the human adjudicates from grant titles; the numeric overlap K is never sent to the client.

## What it reuses (grounded on origin/master)

| Concern | Template | Location |
|---|---|---|
| Advisory card + optimistic state + parallel POSTs | `CoiGapCard` | `components/edit/coi-gap-card.tsx` |
| Route guard / identity | `readEditRequest` → `{session, realCwid, impersonatedCwid, requestId, body}` | `lib/edit/request.ts` |
| Authz (genuine-self OR genuine-superuser, impersonation denied) | inline idiom (no shared helper) | `app/api/edit/coi-gap/[id]/feedback/route.ts:59` |
| Soft-revoke + profile-row delete | core-claim revoke + `PersonNihProfile` delete | `app/api/edit/core-claim/route.ts` |
| Feature-flag helper + route gate | `isCvEnabled()` / flag-first `editError(404)` | `lib/edit/cv-export.ts` |
| Flag env injection + snapshot | `EDIT_CV_EXPORT: env==="staging"?"on":"off"` | `cdk/lib/app-stack.ts` (~L1020) |
| Audit append | `appendAuditRow(tx, AuditRow)` | `lib/edit/audit.ts:225` |
| EditContext fields + loader gate | `unmatchedPubmedCoi*` + `includeCoiGap` | `lib/api/edit-context.ts:407,525` |
| ATTRIBUTES + renderPanel | `coi-gap` entry/case | `components/edit/edit-page.tsx:156,988` |

## File-by-file

### A. Flag (app side) — net-new (ETL side already shipped in #1313)
1. **`lib/edit/reporter-match.ts`** (new) — `export function isReporterMatchV2Enabled(){ return process.env.REPORTER_MATCH_V2 === "on"; }` (mirror `cv-export.ts`).
2. **`cdk/lib/app-stack.ts`** — add to the App task `environment:` block (~L1020): `REPORTER_MATCH_V2: env === "staging" ? "on" : "off"` (staging-first; mirrors EDIT_CV_EXPORT).
3. **app-stack snapshot** — `cd cdk && npm ci && npm test -- -u`, commit only the `.snap` ([[feedback_cdk_appstack_snapshot_regen]]). NOTE: this is the **app-stack** snapshot (etl-stack was #1313).
4. **`.env.local`** — add `REPORTER_MATCH_V2=on` (local-only, parity per [[feedback_flag_parity_local_vs_deployed]]).

### B. EditContext + loader (`lib/api/edit-context.ts`)
5. Element types (above `EditContext`, ~L407): `EditContextReporterProfileCandidate` = `{ candidateId, externalProfileId, candidateName, candidateOrgs, grantCount, sampleGrants: {title,startYear,endYear}[], firstSeenAt }` — **no `overlapK`**. `EditContextReporterProfileConfirmed` = same minus firstSeen + `{ reviewedAt, autolocked: boolean }`.
6. Two readonly fields on `EditContext`: `reporterProfileCandidates` (pending) + `reporterProfileConfirmed` (history).
7. In `loadEditContext`, new opt `includeReporterProfile`: one `reporterProfileCandidate.findMany({ where:{ cwid, status:{ in:["pending","confirmed"] } }, select:{ /* all card-safe fields, NOT overlapK */ } })`; partition pending→candidates, confirmed→confirmed (`autolocked = reviewedBy === "system-autolock"`).

### C. Page gating
8. **`app/edit/page.tsx`** (self): `const includeReporterProfile = isReporterMatchV2Enabled() && genuineSelf;` → pass into `loadEditContext` opts.
9. **`app/edit/scholar/[cwid]/page.tsx`** (superuser): `isReporterMatchV2Enabled() && (isSelf || session.isSuperuser)`.

### D. UI (`components/edit/`)
10. **`edit-page.tsx`** — ATTRIBUTES entry `{ key:"reporter-profile", label:"Is this you?", readonly:true, modes:["self","superuser"] }`; renderPanel `case "reporter-profile":` → `<ReporterProfileCard cwid mode={voiceMode} scholarName candidates={ctx.reporterProfileCandidates} confirmed={ctx.reporterProfileConfirmed}/>`; import. Rail item auto-drops when both arrays empty (mirror coi-gap).
11. **`reporter-profile-card.tsx`** (new) — wrapped in `EditPanel`. Per pending: *"We found NIH grants under **{candidateName}** ({candidateOrgs}) that may be yours: {sampleGrants…}. Are these yours?"* + **required CV purpose line** (§6.2). Actions: **[Yes, these are mine]** → `confirm`; **[Not me ▾]** → reason enum `not_me`/`name_only`/`cant_tell` → `reject`. Confirmed-history section ("matched automatically" when autolocked) → **Revoke**. Optimistic Map/Set + parallel POSTs + rollback; superuser confirm-nag; **no K/score rendered**.

### E. Routes (`app/api/edit/reporter-profile/[id]/…`) — all: `readEditRequest` → flag-first `editError(404)` → load candidate by id (404) → authz `impersonatedCwid===null && (candidate.cwid===realCwid || session.isSuperuser)` else `logEditDenial`+`editError(403,"not_self")` → idempotency short-circuit → one `$transaction` (mutation + audit) → `editOk`.
12. **`confirm/route.ts`** — body `{}`; tx: candidate `{status:"confirmed", reviewedBy:realCwid, reviewedAt:now}` + `personNihProfile.upsert({ where:{ cwid_nihProfileId:{ cwid, nihProfileId:externalProfileId } }, create:{…, source:"RePORTER", resolutionSource:"pmid-overlap-confirmed" }, update:{ resolutionSource:"pmid-overlap-confirmed", lastVerified:now } })` + audit `reporter_profile_confirm`. Idempotent if already `confirmed`.
13. **`reject/route.ts`** — body `{ reason }` validated against the enum; tx: candidate `{status:"rejected", rejectReason:reason, reviewedBy, reviewedAt}` + audit `reporter_profile_reject`. No profile write.
14. **`revoke/route.ts`** — body `{}`; only valid from `confirmed`; tx: candidate `{status:"revoked", reviewedBy, reviewedAt}` + `personNihProfile.deleteMany({ where:{ cwid, nihProfileId:externalProfileId } })` (deleteMany = idempotent, no P2025) + audit `reporter_profile_revoke`. Grants reconcile out next nightly.
15. **`lib/edit/reporter-profile.ts`** (new) — reject-reason enum `["not_me","name_only","cant_tell"]` + `isRejectReason()` guard + shared candidate-load helper (mirror `lib/coi-gap/feedback.ts`).

### F. Audit types
16. **`lib/edit/audit.ts`** — add to `AuditAction`: `reporter_profile_confirm | reporter_profile_reject | reporter_profile_revoke`; add to `AuditEntityType`: `reporter_profile_candidate`.

### G. Tests
17. **`tests/unit/reporter-profile-route.test.ts`** (new) — authz matrix (genuine-self ✓, genuine-superuser ✓, **impersonating-superuser 403**, flag-off 404, not-found 404, bad-id 400); transitions (confirm: pending→confirmed + profile upsert; reject: →rejected+reason; revoke: confirmed→revoked + profile deleted; idempotent `unchanged:true`); reject-enum validation (spec §11 rows 4–9, 11).
18. **`tests/unit/reporter-profile-card.test.tsx`** (new) — pending vs confirmed sections render; reason dropdown options; **projection-starving assertion** (overlap K never in the DOM); auto-lock labeled "matched automatically".

## Open decisions (need your call before build)

1. **`readonly` flag.** Spec §6.1 says `readonly:false`, but the COI-gap precedent (advisory card *with* action buttons) registers `readonly:true` — the flag means "not a profile-field editor," and the card carries its own buttons regardless. **Recommend `readonly:true`** to match coi-gap. (Cosmetic; affects the rail chrome only.)
2. **Route flag-gate response.** CV uses flag-first `404`; coi-gap uses `503` after authz. **Recommend flag-first `404`** (more opaque, simpler) — a dark feature reveals nothing.
3. **`resolutionSource` for human confirm.** **Recommend `"pmid-overlap-confirmed"`** (vs auto-lock's `"pmid-overlap-auto"`) so the §12 audit SQL `LIKE 'pmid-overlap%'` still catches both, but human-confirmed vs auto-locked stays distinguishable.

## Out of scope (unchanged)

No new migration (`ReporterProfileCandidate` + `PersonNihProfile` already exist). No inline at-confirm materialization (next-nightly contract, spec §8). No org-label. No prod flag flip (after staging soak).

## Build & verify (after approval)

- Worktree off **fresh `origin/master`** outside Dropbox; symlink `node_modules`/`cdk/node_modules`, copy `.env*`, **`npx prisma generate`** (canonical's client is 327-behind — no new migration, but the master client is needed; never generate through a symlinked `lib/generated`).
- Implement per above; gates via a verification **workflow**: full `tsc` · `vitest` (route + card suites) · **`next lint`** (raw `<a>` bit #1309) · cdk **app-stack** snapshot test · adversarial review (authz matrix, projection-starving, idempotency, transaction atomicity).
- After `gh pr update-branch`: re-run **full `tsc`** (master-merged fixtures, [[project_reporter_grants_backfill]] CI lesson). PR → master, review only (no merge). Subagents must not merge/push.

## Risk notes

- **Authz matrix** is the security-critical surface — the impersonating-superuser-denied (IS-1) case gets an explicit test.
- **Projection-starving** — `overlapK` must be excluded at the `select`/type level (server) *and* asserted absent in the card test (client).
- **Snapshot** is **app-stack** this time (not etl-stack) — different `.snap`.
