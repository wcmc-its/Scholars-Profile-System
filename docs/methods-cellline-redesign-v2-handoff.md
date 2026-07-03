# Methods cell-line redesign — Spec v2 implementation handoff

**Created:** 2026-06-21 · **Owner:** Paul Albert
**Spec:** `docs/methods-cellline-redesign-spec.md` (on master). The **v2 update** lives as a diff at
`~/Downloads/methods-cellline-redesign-spec.diff` and **applies cleanly** to the master spec —
landing it is Step 0 below.
**Prior art:** `docs/methods-cellline-1166-entity-stage-plan.md`, `docs/methods-cellline-surfaceB-handoff.md`,
`docs/methods-cellline-redesign-plan.md`. Issues: **#1166** (rollout), **#1167** (Surface A / A3), **#1168** (Surface B UI).

---

## 0. Why this exists / current state

Surface B (cell-line discovery on `/methods/[supercategory]/[family]`) is **merged and LIVE on staging**:

- Data layer **#1182** (`family_entity` + `family_entity_usage`, ETL mapper, read APIs) + UI **#1184**
  (strip / directory / per-paper snippet feed), both behind flag **`METHODS_LENS_CELL_LINE_ENTITIES`**
  (staging-on `td sps-app-staging:70`, **prod-off**).
- v4 entity artifact published + `etl:scholar-tool` backfill (235 entity rows / 172 usage rows / 0 orphans)
  + Playwright render-verified on `…/methods/animal-cell-models/immortalized-cell-lines-fam_0032` (2026-06-21).

**Spec v2 is the response to that render-verify.** The live "Immortalized cell lines" directory exposed
four data-quality failures and one IA problem, all now written into the spec:

1. **§5.1 IA** — the strip sits *above* Spotlight today, two sections from the article list it filters.
   Selecting a cell line changes content scrolled off-screen. Move it to be the article list's own header.
2. **§7.1 entity resolution (NEW, the big pipeline ask)** — raw surface forms are neither canonicalized
   nor filtered: 43 rows that should be ~20–25, generic non-lines, phantom 0-count rows, *and* one
   over-merge (293 vs 293T).
3. **D5 snippet selection** — prefer the authors' own experimental use over a generic background claim.

The two are largely independent: **§5.1 is UI-only and shippable now**; **§7.1/D5 is a ReciterAI
pipeline + SPS data-layer effort** that can proceed in parallel.

This handoff also subsumes the **pre-flag-flip punch-list** already filed on
**#1168 (`issuecomment-4761897415`)** — items #1/#3 there are the same defects §7.1 addresses.

---

## 1. Workstreams

### WS-A — §5.1 master-detail (UI only, no data dependency) — **ship first**

> **v2.1 (2026-06-21) — supersedes the "reorder the strip" plan below.** After mockup review (`docs/mockups/methods-cellline-master-detail.html`), the decision is to adopt the **same master-detail layout the supercategory page already uses** (`FamilyRail` + publication feed) for cell-line families: a left rail of cell-line entities, the article feed on the right filtered by selection, inline `<mark>` highlight kept (the one true innovation). Retire `cell-line-strip` / `cell-line-directory`; **generalize `FamilyRail` → a neutral `RailItem`**; **gate Spotlight on record volume** (omit below ≈12 papers / <3 highlights); **no "All" row** (no-selection = default, click-active = clear); descriptor stacks beneath the name (FamilyRail convention). Folds in punch **#1** (non-evidenced → plain label) and **#3** (real distinct-pmid total). Spec §5.1/5.2/5.6/11/12 rewritten to match. The "reorder" text below is kept for history only.

Today (`app/(public)/methods/[supercategory]/[family]/page.tsx`):

```
Header (Definition + Top scholars)         ~section @ L163
{hasCellLines ? <CellLineDiscovery/> : tool-usage}   ~L225   ← strip (standalone, above Spotlight)
<Spotlight data={spotlightData} />         ~L256
<section id="publications"><FamilyPublicationLayout/>  ~L258  ← article list
```

Target (spec v2 §5.1):

```
Header (Definition + Top scholars)
<Spotlight/>                               ← rises to mid-page (curated highlights)
<section id="publications">
   <CellLineDiscovery/> as the FILTER HEADER, directly above…   ← strip moves down, becomes the list header
   <FamilyPublicationLayout/> (the article list it filters)
</section>
```

- Move `<Spotlight>` to render immediately after the header section.
- Move `<CellLineDiscovery>` (and the legacy tool-usage fallback) **inside** the `#publications` section,
  rendered as the header of `FamilyPublicationLayout`'s list — "A filter must be adjacent to the result
  it controls."
- Keep `?cellLine=` / `?dir=open` URL state working; the directory open state is unaffected.
- Files: `page.tsx`, `components/method/cell-line-discovery.tsx`, `components/method/family-publication-layout.tsx`.
- **Mock/test trap (#954):** `tests/unit/methods-loader-notfound.test.tsx` mocks `@/lib/api/methods` —
  reordering JSX doesn't change loader imports, but run the full methods suite before pushing anyway.
- No flag change, no data change → ships on the next CD image roll once merged. Low risk.

### WS-B — §7.1 entity resolution (ReciterAI producer + SPS data layer) — **the big ask**

This is a surface-form → canonical-id layer. It is **the Phase-2 directory prerequisite** — on raw
surface forms the directory is 43 padded/duplicated rows.

**ReciterAI producer** (`pipeline_tools/entities.py` `build_entity_layer`, + a new resolution module):
- **(a) Canonicalize surface forms → one `normalized_entity_id`** via a synonym/alias map. Acceptance
  cases observed on staging (Immortalized cell lines): HMC-1 appears 3× ("human mast cell line HMC-1",
  "HMC-1 cells", "cultured human mast cells (HMC-1)"); OKF6 2×; a NIH-3T3 / MEF / "mouse fibroblast model"
  / "fibroblast cells" cluster. True set ≈ 20–25, not 43. (`surface_form` = raw string; new producer field
  `entity_context`-side, pre-canonicalization.)
- **(b) Generics blocklist → `is_generic = true`**, excluded from strip + directory. Observed generics:
  "immortalized cell cultures", "immortalized basal cell lines", "macrophage cell line", "murine cell line".
- **(c) 0-count suppression** — entities whose in-scope `usage_count == 0` must not be emitted at all.
  (Observed phantom rows: "MEF cells", "MDCK cells", "NIH 3T3 cells".)
- **(d) Guarded NON-merge pairs** — bidirectional resolution: aggressive enough to merge HMC-1 ×3,
  conservative enough to keep **293 vs 293T** apart (293T carries SV40 large T antigen — biologically
  distinct; Crystal's group catches this on sight). Either keep as distinct leaves or use a "HEK293 family"
  `parent_entity_id` with 293/293T as separate forms — **never silently fold 293 into 293T.** Repro on
  staging: under the HEK293T filter, the F220C rhodopsin paper **PMID 34006992** matches on *HEK293* and
  its snippet highlights *HEK293*, sitting directly above a 293T-about-SV40 paper.
- **Net:** (i) synonym/alias map, (ii) generics blocklist, (iii) 0-count suppression, (iv) guarded
  related-but-distinct pairs. **Open question (§12):** how is the alias map maintained — curated / learned /
  hybrid — and who owns it.

**SPS data layer:**
- New column **`family_entity.is_generic Boolean @default(false)`** (the producer already nests via
  `parentEntityId`/`parentLabel`/`parentDescriptor`/`entityRole`). `surface_form` stays producer-side
  (no SPS column needed — SPS stores the canonical id + label).
- `etl/tools/family-entity-mapper-s3.ts`: read `is_generic`; the mapper already recomputes `evidenced`
  and drops dark-pmid facts (ADR-005). 0-count suppression should happen in the **producer** (don't emit),
  with the mapper as a defensive second gate.
- `lib/api/methods.ts`: `getFamilyCellLineEntities` / `getFamilyCellLineRailPreviews` /
  `groupCellLineDirectory` must filter `is_generic = false` and rely on the producer's 0-count suppression.

### WS-C — D5 informativeness-weighted snippet selection — Phase 3

- **ReciterAI:** compute **`informativeness_score`** per (publication × entity) usage sentence —
  "specific experimental use vs. generic background claim." Emit it on `entity_context.json`.
  Example to prefer: "…Nav1.3 heterologously expressed in HEK293T cells" over "…HEK293T cells are widely
  used in GMP facilities, producing higher yield of AAV vectors."
- **SPS:** new column **`family_entity_usage.informativeness_score Decimal? @db.Decimal(6,4)`**.
  `getFamilyCellLineUsageFacts` ranks **informativeness first, then `centrality_score`** (today it orders
  by centrality only). Heading wording (§4.2-A7 / D5): "How it was used" only when the chosen sentence is
  specific, else "Where it appears."
- Fixes the rail builder's `factByPmid` last-wins bug too (#1168 punch-list #2) — pick the top-ranked
  sentence per (entity, pmid), first-wins on the new ordering.

### WS-D — fold in the #1168 punch-list (issuecomment-4761897415)

- **#1 (non-evidenced cell lines render clickable → dead-end):** §7.1c suppresses 0-count rows entirely;
  for any non-evidenced survivors, gate clickability on `is_evidenced` (render as plain labels — Surface A
  pattern in `components/profile/methods-section.tsx`). The count-0 rows at the directory bottom on staging
  are exactly this.
- **#2 (`factByPmid` last-wins, `methods.ts:1280-1283`):** folded into WS-C.
- **#3 (`totalPapers={0}` hardcoded, `page.tsx`):** needs a real distinct-pmid total (not a sum of
  per-entity `usageCount` — that double-counts). Independent of WS-B; can land with WS-A.

---

## 2. Phasing (spec §11, mapped to workstreams)

| Phase | Work | Repos | Gate |
|---|---|---|---|
| **1** | **WS-A** (strip→list-header, raise Spotlight) + punch-list **#1/#3** | SPS | ship now, flag-gated dark |
| **2** | Directory side-sheet (D1) + URL state (D4) + **WS-B prerequisite** (§7.1 resolution) | ReciterAI + SPS | directory unusable until WS-B lands |
| **3** | Multi-select OR (D2) + **WS-C** (D5 informativeness) + **§7.1d** guarded pairs | ReciterAI + SPS | — |

WS-A and the §7.1 pipeline are **independent and parallelizable**.

---

## 3. Data model deltas

```prisma
model FamilyEntity {            // family_entity
  // …existing…
  isGeneric  Boolean @default(false) @map("is_generic")   // §7.1b — NEW
}
model FamilyEntityUsage {       // family_entity_usage
  // …existing…
  informativenessScore Decimal? @map("informativeness_score") @db.Decimal(6,4)  // D5 — NEW
}
```
Both additive/nullable → migrations apply cleanly to the populated staging tables (same posture as the
#1119 `exemplar_contexts` add). Manifest `schema_version` stays `tools-a2-v4` (additive sidecar fields)
unless the producer bumps it.

---

## 4. Key files

**SPS**
- `app/(public)/methods/[supercategory]/[family]/page.tsx` — render order (WS-A), `totalPapers` (#3)
- `components/method/cell-line-{strip,directory,discovery}.tsx`, `family-publication-layout.tsx`, `publication-feed.tsx`
- `lib/api/methods.ts` — `getFamilyCellLineEntities` / `…UsageFacts` / `…RailPreviews` / `groupCellLineDirectory` / `getFamilyPublications` (entity filter)
- `etl/tools/family-entity-mapper-s3.ts` — mapper (is_generic, informativeness)
- `prisma/schema.prisma` — `FamilyEntity` / `FamilyEntityUsage`
- `tests/unit/methods-loader-notfound.test.tsx` — the #954 mock trap

**ReciterAI**
- `pipeline_tools/entities.py` — `build_entity_layer`, `define_entity_parents` (§7.1 resolution lives here / a new module)
- `pipeline_tools/publish.py` — `entities.json` / `entity_context.json` bodies, `_split_artifacts`
- `pipeline_tools/context_quality.py` — `centrality_score`; add `informativeness_score`
- `prompts/entity_parent_define.py` — parent descriptors (already shipped)
- **`cli/publish_entity_sidecar.py`** — the entity-only sidecar publisher (see §5; uncommitted — commit it)

---

## 5. Rollout mechanics (reuse this session's recipe — there is a TRAP)

**Do NOT publish with `python -m cli.build_tool_taxonomy_corpus --publish`.** The corpus pipeline emits the
**pre-#239 fragment `tool_context` (3.61MB)**; a full publish overwrites the **live #239 sentence-aligned
`tool_context` (4.74MB)** and silently regresses the live `METHODS_LENS_TOOL_CONTEXT` feature. The
sentence-aligned rebuild lives in a *separate* `cli/rebuild_tool_context.py`, not the corpus pipeline.

**Use the entity-only sidecar publisher** instead: `cli/publish_entity_sidecar.py` (written this session,
**uncommitted** — commit it as the supported path). It re-runs the cache-warm corpus for the exact
`entities.json`/`entity_context.json` bytes and uploads only those two + a v4 manifest, asserting the live
`tools.json`/`families.json`/`faculty.json`/`tool_context.json` shas are preserved byte-for-byte. SPS picks
it up because `etl/tools/index.ts` short-circuits on a **composite sha over every manifest object**, so the
new entity-object shas trigger a `family_entity*` full-replace without disturbing tool data.

Per-publish sequence:
1. ReciterAI: `python cli/publish_entity_sidecar.py` (dry-run; ~40 min cache-warm corpus, prints `SAFE:`
   + the 5-key plan) → review → `--publish --reuse-bodies` (fast upload). Bucket versioning is on (reversible).
2. SPS backfill — in-VPC `aws ecs run-task`: cluster `sps-cluster-staging`, td `sps-etl-staging:13`,
   container `etl`, cmd `["npm","run","etl:scholar-tool"]`, `SCHOLAR_TOOL_SOURCE=s3` (baked in),
   subnets `subnet-019afebef588ee4b3`+`subnet-03de6e3dfe190288b`, SG `sg-09b494047547ea148`, no public IP.
   Dry-run (`-- --dry-run`) first; watch `mapped_entities` (entity_rows/usage_rows/orphan_facts=0) + `write_complete`.
3. Flag is already staging-on (td:70); no cdk needed unless a new flag is introduced.
4. Render-verify the family page (Playwright; public, no auth).

**PROD** is still gated: own `etl:scholar-tool` backfill (v4 artifact already in the shared bucket) +
flip `app-stack.ts` `env==="staging"?"on":"off"` → on + `cdk deploy Sps-App-prod`. Land §7.1 + punch-list
#1/#3 before flipping prod on for real users.

---

## 6. Gotchas

- **Publish trap** (§5) — full `--publish` regresses live `tool_context`. Sidecar-publish only.
- **Composite-sha detection** — SPS re-backfills when *any* manifest object sha changes (built for the
  #238 single-sidecar republish); an entity-only republish correctly triggers `family_entity*` rewrite.
- **#954 mock trap** — page-loader import changes need `tests/unit/methods-loader-notfound.test.tsx`'s
  `vi.mock("@/lib/api/methods")` updated; run the full suite before pushing.
- **Worktree prisma skew** — after rebasing onto advanced master, `npx prisma generate` before trusting `tsc`.
- **Canonical checkout is on `docs/spotlight-pipeline`** (behind master) — re-ground code refs via
  `git show origin/master:<path>` or a fresh worktree; don't trust working-tree line numbers.
- **`usage_count` is stored, not a groupBy** — the usage facts are a subset (only pmids with a usable,
  non-suppressed sentence). Don't assume usage rows == all in-scope papers.

---

## 7. Open questions (spec §12)

- **Alias-map ownership** (§7.1) — curated / learned / hybrid, and who maintains it as new surface forms appear.
- Does the cell-line strip pattern generalize to other "specific entity" axes (datasets, models, reagents)?
  Build the component generically from the start?
- Multi-membership cross-link cap (§5.5) before truncation.
- Expose `centrality_score` / `informativeness_score` in the UI, or keep internal-only.
