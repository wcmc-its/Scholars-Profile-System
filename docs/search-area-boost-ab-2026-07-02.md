# Staging A/B: SEARCH_PEOPLE_AREA_BOOST + SEARCH_PEOPLE_CLINICAL_FN (2026-07-02)

Executes the pending eval from `docs/search-relevance-concentration-followups-handoff.md`
(step 1) plus the parked Track-B2 clinical function-score cell from PR #1372.

## Method

- Harness: `scripts/search-eval/eval.sh` (8 gold queries, 51 labeled scholars),
  public staging search API, full-corpus paging, dedup + relevanceScore sort.
- Race-proofing: all cells ran on the SAME image digest `ab535684` (git `78f51ef5`,
  master−1; the missing commit is gzip-only). Cells 2–3 via hand-registered task-def
  revisions (`sps-app-staging:105`/`:106`) with the image digest-pinned so concurrent
  master CD rolls could not clobber mid-cell (one CD roll DID land during the window —
  the pin absorbed it). Cell 1 ran on the live service (td:104) with digest verified
  identical before and after the run.
- Note the original 3rd cell (raw/volume boost) is unreachable on master — #1363
  replaced the code path — and it had already lost to boost-off empirically, so the
  decision reduces to off vs fraction-fixed.

## Cells

| Cell | AREA_BOOST | CLINICAL_FN | task def |
|---|---|---|---|
| ON (staging default) | on | off | :104 |
| OFF (control) | off | off | :105 (pinned) |
| CLIN (bonus) | on | on | :106 (pinned) |

## Results

Overall: | Cell | meanMRR | top20 | found |
|---|---|---|---|
| OFF | 0.249 | 24/51 | 45/51 |
| ON | 0.257 | 23/51 | 45/51 |
| **CLIN** | **0.262** | **25/51** | 45/51 |

Per archetype (MRR / medianRank):

| Archetype | OFF | ON | CLIN |
|---|---|---|---|
| clinician-expert | 0.198 / 15 | 0.237 / 14 | **0.250 / 9** |
| research-pi | **0.206 / 19** | 0.156 / 27 | 0.154 / 27 |
| methods-scientist | 0.116 / 32 | 0.126 / 32 | 0.126 / 32 |

Per query (MRR, medianRank):

| Query | OFF | ON | CLIN |
|---|---|---|---|
| diabetes | 0.026 / 185 | 0.059 / 41 | **0.084 / 17** |
| obesity | 0.218 / 4 | 0.318 / 4 | **0.332 / 4** |
| fecal microbiota transplantation | 0.204 / 7 | 0.249 / 4 | 0.249 / 4 |
| alzheimer's | **0.158 / 16** | 0.072 / 24 | 0.072 / 24 |
| hypertension | **0.199 / 15** | 0.174 / 21 | 0.174 / 21 |
| CRISPR | 0.123 | 0.123 | 0.123 |
| single-cell RNA sequencing | 0.060 | 0.060 | 0.060 |
| pediatric congenital heart surgery | 1.0 / 1 | 1.0 / 1 | 1.0 / 1 |

Key scholars: Devereux #1 on hypertension in ALL cells (no top-1 regression).
Boost-on lifts diabetes clinician-experts dramatically (Tchang #185→#41, Shukla
#21→#7, Aronne #16→#8); clinical-fn stacks further (diabetes median 41→17).
Deep obesity specialists stay deep in every cell (Igel ~#150, Aras ~#260 — the
handoff's hoped-for lift did not materialize). Hypertension/alzheimer's expected
scholars sit 5–8 ranks lower with boost on (Alderman #7→#13, Wachtell #11→#18,
Mosconi #10→#18) — the boost promotes concentration-heavy scholars above the
gold set's high-volume research-PI picks, which is partly the intended reorder;
the gold labels are data-derived and pending domain-expert review (#1372).

## Decisions

1. **SEARCH_PEOPLE_AREA_BOOST: keep staging-on, do NOT flip prod yet.** ON beats
   OFF overall (+0.008 meanMRR) with the targeted clinician-expert lift (+0.04 MRR),
   but the handoff's explicit flip criteria (Igel/Aras usable rank; hypertension
   specialists lifted) are not met, and research-pi ranks pay for the gain. Not a
   kill either — diabetes/obesity/FMT wins are large. Next: tune `AREA_BOOST_W_*`
   weights against the hypertension/alzheimer's regressions, and/or re-review the
   gold research-pi labels before re-judging (#1343 umbrella).
2. **SEARCH_PEOPLE_CLINICAL_FN: flip staging ON** (this PR wires it; strict win —
   no per-query regression vs the staging default, clinician-expert medRank 14→9).
   Prod flip after staging soak; weight lever `SEARCH_PEOPLE_CLINICAL_FN_WEIGHT`
   (default 3) untouched.
3. **#1345 (faculty-prominence) re-eval is unblocked**: its diabetes regression
   signature (Tchang deep-ranked) dissolves once the boost is active — re-run that
   A/B with #1363 in place per handoff step 3.

Raw outputs (cell-on/off/clinfn .txt/.json) in the session scratchpad; queries and
expected sets are `scripts/search-eval/fixtures.json` at `0f300bfb`.

## Post-A/B state restoration

Staging service intentionally LEFT on td:106 (pinned digest + CLINICAL_FN=on = the
winning config this PR codifies). After merge, run
`cdk deploy --exclusively Sps-App-staging -c env=staging` from detached
origin/master to re-register the cdk-shaped task def (image back to `:latest`,
CLINICAL_FN=on from this PR) and restore CD self-heal. Until then the digest pin
means master pushes will NOT roll the staging image.
