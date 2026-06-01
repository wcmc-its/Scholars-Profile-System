# Why retracted publications don't display

How the Scholars Profile System keeps retracted papers off profiles, topic pages, the home
feed, and search — and why a dedicated nightly ETL step is required to do it.

**Mechanism:** `etl/pubmed-retractions/` (nightly) + the `NEVER_DISPLAY_TYPES` read-path filter (`lib/publication-types.ts`)
**ETL cadence (source of truth):** `cdk/lib/etl-stack.ts` → `nightlySteps` (`PubMedRetractions`)
**Run manually:** `npm run etl:pubmed-retractions`
**Refs:** #604 (this step) · #63 (the original read-path filter) · ReCiterDB#90 (rejected upstream approach) · PR #625

---

## The goal

A scholarly profile system must not present **retracted papers** as legitimate output. A
retracted article on a faculty member's profile — or in their topics, the home feed, or
search — is a research-integrity and reputational problem. (A Scholars launch KB article,
#506 Gate D, promises this behavior.)

## PubMed represents a retraction as two records

1. The **retraction notice** — a short record typed `Retraction of Publication`
   ("Paper X has been retracted").
2. The **original article** — the paper that was retracted. Once retracted, PubMed also
   stamps the original with the publication type `Retracted Publication` (MeSH D016441).

## What was already handled (#63)

SPS hides anything whose `publicationType` is `Retraction`/`Erratum` via the
`NEVER_DISPLAY_TYPES` filter in `lib/publication-types.ts`, applied across every read path
(home, profile, topics) and both search-index doc builds (`lib/search-index-docs.ts` — the
publications index *and* the people-doc authorship rollup). That catches the **notice**.
#63 = done.

## The gap this step closes

The **original article** is a different record with its own type — when published it was
`Academic Article` / `Journal Article`, **not** `Retraction`. So the #63 filter never
touches it, and the retracted paper keeps displaying.

There is supposed to be a backstop: ReCiter, on **re-fetching** a paper's PubMed record,
collapses a retracted original to `publicationType = 'Retraction'` — which the #63 filter
then hides. But ReCiter only re-fetches on its own cadence, not nightly. **Any paper
retracted since ReCiter last fetched it keeps its pre-retraction type and leaks onto
profiles** — potentially indefinitely, for a stable author who isn't being re-disambiguated.

Measured against PubMed's full `"Retracted Publication"` set (32,559 PMIDs) intersected
with the corpus (2026-05-30):

| Source | retracted originals held | already hidden (collapsed to `Retraction`) | residual leak |
|---|---|---|---|
| ReciterDB `analysis_summary_article` | 144 | 114 | **30** |
| SPS local (dev DB) | 67 | 60 | **7** |

The leak also **grows over time** as new retractions land that ReCiter won't re-fetch.

## Why not fix it upstream (ReCiterDB#90)?

The original plan was an upstream `retracted` boolean in the reporting tables. But that
boolean would be derived from the **same re-fetched PubMed record**, so it inherits the
**same lag** — it wouldn't close the gap. ReCiterDB#90 was closed as "not the right layer."

## The fix

Ask **PubMed directly** — it is the source of truth for retraction status. Each night the
`PubMedRetractions` step:

1. Fetches the full set of `"Retracted Publication"` PMIDs from NCBI E-utilities ESearch,
   **paged by publication year** (each year stays under ESearch's `retstart=9998` ceiling;
   a bucket over the ceiling **throws** rather than silently truncating).
2. Stamps any corpus publication in that set, **not already** typed `Retraction`, to
   `publicationType = 'Retraction'`.
3. The existing #63 filter then hides it everywhere — **no schema change, no read-path change.**

A zero-size fetch **aborts** the run (fetch-fault guard) rather than no-op'ing on bad data.

## Why the ordering in the nightly chain matters

`PubMedRetractions` sits **after `Reciter`** and **before `SearchIndexNightly`**
(`cdk/lib/etl-stack.ts` → `nightlySteps`):

- **After `Reciter`** — reciter's upsert overwrites `publication_type` from ReciterDB on
  every row, so the stamp must come after it or be clobbered back to the stale type.
- **Before `SearchIndexNightly`** — so the same night's reindex reflects the stamp.
- **Re-running nightly self-heals un-retractions** (rare): reciter restores the real type,
  then this step simply no longer re-stamps a PMID that has left the retracted set. The
  stamp is not append-only.

## Accepted tradeoff

Overwriting `publication_type` discards the original type for stamped rows. This is
invisible to users (the row is hidden either way). A future retraction **badge** would
instead need the real type preserved plus a separate `isRetracted` flag — out of scope,
and the reason ReCiterDB#90 was closed rather than pursued.

## Operational note

Being *in* the nightly chain is not the same as *running*:

- **Staging** — the nightly schedule is enabled, so the gap closes on the next nightly run
  automatically.
- **Production** — Step Functions schedules are disabled by design until launch, so the
  step does not auto-run yet. The residual retracted originals stay visible in prod until
  the schedules are enabled at launch, or someone runs `npm run etl:pubmed-retractions`
  followed by a reindex manually.
