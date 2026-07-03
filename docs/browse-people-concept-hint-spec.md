# Browse people rows: replace sparse research-area hint with top MeSH concepts

**Status:** proposal — awaiting approval
**Date:** 2026-06-21
**Surface:** `/search` People tab (Browse + query results), the per-scholar row secondary line.

## Problem

On Browse (no query), most scholar rows show only `— no specific match for this query —`,
and only a minority show the boxed `AREAS …` hint. Two distinct issues:

1. **Sparse identity hint.** The `AREAS` hint is fed by `areasOfInterest`, i.e. the
   ReciterAI research areas — which are only computed for in-scope (full-time-faculty)
   enriched publications. Filter counts: ~2,416 full-time vs ~5,408 affiliated, so the
   large majority of rows structurally cannot populate it.
2. **Wrong empty line on Browse.** `— no specific match for this query —` is correct
   inside real query results, but on the no-query Browse page there *is* no query, so it
   reads as broken.

## Decision (chosen direction)

**Top concepts only.** In the no-match identity slot, show a uniform **TOPICS** hint
sourced from per-scholar **top MeSH descriptors** (`Publication.meshTerms`) instead of
research areas. MeSH tagging exists for any PubMed-indexed paper, independent of the
ReciterAI scope, so it is dense where research areas are sparse, and it is consistent with
the existing profile "Topics" section (#73, "Topics = MeSH").

## Hard constraint (must not regress)

The query-match snippets — `name`, `method`, `topic`, `publications`, `selfDescription`,
`affiliation` — are untouched. The change lands **only** on `selectEvidence` steps 8–9
(`areas` / `none`, the very tail of the precedence) and their rendering.

## Changes

### 1. Index doc — new per-scholar field
- `lib/search-index-docs.ts`: add `topMeshTerms: string[]` to the people doc — top-N
  (N = 8) MeSH descriptor labels by per-scholar accepted-pub frequency.
- Reuse `extractMeshLabels` (already in this file) + the profile aggregation approach
  (`normalizeMeshTerms` / `ScholarKeyword` frequency in `lib/api/profile.ts`).
- Check-tags (Humans/Male/…) are already filtered upstream by ReciterDB, so the JSON
  shouldn't contain them; v1 = top-N by frequency, no extra stoplist.
- **Requires a people reindex** (`npm run search:index:people`).

### 2. Evidence model — new kind
- `lib/api/result-evidence.ts`:
  - Add `{ kind: "concepts"; labels: string[]; total: number }`.
  - Extend `SelectEvidenceInput` with `concepts?: { labels; total } | null`.
  - `selectEvidence` **step 8**: emit `concepts` from `input.concepts` when present;
    stop emitting `areas` (concepts-only). Step 9 stays `none`.
  - Keep the `areas` kind in the union (tested elsewhere); just stop selecting it here.

### 3. Server
- `lib/api/search.ts` `searchPeople`: populate `input.concepts` from the hit's
  `topMeshTerms` (labels capped to `CONCEPTS_CAP = 4`, `total` = full length); drop the
  `areasOfInterest`-fed `areas` population. Flag-gated (below).

### 4. Client
- `components/search/result-evidence.tsx`:
  - Add `ConceptsHint` (label `TOPICS`, middot list, `+N more`) — mirror `AreasHint`.
  - `kind: "concepts"` → render `ConceptsHint`. `EmptyMatchLine` renders **only when a
    query is present** (`hasQuery`), so the no-query Browse state never shows it.
  - `kind: "none"` → nothing on Browse; `EmptyMatchLine` only under a query.
- `components/search/people-result-card.tsx`: thread `hasQuery` (derive from `q`) into
  `ResultEvidence`.

### 5. Flag
- `SEARCH_PEOPLE_CONCEPT_HINT` — staging-on / prod-off. Off ⇒ today's behavior
  (research-area hint + empty line) exactly.

## Rollout
1. Merge dark (flag off) — pure no-op for prod.
2. Add `topMeshTerms` → people reindex on staging (in-VPC `search:index:people`).
3. Flip flag on staging → verify Browse rows render TOPICS, no empty line, snippets intact.
4. Prod later: own reindex + flag flip (gated).

## Tests
- `selectEvidence`: concepts tier wins step 8; `none` when absent; all higher tiers unchanged.
- `result-evidence-card.test.tsx`: `ConceptsHint` renders; empty line suppressed when no query, kept when query present.
- index-doc unit: `topMeshTerms` top-N aggregation + ordering.

## Out of scope
- Widening ReciterAI enrichment scope (the real fix for area sparsity; cost-gated).
- The query-level Research-Areas chip row (`research-areas-row.tsx`) — unchanged.
