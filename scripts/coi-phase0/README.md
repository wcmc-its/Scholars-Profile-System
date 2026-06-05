# Track A — Phase 0 offline precision harness

Validates the unmatched-PubMed-COI **candidate pipeline** (segment → attribute → extract →
normalize → diff → tier) against the 2022 reference corpus, **with no infrastructure and no
approvals**. It is the cheapest way to de-risk the core logic before any live-data (Track B) or
Compliance dependency. See `docs/coi-pubmed-phase0-precision-study.md` for the full two-track design
and `docs/coi-pubmed-unmatched-feasibility.md` for the feature context.

## ⚠️ Confidential data

The official Conflicts-Survey export (`coi_03042022_1.xlsx`) is **confidential** (faculty names,
entities, dollar ranges, family-member flags). Every output is written to `OUT_DIR` (default
`/tmp/coi-phase0`), **never inside the repo**. Do not `git add` the output dir. Only the scripts in
this folder (pure code, no data) are committed.

## Run

```bash
scripts/coi-phase0/run.sh                       # uses default REF_DIR + /tmp/coi-phase0
scripts/coi-phase0/run.sh "<REF_DIR>" "<OUT_DIR>"
```

Prerequisites: `python3` with `openpyxl` (xlsx read), and `node` (≥18, dependency-free ESM). Two
steps:

1. `prep.py` — joins the corpus into clean CSVs in `OUT_DIR`, dropping Excel-corrupted cwids and
   restricting to the study population (valid cwid in **both** knowns and the disclosed export).
2. `analyze.mjs` — runs the pipeline and writes `candidates.csv` + `report.md`.

## Inputs (2022 reference corpus)

| File | Role |
|---|---|
| `KnownsPubs2019+FullTimeFaculty.csv` | `personIdentifier,pmid,articleYear` — scholar↔PMID map |
| `PubMedDownload-2021-06-27.tab` | `pmid,conflicts` — PubMed COI statement text |
| `coi_03042022_1.xlsx` | Official Conflicts-Survey export — the disclosed ground truth |

## Outputs (in `OUT_DIR`, confidential)

- `candidates.csv` — one row per surfaced candidate gap = **the human-labeling sheet**. Fill the
  `LABEL` column with one of: `TRUE` / `co-author` / `funder` / `employer` / `entity-variant` /
  `family` / `ended` / `ambiguous`. Each row carries the **verbatim source sentence** so the human
  adjudicates from the same evidence the eventual /edit panel would show.
- `report.md` — population, gap rate vs the capstone (~37%), tier + suppression + heuristic
  failure-mode histograms, sample High-tier candidates.

## Pipeline & the correctness guards (the parts that matter)

- **Negation drop** — pure "no competing interests" boilerplate generates no candidates.
- **Attribution by author-ref position** — initials (`A.P.`, `SMM`) are treated as an author only
  at clause start or immediately before a reporting verb, and must **exactly** match the scholar's
  initials. This is the guard that stops one author's disclosure list bleeding onto another
  (e.g. a bare `SAS` inside "HalioDx SAS" must not read as author "AS").
- **ASCO/ICMJE structured-blob slicing** — for delimiter-free multi-author blobs
  ("Name Category: orgs Name Category: orgs"), only the scholar's own section is sliced out; if the
  section can't be cleanly bounded the **whole blob is suppressed** (a missed gap is cheaper than a
  false one).
- **Noise filters** — co-author names, the scholar's home institution (Cornell/WCM/NYP), and grant
  IDs (`K23 HL140199`) are never entities; grant/research-funding clauses are classed as funder
  (no WRG analog) and suppressed.
- **Recall-biased normalization** — an extracted entity within fuzzy range of any disclosed entity
  is treated as already-disclosed (suppressed). When in doubt, suppress.
- **Tiers** — `High` (scholar-attributed + strong entity, not disclosed → would render),
  `Medium` (soft attribution or weaker entity), `Low` (suppressed: co-author / funder /
  near-disclosed / weak).

## Known v0 limitations (fix in v1 / Track B)

The rule+gazetteer extractor is deliberately simple; precision is decided by **human labels on
`candidates.csv`**, not by this script. Residual noise to clean up in a v1 extractor (or the
span-grounded LLM-assist proposed for Phase 1):

- A few co-author-name leaks survive in **prose** statements that list several co-authors as company
  employees (no dotted initials to catch).
- Institutional **research support** named via a gazetteer company can slip into `personal` (e.g.
  "research support **to WCM** from <Co>").
- Trial / consortium names ("PCORI-funded …") and publisher honoraria are noisy.
- Common-surname faculty risk mis-attribution (no author roster in the 2022 export; Track B adds
  ReCiter's `targetAuthor`).

## Portability

The pipeline functions in `analyze.mjs` (`segment`, `attribute`, `extractEntities`,
`normalizeEntity`, `fuzzy`, structured-blob slicing, `tierOf`) are framework-free on purpose so the
tuned logic ports into the SPS ETL/lib (TypeScript) for Phase 1.
