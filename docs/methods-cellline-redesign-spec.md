# Methods & Tools — Verbatim Provenance & Cell-Line Discovery

**Redesign spec · Scholars Profile System**

Status: Draft for review · Owner: Paul Albert · Surfaces: scholar profile (`/people/...`) and method detail (`/methods/...`)

---

## 1. Summary

This spec covers two related surfaces in SPS that present method/tool information extracted from publications:

- **Surface A — the "Methods & tools" panel** on a scholar profile, which lists method families inferred from that scholar's papers.
- **Surface B — the method detail page** (e.g. *Immortalized cell lines*), which lists the specific entities a method resolves to, the scholars who use it, and the papers that cite it.

Both already do something rare and valuable: they ground every inferred claim in the verbatim sentence where the technique appeared. That provenance is the load-bearing feature and the thing this redesign protects hardest. The changes below fix execution problems (an occluding tooltip, ambiguous affordances, a prose "sample" block) and turn the extracted sentences from decoration into **navigation and discovery**, without diluting the grounding.

## 2. Goals and non-goals

**Goals**
- Make the provenance traceable end-to-end: verbatim sentence → highlighted matched term → click-through to the source publication.
- Convert the method/cell-line vocabulary into a ranked, filterable index (a third discovery axis alongside *who* and *which papers*).
- Surface papers that keyword/title/topic search would miss, via on-demand relevance snippets.
- Keep every screen scannable — no text walls, no occluding overlays.

**Non-goals**
- Changing the underlying article list itself (the cleared/baseline list is the current production view and stays as-is).
- Re-running or re-scoping the extraction pipeline. This spec defines what the pipeline must *emit*; classifier/extraction quality is out of scope.
- Visual rebrand. Components inherit Scholars Profile Console tokens.

## 3. Design principles

These cut across both surfaces and should arbitrate any ambiguity below.

1. **Provenance is the product.** Anything inferred ("this scholar uses X") must be one interaction away from the verbatim sentence that justifies it, with the matched term highlighted and the source paper linkable. Never assert a grounding sentence the user can't get to.
2. **Detail on demand, not always-on.** The relevance sentence is the proof, but it's heavy. Show it on hover (preview) or on filter (per-paper), never inline across an entire list. A sentence in all 33 article rows buries the scannable title/author line.
3. **Never occlude.** Supporting detail goes in a persistent rail or an expanded row — never a floating overlay that covers unread content.
4. **Snippets do discovery.** The relevance sentence isn't carried-over chrome; under a filter it surfaces papers whose title, journal, and keywords give no hint of the match (see §5.5). That is the justification for filtering by entity at all.
5. **Affordances must be self-evident.** A user should be able to tell what is clickable, what filters in place, and what navigates away — without hovering to find out.
6. **Granular in data, clean in display.** Keep entities granular at the data layer; collapse near-duplicates (differentiation states, role variants) under a parent in the UI via nesting.

---

## 4. Surface A — Scholar profile "Methods & tools" panel

### 4.1 Current problems

- The usage tooltip is a black overlay that **covers the rows beneath it** — reading about one method hides two others.
- Within a row, some terms are underlined and some aren't, but the user can't tell **what's clickable vs. descriptive** without hovering.
- There are **two competing filter models** — a checkbox ("select to filter") and a count-plus-arrow on the right — with neither destination self-evident.
- "AAV gene-therapy vectors (research reagents)" and "AAV gene-therapy vectors (therapeutics)" read as a **near-duplicate**; the role distinction leaks out as a quiet parenthetical.
- The verbatim term rows are visually heavy and **compete with the family titles**, which are the scannable unit.
- Snippet framing mismatch: "How AAVrh.10 vector was used" heads a sentence that actually centers a *different* method (scRNA-seq), because it's the sentence that happens to *contain* the term.

### 4.2 Changes

**A1 — Side rail replaces the overlay.**
The usage example renders in a persistent panel beside the list, updated on hover/focus of a term. It never covers list rows. The rail retains the last-hovered content rather than blanking on mouse-leave.

**A2 — Consistent, self-evident affordance.**
- Terms that carry a usage sentence ("evidenced" terms) get a single consistent treatment: dotted underline + interactive cursor + hover/focus highlight.
- The descriptive parent term ("Adeno-associated virus (AAV) vector") is styled as a plain muted label — no underline, not interactive.
- A one-line caption disambiguates all controls: *"Tick the box to filter this profile. Underlined terms have a usage example — hover to preview. The pill opens that method's publications."*

**A3 — Nest role variants under a shared root.**
"AAV gene-therapy vectors" becomes a group header with indented variants — "As research reagent" and "As therapeutic" — visually nested (indent + left guide). The reagent-vs-therapy distinction reads as intentional structure, not a taxonomy artifact.

**A4 — Two controls, two distinct jobs.**
- **Checkbox (left)** = *filter this profile in place.* Selecting one or more shows a filter chip bar above the list ("Filtering this profile by: …").
- **Count + arrow pill (right)** = *navigate to that method's publications.*
- The behaviors are visually and behaviorally distinct; the pill looks pressable, the checkbox looks like a selection control.

**A5 — Hierarchy correction.**
Family titles become the prominent, scannable unit; verbatim term rows recede in size/weight with more vertical air between rows. **Keep monospace** on the verbatim strings — it reinforces "extracted, verbatim" — but smaller and muted so it supports rather than competes.

**A6 — Provenance treatment in the rail.**
Rail contains: a "Verbatim, from a paper using it" eyebrow; the term; the sentence with the **matched term highlighted in place**; and a source-publication click-through.

**A7 — Snippet framing.**
The in-place highlight resolves the "leads with a different method" problem: even when the sentence opens elsewhere, the user sees exactly where the term sits. Pair with snippet selection that prefers the most term-central sentence (see §7) and soften the heading to "Where it appears" when centrality is low.

### 4.3 Component anatomy (A)

```
Methods & tools                                    Browse all methods →
Inferred from the datasets, models & methods named in this scholar's publications.

[ Filtering this profile by: <chip ×> … ]          (visible only when filtered)

┌─ list ───────────────────────────────┐   ┌─ rail ───────────────┐
│ AAV gene-therapy vectors · two ways   │   │ Verbatim, from a     │
│   ├ ☐ As research reagent        [11↗]│   │ paper using it       │
│   │   AAV vector · AAV vectors ·      │   │ AAVrh.10 vector      │
│   │   AAVrh.10 vector  (underlined)   │   │ "...the liver-tropic │
│   └ ☐ As therapeutic              [3↗]│   │ ‹AAVrh.10 vector› to │
│ ☐ Single-cell RNA sequencing      [5↗]│   │ characterize..."     │
│ ☐ Bulk RNA sequencing             [3↗]│   │ —— Source pub ↗      │
│ ☐ Direct CNS drug delivery        [3↗]│   └──────────────────────┘
│ ⓘ caption disambiguating controls     │
└───────────────────────────────────────┘
```

---

## 5. Surface B — Method detail page

Worked example: *Immortalized cell lines*.

### 5.1 Information architecture

Reorder the page so each block has exactly one job, eliminating the "three stacked sample blocks" smell:

1. **Definition** (what the method is)
2. **Top scholars** — *who* uses it
3. **Specific cell lines used** — *what* it resolves to, **filterable** (replaces "How researchers use these tools")
4. **Spotlight** — *curated* highlights (editorial picks)
5. **Research articles using this method** — *everything*

This resolves the redundancy: the reframed strip (algorithmic, filterable index) and Spotlight (hand-curated highlights) now do genuinely different jobs.

### 5.2 "Specific cell lines used" strip (replaces the prose block)

The current "How researchers use these tools" block is keyed to *specific named cell lines* — that's its one unique contribution (the *what specifically* axis). Don't dissolve it into the paper list; reframe it.

- **Rename** the heading to "Specific cell lines used" with subtext: *"The named cell lines this method resolves to across these papers · select one to filter the list below."*
- **Rank** entities by usage count (descending), with a faint proportional bar so the long tail is legible at a glance.
- Each entity shows its **usage count**.
- **Hover/focus** an entity → previews its verbatim sentence in the rail (§5.3).
- **Select** an entity → filters the article list (§5.4).
- A "N more cell lines" affordance opens the full directory (§5.6).

### 5.3 Hover rail (reused from A)

Same persistent-rail pattern: eyebrow "Verbatim, from a paper using it" → entity name → sentence with matched term highlighted → source-publication link. Previews on hover, persists on leave.

### 5.4 Filter behavior + relevance snippets

- Selecting an entity filters the article list to papers tagged with it and reveals a **per-entity relevance snippet** on each matching row, with the matched term highlighted.
- Snippets are **on-demand** (filter-driven), never shown on the unfiltered baseline list.
- The filtered state shows a context bar (breadcrumb + active chip + clear), an updated count, and a back-to-directory affordance.

### 5.5 Multi-membership and cross-links

A single paper can use multiple cell lines and therefore appear under multiple filters — **with a different relevance sentence surfacing under each.** The cell-line axis is an *overlapping index*, not a partition of the corpus.

> **Worked example (the case that justifies the feature).** Under "MS1 VEGF angiosarcoma cells", the top match is *"STAT1- and NFAT-independent amplification of purinoceptor function integrates cellular senescence with interleukin-6 production in preadipocytes"* (Br J Pharmacol, 2022, PMID 38321760). Nothing in that title, journal, or keywords indicates MS1 cells were used — it reads as a preadipocyte/purinoceptor paper. The match exists **only** because the extracted sentence surfaces a supporting experiment buried mid-paper. The same paper also appears under "3T3-L1 preadipocytes" with a *different* sentence. This is the discovery a title/topic search cannot deliver.

Each filtered row that matches multiple entities shows an "Also matches: ‹entity› →" cross-link that switches the filter.

### 5.6 "All cell lines" directory (expanded view)

When a method resolves to many entities, the compact ranked strip isn't enough. The directory adds:

- **Search-within** ("Filter cell lines…") — substring filter over entity names; collapses parent groups whose children all hide.
- **Sort toggle** — "Most used" (find dominant lines) vs. "A–Z" (find a *known* line). The strip needs only "Most used"; the directory needs both.
- **Parent nesting** — differentiation states of one line collapse under a parent (e.g. "3T3-L1" → "adipocytes" / "preadipocytes" as two forms). This is where nesting earns its place; in the 7-item strip it would be premature.
- Selecting a row **collapses the directory and applies the filter** on the article list.

### 5.7 Filtered article-list state

- **Context bar**: `Immortalized cell lines › ‹entity chip ×›`, a count ("N of 33 articles"), and a "← All cell lines" back link.
- Each matching paper row: title, author chips, source meta (journal · year · PMID · citations), the **highlighted relevance sentence**, and any "Also matches" cross-links.
- A persistent "Clear filter · view all N articles" control.

### 5.8 Cleared / baseline

Clearing drops the filter bar, all per-paper snippets, and cross-links, returning to the standard article list (the current production view). No changes to this state.

---

## 6. Shared interaction model

The two surfaces share one state machine. Selecting from any entry point applies the same filter:

```
            hover/focus
   ┌──────────────────────────► RAIL PREVIEW (verbatim sentence)
   │
RANKED STRIP ──select──► FILTERED LIST ──"Also matches"──► (re-filter, different snippet)
   │                          │  ▲
"N more"                     clear │ back
   ▼                          │  │
DIRECTORY (search/sort/nest) ─select──► FILTERED LIST
                              │
                              └──clear──► BASELINE LIST (33 results)
```

Invariant: **filter state is singular and shared** — the strip selection, directory selection, and context-bar chip all reflect and mutate the same active filter.

---

## 7. Data and pipeline requirements

The redesign is only as good as what the extraction emits. Per method, the pipeline must supply:

| Field | Description | Used by | Notes |
|---|---|---|---|
| `method_family` | Umbrella method (e.g. "Immortalized cell lines") | A, B | Page/section key |
| `entity_term` | Verbatim specific term (e.g. "MS1 VEGF angiosarcoma cells") | A, B | Display string, monospace |
| `normalized_entity_id` | Canonical id grouping synonyms/casing | A, B | Drives counts + dedup |
| `parent_entity_id` | Parent line/family for nesting (e.g. 3T3-L1) | A4/§5.6 | Null if top-level |
| `entity_role` / `form` | Variant label ("research reagent", "adipocytes") | A3/§5.6 | Drives nested rows |
| `is_evidenced` | Whether a usage sentence exists | A2 | Drives clickable vs. label affordance |
| `usage_count` | # papers using this entity (in scope) | strip rank | Powers ranking + bars |
| `usage_sentence` | Verbatim sentence, per (publication × entity) | rail, snippets | One per membership |
| `matched_span` | Char offsets of the term within the sentence | highlight | **Required** for reliable `<mark>`; don't string-match client-side |
| `centrality_score` | How central the term is in the sentence | §4.2-A7 | Selects best sentence; drives heading wording |
| `source_publication_id` | PMID / DOI | click-through | Source link target |

Key implications:
- **Multi-membership is first-class.** A `(publication, entity)` pair is the grain for `usage_sentence` + `matched_span`; one paper → many pairs → many sentences.
- **Highlight needs offsets, not heuristics.** Emit `matched_span` so the UI highlights exactly the matched substring; client-side substring matching is fragile (casing, partial overlaps, repeated tokens).
- **`is_evidenced` drives affordance.** Terms without a usage sentence render as plain descriptive labels, never as interactive.

---

## 8. Open decisions (with recommendations)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Directory surface | Modal · side-sheet · dedicated page | **Side-sheet.** Preserves the article list underneath (a filter-select then feels like it acts on something visible) and is URL-addressable. Modal severs context; a full page is overkill for ~7–20 items. |
| D2 | Select model | Single · multi-OR · multi-AND | **Single-select v1.** If multi later, default **OR** within a method's cell lines (papers using *any* selected line) — the intuitive default for "find papers using these tools." Offer AND as an advanced toggle only. The directory is the natural home for multi-select, not the compact strip. |
| D3 | Entity normalization granularity | Collapse forms into one entity · keep granular | **Keep granular at the data layer; nest in the UI.** Stay distinct on differentiation states / passage variants / transfection derivatives; let nesting be the display hedge that stays clean without lumping. |
| D4 | Filter + sort state location | Component state · URL query params | **URL.** Encode active filter + sort (and side-sheet open state) so filtered/sorted views are shareable and deep-linkable. |
| D5 | Snippet selection | First occurrence · highest centrality | **Highest centrality, fallback to first.** Cap sentence length; always emit `matched_span`. Use "How it was used" only when centrality is high; otherwise "Where it appears." |
| D6 | Rail aesthetic | Light persistent rail · dark ephemeral overlay | **Light persistent rail** for readability of longer text. Dark overlay is acceptable only if you want the panel to read as transient — but transient conflicts with "never occlude." |

## 9. Accessibility

- Terms, entity rows, and the checkbox/pill controls are **real focusable controls** (buttons / proper roles), operable by keyboard, with visible `:focus-visible` rings.
- Wrap each visualization/section in an `sr-only` one-sentence summary.
- The rail region is an `aria-live="polite"` container so the verbatim sentence is announced on focus, not just on hover.
- **Do not rely on color alone** for the evidenced-term affordance — pair the underline with the rail eyebrow/icon and the consistent cursor.
- Filter chips and the directory's clear/back controls are keyboard-removable.

## 10. Implementation notes

- Components inherit **Scholars Profile Console tokens**; the interactive mocks used the chat design system as a stand-in for layout/behavior only.
- Render highlights from `matched_span` offsets; sanitize before injecting.
- The mock placeholder data maps 1:1 to the §7 fields — swapping in real extraction output should be a data change, not a structural one.
- Filter + sort live in the URL (D4); the side-sheet open state is a route or query param so the directory is deep-linkable.

## 11. Suggested phasing

- **Phase 1** — Rename + reframe the strip with counts and ranking; add the rail; replace the prose block; light rail; single-select filter with per-paper snippets; keep the baseline list. Apply A1–A7 to Surface A.
- **Phase 2** — Directory as a side-sheet with search/sort/nesting; multi-membership cross-links; move filter + sort state into the URL.
- **Phase 3** — Multi-select (OR), normalization tuning (D3), and centrality-based snippet selection (D5).

## 12. Open questions

- Does the cell-line strip pattern generalize to other "specific entity" axes on non–cell-line method pages (datasets, models, reagents), and should the component be built generically from the start?
- For multi-membership, is there a cap on how many entities a single paper can advertise before the cross-link list needs truncation/overflow?
- Should `centrality_score` be exposed anywhere in the UI (e.g. to order multiple candidate sentences), or stay an internal selection signal only?
