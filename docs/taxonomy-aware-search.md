# Taxonomy-aware relevance for unified search (v2.2)

Spec for tightening recall and re-weighting concept queries against MeSH descriptors and entry terms, while keeping relevance and impact as separable signals. Companion to `search.md` (architecture reference) and `ADR-001-runtime-dal-vs-etl-transform.md` (why mapping changes are ETL-side).

Status: Phase 1 (§1.1, §1.2) merged in PRs #260, #261, #262. Phases 2 and 3 still pending.

## Corrections in v2.2 (post-implementation)

Three corrections surfaced during prod verification of Phase 1.

### Code corrections

- **§1.1 `type` is `cross_fields`, not `best_fields`.** The §1.1 prose described cross_fields semantics ("a scholar with 'electronic' + 'health' + 'record' scattered across name, areasOfInterest, title, publicationTitles should match") but the code snippet specified `best_fields`. `best_fields` picks the single best-matching field and applies msm only to its tokens — so a scholar whose three concept tokens land in three different fields fails msm (each field sees only 1 of 3). `cross_fields` blends the field group as one big field for IDF and matching, which is what the prose described. Implementing what the spec meant rather than what it said.

- **§1.1 / §1.2 msm string is `"2<-34%"`, not `"-0% 3<-25%"`.** Two-step correction:
  - *Syntactic:* `"-0% 3<-25%"` is invalid OpenSearch — bare segments without `<` trip `For input string: "-0%"`. The equivalent valid form is `"3<-25%"` (the leading "require everything" fragment is the implicit default when no condition matches).
  - *Semantic loosening:* `"3<-25%"` required all tokens on 3-token queries, the modal length of concept queries after stemmer collapse ("electronic health records" → 3 tokens). `"2<-34%"` allows 1 token missing on 3-token queries; it changes *only* the 3-token row of the table (3→2 required), leaving 1, 2, 4+ -token behavior identical. 34%, not 33%, because `floor(0.33 × 3) = 0` lands the floor-rounding exactly at the boundary; 34% rounds up cleanly.

  Required-token table by analyzed-token count (v2.2):

  | analyzed tokens | 1 | 2 | 3 | 4 | 5 | 8 |
  |---|---|---|---|---|---|---|
  | required | 1 | 2 | 2 | 3 | 4 | 6 |

The MeSH-resolution OR-of-evidence shape in §1.6 keeps `type: "best_fields"` for its tiebreaker `multi_match` because that's a name-field-dominated query (different signal profile), but the must-clause should use `cross_fields` when ported. Pub-tab §1.2 keeps `type: "best_fields"` — title-verbatim matches are the dominant relevance signal on the publications surface (unlike the people surface, where concept tokens legitimately scatter across name/title/interest fields).

### Acceptance-band revision

Acceptance band revised from "low-4-figures (~1,000-2,500) people for `electronic health records`" to **"~200-400 high-evidence matches."**

The original band was an intuition about defensible candidate-set size, not a measurement. Implementation revealed that the prior count of 4,303 was ~95% drive-by department matches (a single token like "Health" matching `primaryDepartment`) and ~5% real high-evidence matches; the original band implicitly assumed a softer evidence distribution than the data supports. The `msm + cross_fields` combination correctly identifies the ~300-scholar high-evidence set; expanding past that would require re-admitting the false-positive tail that the spec set out to remove in the first place.

The original spec's quality goals are met:

- Top-10 correct (all Population Health Sciences faculty/staff at WCM).
- No zero-result regression on the eval corpus.
- Nominal-query top-1 unaffected (per-faculty searches still return that faculty member).

The recall *count* missed the band; the recall *composition* didn't.

A note on top-1 stability: under `"3<-25%"` the EHR top-1 was Rainu Kaushal (department chair, the institutional EHR face since ~2008). Under `"2<-34%"` it's Judy Zhong (high-output biostatistician working on EHR-derived data). Both are legitimate top-1 results; which one is "right" depends on whether the user wants the active researcher or the senior figure, and BM25 doesn't know. The shuffle happened because the ranking is now sensitive to the actual evidence distribution rather than to noise — which is the point of the restructure.

### Process note for future specs

Recall-band predictions should be **sampled from the index** before being written into the spec, not estimated from intuition about query semantics. The v2.0/v2.1 prediction of "1,000-2,500 EHR people" was a reasonable-sounding number derived from "what does a defensible candidate set look like?" — but the index distribution was knowable in advance with a half-day of query work, and would have produced a different (and correct) target. Phase 2's recall predictions for `publicationMeshLeadAuthor` and `publicationReciterTopicsLeadAuthor` should be backed by sampled distributions, not by intuition about what a good answer looks like.

## Differences from v2:

- **People-index query restructure (the headline scholar-tab recall fix) lifted into Phase 1.** It has no MeSH dependency and delivers the original 4,303 → 4-figure acceptance on its own. Bundling it with Phase 2 hid the most user-visible improvement behind concept-resolution work.
- **`reciterParentTopicId` and `publicationReciterTopicsLeadAuthor` explicitly typed as `keyword`**, queried with `terms`. They're opaque IDs, not language.
- **Phasing reframed as a quarter of work.** Phase 1 committed in detail; Phase 2/3 to be re-planned at the respective retrospectives.
- **Impact-admission floor in 2.1 deferred to Phase 1 telemetry**; provisional value is 40 (matches spotlight floor), not the previously-plucked 25.
- **Stemmer family verified** (`lib/search.ts` already uses `{ type: "stemmer", language: "english" }`). Resolved before merge.
- **Anchor-table coverage** framed honestly: head-of-distribution in Phase 1, long tail filling in via derived anchors.
- **Phase 1 rollback** now includes a positive success criterion.
- **`conceptImpactByDescriptor` storage cost** estimated.

For the history of how the spec got here (v1 → v2 → v2.1), see the appendix at the bottom.

Status: draft — pending review before implementation.

---

## Problem

A user typing **"electronic health records"** at `/search` currently sees:

- **Scholars tab:** 4,303 of ~9,000 active scholars.
- **Publications tab:** 27,162 of ~90,000 pubs (~30% of the corpus).
- **Funding tab:** 996 projects.

On the pub tab, top hits are sensible (title-verbatim matches dominate via `best_fields`) but recall is enormous and the user has no way to filter or weight by quality. On the scholar tab, the top three results are Department of Population Health Sciences faculty whose visible snippet matches only on "Health" in the always-rendered `primaryDepartment` label (boost 3, not highlighted but readable). Several are genuinely strong EHR people; the system can't tell us so from the surfaced evidence, and the long tail is dominated by drive-by department matches.

### Root causes

1. **No `minimum_should_match`.** `multi_match` defaults to OR with no token-coverage floor.
2. **`publicationAbstracts` is a long concatenated blob on the people index.** Even with msm, the blob clears any per-field threshold on its own. Per-pub `abstract` on the publications index doesn't have this property.
3. **No concept awareness.** "Electronic Health Records" is MeSH descriptor **D057286** with entry terms *Electronic Medical Record(s)*, *Computerized Patient Record(s)*, *EHRs*, *EMRs*. The query is a curated concept and we index publication MeSH — but the search layer treats input as loose tokens.
4. **Surface form sensitivity.** "EHR" shares no token overlap with "Electronic Health Records."
5. **No quality signal exposed at query time.** `impactScore` is on every `publication_topic` row, range ~9-83, already used as a spotlight floor — but unified search doesn't surface or sort on it.

---

## Goals

- Cut scholar-tab recall on concept queries from ~half the institution to a defensible candidate set.
- Make surface-form variants (EHR ↔ EMR ↔ electronic health records ↔ electronic medical records) interchangeable.
- Give users a quality lever on results — relevance vs impact as separable sorts, not fused.
- Cover scholars and pubs whose work doesn't yet have MeSH (recent pubs, non-MEDLINE venues) via ReciterAI's parallel topic tagging.
- Preserve current behavior for nominal queries (CWID, name lookups) and for queries that don't resolve.
- Give users a visible confirmation when the system has interpreted their query as a curated concept, with a way to opt out.

### Non-goals

- Replacing BM25 with embeddings.
- A continuous relevance/impact fusion slider in unified search. Three-way sort dropdown replaces this; the slider becomes a v2 question for dashboard surfaces.
- Building a full ontology layer. MeSH as-is from NLM.
- Touching the grants tab.

---

## Architectural principles

**Separable signals.** Relevance (is this row about the concept?) and impact (how much should this row count?) live in different fields and combine only at sort time, never inside BM25 reps.

**Pubs-first for concept-awareness.** Per-pub impact is current and per-row; per-scholar concept impact requires aggregation. Validate the model on pubs first.

**People-index restructure ships independently of concept-awareness.** The `publicationAbstracts` blob split (1.1) has no MeSH dependency and delivers the headline scholar-tab cut on its own. It's first in Phase 1.

**Parallel evidence: MeSH + ReciterAI topics.** MeSH has known lag and coverage gaps. ReciterAI assigns `parent_topic_id` at pub ingestion with no lag and broad coverage. At filter time, evidence from either source admits a row. The anchor table that connects them (1.4) is the gating dependency.

**Measure before tuning.** Citation rescue, pub-type weights, tree-walk expansion, too-broad cutoffs, adaptive top-N — all moved to Phase 3 and gated on eval data.

---

## Phase 1 — Recall cut + concept-aware pubs

Phase 1 has an internal dependency gradient. 1.1 has no MeSH or ETL dependency and is shippable on its own in ~1 week. 1.2 through 1.6 build MeSH infrastructure with no user-visible change. 1.7 through 1.11 are the user-visible concept-aware pub-tab pieces and ship together once the infrastructure lands.

### 1.1 — People-index query restructure (no MeSH dependency)

The current `multi_match` on the people index lumps every field together. With `best_fields` and `minimum_should_match`, the floor applies *per field* — and `publicationAbstracts` is a concatenated blob that clears any token-coverage threshold on its own. So msm on the existing shape barely tightens anything.

Restructure into two groups, using `cross_fields` for the high-evidence must clause (v2.2 correction; `best_fields` would require all tokens to land in one field, but concept queries legitimately scatter tokens across name/title/interest/publication-titles):

```ts
{
  bool: {
    must: [{
      // High-evidence fields. msm applies meaningfully here.
      multi_match: {
        query,
        fields: [
          "preferredName^10",
          "fullName^10",
          "areasOfInterest^6",
          "primaryTitle^4",
          "primaryDepartment^3",
          "overview^2",
          "publicationTitles^1",
          "publicationMesh^0.5",
        ],
        type: "cross_fields",
        operator: "or",
        minimum_should_match: "2<-34%",
      }
    }],
    should: [{
      // Blob field — scoring only, no msm constraint.
      // Cannot drag in spurious results because msm is on the must clause.
      match: {
        publicationAbstracts: { query, boost: 0.3 },
      }
    }],
  }
}
```

msm reads as: "for ≤3 clauses require all (implicit default when no condition matches); for >3, allow up to 25% missing." Tokens are *post-analysis* — `scholar_text` strips English stopwords first. `cross_fields` (v2.2 correction) blends the high-evidence field group as one big field so a scholar with concept tokens scattered across `preferredName`, `areasOfInterest`, `publicationTitles` etc. satisfies msm.

**Edge cases:** CWID short-circuit (boost:100 on exact `cwid` keyword) is upstream and unaffected. Name autocomplete uses the completion suggester. 1-token queries trivially clear the floor.

**Unit test required:** the OpenSearch msm parser is easy to misread. Cover 1, 2, 3, 4, 5, 8 analyzed tokens; verify required-token counts of 1, 2, 2, 3, 4, 6 (per the v2.2 loosened table — see corrections section above for why the 3-token row dropped from 3-required to 2-required).

**Acceptance:** scholar-tab result count for "electronic health records" drops from 4,303 to a 4-figure number. This is the original headline-problem acceptance criterion and it lives here, not in Phase 2.

**Independently shippable.** No dependency on MeSH ETL or anchors. Gated behind `SEARCH_PEOPLE_QUERY_RESTRUCTURE`.

### 1.2 — `minimum_should_match` floor on pub-tab `multi_match`

The pub-tab `abstract` is a single paper's abstract (not concatenated), so msm on the existing shape works fine — no field restructure needed.

Add `minimum_should_match: "2<-34%"` to the existing `multi_match` query. Same unit-test table as 1.1. Pub-tab keeps `type: "best_fields"` — title-verbatim matches are the dominant relevance signal here (unlike the people tab, where concept tokens legitimately scatter across name/title/interest fields).

### 1.3 — NLM MeSH ingestion (ETL)

New `mesh-descriptors` job in `etl/`:

1. Fetch latest `desc<year>.xml` from <https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/> (~80MB compressed).
2. Parse into a `MeshDescriptor` table: `descriptorUi`, `name`, `entryTerms` (string[]), `treeNumbers` (string[]), `scopeNote`, `dateRevised`.
3. Emit a flat `synonyms.txt` for OpenSearch's `synonym_graph` filter. One line per descriptor; equivalent form (no `=>`).
4. **Drop entry terms shared across multiple descriptors** at ETL. Common-abbreviation collisions (PCR, CRP, MS) create transitively-connected synonym graphs in equivalent form. Detect: `term → [descriptorUi]` map; exclude any term mapping to >1 descriptor. Disambiguation falls through to resolution (1.5), which has explicit tiebreak rules.
5. Push to S3 path `s3://scholars-search-config/synonyms/mesh-<version>.txt`.

Cadence: NLM publishes in November. Run yearly; mid-year update files on demand.

### 1.4 — MeSH-curated-topic anchor table

The OR-of-evidence pattern (1.6 and 2.4) requires a mapping from MeSH descriptor to ReciterAI curated parent topic.

```sql
CREATE TABLE mesh_curated_topic_anchor (
  descriptor_ui   VARCHAR(10) NOT NULL,
  parent_topic_id VARCHAR(128) NOT NULL,
  confidence      VARCHAR(16) NOT NULL,  -- 'curated' | 'derived'
  source_note     TEXT,
  PRIMARY KEY (descriptor_ui, parent_topic_id)
);
```

**Honest framing of coverage:** OR-of-evidence is a *head-of-distribution* feature in Phase 1, not a global property of the system.

- **Curated** anchors for the top 30-50 concept queries from access logs. Half a day to a day of curation team time. Covers most query volume.
- **Derived** anchors fill in over Phase 2 and beyond: for each descriptor, the curated topic with the highest fraction of pubs sharing both tags (threshold e.g. ≥30% co-occurrence). Auto-generated at ETL.
- **Tail queries** (rare, no anchor either curated or derivable) fall back to MeSH-only filtering and inherit the v1 invisibility problem for non-MEDLINE scholars on those specific concepts. Tracked via `search.path_b_admission_rate` per resolved descriptor.

When no anchor exists for a resolved descriptor, OR-of-evidence drops Path B and degrades to MeSH-only. Safe degradation.

### 1.5 — MeSH concept resolution

Extend `matchQueryToTaxonomy()` in `lib/api/search-taxonomy.ts` to resolve against MeSH after curated topics/subtopics.

Resolution algorithm:

1. Normalize: lowercase, collapse whitespace, strip non-alphanumeric.
2. Look up in an in-memory map (built from `MeshDescriptor` at boot, refreshed daily):
   - Exact match on normalized `name` → return descriptor with confidence `exact`.
   - Exact match on any normalized `entryTerm` → return descriptor with confidence `entry-term`.
   - No fuzzy / prefix matching in v1.
3. If multiple descriptors match, prefer (in order): anchor to a curated topic exists (1.4) → highest `localPubCoverage` (1.7) → most recent `dateRevised` → alphabetical `descriptorUi`.

Return shape:

```ts
type MeshResolution = {
  descriptorUi: string;     // "D057286"
  name: string;             // "Electronic Health Records"
  matchedForm: string;
  confidence: "exact" | "entry-term";
  scopeNote?: string;
  entryTerms: string[];
  curatedTopicAnchors: string[];  // parent_topic_id[]; empty if no anchor
};
```

In-memory map of ~30k descriptors fits comfortably; no Redis layer in v1.

### 1.6 — Concept-aware pub filter (OR-of-evidence)

Adds a new `keyword` field on the publications index: **`reciterParentTopicId`** (multi-valued, populated from `publication_topic.parent_topic_id` for the pub). Keyword not text — these are opaque identifiers, not language. Queried with `terms`, not `match`.

When `matchQueryToTaxonomy()` returns a MeSH resolution AND the descriptor has at least one curated-topic anchor:

```ts
{
  bool: {
    must: [{
      bool: {
        should: [
          // Path A: MeSH evidence.
          // match_phrase chosen as safer default until ETL is verified to
          // inject position gaps between MeSH terms in the analyzed stream.
          // If gaps are confirmed, downgrade to:
          //   match: { meshTerms: { query: resolution.name, operator: "and", boost: 8 } }
          { match_phrase: { meshTerms: { query: resolution.name, boost: 8 } } },

          // Path B: ReciterAI topic evidence. Covers no-MeSH pubs (recent,
          // non-MEDLINE) that the AI pipeline has tagged.
          // terms on a keyword field: exact-value match on opaque IDs.
          { terms: { reciterParentTopicId: resolution.curatedTopicAnchors, boost: 6 } },
        ],
        minimum_should_match: 1,
      }
    }],
    should: [{
      // BM25 scoring across free-text fields, with msm from 1.2.
      multi_match: {
        query,
        fields: ["title^5", "abstract^1", "meshTerms^2"],
        type: "best_fields",
        operator: "or",
        minimum_should_match: "2<-34%",
      }
    }],
  }
}
```

When the descriptor has no anchor: drop Path B, fall back to MeSH-only `must`. When no resolution at all: existing query shape with 1.2 msm floor.

**Pubs not yet processed by ReciterAI** (whatever the ingestion lag is — minutes to hours post-Entrez) fall through to free-text matching via title/abstract. Real but minor.

### 1.7 — Per-descriptor coverage metrics

For each MeSH descriptor, compute and store on `MeshDescriptor`:

- `localPubCoverage` — fraction of indexed pubs tagged with the descriptor. Input to resolution tiebreaking (1.5) and to Phase 3's too-broad cutoff (3.3).
- `localLeadAuthorScholarCoverage` — fraction of active scholars with the descriptor in their lead-author MeSH set above the rep threshold. Computed in Phase 2; deferred until then.

### 1.8 — `impactScore` display + three-way sort

Pub-tab result rows already render title, journal, year, authors. Add:

- **`impactScore` badge** on each row when present. Format: `"Concept impact: 78"` when a MeSH descriptor resolved (using max impact across the pub's `publication_topic` rows that match the resolved concept's anchored topic); `"Impact: 78"` otherwise (max across all topic rows for the pmid). Omit when `impactScore` is null.
- **Sort dropdown** in the pub-tab header: `Relevance` (default, BM25), `Impact` (`impactScore` desc), `Recency` (`year` desc, tiebreak on `dateAddedToEntrez`).

`Relevance` and `Impact` are within the candidate set defined by the filter. Users get to the canonical-originator paper via Impact sort even when the candidate set is huge.

### 1.9 — Alias-swap ETL refactor (prerequisite for Phase 2)

The current `etl/search-index/index.ts` does an in-place rebuild — `ensureIndex` deletes the physical index by canonical name and recreates it. Two problems for Phase 2: (a) brief delete-create-bulk-load window is downtime, and (b) Phase 2's mapping changes (new fields, new search-analyzer wiring) can't be applied in-place — OpenSearch refuses field-mapping changes on existing fields.

Add the standard alias-swap pattern in Phase 1:

1. Rename existing physical indices to versioned forms (`scholars-people-v1`, etc.).
2. Create aliases at the canonical names.
3. Rewrite `ensureIndex` to (a) build a new versioned physical index, (b) bulk-load, (c) validate doc count + smoke-query sample, (d) atomically repoint the alias via `_aliases`, (e) delete the previous version after a 24h hold.

Application code keeps using the constants from `lib/search.ts` unchanged. Rollback is a one-call alias repoint.

### 1.10 — Synonym filter on `meshTerms` (search-time)

Add to `lib/search.ts` index settings:

```ts
analysis: {
  filter: {
    mesh_synonyms: {
      type: "synonym_graph",
      synonyms_path: "synonyms/mesh.txt",
      updateable: true,
    },
  },
  analyzer: {
    mesh_search: {
      tokenizer: "standard",
      // Order matters: lowercase → expand synonyms → THEN stem.
      // Stemming after expansion ensures expanded surface forms get stemmed
      // identically to how they were stemmed at index time.
      filter: ["lowercase", "mesh_synonyms", "english_stemmer"],
    },
  },
}
```

**Stemmer family verified.** `lib/search.ts:65,156,231` defines `english_stemmer` as `{ type: "stemmer", language: "english" }`. Same family as proposed for `mesh_search` — index-time and query-time stemming agree.

Apply `mesh_search` as the **`search_analyzer`** on `meshTerms`; leave index-time `analyzer` unchanged. Asymmetric analyzer pattern; no reindex when MeSH updates.

**Why not apply synonyms to title/abstract?** A query for "EHR" expanding to "computerized patient records" against titles would pull in 1990s nomenclature. Synonyms work on controlled vocabularies; on free text they over-recall.

**Synonym refresh timing.** `updateable: true` reload pauses queries on affected shards while the analyzer rebuilds. Schedule reload as the *last* step of the daily ETL window, never on demand.

### 1.11 — UI: resolved-concept chip on pub tab

When a query resolves to a MeSH descriptor, render a chip above the result tabs:

```
┌─────────────────────────────────────────────────────────────┐
│  Showing pubs for MeSH concept: Electronic Health Records   │
│  Matched your search for "EHR" · Search broadly instead ✕   │
└─────────────────────────────────────────────────────────────┘
```

- Hover/tap on descriptor name shows scope note.
- "Search broadly instead" passes `?mesh=off` to the API, falls through to the no-resolution shape (keeps 1.2 msm floor).
- Chip appears in addition to the existing curated-topic callout when both fire.

### 1.12 — Phase 1 success and rollback criteria

**Phase 1 ships (observable on eval corpus at rollout):**

- Scholar-tab result count for "electronic health records" is in the low-4-figures (target ~1,000-2,500), down from 4,303.
- Pub-tab resolved-concept queries on the eval corpus show >50% reduction in p95 result count without regression in top-10 manual-review ratings.

These are checkable the day Phase 1 lands in prod. If both hold, Phase 1 is done.

**Phase 1 succeeded (observable after 2-4 weeks of prod traffic, gates Phase 2 kickoff):**

- `search.sort_choice_distribution` shows users actively reach for Impact or Recency on at least 15% of resolved-concept queries (signal that the three-way sort is real, not vestigial; informs whether the v2 fusion slider is worth building later).

This is a product-success signal, not a ship gate. If it doesn't hold by the Phase 1 retrospective, Phase 2's sort affordances get re-examined before being copied to the scholar tab.

**Pre-committed rollback triggers**, two of three automatic rollback:

- Pub-tab p95 result count drops below 50 for resolved-concept queries (over-tightening).
- Top 10 nominal queries (names; CWID exact match short-circuits) regress by >1 position in top-10 composition.
- Zero-result rate on the eval corpus rises above 3%.

One trigger is 24h watch + manual call.

### 1.13 — Phase 1 sizing

- People-index restructure (1.1) + msm unit tests: ~1.5 days
- Pub-tab msm (1.2): ~0.5 day
- NLM ETL + descriptor table + collision drop (1.3): ~3 days
- Anchor table + curated population for top descriptors (1.4): ~1 day (incl. curation team coordination)
- `matchQueryToTaxonomy` extension + cache (1.5): ~1.5 days
- Pub-tab OR-of-evidence filter + `reciterParentTopicId` keyword field (1.6): ~1.5 days
- Per-descriptor coverage metrics (1.7): ~0.5 day
- `impactScore` display + three-way sort (1.8): ~1.5 days
- Alias-swap ETL refactor (1.9): ~1 day
- Synonym wiring (1.10): ~0.5 day
- Concept chip + scope note hover (1.11): ~0.5 day

**Phase 1 total: ~13 dev-days.** Calendar conversion is ~4 dev-days per week to account for PR review cycles, eval-pass coordination, curation-team scheduling for anchor curation (1.4), and the manual-review ratings (~6-15 hours of senior staff time). That gives **~3 weeks calendar for a senior dev.** The calendar number is downstream of the dev-day estimate; don't compress it without compressing the underlying days.

Internal sequence: 1.1 + 1.2 can ship together at ~1 week; the rest of Phase 1 ships once 1.3-1.6 land.

---

## Phase 2 — Concept-aware scholar tab

Builds on Phase 1's restructure (1.1), ETL, anchors, resolution, and alias-swap. Phase 2 is committed at the level of detail here, but the *plan itself* will be re-opened at the Phase 1 retrospective once we have Phase 1 telemetry.

### 2.1 — New lead-author fields (people index)

Two new fields, populated by the people-index ETL:

- **`publicationMeshLeadAuthor`** (text, `scholar_text` analyzer): MeSH terms from first/last-author pubs only, repeated by `relevance_rep_count` (2.2). Strict subset of `publicationMesh`, ~30% the size.
- **`publicationReciterTopicsLeadAuthor`** (**`keyword`**, multi-valued, no analyzer): `parent_topic_id` values from first/last-author pubs where the pub's `publication_topic.impact_score` clears the admission floor. Opaque IDs; queried with `terms`. Repetition not meaningful for keyword fields, so the repetition formula is applied to the *relevance reps for the descriptor*, and the topic ID is emitted at most once per scholar — admission is binary on this field. Scoring contribution comes from `boost: 6` in the filter, not from term frequency.

**Impact admission floor — provisional 40, tuned from Phase 1 telemetry.**

The floor controls which lead-author pubs contribute to `publicationReciterTopicsLeadAuthor`. v2 used 25 with hand-wavy reasoning; v2.1 defers the decision:

- Provisional value at Phase 2 start: **40** (matches the existing spotlight floor in `lib/api/spotlight.ts:201`). Rationale: anchored in another product surface, continuity, no fresh number to defend.
- Phase 1's pub-tab work surfaces the per-descriptor `impactScore` distribution as a side effect (since impact is now a sort dimension on the pub tab). Use that data to tune the Phase 2 admission floor before 2.1 ships.
- Configurable via `SEARCH_RECITER_TOPIC_IMPACT_FLOOR` environment variable; default updates after Phase 1 telemetry.

### 2.2 — Repetition formula (relevance only)

```python
def relevance_rep_count(pub, scholar_position, current_year):
    author_w = {
        "first": 10, "last": 10,
        "second": 4, "penultimate": 4,
        "middle": 1,
    }[scholar_position]
    age = current_year - pub.year
    recency_w = math.exp(-age / 7.2)  # 7.2 → 5-year half-life
    # Returns raw float. DO NOT round per pub — accumulates to bias.
    return author_w * recency_w


def total_reps_for_term(scholar, term):
    raw = sum(
        relevance_rep_count(p, scholar.position_on(p), current_year)
        for p in scholar.pubs_with_term(term)
    )
    return round(raw)
```

Authorship × recency. Pub-type weights and citation rescue deferred to Phase 3.

**Minimum-evidence threshold:** term included in `publicationMeshLeadAuthor` if `total_reps_for_term >= 3`. A single first-author pub from 2009 contributes ~1.7 reps and doesn't qualify on its own; two recent first-author pubs do.

### 2.3 — Per-(scholar, concept) impact aggregate

New doc-value field `conceptImpactByDescriptor` — a map keyed by `descriptorUi` (and a parallel map keyed by `parent_topic_id`), value is the scholar's aggregate impact for that concept.

Aggregation rule for v1: **flat top-5 mean of `impactScore × author_w × recency_w` across the scholar's lead-author pubs tagged with the concept.**

Adaptive top-N (cancer top-7, niche top-2 in your intuition) deferred to Phase 3 contingent on per-descriptor distribution data from Phase 2 telemetry.

**Storage cost:** ~9k scholars × ~50 active descriptors per scholar × 8 bytes ≈ **4 MB per index**. Trivial. Parallel topic-ID map is similar (~250 curated topics, even smaller per-scholar distribution).

**Cross-concept comparability:** the aggregate is non-comparable across concepts (top-5 cancer and top-5 VNS aren't on the same scale). Fine — we never rank across concepts; the aggregate sorts within a single resolved-concept query.

### 2.4 — Concept-aware scholar filter (OR-of-evidence)

When a MeSH descriptor resolves with at least one curated-topic anchor:

```ts
{
  bool: {
    must: [{
      bool: {
        should: [
          // Path A: MeSH evidence.
          // match_phrase by default; downgrade to match+and if ETL position
          // gaps between MeSH terms are confirmed (see 1.6 note).
          { match_phrase: { publicationMeshLeadAuthor: { query: resolution.name, boost: 8 } } },

          // Path B: ReciterAI topic evidence — covers scholars whose
          // EHR-relevant lead-author pubs are MeSH-less.
          // terms on a keyword field: exact-value match on opaque IDs.
          { terms: { publicationReciterTopicsLeadAuthor: resolution.curatedTopicAnchors, boost: 6 } },
        ],
        minimum_should_match: 1,
      }
    }],
    should: [{
      // BM25 tiebreaker. publicationMesh / publicationAbstracts deliberately
      // omitted — mesh evidence is in must, abstract noise is what we're avoiding.
      multi_match: {
        query,
        fields: [
          "preferredName^10",
          "fullName^10",
          "areasOfInterest^6",
          "primaryTitle^4",
          "overview^2",
          "publicationTitles^1",
        ],
        type: "best_fields",
      }
    }],
    minimum_should_match: 0,
  }
}
```

`primaryDepartment` and `publicationAbstracts` lose ground intentionally — they're the main vehicles of the current false-positive set. `areasOfInterest^6` survives in `should` for ranking-tiebreak; admission is via OR-of-evidence.

**When the descriptor has no anchor:** Path B drops; MeSH-only `must`. **When no resolution:** the 1.1 restructured shape with msm floor.

### 2.5 — Permissive fallback (msm floor preserved)

If the resolved-concept query returns fewer than **20 candidates**, fire a second query that drops the OR-of-evidence `must` but **keeps the 1.1 restructured shape with its msm floor intact**:

```ts
const strict = await searchClient.search({ ...strictBody });
if (strict.hits.total.value >= 20) return strict;

// Permissive fallback — 1.1 restructured shape, msm floor PRESERVED.
// Drops only the concept must; does not recreate the 4,303-scholar
// problem for niche concepts where strict returns <20.
const broadBody = {
  query: {
    bool: {
      must: [{
        multi_match: {
          query,
          fields: [
            "preferredName^10",
            "fullName^10",
            "areasOfInterest^6",
            "primaryTitle^4",
            "primaryDepartment^3",
            "overview^2",
            "publicationTitles^1",
            "publicationMesh^0.5",
          ],
          type: "cross_fields",
          operator: "or",
          minimum_should_match: "2<-34%",  // KEPT
        }
      }],
      should: [{
        match: { publicationAbstracts: { query, boost: 0.3 } },
      }],
    }
  },
};
return await searchClient.search({ index: PEOPLE_INDEX, body: broadBody });
```

This is the real defect-fix from v1: v1's fallback dropped both the concept filter AND the coverage floor, recreating the 4,303-scholar problem for any niche concept query returning <20 strict candidates. Fallback now drops only the *concept filter*.

Threshold 20 = PAGE_SIZE; configurable via `SEARCH_MESH_FALLBACK_THRESHOLD`.

`opts.topic` curated-topic pre-filter is upstream of OpenSearch (Prisma-resolved CWID set) and applies to BOTH queries — fallback widens within the topic-filtered set, not across it.

### 2.6 — Three-way sort on scholars tab

Same dropdown as 1.8 pub tab: `Relevance` (BM25, default), `Impact`, `Recency`.

- **Relevance**: BM25 on the structure above. Within candidate set.
- **Impact**: `conceptImpactByDescriptor[descriptorUi]` desc (from 2.3). Within candidate set. When no concept resolved or no aggregate present, sort hidden or falls back to mean impact across all concepts — decide from Phase 1 telemetry.
- **Recency**: scholar's most-recent lead-author concept-tagged pub year, desc. Tiebreak on Relevance.

**MeSH filter applies regardless of sort.** A user typing a concept and switching to Impact sort is asking *within* the concept set. "Search broadly instead" on the chip is the escape hatch.

### 2.7 — Highlight extension + concept-resolved snippet

Today's highlight config at `lib/api/search.ts:472-480` covers `preferredName`, `areasOfInterest`, `overview`. **`primaryDepartment` is NOT in the highlight config** — the "Health" in the bad-case screenshot is the always-rendered department string on the result card, not a highlight match. Two distinct fixes for the perceptual problem:

**2.7a — Highlight extension.** Add `publicationTitles` to the highlight config so title-level concept evidence (currently the strongest signal on the people index, but never highlighted) surfaces in the snippet:

```ts
highlight: {
  fields: {
    preferredName: {},
    areasOfInterest: {},
    overview: { number_of_fragments: 1, fragment_size: 150 },
    publicationTitles: { number_of_fragments: 2, fragment_size: 120 },
  },
  pre_tags: ["<mark>"],
  post_tags: ["</mark>"],
}
```

Cap fragment counts so a scholar with 50 EHR pubs doesn't blow up the response. `publicationAbstracts` stays out — abstract excerpts read as cherry-picked.

**2.7b — Card rendering (the actual fix for the "Health" perception).** When `meshResolution` is present, augment the result card with a concept-evidence line above the always-rendered title/department label:

```
┌─────────────────────────────────────────────────────────────┐
│  [avatar]  Dr. Jane Smith                                    │
│            27 lead-author pubs on Electronic Health Records  │
│            Concept impact: 84                                │
│            Professor of Medicine · Population Health Sciences│
└─────────────────────────────────────────────────────────────┘
```

The count is the scholar's `publicationMeshLeadAuthor` + `publicationReciterTopicsLeadAuthor` for the resolved descriptor, deduplicated by pmid. The impact line is `conceptImpactByDescriptor[descriptorUi]` (2.3). The always-on title/department line drops to a smaller, lower-contrast secondary line — so "Health" stays true on the row but is no longer the dominant visible token.

**Scope.** 2.7b engages only when `meshResolution` is present. Queries that don't resolve to a MeSH descriptor still see the original card layout with `primaryDepartment` at full prominence. That's defensible — the perceptual problem manifests on concept queries, which by construction resolve under Phase 2's OR-of-evidence — but 2.7b is not a general result-card redesign.

### 2.8 — `opts.topic` × MeSH intersection

When both a curated parent topic pre-filter AND a MeSH resolution are present, they apply as AND: candidate set is `(scholars attributed to curated topic) ∩ (scholars cleared by OR-of-evidence)`. Curated topic narrows first via Prisma; OR-of-evidence narrows within OpenSearch. Permissive-fallback threshold checked against the post-intersection count.

### 2.9 — Phase 2 rollback criteria

- Top-10 composition on resolved-concept eval queries shifts by >50% vs the post-Phase-1 baseline AND >30% of swapped-in scholars are rated "weak" or "unrelated" by manual review.
- `permissive_fallback_rate` > 30%. Catches threshold miscalibration.
- Zero-result rate for resolved concepts > 8%. Catches Path B coverage gaps.

Two of three triggers automatic rollback of `SEARCH_MESH_CONCEPT_FILTER`. The 1.1 restructure stays on (independent value, gated separately under `SEARCH_PEOPLE_QUERY_RESTRUCTURE`).

### 2.10 — Phase 2 sizing

- People-index reindex with new fields, ETL changes (2.1): ~3 days
- Repetition formula (relevance-only) + minimum-evidence threshold (2.2): ~1 day
- `conceptImpactByDescriptor` aggregation at index time (2.3): ~2 days
- People-tab OR-of-evidence filter (2.4) + permissive fallback (2.5): ~2.5 days
- Three-way sort on people tab (2.6): ~1 day
- Highlight extension + concept-resolved snippet (2.7): ~1.5 days
- `opts.topic` intersection wiring + tests (2.8): ~0.5 day
- Eval harness updates + manual review coordination: ~2 days

**Phase 2 total: ~13.5 dev-days (≈3 weeks calendar incl. review).**

Plan to be re-opened at Phase 1 retrospective; current sizing is a forecast, not a commitment.

---

## Phase 3 — Signal refinements (data-driven)

Each item ships only if eval data justifies it. Pre-committed measurement → pre-committed decision. Like Phase 2, the *plan itself* will be re-opened at the Phase 2 retrospective.

### 3.1 — Citation rescue

**Trigger to ship:** if Phase 2 eval shows canonical-originator papers (high-citation old pubs) systematically ranked below recent low-impact pubs by the same scholar, and the Impact sort doesn't already address this.

```python
cite_bonus = log10(max(pub.citation_count, 1)) / 4  # ~0 at 1 cite, 1.0 at 10k cites
return author_w * (recency_w + cite_bonus * 0.5)
```

Log scaling rather than v1's linear-to-100 plateau. v1's plateau-at-100 collapsed expertise gaps between 100-cite and 10,000-cite papers; log distinguishes them.

**Skip ship** if the divide-and-conquer model is doing the job: high-citation old pubs surface via Impact sort even when recency drives them down in Relevance sort.

### 3.2 — Tree-walk expansion (descendants only)

**Trigger to ship:** eval shows scholars whose lead-author work is on narrower descendants of the queried concept are under-admitted.

Add `mesh_tree_relation` table at MeSH ETL. Wrap Path A in `dis_max` with `tie_breaker: 0.2`:

```ts
{
  dis_max: {
    queries: [
      { match_phrase: { publicationMeshLeadAuthor: { query: resolution.name, boost: 8 } } },
      ...descendants.map(d => ({
        match_phrase: { publicationMeshLeadAuthor: { query: d.name, boost: 4.8 } }
      })),
    ],
    tie_breaker: 0.2,
  }
}
```

Skip ancestors (indexer chose the broader term deliberately). Skip siblings (noisy). Cap descendant depth at 3. `tie_breaker: 0.2` so parallel-evidence scholars accumulate credit at a discount, not dominated by single-match.

### 3.3 — Too-broad descriptor handling

**Trigger to ship:** eval shows specific descriptors where even Impact sort doesn't produce a defensible top page.

Compute `localLeadAuthorScholarCoverage` distribution. Cutoff at 95th percentile (configurable via `SEARCH_MESH_BREADTH_CUTOFF_PCT`). Above cutoff: skip OR-of-evidence `must`, degrade to synonym-expansion-only (1.10 still fires). Chip copy: "*Aging* is a broad concept — add a more specific term to narrow results."

**Open question for Phase 3 eval:** does D057286 ("Electronic Health Records") itself land above the 95th percentile? If yes, the headline scholar-tab problem requires either a lower cutoff OR trusting that Impact sort within a large candidate set is enough. Verify against actual numbers before shipping.

### 3.4 — Adaptive top-N

**Trigger:** Phase 2 instrumentation shows top-5 mean is systematically zero-padded for narrow descriptors OR systematically dilutes for broad descriptors.

Candidate functions (decide empirically):
- Bucketed by `localPubCoverage` percentile
- Continuous: `N = clamp(round(log10(lead_author_pub_count) * 2), 1, 7)`
- Hybrid

Until then, flat 5.

### 3.5 — Pub-type weights (impact-side)

**Trigger:** eval shows editorials/case-reports surfacing in Impact sort despite being categorically less weighty.

If shipped: lives on the impact aggregate (2.3), not relevance reps. Preserves divide-and-conquer.

### 3.6 — Multi-descriptor resolution

**Trigger:** eval shows meaningful prevalence of queries like "depression in cancer patients" where single-descriptor resolution leaves obvious evidence on the table.

If shipped: top-N resolution (N=2 likely), both descriptors contributing to OR-of-evidence via additional `should` clauses.

### 3.7 — Phase 3 sizing

Worst case if all six ship: ~5-7 dev-days. Most likely 2-4 ship; ~3-4 dev-days realistic.

---

## UI surface — chip + sort, summary

When a query resolves to a MeSH descriptor, render a chip above the result tabs (text differs slightly between pub and people tabs):

```
┌─────────────────────────────────────────────────────────────┐
│  Showing results for MeSH concept: Electronic Health Records │
│  Matched your search for "EHR" · Search broadly instead ✕    │
└─────────────────────────────────────────────────────────────┘
```

Sort dropdown lives in the result header on both tabs: `Relevance` (default) · `Impact` · `Recency`.

Existing curated taxonomy callout takes precedence visually when both fire — curated above (WCM-specific, intentional), MeSH chip below.

For too-broad descriptors if Phase 3 ships 3.3: copy reads "*Aging* is a broad concept — add a more specific term to narrow results"; filter not applied; sort dropdown still available.

---

## Rollout flags

Independent, gated in `lib/search.ts`:

| Flag | Phase | Initial state |
|---|---|---|
| `SEARCH_PEOPLE_QUERY_RESTRUCTURE` | 1.1 | Staging first, prod after 48h watch — ships earliest, no concept-aware dependencies |
| `SEARCH_PUB_MSM` | 1.2 | Staging first, prod after 48h watch |
| `SEARCH_MESH_SYNONYMS` | 1.10 | Off until synonym file lands |
| `SEARCH_MESH_CONCEPT_FILTER_PUBS` | 1.6 | Off until UX review of chip behavior |
| `SEARCH_PUB_IMPACT_SORT` | 1.8 | Ship with concept filter |
| `SEARCH_RECITER_TOPIC_IMPACT_FLOOR` | 2.1 | Default 40 at start; updated from Phase 1 telemetry |
| `SEARCH_MESH_CONCEPT_FILTER` | 2.4 | Off until Phase 2 eval pass |
| `SEARCH_CONCEPT_SNIPPET` | 2.7 | Ship with people-tab concept filter |
| `SEARCH_PEOPLE_IMPACT_SORT` | 2.6 | Ship with people-tab concept filter |
| `SEARCH_CITATION_RESCUE` | 3.1 | Off until Phase 3 eval pass |
| `SEARCH_TREE_WALK` | 3.2 | Off until Phase 3 eval pass |
| `SEARCH_BREADTH_CUTOFF` | 3.3 | Off until Phase 3 eval pass |

---

## Telemetry & evaluation

### Query corpus

Fixed evaluation set spanning:

- Top 20 concept queries from access logs (last 6 months)
- Edge cases: single-token concepts ("CRISPR"), multi-token ("electronic health records"), acronyms ("EHR", "fMRI"), surface-form variants, non-MeSH concepts ("WCM-NYP integration"), CWIDs, names

**N=50, coarse-only.** Adequate for before/after comparison; not powered for per-stratum claims. If strata-specific concerns surface, grow to N≥150 with stratified sampling.

Per query, per phase: total result count per tab, top-10 composition overlap, whether MeSH resolved, whether Path B contributed admissions, whether permissive fallback triggered, sort distribution.

### Manual review

For the top 20 concept queries, the publication-curation team rates top 10 results as **strong / weak / unrelated** before and after. Target ≥70% strong on resolved-concept queries; no regression on nominal queries.

**Time budget:** 500 ratings × before/after × Phase 1 + same Phase 2 ≈ 30 hours of senior staff time across both phases. Confirm with curation team lead before Phase 1 ships. If unavailable, drop to top 5 per query (~15 hours) or top 10 results for top 10 queries only (~6 hours per pass).

### Production metrics

- `search.resolved_concept_rate` — fraction of queries that resolve
- `search.permissive_fallback_rate` (Phase 2) — fraction of resolved scholar queries that hit <20 fallback
- `search.path_b_admission_rate` (both phases) — fraction of admitted results that cleared via ReciterAI topic but not MeSH. Sanity check on OR-of-evidence value.
- `search.sort_choice_distribution` — fraction of users who switch to Impact or Recency. **Primary signal for whether the v2 fusion slider is worth building.**
- `search.zero_result_rate` per resolution mode
- `search.result_count.p50/p95` — recall distribution before/after
- `search.click_through_rate.position_1` per tab

---

## Risks & open questions

**Anchor table coverage is a head-of-distribution feature in Phase 1.** Top 30-50 concept queries get curated anchors; the long tail falls back to MeSH-only and inherits v1's invisibility problem for non-MEDLINE scholars on those niche concepts. Derived anchors fill in over Phase 2. Tracked via `search.path_b_admission_rate` per descriptor.

**ReciterAI ingestion lag.** Pubs not yet processed by the AI pipeline are out of luck for Path B. Lag is short (minutes to hours) but real for brand-new pubs. Phase 2 telemetry should track: of pubs added in the last 7 days, what fraction have `parent_topic_id`?

**Position gaps for `match_phrase`.** Defaulted to `match_phrase` over `match`+and as safer until ETL is verified to inject position-gap increments between MeSH terms. Verification during Phase 1 1.10. If gaps exist, downgrade to `match`+and; if not, either reindex with explicit gaps (people-index reindex already in Phase 2 scope) or stay on `match_phrase`.

**Curated topic vs MeSH ordering.** When both resolve, the UI shows curated topic as primary chip. Filter applies based on MeSH OR (anchored curated topic). These will usually agree but won't always — curated may be tuned to WCM-specific definitions. Resolve in Phase 2 UX review.

**MeSH license.** NLM-published and freely reusable; no licensing concern.

**Synonym file size.** ~30k descriptors × ~5 entry terms ≈ ~150k synonym lines, ~5MB. OpenSearch handles it; reload pause is the cost (addressed by ETL-window scheduling).

**Supplementary records** (`supp<year>.xml`, chemicals/organisms) out of scope.

**Slider in v2.** Three-way sort is v1. Continuous fusion slider is a plausible follow-up if `sort_choice_distribution` shows users actively reaching for both Relevance and Impact.

---

## Estimated effort and framing

**This is a calendar quarter of one-dev focused work, not a 6-7 week sprint.**

- Phase 1: ~3 weeks calendar (~13 dev-days). Committed in detail. Independently shippable. **Phase 1's internal sequence allows 1.1 + 1.2 to land at ~1 week even if the rest of Phase 1 slips.**
- Phase 2: ~3 weeks calendar (~13.5 dev-days). Sized but **plan will be re-opened at the Phase 1 retrospective** with Phase 1 telemetry in hand.
- Phase 3: ~1-1.5 weeks (~5-7 dev-days). Each refinement gated on a pre-committed eval trigger; **plan re-opened at the Phase 2 retrospective.**
- Eval passes between phases: ~4 days × 2 = ~1.5 weeks.

**Headline scope is 8-10 calendar weeks.** Phase 1's headline-fix piece (1.1) is shippable on its own at ~1 week if everything else slips. The phase-boundary discipline is what protects this from being an open-ended project.

---

## Key decisions

Load-bearing choices, compact reasoning.

### Architecture and sequencing

- **People-index restructure (1.1) leads Phase 1.** No MeSH dependency. Delivers the original 4,303 → 4-figure acceptance criterion on its own.
- **Pubs-first for concept-awareness.** Per-pub `impactScore` is current and per-row; per-scholar concept impact requires aggregation.
- **Divide-and-conquer.** Relevance in BM25 reps (authorship × recency); impact in its own field (`impactScore` per pub, `conceptImpactByDescriptor` per scholar). Combined at sort time only.
- **OR-of-evidence for non-MeSH coverage.** MeSH + ReciterAI topic in parallel at filter time. Requires anchor table (1.4); degrades safely when no anchor.
- **Anchor coverage is head-of-distribution in Phase 1, not global.** Top 30-50 queries curated; long tail derived over time; rare-concept tail accepts MeSH-only as the failure mode.

### Field types

- **`reciterParentTopicId`** (pub index, 1.6) and **`publicationReciterTopicsLeadAuthor`** (people index, 2.1) are **`keyword`** type, queried with `terms`. Opaque IDs, not language. v2 left this ambiguous; resolved here.
- **`publicationMeshLeadAuthor`** stays `text` with `scholar_text` analyzer — repetition counts drive scoring.
- **`conceptImpactByDescriptor`** is a doc-value field for sort. Storage ~4MB per index, trivial.

### Query shape

- **`match_phrase`** as safer default over `match`+`operator:"and"` until ETL position-gap behavior is verified.
- **`minimum_should_match: "2<-34%"`** on high-evidence clauses. Unit-test against analyzed-token counts.

### Resolution and filtering

- **Permissive fallback keeps msm floor** (2.5). Drops the *concept filter*, not the *coverage floor*. v1 dropped both.
- **`opts.topic` × MeSH = AND** (2.8). Curated topic narrows via Prisma first; OR-of-evidence narrows within OpenSearch.
- **MeSH filter applies regardless of sort** (2.6). "Search broadly instead" on the chip is the escape.

### Signal weighting

- **Relevance rep formula is `author_w × recency_w`.** No pub-type weights, no citation rescue in v1 — both Phase 3 contingent on eval data.
- **Lead-author fields** for both MeSH and ReciterAI topics. Filter on these in 2.4; rank on full `publicationMesh` via `should`.
- **Impact aggregate is flat top-5 mean** in v1. Adaptive N deferred to Phase 3.
- **Impact-admission floor for `publicationReciterTopicsLeadAuthor`: provisional 40, tuned from Phase 1 telemetry.** Anchored in existing spotlight floor pending data.
- **Tree-walk deferred to Phase 3.** dis_max with tie_breaker:0.2 if shipped.

### Synonym filter

- **Asymmetric analyzer pattern.** Index-time `scholar_text` unchanged; search-time `mesh_search` runs `lowercase` → `mesh_synonyms` → `english_stemmer`.
- **Stemmer family verified** (`{ type: "stemmer", language: "english" }` in `lib/search.ts` for all three index analyzers).
- **Synonyms on `meshTerms` only**, not title/abstract. Controlled vocab vs free text.
- **Synonym reload at end of ETL window**, never on demand.
- **Shared entry terms dropped at ETL.**

### Snippet

- **`primaryDepartment` is not currently in the highlight config** (verified at `lib/api/search.ts:472-480`). The "Health" perception in the bad case is the always-rendered card label, not a highlight match. Fix is in card rendering (2.7b), not highlight config.
- **`publicationTitles` added to highlight** (2.7a). Title-level concept evidence is the strongest signal on the people index and currently never highlighted.
- **Concept-resolved row** (2.7b) renders count + impact line above the (smaller, lower-contrast) title/department label when `meshResolution` present.

### Rollout

- **Three phases, not three waves.** Phase boundaries are infrastructure-shaped. Each subsequent phase will be re-planned at the previous phase's retrospective.
- **Pre-committed rollback criteria per phase** (1.12, 2.9). Two of three triggers automatic rollback.
- **Phase 1 positive success criterion** is explicit: scholar-tab recall cut, pub-tab p95 reduction, sort engagement ≥15%.
- **Alias-swap pattern in Phase 1** as prerequisite for Phase 2 mapping changes.

### Evaluation

- **N=50, coarse-only.** Manual review budget confirmed with curation team before Phase 1 ships.
- **`search.sort_choice_distribution`** is the primary signal for whether the v2 fusion slider is worth building.

---

## Appendix — versioning history

How the spec arrived at its current shape. Skip unless reviewing a linked older issue.

### Versus v1

- **Pubs-first sequencing** for concept-awareness. Per-pub `impactScore` is current and per-row; per-scholar concept impact requires aggregation, so the pub tab is where the divide-and-conquer model is cleanest to validate.
- **Divide-and-conquer.** Relevance and impact are separable throughout. Repetition formula no longer fuses impact into BM25 reps (v1 had `cite_bonus` and `pub_type_w` inside the rep count, which baked impact into BM25 irreversibly).
- **OR-of-evidence for non-MeSH coverage.** ReciterAI's `parent_topic_id` runs in parallel to MeSH at filter time. v1 left the MeSH-lag and non-MEDLINE-invisibility problem to "permissive fallback partially mitigates," which doesn't actually mitigate it (a `must` rejection happens before any `should` clause can score).
- **Citation rescue, pub-type weights, tree-walk, too-broad cutoff, adaptive top-N** all deferred to Phase 3 with pre-committed measurement triggers. v1 shipped them as load-bearing constants without data.
- **Permissive fallback fix.** v1's fallback dropped both the concept filter AND the coverage floor, recreating the 4,303-scholar problem for any niche concept query returning <20 strict candidates. v2 drops only the concept filter.
- **Citation rescue uses log scaling** (when/if shipped in Phase 3), not v1's linear-to-100 plateau. v1's plateau collapsed expertise gaps between 100-cite and 10,000-cite papers.
- **Three waves → three phases.** Phase boundaries are infrastructure-shaped with cleaner attribution when something goes wrong. v1's "Wave 2" coupled four substantive changes (new field, new rep formula, new filter, new snippet).

### Versus v2

(See the top-of-doc "Differences from v2" section.) Headline changes: lifted 1.1 into Phase 1 with its own acceptance criterion; explicit keyword typing for `reciterParentTopicId` and `publicationReciterTopicsLeadAuthor`; stemmer family verified with file reference; impact floor deferred to Phase 1 telemetry with provisional value 40 (matching spotlight floor) instead of plucked 25; 1.12 success criterion split into ship-time (eval-corpus) and prod-time (sort distribution); 2.7b scope explicitly limited to MeSH-resolved queries.
