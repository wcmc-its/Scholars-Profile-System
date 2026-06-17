# Data Quality Dashboard — `/edit/data-quality`

**Status:** PROPOSED (awaiting approval)
**Date:** 2026-06-17
**Scope:** A new tab in the `/edit` admin surface that lists scholars with their data-quality
gaps (missing headshot, missing overview, pending COI suggestions), sorted by a rolled-our-own
prominence score, filterable by person type and department. Read-only report with deep links into
the existing per-scholar edit pages.

---

## 1. Goals & decisions (locked with the user)

- **Audience / scope (chosen: "Steward + unit-scoped"):**
  - Superuser and comms / comms_steward → **all** scholars.
  - Unit editor (department/division/center owner or curator) → only scholars in the unit(s)
    they administer (incl. the dept→division cascade).
  - A plain scholar editing their own profile → tab is **hidden**, route 404s.
- **Sort:** by a new **prominence** score (formula in §5), descending. The intent is "fix the
  most publicly-visible scholars with gaps first."
- **Interactivity (chosen: read-only report + deep links):** each row deep-links to that scholar's
  existing edit page (and the relevant section anchor). No inline mutation in v1.
- **Filters:** person type (`roleCategory`) and department (`deptCode`). Plus a gap-type filter
  (see §4) and pagination.
- **Default population (chosen: "All active scholars"):** default lists every active
  (`deletedAt = null`, `status = 'active'`) scholar, **including** hidden identity classes
  (doctoral students / `affiliate_alumni`). A dedicated **hidden-scholars filter** lets the viewer
  show/hide those roles (default: shown). Person-type filter can further narrow to one role.

---

## 2. Why a new surface (and not the existing Profiles roster)

`/edit/scholars` (the "Profiles" roster) already does search + status/unit/type filters, but it is
**superuser-only** (`requireSuperuserGet`) and is a generic identity roster — it has no concept of
data-quality gaps or prominence. The Data Quality Dashboard is a distinct, gap-oriented,
role-scoped view, so it gets its own route and loader, modeled on the existing patterns:

- Roster filters/pagination pattern: `app/edit/scholars/page.tsx` + `components/edit/profiles-roster.tsx`
  + `lib/api/edit-roster.ts` (`loadEditRoster`, `loadRosterFacets`).
- Role-aware entry pattern: `app/edit/units/page.tsx` + `lib/edit/manageable-units.ts`
  (`loadManageableUnits`) for unit-scoped users.

---

## 3. Access & entry points

### 3.1 Route gate (`app/edit/data-quality/page.tsx`)
1. `session = await getEffectiveEditSession()`; if null → SAML login redirect (`return=/edit/data-quality`).
2. Flag check: `EDIT_DATA_QUALITY_DASHBOARD === "on"`, else `notFound()`.
3. Authorization — allow if **any** of:
   - `session.isSuperuser`
   - `isCommsSteward(session)`  *(same predicate that powers `isMethodsTabVisible`)*
   - `loadManageableUnits(session.cwid, db.read)` returns ≥ 1 grant (unit owner/curator)
   - else → `notFound()` (never reveal the surface to a plain scholar).
4. Compute **scope**:
   - superuser or comms_steward → org-wide (no unit restriction).
   - otherwise → the set of unit codes from `loadManageableUnits`, expanded via the existing
     membership model in `lib/edit/unit-scholar-authz.ts` (deptCode / divCode / DivisionMembership
     + dept→division cascade; centers per that module's rules).

### 3.2 Tab in `AdminSubnav` (stewards)
- Add `"data-quality"` to `AdminSubnavActive` in `components/edit/admin-subnav.tsx`.
- Render the tab using the **same visibility discipline as `methodsTab`**: shown when the flag is
  on AND (`isSuperuser || isCommsSteward`). Label: **"Data quality"**, `href="/edit/data-quality"`.
- The existing console pages (`/edit/scholars`, `/edit/slugs`, etc.) that render `AdminSubnav` pass
  the new visibility prop so the tab appears alongside the others for stewards.

### 3.3 Entry point for unit editors (`/edit/units`)
Unit editors never see the steward `AdminSubnav` console; their home is `/edit/units`. Add a
role-aware card/link there ("Data quality for your units" → `/edit/data-quality`) shown only when
the flag is on and the viewer has manageable units. This honors role-aware-navigation-spec §3
("never advertise a surface a viewer can't open").

---

## 4. The data-quality signals (per scholar)

| Signal | Source | "Gap" definition | Server-side? |
|---|---|---|---|
| **Headshot** | **persisted** `Scholar.has_headshot` (new column), backfilled by a directory-probe ETL (§4.1) | `has_headshot = false` → missing; `null` → not-yet-checked | Yes (column) |
| **Overview** | `Scholar.overview` + `field_override(entity_type='scholar', field_name='overview')` | `overview` null/empty **and** no overview `field_override` → missing | Yes (cheap) |
| **Pending COI suggestions** | `coi_gap_candidate` where `status='new'`, grouped by `cwid` | count of High-tier (and Medium shown secondarily) > 0 | Yes (one `groupBy`) |

All three are exact and cheap server-side, enabling exact columns, filters, and prominence-sorted
pagination over the whole scoped set.

### 4.1 Headshot persistence (chosen: persist presence now)
`headshot_url` is never written (confirmed: zero non-generated usages); the app determines presence
only via a live directory call that 404s when absent (`identityImageEndpoint(cwid)`, `returnGenericOn404=false`).
To make "missing headshot" an exact, sortable/filterable server-side signal:

1. **Schema migration** — add to `Scholar`:
   - `has_headshot Boolean?` (`hasHeadshot`) — true/false once probed, null = never checked.
   - `headshot_checked_at DateTime?` (`headshotCheckedAt`) — last probe timestamp (freshness).
   - (Leave the dormant `headshot_url` column as-is; render is unchanged.)
2. **Probe ETL** — `etl/headshot/index.ts` + `etl:headshot` npm script:
   - Iterate active (`deletedAt = null`) scholars, GET `identityImageEndpoint(cwid)` with bounded
     concurrency + modest rate-limiting; HTTP 200 → `hasHeadshot = true`, 404 → `false`, other/error
     → leave prior value, stamp `headshotCheckedAt` only on a definitive 200/404.
   - Idempotent; supports `--full` and an incremental "stale older than N days" mode.
   - **Verify** the directory host is reachable from the ETL task's VPC egress before relying on it
     (the endpoint is used client-side on public pages, so it should be publicly reachable over
     HTTPS via NAT — confirm with a one-off `run-task` probe first).
3. **Cron** — register a weekly schedule in `cdk/lib/etl-stack.ts` (mirror the curated-backup
   schedule pattern: rule + state machine + a dedicated creation flag, staging-on / prod-off).
4. **Loader** reads `hasHeadshot` directly → exact column + exact `no-headshot` filter, fully
   server-side, no per-request external calls. Rows with `hasHeadshot = null` render as "—
   (not checked)" until the first probe lands.

---

## 5. Prominence formula (rolled our own — revised per user)

User-directed additions: **department-chair / division-chief leadership** and **times-as-PI, with
NIH emphasis**. Anchored to the existing people-search weights (`lib/search.ts:702-723`, incl. the
#532 dept-leadership constants) and using precomputed columns + a handful of batched aggregates.

```
prominence(scholar) =
      log1p(pubVolume)                       // publication volume, saturated
    + 0.5 * log1p(hIndex ?? 0)               // impact (precomputed FACULTY# rollup)
    + max( 3.0 * isChair , 1.5 * isChief )   // leadership — mirrors #532 (chair > chief, take stronger)
    + 0.5 * log1p(piGrantCount)              // times as PI (any sponsor), saturated
    + 0.5 * log1p(nihPiGrantCount)           // NIH-PI emphasis (NIH PI grants counted a second time)
    + 1.0 * (roleCategory === 'full_time_faculty' ? 1 : 0)   // role boost (mirrors search)

where
  pubVolume       = scoredPubCount ?? <pubCount via one publicationAuthor groupBy> ?? 0
  isChair         = ∃ Department.chairCwid = cwid          (lib/search-index-docs.ts:875)
  isChief         = ∃ Division.chiefCwid  = cwid           (lib/search-index-docs.ts:879)
  PI_ROLES        = { 'PI', 'PI-Subaward', 'Co-PI' }       (Grant.role)
  piGrantCount    = count of Grant where role ∈ PI_ROLES
  nihPiGrantCount = count of Grant where role ∈ PI_ROLES AND nihIc IS NOT NULL  (NIH-funded only)
```

- `hIndex`, `scoredPubCount` are precomputed on `Scholar` (nullable; ETL `etl/dynamodb`).
- Leadership: one `department.findMany({where:{chairCwid:{in:cwids}}})` + one
  `division.findMany({where:{chiefCwid:{in:cwids}}})` — identical source to the search index, so the
  dashboard's "chair" matches what search already ranks (override-applied via ED ETL).
- PI counts: two `grant.groupBy({by:['cwid']})` (all-time, not just active — "times as PI" is
  cumulative). NIH flag = `nihIc` non-null (NIH-funded-only field, per Grant schema #78 F2).
- All weights are constants in one place so they're easy to tune. **Default sort: prominence desc**,
  secondary `preferredName asc` (stable pagination).

Rationale: leadership gets the same strong boost search uses (a chair/chief with a data gap is the
most public-facing fix); PI-count (NIH-weighted) is log-saturated so a few mega-PIs don't dominate;
hIndex + faculty boost mirror the org's tuned search ranking.

---

## 6. Loader (`lib/api/data-quality.ts`)

`loadDataQualityRoster({ scope, roleCategory?, deptCode?, gap?, includeHidden, page }, db)`:

1. Build the candidate `where`: `deletedAt: null`, `status: 'active'`; **include hidden roles by
   default** (`includeHidden` true), else exclude `doctoral_student` / `affiliate_alumni`
   (`HIDDEN_DISPLAY_ROLES`, `lib/eligibility.ts`); apply `roleCategory` filter when chosen; apply
   `deptCode` filter; apply **scope** (unit codes for unit editors).
2. Select identity + prominence inputs (`cwid, preferredName, slug, primaryTitle, primaryDepartment,
   roleCategory, deptCode, overview, hIndex, scoredPubCount, hasHeadshot, headshotCheckedAt`).
3. Batch aggregates over the candidate cwids (all `{ in: cwids }`):
   - `department.findMany({ where:{ chairCwid:{in} } })` → chair set
   - `division.findMany({ where:{ chiefCwid:{in} } })` → chief set
   - `grant.groupBy({ by:['cwid'], where:{ role:{in:PI_ROLES} } })` → PI count
   - `grant.groupBy({ by:['cwid'], where:{ role:{in:PI_ROLES}, nihIc:{not:null} } })` → NIH-PI count
   - `coiGapCandidate.groupBy({ by:['cwid','tier'], where:{ status:'new' } })` → pending COI by tier
   - `fieldOverride.findMany({ where:{ entityType:'scholar', fieldName:'overview', entityId:{in} } })`
     → overrides that satisfy the overview gap even when `scholar.overview` is empty
4. Compute prominence (§5), assemble rows `{ cwid, name, title, dept, roleCategory, isChair, isChief,
   hasHeadshot, hasOverview, pendingCoiHigh, pendingCoiMedium, prominence }`, sort, paginate.
   Headshot presence comes straight from the `hasHeadshot` column (§4.1) — no per-request probe.
5. Facets: reuse / mirror `loadRosterFacets` (`lib/api/edit-roster.ts`) for department + person-type
   dropdown options, restricted to the viewer's scope.

`gap` filter values: `all | no-headshot | no-overview | has-coi` (headshot caveat per §4.1).
A separate `includeHidden` toggle controls the hidden identity classes (per §1).

---

## 7. UI (`components/edit/data-quality-dashboard.tsx`)

- GET-form filter bar (no client JS needed for filters), mirroring `profiles-roster.tsx`:
  person-type `<select>`, department `<select>`, gap-type `<select>`, **hidden-scholars toggle**
  (show/hide doctoral students + alumni; default show), submit. URL-param driven with a `pageHref()`
  helper preserving filters across pagination.
- Table columns: **Scholar** (name + title + dept, links to edit page), **Prominence** (score or a
  compact rank), **Headshot** (✓ / ✗), **Overview** (✓ / ✗), **COI** (count badge, e.g. "3 to
  review"). Each gap cell deep-links to the right section of the scholar's edit page:
  - headshot → `/edit/scholar/[cwid]#photo` (superuser) or the unit-scoped edit path
  - overview → `…#overview`
  - COI → the COI section
  *(Deep-link target depends on viewer: superuser uses `/edit/scholar/[cwid]`; unit editors use the
  unit-scoped scholar edit route they're already authorized for.)*
- Apollo header + `AdminSubnav active="data-quality"` (for stewards). For unit editors arriving from
  `/edit/units`, render without the steward subnav (they aren't authorized for the other console tabs).
- Empty/sparse states; accessible table semantics; respects existing a11y patterns.

---

## 8. Feature flag & rollout

- Flag: **`EDIT_DATA_QUALITY_DASHBOARD`** (off by default; lazy `process.env` read in a
  `lib/edit/*.ts` helper, matching existing flag style).
- Wire in `cdk/lib/app-stack.ts`: staging `on`, prod `off` (gated rollout, same as prior tabs).
- **App side:** no reindex. Reads existing tables + the new `has_headshot` column. Ships on next CD
  image to staging; prod via gated release + `cdk deploy Sps-App-prod` after the prod App stack is
  brought to master (prod App stack currently lags master — standing deploy caveat).
- **Schema migration** (`has_headshot`, `headshot_checked_at`): additive/nullable, ED-ETL-safe.
  Applied via CD migrate on deploy.
- **ETL side (headshot probe):** new `etl:headshot` job + weekly cron in `cdk/lib/etl-stack.ts`
  (creation-flag gated, staging-on / prod-off). Requires `cdk deploy Sps-Etl-<env>` — **operator-gated**
  (my `reciter` creds can `run-task` but not `cdk deploy` Sps-Etl). First run can be a manual
  `run-task` to backfill before the cron is live. Until the first probe completes, headshot cells
  show "— (not checked)".

---

## 9. Tests

- `lib/api/data-quality.ts`: scope restriction (unit editor sees only their units; steward sees all),
  gap computation (overview null vs field_override; COI new-count; hasHeadshot true/false/null),
  prominence ordering incl. chair/chief + PI/NIH terms, hidden-roles default + filter, filter +
  pagination correctness.
- `etl/headshot`: 200→true / 404→false / error→unchanged mapping; idempotent upsert; checkedAt only
  stamped on definitive results (probe the directory via a mockable fetch).
- Route authz: superuser / comms_steward / unit-editor allowed; plain scholar → 404; flag off → 404.
- `AdminSubnav`: tab shows for stewards only; hidden when flag off.
- Component render test for the table + filter form (mirrors `profiles-roster` tests).

---

## 10. Out of scope (v1) / fast-follows

- Inline quick-actions (generate overview, dismiss COI) — deferred.
- Additional gap signals (missing slug, missing appointments, stale overview, etc.).

### Done in v1

- **CSV export** — `GET /edit/data-quality/export` (`buildDataQualityCsv` + `loadDataQualityExport`,
  `lib/api/data-quality.ts`). Same flag/scope/filters as the page, unpaginated, prominence-sorted,
  capped at `DATA_QUALITY_EXPORT_CAP` (5000); columns: rank, cwid, name, title, unit, person_type,
  leadership, headshot, has_overview, pending_coi_high, pending_coi_medium, prominence. "Download CSV"
  link on the dashboard carries the active filters.

---

## 11. Sign-off status

- **Q1 (prominence weights):** RESOLVED — revised §5 to add chair/chief leadership + times-as-PI
  (NIH-weighted) per user.
- **Q2 (default population):** RESOLVED — default = all active scholars incl. hidden roles, with a
  hidden-scholars filter (§1).
- **Q3 (headshot):** RESOLVED — persist presence via an **ETL job** (`has_headshot` column +
  `etl:headshot` probe + weekly cron). Exact column + exact filter. (§4.1)
- **Q4 (flag name):** default `EDIT_DATA_QUALITY_DASHBOARD` unless changed.
