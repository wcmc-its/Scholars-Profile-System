# Handoff — Overview generator: three-state drawer, Phase 2 (the UI)

Date: 2026-06-19. Author of Phase 1: prior session. Issue: #742.

This continues the overview-generator content-selection redesign. **Phase 1
(backend + model + persistence) is built, CI-green, and open as PR #1135.** Phase
2 is the three-state drawer UI that consumes it. The approved spec is the
contract; everything below maps spec → the code that now exists → what to build.

---

## 1. Current state — three open PRs (none merged; review-only)

| PR | Branch | What | CI | Notes |
|----|--------|------|----|-------|
| **#1132** | `opt/overview-generator` | A+B+C prompt-grounding: `toModelFacts()` drops impact / impactJustification / facultyMetrics from model-facing FACTS, bans puffery/h-index | GREEN | No flag (prompt-only). Worktree `~/worktrees/sps-overview-opt`. |
| **#1133** | `docs/overview-generator-selection-spec` | The approved spec + drawer mockup moved into `docs/`; §8 closed | GREEN | Docs only. Worktree removed (was `sps-overview-docs`). |
| **#1135** | `feat/overview-source-selection` | **Phase 1 foundation** (this handoff's basis) | GREEN, MERGEABLE/CLEAN | Worktree `~/worktrees/sps-overview-foundation`. **1 commit behind master** as of writing (the #1134 tool-context flag-flip; no conflict). |

**Suggested land order:** #1133 (docs) → #1132 (prompt) → #1135 (foundation) →
Phase 2 UI. None are interdependent in code, but #1135 is the contract Phase 2
builds on, so merge it (or at least settle review) before Phase 2 lands.

The spec lives at `docs/overview-generator-selection-spec.md` and the drawer
mockup at `docs/mockups/overview-generator/source_drawer_three_state_selection.html`
(embed fragment) + `…_preview.html` (standalone; serve over HTTP, Playwright
blocks `file://`).

---

## 2. What Phase 1 gives Phase 2 (the contract)

All shipped behind the existing `SELF_EDIT_OVERVIEW_GENERATE` flag. **Everything
is additive — `defaultSelected` and the live generator are unchanged.**

### Data: `GET /api/edit/overview/source-options` → `OverviewSourceOptions`
(`lib/edit/overview-facts.ts`). Now also carries, per record:
- **publications:** `tier` (`core|supporting|minor`, backend-only — DO NOT render
  as a label), `isLandmark`, `featured` (in the §5.1 auto-set), `reason`
  (numberless), `recommendedRank` (position in Recommended order). `impact` is
  still present but is backend-only — never render it.
- **funding / tools:** `reason` (numberless), `featured`.
- **`titles`** (NEW, optional array) — `OverviewSourceTitle`: `id`, `title`,
  `organization`, `isPrimary`, `isInterim`, `isCurrent`, `endYear`, `featured`,
  `reason`. From the `appointment` table, significance-thresholded.
- **`education`** (NEW, optional array) — `OverviewSourceEducation`: `id`,
  `degree`, `institution`, `field`, `year`, `featured`, `reason`.

### Model: `lib/edit/overview-params.ts`
- `OverviewSelectionDeltas = { pinned, excluded, publicationPositions, fundingRoles }`
  — `pinned`/`excluded` are per-type id bags (`publication|funding|method|title|education`);
  the two toggles are `"led"|"all"`.
- `normalizeOverviewSelectionDeltas(raw)` — untrusted boundary (use on any client input).
- `applyDeltas(featured, pinned, excluded)` = `(featured ∪ pinned) \ excluded`.
- `isOverviewSelectionDeltasEmpty(d)` — true ⇒ status line reads "auto".
- `summarizeOverviewDeltas(d)` → `{ pinned, hidden }` for the status line.
- `DEFAULT_OVERVIEW_SELECTION_DELTAS`, `OVERVIEW_DELTA_MAX_PER_BAG`.

### Persistence + route
- `GET/PUT /api/edit/overview/selection` (`app/api/edit/overview/selection/route.ts`)
  reads/writes the deltas, same `authorizeOverviewWrite` predicate + flag as the
  other overview routes. Body shape: `{ deltas: OverviewSelectionDeltas }`.
- Store: `lib/edit/overview-selection-store.ts`
  (`loadOverviewSelectionDeltas` / `saveOverviewSelectionDeltas`).
- Table `overview_source_selection` (migration `20260618170000`).

### §5.1 ranking (pure)
`lib/edit/overview-representative.ts` — `rankRepresentativePublications(candidates, opts)`
→ each candidate tagged `rank`, `tier`, `isLandmark`, `featured`, `reason`, `score`.
Already wired into `loadOverviewSourceOptions`.

### Generator wiring
`assembleOverviewFacts(cwid, selection?, { deltas })` — when there's no explicit
snapshot, it applies the durable deltas on the default auto-set. The generate
route already loads + passes them.

---

## 3. Phase 2 build — the three-state drawer UI

The drawer to replace is `components/edit/overview-source-drawer.tsx` +
`components/edit/overview-include-picker.tsx` (today: a buffered checkbox picker
with a "14 of 25" budget counter — the exact anti-pattern §2.5 rejects). Match
the mockup `docs/mockups/overview-generator/source_drawer_three_state_selection.html`.

Concrete tasks, roughly in order:

1. **Switch the drawer's state from a snapshot to deltas.** Replace the
   `OverviewSelection` (`{pmids,grantIds,toolNames}`) local buffer with
   `OverviewSelectionDeltas`. Seed from `GET /api/edit/overview/selection`; persist
   on Done via `PUT`. (Today the parent threads `selection`/`onSelectionChange`;
   rework `components/edit/overview-card.tsx` accordingly.)

2. **Three-state rows.** Each record renders default / pinned / excluded
   (§2.5). "Add merges into pin." Featured rows get exclude (+ pin-to-protect for
   the volatile types pubs/funding/methods); Available-tail rows get add/pin.
   Stable types (titles, education) are exclude-only on featured rows.

3. **Two tiers per type.** Feedstock (`featured: true`) shown; Available
   (`featured: false`) behind "+ show N more" / search (§3.2). Seeing is free;
   only pin/exclude writes a delta.

4. **Status line.** "Using your recommended set · N pinned · M hidden" via
   `summarizeOverviewDeltas` — counts divergences, NEVER "9 of 25". Zero deltas ⇒
   "Using your recommended set". Add "Reset to recommended" (clears deltas).

5. **The two toggles (§2.3).** Publications Led⇄all, Funding Led⇄all, wired to
   `deltas.publicationPositions` / `deltas.fundingRoles`. NOTE: the toggle is meant
   to change which candidates the *auto-set* draws from — see task 8; for now it at
   least needs to round-trip through the delta store.

6. **Publications sort control (§5).** Recommended (default) / Most cited / Most
   recent / Your role. Subtitle on Recommended:
   "your strongest led work · spread across your areas · landmarks kept regardless
   of age · duplicates merged." Sort ≠ selection — re-sorting only reorders.

7. **New types in the drawer.** Render `titles` (with the non-editable
   scaffolding line = name · primaryTitle · dept from the FACTS, deduped against
   the primary appointment) and `education`. Layer leadership-FK roles
   (chair/chief/director/program-leader) into Titles — Phase 1 only sources the
   `appointment` table; the leadership FKs (`Department.chairCwid`,
   `Division.chiefCwid`, `Center.directorCwid`, `CenterProgram.leaderCwid`) are not
   yet surfaced.

8. **Make §5.1 the LIVE auto-set.** This is the one behavior flip. Today
   `loadOverviewSourceOptions` + `assembleOverviewFacts` still use the legacy
   `pickDefaultSelection` for `defaultSelected`/the default generate; §5.1 is
   computed and exposed but not yet authoritative. Switch the auto-set to the
   §5.1 `featured` set and have the Led⇄all toggle feed the ranking
   (`authorPosition` eligibility). **This will change the 6 DB-mocked test files /
   64 assertions that pin the current default — update them deliberately (this is
   the #954-class trap; do it as its own commit).** Files: `overview-facts.test.ts`,
   `overview-source-options-route.test.ts`, `overview-generate-route.test.ts`,
   `overview-source-drawer.test.tsx`, `overview-include-picker.test.tsx`,
   `overview-card.test.tsx`.

9. **Reasons + evidence reveals.** "why this?" uses `reason`; methods "show
   evidence" surfaces the `sample_context` snippet (already in the FACTS as
   `exemplarContexts` via #1119 — confirm the drawer can read it or extend
   source-options if needed). Never render a number or a tier label (§4.3).

10. **Min-records guard (§2.5).** If excludes drop a type below threshold (e.g.
    < 3 pubs), surface "this leaves N papers; the overview will be brief."

---

## 4. Gotchas / conventions (learned in Phase 1)

- **Worktree env:** the SPS repo is a Dropbox repo; a fresh worktree needs
  `node_modules` (symlink to canonical: `ln -s <canonical>/node_modules node_modules`),
  `.env` + `.env.local` (copy from a sibling worktree), and `npx prisma generate`.
  Don't `npm ci` (fork/EAGAIN risk). `lib/generated/prisma` is gitignored.
- **DB-mocked tests:** any NEW `db.read.<model>` call breaks the unit tests that
  mock `@/lib/db` with an explicit model list — add the model + a `beforeEach`
  default, exactly like Phase 1 added `appointment`. Watch the route tests that
  mock whole modules (`overview-selection-store`, `overview-facts`).
- **Additive optional fields** kept existing `toEqual` fixtures compiling; where a
  strict deep-equal broke, switch to `toMatchObject` (subset). When you make §5.1
  the live auto-set, those become real value changes to update, not just shape.
- **Branch drift:** base every new branch off freshly-fetched `origin/master`
  (`feat/overview-source-selection` already drifted 1 behind from the parallel
  #1119 rollout). Re-ground code refs against `origin/master`, not the stale
  `docs/spotlight-pipeline` canonical checkout (~180+ behind).
- **Backend-only signals:** `impact`, `score`, and `tier` must never render in the
  UI or prose (§4.3). The drawer shows reasons + featured/available structure + order.
- Full suite is ~5348 tests / ~70s at `--maxWorkers=4`; run it (not just the
  overview files) before any PR — the #954 trap is cross-file.

---

## 5. Open design questions for Phase 2

- **`featuredLimit` for the live auto-set.** Phase 1 ranks with
  `featuredLimit = REPRESENTATIVE_LIMIT` (25, the combined budget). The Feedstock
  tier the bio actually uses is probably smaller — decide the featured-pub count
  when §5.1 goes live (task 8).
- **Near-duplicate `clusterKey`.** The §5.1 coverage pass supports dedup but Phase
  1 passes `clusterKey = null` (no study/program signal in the data yet). Decide
  whether to source one (e.g. shared trial id) or leave dedup dormant.
- **Tier thresholds.** Quantile cut points (`landmark 0.9`, `core 0.66`,
  `supporting 0.33`) and decay (`0.02/yr`, floor `0.5`) are documented defaults —
  calibrate against real scholars once the UI lets you eyeball results.
- **Toggle semantics for the auto-set.** Confirm Led⇄all should re-rank (change
  candidate eligibility) vs just re-filter — the spec says it changes what the
  auto-set draws from (§2.3).
