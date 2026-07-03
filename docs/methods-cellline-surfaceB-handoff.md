# Methods & Tools redesign — Surface B (cell-line discovery) execution handoff

**Purpose:** kick off the work the redesign has actually been building toward — **Surface B**, the cell-line discovery on the method-family pages (`/methods/…`). The two target mockups are:
- `docs/mockups/methods-lens/surfaceB-method-page-cell-line-strip-filter.html` — the ranked **"Specific cell lines used"** strip + filter on a method page.
- `docs/mockups/methods-lens/surfaceB-all-cell-lines-directory.html` — the expanded **all-cell-lines directory** (searchable, sortable, parent-nested).

The authoritative design is `docs/methods-cellline-redesign-spec.md` (§5 Surface B, §7 data); sequencing is `docs/methods-cellline-redesign-plan.md`; the prior increment's handoff is `docs/methods-cellline-1c-handoff.md`.

> Written 2026-06-20 after Surface A (1a/1b/1c) merged. **Symbol/line refs drift — re-ground before trusting them** (`git fetch origin`; base off fresh `origin/master`).

---

## 0. TL;DR

- **Goal:** build the two Surface B mockups above on the method-family page.
- **Hard gate (do not skip):** they need a **specific-cell-line *entity* layer that does not exist yet** — normalized entities, per-entity counts, parent nesting, per-(pub × entity) sentences, `matched_span`. That is the **#1166 / Phase 2 entity-resolution stage** in **ReciterAI**. The mockup itself says so: *"Counts are illustrative — your extraction pipeline supplies the real set."*
- **Order is forced:** **#1166 (data) → #1168 (UI).** The UI has nothing to render without the entity data.
- **Surface A:** return to legacy. It's already legacy for users (the 1c rail is behind `PROFILE_FACET_REDESIGN`, **prod-off**). Recommendation: **park** the merged 1c rail behind its flag (don't delete) and re-decide Surface A's presentation *after* Phase 2, when real multi-instance data exists — see §2.

---

## 1. Where we are — the foundation is already merged

| Phase | Scope | Status |
|---|---|---|
| 1a | `scholar_family.exemplar_context_pmids` + modal source-pmid | **MERGED #1171** (`2e68fbcc`) |
| 1b | shared `ProvenanceRail` + `highlightSnippet` (reusable on Surface B) | **MERGED #1173** (`72b86c81`) |
| 1c | Surface A profile-panel rail (behind `PROFILE_FACET_REDESIGN`, prod-off) | **MERGED #1177** (`728f68b9`), staging render-verified |
| **2** | **#1166 entity stage — THE GATE for Surface B** | **not started — start here** |
| **3** | **#1168 Surface B UI (the two mockups)** | **not started — after the gate** |

What this leaves you, ready to reuse on Surface B:
- **`components/method/provenance-rail.tsx`** (`ProvenanceRail`) — presentational; props `{ item|null, placeholder, action, className }`; `item = { eyebrow, term, sentence, matchedSpan?, source? }`; `source` accepts `{ href?, onSelect?, label? }`. Built to be shared A↔B; **not yet rendered on `/methods`.**
- **`components/method/highlight-snippet.tsx`** (`highlightSnippet`) — **prefers `matched_span` offsets**, falls back to term-match. Once #1166 emits offsets, the Surface B highlight is exact for free.
- Issues: **#1166** (gate), **#1168** (Surface B), **#1167** (Surface A narrowed to A3 + `matched_span`, also gated on #1166).

---

## 2. Surface A disposition (trivial; do first or skip)

**For users, Surface A is already legacy** — `PROFILE_FACET_REDESIGN` is `env === "staging" ? "on" : "off"` (`cdk/lib/app-stack.ts`), so prod profiles render the original `#1119` panel. No prod action needed.

- **Recommended — park it.** Leave the 1c rail merged but flag-dark; re-decide Surface A's presentation (legacy vs hover-card vs rail) *after* Phase 2, because the reason it felt thin is the **single-exemplar + naive-string-match data** — that limitation disappears once #1166 lands multiplicity + offsets. Optionally flip `PROFILE_FACET_REDESIGN` **off on staging** too, **but note that flag also gates Topics rename / FilterBar / facet counts** — turning it off reverts all of those on staging, not just the methods rail.
- **Alternative — full revert.** Remove the redesign branch from `components/profile/methods-section.tsx` (keep only `LegacyExemplarToolsLine` / the flag-off render) and drop `ProvenanceRail` from the profile. Clean, but discards reviewed work that may be exactly right post-#1166.

> Confirm which you want; the rest of this handoff is Surface B regardless.

---

## 3. The two deliverables (what Surface B must become)

### 3a. Method-page "Specific cell lines used" strip + filter (mockup 1; spec §5.2/§5.4/§5.5/§5.7)
On `app/(public)/methods/[supercategory]/[family]/page.tsx`:
- A ranked strip of the **specific cell lines** the family resolves to (e.g. *3T3-L1 adipocytes — 11*, *HEK293T cells — 5*), each with a **usage count + proportional bar**.
- A persistent **rail** (reuse `ProvenanceRail`) previewing the verbatim sentence (with `matched_span` highlight) + **source publication** link.
- **Single-select (radio)** — selecting a cell line **filters the article list** below and reveals a **per-(pub × entity) relevance snippet** on each matching paper. *A paper using two cell lines surfaces a different sentence under each.*
- A "N more cell lines" expander → the directory (3b).
- **Deliberate divergence:** Surface B uses **radio/single-select**; Surface A uses checkbox/multi-select. **Do NOT unify the control** (spec §8, gotchas).

### 3b. All-cell-lines directory (mockup 2; spec §5.6)
- A searchable / sortable (**Most-used / A–Z**) index of every named cell line in the family.
- **Parent nesting** — e.g. the two *3T3-L1* forms nested under a shared parent *"3T3-L1 · mouse fibroblast line · 2 forms"*.
- Each row links to its **filtered article list**; the view is **URL-addressable** (D4).

---

## 4. Phase 2 / #1166 — the entity stage (BUILD FIRST)

What the mockups need that the pipeline must emit (none of it exists today — today's data is **tool/family display names + one best snippet per tool**):

| Field | Powers | Today |
|---|---|---|
| `normalized_entity_id` (the specific cell line) | the strip rows / directory entries | ❌ only tool/family display names |
| per-entity `usage_count` | the counts + proportional bars | ❌ counts only at family grain |
| per-(pub × entity) `usage_sentence` | the per-paper relevance snippets | ❌ rollup keeps **one** best snippet per tool |
| `parent_entity_id` (+ a parent descriptor string) | directory nesting ("3T3-L1 → 2 forms") | ❌ no parent / descriptor field |
| `entity_role` / `form` | A3 role variants (#1167) | ❌ |
| `matched_span` (char offsets) | exact highlight (vs naive string-match) | ❌ |
| `centrality_score` | snippet selection + heading switch (D5) | ❌ (heuristic lives in SPS only) |

**ReciterAI** (`~/Dropbox/GitHub/ReciterAI`, axis = `pipeline_tools` — **NOT** `pipeline_cores`, which is core-facility attribution, a different axis, out of scope):
- New **entity-resolution stage** below the `canonical_tool_id` registry (`pipeline_tools/registry.py`): mint/normalize specific entities → `normalized_entity_id`; link `parent_entity_id`; attach `entity_role`/`form`.
- Emit **`matched_span`** (offsets of the specific matched occurrence in the verbatim sentence) — `pipeline_tools/extract.py` + `prompts/tool_extract.py`.
- **Preserve `usage_sentence` multiplicity** per (publication × entity) — today's rollup collapses to one best snippet (`selectBestSnippet`).
- Emit **`centrality_score`** (port the `nameFirstFraction` heuristic up from SPS `etl/tools/tool-context.ts`).

**SPS:**
- New **`family_entity_usage`** table at **(publication × entity)** grain + a new ETL mapper (plan decision **P-B** — a real table, **NOT** a JSON extension of `exemplar_contexts`).
- New read APIs: per-family **ranked entity list** (+ counts), per-entity **filtered pub list**, per-(pub × entity) **sentence + offsets**.

---

## 5. Phase 3 / #1168 — the Surface B UI (AFTER the gate)

Target: `app/(public)/methods/[supercategory]/[family]/page.tsx` + `components/method/*`. Reuse `ProvenanceRail` (1b) + `highlightSnippet` (now offset-driven via `matched_span`).
- §5.2 ranked strip (entity + count + bar), **radio/single-select** (D2 v1).
- §5.4 filter → article list + per-(pub × entity) on-demand relevance snippets.
- §5.5 multi-membership **"Also matches"** cross-links (generalize to N/row; cap TBD §12).
- §5.6 directory side-sheet (search-within, Most-used/A–Z, parent nesting) — **URL-addressable (D4)**.
- §5.7 filtered article-list state; §5.1 IA reorder. **URL state (D4)** for filter+sort+side-sheet (the page has none today; `components/method/publication-feed.tsx` is sort + research/all only).
- Later: multi-select OR (D2), centrality-driven snippet selection + heading switch (D5).

---

## 6. Sequencing & first moves

**Forced order:** #1166 (data) → #1168 (UI). Suggested path:
1. (optional) Surface A disposition — §2.
2. **Ground + plan #1166 in ReciterAI** — read `pipeline_tools/{registry,extract}.py` + `prompts/tool_extract.py`; confirm exactly what the artifact emits today vs the §4 table.
3. **Feasibility probe (do this in grounding):** does the pipeline *already* emit any specific cell-line strings (even un-normalized) under a cell-line family? If so a **v0 strip** (ranked names + counts + one snippet) may be bootstrappable from existing tool-grain data while the full entity stage is built. Memory says the tool-usage strip is keyed to **display names, not entities** (entity layer = net-new) — so likely greenfield, but **verify on a real cell-line family** (e.g. *"Immortalized cell lines"*) on staging before assuming.
4. Build #1166 (ReciterAI stage + SPS `family_entity_usage` + mapper + APIs) → backfill.
5. Build #1168 UI per the two mockups.

**Grounding pointers (SPS):**
- Current `/methods` page: `app/(public)/methods/[supercategory]/[family]/page.tsx`; tool-usage strip `getFamilyToolUsage` in `lib/api/methods.ts`; feed `components/method/publication-feed.tsx`.
- Rollup: `etl/tools/tool-context.ts` (`selectBestSnippet`, `nameFirstFraction`), `etl/tools/scholar-family-mapper-s3.ts`.
- Reuse: `components/method/provenance-rail.tsx`, `components/method/highlight-snippet.tsx`.

---

## 7. Open decisions / gotchas

- **Surface A disposition** (park vs revert) — confirm (§2).
- **Parent-descriptor text** ("mouse fibroblast line") — **no §7 field supplies it** (prior handoff Q-4). Decide a source: ReciterAI emits it, or a curated lookup.
- **Directory/strip URL scheme (D4)** — the method page has **no URL state** today; design filter+sort+side-sheet routing.
- **Per-surface control divergence** — Surface B strip = **radio/single-select**; Surface A = checkbox/multi-select. **Do NOT unify** (spec §8).
- **`pipeline_cores` / cores-inference is a DIFFERENT axis** (core-facility attribution → `core`/`publication_core`) — irrelevant to #1166.
- **Don't let #1158/#1167 close #1166** — source-pmid and A3 are *consumers* of the entity stage, not the stage itself.
- **`matched_span`** — once it lands, the rail/snippet highlight is exact automatically (`highlightSnippet` prefers offsets); retire the term-match fallback per spec §10.
- The two mockups use a `sendPrompt(...)` chat shim for interactions — they encode **behavior**, not wiring; the real filter/sort/nav is yours to build.

## Refs
Spec `docs/methods-cellline-redesign-spec.md` (§5, §7, §8), plan `docs/methods-cellline-redesign-plan.md`, prior handoff `docs/methods-cellline-1c-handoff.md`. Mockups `docs/mockups/methods-lens/surfaceB-*.html` (+ the existing `methods-lens/*.html`). Issues **#1166** (gate), **#1168** (Surface B), **#1167** (A3, narrowed). PRs #1171 / #1173 / #1177. ReciterAI repo `~/Dropbox/GitHub/ReciterAI` (`pipeline_tools`).
