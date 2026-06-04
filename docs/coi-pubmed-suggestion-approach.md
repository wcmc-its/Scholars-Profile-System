# COI-from-publications suggestions — how the approach works

**What it is.** A scheduled data source (like ReCiter, InfoEd, RePORTER…) that
surfaces, on a scholar's own `/edit` surface, relationships named in **their own
PubMed competing-interest statements** that we could **not** match against their
current Weill Research Gateway (WRG) disclosures. Each row is a _suggestion to
review_, never a verdict — see `coi-pubmed-unmatched-feasibility.md` for the
governance contract and `coi-pubmed-phase0-trackA-results.md` for the validation
run this document summarizes.

**Where it sits.**

```
PubMed <CoiStatement>  ──(ReCiter → ReciterDB.reporting_conflicts; upstream, WCM-side)
        │  etl:reciter:coi-statements   (nightly, alongside ReCiter — same WCM-DB path)
        ▼
publication_conflict_statement   (per-PMID verbatim COI text)
        │  etl:coi-gap   (nightly, after etl:coi — reads SPS-DB only)
        │     ├─ extract → attribute → diff-vs-disclosed → tier
        ▼
coi_gap_candidate   (the seeded recommendations; self-only on /edit when the flag is on)
```

The two ETL steps run in the nightly cadence (`etl/orchestrate.ts` and the
EtlStack nightly Step Function) exactly like every other source. **Seeding real
data depends on the same WCM-ReciterDB path the ReCiter publication source
needs** (issue #443 + `conflictsImport.py` populating `reporting_conflicts` in
the WCM nightly); the gap computation itself reads only SPS-DB and is not
network-blocked.

---

## The funnel (validation run — 2022 reference corpus, 324 faculty)

| Stage                                                                    | Count           |
| ------------------------------------------------------------------------ | --------------- |
| Faculty evaluated                                                        | 324             |
| Statements carrying COI text                                             | 2,462           |
| → pure negation ("authors declare no competing interests") → dropped     | 697 (28%)       |
| → substantive, run through the pipeline                                  | 1,765           |
| **Suppressed — attributed to a co-author** (the dominant false positive) | **10,686**      |
| Suppressed — fuzzy-matches an already-disclosed entity                   | 4,056           |
| Suppressed — funder / employer clause (no WRG analog)                    | 2,740           |
| **Surfaced: High** (renders on /edit)                                    | **196**         |
| Surfaced: Medium                                                         | 5,445           |
| Faculty with ≥1 surfaced candidate                                       | 207 / 324 (64%) |

The headline: roughly **10,700** of the relationships a naive "company name in a
COI statement" scan would flag are actually a _co-author's_ relationship, not the
scholar's. Suppressing those — not finding company names — is the hard part and
the point of the confidence model.

---

## How one candidate is built — 4 steps

1. **Extract** the candidate entities from the statement (strip boilerplate,
   legal suffixes, grant identifiers).
2. **Attribute** — decide whose relationship it is: the scholar's, or a
   co-author's, or neither (a funder/employer/home-institution clause).
3. **Diff** the scholar's entities against their disclosed WRG set (fuzzy match).
   Only an entity with no disclosed analog survives.
4. **Tier** — `High` when cleanly attributed to the scholar _and_ clearly not
   already disclosed; `Medium` for softer matches above the suppression floor.
   (`Low` is suppressed upstream and never persisted.)

### What surfaces (High) — de-identified examples

| Attribution mechanism                | Statement (scholar name redacted)                                                                                  | Result                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Surname in clause                    | _"Dr. [S] is a consultant to Valeant Pharmaceuticals."_                                                            | `Valeant Pharmaceuticals` → High                                                                                                                                          |
| Exact initials, author-ref position  | _"A.[S].: consulting or advisory role: Bristol Myers Squibb, Regeneron, Seattle Genetics"_                         | each org → High                                                                                                                                                           |
| ASCO/ICMJE structured section header | _"Consulting or Advisory Role: Eisai, Exelixis, Novartis, Janssen Oncology"_ (sliced to the scholar's own section) | each org → High **except** `Janssen Oncology`, whose nearest disclosed entity `Janssen Scientific Affairs, LLC` scored **0.47** → flagged softer (the fuzzy diff at work) |

### What's correctly suppressed — the false-positive avoidance

| Case                                  | Statement (de-identified)                                                                                                                              | Why suppressed                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **Co-author bleed** (the dominant FP) | _"[CoAuthor-initials] has received fees for consultancy from Pfizer, Genentech and HalioDx SAS."_ in a paper where the scholar is a _different_ author | attributed to the co-author, not the scholar                  |
| Funder / grant id                     | _"Dr. [S] is supported by NIH grant K23 HL140199 and a grant from the American Lung Association."_                                                     | grant id never extracted; funder has no WRG disclosure analog |
| Home institution                      | _"[S] has filed a patent in conjunction with Cornell University."_                                                                                     | the scholar's own institution is never a "relationship"       |
| Already-disclosed variant             | entity `Pfizer` when the scholar disclosed `Pfizer Inc`                                                                                                | fuzzy-matches the disclosed set → already covered             |

---

## Quality + limits (read before enabling for scholars)

- This is a **v0 rules extractor.** An automated spot-check of the 196 High-tier
  candidates found **0 bare-junk entities and 1 residual co-author-name leak**;
  the large majority are correctly-attributed real relationships.
- Known residuals (the v1 / span-grounded-LLM scope): a few co-author-name leaks
  in **prose** statements that list multiple co-authors as company employees;
  institutional research-support phrased as a relationship; trial / consortium
  names.
- **The funnel numbers above are a gap _rate_, not a precision number.** A
  measured High-tier precision requires the human-labeling pass over
  `candidates.csv` (the `LABEL` column), ratified with Compliance — this is the
  outstanding quality gate (§C.2 in `coi-pubmed-HANDOFF.md`) and is what a
  threshold for surfacing should be set against.
- The recommendations are recall-biased by design: when attribution is
  uncertain, the pipeline suppresses rather than surfaces.

## Operational notes

- **Cadence:** nightly, in the EtlStack nightly Step Function (`etl:reciter:coi-statements`
  near the ReCiter step; `etl:coi-gap` after the COI step). Incremental via the
  `EtlRun(source="COI-Gap")` watermark; `--full` recomputes all.
- **Visibility:** the seeded `coi_gap_candidate` rows render only on a scholar's
  own `/edit` surface, only when `SELF_EDIT_COI_GAP_HINT=on`, and only for a
  genuine (non-impersonating) self viewer. They are never exposed to curators,
  superusers, the public, the search index, or any compliance feed.
- **Lifecycle:** a scholar's "Not relevant" dismissal is respected durably; the
  nightly job never re-surfaces a dismissed candidate.
- **Reproduce the validation:** `bash scripts/coi-phase0/run.sh` → `/tmp/coi-phase0/`
  (`candidates.csv` + `report.md`; confidential — never committed).
