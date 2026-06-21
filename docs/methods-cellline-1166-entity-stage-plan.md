# #1166 — Specific-cell-line entity stage (the data gate for Surface B) — implementation plan

**Status:** plan only — *no code until approved* (plan §0 P-A; the ReciterAI corpus re-extraction is a real Bedrock cost worth a sign-off gate).
**Written:** 2026-06-20, after re-grounding all SPS code against `origin/master` (this working tree, `docs/spotlight-pipeline`, is 226 commits behind; Surface A PRs #1171/#1173/#1177 are merged on master) and reading ReciterAI `pipeline_tools` + the spec/plan/mockups.
**Forced order:** **#1166 (this plan, the data) → #1168 (the UI).** The UI has nothing real to bind to until the entity data exists.

> **BUILD STATUS (2026-06-20).** Plan approved → **#1166-A producer BUILT + validated on real data** (ReciterAI branch `feature/methods-cellline-entity-stage` off `origin/main`). Two real-data findings refined the design (see §1, §2.1, §3.1): (a) the collapse-hazard probe shows the tool registry already mints each specific cell line as its **own distinct tool record** (`3T3-L1 adipocytes` = `tool_000718`, `preadipocytes` = `tool_001070` — not collapsed), so the producer is a **pure projection over the assembled `tools.json`**, not a new registry; (b) `tool_context` only carries the pmids that have a usable snippet (a subset of `pub_count`), so per-entity `usage_count` cannot be a `groupBy` over the usage rows — the entity **dimension** and the (pub × entity) **facts** are **two artifacts / two tables**. Validated: 235 entities across 7 cell-line families, the `3T3-L1` two-form nesting correct, 96% of facts get an exact `matched_span`. ReciterAI tests green (74/74 relevant; full suite 2184 pass, 4 pre-existing/local-data failures).
>
> **SPS consumer (§3) also DONE** (worktree `~/worktrees/sps-1166-entity-data`, branch `feat/methods-1166-entity-data` off `origin/master`). Two tables `family_entity` + `family_entity_usage` (+ `parent_label` for the directory header) + migration; mapper `etl/tools/family-entity-mapper-s3.ts` (ADR-005 dark-pmid drop + `evidenced` recompute) wired into `etl/tools/index.ts`; read APIs `getFamilyCellLineEntities` / `getFamilyCellLineUsageFacts` / `groupCellLineDirectory` behind `METHODS_LENS_CELL_LINE_ENTITIES` (cdk staging-on/prod-off). **tsc 0, eslint 0, vitest mapper 5 + directory 4 + blast-radius 77 green; cdk app-stack 105 + snapshot; real producer sample round-trips (235 rows / 172 facts / nesting intact).** **The data gate is COMPLETE end-to-end, dark behind flags.** Remaining: **§4 the #1168 UI**, then operator deploy/backfill, then #1166-B.

Authoritative design: `docs/methods-cellline-redesign-spec.md` (on `origin/master`, §5 Surface B, §7 data, §8 decisions). Sequencing: `docs/methods-cellline-redesign-plan.md`. Kickoff: `docs/methods-cellline-surfaceB-handoff.md`. Mockups: `docs/mockups/methods-lens/surfaceB-*.html`.

---

## 0. Locked decisions (this cycle)

| # | Decision | Choice |
|---|---|---|
| D-v0 | Cosmetic v0 strip vs real entity layer | **Real entity layer (#1166).** No cosmetic relabel of tool-grain data — the spec refutes it and SPS would later have to un-wire it to avoid double-counting. |
| D-desc | Parent-descriptor text source (Q-4) | **ReciterAI emits it** (a small define-pass, mirroring `FamilyRegistry` definitions and the Q-5 "centrality upstream" principle). No SPS curation table. |
| D-A | Surface A (merged 1c rail) | **Park** behind `PROFILE_FACET_REDESIGN` (already prod-dark; no code change). Re-decide its presentation *after* #1166 lands real multiplicity/offsets. |

**Default design decisions taken here** (were open in spec §12 / handoff §7; not blocking, recorded so the build is unambiguous):

- **D4 URL scheme** — on the family page `/methods/[supercategory]/[family]`, encode state as query params: `?cellLine=<normalized_entity_id>&sort=<most_used|az>&dir=open`. Use `useSearchParams` + `router.replace(..., { scroll: false })`, mirroring the existing `?family=` deep-link pattern in `components/method/family-publication-layout.tsx` (type-B). The directory side-sheet (D1) is `dir=open`.
- **"Also matches" cap (§12)** — show ≤ **3** cross-links per article row, then "+N more" → opens the directory (or expands inline). Configurable constant.
- **New SPS flag** — `METHODS_LENS_CELL_LINE_ENTITIES` (staging-on / prod-off), consistent with the existing `METHODS_LENS_*` family.
- **Build the data layer generically** (spec §12) — the entity is "a specific named entity within a method family," not hard-coded to cell lines. Tables/APIs are entity-generic; only Surface B's copy/heading ("Specific cell lines used") is cell-line-specific in v1. This lets datasets/models/reagents reuse it later with no schema change.

---

## 1. Phasing — split #1166 to defer the expensive re-extraction

The single biggest cost is re-running the ReciterAI extraction (LLM/Bedrock) over the corpus. Most of Surface B does **not** need it, because specific cell lines already flow through extraction as their own tool `raw_name` records carrying `display_name`, `pub_count`, and `context_by_pub` (verified: ReciterAI `registry.py:281-286`; live staging probe shows *"3T3-L1 preadipocytes · 3T3-L1 adipocytes · MS1 VEGF angiosarcoma cells — 33 pubs"*). So:

| Increment | Delivers | Needs re-extraction? |
|---|---|---|
| **#1166-A** | Entity stage over **existing** extracted mentions → `normalized_entity_id`, `parent_entity_id` + descriptor (nesting), per-(pub × entity) `usage_sentence` (from existing `context_by_pub`), **server-recomputed** `matched_span`, `centrality_score` (port). New `entities.json` + `entity_context.json` artifacts. **SPS `family_entity_usage` table + mapper + read APIs.** | **No** — runs on already-extracted data + a cheap re-publish. |
| **#1166-B** | `entity_role`/`form` (A3 role nesting) + true multi-sentence-per-(pub × entity) multiplicity when one paper genuinely uses an entity in distinct roles. | **Yes** — widened extract prompt → corpus re-extraction (Bedrock cost; gate behind a scoped pilot). |
| **#1168** | The two Surface B mockups (strip + directory) on the family page. | No (consumes #1166 data). |

**#1166-A is real Surface B**, not the rejected cosmetic v0: real normalized entities, real nesting, real per-paper sentences, exact offsets. It just sources sentences from existing extractions instead of paying for a re-run. **Recommend shipping #1166-A first**, then #1166-B + #1168. The rest of this plan details A unless marked **[B]**.

> **Collapse hazard to verify first (probe in grounding step 2 below):** ReciterAI's `ToolRegistry` may already collapse `3T3-L1 adipocytes` and `3T3-L1 preadipocytes` into one tool via `surface_keys`/embedding match (`registry.py:54-103,219-237`). If so, the form distinction the directory needs is lost at the tool grain. The entity stage must therefore consume the **raw `_UniqueMention` forms (pre-collapse)**, not the collapsed tool records — `corpus_run.py` retains raw `raw_name` per mention. Confirm on a real cell-line family before building.

---

## 2. Part A — ReciterAI entity-resolution stage (the producer)

Repo `~/Dropbox/GitHub/ReciterAI`, axis = `pipeline_tools` (**NOT** `pipeline_cores` — the cores axis is core-facility attribution, a different problem; the current checkout is on `feature/cores-inference-pipeline` which is that out-of-scope branch). **Branch #1166 off ReciterAI `origin/main`**, do not build on the cores branch.

### 2.1 New `pipeline_tools/entities.py` — `EntityRegistry`
A sibling of `ToolRegistry`/`FamilyRegistry`, invoked in `corpus_run.py` **after** identity+classification and **after** families form (after ~`corpus_run.py:474`), so each entity can be tagged with its parent canonical tool and family.

- Consumes the raw `_UniqueMention` forms (pre-collapse) for tools whose family is a cell-line family (generic: any family whose `dominant_kind` is the cells bucket).
- **Mint `normalized_entity_id`** — opaque, durable across batches via `pipeline_tools.ids.IdMinter` (the `ToolRegistry` discipline, `registry.py:155`). Match-or-mint on a **stricter** surface key than tools use — **no descriptor-suffix stripping** (so `3T3-L1 adipocytes` ≠ `3T3-L1 preadipocytes` ≠ `3T3-L1`), exact-then-embedding-NN (`registry.py:219-237`).
- **Mint `parent_entity_id` + descriptor (D-desc)** — a second, coarser registry pass keyed on the entity stem (`3T3-L1` for both forms; `3T3` if the data warrants a third level — start with one parent level). The parent's `parent_descriptor` ("mouse fibroblast line") is generated by a small define-pass mirroring `FamilyRegistry.set_definition` (`registry.py:586`). Children carry `parent_entity_id`; top-level entities have it null.
- Back-pointers `canonical_tool_id` + `member_of_family` copied from the parent tool, so SPS can scope an entity to its family page.

### 2.2 `centrality_score` — port `nameFirstFraction` upstream (Q-5)
Move the source of truth from SPS to the producer. Port `nameFirstFraction` (`origin/master:etl/tools/tool-context.ts:108-120`) into `pipeline_tools/context_quality.py` (which already owns snippet acceptance). Per (pub × entity) candidate: `centrality_score = 1 - nameFirstFraction(usage_sentence, salient_name_forms(entity))` — entity named early (the subject) ⇒ high score. Used to (i) pick the best sentence when an entity has several in one paper, and (ii) drive the SPS eyebrow switch ("How it was used" vs "Where it appears", D5) without SPS re-deriving it. **Keep the SPS `nameFirstFraction` as a fallback** for un-upgraded artifacts.

### 2.3 Preserve multiplicity — the critical correctness fix
The blocker is `_merge_context_by_pub` (`registry.py:106-121`), which keeps **longest-wins** per (tool, pmid). For the entity layer, **union a list**, never collapse: emit `entity_context_by_pub: {pmid -> [ {entity_id, usage_sentence, span:[s,e], role?, centrality_score} ]}`, deduped by `(pmid, entity_id, span)`. For #1166-A, the source sentence is the existing `context_by_pub` entry for that (tool=entity, pmid); for **[B]** it's the per-mention `entities[]` sentence.

### 2.4 `matched_span` — recompute server-side (don't trust the model)
Char offsets of the entity term within `usage_sentence`. **Recompute server-side** in `extract.py:_clean_context` (`extract.py:85-102`) against the verbatim text (cheap, deterministic, avoids model-offset drift). For #1166-A this runs over existing sentences; no LLM call.

### 2.5 New publish artifacts + schema bump
In `publish.py:_split_artifacts` (`publish.py:117-179`), add two objects (additive; v3 consumers ignore them) and bump `PUBLISH_SCHEMA_VERSION` `tools-a2-v3 → tools-a2-v4`:
- **`entities.json`** — `{normalized_entity_id, display_name, parent_entity_id, parent_descriptor, canonical_tool_id, member_of_family (supercategory + family_label), usage_count, pmids[]}`.
- **`entity_context.json`** — `entity_id -> {pmid: [ {usage_sentence, span:[s,e], role?, centrality_score} ]}` (the per-(pub × entity) sentences).
Extend `_build_manifest` counts (`publish.py:211-216`) so the manifest composite signature (`index.ts:138-144`) changes when these republish.

### 2.6 [B] Extract-prompt widening (later increment, needs re-extraction)
Widen `EXTRACT_SYSTEM_PROMPT` (`prompts/tool_extract.py:48-100`) so each mention may carry `entities[]: {entity_name (verbatim), entity_role, usage_sentence (verbatim), span:[s,e]}`; keep `entities` a **list** in `normalize_mention` (`extract.py:111-136`); null out-of-vocab roles like `tool_category_hint` does. Validate scope with `cost_guard.py` + a scoped pilot (one cell-line family / sampled pubs) before any full corpus re-run.

### 2.7 Backfill
- #1166-A: re-publish from existing extractions (cheap) → new `entities.json`/`entity_context.json` land in S3 under the manifest.
- #1166-B: scoped pilot → full re-extraction (budgeted via `cost_guard`) → re-publish.

---

## 3. Part B — SPS data layer (consumer)

All refs re-grounded on `origin/master`.

### 3.1 Two new tables — entity DIMENSION + (pub × entity) FACTS (plan P-B; revised from one table)
**Revision (real-data):** `tool_context` keeps a snippet only for the pmids that have one (a subset of `pub_count`), so per-entity `usage_count` cannot be a `groupBy` over the usage rows — it would undercount. The entity **dimension** (one row per specific entity, carrying `usage_count = pub_count`, parent, descriptor) and the **(pub × entity) facts** (the sentences/spans) are therefore two tables, mapping 1:1 to the producer's `entities.json` / `entity_context.json`. Both keyed on the **stable `(supercategory, family_label)`** identity (not the rebuild-unstable `family_id`), matching `FamilySuppressionOverlay`'s FK-less posture. Generic ("entity"), not cell-line-specific.

```prisma
// DIMENSION — entities.json. One row per specific entity. Backs the strip ranking
// (usage_count) + the directory (parent nesting). usage_count is STORED here
// (= institution-wide pub_count), NOT a groupBy over the facts (which are a subset).
model FamilyEntity {
  id                 String   @id @default(uuid()) @db.VarChar(64)
  supercategory      String   @db.VarChar(128)
  familyLabel        String   @map("family_label") @db.VarChar(255)
  normalizedEntityId String   @map("normalized_entity_id") @db.VarChar(128)
  entityLabel        String   @map("entity_label") @db.VarChar(255)
  parentEntityId     String?  @map("parent_entity_id") @db.VarChar(128)
  parentDescriptor   String?  @map("parent_descriptor") @db.VarChar(255)
  entityRole         String?  @map("entity_role") @db.VarChar(64)        // [B]
  usageCount         Int      @map("usage_count")
  evidenced          Boolean  @default(false)                            // is_evidenced (§7) → clickable affordance
  sourceArtifactSha  String?  @map("source_artifact_sha") @db.VarChar(64)
  refreshedAt        DateTime @default(now()) @map("refreshed_at")

  @@unique([supercategory, familyLabel, normalizedEntityId])
  @@index([supercategory, familyLabel, usageCount(sort: Desc)])  // strip: ranked rows
  @@index([parentEntityId])                                       // directory: parent nesting
  @@map("family_entity")
}

// FACTS — entity_context.json. One row per (entity, pmid) usage sentence. Backs the
// per-(pub × entity) relevance snippet on a filtered article row. A LIST per
// (entity, pmid) in the artifact → one row each here (#1166-B may add >1 per pair).
model FamilyEntityUsage {
  id                 String   @id @default(uuid()) @db.VarChar(64)
  supercategory      String   @db.VarChar(128)
  familyLabel        String   @map("family_label") @db.VarChar(255)
  normalizedEntityId String   @map("normalized_entity_id") @db.VarChar(128)
  pmid               String   @db.VarChar(16)
  usageSentence      String   @map("usage_sentence") @db.Text
  matchedSpanStart   Int?     @map("matched_span_start")
  matchedSpanEnd     Int?     @map("matched_span_end")
  centralityScore    Decimal? @map("centrality_score") @db.Decimal(6, 4)
  entityRole         String?  @map("entity_role") @db.VarChar(64)        // [B]
  sourceArtifactSha  String?  @map("source_artifact_sha") @db.VarChar(64)
  refreshedAt        DateTime @default(now()) @map("refreshed_at")

  @@index([supercategory, familyLabel, normalizedEntityId])  // facts for a selected entity
  @@index([pmid])                                             // "Also matches" — entities on a paper
  @@map("family_entity_usage")
}
```
- The strip = `SELECT … FROM family_entity WHERE (supercat, family_label) ORDER BY usage_count DESC`; the bar = `usage_count / max(usage_count)` client-side. The directory adds parent nesting via `parent_entity_id`. The filtered per-paper snippet = join `family_entity_usage` on the selected `normalized_entity_id` ∩ the feed's pmids.
- Migration: a single migration with two `CREATE TABLE` (utf8mb4 / utf8mb4_unicode_ci, matching `20260609120000_add_scholar_family`). New tables → app role's existing DML grant covers them; no FK (key on a non-unique pair, like `FamilySuppressionOverlay`).

### 3.2 New ETL mapper `etl/tools/family-entity-mapper-s3.ts`
Sibling of `scholar-family-mapper-s3.ts`. Consumes the new `entities.json` + `entity_context.json` slice; resolves each entity's family to the stable `(supercategory, family_label)`; emits one `FamilyEntityUsageWrite` per `(supercategory, familyLabel, normalized_entity_id, pmid)` — **does not collapse** (the whole point). Reuses `tool-context.ts` helpers (`isUsableSnippet`, `clampSnippet`) for junk-filter consistency.

### 3.3 Loader wiring `etl/tools/index.ts`
Add the new slice exactly parallel to the optional `tool_context.json` handling (`index.ts:366-400`): fetch + sha256-verify, **optional** (a pre-v4 manifest is benign). Add a third `deleteMany()` + chunked `createMany({ skipDuplicates: true })` write block after the scholar_family block (`index.ts:507-530`), under the same `SCHOLAR_TOOL_SOURCE=s3` / dry-run gate, stamping `sourceArtifactSha`. **No new npm script** — `npm run etl:scholar-tool` already drives it.

### 3.4 Gating, suppression, overlay — re-apply at the new grain (must-not-skip)
Every new loader/read path must apply the same gates the existing methods loaders do, or it leaks:
- `isMethodsLensEnabled()` + the #800 suppression / #801 sensitivity overlay (`lib/api/methods-overlay.ts`) **before** counting.
- `isPubliclyDisplayed` role gate (as `getFamilyToolUsage` does, `methods.ts:292`).
- **ADR-005 publication suppression** per row — `loadAllPublicationSuppressions` (already loaded `index.ts:415`) in the mapper drops any `(pub × entity)` row whose pmid is dark / per-author-hidden; read APIs additionally apply `resolveDarkPmids`/`isAuthorHidden`.
- **Opaque-tool gate mismatch:** `selectBestSnippet` drops snippets for tools with global `pub_count > 4` (`MAX_PUB_COUNT_FOR_SNIPPET`). Cell-line entities are high-frequency by nature — do **not** inherit that gate for entities or it suppresses exactly the entities the strip ranks. Re-tune the entity threshold.

### 3.5 New read APIs (`lib/api/methods.ts`)
1. `getFamilyCellLineUsage(supercategory, familyLabel): CellLineStripRow[]` — ranked entities + per-entity `usage_count` (+ `parentEntityId`, `centralityScore`) for the strip. `groupBy` on the first index.
2. `getFamilyCellLineDirectory(supercategory, familyLabel): CellLineDirEntry[]` — all entities + `parentEntityId`/`parentDescriptor` for nesting; backs search/sort.
3. Entity-filtered article list — add an optional `entityId` to `getFamilyPublications` (+ the publications route allowlist `app/api/methods/.../publications/route.ts`) that intersects the feed pmids with the entity's pmids, OR a dedicated `getFamilyPublicationsForEntity`.
4. Per-(pub × entity) sentence — join `family_entity_usage` (`usage_sentence` + `matched_span_start/end` + `centrality_score`) onto the filtered hits (new optional field on `MethodPublicationHit`, e.g. `entityUsage?: { sentence; matchedSpan; centrality }`). Prefer **on-demand** (only when a filter is active) given the page is `force-dynamic` (`page.tsx:31`) with no ISR — don't add heavy entity queries to the page's baseline `Promise.all`.

---

## 4. Part C — #1168 Surface B UI (after the data lands)

Target `app/(public)/methods/[supercategory]/[family]/page.tsx` + `components/method/*`. Reuse the already-merged `ProvenanceRail` + `highlightSnippet` (now offset-driven via `matched_span`). Per spec §5 + the two mockups (which encode behavior via a `sendPrompt(...)` shim — replace each with real router/state/modal wiring):
- **§5.1 IA reorder** — Definition → Top scholars → **"Specific cell lines used"** (replaces "How researchers use these tools") → Spotlight → Research articles.
- **§5.2 ranked strip** — entity + count + proportional bar, **radio / single-select (D2 v1)**. **Do NOT reuse Surface A's checkbox control** (spec §8 hard rule — A = checkbox/multi, B = radio/single).
- **§5.3 rail** — reuse `ProvenanceRail`; eyebrow "Verbatim, from a paper using it"; persists on leave; source-publication link via `usePublicationModal()` (Surface A wiring in `components/profile/methods-section.tsx:273-290` is the pattern).
- **§5.4 filter + on-demand per-row snippet**, **§5.5 multi-membership "Also matches"** (cap 3), **§5.6 directory side-sheet** (search-within, Most-used/A–Z, parent nesting), **§5.7 filtered-list state** with context bar, **§5.8 baseline unchanged**.
- **D4 URL state** — `?cellLine=&sort=&dir=` (the page has none today).

---

## 5. Consolidated risks / gotchas

- **Drift trap.** Working tree is 226 behind `origin/master`; all Surface A code is on master. Re-ground every SPS symbol via `git show origin/master:<path>` — never cite the working tree.
- **Wrong-axis trap.** ReciterAI checkout is on the `cores` branch (out of scope). Branch #1166 off `origin/main`; touch only `pipeline_tools/*` + `prompts/tool_*`.
- **`family_id` instability.** Key everything on `(supercategory, family_label)`; `family_id` is re-minted each A2 rebuild.
- **Multiplicity regression** (the #1 correctness trap). Entity path must **union a list**, never `_merge_context_by_pub` longest-wins.
- **Surface-form collapse.** Entity registry must use the raw pre-collapse forms / a stricter key, or `3T3-L1 adipocytes` vs `preadipocytes` merge and the directory nesting dies.
- **Schema/consumer skew.** Once `entities.json` ships (v4), SPS must read the new sidecar, **not** infer entities from tool records — else double-count (tool + entity row for the same line).
- **`matched_span` trust.** Recompute offsets server-side; never trust model-emitted offsets.
- **Suppression at the new grain** (§3.4) — a dark/hidden pmid must drop the row; opaque-tool snippet gate must be re-tuned for high-frequency entities.
- **Full-replacement semantics.** `deleteMany` + `createMany` (no upsert); stamp `source_artifact_sha`.
- **Counts illustrative.** Mockup numbers (7 entities / 13 total / 33 papers) are placeholders; verify the §5.5 worked example (MS1 / 3T3-L1 / PMID 38321760) against real data before any data claim.

---

## 6. First moves (after approval)

1. **ReciterAI** — branch off `origin/main`; read `pipeline_tools/{registry,extract,corpus_run,publish,context_quality}.py` end-to-end; run the **collapse-hazard probe** on a real cell-line family (does `ToolRegistry` already merge the two 3T3-L1 forms?). Confirms whether #1166-A consumes raw mentions vs tool records.
2. Build `entities.py` (`EntityRegistry`) + the `centrality_score` port + server-side `matched_span` recompute + the two new publish artifacts (v4); re-publish from existing extractions; validate `entities.json`/`entity_context.json` on the *immortalized-cell-lines* family.
3. **SPS** — `family_entity_usage` migration + `family-entity-mapper-s3.ts` + loader wiring; run `etl:scholar-tool` against the v4 artifact; verify rows for the same family.
4. **SPS** — the read APIs (§3.5) behind `METHODS_LENS_CELL_LINE_ENTITIES`.
5. **#1168** — build the two mockups against real data; staging render-verify on a real cell-line family.
6. **[B]** — scoped extract-prompt pilot → budgeted re-extraction → role/form nesting.

**Verification gates (per global rules):** nothing is "done" until CI is green *and* the family page render-verifies on staging against a real cell-line family (e.g. `immortalized-cell-lines-fam_0032`). Local `tsc`/build is not sufficient.

---

## 7. Still-open (small; not blocking the build)
- Whether a 3rd nesting level (`3T3-L1` under `3T3`) is warranted — start with one parent level; revisit if real data shows deep families.
- §12 "expose centrality in UI" — keep internal-only in v1 (drives selection + heading), don't surface the score.
