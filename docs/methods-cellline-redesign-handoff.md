# Methods & Tools redesign — session handoff

**Purpose:** ground a future session to implement the Methods & Tools verbatim-provenance +
cell-line-discovery redesign. The authoritative design is `docs/methods-cellline-redesign-spec.md`;
this file is the orientation layer (what exists, what's shipped, what supersedes what, where to start).

## Source materials (in this repo)

- **Spec (authoritative):** `docs/methods-cellline-redesign-spec.md` — two surfaces, §7 data requirements,
  §8 decisions, §11 phasing.
- **Mockups:** `docs/mockups/methods-cellline/`
  - `method_page_cell_line_strip_filter.html` — Surface B strip + hover rail + filterable list (§5.2–5.4)
  - `ms1_filtered_article_list.html` — Surface B filtered article-list state, MS1 worked example (§5.7)
  - `all_cell_lines_directory_expanded.html` — Surface B "all cell lines" directory (§5.6)
  - (Surface A's earlier mockup lives outside the repo: `~/Downloads/scholars_methods_panel_redesign.html`.)

> **Supersession (unconfirmed):** the strip and directory mockups were flagged by the author as
> possibly superseded by a newer iteration. By content they're three *complementary* states (main view,
> filtered state, directory), all consistent with the spec — none supersedes another internally. Treat
> the spec as source of truth and confirm the strip/directory visuals before building.

## Tracking issues (filed)

| Issue | Scope | Spec |
|---|---|---|
| **#1166** | Extraction / data requirements (gating dependency) | §7 |
| **#1167** | Surface A — profile "Methods & tools" panel redesign | §4 |
| **#1168** | Surface B — method-detail cell-line discovery | §5 |

#1166 gates both #1167 and #1168.

## How this relates to already-shipped work — READ FIRST

The Surface A panel is the one **already partially redesigned** in recent PRs. Do not re-derive:

- **#1160** (publication modal) + **#1164** (profile panel `ExemplarToolsLine`) shipped the
  **"Verbatim, from the author's papers"** framing + in-place mark-highlight (`markTermInText` in
  `components/ui/mark-term.tsx`). That is spec **A6/A7, in interim form.**
- The spec goes further and **supersedes two interim choices**:
  - **A1 (persistent side rail)** replaces the hover tooltip that #1164 kept (spec §3.3 "never occlude").
    When #1167 lands the rail, the `ExemplarToolsLine` / `MethodToolsLine` tooltips get reworked.
  - **§7 `matched_span` (char offsets)** replaces the **client-side string matching** in
    `markTermInText` ("don't string-match client-side"). The current util is the interim; offset-driven
    highlighting is the target once #1166 lands.
- **#1158** (snippet source-pmid traceability) is a **subset of #1166** (`source_publication_id` is one
  of the §7 fields). Reconcile: fold #1158 into #1166 or narrow it once #1166 is scoped.
- Current data substrate: `scholar_family.exemplarTools` / `exemplarContexts` (#1119) — per-(scholar,
  family, tool) representative snippet, keyed by tool display name. **No** offsets, source pmid,
  per-(pub×entity) grain, or entity normalization. #1166 is the artifact/schema upgrade that supplies them.

## Where to start (grounding TODOs for the next session)

1. **Re-ground against `origin/master`** — this handoff was written when master was at the #1162 era;
   re-verify symbol/line refs before trusting them.
2. **Verify the method-detail page's current state** (Surface B): does a "How researchers use these tools"
   block + cell-line entity resolution exist today, or is the entity layer net-new? The spec §5.2 says it
   "replaces the prose block," implying it exists — confirm in `components/method/*` / `lib/api/methods*`.
3. **Scope #1166 first** — the ReciterAI extraction artifact is the hard gate; the UI issues can't fully
   land without it. Start with the artifact change on the ReciterAI side.
4. **Build the rail component once** — Surface A (#1167) and Surface B (#1168) share the persistent
   provenance rail (spec §5.3 "reused from A").
5. **Confirm mockup supersession** with the author before building the strip/directory.

## Phasing (spec §11)

- **Phase 1** — Surface A rail + affordances (A1–A7); Surface B reframed strip + rail + single-select
  filter + per-paper snippets. Keep the baseline list unchanged.
- **Phase 2** — Surface B directory as a side-sheet (search/sort/nest); multi-membership cross-links;
  filter+sort state in the URL.
- **Phase 3** — multi-select (OR), entity normalization tuning, centrality-based snippet selection.

Refs: spec `docs/methods-cellline-redesign-spec.md`, #1166, #1167, #1168, #1158, #1160, #1164, #1119.
