# People match-explainability — coverage eval (#702)

The gate before defaulting `SEARCH_PEOPLE_MATCH_EXPLAIN` on, following the #307
People-relevance pattern (an env-flag default flipped only after an eval, with an
independent rollback lever).

## What #702 changed

People highlighting was keyed to three self-reported fields
(`preferredName` / `areasOfInterest` / `overview`), but topic relevance scores
heavily on publication-derived fields (`publicationTitles^6` / `publicationMesh^4`).
A scholar admitted purely on publication evidence had nothing to highlight in the
bio fields, so the card rendered bare. #702 (behind `SEARCH_PEOPLE_MATCH_EXPLAIN`)
also highlights the pub fields (surfaced as a "Matched in publications: …"
snippet) and emits a last-resort "Matched on …" chip; #688's `computeMatchProvenance`
(behind `SEARCH_PEOPLE_MATCH_PROVENANCE`) was generalized to also explain a direct
concept match.

## The two gates

1. **Coverage** — the blank-card rate (fraction of top-page results the card would
   render bare) must drop sharply with the flag on.
2. **Ranking-regression guard** — #702 only widens the highlight *request*; it must
   not move ranking. The eval asserts the result order is byte-identical OFF vs ON
   on every query.

## Running it

Requires OpenSearch up (`npm run db:up`) with a current `scholars-people` index
(`npm run search:index:people`). Bypasses HTTP — calls the same `searchPeople` the
route does. Forces `SEARCH_GENERIC_TERM_DEMOTE=on` and `SEARCH_PEOPLE_MATCH_PROVENANCE=on`
on both passes so the only variable is `matchExplain`.

```
DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
  npm run eval:people-match-explain
```

Exit code is non-zero if the ranking-regression guard fails.

## Captured run — local index, 2026-06-02 (9 topic queries, top-20 each)

```
 query                        |  n | blank OFF | blank ON | self pub note chip | order
 microbiome research          | 20 |  90% (18) |   0% ( 0) |    2  18    0    0 | same
 microbiome                   | 20 |  90% (18) |   0% ( 0) |    2  18    0    0 | same
 crispr                       | 20 | 100% (20) |   0% ( 0) |    0  20    0    0 | same
 immunotherapy                | 20 |  85% (17) |   0% ( 0) |    3  17    0    0 | same
 machine learning             | 20 |  95% (19) |   0% ( 0) |    1  19    0    0 | same
 cardiology                   | 20 |  85% (17) |   0% ( 0) |    3  17    0    0 | same
 single cell rna sequencing   | 20 |  85% (17) |   0% ( 0) |    3  17    0    0 | same
 melanoma                     | 20 | 100% (20) |   0% ( 0) |    0  20    0    0 | same
 breast cancer                | 20 |  80% (16) |   0% ( 0) |    4  16    0    0 | same

 Aggregate blank-card rate:  OFF 90% (162/180)  →  ON 0% (0/180)
 ON composition:  self=18  pub=162  note=0  chip=0  blank=0
 Ranking-regression guard: PASS (order identical OFF vs ON on every query)
```

**Result:** blank-card rate **90% → 0%**, entirely via the pub snippet, with ranking
unchanged.

### Caveats / what staging adds

- **`note` reads 0 locally** because the dev DB lacks `mesh_curated_alias`, so MeSH
  resolution fails closed (`getMeshMap` → null) and the provenance note can't fire.
  The note is *additive* on top of the pub snippet; the staging run (where
  `mesh_curated_alias` is populated) is where it contributes. Re-run on staging to
  capture the `note` column.
- **`chip` reads 0** because pub highlighting already explains every card here. The
  chip is the residual catch-all for cards a pub fragment can't cover (e.g.
  dept/title-only matches).

## Bug surfaced and fixed by this eval

The first run threw `illegal_argument_exception: The length of [publicationTitles]
field of [5653] doc has exceeded [1000000] — maximum allowed to be analyzed for
highlighting`: a prolific author's concatenated `publicationTitles` blob exceeds the
index `highlight.max_analyzed_offset`, which fails the **whole** search (a 500) when
the flag is on. Fixed by capping the highlighter at `max_analyzer_offset: 900000`
when match-explain adds the blob fields (`lib/api/search.ts`). The flag-off body is
unchanged.
