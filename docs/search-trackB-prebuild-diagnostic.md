# Track B pre-build diagnostic — the authorship premise doesn't hold for the gold cases

_Measured 2026-06-30 while starting B0/B1 implementation. Before writing the authorship-
expertise restructure, I diagnosed WHY the gold-set specialists are actually buried. The
finding revises the approved plan: **B1 (authorship-expertise restructure) is not the lever
for the buried methods-scientists.** Stop and re-decide before building._

## What B1 assumed vs what the code/data show

The plan's B1 = generalize authorship credit to 10/4/1 + `1/√N` so high-N **middle-author**
methods-scientists (Mason) get concentration credit. Two checks refute this for the gold cases:

1. **B0 (tuning the existing boost weights/thresholds) is inert** for buried specialists — the
   concentration formulas give them ~0, so no weight/threshold tuning lifts them. (Same shape as
   the Track A finding.)

2. **The two concentration paths don't work the way B1 targets:**
   - **Curated path** (`getAreaScholarConcentration`, `publication_topic`): Mason already ranks
     **near the top** in `single_cell_spatial_biology` (topicScore 7.9, n=14 first/last, concentration
     0.47, among only 28 area scholars). So curated-path authorship handling is **not** burying him.
   - **Concept path** (`getConceptScholarConcentration`, the OS/MeSH route the scRNA query actually
     uses): counts `wcmAuthorCwids` **regardless of author position** (`search.ts:1138-1148`) — it
     **already counts middle authors**. So B1's position/`1/√N` change is **moot** for concept queries.

## The real scRNA burial: the resolved descriptor has no corpus

`matchQueryToTaxonomy("single-cell RNA sequencing")` → descriptor **"Single-Cell Gene Expression
Analysis"**, `descendantUis = 1` (no descendants). `getConceptScholarConcentration` returns a
**pool of 0** — measured: even Olivier Elemento (scRNA leader, **538** indexed pubs) has **0** pubs
tagged with that `meshDescriptorUi`. The descriptor is too new/narrow to have WCM corpus, so the
concentration boost **never fires** and the query ranks on base text + prominence only → the
methods-scientists fall to #706/MISS. This is a **taxonomy-coverage** problem (cousin of the
Finding-C lay-term gap), not an authorship problem.

## Data-quality flag (verify)

Christopher Mason (`chm2042`) shows `totalPubs = 0` in the publications index under `wcmAuthorCwids`,
despite 468 pubs in the people index and last-author rows in `publication_topic`. An author-
attribution / index inconsistency that would independently sink him on any concept query — worth a
dedicated check (it may be the dominant cause for him specifically).

## Heterogeneous burial mechanisms (per gold query)

| query | why the specialist is buried | real lever |
|---|---|---|
| single-cell RNA sequencing | resolved descriptor has ~0 corpus → concentration pool empty | taxonomy coverage (broaden descriptor / descendants) + the Mason attribution bug |
| diabetes / alzheimer's | `meshMapped=false` → keyword fallback | curated aliases (#1258, Finding C) |
| obesity (Igel) | clinician with few topical pubs → low n; clinical text inert | clinical-as-function_score (B2) |
| obesity/hypertension (well-covered) | concentration `n²/total` fraction-penalty on high-volume authors | concept-concentration formula (dampen volume penalty) + methods guardrail |

**None of these is the authorship-position restructure B1 proposed.** The plan over-fit to the
`publication_author` authorship data (which is rich and tempting) but the buried gold cases are
held down by taxonomy coverage, a data bug, the clinical-text limitation, and the fraction penalty —
in that rough order of impact for the current gold set.

## Recommendation

Re-scope Track B around the measured mechanisms, prioritized:
1. **Verify/fix the Mason-type author-attribution gap** (`wcmAuthorCwids` missing real authors) — a
   data bug can dwarf any ranking tuning; cheap to check, high impact.
2. **Concept-path concentration: dampen the `n²/total` volume penalty + add the methods guardrail**
   (the one piece of B1 that survives) — but tension with #1343's deliberate specialist-over-generalist
   design; needs gold-set A/B with the boost-OFF control.
3. **B2 clinical-as-function_score** (unchanged; the clinician-expert lever) — still valid.
4. Taxonomy coverage for narrow/new descriptors (overlaps #1258) — separate.

Authorship-position restructure (original B1) and scheme-unification (B3) drop to "nice-to-have"
until a gold case is shown to need them.
