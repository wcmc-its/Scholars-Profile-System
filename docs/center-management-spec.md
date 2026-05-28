# Center management — extended data model, dated memberships, audit

**Status:** Draft v1 — 2026-05-28
**Companion docs:** `docs/unit-curation-spec.md` (#540), `docs/ADR-005-manual-override-layer.md` Amendment 1
**Tracking issue:** TBD (this PR)
**Owner:** TBD

## 1. Background

#540 lit up the manual-roster table `CenterMembership` for every center and institute, but kept it bare: `(centerCode, cwid, source, lastRefreshedAt)`. Two pieces are missing for real launch:

1. **Cancer Center is structurally special.** The Meyer Cancer Center exports each member with a `membershipType` (`RESEARCH` / `CLINICAL`) and a `program` code (`CB`, `CGE`, `CPC`, `CT`, `ZY`). Today the source data carries this in a `program` field formatted `"Meyer Cancer Center: CT"`, but nothing in the schema represents it.
2. **All centers and institutes** need dated membership and audit history. Without start/end dates, a center page can't honestly report "who is here right now" — and the manual-roster layer has no audit trail today even though the rest of /edit does (#102 B03).

This spec extends the unit-curation manual-roster layer with:
- A per-center program taxonomy (Cancer-Center-shaped, designed so any other center can opt in by seeding rows — no schema change required)
- A membership type field
- Start/end dates
- Public-roster active filtering
- B03 audit coverage for every `CenterMembership` write

## 2. Scope

### In scope

- Schema extension on `CenterMembership` (nullable type/program/dates)
- New `CenterProgram` taxonomy table, per-center
- Seed Meyer Cancer Center's 5 programs (CB, CGE, CPC, CT, ZY)
- `POST /api/edit/roster` extensions to carry type/program/dates
- `/edit/center/<slug>` roster UI extensions: type dropdown, program dropdown (only for centers with programs), date pickers, Active/Pending/Inactive status, "show inactive" toggle
- Public `/center/<slug>` active-only filter + program grouping when programs exist
- B03 audit on `CenterMembership` writes (action `roster_change`, before/after snapshots)
- One-off import script for Meyer's legacy type+program backfill from `data/center-members/meyer-cancer-center.txt`
- Search-index facet change: `centerProgram:<code>` keyed off active memberships only

### Out of scope (explicit non-goals)

Do not let scope creep introduce these:

- Per-division program taxonomy — no division has asked
- Per-membership "rank" or "tenure-track" status beyond what RESEARCH/CLINICAL already conveys
- Multiple programs per membership row (a Cancer Center member is in exactly one program)
- Co-membership (one member is in two centers) — already supported by the table shape, no new work needed
- Bulk-edit UI for rosters (one row at a time in v1)
- Importing membership history beyond the current snapshot — start_date is today (or the export date) for first migration, not back-filled to original join dates
- Membership-derived facets on the people-search relevance score
- Notifications when a membership transitions Active → Inactive
- "Program directors" as a separate field (covered by `Center.directorCwid` today)

## 3. Data model

### 3.1 New table: `CenterProgram`

```prisma
/// Per-center program taxonomy. Empty for centers that don't use programs
/// (most). Cancer Center seeds five rows (CB, CGE, CPC, CT, ZY). Other
/// centers may opt in later by inserting their own rows — no schema change.
/// Added by this spec.
model CenterProgram {
  centerCode String @map("center_code") @db.VarChar(64)
  code       String @db.VarChar(16)
  label      String @db.VarChar(255)
  sortOrder  Int    @default(0) @map("sort_order")

  center  Center             @relation(fields: [centerCode], references: [code], onDelete: Cascade)
  members CenterMembership[]

  @@id([centerCode, code])
  @@map("center_program")
}
```

Notes:
- Composite PK `(centerCode, code)` — codes are namespaced per center, so two centers can both have a "CT" code without colliding.
- `label` is the display string ("Cancer Therapeutics"). `code` is the short form used in source exports and API payloads.
- `sortOrder` controls grouping order on the public page; defaults to `0`, ties break alphabetically by label.

### 3.2 Extended: `CenterMembership`

```prisma
model CenterMembership {
  centerCode      String                @map("center_code") @db.VarChar(64)
  cwid            String                @db.VarChar(32)
  membershipType  CenterMembershipType? @map("membership_type")
  programCode     String?               @map("program_code") @db.VarChar(16)
  startDate       DateTime?             @map("start_date") @db.Date
  endDate         DateTime?             @map("end_date") @db.Date
  source          String                @default("manual") @db.VarChar(64)
  lastRefreshedAt DateTime              @default(now()) @map("last_refreshed_at")

  center  Center         @relation(fields: [centerCode], references: [code], onDelete: Cascade)
  program CenterProgram? @relation(fields: [centerCode, programCode], references: [centerCode, code], onDelete: SetNull)

  @@id([centerCode, cwid])
  @@index([cwid])
  @@index([centerCode, programCode])
  @@map("center_membership")
}

enum CenterMembershipType {
  research
  clinical

  @@map("center_membership_type")
}
```

NULL semantics:
- All four new columns are nullable. Pre-existing rows continue to read as `(type=null, program=null, startDate=null, endDate=null)` — interpreted as "active forever, unclassified".
- A center with no `CenterProgram` rows MUST have `programCode = null` on every membership — enforced by the API and the FK.
- `membershipType` is independent of `programCode`. Either may be set without the other (though Cancer Center sets both).

### 3.3 Active filter (the load-bearing predicate)

```sql
(start_date IS NULL OR start_date <= CURRENT_DATE)
  AND (end_date IS NULL OR end_date >= CURRENT_DATE)
```

Boundaries are inclusive on both ends. The same predicate is used in:
- `lib/api/centers.ts` for the public `/center/<slug>` page
- `etl/search-index/index.ts` for the `centerProgram:` facet
- `lib/api/scholars.ts` for the "Centers" chips on the scholar profile (a scholar's membership chip hides once the membership ends)

The `/edit/center/<slug>` Owner/Curator view does NOT apply the filter — admins see all rows with a status column distinguishing Active / Pending / Inactive.

## 4. API

`POST /api/edit/roster` (added by #540 Phase 5) gains a `set` action and four optional fields:

```json
{
  "unitType": "center",
  "unitCode": "meyer-cancer-center",
  "cwid": "joa9069",
  "action": "set",
  "membershipType": "research",
  "programCode": "CT",
  "startDate": "2024-07-01",
  "endDate": null
}
```

Semantics:
- `action: "add"` (existing) — inserts a row with the four new fields if provided, defaults null
- `action: "remove"` (existing) — deletes the row; audited
- `action: "set"` (new) — upserts; partial bodies allowed; explicit `null` clears a field
- `unitType: "division"` rejects 400 on `programCode` (no per-division taxonomy in v1)
- `unitType: "department"` or LDAP-sourced division already 400s per #540

Validation order (any failure → 400 with named reason; superseding checks short-circuit):
1. `unitType` valid + roster writable (#540 rule)
2. Owner/Curator authz (#540 § 2)
3. `programCode` non-null → row exists in `CenterProgram` for this `centerCode`
4. Center has zero `CenterProgram` rows AND `programCode` non-null → reject `400 no_taxonomy`
5. `startDate` + `endDate` both non-null → `endDate >= startDate`
6. `cwid` corresponds to a non-deleted scholar (existing #540 rule)

## 5. Audit

Every roster mutation appends one row to `scholars_audit.manual_edit_audit` via the generalized B03 shape:

```
target_entity_type = 'center'
target_entity_id   = <centerCode>
action             = 'roster_change'
actor_cwid         = <session cwid>
before             = null | { cwid, membershipType, programCode, startDate, endDate }
after              = null | { cwid, membershipType, programCode, startDate, endDate }
```

- `add`: `before = null`, `after` = full row snapshot
- `remove`: `before` = full row snapshot, `after = null`
- `set` on an existing row: `before` + `after` carry the full row (consumers diff), even for partial updates — diffing is the consumer's job, not the producer's

Runnable audit query — last 90 days of roster activity for a center, with a derived "field changed" column:

```sql
SELECT
  created_at,
  actor_cwid,
  CASE
    WHEN JSON_VALUE(before, '$.cwid') IS NULL THEN 'add'
    WHEN JSON_VALUE(after,  '$.cwid') IS NULL THEN 'remove'
    ELSE 'modify'
  END AS change_kind,
  JSON_VALUE(COALESCE(after, before), '$.cwid')           AS target_cwid,
  JSON_VALUE(after,  '$.membershipType')                  AS new_type,
  JSON_VALUE(before, '$.membershipType')                  AS old_type,
  JSON_VALUE(after,  '$.programCode')                     AS new_program,
  JSON_VALUE(before, '$.programCode')                     AS old_program,
  JSON_VALUE(after,  '$.startDate')                       AS new_start,
  JSON_VALUE(after,  '$.endDate')                         AS new_end
FROM scholars_audit.manual_edit_audit
WHERE action             = 'roster_change'
  AND target_entity_type = 'center'
  AND target_entity_id   = ?  -- e.g. 'meyer-cancer-center'
  AND created_at         >= NOW() - INTERVAL 90 DAY
ORDER BY created_at DESC;
```

Audit visibility:
- Superuser-only via the existing audit-log UI (#102)
- Owner/Curator of a center can see the per-center slice through `/edit/center/<slug>/history` (new sub-route, scoped query)

## 6. UI

### 6.1 `/edit/center/<slug>` — roster panel

Columns: **Member** | **Type** | **Program** | **Start** | **End** | **Status** | actions

- **Type** — dropdown: Research / Clinical / (none). Editable inline (one-field PATCH).
- **Program** — dropdown of this center's `CenterProgram` rows; hidden if zero rows exist.
- **Start** / **End** — date pickers; both optional; UI blocks Save if End < Start.
- **Status** — derived, not stored:
  - Active = today in range (per § 3.3)
  - Pending = startDate > today
  - Inactive = endDate < today
- Default view = "Show active only" (filter chip ON). Toggle OFF reveals Pending + Inactive rows, with row styling to dim Inactive (the deselect-style affordance — same pattern as the suppression UI).

### 6.2 `/center/<slug>` — public page

- Active-filter applied (§ 3.3); Pending and Inactive members do not appear.
- If the center has ≥1 `CenterProgram` row AND ≥1 active member with non-null `programCode`:
  - Members grouped under `program.label` headers, sorted by `program.sortOrder` then label
  - Members with `programCode = null` fall into an "Other" group at the end (header shown only if non-empty)
- If the center has zero `CenterProgram` rows, render a flat member list (today's behavior).
- `membershipType` does **not** render on the public page in v1 — Meyer hasn't asked for it visible, and showing "Research member" / "Clinical member" is loaded language that the center may not want public. Open Question 3.

### 6.3 `/edit/center/<slug>/history` — audit view

- Read-only table: timestamp / actor / change kind / target / diff summary
- Scope: rows for this center only (`target_entity_id = <centerCode>`)
- Visible to Owner, Curator, Superuser
- Per #540 Phase 7 pattern — matches the unit-edit history surface

## 7. Migration

Offline-generated per `project_prisma_migration_offline`. Steps:

```sql
-- 1. Schema columns (nullable; no backfill required for legacy rows)
ALTER TABLE center_membership
  ADD COLUMN membership_type ENUM('research','clinical') NULL,
  ADD COLUMN program_code    VARCHAR(16) NULL,
  ADD COLUMN start_date      DATE NULL,
  ADD COLUMN end_date        DATE NULL,
  ADD INDEX center_membership_program (center_code, program_code);

-- 2. CenterProgram table
CREATE TABLE center_program (
  center_code VARCHAR(64) NOT NULL,
  code        VARCHAR(16) NOT NULL,
  label       VARCHAR(255) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (center_code, code),
  CONSTRAINT center_program_center_fk
    FOREIGN KEY (center_code) REFERENCES center(code) ON DELETE CASCADE
);

-- 3. Seed Meyer Cancer Center programs
INSERT INTO center_program (center_code, code, label, sort_order) VALUES
  ('meyer-cancer-center', 'CB',  'Cancer Biology',                10),
  ('meyer-cancer-center', 'CGE', 'Cancer Genetics & Epigenetics', 20),
  ('meyer-cancer-center', 'CPC', 'Cancer Prevention and Control', 30),
  ('meyer-cancer-center', 'CT',  'Cancer Therapeutics',           40),
  ('meyer-cancer-center', 'ZY',  'Non-aligned Clinical',          50);

-- 4. FK from membership.program_code -> center_program (added after seed)
ALTER TABLE center_membership
  ADD CONSTRAINT center_membership_program_fk
    FOREIGN KEY (center_code, program_code)
    REFERENCES center_program(center_code, code)
    ON DELETE SET NULL;
```

Backfill of Meyer's existing 11+ rows happens in Phase 5 via a one-off script (`scripts/seed/center-membership-extended.ts`) that reads the source export and runs an UPSERT keyed on `(center_code, cwid)`. Not in the migration itself.

Audit-schema impact: zero. The B03 row shape already accepts arbitrary `before` / `after` JSON; new keys are additive.

## 8. ETL and search-index impact

| Area | Change |
|---|---|
| `etl/ed/index.ts` | None — ED is not the source for `CenterMembership`. |
| `etl/search-index/index.ts` | When building a scholar's document, include `centerProgram:<code>` facet keys **only for memberships where the active-filter predicate is true and `programCode IS NOT NULL`**. Inactive memberships do not contribute facet keys. Pending memberships do not contribute facet keys until their `startDate`. |
| `lib/api/centers.ts` | Apply active-filter when building public roster; pass `programs` map for grouping. |
| `lib/api/scholars.ts` | "Centers" chips on the profile honor the active-filter; expired chips disappear. |
| Nightly Step Function `SearchIndexNightly` | Picks up changes automatically — the document builder is the only thing that changed. No new step. |

## 9. Edge cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | Center has zero `CenterProgram` rows; Owner sets `programCode` via API | `400 no_taxonomy` |
| 2 | `programCode` row deleted from `CenterProgram` while memberships reference it | FK `ON DELETE SET NULL` clears `program_code` on each affected membership; one audit row per affected membership |
| 3 | `startDate > endDate` | `400 invalid_date_range` at the API; UI disables Save |
| 4 | Both dates null | Active forever (pre-extension legacy semantics) |
| 5 | `startDate IS NULL, endDate < today` | Inactive (we don't infer a fake start) |
| 6 | `startDate > today, endDate IS NULL` | Pending — visible to Owner with Status=Pending, hidden from public roster |
| 7 | `endDate = today` | Active today; inactive tomorrow — inclusive boundary |
| 8 | Public page on a center with mixed programmed + unprogrammed active members | Programmed members grouped; unprogrammed fall into "Other" group |
| 9 | Public page on a center with zero programmed active members but `CenterProgram` rows exist | Flat list, no group headers — don't render an empty taxonomy |
| 10 | Scholar `cwid` soft-deleted | Membership row remains; public roster filters out the dormant scholar (existing) |
| 11 | `programCode` set but `membershipType` null | Allowed |
| 12 | Two Owners edit the same row concurrently | Last write wins; both writes audited; UI shows a "this row was just updated by X" toast on stale save (existing #540 optimistic-concurrency surface) |
| 13 | Owner of department containing this center's parent department tries to edit the roster | Allowed only if center's `ownerEntityType / ownerEntityId` cascade rule from #540 § 2 includes them. Center Owners are direct grants in v1 — department Owners do not cascade into centers. |
| 14 | Audit row for a row that was both inserted and deleted in the same minute | Two distinct B03 rows, in order; no compaction |
| 15 | Re-add of a previously-removed member | New row; old audit history retained; new membership's `startDate` is whatever the Owner provides (often today) |

## 10. Tests

| Layer | File | Coverage |
|---|---|---|
| Schema | `tests/db/center-program.test.ts` | FK SET NULL on program delete; cascade on center delete; composite PK uniqueness |
| API | `tests/api/edit-roster-center.test.ts` | All § 4 validation paths; `set` upsert semantics; `null` clears; authz; no-taxonomy reject |
| Active filter | `tests/lib/active-filter.test.ts` | All 8 boundary cases from § 9 rows 4–8 + inclusive endpoints |
| Audit | `tests/audit/center-roster-audit.test.ts` | `before`/`after` snapshots correct for add/remove/set; FK-induced SET NULL also audited |
| UI | `tests/components/center-roster-panel.test.tsx` | Type/program dropdowns render correctly per center config; Save disabled on bad date range; show-inactive toggle |
| Public page | `tests/pages/center-slug.test.tsx` | Active-only filter; grouping under program labels; "Other" group; flat list for no-taxonomy centers |
| Search index | `tests/etl/search-index-center-program.test.ts` | Facet keys only emitted for active + programmed memberships |
| Integration | `tests/integration/meyer-end-to-end.test.ts` | Seed Meyer programs, add member with type+program+dates, verify public page, advance system time past endDate, verify hidden + facet stops emitting |

## 11. Phasing

Each phase ≈ one PR; follow #540's wave shape.

| Phase | Scope | Depends on |
|---|---|---|
| 1 | Schema migration + `CenterProgram` + Meyer seed + Prisma regen | #540 Phase 1 (#544 already merged) |
| 2 | API extensions on `POST /api/edit/roster` + validation + audit shape | #540 Phase 2 (#545 — authz already merged) + #540 Phase 5 (write endpoint) |
| 3 | `/edit/center/<slug>` roster columns + program dropdown + date pickers + show-inactive toggle | Phase 2 |
| 4 | Public `/center/<slug>` active filter + program grouping | Phase 1 |
| 5 | One-off import script for Meyer's legacy type+program | Phase 1; runs once per env |
| 6 | Search-index facet active-only + `centerProgram:` keying | Phase 1; ETL/search-index changes |
| 7 | `/edit/center/<slug>/history` audit view | Phase 2 (writes producing audit rows must exist first) |

## 12. Open questions

1. **Type visibility on the public page** — render "Research"/"Clinical" subtitle by default, hide unless toggled, or per-center configurable? Recommendation: hide in v1; Meyer-specific toggle later if requested.
2. **Pending memberships on the public page** — hide entirely or surface as "Joining 2026-07-01"? Recommendation: hide entirely in v1 (cleaner, matches the active filter; an Owner can adjust dates if a member needs visibility sooner).
3. **Owner cascade into centers** — § 9 row 13 leans "department Owners do not cascade into centers". Reasonable for v1 (most centers are cross-departmental anyway) but worth confirming.
4. **Per-center program description** — `CenterProgram.label` is the visible string; do we want a longer description / link out (e.g. each Meyer program has its own page on the Meyer site)? Recommendation: not in v1; add `description TEXT?` + `url VARCHAR(255)?` if a center asks.
5. **Membership end date when a scholar leaves the institution** — does the LDAP `weillCornellEduPersonStatus = 'inactive'` transition auto-stamp `endDate` on every membership? Recommendation: NO in v1 (manual table stays manual); revisit if Owners report stale rosters.
6. **Cancer Center's existing source export format** — confirm with Andria whether the source file (or its replacement) will continue to provide type+program for new members, or whether new members will be added Owner-by-Owner via the UI going forward. Phase 5 import is one-off either way; this only affects the ongoing operating model.

## 13. Files touched

| File | Change |
|---|---|
| `prisma/schema.prisma` | `CenterProgram` model; `CenterMembership` field additions; `CenterMembershipType` enum |
| `prisma/migrations/<ts>_center_management/migration.sql` | § 7 SQL, offline-generated |
| `prisma/seed-centers.ts` | Seed Meyer programs |
| `app/api/edit/roster/route.ts` | § 4 extensions |
| `lib/edit/validation.ts` | New validators: `validateProgramCode`, `validateDateRange` |
| `lib/api/centers.ts` | Active-filter; program grouping |
| `lib/api/scholars.ts` | Active-filter on scholar's center chips |
| `etl/search-index/index.ts` | Facet keying changes |
| `app/edit/center/[slug]/page.tsx` | Roster columns; type/program dropdowns; date pickers; show-inactive toggle |
| `app/edit/center/[slug]/history/page.tsx` | New |
| `app/center/[slug]/page.tsx` | Group-by-program rendering |
| `scripts/seed/center-membership-extended.ts` | One-off Meyer backfill |
| Tests per § 10 | New |
