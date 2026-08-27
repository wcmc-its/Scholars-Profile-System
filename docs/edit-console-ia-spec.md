# `/edit` console navigation IA — normative spec, implementation notes & gap audit

**Status:** Part A (invariants + intended matrix) is normative and should stay stable as gaps close. Part B describes shipped code on `origin/master` as of `41cfe938` and will drift the moment that code changes — it is implementation notes, not spec. Part C is a gap audit; each row should carry a tracking issue, not live only in this doc.

**Scope:** The in-console tab strip (`AdminSubnav`, reached once a viewer is already on a `/edit` page) and the Reports tab's own internal routing (`app/edit/reports/*`). Companion to [`role-aware-navigation-entry-points-spec.md`](./role-aware-navigation-entry-points-spec.md), which covers the layer *before* this one — the login dropdown's entry points that get a viewer *into* the console in the first place. That spec's §2c ("Console tab strip — already correct") is the reason this layer was never audited on its own; Part C shows it needs its own pass.

This document was originally a pure audit — a descriptive matrix plus four gaps found against it. On review, that framing buried the actual finding: Gaps 1, 1b, 3, and 4 (plus #1767 historically, plus a test that pins one of them as intentional) are not four bugs, they're four failures of the *same* distributed contract — "the page itself is expected to OR its own grant signal onto the session baseline" (Part B §1a). A contract that four different pages have now violated four different ways is the root cause, not the pages. Part A states that as three invariants and a normative matrix; Part B keeps the old descriptive material, now framed as the mechanism the invariants say to delete; Part C is the gap list, re-expressed as invariant violations.

## Part A — Normative IA spec

### A1. Invariants

Three properties fall out of the gap list below. A future change to console navigation should be checked against these, not against the shipped mechanism in Part B.

- **I1 — Location-independence.** Tab visibility is a function of the viewer (session + grants) alone, never of which `/edit` page they're standing on. The current mechanism violates this by construction: `usageTab` has no session-derived baseline at all (`deriveConsoleTabs`/`ConsoleTabProps` doesn't include it — see Part B §1a), so every page that wants to show Usage must independently remember to compute and pass it, and most don't. A nav strip that mutates as a unit Owner clicks around the console is disorienting on its own, independent of any individual bug.
- **I2 — Nav/page parity.** A tab shows in the strip iff the page behind it admits the viewer. Gap 2 (nav shows, page 404s) and Gap 3 (page admits, nav hides) are the two directions of violating this one rule; #1767 was too. Gap 5 (Part C) shows a third: a tab can be nav-visible to a role for whom the page it points at 404s in a genuine edge case, not just a bug.
- **I3 — Monotonicity.** Granting an additional role or grant never removes a tab. Gap 4b — a comms_steward loses the Units tab specifically on `/edit/administrators` — is a direct violation: `unitsTab` is a *replace*, not an *OR*, prop (Part B §1b), so a page that means to add a narrower signal can instead erase a broader one already earned. The role × tab matrix in Part B's predecessor only had pure-role columns; replace-not-OR semantics make role *combinations* exactly where this class of bug lives, and until the fixture below, they were untested.

### A2. Intended matrix — normative, executable

The matrix is `tests/unit/console-tab-matrix.fixture.ts`, not this table. That file names a viewer shape and the exact tab set it must see; `tests/unit/console-tab-matrix.test.ts` asserts `lib/edit/console-tabs.server.ts`'s `TAB_PREDICATES` reproduce every row, that every tab id is covered by at least one row (so an unspecified new tab fails closed instead of shipping unnoticed, the way the News piggyback did), and that every pairwise merge of two rows satisfies I3. The table below is a rendering of that file for readability — if the two ever disagree, the fixture is right and this table needs updating, not the reverse.

| Tab | Superuser | comms_steward | honors_curator | unit Owner | unit Curator | pure `developer` |
|---|---|---|---|---|---|---|
| Profiles / Org units | ✓ | ✓ | ✗ | ✓ (`manageableUnitCount > 0`) | ✓ same | ✗ |
| URL requests / URL registry / Activity / ETL status | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Cores | ✓ (flag) | ✓ (flag; 2026-08-26 policy widening, decision #6 — full curator-parity on cores) | ✗ | ✗ (owner-scoped index still a deliberately deferred gap) | ✗ | ✗ |
| Honors | ✓ (flag) | ✗ | ✓ | ✗ | ✗ | ✗ |
| News | ✓ | ✓ (flag) | ✗ | ✗ | ✗ | ✗ |
| Administrators | ✓ (flag) | ✗ | ✗ | ✓ — `ownerUnitCount > 0` only, D5 | ✗ (by design, D5) | ✗ |
| Method families | ✓ (flag) | ✓ | ✗ | ✗ | ✗ | ✗ |
| Reports | ✓ | ✓ | ✗ | ✓ — `reportableUnitCount > 0` (centers only, not depts/divisions/cores) | ✓ same | ✗ |
| Data quality | ✓ (flag) | ✓ | ✗ | ✓ (`manageableUnitCount > 0`) | ✓ same | ✗ |
| Data sharing | ✓ (flag) | ✓ | ✗ | ✗ (no unit-scoped variant exists — no decision doc cites this yet, unlike Data Quality) | ✗ | ✗ |
| Usage | ✓ | ✗ (`canViewUsage` has no steward carve-out) | ✗ | ✓ any `UnitAdmin` grant, either role | ✓ same | ✗ |
| Funding matcher / Matcha | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ (Matcha also flag-gated) |

Every cell above is a single predicate in `TAB_PREDICATES`; there is no second merge step, no per-page override, and no case where two different code paths compute the same tab's visibility. That collapse is the actual content of "kill the contract" (Part B §2) — everything else follows from it.

## Part B — Implementation notes (pinned to `41cfe938`)

### B1. How tab visibility is computed today

Three pieces, applied in order for every `ConsoleShell`-rendered page:

**a. Session baseline — `lib/edit/console-tabs.ts`, `deriveConsoleTabs(session)`.**
Computes 9 of `AdminSubnav`'s props from `EditSession` alone (`superuserSurfaces`, `profilesTab`, `unitsTab`, `administratorsTab`, `methodsTab`, `dataQualityTab`, `dataSharingTab`, `reportsTab`, `viewerIsDeveloper`). Its own docblock is explicit about what it deliberately excludes: `active`, the two DB-derived pending counts, and "the unit-admin escape hatches: `usageTab`, and the EXTRA `unitsTab`/`dataQualityTab` visibility a unit Owner/Curator earns on the pages they can reach" — those need a grant/scope read `EditSession` doesn't carry, so **the page itself is expected to OR its own signal onto the base** before handing the final value to `ConsoleShell`. `usageTab` is the extreme case: it isn't in `ConsoleTabProps` at all, so there is no baseline to OR onto — every page that wants to show it starts from `false` and must compute the whole thing itself.

**b. Per-page override — `components/edit/console-shell.tsx`.**
Calls `deriveConsoleTabs`, then layers page props on top with three different merge rules:
- `profilesTab` / `reportsTab` — **OR'd** onto the baseline (`tabs.x = tabs.x || x`). A page just contributes an extra "yes."
- `unitsTab` / `dataQualityTab` / `administratorsTab` — **replaced outright** by whatever the page passes, including `undefined` treated as "keep baseline" but any defined value (even `false`) wins. This is correct *only* if the page has already OR'd its own signal in beforehand — it is the other half of §1a's contract, not a second bug. `app/edit/administrators/page.tsx` doesn't hold up that half: it passes `unitsTab={session.isSuperuser}` unconditionally, which *replaces* the baseline `session.isSuperuser || session.isCommsSteward`. In practice this is reachable only by a comms_steward who **also** owns a unit — a pure comms_steward with no owned unit never gets past the page's own authz gate (`loadOwnerManagedUnitScope` returns `[]` for them, and the page 403s *before* `ConsoleShell` ever renders, so there's no nav strip to lose a tab from). For that steward+owner viewer, the page strips a tab their role alone already earned (Gap 4b below).
- `usageTab` — passed straight through to `AdminSubnav` with no merge logic at all, because there's no baseline field to merge with (see §1a). A page that forgets to compute it gets `false`, silently.

**c. Tab-level gate — `admin-subnav.tsx`'s `tabs` array.**
Each of the 17 entries has its own `show: boolean`. Most non-superuser tabs are gated on a count-vs-null/undefined check alone (`methodsTab`, `dataQualityTab`, `dataSharingTab`) or an OR with `superuserSurfaces` (`reports`, `usage`) — but `administrators` is `superuserSurfaces && administratorsTab !== null && administratorsTab !== undefined`, ANDing a role check its siblings don't (Gap 3). Honors is the opposite outlier: gated on `pendingHonors !== null` **alone**, deliberately not ANDed with `superuserSurfaces` — the inline comment cites #1767, "an honors surface nobody could find," as the reason. Honors and Administrators are structurally the same shape (a non-superuser role needs an entry point); only one of them was fixed.

**d. `CONSOLE_SUBNAV_GROUPED`** — presentation-only. It buckets the *already-filtered* `tabs` array into `queues`/`registries`/`reports`/`insights`/`tools` groups and renders a single-member group as a plain tab. It never changes whether a tab is in the array to begin with.

### B2. Why kill the contract

The only reason visibility is spread across three layers is that `EditSession` doesn't carry grant/scope data, and the pages happen to already run the DB reads that would fill that gap. `lib/edit/console-tabs.server.ts` (new, this session) is a proposed replacement: one `cache()`'d loader (`loadConsoleGrants`) runs the four grant reads once per request (`loadOwnerManagedUnitScope`, `loadManageableUnits`, `loadReportableUnitsForActor`, `canViewUsage`), and `TAB_PREDICATES` — a `Record<ConsoleTabId, (session, grants) => boolean>` — is the *entire* IA, one function per tab, each a pure disjunction (I3 by construction). `assertTabAdmits(tab, session, db)` is I2 in one helper: a page calls it instead of hand-rolling its own authz-for-nav check, so nav-shows/page-404s and page-admits/nav-hides both become unrepresentable — one predicate, two callers.

Every predicate that has an existing bundled `isXTabVisible(session)` function (`isHonorsQueueTabVisible`, `isNewsQueueTabVisible`, `isMethodsTabVisible`, `isDataSharingDashboardTabVisible`) delegates to it rather than re-reading the flag. `administrators` was the one gap without such a function — `isAdministratorsTabEnabled()` was flag-only, with no paired role check — so `isAdministratorsTabVisible(session, ownerUnitCount)` was added next to it in `lib/edit/administrators.ts`, matching its siblings' shape exactly.

Under this design: Gap 1 dissolves because there's no separate `showConsoleNav` gate on `/edit` to forget a role in — the loader's tab-set is what decides whether the strip renders at all. Gap 1b dissolves because `fundingMatcher`/`matcha` are ordinary predicates, reachable from any page including the landing page, not something only `EditShell`'s already-derived `viewerIsDeveloper` prop happens to carry. Gap 3 dissolves because `administrators` is one predicate, called by both the nav and (once wired) the page. Gap 4 and 4b dissolve because there is no replace-vs-OR distinction left to get wrong — every predicate is additive by construction.

**This is not yet wired into `AdminSubnav`, `ConsoleShell`, or any page.** Migrating the shipped nav onto it means deleting `deriveConsoleTabs`, the `ConsoleShell` merge props, and every page's per-page OR — an auth-adjacent change across roughly 14 files, including the test in Part C that currently pins Gap 3 as intentional. That migration needs an explicit go (`2026-08-14-edit-console-ia-handoff.md`, decision 3), same posture the Reports IA plan took on its own permissions-adjacent phase. What ships in this session is the executable spec (`console-tabs.server.ts` + the fixture + its test) as the target the migration converges on, verified in isolation: `npm run typecheck`, `eslint`, and `vitest run tests/unit/console-tab-matrix.test.ts` (99/99) all pass against it without touching any shipped page.

### B3. Reports sub-IA — `app/edit/reports/page.tsx`

Once a viewer opens the Reports tab, `EditReportsIndexPage` branches purely on `loadReportableUnitsForActor(session, db.read)` and, for a superuser/comms_steward, the size of that set:

```
?center=<code> given          → resolveReportsCenterCode (org-wide existence check, NOT actor-scoped)
                                   → code doesn't exist / no program taxonomy → notFound() (404)
                                   → code exists → loadReportsContext (the real per-actor gate)
                                       → viewer can't access it → ForbiddenEditPage (403), not 404, not a silent fallback to the index
                                       → viewer can → SingleUnitReports for that unit ("3a")
0 reportable units             → notFound() — including a superuser with zero reportable centers (no
                                   role carve-out on this branch; theoretical today, since prod always
                                   has centers with a program taxonomy, but a real I2 gap if it ever isn't)
exactly 1 reportable unit      → SingleUnitReports, resolved automatically ("3a")
2+ reportable units:
  superuser/comms_steward       → ReportsIndex, mode="table"  ("2a" — filter rail)
  otherwise                     → ReportsIndex, mode="bands"  ("1a" — every unit banded inline)
```

The old `units.length > 3` gate on `2a` was a bare inline literal — not a named constant, not cited to a decision doc — and it kept the filter rail unreachable at real unit counts (staging has 1 reportable unit today). Removed: a superuser/comms_steward now gets the table/filter-rail view starting at 2 units, no size minimum.

`SingleUnitReports` renders the same `Report | Focus | Last refreshed` table each `1a` band uses, minus the band header — the page's own `<h1>` (`{ctx.unit.name} reports`) already names the unit, so the header would be redundant (this is the mockup-matching behavior landed in #2411, "3a's single-unit reports list now matches the mockup's table").

Mockup correspondence — [`Reports IA.dc.html`](./mockups/reports-ia.dc.html), committed alongside this revision (previously only in the design-review Downloads folder, and unverifiable in six months as a result; checked for real-faculty PII before committing — none found, only public center names and the account owner's own name as the logged-in-user example):
- `1a` = "Insights › Reports — role-scoped index (this admin holds two centers)"
- `2a` = "Insights › Reports — superuser index" (filter rail + sortable table)
- `3a` = "Insights › Reports — limited end user" (one unit, no band header)

The five numbered report pages (`/edit/reports/{1..5}`) share one center-resolution helper (`resolveNumberedReportCenterCode`, in `lib/edit/cancer-center-reports.ts` — not duplicated per page), but each page still independently re-resolves session/authz/shell props around that shared call ("matching every other `/edit/*` console page's convention," per each file's doc comment). That convention is the exact mechanism Part B §1 and Part C document as fragile everywhere else it appears — consistency with it is not, on its own, a reason this family is safe; it's simply that no drift was found *here*, this session. All five pages, plus both index branches, pass a bare `reportsTab` (or inherit `reportsTab: session.isSuperuser || session.isCommsSteward` from the baseline) — no drift found across this family.

## Part C — Gap audit (export to tracker)

| # | Gap | Invariant violated | Severity | Status |
|---|---|---|---|---|
| 1 | `honors_curator` can lose the whole console nav on `/edit` | I1, I2 | High — role lockout, reproduces #1767's shape one layer up | Confirmed, unfixed |
| 1b | `isDeveloper` unread on `/edit`, no Funding-matcher entry point | I1 | Medium — deep link still works | Confirmed, unfixed |
| 2 | News tab can show a link that 404s | I2 | High — user-facing breakage | Confirmed, unfixed |
| 3 | Administrators tab unreachable for a non-superuser unit Owner | I2 | High — contradicts locked decision D5; a test pins the bug as intentional | Confirmed, unfixed |
| 4 | `/edit/units` doesn't surface Usage or Reports | I1, I2 | Medium | Confirmed, unfixed |
| 4b | A comms_steward who also owns a unit loses the Units tab on `/edit/administrators` | I3 | High — silently drops an already-earned tab; the "buried" finding | Confirmed, unfixed |
| 5 | A superuser with zero reportable centers 404s on a tab visible to them | I2 | Low — structurally real, no known live trigger | Confirmed, unfixed, edge case |

None of these has a tracking issue yet — they live only in this doc. Filing them is a deliberate follow-up decision, not done as part of this revision (see the handoff for that call).

**Gap 1 — a pure `honors_curator` landing on `/edit` (self-edit) may get no console nav at all, Honors tab included.**
`app/edit/page.tsx`:
```ts
const hasUnitGrants = manageableUnits.length > 0;
const showConsoleNav = canBrowseProfiles || commsSteward || hasUnitGrants;
```
`honorsCurator` is resolved two lines earlier (for `pendingHonors`) but never ORed into `showConsoleNav`. When all three of `canBrowseProfiles`/`commsSteward`/`hasUnitGrants` are false, `consoleNav` is `undefined` and `AdminSubnav` never renders — reproducing the exact #1767 shape ("an honors surface nobody could find") one layer up, in the gate that decides whether to render the strip at all, rather than in the Honors tab's own (already-correct) `show` boolean.
*Fix:* `const showConsoleNav = canBrowseProfiles || commsSteward || hasUnitGrants || honorsCurator;` — or, once Part B §2 lands, this whole gate becomes `visibleTabCount(await loadConsoleTabs(...)) > 0`, closing the class rather than the instance.

**Gap 1b — `isDeveloper` is never read in `app/edit/page.tsx`.** No reference to it anywhere in the file (confirmed by grep), and the page uses `getSession()`, not `getEffectiveEditSession()`, so no `EditSession.isDeveloper` value is even available to check. A pure `development`-role viewer has no path from their own `/edit` landing page to `/edit/find-researchers` / `/edit/matcha` / `/edit/grant-matcha`.

**Gap 2 — the News tab can show a link that 404s.**
`admin-subnav.tsx`: `show: (superuserSurfaces || profilesTab) && isNewsQueueEnabled()`. This piggybacks on `profilesTab` — but `app/edit/scholars/page.tsx` sets `profilesTab={unitScope !== null}`, true for *any* non-empty scope, including a plain unit Owner/Curator who is neither superuser nor comms_steward. `lib/edit/news-queue.ts` defines a dedicated, correct predicate — `isNewsQueueTabVisible(session)` (`isNewsQueueEnabled() && (isSuperuser || isCommsSteward)`) — that is **never called anywhere** (confirmed: its only occurrence in the repo is its own definition). A unit Owner/Curator with the news flag on sees "News" on `/edit/scholars`, then hits `app/edit/news-queue/page.tsx`'s `notFound()` gate.
*Fix:* `show: isNewsQueueTabVisible(session)` — the predicate already exists, is already correct, and is already exported; it just needs to be called.

**Gap 3 — the Administrators tab is unreachable for a non-superuser unit Owner, contradicting a locked spec decision.**
[`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) Decision D5: *"Administrators tab audience: superusers AND unit Owners... supersedes the 'superuser-only at launch' language."* `app/edit/administrators/page.tsx` implements the D5 query-side scoping via `loadOwnerManagedUnitScope`. But:
- `lib/edit/console-tabs.ts`: `administratorsTab: session.isSuperuser && isAdministratorsTabEnabled() ? 0 : null` — hard-gates on `isSuperuser`.
- `admin-subnav.tsx`: `show: superuserSurfaces && administratorsTab !== null && administratorsTab !== undefined` — hard-ANDs on `superuserSurfaces` too, unlike the sibling `methodsTab`/`dataQualityTab`/`dataSharingTab` gates, which trust the count-vs-null signal alone.
- No page — including `app/edit/administrators/page.tsx` itself (`unitsTab={session.isSuperuser}`, nothing else) — ever ORs an owner signal into `administratorsTab`.
- `tests/unit/admin-subnav.test.tsx`'s `"superuserSurfaces=false shows ONLY Method families"` test (~line 148, assertion ~line 156) passes `administratorsTab={0}` alongside `superuserSurfaces={false}` and asserts the tab is absent — pinning the bug as intentional, a few dozen lines from the test (~line 376, `"🔴 shows the tab to a NON-superuser honors_curator"`) documenting the identical shape already fixed for Honors per #1767.

Net effect: an Owner who *can* open `/edit/administrators` (the content renders in full, scoped correctly) has no nav entry point to it anywhere in the app, and no highlighted tab even while standing on that page.
*Fix:* thread an owner-scope signal (`loadOwnerManagedUnitScope` already computes it server-side for the page's own content — or, once Part B §2 lands, `isAdministratorsTabVisible(session, ownerUnitCount)`, already added) into `administratorsTab`; drop the `superuserSurfaces` AND in `admin-subnav.tsx`'s gate to match its siblings; update the pinning test.

**Gap 4 / 4b — `/edit/units` doesn't surface Usage or Reports, and `/edit/administrators` drops Units for a comms_steward who also owns a unit.**
`app/edit/units/page.tsx` loads `units = await loadManageableUnits(...)` and already ORs `units.total > 0` into `dataQualityTab` — but never passes `usageTab` or `reportsTab`. `canViewUsage` (`lib/edit/usage-access.ts`) grants Usage to any `UnitAdmin` grant holder — a subset of `units`. `loadReportableUnitsForActor` (`lib/edit/cancer-center-reports.ts`), for a non-global viewer, reads the same `loadManageableUnits(...).centers`. So a unit Owner/Curator with a reportable center and/or any grant, landing on the page whose own doc comment says it's "no longer a navigational dead end," still can't reach Usage or Reports from there.

The related bug on `/edit/administrators`: `unitsTab={session.isSuperuser}` is passed unconditionally, and per Part B §1b that **replaces** the baseline (`session.isSuperuser || session.isCommsSteward`) rather than OR-ing into it. A pure comms_steward with no owned unit never sees this — the page's own authz gate 403s them before `ConsoleShell` renders at all (`loadOwnerManagedUnitScope` returns `[]`, `scope.length === 0`). It's a comms_steward who **also** owns ≥1 unit — who does pass that gate — for whom the replace silently drops a tab their role alone already earned: a monotonicity (I3) violation, not a broader parity gap. Git blame (`e7175df8`, #977) shows the literal predates `ConsoleShell`/`deriveConsoleTabs` — at the time, `unitsTab={session.isSuperuser}` *was* the complete, correct value for this page; it became a footgun once the page was later migrated onto the shared shell and its baseline grew a comms_steward case the page-level override was never revisited to match.
*Fix:* delete the `unitsTab={session.isSuperuser}` line — omitting the prop lets `ConsoleShell` keep the `deriveConsoleTabs` baseline unmodified, exactly like every other console page that has no reason to narrow it. No new query needed; on `/edit/units`, add `usageTab={await canViewUsage(session, db.read)}` and `reportsTab={(await loadReportableUnitsForActor(session, db.read)).length > 0}`.

**Gap 5 — a superuser with zero reportable centers 404s on a tab that's visible to them (Part B §3).** `EditReportsIndexPage`'s `reportableUnits.length === 0 → notFound()` branch has no superuser carve-out, and `admin-subnav.tsx` shows Reports to every superuser unconditionally (`superuserSurfaces || reportsTab`). No known environment triggers this today — every deployed env has centers with a program taxonomy — but it is a real I2 violation if that ever isn't true (e.g., a from-scratch environment before any center is seeded), not merely a theoretical one.

## Verified conformant — not a gap

- `CONSOLE_SUBNAV_GROUPED` — presentation-only (Part B §1d).
- Superuser gets a uniform experience on every page; no page-specific drift found for that role.
- The five numbered Reports pages + both index branches — consistent `reportsTab` wiring throughout (Part B §3).
- `canViewDataSharingDashboard` and `isDataSharingDashboardTabVisible` are the same function under two names — no divergence.
- The Cores tab now has a comms_steward escape hatch (`coresTab`, mirroring `newsTab`/`reportsTab`) per the 2026-08-26 policy widening (decision #6). The remaining gap — no *owner-scoped* index for a plain core owner/curator — is still self-documented as deliberately deferred in `app/edit/core/page.tsx`'s own comment ("an owner-scoped index is a future add") — unlike Gaps 1–5 above, this one isn't silent.
- Curators correctly excluded from Administrators (Part A §2, D5) — matches D5's Owner-only wording exactly.

## Related docs

- [`role-aware-navigation-entry-points-spec.md`](./role-aware-navigation-entry-points-spec.md) — the layer before this one (account-menu entry points).
- [`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) — Decision D5, the source of Gap 3.
- [`apollo-surface-language.html`](./mockups/apollo-surface-language.html) — the visual design system the Reports pages (Part B §3) are styled against.
- [`comms-steward-methods-visibility-spec.md`](./comms-steward-methods-visibility-spec.md) — the comms_steward role definition referenced throughout Part A.
- [`lib/edit/console-tabs.server.ts`](../lib/edit/console-tabs.server.ts), [`tests/unit/console-tab-matrix.fixture.ts`](../tests/unit/console-tab-matrix.fixture.ts), [`tests/unit/console-tab-matrix.test.ts`](../tests/unit/console-tab-matrix.test.ts) — the executable form of Part A, proposed but not yet wired (Part B §2).
