# Plan — per-paper usage snippets for ALL tool/method family feeds

**Created:** 2026-06-22 · **Owner:** Paul Albert · **Status:** PLAN — awaiting approval (no code yet)
**Tracks:** SPS #1168 (consumer) · depends on ReciterAI #252 / #253 / #254 (producer, in flight)

---

## 1. Goal & why

On the cell-line family feed, each filtered paper shows a **per-paper usage snippet**: one verbatim sentence with the entity `<mark>`-highlighted + a **"How it was used"** badge (shipped in #1195/#1197). On a *tool/method* family page (e.g. `…/recombinant-protein-reagents-fam_0580`) there is no such treatment — we just removed the legacy "How researchers use these tools" prose strip (#1201), so those feeds are intentionally bare for now.

**This plan extends the cell-line per-paper snippet treatment to *all* tool/method families** — resolving the "I should see this everywhere" inconsistency with the *good* format rather than the old prose. It consumes the producer outputs from **ReciterAI #252/#253/#254** (assumed clean/ready; **no interim**).

---

## 2. Current state (grounded on master content via the cut-toolusage worktree)

The snippet pipeline is wired end-to-end and gated to cell-line families by **naming, not by schema**:

- `page.tsx:87,98,252` → `getFamilyCellLineEntities` → branch on `hasCellLines` → `CellLineRail` (left) + `FamilyPublicationLayout` (right)
- select a rail row → `?cellLine=<entityId>` → `publication-feed.tsx:102-104` → route validates `ENTITY_ID_RE` (`route.ts:60-63,109-113`) → `getFamilyPublications` (`methods.ts:1299-1306,1344-1347`) intersects family pmids with `getFamilyCellLineUsageFacts` and attaches `hit.entityUsage`
- `PubRow` renders `SnippetUsageBadge` + `highlightSnippet` (`publication-feed.tsx:358-364`)

**What actually blocks all-tools** is only:
1. the cell-line-named flag `METHODS_LENS_CELL_LINE_ENTITIES` (`methods-lens-flags.ts:226-227`) and reader names;
2. the `?cellLine=` URL param + rail copy ("Cell lines" / "CELL LINES" / "Filter cell lines…", `cell-line-rail.tsx:66-69`);
3. four **new producer fields** not yet in the schema/mapper — `is_generic`, `vocab_normalized_form` (#252), `informativeness_score`, `usage_class` (#253) — which the badge needs to stop defaulting every snippet to "How it was used".

The `family_entity` / `family_entity_usage` tables have **no entity-type column** (`schema.prisma:2138-2191`) and already store any entity kind. So no per-type table is needed — only additive columns.

## 3. Reusable as-is (no change)

- `highlight-snippet.tsx` `highlightSnippet` (offset-aware `<mark>` + ellipsis fallback) — fully generic
- `snippet-usage-badge.tsx` `SnippetUsageBadge` — **already typed `usage?: 'used' | 'appears'`** with both labels; only the call site (`publication-feed.tsx:362`, currently propless → defaults `'used'`) needs the WS-C value threaded in
- `entity-rail.tsx` `EntityRail` (neutral `RailItem[]`) — `CellLineRail` is a thin wrapper over it
- `family-entity-mapper-s3.ts` `buildFamilyEntityWritesFromS3` + `index.ts` entity-load block (sha256-paired-verify, ADR-005 dark-pmid suppression, evidenced recompute) — generic, only need additive field extraction
- `getFamilyPublications` entity-filter + `entityUsage` attach (`methods.ts:1299-1306,1342-1347`) — no entity-kind discrimination
- the `family_entity` / `family_entity_usage` tables — single shared, full-replacement load

## 4. Producer contract (ReciterAI #252/#253/#254 — assumed delivered)

| Field | Source | Level | SPS use |
|---|---|---|---|
| `is_generic` (bool) | #252 WS-B | entity dimension | suppress/soften generic entities ("macrophage cell line") |
| `vocab_normalized_form` (str) | #252 WS-B | entity dimension | canonical display label (293T→HEK293T); de-dups surface variants |
| `informativeness_score` (float ∈ [0,1]) | #253 WS-C | per (entity×pmid) fact | drives snippet show/hide + badge |
| `usage_class` (`usage`\|`mention`\|`other`) | #253 WS-C | per (entity×pmid) fact | badge label: `mention` ⇒ "Where it appears", else "How it was used" |
| `sentence_complete` hint + recomputed `matchedSpan` | #254 | per fact | already-tolerated by `highlightSnippet` ellipsis fallback; mapper validation only |
| `dominant_kind` (enum\|null) | **ReciterAI #260** | entity (copied from family) | rail header noun via a static kind→noun map; cell-line guard retained |

Producer PRs are **OPEN and stacked: #256 ← #257 ← #259**; `dominant_kind` passthrough is **#260** (sibling, additive). Artifact stays `entities.json` + `entity_context.json` (additive, v-next, no schema-version bump).

## 5. Implementation — 4 phases

**Phase 1 — Schema + mapper additive ingest (ships dark).** No reader/flag/UI change.
- `schema.prisma:2138-2191` — `FamilyEntity` += `is_generic Boolean @default(false)`, `vocab_normalized_form String? @db.VarChar(255)`, `dominant_kind String? @db.VarChar(32)` (ReciterAI #260, rail noun); `FamilyEntityUsage` += `informativeness_score Decimal? @db.Decimal(6,4)` (**match `centralityScore`'s scale**), `usage_class String? @db.VarChar(32)`; add `@@index([supercategory, familyLabel, isGeneric, usageCount(sort:Desc)])`; author migration.
- `family-entity-mapper-s3.ts:32-214` — extend `RawFamilyEntity`/`RawUsage`/`*Write` with the 4 fields (`?: unknown`, matching the existing graceful-degrade pattern), coerce via `bool()`/`str()`/`num()` + enum-guard for `usage_class`.
- `index.ts` entity write/log — pass the 4 fields through `createMany`; add is_generic-suppression count + usage_class/score distribution to the `mapped_entities` log.
- Backfill via `etl:scholar-tool` against the v-next artifact.

**Phase 2 — Read API + badge wire-through (behind new flag).**
- `methods.ts:323-454` — rename the 3 readers to neutral names (`getFamilyEntities` / `getFamilyEntityUsageFacts` / `getFamilyEntityRailPreviews`); SELECT the new columns; apply `is_generic` filter; map `usage_class`/`informativeness_score` onto the fact.
- widen `Hit.entityUsage` (`methods.ts:1342-1347` + `publication-feed.tsx:67-69`) to carry `usage` (`'used'|'appears'` derived from `usage_class`/score); thread into `SnippetUsageBadge` at `publication-feed.tsx:362`.
- new flag `isMethodsLensEntityUsageOn()` (`methods-lens-flags.ts`) + `.env.local` + `cdk/lib/app-stack.ts` (flag-parity rule). Cell-line surface keeps working.

**Phase 3 — Surface generalization (rail + URL + labels) for all families.**
- `?cellLine=` → `?entity=` (`publication-feed.tsx`, `route.ts`, `cell-line-rail.tsx`) — **keep `?cellLine=` as a back-compat alias**.
- rail header noun from a static **kind→noun** map keyed on `dominant_kind` (ReciterAI #260): instrument→Instruments, reagent→Reagents, dataset→Datasets, method→Methods, organism_or_cells→"Cell lines & models", assay→Assays, software→Software, model→Models; supercategory→noun as the null fallback; keep the `/cell line/i`+`organism_or_cells` guard so true cell-line families still read "Cell lines". Generalize `page.tsx` `hasCellLines`→`hasEntities` branch + `cellLineLabels`→`entityLabels` prop chain so non-cell-line families render rail + feed + snippets.
- confirm `ENTITY_ID_RE` (`route.ts:63`) still matches whatever id namespace #252 mints for non-cell-line tools.

**Phase 4 — Staging rollout + verify, then prod (gated).**
- backfill entity artifact on staging → flip `METHODS_LENS_ENTITY_USAGE` on (`cdk deploy --exclusively Sps-App-staging`) → Playwright-verify a non-cell-line family (e.g. `recombinant-protein-reagents-fam_0580`) shows ranked rail + per-paper snippet + correct usage/mention badge → prod off until prod entity data lands → narrow SPS #1168 to the remaining rollout step.

## 6. New flag

**`METHODS_LENS_ENTITY_USAGE`** → `isMethodsLensEntityUsageOn()`, paralleling `isMethodsLensCellLineEntitiesOn` and the `TOOL_CONTEXT` convention. **Recommend SUPERSET, not replace** — leave the already-staging-live cell-line surface on its own flag so the all-tools path can soak without regressing cell lines. Wire in **both** `.env.local` and the per-env block in `cdk/lib/app-stack.ts`.

## 7. Open decisions (need your call before/at execution)

1. **Rail label / entity-kind taxonomy — ✅ RESOLVED (2026-06-22).** A static supercategory→noun map is provably wrong: **7/13 populated supercategories mix kinds** (e.g. `therapeutics_interventions` = 30 reagent + 6 instrument families), so there's no single correct noun at the supercategory grain. Decision: drive the rail noun off the family's `dominant_kind` (the producer's existing 8-value `kind` enum, already computed as a plurality mode + published on the family record), via the static kind→noun map in Phase 3, with supercategory→noun as the null fallback and the `/cell line/i`+`organism_or_cells` guard retained. Producer passthrough filed as **ReciterAI #260** (sibling to #252-254; additive, sourced from `fam` already in scope, no schema-version bump). SPS-side: nullable `dominant_kind` column on `family_entity` (Phase 1).
2. **Badge thresholds:** exact `usage_class` + `informativeness_score` → "How it was used" vs "Where it appears"; and whether to *hide* the snippet below some score vs always show it with the softer badge.
3. **`is_generic` posture:** HARD (entity vanishes) vs SOFT (shown but collapsed/non-interactive, like the existing unevidenced-row Punch #1 treatment). Recommend SOFT for consistency.
4. **`vocab_normalized_form` storage:** overwrite `entity_label` in place (simpler) vs separate column (audit/fallback).
5. **Flag posture:** superset (recommended) vs replace `METHODS_LENS_CELL_LINE_ENTITIES`.
6. **Pilot families:** which non-cell-line supercategories get the rail first — depends on where #252-254 actually produced entity layers (all 14 supercategories vs cell-line + first tool families).

## 8. Risks / guardrails

- **Decimal scale:** use `Decimal(6,4)` (match `centralityScore`), not `Decimal(3,2)` — avoids silent rounding.
- **Nullability:** facts predating a full #253 run arrive with `informativeness_score`/`usage_class` = null → badge mapper must treat **null ≠ mention** (null ⇒ keep "used" default), else genuine usages get mislabeled.
- **Flag-rename regression:** renaming the cell-line flag outright darks the live cell-line surface mid-rollout → superset/alias avoids it.
- **URL alias:** keep `?cellLine=` working or break existing deep-links.
- **`ENTITY_ID_RE` namespace:** confirm #252 doesn't mint id shapes the `tool_`/`ent_` regex rejects (400s).
- **Partial/failed ETL:** full-replacement + sha256 paired-verify must fail the run rather than leave a family with new dimension + stale facts; confirm both artifact objects are always co-published.
- **Scope safety:** non-`#252-254` families must render the old no-rail path gracefully — the `hasEntities` branch is already empty-safe (readers return `[]` when off / no data).

## 9. Issue tracking

- **SPS #1168** (OPEN) — the consumer-side mirror; this plan is its residual scope. Narrow to "remaining rollout step" once the all-tools path is live on staging.
- **ReciterAI #252 / #253 / #254** (OPEN, PRs #256←#257←#259) — producer dependency; execution starts when these land clean.
- **ReciterAI #260** (OPEN) — `dominant_kind` passthrough onto `entities.json` for the rail noun; sibling to #252-254, additive, should ship in the same producer cycle.
