# Publications Search

Example-driven explainer for the **Publications tab** of `/search`. Companion to:
- `docs/search.md` — architecture-level reference (all three tabs).
- `docs/taxonomy-aware-search.md` — the v2.x SPEC for the MeSH-aware behavior described here.
- Issue [#298](https://github.com/wcmc-its/Scholars-Profile-System/issues/298) — SPEC for the next round of empty/sparse-state improvements.

Audience: anyone who wants to understand what the pub-tab search will and won't do, and why. Written for a reader who hasn't read the code.

---

## TL;DR

When you search for `EHR` on the publications tab, the system:

1. Sees that `EHR` is a known entry term for the MeSH descriptor **D057286 Electronic Health Records**.
2. Pulls every descendant of that descriptor in the MeSH tree (~20 descriptors covering things like "Personal Health Records", "Meaningful Use", and historical variants).
3. Runs OpenSearch with **four parallel admission paths**, any one of which returns a publication:
   - BM25 text match on your literal query (`EHR`)
   - BM25 text match on the canonical descriptor name (`Electronic Health Records`)
   - Exact-match on any publication tagged with **D057286 or any of its descendants** (via the `meshDescriptorUi` keyword field)
   - Exact-match on any publication whose ReciterAI topic anchors match curator-defined parents for that descriptor
4. Shows you a chip explaining what just happened, with affordances to narrow or escape.

This is the **default** behavior as of PR [#299](https://github.com/wcmc-its/Scholars-Profile-System/pull/299) (`SEARCH_PUB_TAB_CONCEPT_MODE=expanded`). Two earlier flags exist as fallbacks (see [Rollback knobs](#rollback-knobs)).

---

## Query lifecycle, end-to-end

```
                                                         ┌──────────────────────────────┐
                                                         │ taxonomy resolver            │
                                                         │ lib/api/search-taxonomy.ts   │
                                                         └──────────────┬───────────────┘
                                                                        │ MeshResolution | null
       ┌──────────┐                  ┌────────────────────┐             │
URL ── │ page.tsx │ ─── q + filters ▶│ searchPublications │ ◀───────────┘
       │  (SSR)   │                  │ lib/api/search.ts  │
       └──────────┘                  └─────────┬──────────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │  OpenSearch  │
                                       │ pubs index   │
                                       └──────────────┘
```

The **taxonomy resolver** runs once at the top of the request, regardless of which tab is active. If the query normalizes to a known MeSH descriptor (by name or entry term, ≥ 3 chars, case-insensitive), it returns a `MeshResolution` carrying:

- `descriptorUi` — e.g., `D057286`
- `name` — `Electronic Health Records`
- `matchedForm` — the surface form that matched (could be the user's input verbatim, an entry term, etc.)
- `confidence` — `exact` (matched the canonical name) or `entry-term` (matched an alternate)
- `scopeNote` — NLM's free-text definition; shown in the chip tooltip
- `descendantUis` — `[D057286, D000077863, ...]` — self at index 0, then every descriptor whose tree number prefix-contains any of D057286's tree numbers. Bounded at 200.
- `curatedTopicAnchors` — `["digital-health", "informatics"]` — ReciterAI parent-topic IDs hand-curated for this descriptor (may be empty).

The resolver result feeds `searchPublications`, which constructs the OpenSearch body and returns hits, facet counts, and telemetry fields.

---

## Examples

Concrete query → behavior walkthroughs. All examples assume the default flag state (`expanded`).

### Example 1 — Descriptor with descendants

**Query:** `genome components`

**What happens:**

- Resolver matches `genome components` → **D040481 Genome Components** (exact name match, `confidence: "exact"`).
- `descendantUis` = ~50 descriptors under `G05.360.340.024.*`, including:
  - D000483 Alleles
  - D003062 Codon
  - D018899 CpG Islands
  - D064112 Clustered Regularly Interspaced Short Palindromic Repeats (the DNA structure — distinct from D064113 CRISPR-Cas Systems)
  - D004251 DNA Transposable Elements
  - D007424 Introns
  - …and many more

**OpenSearch body (sketched):**

```jsonc
{
  "bool": {
    "should": [
      // 1. BM25 on the literal query
      { "multi_match": { "query": "genome components", "fields": [...], "boost": 1 } },
      // 2. BM25 on the canonical name (same as q here; emitted anyway for snapshot stability)
      { "multi_match": { "query": "Genome Components", "fields": [...], "boost": 1 } },
      // 3. Exact-match: any pub tagged D040481 or any descendant
      { "terms": { "meshDescriptorUi": ["D040481", "D000483", "D003062", "D018899", "D064112", ...], "boost": 8 } },
      // 4. Anchor-match: pubs tagged with curated parent topics (empty here — no anchors set for D040481)
    ],
    "minimum_should_match": 1
  }
}
```

**Result set:** publications tagged with Genome Components itself **plus** publications tagged only with descendants. A paper tagged D018899 CpG Islands surfaces even though it never mentions the literal phrase "genome components" anywhere.

**Chip rendered:**
> 🏷 **Boosted by MeSH concept: Genome Components** · Narrow to this concept only · Don't use MeSH ✕

### Example 2 — Entry-term match (synonym)

**Query:** `EHR`

**What happens:**

- Normalized to `ehr`, looked up in the resolver's entry-term index → **D057286 Electronic Health Records** (`confidence: "entry-term"`, `matchedForm: "EHR"`).
- `descendantUis` includes D057286 itself + a handful of subtree descriptors (EMR variants, Personal Health Records, etc.).

**Result set:** every pub tagged Electronic Health Records or descendants, plus any pub whose title/abstract mentions either the literal `EHR` or the phrase `Electronic Health Records`. The user typed three letters and got the conceptual answer.

**Chip rendered:**
> 🏷 **Boosted by MeSH concept: Electronic Health Records** · Narrow to this concept only · Don't use MeSH ✕

The descriptor name is shown, not the user's input — the chip is honest that `EHR` was interpreted as a concept, not just text-matched.

### Example 3 — Unresolved query (no MeSH match)

**Query:** `tumor immunotherapy resistance mechanisms`

**What happens:**

- Resolver finds no descriptor (no exact name or entry-term match for that exact normalized string).
- Falls through to the **§1.2 path** — a standard `multi_match` with the per-field boosts in [docs/search.md](search.md#publications-searchpublications--scholars-publications) and a `minimum_should_match: "2<-34%"` floor (2 tokens required on 2-token queries; for a 4-token query like this one, 2 of 4 tokens must hit somewhere).
- No chip, no concept expansion. Pure BM25 over title / meshTerms / authorNames / journal / abstract.

**Result set:** a relevance-ranked list of pubs that match a meaningful subset of those tokens. Title hits dominate (`best_fields` scoring, title boost = 4).

### Example 4 — `?mesh=strict` (chip-narrow opt-in)

**Query:** `genome components`, then user clicks **"Narrow to this concept only"** on the chip.

**What happens:**

- URL becomes `?q=genome+components&type=publications&mesh=strict`.
- `searchPublications` builds the **pre-PR-4** body shape: must-clause is `match_phrase` on `meshTerms` + optional anchor terms; the BM25 query sits in a top-level should as scoring only (not admission).
- Result set shrinks dramatically — only pubs **directly tagged** D040481 itself survive (no descendants, no abstract-mention matches).

**Chip rendered:**
> 🏷 **Narrowed to MeSH concept: Genome Components** · Expand to related ✕

The "Expand to related" link strips the `mesh=strict` param and re-engages expanded mode.

### Example 5 — `?mesh=off` (escape hatch)

**Query:** `health economics`, then user clicks **"Don't use MeSH ✕"** on the chip.

**What happens:**

- URL becomes `?q=health+economics&type=publications&mesh=off`.
- Resolver still runs and logs the resolution (so analytics see the opt-out rate per descriptor), but the route handler nulls it before passing to `searchPublications`.
- Body shape collapses to the §1.2 multi_match — pure BM25, no MeSH paths. Same as Example 3.
- **No chip**. The escape is sticky for as long as `?mesh=off` is in the URL.

### Example 6 — Author-name search

**Query:** `Cantley LC`

**What happens:**

- Resolver finds no descriptor (`Cantley LC` doesn't match any MeSH name or entry term).
- Falls through to §1.2 multi_match. The `authorNames` field has boost 2.
- Result set: publications where Cantley appears in the author list, ranked by relevance score (so high-author-count pubs and those with Cantley in title-mention positions score well).

**Note:** author searches do NOT use the WCM-specific identity layer here — that's a separate facet. The free-text `authorNames` field carries every author on every paper exactly as PubMed records them; useful for finding co-authors outside WCM or papers from before someone joined.

### Example 7 — Title-verbatim quotation

**Query:** `electronic health records adoption barriers`

**What happens:**

- Resolver matches `electronic health records` (substring inside the query? no — it requires the full normalized query). With the full string, no exact-name match, no entry-term match. **No resolution.**
- Falls through to §1.2 multi_match. `best_fields` scoring + title boost = 4 means a paper whose title is "Adoption Barriers to Electronic Health Records" scores very high — its title hits 4 of the 5 query tokens.

**Caveat:** the resolver is **whole-string match only**. It does NOT do "best-substring" MeSH resolution against `electronic health records adoption barriers` to find an EHR descriptor buried inside. That's deliberate — partial-string matching introduces false positives (e.g., `q=cancer prevention strategies in low-income communities` would pull a `Cancer` chip that's not what the user wanted to highlight). The §1.2 multi_match still finds the EHR papers via title/abstract matching; the chip just doesn't fire.

This is a known limitation — see [Behavior the reader might find surprising](#behavior-the-reader-might-find-surprising) below, under "Multi-word queries with a buried descriptor".

### Example 8 — Empty concept-tagged result

**Query:** `authorship` with `?mesh=strict`

**What happens (today):**

- Resolver matches `authorship` → **D001319 Authorship**.
- Strict-mode admission: only pubs tagged D001319 are admitted. Local corpus has very few such pubs (academia publishes about authorship, but most papers aren't *tagged* with that descriptor).
- If zero pubs are tagged → `ConceptEmptyState` renders: "No publications tagged with this concept · Search broadly for «authorship» — N results" (a single CTA link).

**What [#298](https://github.com/wcmc-its/Scholars-Profile-System/issues/298) proposes:**

- Render the broad-text fallback (top 10 pubs that mention "authorship" without being tagged) **on the same page**, below the empty-state header. No click required.
- Adds a "sparse trigger": if concept-tagged returns 1–5 hits AND broad-text would return ≥ 5× that, show both result sets with a divider.

That improvement is queued, not built. The current behavior is a dead-end that requires a click.

---

## What gets indexed

Publications index = one OpenSearch document per PMID. Built by `etl/search-index/index.ts` from the canonical `publication` table (which is ReCiter's output). Per-doc fields used by search:

| Field | Source | Role at query time |
|---|---|---|
| `title` | PubMed `ArticleTitle` | BM25, boost 4 |
| `meshTerms` | PubMed MeSH headings (canonical names, deduped, position-gapped) | BM25 boost 2; `match_phrase` admission under strict mode |
| `meshDescriptorUi` | PubMed MeSH headings, projected to descriptor UIs | `terms` admission under expanded mode (the **descendant** clause) |
| `reciterParentTopicId` | ReciterAI rollups (curated parent-topic attribution) | `terms` admission under expanded mode (the **anchor** clause); also strict-mode Path B |
| `authorNames` | PubMed author list, concatenated | BM25 boost 2 |
| `journal` | PubMed `Title` (NLM journal name) | BM25 boost 1; facet on `journal.keyword` |
| `abstract` | PubMed `Abstract` | BM25 boost 0.5 |
| `wcmAuthorCwids` | `publication_author` join (WCM-affiliated authors) | Facet; per-author result lists |
| `wcmAuthorPositions` | derived first/senior/middle from author rank | Facet bucket (first / senior / middle) |
| `year` / `publicationType` | PubMed | Sort + facet |
| `citationCount` | NIH iCite | Sort |
| `pmid` / `pmcid` / `doi` / `pubmedUrl` | PubMed | Linkout; not searched |
| `impactScore` / `topicImpacts` | ReciterAI synthesis | Sort + display (flag-gated; `SEARCH_PUB_TAB_IMPACT=on` to enable) |

The `meshDescriptorUi` and `reciterParentTopicId` fields are **keyword** (exact-match), not analyzed — they're the spine of the concept-aware admission.

---

## Resolver lookup table

The MeSH descriptor table (`mesh_descriptor`) is the source of truth for what `EHR` resolves to. It carries:

- `descriptor_ui` — the NLM UI
- `name` — canonical preferred-concept preferred term
- `entry_terms` — every alternate term NLM lists under any of the descriptor's concepts (deduped, with the canonical name excluded)
- `tree_numbers` — every position the descriptor occupies in the MeSH tree
- `scope_note` — NLM's free-text definition (shown in chip tooltip)

Loaded by `etl/mesh-descriptors/index.ts` from NLM's annual `desc<year>.xml` bulk file. Full-replace; ~31,000 descriptors for the 2026 release.

The resolver builds an in-process `Map<normalizedForm, descriptorUi[]>` at first use, cached for 1 hour. Normalization: lowercase + strip non-alphanumeric, so `cardio-oncology` / `cardio oncology` / `cardiooncology` all collapse to the same key.

When a normalized form maps to multiple descriptors (rare but real — e.g., a string that's an entry term on two unrelated descriptors), the tiebreaker is:
1. `localPubCoverage` (the fraction of indexed pubs tagged with each descriptor) — prefer the descriptor that's actually used in our corpus
2. Lexical similarity to the original query
3. `descriptorUi` (stable last-resort)

**Edge case worth knowing:** if `mesh_descriptor` is stale (loaded by a buggy parser version, see [#297](https://github.com/wcmc-its/Scholars-Profile-System/issues/297)), descriptor names can be wrong — and the chip will show the wrong concept. The fix is `MESH_FORCE_REPLACE=1 npm run etl:mesh` followed by a Node restart (the in-process map cache is keyed off the source-XML sha256, which a parser-fix backfill doesn't bump).

---

## Facets and filters

Each facet is multi-select with OR-within and AND-across semantics. The query body splits filters between `must` (always applied) and `post_filter` (excluded from per-axis aggregations so bucket counts are "what if I added this filter next?").

| Facet | Source field | Notes |
|---|---|---|
| Year range | `year` | Range filter; affects the year-range slider's bounds |
| Publication Type | `publicationType` | Top 15 by count |
| Journal | `journal.keyword` | Top 500 by count; client-side typeahead for the long tail |
| WCM Author Position | `wcmAuthorPositions` | Three buckets (first / senior / middle) — see [author-position derivation in search.md](search.md) |
| WCM Author | `wcmAuthorCwids` | Top 500 by count, hydrated server-side with name/slug/avatar; cardinality sub-agg shows true distinct count (e.g., "Author 1,619") |
| Mentoring Programs | `pmid` (via precomputed buckets) | MD / MD-PhD / PhD / Postdoc / ECR. The bucket sets are computed nightly by the mentoring rollup ETL |

Under expanded mode, facet aggs reference the same top-level `should` clauses + `msm: 1` that drive admission (instead of the `must`-only contract used under strict mode). This is why facet counts continue to reflect the actually-shown result set — no silent narrowing.

---

## Sort options

| Sort | Behavior |
|---|---|
| Relevance (default) | OpenSearch `_score` from the BM25 + boost layer described above |
| Year (newest first) | `year` desc |
| Citation count | `citationCount` desc |
| Impact (flag-gated) | `impactScore` desc, tiebreak on `pmid` for paging determinism |
| Recency (flag-gated) | `year` desc, tiebreak on `dateAddedToEntrez` desc |

Impact + Recency are behind `SEARCH_PUB_TAB_IMPACT=on`. When the flag is off, the dropdown hides those options (URL `?sort=impact` falls through to relevance — no 500).

---

## URL contract (publications-tab parameters)

| Param | Values | Effect |
|---|---|---|
| `q` | any string | Free-text query (and trigger for MeSH resolution) |
| `type` | `publications` | Active tab |
| `page` | integer ≥ 0 | Pagination (PAGE_SIZE = 20) |
| `sort` | `relevance` / `year` / `citations` / `impact` / `recency` | Sort key (some flag-gated) |
| `yearMin` / `yearMax` | integers | Year range |
| `publicationType` | exact string | Single-select |
| `journal` | repeated | Multi-select |
| `wcmAuthorRole` | `first` / `senior` / `middle`, repeated | Multi-select author position |
| `wcmAuthor` | CWID, repeated | Multi-select WCM authors |
| `mentoringProgram` | `md` / `mdphd` / `phd` / `postdoc` / `ecr`, repeated | Multi-select mentoring program |
| `mesh` | `off` / `strict` | Chip escape (off) or chip-narrow opt-in (strict). `off` wins over `strict` regardless of URL order |

The `mesh` precedence rule (`off` wins) is enforced both server-side in the route handler and in the chip-link generator (`buildMeshHref` will never emit both simultaneously).

---

## Rollback knobs

| Env | Default | What it does |
|---|---|---|
| `SEARCH_PUB_TAB_CONCEPT_MODE` | `expanded` | Set to `strict` to revert to PR-3-merge admission (today's `concept_filtered` body). Set to `off` for pre-§1.6 fallback (resolution logged but not applied). |
| `SEARCH_PUB_TAB_MSM` | `on` | Set to `off` to remove the `minimum_should_match` floor on unresolved-query multi_match. Pre-§1.2 behavior. |
| `SEARCH_PUB_TAB_IMPACT` | `off` | Set to `on` to surface Impact + Recency sort options + display `impactScore` / `conceptImpactScore` in hit rows. |

All three are env-flips, no redeploy required.

---

## Telemetry

Every pub-tab request emits a structured `search_query` log line with:

```jsonc
{
  "event": "search_query",
  "type": "publications",
  "q": "genome components",
  "resultCount": 487,
  "queryShape": "concept_expanded",         // or concept_filtered / concept_fallback / restructured_msm / legacy_multi_match
  "conceptMode": "expanded",                // resolved mode (after legacy fallback)
  "filters": { /* yearMin, yearMax, ... */ },
  "meshResolutionDescriptorUi": "D040481",
  "meshResolutionConfidence": "exact",
  "meshDescendantSetSize": 47,              // length of descendantUis (null when no resolution)
  "meshAnchorCount": 0,                     // length of curatedTopicAnchors (null when no resolution)
  "meshOff": false,                         // ?mesh=off
  "meshStrict": false,                      // ?mesh=strict
  "taxonomyMatchMs": 12,                    // resolver scope only
  "searchLatencyMs": 87,                    // body construction + OpenSearch + Prisma hydration
  "ts": "2026-05-15T12:34:56.789Z"
}
```

`taxonomyMatchMs` is logged on every branch (people / pubs / funding) so resolver-only regressions are observable everywhere. `searchLatencyMs` is publications-only — it's the input to the §3.1 (c) latency guardrail for the MeSH rebalance work.

The structured log is the substrate for the post-flip retro plot (recall lift by descendant-set size, latency distribution by query shape, chip-bounce rate, etc.).

---

## Behavior the reader might find surprising

Three honest buckets. Each item names what category it falls in, so the reader doesn't have to infer.

### By design

Behaviors that look like gaps but are deliberate trade-offs. Filing these as "improvements" would re-litigate decisions that already have answers.

#### See-also relations don't expand

`Authorship` (D001319) has a MeSH See-Also reference to `Plagiarism` (D015714). The descendant precompute only walks tree-prefix children, NOT See-Also links. A query for `authorship` will NOT surface Plagiarism-tagged pubs — and shouldn't, since "See Also" in MeSH is an editorial cross-reference, not a semantic-equivalence claim.

When the semantic relationship IS real but cross-tree (e.g., `CRISPR-Cas Systems` and `Genome Components` are both genome-editing-adjacent but sit in different MeSH sub-trees), the bridge mechanism is the **curated topic anchor table** (`mesh_curated_topic_anchor`, SPEC §1.4). A curator maps a descriptor to ReciterAI parent-topic IDs; those propagate as the fourth admission clause under expanded mode. Anchor coverage today is sparse — only descriptors that came up during Phase-1 curation — but the **mechanism** is the answer, not a missing feature.

#### Cross-tab fallback (auto-redirect when one tab is empty)

If a pub-tab search returns zero hits but `q=` would return 12 scholars on the People tab and 5 active grants on the Grants tab, we don't surface that. The user has to click each tab manually. Some other search products auto-redirect; we don't, for the same reason silent auto-broaden is rejected in [#298](https://github.com/wcmc-its/Scholars-Profile-System/issues/298) — academic search benefits from explicit user agency over which evidence model is in play (concept-tagged vs. text-mention vs. person-record vs. funded-project). Auto-redirect makes the system's interpretation invisible.

#### Concept-impact scoring is gated off

The `impactScore` and `conceptImpactScore` per-hit fields are computed by ReciterAI synthesis and written to the index, but the UI is gated on `SEARCH_PUB_TAB_IMPACT=on`. Default off pending a quality bar on the impact rollup — the gate is intentional, not forgotten. When enabled, hits show a small "Impact: X" or "Concept impact: X" badge and the sort dropdown gains Impact + Recency options.

### Upstream constraints we can't control

Behaviors that come from data we receive, not code we write.

#### MeSH lag for recent papers

NLM applies MeSH headings to PubMed papers asynchronously — typical lag is 6–18 months. A paper from the last few months may have an `abstract` but no `meshTerms` / `meshDescriptorUi`. It won't surface under the expanded-mode descendant clause; it can still surface via abstract BM25 if your query happens to hit. Non-MEDLINE journals never get MeSH at all (preprints, some industry journals, conference proceedings). No code fix possible — the gap closes when NLM catches up.

#### ReciterAI topic attribution is sparse for one-off pubs

The `reciterParentTopicId` field (anchor admission, expanded clause 4) requires that ReciterAI assigned the publication to a parent topic. Attribution is high-confidence for scholars with ≥ 3 pubs in a coherent area; one-off pubs and emerging-area first-papers often aren't attributed yet. Improves as the corpus grows; no per-query workaround.

### Known limitations and queued work

Real gaps with concrete future-state implications. Each item links to where it lives in the roadmap (or notes that it doesn't yet).

#### Empty / sparse result UX

Today: zero-result pages under `?mesh=strict` (or any path that returns no hits) show a single CTA link to broaden. Sparse pages (1–5 hits when broadening would return 50+) just show the sparse list with no signal.

Queued in **[#298](https://github.com/wcmc-its/Scholars-Profile-System/issues/298)**: co-render the broad-text fallback on the same page (top 10 inline + "View all N broad results →"). SPEC complete, ready for PLAN; requires no resolver/index changes, just a page-render addition.

#### Multi-word queries with a buried descriptor

A query like `electronic health records adoption barriers in rural hospitals` does NOT trigger MeSH resolution, because the resolver requires whole-string normalized match. The §1.2 multi_match still finds title/abstract hits, but the user doesn't see the EHR chip and doesn't get descendant expansion.

The fix is harder than it looks — naive substring matching introduces false positives (e.g., `cancer prevention in low-income communities` shouldn't fire a `Cancer` chip if the user's intent is the community-health angle). Possible future work: tokenize the query and check the longest contiguous span that resolves, with confidence-based suppression. **Not scoped; no issue filed yet.**

#### Multi-descriptor resolution (union of descendant sets)

A query that maps to multiple descriptors today picks ONE winner (via the `localPubCoverage` / similarity tiebreaker). The expanded body is then built from just that winner's descendants + anchors.

A future improvement is to admit on the **union** of multiple-descriptor descendant sets — useful for queries like `breast cancer` (which legitimately maps to both `Breast Neoplasms` and `Carcinoma, Ductal, Breast`). Deferred to Phase-3 work, SPEC §11.

#### Sibling explosion (admit siblings, not just descendants)

The descendant precompute walks **children only**, not siblings. A query for `Lymphoma, Non-Hodgkin` doesn't admit pubs tagged with the sibling descriptor `Lymphoma, Hodgkin`, even though a user looking for "lymphoma research" probably wants both. SPEC §10 Q3 — deferred to Phase-3.

---

## When to use the publications tab vs other surfaces

- **Want papers ON a topic** → publications tab (this doc).
- **Want people who WORK on a topic** → people tab (different signal stack — see `docs/search.md`).
- **Want money flowing INTO a topic** → grants tab (also `docs/search.md`).
- **Want a curated landing page** → look for the topic callout above the result tabs. If the resolver matched a curated parent topic / subtopic, there's a link to the dedicated page with all signals consolidated.
- **Want to browse rather than search** → see `docs/browse-vs-search.md`.

---

## How to verify this doc matches reality

The behaviors here are encoded in tests:

- `tests/unit/search-pub-query-shape.test.ts` — the body-shape matrix (§5 SEARCH_PUB_TAB_CONCEPT_MODE cases 1–10, §1.6 OR-of-evidence cases 1–5, §1.2 MSM cases 1–3).
- `tests/unit/search-flags.test.ts` — `resolveConceptMode` + `parseMeshParam` precedence rules.
- `tests/unit/search-broaden-href.test.ts` — `buildMeshHref` URL generation.
- `tests/unit/concept-chip.test.tsx` — chip rendering for each mode.
- `tests/unit/search-taxonomy.test.ts` — resolver tiebreaker behavior.
- `tests/unit/mesh-descriptor-parser.test.ts` — NLM XML parsing (the source of the lookup table).

If a behavior described here diverges from what the tests say, trust the tests and patch this doc.

---

## Cross-references

| Topic | Where |
|---|---|
| Why the field boosts are what they are | `docs/search.md` §How relevance is computed |
| The taxonomy-aware SPEC | `docs/taxonomy-aware-search.md` |
| Why ranking signals are precomputed in ETL | `docs/ADR-001-runtime-dal-vs-etl-transform.md` |
| Browse vs. search decision tree | `docs/browse-vs-search.md` |
| The 4-PR MeSH defaults rebalance | Issue #259, PRs #289, #293, #296, #299 |
| Next-up SPEC: empty/sparse-state co-render | Issue #298 |
| MeSH parser stale-data drill | Issue #297 (closed) |
