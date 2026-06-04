# Phase 0 — Offline Precision Study for Unmatched-PubMed-COI Detection

> Scopes the no-UI, no-faculty-exposure precision study that gates everything in
> `coi-pubmed-unmatched-feasibility.md`. The study exists to answer one question with a defensible number:
> **on the High-confidence tier, what fraction of surfaced "unmatched conflicts" are genuinely this scholar's
> undisclosed external relationship?** Nothing ships to /edit until this clears its exit gate.

## Why a Phase 0 at all

The feasibility verdict is BUILD-GATED specifically because the dominant failure mode (a co-author's conflict
mis-attributed to our scholar out of a paper-level statement) produces *false accusations*, which are categorically
more costly than a normal product defect. We cannot reason our way to the false-positive rate — it has to be measured
on real WCM data and hand-labeled. The study also yields two durable byproducts: a **labeled gold set** that becomes the
Phase-1 regression fixture, and a **tuned confidence threshold** recommendation for Compliance to ratify.

## Two-track design (Track A runs today; Track B needs the VPC)

### Track A — Validate the pipeline against the 2022 corpus (NOT VPC-blocked)

The 2022 capstone left a complete, joinable historical corpus in
`~/Dropbox/Index/Conflicts of Interest : External Relationships/`:

| File | Role in Track A |
|---|---|
| `KnownsPubs2019+FullTimeFaculty.csv` | `personIdentifier, pmid, articleYear` — the scholar↔PMID map (ReCiter knowns) |
| `PubMedDownload-2021-06-27.tab` / `.txt` | `pmid, conflicts` — the COI statement text per PMID |
| `coi_03042022_1.xlsx` | Official Conflicts-Survey export — `cwid, entity, Activity Type, value, Activity Relates To` (the disclosed ground truth) |
| `SampleCOIdata-jpleonar.xlsx` | Full official-export schema reference |
| `Capstone Paper 4.0.pdf` | The 2022 methodology + headline results (37% undeclared) to sanity-check the pipeline against |

**Track A procedure:** join the three tables on `cwid`/`pmid`, run the candidate pipeline (below), and reproduce the
capstone's aggregate gap rate within tolerance. If our pipeline says ~37% of statements have an undeclared entity, the
extraction+normalization+diff core is behaving; if it says 5% or 80%, the pipeline is broken before we ever touch live
data. Track A is the cheapest possible way to de-risk the core logic and can begin immediately.

**Track A limitation — attribution can only be partially tested here.** The 2022 `conflicts` column is the
*paper-level concatenated* statement with **no author list attached**. So Track A can test:
- entity extraction from the statement text,
- entity normalization vs the disclosed set,
- the diff,
- attribution **by in-clause initials/name matching** (parse "D.X. received…" and match to the scholar's initials).

It **cannot** test attribution that relies on the per-paper author roster + target-author flag — that signal lives in
the live `ReciterDB.analysis_summary_author_list` table (Track B).

### Track B — Fresh faculty sample on live data (VPC-blocked)

Blocked on SPS→WCM ReciterDB reachability (see `project_sps_vpc_wcm_connectivity` — routing currently times out) and on
confirming `conflictsImport.py` is enabled in the WCM prod nightly so `reporting_conflicts` is actually populated.
When unblocked, Track B assembles a *current* sample and exercises the full attribution stack.

**Data assembly (read-only):**
1. SPS → for each sampled `cwid`, its confirmed PMIDs (`publication_author`).
2. `ReciterDB.reporting_conflicts` → `pmid → conflictsVarchar` (read the CAST varchar, not the blob).
3. `ReciterDB.analysis_summary_author_list` → `pmid → [authors]` with `targetAuthor` flag + `authorFirstName/LastName`.
4. SPS `CoiActivity` → `cwid → disclosed entities` (filter `activityRelatesTo='Self'`).

**Sample design:** ~75–100 full-time faculty, stratified so the labeling effort hits the hard cases, not just the easy
ones. Strata: (a) high-publication-count clinicians (most multi-author statements → attribution stress); (b)
basic-science faculty (more ownership/IP disclosures); (c) faculty with ≥1 existing `CoiActivity` row vs none. Target
~300–500 candidate gaps to label — enough for a precision estimate with a usable confidence interval, small enough for
one or two human labelers in a bounded sitting.

## The candidate pipeline under test

Identical logic in both tracks, so Track A's tuning carries into Track B:

1. **Segment** the statement into clauses/sentences; drop pure-negation boilerplate ("No competing interests were
   disclosed.", "The authors have nothing to disclose.") — ~68% of rows are this and must not generate candidates.
2. **Attribute** each remaining clause to the scholar. Score from: in-clause initials/surname match (`deriveInitials`),
   author position, single-author boost, "all authors" / many-author penalty, shared-common-initials penalty. Track B
   adds the `targetAuthor`-confirmed gate.
3. **Extract** entity strings from the scholar's attributed clause — **span-grounded**: keep only verbatim substrings;
   reject anything not literally present. Rules/dictionary first; if an LLM assists, temperature 0 + post-hoc substring
   verification, and **only the public PubMed text leaves the VPC — never the disclosed set**.
4. **Normalize** both the extracted entity and the `CoiActivity` entities (strip `Inc/LLC/Ltd/Pharmaceuticals`,
   trailing `(*)`, parenthetical parents; lowercase; fuzzy match) via `canonicalizeSponsor` + an auditable alias table.
   **Recall-biased:** ambiguous match → treat as already-disclosed (suppress the candidate).
5. **Diff & tier**: entity not matched to any disclosed `Self` entity → candidate. Assign High/Medium/Low from the
   multiplicative confidence `paperMatch × authorAttribution × entityExtraction × normalizationMatch`.

## Human labeling rubric

Each candidate gap is labeled exactly one of:

| Label | Meaning |
|---|---|
| **TRUE Case-1** | Genuinely the scholar's own external relationship, absent from their disclosures |
| FALSE — co-author | The relationship belongs to a co-author, mis-attributed by the pipeline |
| FALSE — funder/employer | Names a grant funder / sponsor / employer-of-record, not a personal relationship (no WRG analog) |
| FALSE — entity-variant | Actually disclosed; a normalization miss (Pfizer Inc vs Pfizer) |
| FALSE — family | Disclosed under a family member, or is a family-member relationship |
| FALSE — ended/below-threshold | Was disclosed-then-ended, or sits below the WRG reporting threshold |
| AMBIGUOUS | Labeler cannot adjudicate from the source sentence alone |

The labeling UI is a spreadsheet: one row per candidate, showing `cwid`, `pmid`, the **verbatim source sentence**, the
extracted entity, the scholar's disclosed-entity list, and the computed tier — so the human adjudicates from the same
evidence the eventual /edit panel would show.

## Metrics & exit gate

- **Primary: High-tier precision** = TRUE / (TRUE + all FALSE) among High-tier candidates, with a 95% Wilson interval
  (reuse the interval helper from the `seo:llm-rank` work).
- **Failure-mode histogram** across the FALSE labels — tells us which mitigation (attribution gate vs funder-clause
  filter vs alias table) buys the most precision.
- **Per-input ablation** — recompute precision with each confidence input disabled to confirm each one earns its place.
- **Recall sanity** (secondary) — on a labeled-positive subset, what fraction did the High tier surface? We deliberately
  trade recall for precision, but we want to know the cost.

**Exit gate (both must hold):**
1. High-tier precision lower-CI-bound clears the threshold **Compliance ratifies** (the doc proposes ≥0.90 as a starting
   point given the false-accusation stakes — but the number is a governance decision, not an engineering one), **and**
2. Faculty Affairs / Compliance / General Counsel have signed off on the concept and the exact /edit copy.

Failing the gate is a successful Phase 0 outcome: it either tells us which mitigation to build before retrying, or that
the precision ceiling is too low for a scholar-facing surface and the idea should stay an internal analysis only.

## Prerequisites & decisions before Track B

1. **VPC reachability** to ReciterDB (currently times out — `project_sps_vpc_wcm_connectivity`).
2. **Confirm `conflictsImport.py` is enabled** in the WCM prod nightly and `reporting_conflicts` is non-empty — run a
   direct row-count probe; do not estimate (known repo footgun: fabricated stats off an empty fetch).
3. **Extraction approach decision** — deterministic dictionary, span-grounded LLM-assist, or hybrid — which fixes the
   LLM-egress governance posture.
4. **Scope confirmation** — exclude `activityRelatesTo≠Self` and below-threshold relationships from the diff.

## Deliverables

- `precision-report.md` — High-tier precision + CI, failure-mode histogram, ablation, threshold recommendation.
- `coi-gap-gold-<date>.csv` — the labeled candidate set, reused as the Phase-1 regression fixture.
- A go/no-go memo to the gate owners (Faculty Affairs / Compliance) with the measured number, not a promise.

## Immediate runnable first step

Track A against the 2022 corpus needs no infra and no approvals — it is the cheapest validation of the core pipeline and
would surface most extraction/normalization bugs before any live-data or Compliance dependency. Recommend building the
Track-A harness (`scripts/coi-phase0/` — corpus join + segment + attribute-by-initials + extract + normalize + diff +
reproduce-capstone-rate check) as the next concrete unit of work, pending your go-ahead.
