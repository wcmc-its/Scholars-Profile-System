# Methods & Tools redesign — execution handoff (Phase 1c → Phase 3)

**Purpose:** kick off the next session to continue the Methods & Tools redesign. Phase 1a + 1b are merged-or-in-review; **Phase 1c (Surface A panel wiring) is next.** This doc is the orientation layer; the authoritative design is `docs/methods-cellline-redesign-spec.md` and the sequencing is `docs/methods-cellline-redesign-plan.md`.

> Written 2026-06-20 after 1a/1b shipped. **Symbol/line refs drift fast** (master moved 3× in one session). Treat every line number here as approximate and **re-ground before trusting it** (see step 0).

---

## 0. First moves (do these before writing code)

1. **Re-ground against `origin/master`.** `git fetch origin` and base all work off the latest. Re-verify the symbol locations in §3 with `grep -n` — cite symbols, not the line numbers below.
2. **Check 1a/1b merge state.** PRs **#1171** (1a, source-pmid) and **#1173** (1b, ProvenanceRail) were CI-green and review-only. If they've merged, branch 1c off fresh master. If NOT merged, branch 1c off master and cherry-pick / stack — 1c **depends on both** (§2). Don't rebuild what they added.
3. **Confirm the open decisions in §5** with Paul (especially Q-7, the source-link target — it has no obvious default).
4. **Environment:** the Dropbox SPS repo needs untracked `.env*` + `node_modules` + a generated Prisma client. Reuse the worktree `~/worktrees/mc-phase1` (deps installed) if it survives, or set up a fresh worktree off `origin/master` with `npm ci` + `npx prisma generate` + copy `.env*`. Bound test runs with `--maxWorkers=4`.

---

## 1. Where we are

| Phase | Scope | Status |
|---|---|---|
| Grounding + plan | 4-agent grounding; plan + issue re-scope | done; plan = PR #1172 |
| **1a** | `scholar_family.exemplar_context_pmids` (sibling map) + migration + ETL + modal "from this paper" framing | **PR #1171, CI-green, review-only** |
| **1b** | shared `ProvenanceRail` + `highlightSnippet` (standalone, 15 tests) | **PR #1173, CI-green, review-only** |
| **1c** | **wire the rail into Surface A (the profile panel) — THIS HANDOFF** | not started |
| 2 | the #1166 gate: ReciterAI entity-resolution stage + `matched_span`; new `family_entity_usage` table | not started |
| 3 | Surface B (#1168) full discovery: strip / filter / directory / cross-links / URL state | not started |

Issues are re-scoped on GitHub: **#1166** (gate, §7 + status table), **#1167** (Surface A, drift fixed), **#1168** (Surface B, net-new), **#1158** (narrowed; advances with 1a, closes with the rail's click-through in 1c).

---

## 2. What 1a/1b already give you — DON'T rebuild

**From 1a (#1171):**
- DB column `scholar_family.exemplar_context_pmids` — a `{ toolDisplayName: pmid }` map **parallel** to `exemplar_contexts` (1:1 by key). Nullable; **null until a full-replace tools ETL backfills it** (so live source links won't render until an operator runs `etl:scholar-tool` — until then the column is null and readers degrade to "no source").
- `PublicationDetailMethodTool.sourcePmid` (modal path only) + the modal's "Verbatim, from this paper" framing.

**From 1b (#1173):**
- `components/method/provenance-rail.tsx` — `ProvenanceRail` + `ProvenanceRailItem`. Presentational; **the consumer owns hover state and the "retain last-hovered" behavior** (§4.2-A1). Props: `item | null`, `placeholder`, `action`, `className`. `item` = `{ eyebrow, term, sentence, matchedSpan?, source? }`. Already has `aria-live="polite"` (§9) and a placeholder.
- `components/method/highlight-snippet.tsx` — `highlightSnippet(sentence, term, span?, markClassName?)`. **Prefers `matchedSpan` offsets (forward-compat with #1166); falls back to client-side term matching** (the #1119 interim). Injection-safe (React nodes). Reuses the app's pale-red mark class `SNIPPET_MARK_CLASS`.

So 1c is **wiring + panel redesign**, not new provenance infrastructure. When `matched_span` lands in Phase 2, you pass it as `item.matchedSpan` and the rail upgrades for free — no rail change.

---

## 3. Phase 1c — the work (spec §4.2, plan §3 "1c")

Target file: **`components/profile/methods-section.tsx`** (`MethodsSection` ~L145; per-tool row `ExemplarToolsLine` ~L63; the snippet currently shows in a Radix **Tooltip** ~L88–102; two render paths — `facetRedesignEnabled` ~L238+ and legacy ~L557+). Host island: **`components/profile/profile-pubs-cluster.tsx`** (renders `MethodsSection`; owns `selectedFamilyIds`/`onFamilyToggle` + the `FilterBar` chip bar).

### 3a. Thread the source pmid into the Surface A read path (1a did the modal path only)
- `lib/api/profile.ts`: add `exemplarContextPmids: Record<string, string>` to `ScholarFamilyView` (~L78–88); coerce it in `toScholarFamilyView` (~L180–208) with the **same back-compat coercion** as `coerceStringRecord` (tolerate null/missing → `{}`); add `exemplarContextPmids: true` to the `select` (~L250).
- `lib/api/method-exemplar.ts`: `pickMethodContext` (~L146) / the `methodContext` shape (~L44) currently carries `{ tool, context }`. Add the source pmid (`{ tool, context, sourcePmid }`) so the panel can build the rail's source link. Gate it with the snippet (same `METHODS_LENS_TOOL_CONTEXT` gate).

### 3b. Wire `ProvenanceRail` into the panel (A1 + A6 + A7)
- **A1 — replace the Radix Tooltip overlay with the persistent rail.** Two-column layout: the family/tool list on the left, `<ProvenanceRail item={hovered}>` on the right. The panel (a client component) holds `hovered` state; set it on tool hover/focus; **do not clear on mouse-leave** (retain last — spec §4.2-A1). Build the `ProvenanceRailItem` from `exemplarContexts[name]` (sentence), `name` (term), `exemplarContextPmids[name]` (source), eyebrow **"Verbatim, from this scholar's papers"**.
- **A6/A7** — the rail already does the eyebrow + highlighted sentence + source link. Phase-1 highlight is term-based (no `matchedSpan` yet). Heading stays fixed "Verbatim…" until `centrality_score` exists (Phase 2).
- This **closes #1158** (the click-through finally has a home).

### 3c. Affordance + hierarchy polish (A2, A4, A5)
- **A2** — keep the existing dotted-underline evidenced-term treatment; add the **muted descriptive-parent label** and the **one-line disambiguating caption** (spec §4.2, the "Tick the box to filter… Underlined terms have a usage example… The pill opens that method's publications" line).
- **A4** — consolidate the currently-separate count + arrow into the single **count+arrow pill** (navigate); keep the checkbox (filter-in-place) + `FilterBar` chip bar.
- **A5** — family titles prominent; the monospace verbatim row recedes with more vertical air.

### 3d. Consolidate the highlighter (kill the duplication 1b deferred)
- `components/publication/publication-modal.tsx` has a **local** `highlightTermInSnippet` (~L681). Replace it with the shared `highlightSnippet` from 1b (pass the modal's dark `markClassName` so the dark-tooltip styling is preserved). Remove the local copy + its `escapeRegExp` if unused elsewhere. (1b left them duplicated on purpose to keep that PR conflict-free.)

### 3e. Deferred to Phase 2 (do NOT attempt in 1c)
- **A3 — role-variant nesting** ("AAV … (research reagent)" / "(therapeutic)"). Needs `parent_entity_id` / `entity_role` from #1166. The data isn't there.

### Flags
Surface A is behind `PROFILE_FACET_REDESIGN` / `METHODS_LENS_*` (notably `METHODS_LENS_TOOL_CONTEXT` for the snippet). Thread the existing flag fabric; the rail/source link rides the tool-context gate. Decide the legacy flag-off render path's fate (plan Q-6).

---

## 4. Verification (1c)
- Unit tests: panel renders the rail on hover/focus, retains last-hovered, builds the source link from `exemplarContextPmids`, omits it when null; A2 caption + muted parent; A4 pill vs checkbox. Reuse `tests/unit/methods-section.test.tsx` patterns.
- `tsc` + `eslint` + full `vitest --maxWorkers=4` green.
- **Live render-verify needs a backfill:** `exemplar_context_pmids` is null until a full-replace `etl:scholar-tool` run, so the rail's source link won't show on staging until an operator runs it. Verify the rail/highlight with mocked data in tests; note the backfill dependency for staging.
- Render-check (Playwright `browser_snapshot`) the two-column rail layout once deployed with data.

---

## 5. Open decisions for Paul (resolve before/early in 1c)

| ID | Decision | Note / recommendation |
|---|---|---|
| **Q-7 (NEW)** | The rail's "Source publication →" **link target** | There is **no public single-publication route**; the only pub-detail UI is `PublicationModal`, opened from pub rows. Options: (a) open the `PublicationModal` for that pmid from the rail (needs a modal-open callback plumbed into the profile panel); (b) external PubMed link `https://pubmed.ncbi.nlm.nih.gov/<pmid>/` (simplest interim); (c) deep-link/scroll to the pub in the profile's own list. **Recommend (b) as the 1c interim, (a) as the proper follow-up.** |
| Q-6 | Legacy flag-off render path in `methods-section.tsx` | Redesign behind the flag; decide whether to retire the legacy path. |
| Q-2 | Surface B in Phase 1 | §5.1 IA rename only; strip/directory deferred to Phase 3. |
| Q-3 | Article-list sort dropdown (mockup-only) | No spec backing — defer to Phase 3 unless Paul wants it. |
| Q-4 | Directory parent-descriptor text | No §7 field supplies it; decide a source before Phase 3. |
| Q-5 | Where `centrality_score` is computed | Upstream in ReciterAI (Phase 2). |

§8 D1–D6 are accepted as written. Mockup supersession is resolved (the 3 Surface B mockups are complementary). Surface A mockup: `~/Downloads/scholars_methods_panel_redesign.html` (realizes A1–A7).

---

## 6. Phase 2 — the #1166 gate (after 1c)

The hard dependency for a faithful Surface B and for offset-driven highlighting.

**ReciterAI** (`~/Dropbox/GitHub/ReciterAI`, axis = `pipeline_tools`; NOT `pipeline_cores`, which is core-facility attribution and out of scope):
- New **entity-resolution stage** below the existing `canonical_tool_id` registry (`pipeline_tools/registry.py`): mint/normalize specific entities → `normalized_entity_id`, link `parent_entity_id`, attach `entity_role`/`form`.
- Emit **`matched_span`** (char offsets of the *specific* matched occurrence in the verbatim sentence) — `pipeline_tools/extract.py` + `prompts/tool_extract.py`.
- Emit **`centrality_score`** (port the `nameFirstFraction` heuristic from SPS `etl/tools/tool-context.ts` upstream).
- Preserve **`usage_sentence` multiplicity** per (publication × entity) — today's SPS rollup collapses to one best snippet (§5.5 needs all of them).

**SPS:**
- New **`family_entity_usage`** table at `(publication × entity)` grain + a new ETL mapper (plan decision P-B — **not** a JSON extension of `exemplar_contexts`).
- New read APIs for per-entity lists + per-(pub×entity) sentences/offsets.
- **Swap the rail highlight to offset-driven**: pass `item.matchedSpan` to `ProvenanceRail` (already supported — no rail change). Retire the term-match fallback once offsets cover the surface (spec §10).

---

## 7. Phase 3 — Surface B full discovery (#1168, after the gate)

Target: `app/(public)/methods/[supercategory]/[family]/page.tsx` + `components/method/*`. Reuse `ProvenanceRail` (built in 1b).
- §5.2 ranked **"Specific cell lines used" strip** (entity + usage_count + proportional bar), **radio / single-select** (D2 v1) — **do NOT reuse Surface A's checkbox control** (deliberate per-surface divergence).
- §5.4 filter + per-(pub×entity) relevance snippets (on-demand); §5.7 filtered article-list state.
- §5.5 multi-membership **"Also matches" cross-links** (generalize to N/row; cap TBD §12).
- §5.6 **directory side-sheet** (search-within, Most-used/A–Z sort, parent nesting) — URL-addressable (D4).
- §5.1 IA reorder. **URL state** (D4) for filter+sort+side-sheet (the page has none today).
- Later: multi-select OR (D2), centrality-driven snippet selection + heading switch (D5).

---

## 8. Gotchas / lessons

- **Re-ground line numbers** — the original handoff's drift (claiming a `mark-term.tsx` / PR #1164 that never existed) is the failure mode to avoid. Cite symbols; verify lines.
- **`exemplar_contexts` has ~10 readers** (overview-facts, search index, method page, modal, profile). The sibling-column design (1a) keeps them untouched — don't widen the value shape.
- **`HoverTooltip` is `pointer-events-none`** — it can't host a clickable link. That's why the rail (not the modal tooltip) owns the click-through.
- **Surface A = checkbox/multi-select; Surface B strip = radio/single-select.** Do not unify the control.
- **`cores-inference` / `pipeline_cores` is a different axis** (core-facility attribution → `core`/`publication_core` tables) — irrelevant to #1166.
- **Don't let #1158 close #1166** — source-pmid ≠ the entity stage / matched_span.
- **Backfill dependency:** new ETL fields are null until a full-replace `etl:scholar-tool` run; live verification of source links / "from this paper" needs that backfill.

Refs: spec `docs/methods-cellline-redesign-spec.md`, plan `docs/methods-cellline-redesign-plan.md`, PRs #1171/#1172/#1173, issues #1166/#1167/#1168/#1158.
