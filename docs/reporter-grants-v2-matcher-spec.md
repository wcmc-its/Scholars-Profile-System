# RePORTER grants v2 — PMID-overlap matcher + `/edit` "Is this you?" confirm

**Status:** SPEC, awaiting approval. **Date:** 2026-06-26. **Builds on:** v1 (#1305/#1306/#1307/#1309, all merged + staging-verified — 1584 rows / 654 scholars). **Spec lineage:** `docs/reporter-grants-matcher-spec.md` §5 (matcher), this doc = the productionization.

## 1. Why

v1 only materializes RePORTER grants for scholars **already in `person_nih_profile`** — i.e. people who have a WCM (InfoEd) NIH grant whose core-project resolved a `profile_id`. It does **not** serve the handoff's headline case: a **pure lateral recruit** (dean-from-Stanford) with *no* WCM grant yet, so no `person_nih_profile` row, so zero backfill. v2 resolves those scholars by **name → candidate `profile_id`s → PMID overlap** against the scholar's trusted PubMed set, then materializes the winner's grants through the *identical* v1 dedup/upsert/recency path.

## 2. Scope / non-goals

**In:** the non-`person_nih_profile` active cohort; auto-lock (K≥3) materialization; a K=2 "Is this you?" confirm card in `/edit`; structured reject reason feeding matcher QA. **Behind a flag**, staging-first.

**Out (non-goals):** changing v1's profile-id path; non-NIH grants; surfacing any numeric overlap score to users (projection-starved, per [[project_topic_score_is_internal]] + the COI-gap governance); altering rollup exclusion (RePORTER rows already excluded — unchanged). No org-aware "prior institution" label (separate deferred follow-up).

## 3. Architecture

```
ETL (nightly, flag-gated):
  cohort = active scholars − person_nih_profile         (§4.1)
  per scholar with ≥1 trusted PMID:
    candidates = searchProjectsByPiName(first,last)      (§4.2)
                 → group by profile_id
                 → per candidate: coreNums → fetchPublicationsByCoreNums → grantPmids  (§4.3, NEW)
    result = rankByPmidOverlap(trustedPmids, candidates) (§4.4)
      K≥3 + separation → AUTO-LOCK  → person_nih_profile + ReporterProfileCandidate(status=confirmed, by=system-autolock)
      K=2  + separation → PENDING   → ReporterProfileCandidate(status=pending)   ← surfaces in /edit
      else              → none      (no proposal; recall miss, acceptable)
  → grants for any new person_nih_profile row materialize via the v1 path (same or next run)

/edit "Is this you?" card (flag-gated, genuine-self or superuser):
  PENDING rows → card → Confirm → person_nih_profile + status=confirmed   (grants appear next nightly)
                      → Not me  → status=rejected + reason  (never re-proposed; feeds QA)
  CONFIRMED rows (incl. auto-locks) → "Confirmed matches" history → Revoke → status=revoked + person_nih_profile row removed (grants reconciled out next run)
```

## 4. ETL design (`etl/reporter-grants/index.ts`, v2 branch before the v1 fetch at line ~73)

### 4.1 Cohort
Active scholars (`deletedAt: null, status: "active"`) **minus** any cwid present in `person_nih_profile`. Skip any scholar with **0 trusted PMIDs** (no discriminator possible) and any with an existing terminal `ReporterProfileCandidate` (`rejected`/`revoked`) for every candidate (don't re-propose — see §4.6).

Trusted PMIDs: `publicationAuthor.findMany({ where: { cwid, isConfirmed: true }, select: { pmid: true } })` → `new Set(rows.map(r => Number(r.pmid)))`.

### 4.2 Candidate generation
`searchProjectsByPiName({ firstName, lastName })` → `ReporterProject[]`; group by `profile_id`. Each group = one `Candidate { profileId, fullName, orgs, grantPmids }`. `fullName`/`orgs` from the projects (for the card + `namesMatch()` pre-filter to drop obvious non-matches before the PMID fetch — cheap recall guard, not the decision).

### 4.3 NEW — grant→PMID fetcher (the one build item)
`fetchPublicationsByCoreProjectNums(coreNums: string[]) → { coreproject, pmid, applId }[]` hitting RePORTER `POST /v2/publications/search` (public; the endpoint the v1 spec already probed). Per candidate: collect its `core_project_num`s from §4.2, fetch, union the PMIDs → `Candidate.grantPmids: Set<number>`. Batch core-nums per request; same `sleepBetweenRequests` throttle as the v1 fetcher. (This is the ONLY net-new external call; everything else is wiring.)

### 4.4 Matching
`rankByPmidOverlap(trustedPmids, candidates) → { autoLock, suggestions, ranked }` (existing, tested). Thresholds (existing consts): `K_AUTOLOCK=3`, `K_SUGGEST=2`, `SEPARATION=2` (winner must beat runner-up ≥2×). No tie → no proposal.

### 4.5 Outcomes → writes
- **autoLock ≠ null:** upsert `person_nih_profile` (`resolutionSource="pmid-overlap-auto"`) + upsert `ReporterProfileCandidate` (`status="confirmed"`, `reviewedBy="system-autolock"`, `reviewedAt=now`). Grants flow via v1 path.
- **suggestion (K=2, no autoLock):** upsert `ReporterProfileCandidate` (`status="pending"`). **No `person_nih_profile` write, no grant materialization** until a human confirms.
- **none:** nothing.

### 4.6 Idempotency / re-run
`ReporterProfileCandidate` keyed `@@unique([cwid, externalProfileId])`. Re-run: refresh a still-`pending` row's `lastSeenAt` + summary; **never** resurrect a `rejected`/`revoked` row (skip that `(cwid, profileId)`); never overwrite a human `confirmed` with a system write. Auto-lock is upsert-stable. Verified the same way as v1 (run twice → 0 net-new).

## 5. Data model — `ReporterProfileCandidate`

```prisma
model ReporterProfileCandidate {
  id                String    @id @default(uuid()) @db.VarChar(64)
  cwid              String    @db.VarChar(32)
  scholar           Scholar   @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  externalProfileId Int       @map("external_profile_id")        // NIH eRA profile_id
  candidateName     String    @map("candidate_name") @db.VarChar(255)
  candidateOrgs     String    @map("candidate_orgs") @db.VarChar(512)  // comma-joined, for the card
  grantCount        Int       @map("grant_count")                // # net-new grants riding on this match (card summary)
  overlapK          Int       @map("overlap_k")                  // INTERNAL ONLY — QA/audit, never projected to the card
  sampleGrants      Json      @map("sample_grants")              // [{title, startYear, endYear}] ≤3, for human recognition
  status            String    @default("pending") @db.VarChar(16) // pending | confirmed | rejected | revoked
  reviewedBy        String?   @map("reviewed_by") @db.VarChar(32) // cwid | "system-autolock"
  reviewedAt        DateTime? @map("reviewed_at")
  rejectReason      String?   @map("reject_reason") @db.VarChar(24) // §6.2 enum, null unless rejected
  firstSeenAt       DateTime  @default(now()) @map("first_seen_at")
  lastSeenAt        DateTime  @default(now()) @map("last_seen_at")
  @@unique([cwid, externalProfileId])
  @@index([cwid, status])
}
```

**State machine:** `pending → confirmed | rejected`; `confirmed → revoked`; `rejected`/`revoked` terminal (no re-propose). `confirmed`/`revoked` flip whether a `person_nih_profile` row exists for `(cwid, externalProfileId)`.

## 6. `/edit` "Is this you?" card (reuse COI-gap advisory + core-claim soft-revoke)

### 6.1 Surfacing
Add to `EditContext`: `reporterProfileCandidates: EditContextReporterProfileCandidate[]` (pending) + `reporterProfileConfirmed: EditContextReporterProfileConfirmed[]` (confirmed history). Load in `loadEditContext` **gated on the flag AND genuine-self-or-superuser** (same gate as COI-gap — not visible under "View as"). Register `{ key: "reporter-profile", label: "Is this you?", modes: ["self","superuser"], readonly: false }` in the `ATTRIBUTES` registry; add the `renderPanel` case.

### 6.2 Card UX
Per pending candidate: *"We found NIH grants under **{candidateName}** ({candidateOrgs}) that may be yours: **{sampleGrants…}**. Are these yours?"* → **[Yes, these are mine]** / **[Not me ▾]**. Projection-starved: **no K/score shown** — the human adjudicates from the grant titles, not a number.
- **Purpose line (required):** the card states *why* it's asking — *"Confirming adds these grants to your profile and to your **CV** when you generate one."* This is the primary driver: the [[project_scholar_cv_generator_spec]] CV export (`EDIT_CV_EXPORT`, #1308) and the public profile both read a scholar's complete grant history, which for lateral recruits/older history is incomplete until these RePORTER grants are confirmed. The CV motivation is the reason a scholar should bother answering.
- **Yes** → `confirm` route → materializes (next nightly). Optimistic move to "Confirmed matches".
- **Not me** → reason enum (mechanism-accurate, feeds QA): `not_me` (different person) · `name_only` (shares my name, not me) · `cant_tell`. → `reject`.
- Superuser voice reframes copy ("…may be this scholar's") + a confirm nag before write (COI-gap convention).

### 6.3 Confirmed history
"Confirmed matches" section lists `confirmed` rows (incl. auto-locks, labeled "matched automatically"), each **Revoke**-able → `revoke` route → removes the `person_nih_profile` row → grants reconciled out next run. Mirrors COI-gap's reviewed-history + core-claim's soft-revoke.

## 7. API routes + authz

`POST /api/edit/reporter-profile/[id]/confirm` `{}` · `/reject` `{ reason }` · `/revoke` `{}`. Each via `readEditRequest` (origin guard, live-session re-check). **Authz = genuine-self OR genuine-superuser** (`impersonatedCwid === null && (candidate.cwid === realCwid || session.isSuperuser)`) — impersonating superuser **denied** (identity linkage, IS-1 parity). One `$transaction`: update candidate status/reviewedBy/reviewedAt(/rejectReason) + on confirm upsert `person_nih_profile` / on revoke delete it + append audit row (`action: "reporter_profile_confirm|reject|revoke"`, actor = realCwid). Idempotent: unchanged status → `{ ok: true, unchanged: true }`. `400` (shape/enum/existence) precedes `403`.

## 8. Materialization coupling

Confirm writes **only** `person_nih_profile`; the Grant rows appear on the **next `reporter-grants` ETL run** (v1 path picks up the new profile_id) — same "updates on next nightly" contract as funding search (#481). Card copy states the lag. *(Inline at-confirm materialization is a possible later enhancement; out of scope — keeps RePORTER fetches out of the request path.)*

## 9. Flag + rollout

Single flag `REPORTER_MATCH_V2` (wire in `cdk app-stack.ts` per-env **and** `.env.local`, per [[feedback_flag_parity_local_vs_deployed]]; regenerate the app-stack snapshot per [[feedback_cdk_appstack_snapshot_regen]]). Gates: the ETL v2 branch, the `/edit` card, and context loading. **Rollout lever (open decision §14-A):** whether K≥3 **auto-lock** is live at first prod flip, or initially demoted to `pending` (everything human-confirmed) until prod confidence. Staging-on / prod-off at merge.

## 10. Rollups — unchanged

Materialized rows are `source='RePORTER'` → already excluded by the ~10 `source:{not:"RePORTER"}` aggregation filters (v1, staging-verified). No new aggregation; any future one must filter likewise.

## 11. Edge-case test table

| # | Case | Expected |
|---|------|----------|
| 1 | Scholar 0 trusted PMIDs | skipped, no candidate row |
| 2 | Name search 0 candidates (e.g. `van Besien`) | no proposal (recall miss, logged) |
| 3 | 2 candidates, no 2× separation | no autoLock, no suggestion (ambiguous → skip) |
| 4 | K=2 winner | `pending` row; **no** person_nih_profile, **no** grants |
| 5 | K≥3 winner | auto-lock; person_nih_profile + grants; revocable in history |
| 6 | Confirm pending | person_nih_profile upsert; grants next run; row→confirmed |
| 7 | Reject pending | row→rejected+reason; not re-proposed on re-run |
| 8 | Revoke confirmed | person_nih_profile row deleted; grants reconciled out; row→revoked |
| 9 | Re-run after reject/revoke | `(cwid,profileId)` skipped (terminal) |
| 10 | Scholar already in person_nih_profile (v1) | not in v2 cohort |
| 11 | Impersonating superuser hits confirm | 403 not_self |
| 12 | Soft-deleted scholar | excluded from cohort + card |
| 13 | Same person, 2 profile_ids both K≥3 | both auto-lock (multi-profile_id is valid, like v1 union) |
| 14 | Flag off | ETL v2 branch skipped; card absent; 0 candidate rows |

## 12. Audit SQL

```sql
-- proposal funnel
SELECT status, COUNT(*) FROM reporter_profile_candidate GROUP BY status;
-- auto-lock vs human-confirmed split
SELECT reviewed_by='system-autolock' AS autolocked, COUNT(*)
  FROM reporter_profile_candidate WHERE status='confirmed' GROUP BY autolocked;
-- reject-reason distribution (matcher QA — high not_me ⇒ precision issue)
SELECT reject_reason, COUNT(*) FROM reporter_profile_candidate WHERE status='rejected' GROUP BY reject_reason;
-- pending backlog awaiting scholars
SELECT cwid, candidate_name, grant_count, overlap_k, first_seen_at
  FROM reporter_profile_candidate WHERE status='pending' ORDER BY first_seen_at;
-- grants that rode in via a v2 (pmid-overlap) profile_id
SELECT g.cwid, COUNT(*) FROM grant g
  JOIN person_nih_profile p ON p.cwid=g.cwid
  WHERE g.source='RePORTER' AND p.resolution_source LIKE 'pmid-overlap%'
  GROUP BY g.cwid;
```

## 13. Phasing (stacked PRs)

- **PR-1 (ETL + model):** `ReporterProfileCandidate` migration; `fetchPublicationsByCoreProjectNums`; v2 branch (cohort, candidate gen, match, auto-lock + pending writes); idempotency. Unit-tested; flag-gated. Staging live-verify like v1.
- **PR-2 (`/edit` UI):** edit-context fields + loader gate; `reporter-profile-card.tsx`; confirm/reject/revoke routes + authz + audit; renderPanel + ATTRIBUTES wiring. Tests for authz matrix + state transitions.

## 14. Decisions (RESOLVED 2026-06-26)

- **A. Auto-lock — ON.** K≥3 auto-locks, but **always recorded as a revocable `confirmed` row** (`reviewedBy="system-autolock"`), with the §9 rollout lever to demote to all-`pending` if prod ever surfaces a wrong lock.
- **B. Reject reason — enum only.** `not_me` / `name_only` / `cant_tell`. **No free-text "why"** (no `note` field) for now.
- **C. Confirmed history — show auto-locks** (labeled "matched automatically"), self-revocable.
```
