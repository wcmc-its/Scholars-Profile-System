# Search relevance & evidence-display — handoff (2026-06-28)

Driven by staging review of `/search` (`children's health`, `crispr`). Two themes:
**relevance** (who ranks, in what order) and **evidence display** (what the row says about
*why* a scholar matched). The connective tissue across all of it is **MeSH**.

---

## 1. Shipped (both draft PRs, CI running, NOT merged)

| PR | Branch | What | Flag | Verified locally |
|---|---|---|---|---|
| **#1336** | `feat/search-area-relevance-spec` | **Track B** — Research-Area relevance×coverage ranking boost | `SEARCH_PEOPLE_AREA_BOOST` (off; staging-on) | tsc clean · 255 unit tests · cdk 109 + snapshot |
| **#1337** | `feat/search-evidence-badge-labeling` | `tagged`→**Concept** relabel (was mislabeled "Research area") + tighter evidence-row gap (`mt-2`→`mt-1.5`) | scoped to `SEARCH_EVIDENCE_ROWS` (badged) path | tsc clean · 187 unit tests |

Not verified for either: **CI green** (just opened) and **runtime/visual on staging**.

Spec: `docs/search-research-area-relevance-spec.md` (in #1336). Worktree:
`~/worktrees/sps-area-relevance/`.

---

## 2. Design decisions locked

- **D1 — boost magnitude = relevance × coverage = the topic page's per-scholar `total`**
  (Σ `scorePublication(reciteraiImpact = publication_topic.score, "top_scholars")` over the
  D-13/D-14 first/last-author carve). Reuses the number the topic page already ranks on, so
  People-search order matches the validated topic page.
- **MeSH is the concept ↔ research-area bridge** — `mesh_curated_topic_anchor`
  (`descriptorUi → parentTopicId`, confidence `curated`/`derived`). This is BOTH how the
  area gets matched (#1258 folds anchors into the chip row) AND the **query→area relevance
  (A)** signal — far better than substring `similarity` (≈0 for anchor matches). Full boost
  = **A(anchor tier) × Σ B(scholar concentration)**.
- **D2** granularity carried by the score (subtopic `total` when one resolves); **D3** blend
  into default Relevance, no new scope; **D4** reorder-only MVP (no set/facet change).
- **Labeling:** a MeSH-descriptor hit is a **Concept**, not a Research area; "Research area"
  is reserved for the topic-taxonomy match (#1337).

---

## 3. Open work (prioritized)

### P1 — Staging eval + merge (#1336, #1337)
Deploy #1336 to staging (`cdk deploy --exclusively Sps-App-staging -c env=staging`, flag is
already `staging→on` in `app-stack.ts`). Run flag-off vs flag-on on `children's health` +
~5 area-mapping queries, **a control** (a name; a narrow method) that must stay
byte-identical, and **≥1 older-engagement scholar** (see P4c). Confirm the area's known top
scholars rise and prolific off-topic / "1-of-N" rows fall. Tune `AREA_BOOST_W_*` / band
cutoffs. Merge after CI green + eval.

### P2 — Wire the anchor gate into Track B (refinement, not yet built)
Track B currently fires on **any** matched `areas[0]`, regardless of how it matched. Per
spec §3.4: gate on **`areas[0].id ∈ meshResolution.curatedTopicAnchors`** and scale the
boost by the anchor `confidence` tier (reuse `meshMatchTier`). A name/embedding-matched area
the descriptor doesn't anchor to is *ancillary* → no boost. Small change in
`app/api/search/route.ts` + `app/(public)/search/page.tsx` (the area-resolution block) and
the weight selection in `search.ts`.

### P3 — 2b: real "Research area" evidence row + anchor-gated display precedence
Build the **"N publications in {Research Area}"** evidence row backed by the rollup (the
same data #1336 ranks on; needs the per-scholar in-area pub **count**, not just `total` —
extend `getAreaScholarConcentration` or a lazy fetch like the funding row). Then per spec
§3.5: **anchored (high A) → show the Research-area row; not-anchored/derived (low A) → show
the Concept row even at a lower count.** This is what will actually *surface* the
high-concentration scholars with proper evidence.

### P4 — Rice / CRISPR case (four sub-issues)
`crispr` → Charles Rice (Nobel; 11 of 368 mention) ranks low, and **expanding his row does
nothing.**

- **(a) Dead `mention` disclosure — concrete, ready to fix.** `fetchKeyPaper`
  (`lib/api/search.ts`) builds its match filter as `terms: { meshDescriptorUi: descriptorUis }`
  whenever a descriptor resolved. A `mention`-only match is text (title/abstract), **not
  tagged** the descriptor — so the fetch returns **zero** and the disclosure is dead. The
  count's predicate (mention = text) and the fetch's predicate (tagged = descriptor) don't
  match. **Fix:** for `mention`-strength evidence, fetch by the literal query text (the
  existing `multi_match operator:"and"` fallback path) — i.e. the card passes
  `descriptorUis: []` (or a `text-only` flag) for mention rows so the disclosure matches the
  count. (#1337-adjacent; `components/search/people-result-card.tsx` builds the fetch.)
- **(b) Keyword-axis relevance×coverage.** The "N of M mention" count is display-only — not
  a ranking input — so the ranking is single-best-doc BM25 × prominence and a broadly-engaged
  scholar (11 mentions) gets no breadth credit. Same principle as Track B; could extend to
  the keyword axis, BUT mind: a `mention` is lower-relevance than a `tagged`/concept hit, and
  raw count re-introduces the "volume wins" risk (#1329). Relevance×coverage handles it
  (mention coverage × low per-pub relevance) — design before building.
- **(c) Recency (the key realization).** Rice's CRISPR work **may predate the 2020 rollup
  floor** (`RECITERAI_YEAR_FLOOR`, D-15) → excluded from `publication_topic` → zero
  relevance×coverage, so no area/concept credit; only the un-gated keyword mention shows.
  See spec §9. **Verify Rice's CRISPR pub years.** If old: decide whether foundational work
  should count — the lever is the rollup floor/recency curve (upstream of Track B), not the
  boost.
- **(d) Data quality.** If his CRISPR pubs are *recent* but not MeSH-tagged the CRISPR
  descriptor, that's a tagging gap (mention-but-not-tagged) — upstream MeSH/ReciterAI.

### P5 — Spacing visual-verify
`#1337` tightened the evidence-row gap `mt-2`→`mt-1.5` (8→6px). Eyeball on staging; easy to
go to `mt-1` (4px) if still loose.

---

## 4. Key files / signals

- Ranking: `lib/api/search.ts` (`buildAreaBoostFunctions`, prominence `function_score` ~2060).
- Rollup: `lib/api/topics.ts` (`getAreaScholarConcentration`, `getTopScholarsForTopic`).
- A signal: `lib/api/search-taxonomy.ts` (`curatedTopicAnchors`, `meshMatchTier`);
  table `mesh_curated_topic_anchor`.
- Display: `components/search/result-evidence.tsx` (flavor mapping),
  `components/search/match-reason.tsx` (badges/spacing),
  `components/search/people-result-card.tsx` (disclosure + key-paper fetch).
- Key-paper fetch: `fetchKeyPaper` in `lib/api/search.ts`; route `app/api/search/key-paper/`.
- Flags: `lib/api/search-flags.ts` (`resolveSearchPeopleAreaBoost`); cdk
  `cdk/lib/app-stack.ts`.
