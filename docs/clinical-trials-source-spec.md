# Clinical Trials — New Data Source Spec

Status: **APPROVED — implemented (this PR)**
Author: Paul Albert
Date: 2026-06-18

> As-built note: all four §9 open decisions were resolved to their proposed
> defaults — show Active + Completed and hide Withdrawn (no hard year cut);
> name-match role heuristic (PI vs Investigator); section placed after Funding;
> search/facets deferred. Migration timestamp `20260618174500` (bumped off
> `…170000` to avoid colliding with the open overview-selection PR).

## 1. Goal

Surface each scholar's clinical trials on the Scholars Profile System (SPS), end to
end: ingest from reciterdb → Prisma models → a profile section. Design the
enrichment layer so a fresher third-party trial feed can replace ClinicalTrials.gov
(NCT) later without reworking the link model, ETL spine, or UI.

## 2. Decisions locked (this session)

- **Scope:** full vertical — ETL + Prisma models + profile UI section.
- **Source of truth (v1):** the two existing reciterdb tables,
  `clinical_trials` (institutional export, the cwid→trial spine) and
  `clinical_trials_enriched` (ClinicalTrials.gov API v2). No new external feed in v1.
- **Third-party fresher feed:** intended *eventually*, not available yet. v1 must
  leave a clean swap-point (see §8); it must not block on the third party.

## 3. Why this is a low-risk add

The hardest part of most new SPS sources — resolving people to `cwid` — is already
done. `clinical_trials.cwid` is populated per row, so unlike `etl/nih-profile`
(grant-join + fuzzy name fallback) clinical trials arrive **pre-linked**.
`clinical_trials_enriched` joins on `nctNumber`. SPS already has the reciterdb client
(`lib/sources/reciterdb.ts`, `SCHOLARS_RECITERDB_*` env, mariadb pool). This is the
well-worn "new etl source" pattern, not new infrastructure.

## 4. Source tables (reciterdb)

### `clinical_trials` (institutional export — the spine)
`id`, `cwid`, `nctNumber` (NULLABLE), `protocolNumber` (NOT NULL), `piName`, `title`,
`protocolType`, `firstOTADate`, `firstCTADate`, `statusDate`, `principalSponsor`,
`overallCurrentStatus`.

Gotchas to verify at implementation:
- **Row multiplicity** — confirm whether rows are per-`(cwid, protocolNumber)` (one
  per WCM investigator on a trial) or per-protocol (PI only). The model in §5 handles
  both; this only affects how many investigators we render.
- **`nctNumber` is nullable** → not every trial has enrichment. `protocolNumber` is
  the always-present natural key, not NCT.
- **Dates are `varchar`** (M/D/YY per the POC). Need defensive parsing → `Date`.
- **"Fixed" snapshot** — the institutional table is static until a new export lands;
  freshness ceiling is the export cadence (the third party is the eventual fix, §8).

### `clinical_trials_enriched` (ClinicalTrials.gov API v2 — the NCT enrichment)
Keyed on `nctNumber`. `briefTitle`, `officialTitle`, `briefSummary`,
`detailedDescription`, `studyType`, `phases`, `conditions`, `keywords`, `meshTerms`,
`interventions`, `eligibilityCriteria`, `ageMin`, `ageMax`, `healthyVolunteers`,
`primaryOutcome`, `secondaryOutcomes`, `enrollment`.

## 5. Data model (Prisma) — normalized: trial + person-link

Mirrors existing conventions (`Grant`, `PersonNihProfile`): `cwid` keys, `externalId`
for idempotent upsert, `lastRefreshedAt` watermark, cascade off `Scholar`.
Exact field names/`@db` types reconciled against `origin/master` at implementation.

```prisma
model ClinicalTrial {
  protocolNumber  String   @id @map("protocol_number") @db.VarChar(64) // always present
  nctNumber       String?  @unique @map("nct_number") @db.VarChar(32)  // join to enrichment
  title           String   @db.Text          // prefer enriched official/brief, else institutional
  status          String?  @db.VarChar(64)   // overallCurrentStatus
  statusDate      DateTime? @map("status_date") @db.Date
  protocolType    String?  @map("protocol_type") @db.VarChar(64)
  studyType       String?  @map("study_type") @db.VarChar(64)
  phases          String?  @db.VarChar(64)
  principalSponsor String? @map("principal_sponsor") @db.VarChar(255)
  conditions      String?  @db.Text
  meshTerms       String?  @map("mesh_terms") @db.Text
  briefSummary    String?  @map("brief_summary") @db.Text
  enrollment      Int?
  firstOtaDate    DateTime? @map("first_ota_date") @db.Date
  firstCtaDate    DateTime? @map("first_cta_date") @db.Date

  // enrichment provenance — the swap-point (§8)
  enrichmentSource String? @map("enrichment_source") @db.VarChar(48) // "ClinicalTrials.gov" | future vendor | null
  enrichedAt       DateTime? @map("enriched_at")

  source          String   @default("reciterdb.clinical_trials") @db.VarChar(48)
  lastRefreshedAt DateTime @default(now()) @map("last_refreshed_at")

  investigators   PersonClinicalTrial[]
  @@map("clinical_trial")
}

model PersonClinicalTrial {
  cwid           String   @db.VarChar(32)
  scholar        Scholar  @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  protocolNumber String   @map("protocol_number") @db.VarChar(64)
  trial          ClinicalTrial @relation(fields: [protocolNumber], references: [protocolNumber], onDelete: Cascade)
  role           String   @db.VarChar(48)   // derived: "Principal Investigator" | "Investigator"
  piNameRaw      String?  @map("pi_name_raw") @db.VarChar(255)
  lastRefreshedAt DateTime @default(now()) @map("last_refreshed_at")

  @@id([cwid, protocolNumber])
  @@index([cwid])
  @@index([protocolNumber])
  @@map("person_clinical_trial")
}
```

Plus a `clinicalTrials PersonClinicalTrial[]` relation on `Scholar`. One migration
(`add_clinical_trials`).

## 6. ETL — `etl/clinical-trials/index.ts`

1. Read `clinical_trials` via `withReciterConnection` (only rows whose `cwid` exists
   as a non-deleted `Scholar`).
2. Left-join `clinical_trials_enriched` on `nctNumber` (in SQL or in memory).
3. Build `ClinicalTrial` rows: title precedence `officialTitle → briefTitle →
   institutional title`; parse varchar dates defensively; set
   `enrichmentSource="ClinicalTrials.gov"`/`enrichedAt` when an enriched row exists,
   else null.
4. Build `PersonClinicalTrial` rows: derive `role` by normalized compare of the
   scholar's name to `piName` (match → "Principal Investigator", else "Investigator").
5. Idempotent upsert (`protocolNumber` natural key); stamp `lastRefreshedAt`.
6. Register `"etl:clinical-trials": "tsx etl/clinical-trials/index.ts"` in
   `package.json`; slot into `etl/orchestrate.ts` after COI (independent step — its
   failure must not block siblings).

## 7. Read path + UI

- Extend `getScholarFullProfileBySlug` (in `lib/api/profile.ts`) to `include`
  `clinicalTrials` → trial, ordered active-first then `statusDate desc`.
- New `components/profile/clinical-trials-section.tsx`, modeled on
  `grants-section.tsx`: split **Active** vs **Completed/Closed**; each row shows
  title, status (+ "as of" `statusDate`), phase, sponsor, role, conditions; expand
  reveals summary/enrollment and a ClinicalTrials.gov link when `nctNumber` present.
- Insert in `profile-view.tsx` after the Grants section (research-activity grouping).
- **Gated** behind a `CLINICAL_TRIALS_SECTION` flag (app-stack, staging-on/prod-off),
  per the repo's ship-dark convention.

## 8. Future third-party swap-point

Enrichment is isolated to the `ClinicalTrial` enrichment columns +
`enrichmentSource`/`enrichedAt`. When the fresher feed arrives:
- if it lands as a reciterdb table → swap the join in ETL step 2, set
  `enrichmentSource` to the vendor; **no model/UI change**;
- the `cwid` spine (`clinical_trials`) and `PersonClinicalTrial` are untouched;
- UI already renders provenance, so a "fresher as of" indicator is a one-line change.

## 9. Open decisions (need your sign-off in the plan)

1. **Status filtering** — show all linked trials, or hide `Withdrawn`/never-enrolled
   (and apply the POC's `statusDate ≥ 2020` recency gate)? *Proposed: show
   Active + Completed, exclude Withdrawn; no hard year cut, just sort recent.*
2. **Role derivation** — name-match to `piName` is heuristic. OK for v1, or treat all
   as "Investigator" until we have a structured role? *Proposed: name-match heuristic.*
3. **Profile placement** — after Grants (proposed) vs a combined "Research activities"
   block vs its own top-level section.
4. **Search/facet** — v1 is **profile section only**; clinical-trials search tab,
   filters, and a methods/Topics tie-in are **out of scope** (separate follow-up).
   Confirm that's acceptable.

## 10. Rollout

1. PR off fresh `origin/master` worktree (this checkout is ~186 behind): schema +
   migration + ETL + UI behind `CLINICAL_TRIALS_SECTION` (default off).
2. Staging: run `etl:clinical-trials` (first staging write → confirm with operator),
   flip flag on staging via `cdk deploy --exclusively Sps-App-staging`, verify a
   known PI's profile renders trials.
3. Soak, then gated prod flip.

## 11. Out of scope (v1)

Third-party feed ingestion; clinical-trials search/facets; methods/Topics linkage;
trial↔publication linking; editorial/suppression controls beyond scholar soft-delete.
