# Data Quality Dashboard — v2 changes (HANDOFF)

**Date:** 2026-06-17
**Author of v1:** (this session)
**Status:** Handoff — NOT yet implemented. v1 shipped in **PR #1081** (`feat/data-quality-dashboard`, CI green, not merged).
**Source of feedback:** live review of the running dashboard at `/edit/data-quality`.

This document hands off a second round of changes requested after reviewing v1. It is
written so whoever picks it up (or a future session) can execute without re-deriving context.
v1 spec: `docs/data-quality-dashboard-spec.md`.

---

## v1 files you'll be editing

| File | Role |
|---|---|
| `lib/api/data-quality.ts` | Loader (`loadDataQualityRoster`, `computeDataQualityEntries`), types, prominence formula, CSV (`buildDataQualityCsv`, `loadDataQualityExport`) |
| `lib/edit/data-quality.ts` | Flag, tab visibility, scope resolver |
| `app/edit/data-quality/page.tsx` | Route (parses search params → loader) |
| `app/edit/data-quality/export/route.ts` | CSV download route (same params) |
| `components/edit/data-quality-dashboard.tsx` | The table + GET-form filter bar + pagination |
| `lib/api/edit-roster.ts` | `loadRosterFacets` — the dropdown option source (extend for hierarchy) |
| tests | `tests/unit/data-quality-*.test.ts(x)` |

The filter model today: a server-rendered **GET form** (no client JS); each filter is a query
param; `loadDataQualityRoster` turns params into a Prisma `where` + in-app prominence sort + slice.
Several v2 items widen that param model (single → multi), which touches the page, the export route,
the loader options, and the component in lockstep — plan them together.

---

## Requested changes

### 1. The Dean must rank #1 (institutional leadership above chairs)

**Today:** prominence gives dept chairs `+3.0` and division chiefs `+1.5`, so chairs top the list
(Ronald Crystal 13.53). The **Dean is not a dept chair**, so he doesn't get the boost and doesn't
rank #1. Robert Harrington (**cwid `rharrington`**, title "Stephen and Suzanne Weiss Dean") should be #1.

**Decision needed — how to identify institutional leaders:**
- ❌ Title heuristic (`LIKE '%Dean%'`) is unreliable: 5 active scholars match — `rharrington` (the Dean),
  `rbsilve` (Associate Dean), `dalonso`/`amg2004` (Dean Emeritus), `jos9046` (Senior Associate Dean).
  Only `rharrington` is *the* Dean.
- ✅ **Recommended: a curated institutional-leadership overlay** — a small in-code map of `cwid → tier`
  (or weight) for roles the org chart doesn't model as chair/chief (Dean, Provost, EVP for Health, etc.),
  seeded with `rharrington`. Extensible, explicit, testable. Mirrors the existing `lib/external-leaders.ts`
  pattern (curated overlay keyed by id).

**Decision needed — guarantee #1, or just boost?**
- A large additive weight (e.g. `+100`) makes the Dean dominate prominence — simple, but "guaranteed
  #1" depends on no one else also being in the overlay with a higher score.
- ✅ **Recommended: a sort *tier***. Sort institutional leaders (overlay order) strictly above everyone
  else, then prominence within each tier. Deterministic ("Dean is always first"), and naturally orders
  Dean > Provost > … if more are added. Implement as a primary sort key in
  `computeDataQualityEntries`: `tier(a) - tier(b) || b.prominence - a.prominence || name`.

**Where:** `lib/api/data-quality.ts` — add the overlay + a `leadershipTier(cwid)` and fold it into the
sort. Surface the role in the row (e.g. `leadership: "Dean" | "Chair" | "Chief" | null`) so the CSV +
table show it.

---

### 2. Show more than 50 + a jump bar

**Today:** `PAGE_SIZE = 50` with only Prev/Next links. `MAX_LIMIT = 200` in the loader.

**Asks:** show more per page **and** a "jump bar" to move across the full set quickly.

**Interpretation / recommendation** (confirm "jump bar" meaning with the requester):
- "jump bar" = **numbered pagination** — First · ‹ Prev · `1 2 3 … N` (windowed) · Next › · Last,
  plus optionally a "Go to page __" input. (Not an A–Z bar — the list is prominence-sorted, not
  alphabetical, so alphabetical jumps don't apply.)
- Raise the page size (e.g. `PAGE_SIZE = 100`) and/or add a page-size selector (50/100/200).
- All still fits the GET-form model: page links carry the current filters (extend the existing
  `pageHref`).

**Where:** `components/edit/data-quality-dashboard.tsx` (the pagination block + `pageHref`); page size
is a const in `app/edit/data-quality/page.tsx` (and mirror in the export cap reasoning if relevant).

---

### 3. Filter by name or CWID

**Today:** no free-text search.

**Approach:** add a `q` param → in `buildWhere`, `OR: [{preferredName contains q}, {fullName contains
q}, {cwid contains q}]` — copy the proven block from `lib/api/edit-roster.ts:buildWhere`. Add a search
`<input name="q">` to the filter bar; thread through page + export route + loader options.

---

### 4. Multi-select for every dropdown

**Today:** person-type and the (department-only) unit filter are single-value `<select>`.

**Asks:** all dropdowns multi-select.

**Decision needed — UX vs no-JS:**
- ✅ Simplest, keeps the no-JS GET form: native `<select multiple>` → submits repeated params; read with
  `searchParams.getAll("type")`. Loader options become `roleCategories: string[]`, `units: UnitRef[]`.
  Prisma `where`: `roleCategory: { in: [...] }`; unit filter OR's the selected dept/div/center clauses.
- Nicer UX (chips/checkbox dropdown) needs a client component. **Reuse candidate:** the searchable
  multi-select `RosterFacet` typeahead from #972 (`components/...` — used by the center/org-unit method
  facets). If adopted, the form likely becomes a small client island while the table stays server-rendered.

**Where:** loader options + `buildWhere` (`= value` → `in: [...]`), page param parsing (`getAll`),
export route param parsing (must match), component filter controls, `pageHref`/`exportHref` (repeat each
selected value).

---

### 5. Org-unit filter: include divisions + centers, indented under their parent

**Today:** the unit dropdown lists **departments only**; the loader filters on `deptCode`.

**Asks:** include divisions and centers, indented (e.g. *Cardiology* nested under *Medicine*).

**Data reality (important):**
- **Divisions** carry `Division.deptCode` → their parent department, so they indent cleanly under it.
- **Centers have NO parent-dept FK** (`loadAllUnitsDirectory` notes "Centers are NOT modeled with a
  parent-dept FK — always null"). So centers **cannot** be indented under a department — list them in
  their own group ("Centers") after the dept→division tree. Confirm this is acceptable.

**Approach:**
- Extend the facet (`loadRosterFacets` or a new `loadUnitHierarchyFacet`) to return departments each with
  their child divisions (group by `division.deptCode`), plus a flat centers list.
- Render as an indented multi-select (optgroups or indented options; with native `<select multiple>` use
  `<optgroup label="Medicine">` + indented division options, then an optgroup "Centers").
- Generalize the loader's `deptCode` filter to a **unit filter** like `edit-roster`'s `EditRosterUnitFilter`
  (`{kind:'department'|'division'|'center', code}`): department→`deptCode in`, division→`divCode in`,
  center→`cwid in (active center members)` (reuse `activeCenterMemberCwids` from `edit-roster.ts`).
  Combined with multi-select (#4), the selected units OR together.

---

### 6. "Overview last updated" column + a sensible filter

**Today:** the loader has `overview` (for the gap) but not its date.

**Asks:** show when the overview was last updated, and a sensible filter on it.

**Leverage existing work:** master already ships **#1077 "overview last updated date + imported-bio
label"** (commit `aaca6f2e`). Find that helper (search `overviewUpdatedAt` / "imported" in
`lib/api/edit-context.ts` or a `lib/overview-*` helper) and **reuse its date + imported/seeded
classification** so the dashboard agrees with the edit surface.

- **Column:** add `overviewUpdatedAt` to the loader select + entry; render the date (or "—" when null /
  no overview), with the #1077 "imported"/"seeded" label where applicable. (Remember `overviewUpdatedAt`
  is null for scholars with no overview.)
- **"Sensible" filter (decision needed):** recommended buckets —
  `imported/seed (never genuinely edited)` · `>2 years` · `1–2 years` · `<1 year` · `never`. The
  highest-value one is **"imported/seed only"** — overviews that are still the VIVO seed and need a real
  one (this pairs with the #1077 imported-bio signal). Confirm the bucket set with the requester.
- ⚠️ **Local-DB caveat for whoever verifies:** in the local dev DB every overview's `overview_updated_at`
  is a single bulk-seed timestamp (`2026-05-06`), so the date column/filter looks uniform locally —
  verify the date variety on **staging**, where real edits exist.

---

### 7. Remove the "Edit →" link column

**Today:** the last table column is an `Edit →` link; the scholar **name already links** to the same
edit page.

**Approach:** delete the trailing `<th></th>` + the `Edit →` `<td>` in
`components/edit/data-quality-dashboard.tsx`. Keep the name link (`editHref`) as the row's way in. Trivial.

---

## Cross-cutting work (do these once, they serve items 3–6)

1. **Widen the filter param model** end-to-end (page parse → loader options → export route parse →
   component controls → `pageHref`/`exportHref`): `roleCategory→roleCategories[]`, `deptCode→units[]`,
   add `q`, add `overviewAge`. The **export route must parse identically to the page** (it already
   mirrors today — keep them in lockstep, ideally via a shared `parseDataQualityParams(searchParams)` to
   prevent drift).
2. **`computeDataQualityEntries` sort:** add the leadership tier as the primary key (#1).
3. **Tests:** extend `data-quality-loader`/`-export`/`-page` for multi-value filters, name/cwid search,
   the leadership tier (Dean first), the unit hierarchy filter (division/center), and the overview-age
   filter. Update the CSV header test if the `leadership`/`overview_updated` columns change.

---

## Open decisions (get answers before building)

1. **Institutional-leadership source** — curated overlay (recommended; seed `rharrington`) vs title
   heuristic. Who else belongs in tier 0 besides the Dean (Provost? EVP Health?)?
2. **"Jump bar"** — confirm = numbered pagination (recommended). New page size (100? selector?).
3. **Multi-select UX** — native `<select multiple>` (no-JS, simplest) vs the #972 `RosterFacet`
   client typeahead (nicer).
4. **Centers can't indent** (no parent-dept FK) — OK to list them in a separate "Centers" group?
5. **Overview-age buckets** — confirm the bucket set; is "imported/seed only" the primary one?
6. **CSV columns** — add `overview_updated_at` (and keep `leadership` now carrying "Dean")? Drop nothing
   else.

---

## Suggested sequencing

1. Quick wins, low risk: **#7 (remove edit link)**, **#1 (Dean tier)**, **#3 (name/cwid search)**.
2. **#6 (overview date col + filter)** — once the #1077 helper is located/reused.
3. **#2 (page size + jump bar)**.
4. **#4 + #5 together** (multi-select + unit hierarchy) — the biggest piece; they share the widened
   param model.

Reasonable as **one PR** stacked on #1081 (or after it merges, off fresh `origin/master`). App-only, no
new migration, no reindex. Keep the `EDIT_DATA_QUALITY_DASHBOARD` flag.

---

## How to run / verify locally (recipe used for v1)

A dev server is currently up on **:3009** from the `feat/data-quality-dashboard` worktree. To reproduce
from scratch:

```bash
# 1. worktree on the branch (canonical is on a different branch)
git worktree add ~/worktrees/sps-data-quality feat/data-quality-dashboard
cp .env .env.local ~/worktrees/sps-data-quality/         # copy local env
# dev-login is LOCAL-ONLY + uncommitted — copy it in:
cp app/api/auth/dev-login/route.ts ~/worktrees/sps-data-quality/app/api/auth/dev-login/route.ts
cd ~/worktrees/sps-data-quality && npm ci && npx prisma generate

# 2. local DB needs the migration's columns (additive, nullable):
#    ALTER TABLE scholar ADD COLUMN has_headshot BOOLEAN NULL;
#    ALTER TABLE scholar ADD COLUMN headshot_checked_at DATETIME(3) NULL;
#    (already applied to this machine's dev DB)

# 3. run with the flag on + a superuser cwid
EDIT_DATA_QUALITY_DASHBOARD=on SCHOLARS_SUPERUSER_CWIDS=aaa4027 PORT=3009 npm run dev
```

Then open (dev-login mints the session, then redirects):
- Superuser (all scholars): `http://localhost:3009/api/auth/dev-login?cwid=aaa4027&return=/edit/data-quality`
- Unit owner (scoped to Meyer Cancer Center): `…dev-login?cwid=aog2001&return=/edit/data-quality`
- Plain scholar (404 expected): `…dev-login?cwid=aab9028&return=/edit/data-quality`

---

## Appendix — grounded facts (from the live local DB, 2026-06-17)

- Dean: **`rharrington`** — "Stephen and Suzanne Weiss Dean."
- "Dean" in `primary_title` (5): `rharrington`, `rbsilve` (Associate Dean), `dalonso` (Dean Emeritus),
  `amg2004` (Provost … and Dean Emeritus), `jos9046` (Senior Associate Dean) → title match is too broad.
- Active scholars: ~8,937. Overviews present: ~557; missing: ~8,380.
- `overview_updated_at`: null for the ~8,380 without overviews; uniformly the `2026-05-06` seed for those
  with one (local dev only — real variety lives on staging).
- Org units: `Division.deptCode` → parent dept (indentable). `Center` has no parent-dept FK (not
  indentable → separate group).
- Leadership source (existing): `Department.chairCwid`, `Division.chiefCwid` (override-applied by ED ETL;
  same source people-search ranks on). Curated overlay precedent: `lib/external-leaders.ts`.
