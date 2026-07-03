# Inferring WCM core usage — head-to-head pilot (Biomedical Imaging core)

**Question:** Is it viable to infer which WCM core facilities a publication used, by (a) LLM scoring of title/abstract and/or (b) pattern recognition on full-text "shout-outs" (acknowledgements)?

**Method:** Used the existing human-labeled pilot (`Imaging Core Testing - 2024-02-28.xlsx`) as ground truth — 237 WCM papers each marked yes/no for whether the **Biomedical Imaging core** was used (137 yes / 100 no). Re-ran two signals on the *same* ground truth and compared:

1. **LLM signal** — re-scored all 237 papers 1–10 from title+abstract with the original Biomedical Imaging prompt (Claude Opus 4.8, 12 parallel scorers). The original 2024 spreadsheet had only 39 papers scored (by ChatGPT).
2. **Deterministic signal** — fetched PMC full text (211/237 = 89% available), matched WCM imaging-core name aliases ("Citigroup Biomedical Imaging Center / Core", "CBIC", "Biomedical Imaging Core") in acknowledgements/affiliations, and harvested co-occurring grant IDs.

---

## Results

| Signal | Population | Precision | Recall | AUC | Notes |
|---|---|---|---|---|---|
| **Acknowledgement name-match** | full-text subset (where it can fire) | **100%** (133/133) | **97%** (133/137) | — | 0 false positives among 100 negatives |
| **LLM (title+abstract), Opus 4.8** | all 237 | 91% @ T≥3 | 89% @ T≥3 | **0.938** | far better than the 2024 ChatGPT pilot |
| LLM — original 2024 ChatGPT pilot | 39 scored | ~62% | ~76% | 0.719 | what the spreadsheet actually contained |
| Grant-ID match | full-text subset | — | — | — | **does not work** (see below) |

**Two headline findings:**

1. **The acknowledgement match is essentially perfect on this set — but that's partly circular.** Every "no" paper was correctly rejected (100% precision) and 97% of "yes" papers verbatim name the core. *However*, the original `yes` labels were almost certainly created by exactly this PMC search (the project write-up describes "PMC search for 'Citigroup Biomedical Imaging Core'" as the method, and all 137 yes-papers happen to be in PMC with full text — a 0% blind-spot rate that's implausible unless the label set was sourced from PMC). So this result proves the signal is **cleanly machine-extractable and can automate the current manual method**, not that it independently *discovers* usage. Still the strongest, cheapest, most explainable signal available.

2. **The LLM is dramatically more viable than the 2024 pilot suggested — this is the genuinely new result.** The LLM never saw acknowledgements, yet predicts the label at **AUC 0.94** vs. the 0.72 the old 39-row ChatGPT sample implied. Driver: a current strong model + abstracts (not titles alone). This is non-circular signal from semantic content.

**Grant-number matching is a dead end for this core.** The grant IDs co-occurring with core mentions are the papers' own research grants (R01 DA…, W81XWH…, etc.) — diverse and paper-specific. There is no single shared S10/core grant the imaging core stamps on its users' papers. Drop grant-ID matching here (may still work for a core funded by one dedicated instrument grant — test per core).

### The catch the AUC hides: base rates

The pilot is **enriched** (58% prevalence). In the real corpus any one core is used by ~1–5% of papers. Re-projecting the LLM's measured sensitivity/specificity to realistic prevalence:

| LLM threshold | sensitivity | specificity | **precision @ 2% prevalence** | precision @ 5% | precision @ 58% (this set) |
|---|---|---|---|---|---|
| T≥3 | 89% | 88% | **13%** | 28% | 91% |
| T≥6 | 80% | 95% | **25%** | 46% | 96% |
| T≥8 | 70% | 95% | **22%** | 42% | 95% |

At a realistic 2% base rate a curator reviewing LLM hits would wade through **4–8 false positives per true hit**. So abstract-only LLM scoring **cannot be an autonomous classifier across the full corpus** — it must feed a ranked human-review queue, not auto-apply labels.

Also note the 0.94 is itself optimistic: the negatives in this set are "easy" (clearly non-imaging papers), not the hard case (an MRI paper that used a *different* scanner). Real-world discrimination will be lower.

---

---

## UPDATE — non-circular validation on a random WCM sample (the decisive test)

To remove the circularity, I pulled a **random, un-enriched** sample of 400 WCM-affiliated papers (2021–2023; 18,600 in the frame), fetched full text for the 267 with PMC, used the objective acknowledgement match as truth, and LLM-scored abstracts. This measures both signals at the *real* base rate.

| Measurement on random WCM papers | Result |
|---|---|
| Papers naming the Imaging core ("Citigroup/CBIC/Biomedical Imaging Core") | **0 / 267 (0%)** |
| Papers using advanced-imaging methodology language (MRI/PET/MRS/SPECT/…) | 84 / 267 (31%) |
| …of those, how many named the core | **0** |
| LLM flags for review @ score≥4 / ≥6 | 14% / 8% of corpus |
| LLM≥4 among clearly non-imaging papers (false-positive rate) | 4% |

**This overturns the rosy read of the pilot:**

1. **The 97% acknowledgement recall was an artifact of circular labeling.** In the wild, acknowledgement recall is **near-zero** — 84 papers use imaging methods, *none* name the core. The deterministic match stays high-*precision* (a named core is real) but has **catastrophically low recall**: it confirms a tiny sliver and misses essentially everyone else.
2. **The 58% base rate was wildly unrepresentative.** True acknowledgement-confirmable usage is well under 1% of random WCM papers.
3. **Text alone cannot establish core usage at scale.** Acknowledgement = precise but near-blind; LLM = identifies *imaging-topic* papers but cannot tell a WCM-core MRI from an outside-scanner MRI (no ground truth could adjudicate — 0 acknowledgements to check against). The LLM is appropriately conservative (only 4% false positives on clear negatives; it catches ~30–40% of full-text imaging papers, correctly skipping incidental/clinical imaging).

**Consequence for the design:** the non-text ground-truth sources are **essential, not optional**. Service-owner CWID customer lists and core-staff co-authorship are the only scalable way to reach the silent majority who never acknowledge. The LLM's validated job shrinks to **triage** — narrowing a per-core review queue from the whole corpus to ~8–14% candidate papers (good specificity) — feeding the human-claim role. It is not an auto-labeler, and the acknowledgement match is a confirmer, not a discoverer.

*Caveat:* the affiliation frame includes multi-site trials where WCM is a minor contributor, which dilutes the base rate somewhat; a sample drawn from the ReCiterDB faculty corpus would be modestly higher. But the recall correction holds regardless — among the 84 imaging-methodology papers, zero named the core.

---

## Verdict: viable as triage + claim, NOT as a text-only auto-labeler

Yes — but as a **multi-signal triage + human-claim system**, with text as a minor contributor. The validation reorders the signals:

1. **Service-owner CWID customer lists + core-staff co-authorship = the primary recall engine.** Because acknowledgement recall is near-zero in the wild, these non-text sources are the only scalable way to reach the silent majority of real users. Both are deterministic CWID/author-list matches. This is now the *first* thing to build, not an afterthought.
2. **Acknowledgement / alias name-match = a high-precision confirmer, not a discoverer.** When a paper names the core it's a true hit (~100% precision) and auto-confirmable — but it fires on <1% of papers, so it validates a sliver and finds almost no one new. Cheap to run; don't expect coverage from it.
3. **LLM = a triage filter to populate the per-core claim queue.** It narrows the corpus to ~8–14% candidate papers per core with good specificity (4% FP on clear negatives), so a core owner reviews a short list instead of the whole corpus. It cannot confirm WCM-core-vs-external usage and must never auto-label.
4. **Human-claim role does real work.** Given (1)–(3) only surface candidates, the new core-owner "claim" affordance is the actual source of truth, not a rubber stamp.

**The real IP is still the per-core dictionary** — but expanded: canonical/historical/acronym names (for the confirmer) **plus core-staff CWIDs and the service-owner customer roster** (for the recall engine).

### Status of validation
**Done** (see the "non-circular validation" section above). The remaining unknown is the *true precision* of the LLM/imaging-topic signal — i.e., of the imaging papers it flags, how many actually used CBIC vs an external scanner. Only a service-owner customer list or curator review can settle that, since acknowledgements don't.

---

## Architecture placement (recommendation)

- **Engine → ReciterAI.** It already runs exactly this shape of work: Python + Bedrock, batch publication scoring, faculty rollups, publishing to S3 + DynamoDB for SPS to consume. The acknowledgement matcher + LLM scorer + alias dictionary is one more batch pipeline in that pattern. (SPS *does* have an `etl/` dir, but the heavy Bedrock/LLM scoring belongs with the other ReciterAI scoring jobs.)
- **UI / "claim by a new core role" → Scholars-Profile-System.** Per-publication core-likelihoods and the curator/core-owner claim affordance live in SPS, consuming the engine's S3/DynamoDB output.
- **Open reconciliation:** the original write-up put the "assert which services supported a publication" UI in **ReCiter Publication Manager**. Decide whether the claim UI lives in PM (curation/admin) or SPS (profiles) — or both surfaces against one shared store — before building.

---

## Artifacts (in `Projects/Inferring Cores and Services/analysis/`)
- `labeled_set.csv` — 237 PMIDs + human labels + original ChatGPT scores
- `llm_scores.json` — fresh Opus 4.8 1–10 scores for all 237
- `deterministic_results.json` — per-paper alias hits + matched snippets + grant IDs
- `merged_results.csv` — everything joined, one row per paper (the table to eyeball)
- `pubmed_data.json` — abstracts, grant IDs, MeSH, PMC IDs
- `fulltext/` — cached PMC full-text XML (211 papers)
- scripts: `fetch_fulltext.py`, `match_deterministic.py`, `save_llm_scores.py`
- `validation/` — the random un-enriched WCM sample: `sample_pmids.json`, `sample_data.json`, `llm_scores.json`, `fulltext/`, `validation_merged.csv`, `fetch_all.py`, `analyze.py`
