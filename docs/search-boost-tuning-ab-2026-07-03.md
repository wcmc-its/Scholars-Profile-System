# Staging A/B: area-boost weight tuning + faculty re-eval + phrase-boost (2026-07-03)

Follow-up to `docs/search-area-boost-ab-2026-07-02.md`, running the three levers
that verdict left open: weight tuning (#1343), the unblocked faculty re-eval
(#1345), and the newly-wired phrase boost (#1344). All four cells ran on ONE
pinned image digest `sha256:47389c58…` (git `abf823ac`, master after PR #1470),
via hand-registered task-def revisions `sps-app-staging:108–111`. Digest verified
identical before each eval. Fixtures: 20 gold queries / 102 labeled scholars
(`scripts/search-eval/fixtures.json`, the #1446 expansion).

## Cells

| Cell | area-boost weights | faculty prominence | phrase boost | td |
|---|---|---|---|---|
| C0 baseline (master default) | 3 / 1.5 / 0.75 | off | on | :108 |
| C1 softened weights | **2 / 1 / 0.5** | off | on | :109 |
| C3 faculty on (#1345) | 3 / 1.5 / 0.75 | **on** | on | :110 |
| C4 phrase off (#1344) | 3 / 1.5 / 0.75 | off | **off** | :111 |

(area-boost + clinical-fn on in every cell — the shipped staging defaults.)

## Overall

| Cell | meanMRR | top20 | found |
|---|---|---|---|
| C0 baseline | 0.292 | 71/102 | 92 |
| **C1 softened** | **0.294** | 70 | 92 |
| C3 faculty on | 0.285 | 66 | 92 |
| C4 phrase off | 0.270 | 69 | 92 |

Per-archetype MRR: C0 clin 0.297 / meth 0.220 / pi 0.201; C1 0.288 / 0.227 / **0.216**; C3 0.292 / 0.212 / 0.191; C4 0.276 / 0.201 / 0.217.

## #1343 — weight tuning: soften to 2/1/0.5 (C0→C1)

Softening the tier weights **relieves exactly the regressions the 07-02 verdict flagged**, at a flat headline (0.292→0.294):

| Query | C0 (3/1.5/.75) | C1 (2/1/.5) |
|---|---|---|
| resistant hypertension | 0.178 (med 4) | **0.250 (med 3)** |
| alzheimer's | 0.068 (med 20) | **0.100** |
| hypertension | 0.159 (med 28) | 0.163 (med 25) |
| parkinsons | 0.295 | 0.299 |
| interventional cardiology | 0.411 | 0.418 |

Cost is a redistribution, not free: concentration-heavy queries give some back — diabetes 0.086→0.073, fecal 0.245→0.232, blood disorders 0.246→0.184. Net effect: the softer boost stops over-promoting concentration specialists above high-volume research-PIs (archetype pi MRR 0.201→0.216) — the intended direction. **This is a genuine redistribution, not a Pareto win**, so it is a recommendation to the #1343 owner, not a unilateral default change: soak 2/1/0.5 on staging (env override `SEARCH_AREA_BOOST_W_HI/MID/LO=2/1/0.5`, now supported since #1470), confirm the regression relief holds on the broader gold set, then decide the shipped default. Softer-still was not run — the 07-02 A/B already showed the limit is boost-off, which loses the diabetes/obesity wins.

## #1344 — phrase boost: keep on (C0→C4)

Phrase-boost ON is a **net win (+0.022 meanMRR)**, driven by clinical multi-word specialty queries, which is exactly its target:

| Query | phrase ON (C0) | phrase OFF (C4) |
|---|---|---|
| resistant hypertension | 0.178 (med 4) | 0.053 (med 15) |
| interventional cardiology | 0.411 (med 3) | 0.212 (med 6) |
| pediatric cardiac surgery | 0.500 (med 2) | 0.250 (med 4) |

Movers: Alderman `mia2003` #3→#9, Mann `sjmann` #5→#21 on resistant hypertension without phrase-boost; the match_phrase over publicationTitles/areasOfInterest rescues the multi-word specialist from min_should_match dilution. It mildly HURTS two non-clinical multi-word *concept* queries (computational drug discovery 0.152→0.257, gut bacteria 0.371→0.401) where the phrase match rewards incidental title co-occurrence — but the clinical wins dominate. **Verdict: the staging-on wiring from #1470 is validated; keep it on, prod flip rides the #1344 rollout after soak.**

## #1345 — faculty prominence: keep OFF, regression dissolved (C0→C3)

Turning the flat full-time-faculty prominence term back ON is a **net regression** (0.292→0.285, top20 71→66): it drops methods-scientist (0.220→0.212) and research-pi (0.201→0.191), and worsens CAR 0.228→0.116. Crucially, the diabetes-cluster regression that originally parked #1345 (faculty-OFF was said to cost the all-FT diabetes cluster) **does not reproduce with the #1363 boost active** — diabetes is actually marginally BETTER faculty-off (0.086 vs 0.083, med 14.5 vs 19). The boost now lifts the true specialists the faculty term was compensating for. **Verdict: keep `SEARCH_PEOPLE_FACULTY_PROMINENCE` OFF on staging (current default); the expertise-independent employment term is superseded by #1363. #1345 can resolve as "keep disabled."**

## Actions

- #1344 phrase boost: staging-on wiring validated (this A/B); prod flip → #1344 rollout after soak.
- #1345: recommend resolve/close — keep faculty prominence disabled; regression dissolved. Comment posted.
- #1343: recommend soaking 2/1/0.5 via env override, then owner decides the default. Comment posted with the redistribution tradeoff. HOLD prod (boost still staging-only).
- Staging restored to the clean master cdk task-def (`cdk deploy Sps-App-staging`): weights code-default 3/1.5/0.75, phrase-on, faculty-off, clinical-fn-on, image un-pinned (CD self-heal restored).

Raw outputs (c0/c1/c3/c4 .txt/.json) in the session scratchpad.
