# Handoff — ASMS enrichment for the CV (postdoc training + primary affiliation)

**Status:** PLAN — approved-to-build pending. **Branch:** `docs/scholar-cv-generator-spec`.
**Depends on:** the shipped CV tool (`lib/edit/cv-export.ts`, `app/api/edit/cv/*`, `lib/edit/pops.ts`)
and spec `docs/scholar-cv-generator-spec.md` §6c. **Author context:** ASMS probed live 2026-06-26.

## 1. Why

The CV's §5 Postdoctoral Training and §9 Hospital Affiliation are currently `N/A` (or thinly
POPS-fed). ASMS holds both, comprehensively. Two empirical findings settle the sourcing:

- **Training: ASMS-only.** Of 120 ASMS clinical (NPI) providers, 70 were in POPS; ASMS had training
  for 67 (mean 2.13 entries, with years + specialty), POPS for **1** (mean 0.01). POPS adds training
  ASMS lacks in **1/70**. POPS `training[]` is sparse — drop it as a CV source.
- **Appointments: ASMS-only** (user-confirmed: *POPS has no appointments ASMS doesn't*). Drop POPS
  appointments from the CV too.

So POPS's CV role narrows to what ASMS/Scholars genuinely lack: **board certifications, NPI, honors,
practices, expertise, specialties, Castle Connolly**. Everything dated/structural comes from ASMS.

## 2. Confirmed ASMS schema (probed)

- **`asms.dbo.fc_doctoral_training`** (16,551 rows): `person_id`, `doctoral_training_type_id`,
  `institution` (varchar), `specialty` (varchar), `year_from`/`year_to` (int, populated),
  `date_from`/`date_to` (date, **mostly null** → use years).
- **`asms.dbo.fc_doctoral_training_type`**: `1 Internship · 2 Residency · 3 Fellowship · 4 Other ·
  5 Postdoctoral · 6 Internship and Residency`.
- **`asms.dbo.wcmc_person.institution_id` → `asms.dbo.wcmc_institution`**: `title`, `abbreviation`.
  Primary institutional affiliation (may be non-WCM — e.g. Hamad/Qatar — store as-is).
- `wcmc_person.is_deleted` / `inactive_date` gate validity (mirror the education ETL's active-CWID join).

## 3. Scope

**In:** ASMS ETL (training + affiliation), Prisma migration, profile-loader exposure, CV-builder
swap (§5→ASMS, §9→ASMS, drop POPS training + appointments), POPS-shape trim, tests.
**Out:** the rest of POPS (unchanged), other CV sections, RePORTER grants companion.

## 4. Schema (Prisma migration)

Add to `prisma/schema.prisma` (mirror the `Education` model conventions — ADR-005 override layer,
externalId reconcile #352):

```prisma
/// Postdoctoral / doctoral training (residency, fellowship, internship) from ASMS
/// `fc_doctoral_training`. Distinct from Education (degrees). Years only — ASMS
/// date_from/date_to are largely null; year_from/year_to are populated.
model Training {
  id              String   @id @default(uuid()) @db.VarChar(64)
  cwid            String   @db.VarChar(32)
  scholar         Scholar  @relation(fields: [cwid], references: [cwid], onDelete: Cascade)
  trainingType    String   @map("training_type") @db.VarChar(64)  // Internship|Residency|Fellowship|Postdoctoral|...
  institution     String   @db.VarChar(255)
  specialty       String?  @db.VarChar(255)
  yearFrom        Int?     @map("year_from")
  yearTo          Int?     @map("year_to")
  externalId      String   @unique @map("external_id") @db.VarChar(128)  // ASMS-DT-{fc_doctoral_training.id}
  source          String   @default("ASMS") @db.VarChar(32)
  lastRefreshedAt DateTime @default(now()) @map("last_refreshed_at")
  @@index([cwid])
  @@map("training")
}
```

On `Scholar`, add (sourced ASMS; one value per person):
```prisma
  primaryAffiliation       String?  @map("primary_affiliation") @db.VarChar(255)
  primaryAffiliationAbbrev String?  @map("primary_affiliation_abbrev") @db.VarChar(64)
  training                 Training[]
```

Then `npx prisma migrate dev --name add_training_and_primary_affiliation` and
`npx prisma generate`. (Schema is the source of truth; the migration SQL lands under
`prisma/migrations/`.)

## 5. ETL (`etl/asms/`)

Extend the ASMS ETL (either grow `etl/asms/index.ts` or add `etl/asms/training.ts` + an affiliation
step; keep one `etl:asms` entrypoint). Reuse the existing active-CWID batch + `classifyByExternalId`
reconcile pattern.

**Training query** (batched IN-clause, batch ≤500 like education):
```sql
SELECT p.cwid, tt.title AS type, t.institution, t.specialty, t.year_from, t.year_to, t.id AS dt_id
FROM asms.dbo.fc_doctoral_training t
JOIN asms.dbo.wcmc_person p ON p.id = t.person_id
LEFT JOIN asms.dbo.fc_doctoral_training_type tt ON tt.id = t.doctoral_training_type_id
WHERE p.cwid IN (@p0,…) AND p.is_deleted = 0
```
- Map → `{ cwid, trainingType: type ?? "Training", institution, specialty, yearFrom, yearTo,
  externalId: \`ASMS-DT-${dt_id}\`, source: "ASMS" }`, filter to active local cwids.
- Reconcile by `externalId` (create/update/tombstone), contentKey over the mapped fields. **No
  `grad_year` filter** (that's the education query; training has none).

**Affiliation query**:
```sql
SELECT p.cwid, i.title AS institution, i.abbreviation AS abbrev
FROM asms.dbo.wcmc_person p
LEFT JOIN asms.dbo.wcmc_institution i ON i.id = p.institution_id
WHERE p.cwid IN (@p0,…) AND p.is_deleted = 0 AND p.institution_id IS NOT NULL
```
- Per active cwid, set `Scholar.primaryAffiliation` / `primaryAffiliationAbbrev` (null them when a
  scholar drops out of the result, so stale values clear).

Wire both into `etl/orchestrate.ts`, the `etl:asms` npm script, and the freshness tracker
(`etl/freshness`). **Ops note:** ASMS is reached only by the nightly ETL (MSSQL, `SCHOLARS_ASMS_*`),
not by the app at request time — these queries run in the same place `etl:asms` already does; no new
reachability. (See the daily-ETL VPC status in `docs/etl-vpc-migration-handoff.md`.)

## 6. Profile loader (`lib/api/profile.ts`)

Extend `ProfilePayload` (in `getScholarFullProfileBySlug`):
- `training: Array<{ type; institution; specialty: string|null; yearFrom: number|null; yearTo: number|null }>`
  (year desc), from the `Training` model.
- `primaryAffiliation: { title: string; abbrev: string|null } | null`, from the Scholar fields.

**Visibility decision (OPEN, §9):** training/affiliation are standard faculty data. If
profile-eligible, route them through the normal suppression/`field_override` layer like
`educations`/`appointments`. If CV-only, expose them only to the CV path. Default recommendation:
**profile-eligible** (it's not sensitive clinical data like POPS) — but confirm.

## 7. CV builder (`lib/edit/cv-export.ts`)

- **§5 `postdocTrainingBody`** → read `input.profile.training` (ASMS). Columns
  `["Title", "Institution", "Dates"]` where Title = `specialty ? \`${type}, ${specialty}\` : type`,
  Dates = `yearFrom–yearTo` (years only; `dateRange` already handles one-sided/empty). **Remove
  `pops.training`.**
- **§9 `hospitalAffiliationBody`** → `input.profile.primaryAffiliation` + the NYP rows already in
  `profile.appointments`. **Remove `pops.appointments`.**
- **§6 `positionsBody`** → keep `profile.appointments`; **remove `pops.appointments`.**
- **`CvInput`** unchanged shape (training/affiliation arrive via `profile`).
- **Trim `PopsEnrichment`** (`lib/edit/pops.ts`): remove `training` + `appointments` (and their
  mapper lines). POPS keeps `npi, boardCertifications, degrees?, honors, specialties, practices,
  expertise, castleConnolly`. *(Optional: drop `degrees` too — ASMS Education already fills B1; POPS
  degrees were only corroboration. Lean recommendation: drop.)*
- **Preview** (`components/edit/cv-tool.tsx` `buildPopsPreviewGroups`): drop the "Hospital
  appointments" group (training group was never there). The preview now shows board cert / training?
  no — training moves to ASMS so it leaves the POPS preview; keep board cert, honors, practices,
  expertise, specialties, NPI.

## 8. Tests

- `tests/unit/pops.test.ts` — drop training/appointment assertions + fixture rows for the trimmed shape.
- `tests/unit/cv-export.test.ts` — §5 now from `profile.training` (add a fixture with years + specialty;
  assert "Residency, Cardiology" + "2009–2014" in POSTDOCTORAL TRAINING); §9 from `primaryAffiliation`;
  assert POPS appointments no longer drive §6/§9.
- `tests/unit/cv-pops-preview.test.ts` — drop the hospital-appointments group expectation.
- ETL: add a reconcile unit test if `etl/asms` has a test harness (else a probe-style dry-run is the check).

## 9. Phases (each its own commit/PR-able unit)

1. **Schema** — `Training` model + Scholar affiliation fields + migration + `prisma generate`.
2. **ETL** — training + affiliation queries, reconcile, orchestrate wiring; dry-run row counts on staging.
3. **Loader** — `ProfilePayload.training` + `.primaryAffiliation` (+ visibility decision).
4. **CV builder** — swap §5/§9/§6 to ASMS, trim POPS, update preview + tests.
5. **Verify** — generate a CV for a clinical AND a research scholar; confirm §5 shows ASMS training
   with years, §9 shows affiliation, POPS training/appointments are gone; run full vitest + tsc + cdk.

## 10. Open decisions (resolve before/while building)

1. **Visibility:** training/affiliation CV-only vs profile-eligible (§6). Rec: profile-eligible.
2. **Schema:** dedicated `Training` model (this plan) vs extend `Education` with a discriminator.
   Rec: dedicated model (WCM CV separates degrees from training; ASMS does too).
3. **Drop POPS `degrees`?** ASMS Education already fills B1. Rec: drop (lean).
4. **Dates granularity:** ASMS gives years, not mm/yy. CV §5 header says mm/yy; render years
   (e.g. "2009–2014"). Acceptable? (No fabrication; years are what ASMS has.)
5. **Non-WCM primary affiliation** (Hamad/Qatar etc.) — render as-is (it's the person's recorded
   home institution). Confirm that's desired for §9.

## 11. Handoff checklist (subsequent steps)

- [ ] Confirm the 5 open decisions (§10) with the owner.
- [ ] Phase 1: schema + migration (commit; regenerate prisma client).
- [ ] Phase 2: ETL training + affiliation; `npm run etl:asms` dry-run on staging, record row counts.
- [ ] Phase 3: profile loader + visibility wiring.
- [ ] Phase 4: CV builder swap + POPS trim + preview + tests green (vitest/tsc/eslint).
- [ ] Phase 5: end-to-end CV generation check (clinical + research scholar); cdk snapshot if app-stack touched.
- [ ] Update spec §5/§6c/§9 to "ASMS-sourced, shipped"; update `docs/scholar-cv-generator-spec.md` coverage matrix.
- [ ] `rm` the temp probes left in the worktree: `_asms_pops_compare.ts`, `_asms_plan_probe.ts`.

## 12. Reference — probe commands (re-runnable)

- `npm run etl:asms:probe` — column dump for fc_doctoral_training / wcmc_institution (+ targets list in `etl/asms/probe.ts`).
- Type lookup: `SELECT id, title FROM asms.dbo.fc_doctoral_training_type`.
- Creds: `SCHOLARS_ASMS_*` (in shell env / ETL secrets); ASMS = MSSQL, encrypt + trustServerCertificate.
