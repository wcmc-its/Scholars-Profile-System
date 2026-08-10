# WCM Sensitive Data Sharing — Bulk Data Rule / S-Index pipeline

Standalone Python pipeline, checked in here for version control only — it is not part of the
Next.js app, does not run in CI or the deploy pipeline, and has no Prisma/Postgres dependency. It
queries **reciterdb** (MariaDB) directly and talks to PubMed/Europe PMC/DataCite. Two projects
share it: the original Bulk Data Rule sensitive-data landscape scan (28 CFR Part 202), and a
newer NIH S-Index / DMS-policy data-sharing extraction — same extraction engine, different filter
and purpose. Full design docs for both live in `~/Dropbox/Projects/Bulk Data Rule/` (private
working area — this repo is public; see `CONTRIBUTING.md`).

## Deliverables

Both projects write their dated report deliverables (`.xlsx`, `.md`) to
`~/Dropbox/Projects/Bulk Data Rule/`, not into this repo — see each script's `PROJ`/`OUT` path.

## Prerequisites

**Environment variables** (already set in `~/.zshrc`; never hardcode):
- `DB_USERNAME`, `DB_PASSWORD`, `DB_HOST`, `DB_NAME` — reciterdb (MariaDB, read-only use).
- `PUBMED_API_KEY` — optional; raises NCBI rate limit to ~10 req/s.

**Python** (3.13+): `pip install -r requirements.txt` (pandas, sqlalchemy, pymysql, openpyxl).
Standard library: `urllib`, `xml.etree`, `concurrent.futures`, `re`, `json`.

## Where the data comes from

- **Corpus + article metadata (DOI, journal, impact factor, citations):** reciterdb tables `analysis_summary_author`, `analysis_summary_article`, `identity`.
- **Deposition locations:** PubMed structured `<DataBankList>` (NCBI E-utilities `efetch`) + full-text Data Availability statements (Europe PMC `fullTextXML`, NCBI `efetch db=pmc` fallback).
- **Funding, abstract, MeSH:** PubMed `efetch` (`GrantList`, `Abstract`, `MeshHeading`).
- **DOI resource typing** (S-Index only): DataCite REST API (`datacite.py`).

Full-text XML is fetched live per run and **not cached** — see Limitations.

## Pipeline (run order)

Run from this directory. `catalog.py`, `taxonomy.py`, and `datacite.py` are imported modules; run them directly only to execute their self-checks.

| # | Script | Reads | Writes |
|---|--------|-------|--------|
| 0 | `size_corpus.py` | reciterdb | (prints corpus counts by year) |
| 1 | `extract_databanks.py` | reciterdb + PubMed efetch | `coverage.csv`, `deposits_databank.csv` |
| 2 | `scan2.py` | `coverage.csv` + Europe PMC/NCBI full text | `deposits_v2.csv`, `status_v2.csv` |
| 3 | `mesh_sensitive.py` | `coverage.csv` + PubMed efetch | `mesh_sensitive.csv` |
| 4 | `build_outputs.py` | steps 1–3 outputs | Landscape `.xlsx` + `report_stats.txt` |
| 5 | `preprint_extend.py` | reciterdb + PubMed/Europe PMC | `preprint_*.csv` |
| 6 | `attribute.py` | steps 2,5 + reciterdb + PubMed efetch | `attributed_deposits.csv` |
| 6b | `coauthor_affil.py` | `attributed_deposits.csv` + PubMed efetch | `coauthor_affil.csv` (country-of-concern coauthor flags) |
| 7 | `build_people.py` | `attributed_deposits.csv` + deposit CSVs + `coauthor_affil.csv` | People & Metadata `.xlsx` |
| — | `datacite.py` | DataCite API, per DOI | (library; not yet wired into `scan2.py` — see S-Index spec, Open questions) |

```bash
cd scripts/bulk-data-rule
python3 catalog.py && python3 taxonomy.py && python3 datacite.py   # self-checks (optional)
python3 extract_databanks.py                  # ~3 min  (25k PMIDs, full BDR scope; see below for S-Index scope)
python3 scan2.py                              # ~5 min  (5k full-text fetches, 8 threads)
python3 mesh_sensitive.py                     # ~3 min
python3 build_outputs.py                      # landscape workbook
python3 preprint_extend.py                    # ~1 min
python3 attribute.py                          # ~2 min
python3 coauthor_affil.py                     # ~2 min  (all-author affiliations, COC flags)
python3 build_people.py                       # people workbook
```

CSV intermediates are written next to the scripts (gitignored — see `.gitignore` in this dir and
the root `.gitignore`'s `*.csv`/`data/` rules); the two `.xlsx` workbooks go to the project root
(dated), outside this repo.

## S-Index scope (department pilot)

`extract_databanks.py`'s corpus query branches on `PILOT_DEPARTMENT`:
- **Unset** (default): original Bulk Data Rule scope — full-time faculty, first/last author only.
  Reproduces the already-shipped landscape report.
- **Set** (`PILOT_DEPARTMENT='Systems and Computational Biomedicine' python3 extract_databanks.py`):
  S-Index scope — one department, all WCM co-authors, any author position. Also applies a registry
  exclusion + deposit-vs-use pass to DataBankList rows before `attribute.py` will count them (see
  spec, Architecture).

## Tuning the scan

- **Corpus:** `publicationTypeCanonical`, `authorPosition`/`fullTimeFaculty`/`PILOT_DEPARTMENT` filters live in the SQL of `extract_databanks.py` and `preprint_extend.py`; `articleYear>=2020` window in `scan2.py` / `mesh_sensitive.py` / `build_outputs.py`.
- **Repositories & risk tiers:** `catalog.py` (36 repos: host country, access model, data-type bucket, tier, accession-prefix patterns).
- **Match signals (accession / URL / name):** `scan2.py` `SIG` dict.
- **Deposit-vs-use language:** `scan2.py` `DEP` / `USE` regexes.
- **Sensitivity categories & sub-types:** `taxonomy.py` (`CAT`, `SUB`).
- **DOI resource typing (S-Index):** `datacite.py` (`INCLUDE`/`EXCLUDE` sets).
- **"Concerning" and "Non-exempt exposure" definitions:** `attribute.py` (`concern`) and `build_people.py` (`nonexempt`).

## Limitations

**PubMed Central coverage**
- Only the **PMC Open Access subset** has machine-readable full text. Of the since-2020 corpus, ~63% are in PMC and ~98% of those returned full text — so **~37% of the corpus (not in PMC) is scanned only via the sparse structured `<DataBankList>`**, undercounting deposition by non-PMC pubs.
- No raw XML is cached → a rerun depends on live Europe PMC / NCBI availability and current content. PMC adds and edits articles over time, so counts drift between runs. **Fix:** cache fetched XML keyed by PMCID.

**Extraction**
- Data Availability statements are found by section-heading heuristics; non-standard headings are missed.
- Prose-only sharing ("available on request", supplementary files, a bare GitHub link) is **not** counted as a repository deposit.
- Accession/name matching is high-precision (word boundaries + DAS-section context + deposit-vs-use filter) but **precision/recall are not yet measured** against a labeled gold set. Country-of-concern hits were hand-verified; the broader deposit set was not.

**MeSH sensitive-area tagging**
- MeSH is assigned only to **indexed** articles — **preprints and very recent papers usually have no MeSH**, so sensitive-area and sub-type tags undercount for them. MeSH reflects study *topic*, an upper bound on sensitive-data generation, not proof of data content.

**Coauthor affiliation (country-of-concern vector)**
- Uses PubMed all-author `<AffiliationInfo>` (~100% coverage) with country-token matching per affiliation string (Taiwan and South-Korea guards to avoid PRC/DPRK false positives). Hand-verified high-precision on this corpus. Some records carry no per-author affiliation; a few older records list only the first author's affiliation.
- A country-of-concern-affiliated coauthor identifies the *population to review* (covered-person-with-access question), **not** a violation — it does not establish that the coauthor accessed the bulk dataset, nor that the collaboration is a non-exempt covered transaction.

**Corpus / funding**
- reciterdb is a **live** database; the corpus grows over time. Date-stamp and snapshot for comparability.
- "US-federal funding" (exemption signal) comes from PubMed `GrantList`; presence is a signal, **not proof** the specific deposit was expressly authorized. US-person fraction of any dataset is not observable.

## Making it audit-grade (next steps)

1. **Snapshot inputs:** persist the reciterdb result set and cache fetched full-text XML per run date → exact reproducibility independent of live APIs.
2. **Version the taxonomy:** changelog on `catalog.py` / `taxonomy.py` so classification changes are traceable.
3. **Validation harness:** hand-label a random sample → report measured precision/recall instead of assumed accuracy.
4. **If an LLM pass is added** (the prose-only tail): `temperature=0`, pinned model version, cache every response, and route LLM output through the deterministic classifier (extract-then-verify) so LLM non-determinism stays out of the final numbers.

## Reproducibility summary

The pipeline is **deterministic** (only `random_state=42` in the validation sample) — same inputs + same scripts → identical output. The soft spots are **input drift** (live DB + live PMC, fixable by snapshotting) and **unmeasured classification accuracy** (fixable with a labeled sample). Judgment lives in the version-controlled `catalog.py` / `taxonomy.py` / `datacite.py` and the `concern` / `nonexempt` definitions — transparent and editable, but not yet benchmarked.
