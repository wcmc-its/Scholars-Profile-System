# Handoff — Overview generator: Phase 2c (the §5.1-live flip + led/all + min-records + dedup + leadership-FK)

Date: 2026-06-19. Issue: #742. Predecessor: **Phase 2b Titles & Education = PR #1143 (squash `eb0b6296`, MERGED to master).**

This continues the overview-generator content-selection redesign. The state now:

- **Phase 1** (foundation: §5.1 ranking + three-state delta model + `overview_source_selection` persistence — #1133/#1132/#1135) — merged.
- **Phase 2a** (three-state drawer UI for **publications · funding · methods**) — PR #1139, merged.
- **Phase 2b** (titles & education deltas bite + UI + identity scaffold) — **PR #1143, merged (`eb0b6296`).**

Everything so far is **additive / dormant** behind `SELF_EDIT_OVERVIEW_GENERATE`. The §5.1 ranking is *computed and exposed in the drawer* but the model still grounds on the **v3.1 default rule** (`pickDefaultSelection`). Phase 2c makes the §5.1 set the live auto-set and wires the remaining mechanics.

> ⚠️ Line numbers below are grounded against master `eb0b6296` (post-#1143). They WILL drift. Re-ground every symbol via `git show origin/master:<path>` or a fresh worktree before trusting a line. Empirical findings hold; only code refs need re-grounding.

---

## 0. Decisions — ALREADY SETTLED (do NOT re-ask)

The 5 gating questions from the original §3.0 were put to the operator and decided. Build to these:

1. **Featured-pub count → keep 25.** The flip swaps the *source* of the featured set, NOT the size. `featuredLimit` stays `REPRESENTATIVE_LIMIT` (= `OVERVIEW_SELECTION_MAX_ITEMS` = 25). The ranking module's `DEFAULTS.featuredLimit = 12` is overridden by the explicit `{ featuredLimit: REPRESENTATIVE_LIMIT }` at the call site (`overview-facts.ts:789`) — leave it.
2. **led/all → swap the ranked pool.** `led` = first/last-author pubs + lead funding role only; `all` = also include middle-author / co-I. The toggle changes which candidate pool the §5.1 auto-set ranks over; pins/excludes always preserved on top.
3. **Pin overflow → pins-first + warn.** Order pins ahead of auto-selected before the 25-cap slice so pins are never silently dropped; warn if pins alone exceed the budget.
4. **Dedup → ReciterAI cluster id, else normalized title+year+first-author.** VERIFIED: **there is no `cluster`/`companion` column anywhere in the SPS Prisma schema**, and ReciterAI surfaces none to SPS — so this resolves to the **fallback** (normalized title + year + first-author). Don't go hunting for a cluster id.
5. **Tier calibration → keep per-scholar percentiles** (scale-free, from the scholar's own impact distribution). Validate `featured`/`reason` on a few real staging scholars; no fork.

---

## 1. What #1143 already shipped (the base 2c builds on)

- `OverviewFacts.titles` (significant current leadership roles beyond the primary) + titles/education resolved through the deltas (default = the candidate loaders' `featured` tier, pins reach the Available tail, excludes veto). `overview-facts.ts`.
- The **generate route loads the durable deltas unconditionally** (`app/api/edit/overview/generate/route.ts`) — titles/education are not in the `OverviewSelection` snapshot, so they resolve from the durable store on every path. Pub/funding/method behavior is unchanged because `assembleOverviewFacts` gates those on `hasExplicit`.
- `OverviewSourceOptions.identity` (name / primaryTitle / primaryDepartment) drives the picker's "Always shown" scaffold from the same strings the bio grounds on.
- `ADDITIONAL TITLES` grounding block + rule-3 "a title grounds the ROLE verbatim, not the specialty inside it" (consistent with VERIFY).
- `normalizeTitleForDedup(title)` helper in `overview-facts.ts` — reuse it for the leadership-FK dedup (§3.6).

**The additive contract still holds for pubs/funding/methods:** with empty deltas, the resolved pub/funding/method selection (and generator output) is byte-identical to pre-Phase-2. **The §5.1 flip (§3.2) is the deliberate moment that contract changes** — that's the whole point of this phase.

---

## 2. Phase 2c scope — the work

### 2.1 — The §5.1-live flip + pin-cap (THE #954 TRAP — its own commit, the centerpiece)

**Today** (`overview-facts.ts`):
- `assembleOverviewFacts` else-branch (no explicit snapshot): `const def = pickDefaultSelection(candidatePubs, funding, methodFamilies)` at **`:586`**, then `applyDeltas` over `def.*`, then `selectedPmids.slice(0, REPRESENTATIVE_LIMIT)` at **`:612`**.
- `pickDefaultSelection` (**`:277`**) = the v3.1 rule: first/last-author pubs (impact desc) + lead-role funding. This is what the **model grounds on**.
- The §5.1 ranking (`rankRepresentativePublications`) is computed ONLY by `rankCandidatePublications` (**`:768`**, called at **`:925`**) to enrich `loadOverviewSourceOptions.publications` with `featured`/`tier`/`isLandmark`/`reason`/`recommendedRank` — it never reaches the facts.

**The flip:**
1. In the else-branch (`:586`), replace the **publications** base with the §5.1 featured set (top-25 by §5.1 score, honoring the led/all pool from §2.2). Funding stays lead-role default; tools stay the pmid-floor default — only **pubs** flip to §5.1. (Compute the ranked set once and reuse for both the facts base and, ideally, the enrichment.)
2. Rebind the picker's **Featured tier** from `defaultSelected` → `featured`: `buildPublications` in `components/edit/overview-include-picker.tsx` currently sets `bucket: p.defaultSelected ? "featured" : ...` — change to `p.featured ? ...`.
3. Mirror in the **client resolver** so the drawer and generation agree: `lib/edit/overview-resolve.ts` `resolveOverviewSelection` (**`:51`**) derives `defaultIds` from `options.publications.filter((p) => p.defaultSelected)` (**`:58`**) — switch to `.filter((p) => p.featured)`. Do the SAME in `selectionToDeltas` (**`:101`**, the #765 "Use these settings" restore baseline, **`:108`**) so a restored snapshot diffs against the new default.

**Pin-cap fix (gap #1):** `applyDeltas` (`lib/edit/overview-params.ts:339`) appends pins at the **tail** (the second loop, `:353`), so a pin past index 25 is evicted by `slice(0, REPRESENTATIVE_LIMIT)` (`overview-facts.ts:612`). Fix: in the else-branch, order surviving pins **ahead** of default-but-unpinned ids before the slice (per decision #3). The 2a client resolver (`overview-resolve.ts` `resolveIds`, **`:25`**) already does pins-first — mirror it server-side. Add the "pins alone exceed budget" warning surface.

**Tests:** this rewrites the default-selection assertions in `tests/unit/overview-facts.test.ts` (~64 originally; #1143 added more) and ripples to `overview-generate-route.test.ts`, `overview-include-picker.test.tsx` (the `featured` binding), and `overview-resolve` tests. **Do it as its OWN commit**, re-run the FULL suite (~5390 tests, not just the overview files), and `gh pr update-branch` onto current master before merge — this is the recurring #954 fixture-drift trap.

### 2.2 — led/all toggle server wiring (gap #2) — COUPLED to the flip

`deltas.publicationPositions` / `fundingRoles` are persisted + normalized but consumed nowhere in `assembleOverviewFacts` (today the 2a/2b UI toggle only reveals/hides rows). Per decision #2, the toggle re-filters the **candidate pool** the §5.1 auto-set ranks over: `led` = first/last-author pubs + lead-role funding only; `all` = include middle-author / co-I. Because the flip (§2.1) computes the featured set over this pool, the two are coupled — implement together or flip first then layer the pool filter. Pins/excludes are preserved on top regardless.

### 2.3 — Server-side min-records guard (gap #6)

The §2.5 "this leaves fewer than 3 papers — the overview will be brief" warning exists ONLY client-side (`overview-include-picker.tsx` `MIN_PUBLICATIONS = 3`). Wire it to the resolved selection server-side so a sub-3-paper selection produces an honestly brief overview (e.g., a generator directive, or route it through the existing sparse / `hasSufficientFacts` path in `overview-facts.ts`).

### 2.4 — clusterKey dedup (gap #5)

Per decision #4 (fallback, since no cluster id exists in SPS): populate `clusterKey = normalize(title) + year + first-author` on the candidates fed to the ranker. `rankRepresentativePublications` (`lib/edit/overview-representative.ts`) already honors `clusterKey` in its coverage/dedup loop (`:243` adds, `:253` skips a non-landmark sharing a used cluster) — it's currently inert because nothing sets the key. Set it in `rankCandidatePublications` (`overview-facts.ts:768`) when building the `RankCandidate[]`. Landmarks are exempt from dedup (already handled in the ranker).

### 2.5 — Leadership-FK title augmentation (gap #3) — can be its own PR

Augment the title candidates + `OverviewFacts.titles` with chair/chief/director/program-leader roles recorded on the org-unit FK tables, to catch leadership missing from the appointment table (field_override-set leaders, ETL-missed cases like Stewart). Sources (verified in `prisma/schema.prisma`):
- `Department.chairCwid` (`:994`), `Division.chiefCwid` (`:1023`), `Center.directorCwid` (`:1065`) + `Center.leaderInterim` (`:1071`),
- `CenterProgramLeader` (`:1122`) + `CenterProgram.leaderCwid` (`:1108`).

For the target `cwid`, find units where this scholar IS the leader, synthesize a title string ("Chair, Department of X" / "Chief, Division of Y" / "Director, Z Center" / "Leader, P Program"), mark `featured` (current leadership), and **dedup** against the appointment-based titles AND `scholar.primaryTitle` using the existing `normalizeTitleForDedup` helper. Only add when the leader cwid == the scholar (external-leaders like Joel Stein are not this scholar, so a cwid match naturally excludes them). Add `db.read` mocks for the new loaders (follow the `appointment` pattern in `overview-facts.test.ts`).

---

## 3. Recommended sequencing

1. **§5.1 flip + pin-cap (§2.1) + led/all wiring (§2.2)** — coupled; one focused PR. Its own flip commit; rewrites the default-selection assertions; FULL suite + `update-branch`. This is the needle-mover and the riskiest.
2. **clusterKey dedup (§2.4)** — small, can ride with the flip PR or follow it.
3. **min-records guard (§2.3)** — small, separate.
4. **Leadership-FK augmentation (§2.5)** — its own PR.

---

## 4. Mapping the original 7 review contract-gaps (#742) to 2c tasks

| # | Gap | 2c task |
|---|-----|---------|
| 1 | Pin-loss at the 25-item cap | §2.1 pin-cap fix |
| 2 | led/all toggles inert | §2.2 |
| 3 | Leadership-FK roles not in `titles[]` | §2.5 |
| 4 | `featured` ≠ `defaultSelected` for pubs | §2.1 the flip (rebind in lockstep) |
| 5 | `clusterKey` dedup unsourced | §2.4 |
| 6 | No server-side min-records guard | §2.3 |
| 7 | Pin-to-protect type-generic in data | closed by #1143 (UI enforces per-type control set) |

---

## 5. Gotchas

- **#954 trap:** the flip rewrites the default-selection assertions. Run the FULL suite (not just overview), and `gh pr update-branch` onto current master so CI re-runs against the real merge target before merging. This trap has bitten every prior phase.
- **Rebind in lockstep:** `defaultSelected → featured` must change in BOTH the picker (`buildPublications`) AND the client resolver (`overview-resolve.ts` `resolveOverviewSelection` + `selectionToDeltas`), or the drawer and generation disagree.
- **Backend-only fields (§4.3):** never render `tier` / `isLandmark` / `recommendedRank` / raw `impact`. UI drives off `reason` + featured/available + order.
- **`toModelFacts` allow-list (#1132):** a new grounded field is silently withheld unless it rides via `...rest` or is explicitly re-projected (top-level fields ride `...rest`; `representativePublications` is re-projected).
- **Worktree setup (Dropbox repo):** branch off **fresh `origin/master`** into `~/worktrees/<name>` (outside Dropbox); `ln -s <canonical>/node_modules`, `cp <canonical>/.env*`, `npx prisma generate --schema prisma/schema.prisma` (custom output `lib/generated/prisma`, gitignored). Do NOT `npm ci`.
- **Worktree + Turbopack:** symlinked `node_modules` makes `next dev --turbopack` fail ("Symlink points out of the filesystem root"). vitest/tsc are fine; for a live visual check use `npx next dev` (webpack) on port 3002.
- **Stale predecessor worktree:** `~/worktrees/sps-overview-phase2b` is still on the now-merged `feat/overview-titles-education` (2+ commits behind master) and holds an untracked scratch `edu-probe.mjs`. Do NOT base 2c on it — branch fresh. (Cleanup of that worktree + the merged remote branch is pending the operator's OK — safety rules block `rm`/branch-deletion/`git worktree remove` without asking.)
- **Bounded test runners:** `vitest --maxWorkers=4`; `pkill -f 'vitest|esbuild|tinypool'` after isolated runs (macOS fork/EAGAIN guard).

---

## 6. Reference

- Spec: the overview-generator selection spec (§2 three-state, §4.3 backend-only, §5 sort, §8 per-type control table).
- Predecessor handoff: `docs/overview-drawer-phase2b-handoff.md` (the §3.0 decisions, the original gap analysis).
- 2b PR: #1143 (`eb0b6296`). 2a PR: #1139 (`b5f30382`). Phase-1: #1133/#1132/#1135.
- Tracker: #742 (Phase 2b progress comment `issuecomment-4753555948` records what landed + what remains).
- Memory: `project_overview_generator_selection_redesign.md`. Tool-context: `project_1119_tool_context.md`.
- Key symbols (master `eb0b6296`, WILL drift): flip seam `overview-facts.ts:586`; cap slice `:612`; `pickDefaultSelection:277`; `rankCandidatePublications:768`; `resolveOverviewSelection` `overview-resolve.ts:51`; `applyDeltas` pin tail-append `overview-params.ts:353`.
