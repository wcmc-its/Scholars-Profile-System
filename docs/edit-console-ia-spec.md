# `/edit` console navigation IA — tab strip, role visibility & the Reports sub-IA

**Status:** Reference — describes shipped code on `origin/master` as of 2026-08-14 (`41cfe938`), plus a **Known gaps** section of confirmed, not-yet-fixed inconsistencies against that same code.
**Scope:** The in-console tab strip (`AdminSubnav`, reached once a viewer is already on a `/edit` page) and the Reports tab's own internal routing (`app/edit/reports/*`). Companion to [`role-aware-navigation-entry-points-spec.md`](./role-aware-navigation-entry-points-spec.md), which covers the layer *before* this one — the login dropdown's entry points that get a viewer *into* the console in the first place. That spec's §2c ("Console tab strip — already correct") is the reason this layer was never audited on its own; §5 below shows it needs its own pass.

## 1. The three navigation layers

1. **Account-menu entry points** (`components/site/account-menu.tsx`, server-built `consoleLinks`) — gets a viewer *into* `/edit` at all. Covered by `role-aware-navigation-entry-points-spec.md`, not repeated here.
2. **Console tab strip** (`components/edit/admin-subnav.tsx`) — once inside, which of 17 tabs a viewer can jump to. **This document's subject.**
3. **Reports' own sub-IA** (`app/edit/reports/page.tsx`) — the Reports tab is one destination, but what renders behind it depends on how many units the viewer administers. §4 below.

## 2. How tab visibility is computed

Three pieces, applied in order for every `ConsoleShell`-rendered page:

**a. Session baseline — `lib/edit/console-tabs.ts`, `deriveConsoleTabs(session)`.**
Computes 9 of `AdminSubnav`'s props from `EditSession` alone (`superuserSurfaces`, `profilesTab`, `unitsTab`, `administratorsTab`, `methodsTab`, `dataQualityTab`, `dataSharingTab`, `reportsTab`, `viewerIsDeveloper`). Its own docblock is explicit about what it deliberately excludes: `active`, the two DB-derived pending counts, and "the unit-admin escape hatches: `usageTab`, and the EXTRA `unitsTab`/`dataQualityTab` visibility a unit Owner/Curator earns on the pages they can reach" — those need a grant/scope read `EditSession` doesn't carry, so **the page itself is expected to OR its own signal onto the base** before handing the final value to `ConsoleShell` (e.g. `unitsTab: base.unitsTab || viewerAdminsAUnit`).

**b. Per-page override — `components/edit/console-shell.tsx`.**
Calls `deriveConsoleTabs`, then layers page props on top with two different merge rules, both intentional:
- `profilesTab` / `reportsTab` — **OR'd** onto the baseline (`tabs.x = tabs.x || x`). A page just contributes an extra "yes."
- `unitsTab` / `dataQualityTab` / `administratorsTab` — **replaced outright** by whatever the page passes. This is correct *only* because §2a's contract already expects the page to have done its own OR-ing beforehand (see `units/page.tsx`'s `dataQualityTab` below) — it is not a second, independent bug, it's the other half of the same contract.

**c. Tab-level gate — `admin-subnav.tsx`'s `tabs` array.**
Each of the 17 entries has its own `show: boolean`, mostly `<prop> !== null && <prop> !== undefined` for the count-typed props, or a bespoke expression for the boolean ones (e.g. Honors: `pendingHonors !== null` alone, **deliberately** not ANDed with `superuserSurfaces` — the inline comment cites #1767, "an honors surface nobody could find," as the reason).

**d. `CONSOLE_SUBNAV_GROUPED`** — confirmed presentation-only. It buckets the *already-filtered* `tabs` array into `queues`/`registries`/`reports`/`insights`/`tools` groups and renders a single-member group as a plain tab. It never changes whether a tab is in the array to begin with.

## 3. Role × tab matrix

| Tab | Superuser | comms_steward | honors_curator | unit Owner | unit Curator | pure `developer` |
|---|---|---|---|---|---|---|
| Profiles | ✓ everywhere | ✓ everywhere (`profilesTab`) | ✗ | ✓ on pages that OR in a scope signal (e.g. `/edit/scholars`) | ✓ same | ✗ |
| Org units | ✓ everywhere | ✓ everywhere | ✗ | ✓ on pages that OR in a grant signal | ✓ same | ✗ |
| URL requests / URL registry / Activity / ETL status / Cores | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Honors | ✓ (flag on) | ✗ | ✓ — except `/edit` self-edit landing (§5, Gap 1) | ✗ | ✗ | ✗ |
| News | ✓ | ✓ (flag on) | ✗ | can leak `true` via `profilesTab` then 404 (§5, Gap 2) | same leak | ✗ |
| Administrators | ✓ (flag on) | ✗ (no page ORs a steward signal) | ✗ | ✗ — even on `/edit/administrators` itself, despite the page admitting them (§5, Gap 3) | ✗ (by design — see below) | ✗ |
| Method families | ✓ (flag on) | ✓ everywhere it's rendered | ✗ | ✗ | ✗ | ✗ |
| Reports | ✓ | ✓ everywhere | ✗ | ✓ only on `/edit/reports/*`; not surfaced from `/edit/units` (§5, Gap 4) | same | ✗ |
| Data quality | ✓ (flag on) | ✓ everywhere | ✗ | ✓ on pages that OR in a grant signal | same | ✗ |
| Data sharing | ✓ (flag on) | ✓ everywhere | ✗ | ✗ (no unit-scoped variant — by design, no per-unit data-sharing concept exists) | ✗ | ✗ |
| Usage | ✓ | ✗ (`canViewUsage` has no steward carve-out) | ✗ | ✓ only on `/edit/usage` itself; not surfaced from `/edit/units` or `/edit/administrators` (§5, Gap 4) | same | ✗ |
| Funding matcher / Matcha | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ only once already on `/edit/find-researchers`, `/edit/matcha`, or `/edit/grant-matcha` — no entry point from `/edit` landing (§5, Gap 1b) |

**By design, not a gap:** unit **Curators** never get the Administrators tab — `lib/edit/administrators.ts`'s `loadOwnerManagedUnitScope` filters on `role: "owner"` only, matching [`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) Decision D5 ("superusers AND unit **Owners**") exactly.

## 4. Reports sub-IA — `app/edit/reports/page.tsx`

Once a viewer opens the Reports tab, `EditReportsIndexPage` branches purely on `loadReportableUnitsForActor(session, db.read)` and, for a superuser/comms_steward, the size of that set:

```
?center=<code> given          → SingleUnitReports for that one unit ("3a")
0 reportable units             → notFound()
exactly 1 reportable unit      → SingleUnitReports, resolved automatically ("3a")
2+ reportable units:
  superuser/comms_steward
    AND count > 3               → ReportsIndex, mode="table"  ("2a" — filter rail)
  otherwise                     → ReportsIndex, mode="bands"  ("1a" — every unit banded inline)
```

`SingleUnitReports` renders the same `Report | Focus | Last refreshed` table each `1a` band uses, minus the band header — the page's own `<h1>` (`{ctx.unit.name} reports`) already names the unit, so the header would be redundant (this is the mockup-matching behavior landed in #2411, "3a's single-unit reports list now matches the mockup's table").

Mockup correspondence (`docs/mockups/Reports IA.dc.html` in the design-review Downloads folder; not committed — see `apollo-surface-language.html` for the committed sibling):
- `1a` = "Insights › Reports — role-scoped index (this admin holds two centers)"
- `2a` = "Insights › Reports — superuser index" (filter rail + sortable table)
- `3a` = "Insights › Reports — limited end user" (one unit, no band header)

The five numbered report pages (`/edit/reports/{1..5}`) each independently re-resolve session/authz/center via `resolveNumberedReportCenterCode` + `loadReportsContext` — a deliberate per-page duplication ("matching every other `/edit/*` console page's convention," per each file's doc comment), not a shared server component. All five, plus both index branches, pass a bare `reportsTab` (or inherit `reportsTab: session.isSuperuser || session.isCommsSteward` from the baseline) — no drift found across this family.

## 5. Known gaps (open, unfixed as of 2026-08-14)

**Gap 1 — a pure `honors_curator` landing on `/edit` (self-edit) may get no console nav at all, Honors tab included.**
`app/edit/page.tsx`:
```ts
const hasUnitGrants = manageableUnits.length > 0;
const showConsoleNav = canBrowseProfiles || commsSteward || hasUnitGrants;
```
`honorsCurator` is resolved two lines earlier (for `pendingHonors`) but never ORed into `showConsoleNav`. When all three of `canBrowseProfiles`/`commsSteward`/`hasUnitGrants` are false, `consoleNav` is `undefined` and `AdminSubnav` never renders — reproducing the exact #1767 shape ("an honors surface nobody could find") one layer up, in the gate that decides whether to render the strip at all, rather than in the Honors tab's own (already-correct) `show` boolean.
*Fix:* `const showConsoleNav = canBrowseProfiles || commsSteward || hasUnitGrants || honorsCurator;`

**Gap 1b — `isDeveloper` is never read in `app/edit/page.tsx`.** No reference to it anywhere in the file (confirmed by grep), and the page uses `getSession()`, not `getEffectiveEditSession()`, so no `EditSession.isDeveloper` value is even available to check. A pure `development`-role viewer has no path from their own `/edit` landing page to `/edit/find-researchers` / `/edit/matcha` / `/edit/grant-matcha`.

**Gap 2 — the News tab can show a link that 404s.**
`admin-subnav.tsx`: `show: (superuserSurfaces || profilesTab) && isNewsQueueEnabled()`. This piggybacks on `profilesTab` — but `app/edit/scholars/page.tsx` sets `profilesTab={unitScope !== null}`, true for *any* non-empty scope, including a plain unit Owner/Curator who is neither superuser nor comms_steward. `lib/edit/news-queue.ts` defines a dedicated, correct predicate — `isNewsQueueTabVisible(session)` (`isSuperuser || isCommsSteward`) — that is **never called anywhere** (confirmed: its only occurrence in the repo is its own definition). A unit Owner/Curator with the news flag on sees "News" on `/edit/scholars`, then hits `app/edit/news-queue/page.tsx`'s `notFound()` gate.
*Fix:* `show: superuserSurfaces && isNewsQueueEnabled()` (or wire the unused `isNewsQueueTabVisible(session)` through properly if steward-only access is intended — the predicate already encodes that).

**Gap 3 — the Administrators tab is unreachable for a non-superuser unit Owner, contradicting a locked spec decision.**
[`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) Decision D5: *"Administrators tab audience: superusers AND unit Owners... supersedes the 'superuser-only at launch' language."* `app/edit/administrators/page.tsx` implements the D5 query-side scoping via `loadOwnerManagedUnitScope`. But:
- `lib/edit/console-tabs.ts`: `administratorsTab: session.isSuperuser && isAdministratorsTabEnabled() ? 0 : null` — hard-gates on `isSuperuser`.
- `admin-subnav.tsx`: `show: superuserSurfaces && administratorsTab !== null && administratorsTab !== undefined` — hard-ANDs on `superuserSurfaces` too, unlike the sibling `methodsTab`/`dataQualityTab`/`dataSharingTab` gates, which trust the count-vs-null signal alone.
- No page — including `app/edit/administrators/page.tsx` itself (`unitsTab={session.isSuperuser}`, nothing else) — ever ORs an owner signal into `administratorsTab`.
- `tests/unit/admin-subnav.test.tsx` (~line 149) pins the current AND as intentional (`administratorsTab={0}` + `superuserSurfaces={false}` asserts the tab is absent) — a few dozen lines from a test (~line 370) documenting the identical shape already fixed for Honors per #1767.

Net effect: an Owner who *can* open `/edit/administrators` (the content renders in full, scoped correctly) has no nav entry point to it anywhere in the app, and no highlighted tab even while standing on that page.
*Fix:* thread an owner-scope signal (`loadOwnerManagedUnitScope` already computes it server-side for the page's own content) into `administratorsTab`, drop the `superuserSurfaces` AND in `admin-subnav.tsx`'s gate to match its siblings, and update the pinning test.

**Gap 4 — `/edit/units` doesn't surface Usage or Reports, despite already holding the data both checks need.**
`app/edit/units/page.tsx` loads `units = await loadManageableUnits(...)` and already ORs `units.total > 0` into `dataQualityTab` — but never passes `usageTab` or `reportsTab`. `canViewUsage` (`lib/edit/usage-access.ts`) grants Usage to any `UnitAdmin` grant holder — a subset of `units`. `loadReportableUnitsForActor` (`lib/edit/cancer-center-reports.ts`), for a non-global viewer, reads the same `loadManageableUnits(...).centers`. So a unit Owner/Curator with a reportable center and/or any grant, landing on the page whose own doc comment says it's "no longer a navigational dead end," still can't reach Usage or Reports from there. The identical `usageTab` omission exists on `/edit/administrators` (`unitsTab={session.isSuperuser}` only — no OR at all, so a comms_steward who also owns a unit loses the Units tab specifically on that one page, since `unitsTab` is a replace-not-OR prop per §2b).
*Fix:* on `/edit/units`, add `usageTab={await canViewUsage(session, db.read)}` and `reportsTab={(await loadReportableUnitsForActor(session, db.read)).length > 0}` (or thread the already-loaded unit list through instead of a second query); on `/edit/administrators`, change `unitsTab={session.isSuperuser}` to OR in the same unit-admin signal `units/page.tsx` uses.

## 6. Not a gap — verified fine

- `CONSOLE_SUBNAV_GROUPED` — presentation-only (§2d).
- Superuser gets a uniform experience on every page; no page-specific drift found for that role.
- The five numbered Reports pages + both index branches — consistent `reportsTab` wiring throughout (§4).
- `canViewDataSharingDashboard` and `isDataSharingDashboardTabVisible` are the same function under two names — no divergence.
- The Cores tab having no non-superuser escape hatch is already self-documented as a deliberately deferred gap in `app/edit/core/page.tsx`'s own comment ("an owner-scoped index is a future add") — unlike Gaps 1-4 above, this one isn't silent.
- Curators correctly excluded from Administrators (§3, "by design" note) — matches D5's Owner-only wording exactly.

## 7. Related docs

- [`role-aware-navigation-entry-points-spec.md`](./role-aware-navigation-entry-points-spec.md) — the layer before this one (account-menu entry points).
- [`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) — Decision D5, the source of Gap 3.
- [`apollo-surface-language.html`](./mockups/apollo-surface-language.html) — the visual design system the Reports pages (§4) are styled against.
- [`comms-steward-methods-visibility-spec.md`](./comms-steward-methods-visibility-spec.md) — the comms_steward role definition referenced throughout §3.
