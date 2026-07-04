# Finding: the "buried methods-scientist" is mostly a data bug — Track B re-scopes to B2 + data/taxonomy

_Measured 2026-06-30 (in-VPC probe), confirming the attribution flag from
`docs/search-trackB-prebuild-diagnostic.md`. This collapses the methods-scientist ranking
thesis and re-scopes Track B._

## Confirmed: Christopher Mason has zero attributed pubs in staging

| signal | value |
|---|---|
| staging people index `publicationCount` (chm2042) | **0** |
| staging publications index — pubs listing `wcmAuthorCwids: chm2042` | **0** |
| control: pubs listing `wcmAuthorCwids: ole2001` (Elemento) | 538 |
| his 8 sampled known pmids present in the pub index | **0 / 8** (all 404) |
| local `publication_author` rows for chm2042 | **468** |

So a real, prolific WCM faculty member is **entirely unattributed** in staging search — he can
only ever match on name/text, never on topical publications, so he's buried on *every* topical
query. This is an **upstream author-disambiguation / ETL attribution gap** (ReCiter identity or
the people/pub-index author linkage), **not** a ranking problem. It is scholar-specific
(Elemento/Betel/Landau are attributed fine), so it's an individual disambiguation miss, not a
systemic index failure (**1 of 40 probed gold scholars** — only Mason — has `publicationCount=0`;
the other 39 are attributed). Local has his 468 rows; staging has none → likely a staging-data
regression or a disambiguation change. **Route to the data/ReCiter team.**

## Why this collapses the methods-scientist ranking thesis

The whole "methods-scientists are buried" premise leaned on Mason (#706/MISS). Remove the data
artifact and re-read the flag-off baseline:

| query | cleanly-attributed methods-scientists | buried? |
|---|---|---|
| single-cell RNA sequencing | Betel #11, Landau #6, Elemento #28 | **no** (and the concept pool was empty — they rank on base text + prominence) |
| CRISPR | Dow #1, Vardhana #32, Guo #55 | no |
| hypertension | Wachtell #18 | no |
| FMT | Peled #3 | no |
| alzheimer's | Glodzik #20, Anna Orr #103 | only via `meshMapped=false` keyword crater (Finding C) |

The only deeply-buried methods cases are **Mason (data bug)** and the **alzheimer's** ones
(**Finding C**, lay-term mapping). **No cleanly-attributed methods-scientist on a well-mapped
query is buried by ranking.** So B1 (authorship restructure) and the concept `n²/total`
volume-penalty change are addressing a near-non-problem for the current gold set — and loosening
the concentration would risk regressing #1343's deliberate specialist-over-generalist win for no
measured gain.

## Re-scoped Track B (evidence-ranked)

1. **Author-attribution gap (data, not search)** — verify scope (how many scholars beyond Mason
   have `publicationCount=0` despite real authorship) and route upstream. Highest real-world impact;
   no ranking change fixes it.
2. **B2 — clinical-as-function_score** — the one genuine *ranking* lever: thin-publication
   clinician-experts (Igel #183, Aras #264 on obesity) need clinical signal as a function_score
   boost (proven: clinical text fields are inert). **This is the Track B worth building.**
3. **Finding C — lay-term MeSH aliases** (#1258) — fixes diabetes/alzheimer's keyword crater across
   all archetypes.
4. **scRNA-type narrow-descriptor coverage** — the resolved descriptor has ~0 corpus so concentration
   can't fire; a taxonomy-coverage issue (overlaps #1258), not authorship.
5. **B1 authorship restructure + B3 scheme-unify** — **DROP** unless a future gold case demonstrably
   needs them. Not supported by the current evidence.

## Gold-set note

Mason (chm2042) is a **confounded exemplar** until his attribution is fixed — flag or drop him from
the methods-scientist gold cohort so the per-archetype scorecard isn't dragged by a data bug.
