# Handoff — Overview generator: Phase 2b (Titles/Education + make §5.1 live)

Date: 2026-06-19. Issue: #742. Predecessor: Phase 2a = PR #1139 (squash `b5f30382`, merged to master).

This continues the overview-generator content-selection redesign. **Phase 1** (foundation:
§5.1 ranking + three-state delta model + `overview_source_selection` persistence — PRs #1133/#1132/#1135)
and **Phase 2a** (the three-state drawer UI for **publications · funding · methods** — PR #1139)
are merged and **additive/dormant** behind `SELF_EDIT_OVERVIEW_GENERATE`. Phase 2b makes the
selection model fully live and complete.

> ⚠️ Line numbers below are approximate (captured against master `7b1a0f54`; master is now `b5f30382`+).
> Re-ground every symbol via `git show origin/master:<path>` or a fresh worktree before trusting a line.

---

## 1. What Phase 2a already shipped (the base 2b builds on)

The drawer/picker now edit `OverviewSelectionDeltas` (three-state: pinned / excluded + two
position toggles), persisted via `GET/PUT /api/edit/overview/selection`. Key files:

- **`components/edit/overview-include-picker.tsx`** — three-state rows (default/pinned/excluded),
  Featured vs Available tiers, "+ N more — show", led⇄all toggle (pub+funding), publications sort
  (reorder-only), why/show-evidence reveals, thin-overview warning. **Renders pub/funding/method ONLY.**
  There is a comment block where the Titles & Education sections were removed — that's the 2b re-add point.
  `Section`/`RecordRow`/`SegmentedToggle`/`PublicationSort` are reusable; the `SectionSpec` type already
  carries `type: OverviewRecordType` for all five types and the per-type `pinnable` flag.
- **`components/edit/overview-source-drawer.tsx`** — deltas-buffered, status line, Done/Reset/discard.
- **`lib/edit/overview-resolve.ts`** (new) — `resolveOverviewSelection(options, deltas)` derives the
  generation snapshot from the deltas with **pins ordered first** (cap protection); `selectionToDeltas`
  maps a restored snapshot → deltas (#765). **Only handles pub/funding/method** (the snapshot types).
- **`components/edit/overview-card.tsx`** — holds the deltas (GET on mount / PUT on Done via
  `commitDeltas`), derives the resolved `OverviewSelection` that the existing generate/hints/#765 path
  consumes unchanged.

**The additive contract (DO NOT break):** with empty deltas the resolved selection equals the prior
default selection, so the live generator output is byte-identical (proven by the 2a review). The 6
DB-mocked default-selection suites pin this. Phase 2b's §5.1 flip is the deliberate moment that contract
changes — see §3.

**2a binding choice:** the Featured tier binds to `defaultSelected` (what generation actually uses today),
NOT the §5.1 `featured` field. Generation goes through the explicit-snapshot path
(`overview-card.tsx` posts `{ entityId, params, selection }` where `selection` = resolved snapshot).

---

## 2. Why Titles & Education were deferred (the gap to close)

`OverviewFacts` (`lib/edit/overview-facts.ts:~60`) is what the generator grounds on. Today:

- **`education`** IS in `OverviewFacts` (`:~100`), assembled by `assembleEducation(cwid)` (`:~945`) —
  but it is **NOT filtered by the deltas**, and `OverviewFacts["education"]` has **no id field**, so an
  `excluded.education` delta does nothing. → hiding an education row is currently inert.
- **`titles`** are **not in `OverviewFacts` at all** — `OverviewSourceTitle` exists only as a drawer
  candidate list in `loadOverviewSourceOptions`, and the title candidate list is appointment-table-only
  (the chair/director/chief/program-leader leadership-FK join is the "layered in by the PR-2 UI" TODO).

So rendering those two sections in 2a would have shipped a broken promise ("hiding affects this overview").
2b makes them real.

---

## 3. Phase 2b scope — the work

### 3.0 — DECIDE FIRST (5 gating design questions, on #742)

The §5.1-live flip cannot responsibly proceed until these are settled. My recommendations in parens:

1. **Featured-pub count.** `loadOverviewSourceOptions` ranks with `featuredLimit = REPRESENTATIVE_LIMIT`
   (25); the ranking module `DEFAULTS.featuredLimit = 12` (`lib/edit/overview-representative.ts`); the
   mockup shows a handful. *(Rec: 12 featured, rest Available — calibrate against a few real scholars.)*
2. **`clusterKey` dedup source.** §5.1 Dedup is scaffolded but inert — what key merges companion papers?
   *(Rec: prefer a precomputed cluster id from ReciterAI if available; else normalized-title+year+first-author.)*
3. **Tier-threshold calibration.** The MSM-style tiers/landmark come from the scholar's OWN impact
   distribution (scale-free). *(Rec: keep per-scholar percentiles; validate `featured`/`reason` on sample scholars.)*
4. **led/all re-rank semantics.** `publicationPositions`/`fundingRoles` should change which candidate
   pool the auto-set ranks over. *(Rec: led = first/last-author (pubs) / lead-role (funding) only; all =
   include middle-author / co-I. Toggle swaps the pool; pins/excludes preserved on top.)*
5. **Pin cap-protection policy** (review MEDIUM gap #1). *(Rec: protect pins within the 25-cap by ordering
   pins first before the slice — same as the 2a client resolver already does — plus warn if pins alone exceed budget.)*

Put these to the user as a focused `AskUserQuestion` set before writing the flip.

### 3.1 — Titles & Education sections (functional)

**UI** (`overview-include-picker.tsx`): re-add the two `<Section>`s at the deferral comment. The build
helpers were removed in 2a (git history of #1139 has them) — re-add `buildTitles`/`buildEducation`/
`titleMeta`/`educationTitle` and the `OverviewSourceTitle`/`OverviewSourceEducation` imports. Per §8 of the
spec: titles/education featured rows are **exclude-only** (`pinnable: false`, leading spacer not a pin);
Available-tail rows get add-and-pin. Titles needs the **scaffolding "Always shown" line** (primary title +
dept, from the `isPrimary` title) + the dedup line. Education subtitle: "Terminal and professional degrees…".

**Server (make the deltas bite):**
- **Education:** thread an `id` onto `OverviewFacts["education"]` (or filter inside `assembleOverviewFacts`),
  then apply `applyDeltas`/exclude for `deltas.excluded.education` / `pinned.education` before the facts are
  built. Education ids must match the `OverviewSourceEducation.id` the drawer uses.
- **Titles:** add a `titles` field to `OverviewFacts`; assemble it (significance threshold, `:~718`) +
  the **leadership-FK join** (chair/director/chief/program-leader tables — gap #3 — likely shares the
  Meyer program-leaders / center-leader tables, see #1117); filter by `deltas.{pinned,excluded}.title`;
  then surface it in the generator prompt.
- **Generator prompt seam (#1132):** `lib/edit/overview-generator.ts` `toModelFacts()` is an **allow-list**
  projection. Any new grounded field (titles, or a new per-record field) MUST be added to that allow-list or
  it is silently withheld from the model. `methods[]` auto-inherits via `...rest`; `representativePublications`
  does not. Keep the puffery/h-index suppression intact.
- **New `db.read` mocks:** the leadership-FK loader + any new education-id read break the DB-mocked unit
  tests — add the mocks (2a added `appointment`; follow that pattern in `overview-facts.test.ts`).

### 3.2 — Make §5.1 the live auto-set (THE #954 trap — its own commit)

This is the one behavior change. Today `assembleOverviewFacts` (`:~555-591`) else-branch (no explicit
snapshot) calls `pickDefaultSelection(candidatePubs, funding, methodFamilies)` (`:~264-287`, the live
auto-set) then `applyDeltas`. The §5.1 ranking (`rankRepresentativePublications`, `:~692-716`) is computed
ONLY for `loadOverviewSourceOptions` enrichment, never for the facts the model sees.

**The flip:** replace the `def` base in the else-branch with the §5.1 featured set (honoring the decided
featured count + led/all pool), and flip the picker's Featured-tier binding from `defaultSelected` → `featured`.
Do the same in the **client resolver** (`overview-resolve.ts` `resolveOverviewSelection` — its `defaultIds`
source switches from `defaultSelected` to `featured`) so the drawer and generation stay consistent.

**Pin-cap fix (gap #1):** in the else-branch, order surviving pins ahead of default-but-unpinned ids before
`selectedPmids.slice(0, REPRESENTATIVE_LIMIT)` (`:~594`) — `applyDeltas` currently tail-appends pins so a
pin past index 25 is silently evicted. Same shape for funding/tools. (The 2a client resolver already does
pins-first; mirror it server-side.)

**Tests:** this rewrites the ~64 default-selection assertions in `tests/unit/overview-facts.test.ts`
(and ripples to `overview-generate-route.test.ts`). **Do it as its own commit** and re-run the FULL suite
(~5354 tests), not just the overview files — this is the recurring #954 fixture-drift trap.

### 3.3 — led/all toggle server wiring (gap #2)

`deltas.publicationPositions` / `fundingRoles` are persisted + normalized but consumed nowhere in
`assembleOverviewFacts`. Wire them per decision #4: the toggle re-filters the candidate pool the auto-set
ranks over. Currently inert; the 2a UI toggle only reveals/hides rows for pinning.

### 3.4 — Server-side min-records guard (gap #6)

§2.5 "this leaves N papers; the overview will be brief" exists only client-side (the picker warning). Wire
it to the resolved selection server-side so a sub-3-paper selection produces an honestly brief overview.

### 3.5 — clusterKey dedup (gap #5)

Per decision #2, choose + populate a cluster key so §5.1 Dedup actually merges companion/duplicate papers.

---

## 4. Mapping the 7 review contract-gaps (on #742) to 2b tasks

| # | Gap | 2b task |
|---|-----|---------|
| 1 | Pin-loss at the 25-item cap | §3.2 pin-cap fix |
| 2 | led/all toggles inert | §3.3 |
| 3 | Leadership-FK roles not in `titles[]` | §3.1 titles server |
| 4 | `featured` ≠ `defaultSelected` for pubs | §3.2 the flip (rebind in lockstep) |
| 5 | `clusterKey` dedup unsourced | §3.5 |
| 6 | No server-side min-records guard | §3.4 |
| 7 | Pin-to-protect type-generic in data | §3.1 (UI enforces per-type control set) |

---

## 5. Recommended sequencing

1. **Decisions** (§3.0) — `AskUserQuestion`, capture in the spec/#742.
2. **Titles & Education** (§3.1) — additive (no flip yet); ship + verify they actually change the bio.
3. **§5.1-live flip + pin-cap** (§3.2) — its own commit; rewrites the 64 assertions; full-suite + update-branch.
4. **led/all wiring + min-records + clusterKey** (§3.3–3.5) — can be separate small PRs.

Each step is a candidate PR; the flip is the one that needs the most care.

---

## 6. Gotchas

- **Worktree + Turbopack:** a worktree's symlinked `node_modules` (pointing outside the worktree root)
  makes `next dev --turbopack` fail ("Symlink … points out of the filesystem root"). vitest/tsc are fine;
  for a live visual check run `npx next dev` (webpack) on port 3002. (A throwaway client preview page under
  `app/` with fixture data renders the picker without SSO/DB.)
- **Worktree setup (Dropbox repo):** branch off fresh `origin/master`; symlink `node_modules`, copy `.env*`,
  run `npx prisma generate` (custom output `../lib/generated/prisma`, so it doesn't touch the shared
  `node_modules`). Don't `npm ci`.
- **#954 trap:** run the FULL suite (not just overview), and `gh pr update-branch` onto current master so CI
  re-runs against the real merge target before merging.
- **toModelFacts allow-list (#1132):** new grounded fields are silently withheld unless added there.
- **Backend-only (§4.3):** never render `tier` / `isLandmark` / `recommendedRank` / raw `impact` — UI drives
  off `reason` + featured/available + order.
- **Status line (§2.5):** counts divergences ("N pinned · M hidden"), never "9 of 25".
- **Safety rules block `rm` / `kill` / `git branch -D` / remote `--delete` / `git reset`** — ask the user for
  worktree/branch cleanup; don't try to work around it.

---

## 7. Reference

- Spec: `docs/overview-generator-selection-spec.md` (merged via #1133) — §2 three-state, §4.3 backend-only,
  §5 sort, §8 per-type control table.
- Mockup: `docs/mockups/overview-generator/source_drawer_three_state_selection.html` (the full design incl.
  Titles & Education).
- Contract gaps + open questions: #742 (`issuecomment-4751275586`).
- 2a PR: #1139 (`b5f30382`). Phase-1 PRs: #1133/#1132/#1135.
- Memory: `project_overview_generator_selection_redesign.md`.
