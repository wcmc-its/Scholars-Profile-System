# People-tab Relevance — PR-1 Baseline

**Status: FROZEN 2026-05-27.** Eval-owner sign-off: paulalbert1 (issue author,
acting as eval owner — #362's "Owner: TBD" was never separately assigned). The
*mechanical half* — the SPEC §11 audit and the candidate §3.1 labeled set — was
landed by [#365](https://github.com/wcmc-its/Scholars-Profile-System/pull/365).
This revision completes the *judgment half*: the §6 labeled set is validated and
**frozen** (§6), and the §4 Recall@3 baseline is **captured and signed off**
under `legacy` ranking (§7) against a freshly rebuilt index (§2). The audit was
re-confirmed against a stable corpus (§2).

**Gate lifted:** PR-2 ([#309](https://github.com/wcmc-its/Scholars-Profile-System/issues/309),
name-shape template) may begin — §7 below is its 0.95 name-shape acceptance and
rollback target. §6 is frozen and revisable only at a major-version flip.

**Forward input:** §5.4 records a v3 prominence-ranking recommendation
(publication-count-led, with full-time-faculty and active-grant boosts) surfaced
while capturing this baseline. It is a recommendation for the v3 ladder, not a
change to the legacy baseline.

| Source | Reference |
| --- | --- |
| SPEC | `.planning/drafts/SPEC-people-relevance-sort-Rev.md` (draft 4) — §3, §4, §5, §11, §12 |
| PR-1 plan | `.planning/drafts/PLAN-issue-308-people-relevance-pr1.md` — §Eval track |
| PR-1 code | merged to `master` as #363 (`feat/308-people-query-shape-classifier`, 2026-05-18) |

---

## 1. What is and is not captured here

| Deliverable | Status |
| --- | --- |
| §11 audit (a)–(i) — corpus-coverage queries | ✅ Run — §4 below |
| §11 audit (e) — MeSH coverage by MEDLINE-indexed journal | ⛔ N/A — no `journal` table / MEDLINE flag in this schema (§4e) |
| §11 audit (k)/(m)/(n) — query-side audits | ⏸ Deferred — require a People-tab query log that does not yet exist (§8) |
| §5.1 coverage map + §5.3 calibration implications | ✅ §5 below |
| Legacy ranking configuration (boost ladder, msm) | ✅ §3 below — verified against `lib/search.ts` |
| §3.1 12-query labeled set | ✅ **Frozen 2026-05-27** — §6 below; judgment calls resolved |
| §4 Recall@3 baseline under `legacy` mode | ✅ **Captured + frozen 2026-05-27** — §7 below (overall 0.16) |
| Prominence signal (v3 ranking recommendation) | ✅ §5.4 below — pub-led + faculty/grant boosts; not a baseline change |

The query-log dependency is **not** treated as a blocker (per maintainer
direction): audits (k)/(m)/(n) and the traffic-grounded validation of the
labeled set are scheduled as a revisit once PR-1 telemetry accrues (~2 weeks
post-#363) — see §8. They do not gate #309.

---

## 2. Data snapshot & provenance

**Audited database — the host dev MySQL.** Local `:3306` is served by the host
`mariadbd` (MariaDB 12.1), schema `scholars`. A docker container
`scholars-mysql` (mysql:8.0) also holds a `scholars` schema but its 3306 is
**unpublished** (unreachable from the host) and its data is stale (pre-#350
`publication_topic` counts, missing `mesh_descriptor` / `department`). **The
host DB is the audit target; the docker instance is the orphan #362 warns
about.** Any re-run must confirm the same — verify schema against
`prisma/schema.prisma` first.

**Snapshot date:** 2026-05-18. Row counts (exact):

| Table | Rows |
| --- | --- |
| `scholar` (all) | 10,815 |
| `scholar` (active: `deleted_at IS NULL AND status='active'`) | 8,937 |
| `publication` | 178,406 |
| `publication_topic` | 77,131 |
| `publication_author` | 250,311 |
| `topic_assignment` | 12,992 |
| `topic` | 67 |

> **Re-verified 2026-05-27 (freeze).** The corpus is stable versus the 05-18
> snapshot: every count above is unchanged except `topic_assignment`
> (12,992 → 13,030, +38). The §4 audit therefore stands without a re-run. The
> `scholars-people` index was rebuilt from the host DB immediately before the §7
> measurement (`npm run search:index:people` → 8,937 docs, alias-swapped to
> `scholars-people-v1`, smoke checks passed), so §7 reflects current data under
> the legacy ranking.

**ETL freshness** (last successful run per source) — establishes how current
each signal is:

| Source | Last success |
| --- | --- |
| ReCiterAI-projection | 2026-05-16 |
| Spotlight | 2026-05-16 |
| Hierarchy | 2026-05-16 |
| MeSH | 2026-05-15 |
| MeshCoverage | 2026-05-14 |
| MeshAnchor | 2026-05-14 |
| ED (scholar/appointment) | 2026-05-13 |
| ReCiter (publications) | 2026-05-12 |
| InfoEd | 2026-05-08 |

> `mesh_descriptor.local_pub_coverage` is currently all-NULL: the MeSH ETL
> full-replaced the descriptor table on 05-15, after MeshCoverage last ran
> (05-14), so coverage is awaiting recompute. Not used by this audit.

---

## 3. Legacy ranking configuration (frozen reference)

Captured per SPEC §4. The §6 baseline is measured with
`SEARCH_PEOPLE_RELEVANCE_MODE=legacy` (the PR-1 default).

**People-tab boost ladder** — `lib/search.ts`, verified at this snapshot:

| Field | Boost | Constant |
| --- | --- | --- |
| `preferredName` | 10 | `PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS` |
| `fullName` | 10 | " |
| `areasOfInterest` | 6 | " |
| `primaryTitle` | 4 | " |
| `primaryDepartment` | 3 | " |
| `overview` | 2 | " |
| `publicationTitles` | 1 | " |
| `publicationMesh` | 0.5 | " |
| `publicationAbstracts` | 0.3 | `PEOPLE_ABSTRACTS_BOOST` (separate scoring-only `should` clause) |

- **`minimum_should_match`:** `PEOPLE_RESTRUCTURED_MSM = "2<-34%"` (`lib/search.ts:447`).
- **CWID short-circuit:** `term { cwid: <lowercased>, boost: 100 }`, appended unconditionally (`lib/api/search.ts`).
- **Authorship weighting at index time:** 10 / 4 / 1 for first-or-last / second-or-penultimate / middle (per SPEC §4, `docs/search.md`; not re-verified in this pass).
- **MeSH minimum-evidence threshold:** a MeSH term reaches the people index only with ≥2 pubs OR ≥1 first/last-authored pub (per SPEC §4; not re-verified).
- **Sparse-profile filter:** off by default (issue #152).
- **Topic pre-filter (D-10):** Prisma-resolved CWID set; composes with the query, unchanged by PR-1.

---

## 4. §11 audit results

Run 2026-05-18 against the host `scholars` DB. The audit SQL — reconciled to the
live schema — is in Appendix A. Reconciliations from the SPEC's assumed column
names (the SPEC explicitly directs "verify schema … before running"):

- **`areas_of_interest` is not a `scholar` column.** `areasOfInterest` is an
  OpenSearch index field built by `etl/search-index/index.ts:402` as
  `s.topicAssignments.map(t => t.topic).join(" ")`. SPEC §6.1.5 itself defines
  non-trivial AOI as "≥3 topic-assignment terms," so §11(a)/(b) AOI coverage is
  computed from `topic_assignment` row counts per scholar.
- **No `person_type` column** — `role_category` is the only appointment-type
  field; §11(b)/(g) group on it. It is 100% populated.
- **§11(e) is N/A** — see §1.

### a) Scholar-field coverage — active scholars (n = 8,937)

| Signal | Count | % of active |
| --- | --- | --- |
| `overview` present | 557 | 6.2% |
| `overview` non-trivial (`LENGTH > 200`) | 535 | 6.0% |
| `primaryTitle` present | 8,937 | 100% |
| `primaryDepartment` present | 8,926 | 99.9% |
| `areasOfInterest` ≥1 topic term | 1,550 | 17.3% |
| `areasOfInterest` ≥3 topic terms (non-trivial) | 1,511 | 16.9% |
| `roleCategory` present | 8,937 | 100% |

### b) Coverage by role category — selection-bias check

| `role_category` | n | % overview>200 | % AOI≥3 | % title | % dept |
| --- | --- | --- | --- | --- | --- |
| affiliated_faculty | 5,408 | 3.3% | ~0% | 100% | 99.9% |
| full_time_faculty | 2,416 | **14.5%** | **62.5%** | 100% | 100% |
| non_faculty_academic | 489 | 1.0% | ~0% | 100% | 99.8% |
| postdoc | 464 | 0% | ~0% | 100% | 99.6% |
| fellow | 155 | 0.6% | ~0% | 100% | 97.4% |
| instructor | 5 | 0% | ~0% | 100% | 100% |

**Selection bias confirmed and severe.** `overview` non-trivial coverage is
14.5% for full_time_faculty vs 3.3% for affiliated_faculty — a **4.4× ratio**,
past SPEC §5.3's 2× caveat trigger. `areasOfInterest` is more extreme still:
≥3 terms exist for 62.5% of full_time_faculty and essentially 0% of every other
role — all 1,511 non-trivial-AOI scholars are full-time faculty.

### Publication-count distribution — active scholars

| Pub count | Scholars | % |
| --- | --- | --- |
| 0 | 3,495 | 39.1% |
| 1–4 | 1,369 | 15.3% |
| 5–19 | 1,709 | 19.1% |
| 20–49 | 1,035 | 11.6% |
| 50+ | 1,329 | 14.9% |

39% of active scholars have no indexed publication; 45.6% (4,073) have ≥5.

### c) Abstract coverage by publication type (n = 178,406)

| Publication type | n | % with abstract |
| --- | --- | --- |
| Academic Article | 125,168 | 94.5% |
| Review | 24,066 | 91.8% |
| Case Report | 10,777 | 76.6% |
| Letter | 5,780 | 15.3% |
| Editorial Article | 5,064 | 18.8% |
| Comment | 2,383 | 30.0% |
| Guideline | 1,853 | 73.9% |
| Preprint | 1,497 | 100% |
| Erratum | 1,053 | 46.2% |
| Conference Paper | 406 | 59.9% |
| Article | 261 | 24.1% |
| Retraction | 98 | 66.3% |

Research-type articles ≈ 92–100%; editorials/letters/comments are sparse — as
SPEC §5.1 anticipates. A corpus skewed to non-research types under-weights its
author on any abstract-derived signal.

### d) MeSH coverage by recency

| Years old | Pubs | % with MeSH |
| --- | --- | --- |
| 0 | 2,164 | 39.3% |
| 1 | 7,081 | 59.3% |
| 2 | 7,403 | 71.1% |
| 3 | 7,650 | 74.8% |
| 4 | 8,035 | 79.1% |
| 5 | 8,892 | 79.1% |
| 6 | 9,029 | 83.0% |
| 7–9 | ~22k | 84.7–85.8% |
| 10–13 | ~27k | 87.1–92.2% |

Confirms NLM indexing lag: recent papers (0–2 yrs) carry MeSH 39–71% of the
time, climbing toward a ~92% ceiling — the residual ~8% being the permanent
non-MEDLINE gap (preprints, some proceedings).

### f) Topic-attribution coverage — publication level

6,081 of 178,406 publications carry a `publication_topic` row — **3.4%**. By
type: Academic Article 4.7%, Review 0.6%, every other type ≈ 0%. Topic
attribution exists almost exclusively on research articles.

### g) Topic-attribution coverage — scholar level (headline)

| `role_category` | Active | With ≥1 attributed pub | % |
| --- | --- | --- | --- |
| full_time_faculty | 2,416 | 1,552 | **64.2%** |
| affiliated_faculty | 5,408 | 0 | 0% |
| non_faculty_academic | 489 | 0 | 0% |
| postdoc | 464 | 0 | 0% |
| fellow | 155 | 0 | 0% |
| instructor | 5 | 0 | 0% |
| **All active** | **8,937** | **1,552** | **17.4%** |

Only 17.4% of active scholars have any topic-attributed publication, and 100%
of them are full-time faculty. **The non-attributed cohort is 82.6%** — SPEC
§6.3's Phase-2B trigger (a) ("non-attributed cohort > 30% of active scholars")
is decisively met. See §5.

### h) Authorship-position distribution — scholars with ≥5 pubs

| Pub bucket | Scholars | Avg frac first | Avg frac last | Avg frac middle |
| --- | --- | --- | --- | --- |
| 5–19 pubs | 1,709 | 0.298 | 0.101 | 0.621 |
| ≥20 pubs | 2,364 | 0.209 | 0.224 | 0.596 |

### i) Authorship-position distribution — full corpus

250,311 WCM authorship rows: 18.7% first, 26.2% last, 17.7% penultimate, 58.5%
middle. (First + last sum >100% because ~3.4% of rows are sole-author papers,
counted as both.) ~58% of WCM authorships are middle-author — the cohort the
deferred §6.2 authorship-asymmetry refinement would target.

---

## 5. §5.1 coverage map — calibration implications for §6

The audit confirms SPEC §5's load-bearing claim — every ranking signal has
*categorical*, not random, coverage gaps — and quantifies them more sharply
than the `docs/search.md` estimates the SPEC was seeded from.

| Signal | SPEC/`docs/search.md` assumed | **Audited (active scholars)** | §5.3 rule outcome |
| --- | --- | --- | --- |
| `areasOfInterest` (≥3 terms) | ~50% populated | **16.9%** | < 25% → §5.3 says **drop from the boost ladder** |
| `overview` (non-trivial) | ~30–50% populated | **6.0%** | < 25% → §5.3 says **drop from the boost ladder** |
| `publicationMesh` / titles | ~100% of scholars w/ ≥1 pub | ~61% of active have ≥1 pub | primary topical signal |
| Topic attribution (scholar) | "conditional" | **17.4%**, all full-time faculty | §6.3 Phase-2B trigger (a) met |

**Three findings the eval owner and PR-3 must reconcile against SPEC §6:**

1. **`areasOfInterest` and `overview` both fall below §5.3's 25% "drop" line.**
   SPEC §6.1.3's v3 ladder still assigns `areasOfInterest^3` and `overview^2`.
   Per the §5.3 first-pass rule the audit just triggered, PR-3 should either
   drop both from the topic-shape ladder or document why §5.3 is overridden.
   This is a recommendation for PR-3 calibration, **not** a change made here.

2. **The `areasOfInterest` selection bias is real but the SPEC mis-attributes
   its mechanism.** SPEC §1 Problem #1 and §5.1 frame AOI as a *self-reported*
   "profile maintenance" string. It is not: `areasOfInterest` is built entirely
   from ReCiterAI `topic_assignment` rows (`etl/search-index/index.ts:402`) —
   algorithm-derived, not user-maintained. The bias is that topic assignments
   are produced only for full-time faculty with research-article publications
   (audit b/g), not that "profile maintainers aren't a random sample." The §6
   remedy (down-weight AOI) is unaffected; the §1/§5.1 wording is a factual
   correction (§9).

3. **Phase-2B trigger (a) is already met.** 82.6% of active scholars are
   topic-non-attributed. SPEC §6.3 promotes Phase 2A → Phase 2B when the
   non-attributed cohort exceeds 30% **and** post-flip telemetry shows that
   cohort's hits landing below position 10. The first condition holds now; the
   second needs post-flip `top3PersonTypes` data. Flag for the PR-5 retro.

### 5.4 Prominence signal — v3 ranking recommendation

The §7 legacy baseline carries **no prominence signal**: within a result set,
scholars are ordered by text relevance alone, so prominent scholars sink in
large sets (topic/dept Recall@3 = 0.00) and same-surname ties resolve
arbitrarily (#4 `wong` = 0/3). The remedy is a prominence factor in the v3
ladder. This section records what that factor should be, with the evidence
gathered while freezing this baseline. **It is a recommendation for the v3
ladder (SPEC §6, PR-2/PR-3, `SEARCH_PEOPLE_RELEVANCE_MODE=v3`); it does not
change the legacy baseline above.**

**Candidate-signal coverage (all 8,937 active people, search-independent — it is
the fraction of the corpus a score on that field can re-order at all):**

| Signal field | Coverage | As a ranker |
| --- | --- | --- |
| `publicationCount ≥ 1` | **60.9%** | Dense enough to lead. |
| `grantCount ≥ 1` | 16.1% | Too sparse to lead; fine as a minor boost. |
| `hasActiveGrants` | 12.5% | " |
| `activePiGrantCount ≥ 1` | 7.0% | Sparsest; minor boost only. |

**Experiment — #4 `wong` re-ranked by `function_score` over the rebuilt index**
(the cleanest case: pure name disambiguation, no topic template). Labeled top-3 =
the three highest-output Wongs (stephen 254 / shing 201 / richard 186 pubs):

| Variant | Recall@3 | Top-3 |
| --- | --- | --- |
| Legacy (control, no prominence) | 0/3 | krystie / ada / christopher (0–3 pubs) |
| `× log1p(grantCount)` | 1/3 | only shing surfaces; degenerate (zeroes the 84% with no grant) |
| `× log1p(activePiGrantCount)` | 0/3 | all zeroed — no prominent Wong holds an active PI grant |
| **`× log1p(publicationCount)`** | **3/3** | **stephen / shing / richard** |

Publication count alone lifts #4 from 0/3 to 3/3; grants cannot, because the
scholars who *should* rank carry many publications but few or zero grants.

**Recommended v3 prominence factor (eval-owner decision, 2026-05-27):**

1. **Publication count leads** — log-saturated (`log1p`, so 250 vs 500 pubs does
   not run away), applied as a multiplicative or strong additive prominence
   factor over the text score.
2. **Full-time-faculty — a *meaningful additive* boost**, not an absolute first
   tier. The owner's intent is that faculty surface higher; an absolute
   "faculty-first" rule is explicitly **rejected** because it breaks #4 — the
   labeled Wongs are *affiliated* faculty with 186–254 pubs, and a hard
   faculty-first tier would rank full-time Wongs with ≤17 pubs above them. The
   boost must be unable to override a large publication-count gap.
3. **Active grants — a *small additive* boost** (`hasActiveGrants` /
   `activePiGrantCount`) as a "currently funded" tiebreaker, never a standalone
   multiplier.

**Selection bias:** publication, grant, and faculty signals are all
full-time-faculty-skewed (§4b, §5). The eval owner has **accepted** this
amplification as desirable (prominent/established scholars *should* rank higher);
§5.3's down-weight caution is therefore overridden by product decision for the
prominence factor. Weights must still be calibrated against the §7 frozen
baseline and the per-shape lift measured before any v3 flip — the full 12-query
prominence sweep (which needs the production topic-template query in hand) is
deferred to the v3 PR.

---

## 6. §3.1 labeled set — FROZEN 2026-05-27 (12 queries)

Per SPEC §3.1: 12 queries (4 name / 4 topic / 2 department / 2 hybrid), each
with 1–3 scholar slugs that should appear in the top 3, and a one-line
rationale. **Frozen 2026-05-27** — the open judgment calls below were resolved
by the eval owner; revisable only at a major-version flip. All 22 distinct slugs
were re-verified 2026-05-27 as real, active scholars. Subjects were chosen from
corpus data (surname frequency, pub counts, `publication_topic` attribution
depth, department headcount), not query traffic — traffic-grounded
representativeness (audit n) is a later revisit (§8).

"Expected shape" is the §6.1.1 / PLAN-D1 classifier outcome; rows marked † carry
a data dependency noted below the table.

| # | Sub-type | Query | Expected shape | Labeled top-3 slugs | Rationale |
| --- | --- | --- | --- | --- | --- |
| 1 | name — lastname only | `iadecola` | name | `costantino-iadecola` | Distinctive surname, exactly one active scholar; known-item retrieval must rank him #1. |
| 2 | name — full name | `richard devereux` | name | `richard-b-devereux` | Forward-order given+surname; unique surname; phrase match must win. |
| 3 | name — partial full name | `harold varmus` | name | `harold-e-varmus` | Indexed as "Harold E. Varmus"; query drops the middle initial — exercises `match_phrase` slop. |
| 4 | name — ambiguous surname, fan-out | `wong` | name | `stephen-t-c-wong`, `shing-chiu-wong`, `richard-j-wong` | 18 active WCM scholars surnamed Wong (SPEC §1 Problem #2 example). Recall@3 = the 3 highest-output Wongs occupy top-3, with no non-Wong scholars surfacing via publication-content fan-out. |
| 5 | topic — MeSH single-term | `melanoma` | topic | `jedd-d-wolchok`, `taha-merghoub` | Resolves to `melanoma_skin_cancer`; Wolchok is the top-attributed scholar and a leading melanoma immunotherapist. |
| 6 | topic — MeSH multi-term | `breast cancer` | topic | `rulla-tamimi`, `massimo-cristofanilli`, `lisa-newman` | Resolves to `breast_cancer`; the three top-attributed scholars span epidemiology, medical oncology, surgical oncology. |
| 7 | topic — non-MeSH technical † | `spatial transcriptomics` | unclassified → topic | `olivier-elemento`, `christopher-e-mason` | Technical phrase with no MeSH descriptor; classifier falls back to the topic template. Top `single_cell_spatial_biology` scholars. |
| 8 | topic — broad domain | `immunology` | topic | `jedd-d-wolchok`, `sallie-permar` | Broad single-token domain. **Owner judgment call:** raw `immunology_inflammation` attribution ranks Elemento #1 by row count, but Wolchok (immuno-oncology) and Permar (viral immunology) are the domain-defensible answers — raw attribution-count ≠ domain expectation here. |
| 9 | department — short | `pediatrics` | department | `james-b-bussel`, `nai-kong-cheung`, `richard-j-oreilly` | Single-token department name; the three highest-output Pediatrics scholars. |
| 10 | department — multi-token | `population health sciences` | department | `rulla-tamimi`, `philip-goodney`, `bjorn-redfors` | Three-token department name; the three highest-output Population Health Sciences scholars. |
| 11 | hybrid — surname + topic † | `iadecola stroke` | hybrid | `costantino-iadecola` | Surname + MeSH-resolvable topic token. Iadecola is a cerebrovascular researcher (top topic `neuroscience_neurology`); hybrid template must rank him #1 regardless of stroke-attribution depth. |
| 12 | hybrid — department + topic | `medicine cardiology` | hybrid | `monika-m-safford`, `parag-goyal`, `jonathan-w-weinsaft` | Department term ("Medicine") + leftover topic token; the three top cardiovascular-attributed scholars in the Medicine department. |

**Data dependencies (†):**
- **#7** — classified `unclassified` (2 tokens, not a surname, not MeSH-resolvable, < 4 tokens) and soft-routed to the topic template. SPEC §3.1 places it in the topic bucket *by intent*; the eval partitions it as topic-shape.
- **#11** — `hybrid` requires `matchQueryToTaxonomy("iadecola stroke")` to resolve "stroke" to MeSH. If it does not, the query degrades to `name` and #11 still tests Iadecola retrieval — note for the owner.

**Resolved judgment calls (frozen 2026-05-27):**
- **#4 `wong` — kept; metric is "the three highest-output Wongs in top-3."**
  Re-verified against the corpus: among 19 active Wongs, stephen-t-c (254 pubs),
  shing-chiu (201) and richard-j (186) are unambiguously the top three by output,
  with a clear gap to #4 (kelvin, 43). The name template alone cannot disambiguate
  among same-surname matches — it only stops *non-Wong* results — so this row is
  the canonical case for the §5.4 prominence factor: legacy scores it 0/3, a
  pub-led prominence factor scores it 3/3.
- **#6 `breast cancer` and #8 `immunology` — kept the domain-defensible picks
  over the raw-attribution leaders.** For #6, raw #2 by attribution is Otterburn
  (25, breast *reconstruction*); the frozen labels keep Cristofanilli (medical
  onc) + Newman (surgical onc) for oncology span. For #8, raw #1 is Elemento (48,
  a computational biologist whose immunology attribution is incidental); the
  frozen labels keep Wolchok (immuno-oncology) + Permar (viral immunology). The
  labeled set encodes what a *good ranker should surface*, not raw row counts.
- **Reuse accepted:** `iadecola` anchors #1 and #11 (intentional — one scholar
  via two shapes); `rulla-tamimi` anchors #6 and #10.
- **Data flag (not blocking):** `christopher-e-mason` (#7) has 0
  `publication_author` rows — his authorships are not linked to his cwid — yet 49
  attributed-topic pubs. He may be hard to retrieve via authorship-derived
  signals; the #7 topic template relies on topic attribution, which he has. Noted
  for the v3 sweep.

Frozen verbatim per SPEC §3.1 ("Frozen at first capture; revisable only at
major-version flips").

---

## 7. §4 Recall@3 baseline — CAPTURED + FROZEN 2026-05-27

The §4 baseline — per-shape Recall@3 for each §6 query under
`SEARCH_PEOPLE_RELEVANCE_MODE=legacy` — is **captured below** against the index
rebuilt at freeze time (§2). It is PR-2's hard rollback target and is frozen,
never refreshed (SPEC §4).

| Shape | Queries | **Recall@3 (legacy, frozen)** | PR-2/3/4 target | Gate |
| --- | --- | --- | --- | --- |
| Name | #1–4 | **0.50** (3/6) | 0.95 | **Hard floor — PR-2 rolls back if not cleared** |
| Topic | #5–8 | **0.00** (0/9) | 0.65 | Directional — "should improve" |
| Department | #9–10 | **0.00** (0/6) | 0.90 | Directional |
| Hybrid | #11–12 | **0.25** (1/4) | 0.75 | Directional |
| **Overall** | all 12 | **0.16** (4/25) | — | — |

§3.3 secondary — mean rank of labeled scholars appearing on page 1: **8.38**
(n=13). The official run (2026-05-27, rebuilt index) reproduced the 2026-05-18
provisional dry-run **exactly**, confirming reproducibility.

**Reading the baseline.** The numbers confirm SPEC §1's thesis: legacy ranking
carries no prominence/topical-fit signal, so prominent scholars sink in
400–1,400-result topic/department sets (Recall@3 = 0.00) and same-surname ties
resolve arbitrarily.

- **Name 0.50 is the legacy floor, not a failure.** #1–3 (unique surnames) and
  #11 all rank their target #1; the *only* name miss is #4 `wong`. Closing #4 to
  the 0.95 PR-2 floor **requires a prominence tiebreaker** — demonstrated in §5.4
  (pub-led prominence takes #4 from 0/3 to 3/3). This is the headroom PR-2 must
  close, not a defect in the baseline.
- **Topic/department 0.00** is the v3 headroom: labeled scholars are present in
  the result set (mean rank 8.4) but below position 3 because nothing floats
  prominent scholars up. The §5.4 prominence factor targets exactly this.

**Reproduction.** With OpenSearch up (`npm run db:up`) and the index rebuilt:

```
DATABASE_URL='mysql://paulalbert@localhost/scholars?socketPath=/tmp/mysql.sock' \
  OPENSEARCH_NODE='http://localhost:9200' \
  SEARCH_PEOPLE_RELEVANCE_MODE='legacy' \
  npx tsx scripts/people-relevance-dryrun.ts
```

**Protocol (as run, 2026-05-27).** With `SEARCH_PEOPLE_RELEVANCE_MODE=legacy`,
each of the 12 queries was run through `searchPeople()` (the same path the
`/api/search?type=people` route uses, so the ranking is faithful) via
`scripts/people-relevance-dryrun.ts`. For each query the top-3 result slugs were
recorded; Recall@3 = (labeled scholars in top-3) ÷ (labeled scholars total), per
shape and overall, plus the mean rank of each labeled scholar that appears
(§3.3). Frozen here, never refreshed (SPEC §4): a v3 flag-flip that fails to beat
the name-shape number is reverted; a regression on another shape is a review
flag.

**Per-query detail (legacy, 2026-05-27).** ✓ = labeled scholar in top-3.

| # | Shape | Query | Total hits | Hit |
| --- | --- | --- | --- | --- |
| 1 | name | `iadecola` | 1 | 1/1 ✓ |
| 2 | name | `richard devereux` | 1 | 1/1 ✓ |
| 3 | name | `harold varmus` | 1 | 1/1 ✓ |
| 4 | name | `wong` | 20 | 0/3 — arbitrary low-output Wongs (see §5.4) |
| 5 | topic | `melanoma` | 388 | 0/2 |
| 6 | topic | `breast cancer` | 769 | 0/3 |
| 7 | topic | `spatial transcriptomics` | 78 | 0/2 |
| 8 | topic | `immunology` | 515 | 0/2 |
| 9 | department | `pediatrics` | 1,362 | 0/3 |
| 10 | department | `population health sciences` | 878 | 0/3 |
| 11 | hybrid | `iadecola stroke` | 1 | 1/1 ✓ |
| 12 | hybrid | `medicine cardiology` | 99 | 0/3 |

Exact-name lookup (#1–3, #11) ranks the target #1 — the index and `searchPeople`
are verified functional, so the topic/department 0.00 is a *ranking* result, not
a data bug. The §6 judgment calls that this run would have informed are resolved
above; the prominence headroom it reveals is addressed in §5.4.

---

## 7b. v3 eval — CAPTURED 2026-05-27 (companion to §7; NOT a re-freeze)

First v3 run of the same frozen §6 labeled set, after the §6.1 templates
(#309–#311) + the #513 prominence factor landed. Index rebuilt immediately
before (`npm run search:index:people` → `scholars-people-v2`, 8,937 docs, PR-3
v3 fields now populated: `publicationMeshUi` 4,773 / `aoiTermCount`>0 1,550 /
`overviewLength`>0 557). The harness's legacy mode reproduced §7's **0.160**
exactly in the same session, so the rebuild is faithful. Reproduce:
`SEARCH_PEOPLE_RELEVANCE_MODE=v3 DATABASE_URL='…' npx tsx scripts/people-relevance-dryrun.ts`.

| Shape | Legacy (§7) | v3 | Gate | Verdict |
| --- | --- | --- | --- | --- |
| name | 0.500 | **1.000** | ≥ 0.95 hard floor | ✅ cleared — #4 `wong` 0/3 → 3/3 |
| topic | 0.000 | 0.222 | 0.65 directional | below |
| department | 0.000 | 0.000 | 0.90 directional | classifier misroute (#528) |
| hybrid | 0.250 | 0.500 | 0.75 directional | below, improved |
| **OVERALL** | **0.160** | **0.400** | — | mean rank 8.38 → 2.42 |

**Findings:**

1. **Name clears the 0.95 hard floor (1.000).** The #513 prominence factor
   (publication-count `ln1p`) resolves #4 `wong` (0/3 → 3/3, the three
   high-output Wongs). This is the one *hard* PR-5 (#312) gate criterion — met.

2. **Department 0.000 is a classifier misroute, not a ranking result** — unlike
   §7, where it was a ranking result. Both labeled department queries collide
   with a surname on a department-name token, so `classifyPeopleQuery` routes
   them off the department template before the department check fires
   (`lastNameSort=sciences` matches 3 scholars → "population health sciences"
   classifies as `name`; "pediatrics" → `hybrid`). The department template never
   runs. Filed as **#528**; the directional target is unreachable until fixed.

3. **Topic is coefficient-insensitive — prominence, not the attribution boost,
   is the lever.** Sweeping the §6.1.3 attribution coefficient 1.5 → 1.75 → 2.0 →
   3.0 left topic flat at 0.222: the labeled misses (Wolchok, Merghoub) *are*
   attributed (Wolchok carries Melanoma D008545, 217 pubs), but so are the
   scholars who outrank them, and the multiplicative boost is uniform across the
   attributed cohort, so it can't reorder within it. A probe adding pub-count
   `ln1p` prominence to the topic body lifted topic 0.222 → 0.333 (surfaced
   Elemento for "spatial transcriptomics"), confirming prominence is the lever —
   but the blunt *multiplicative* form distorted "melanoma" (toward low-relevance
   high-pub dermatologists). The proper fix is the **additive/nested** topic
   prominence deferred from #513 (outer `score_mode: sum` prominence over the
   inner multiply-mode topic function_score), to be calibrated in the follow-up.

**Bottom line:** PR-5's hard floor (name ≥ 0.95) is satisfiable with #513
merged. The directional targets are not yet met — department blocked on the
#528 classifier fix, topic on the deferred additive topic-prominence work (the
attribution coefficient is a dead end). Weights remain initial; this is a
12-query smoke eval, not the full calibration.

---

## 8. Deferred — revisit when telemetry accrues

No People-tab query log exists yet. The following depend on one and are
**not** treated as blockers for #309:

- **§11(k)** — CWID short-circuit fire rate.
- **§11(m)** — query-shape distribution over 90 days (validates the classifier's design assumptions; SPEC §12.1).
- **§11(n)** — repeat-query rate (tests how representative the 12-query set is).

PR-1 (#363) shipped the §9 telemetry today; once ~7–14 days of People-tab
traffic accrues, re-run the §6.1.1 classifier offline over it for (k)/(m)/(n)
and re-validate the §6 labeled set's representativeness against real demand.
Track as a follow-up to #362.

---

## 9. SPEC corrections surfaced by this audit

For folding back into `SPEC-people-relevance-sort-Rev.md` (joins the corrections
already listed in PLAN-issue-308 §Open-questions Q5):

1. **§11(a) SQL** references a `scholar.areas_of_interest` JSON column that does
   not exist. AOI coverage must be derived from `topic_assignment` row counts.
2. **§5.1 / §1 Problem #1** describe `areasOfInterest` as a self-reported
   "profile maintenance" string. It is algorithm-derived from ReCiterAI
   `topic_assignment` rows (`etl/search-index/index.ts:402`). The selection-bias
   conclusion stands; its stated mechanism does not (see §5 finding 2).
3. **§11(e)** assumes a `journal.medlineIndexed` field. There is no `journal`
   table — `publication.journal` is a bare title string. Audit (e) is not
   runnable against this schema.
4. **§10 case 5 / §6.1.4** use `cardiology` as the department example.
   `cardiology` is not a `scholar.primaryDepartment` value (it is a division
   under "Medicine"); it will not classify as `department`. Department-shape
   examples should use real department names (e.g. `pediatrics`,
   `population health sciences`).

---

## 10. Owner sign-off checklist

Completed 2026-05-27 by paulalbert1 acting as eval owner (#362's "Owner: TBD"
was never separately assigned):

- [x] Review §6 — judgment calls resolved (#4 metric + picks, #6/#8
      domain-defensible over raw attribution, reuse accepted, Mason data flag).
- [x] **Freeze §6** — frozen 2026-05-27; revisable only at a major-version flip.
- [x] Confirm the `scholars-people` index is present — rebuilt at freeze time
      (§2), 8,937 docs.
- [x] Run §7 — per-shape + overall Recall@3 captured under `legacy` (§7).
- [x] **Sign off §7** — table filled; this is PR-2's rollback target.
- [x] Confirm #309 (PR-2) may begin — **gate lifted.**

---

## Appendix A — reconciled §11 audit SQL

Run against the host dev MySQL, schema `scholars` (see §2). The snapshot in §4
was produced with socket auth as the OS user; any equivalent read-only access
to the host DB works. Re-runnable as the corpus refreshes.

```sql
-- a) scholar-field coverage — active scholars
SELECT COUNT(*) AS active_scholars,
       SUM(s.overview IS NOT NULL AND s.overview<>'') AS overview_present,
       SUM(LENGTH(s.overview)>200)                    AS overview_gt200,
       SUM(s.primary_title IS NOT NULL AND s.primary_title<>'')           AS has_title,
       SUM(s.primary_department IS NOT NULL AND s.primary_department<>'') AS has_dept,
       SUM(ta.n>=1) AS aoi_ge1_term,
       SUM(ta.n>=3) AS aoi_ge3_terms
FROM scholar s
LEFT JOIN (SELECT cwid,COUNT(*) n FROM topic_assignment GROUP BY cwid) ta ON ta.cwid=s.cwid
WHERE s.deleted_at IS NULL AND s.status='active';

-- b) coverage by role_category (selection-bias check)
SELECT COALESCE(s.role_category,'(null)') AS role_category, COUNT(*) AS n,
       ROUND(100.0*SUM(LENGTH(s.overview)>200)/COUNT(*),1) AS pct_overview_gt200,
       ROUND(100.0*SUM(ta.n>=3)/COUNT(*),1)                AS pct_aoi_ge3,
       ROUND(100.0*SUM(s.primary_title IS NOT NULL AND s.primary_title<>'')/COUNT(*),1)           AS pct_title,
       ROUND(100.0*SUM(s.primary_department IS NOT NULL AND s.primary_department<>'')/COUNT(*),1) AS pct_dept
FROM scholar s
LEFT JOIN (SELECT cwid,COUNT(*) n FROM topic_assignment GROUP BY cwid) ta ON ta.cwid=s.cwid
WHERE s.deleted_at IS NULL AND s.status='active'
GROUP BY COALESCE(s.role_category,'(null)');

-- c) abstract coverage by publication_type
SELECT COALESCE(publication_type,'(null)') AS publication_type, COUNT(*) AS n,
       SUM(abstract IS NOT NULL AND abstract<>'') AS has_abstract,
       ROUND(100.0*SUM(abstract IS NOT NULL AND abstract<>'')/COUNT(*),1) AS pct
FROM publication GROUP BY COALESCE(publication_type,'(null)') ORDER BY n DESC;

-- d) MeSH coverage by recency
SELECT (YEAR(CURDATE())-year) AS years_old, COUNT(*) AS n,
       SUM(JSON_LENGTH(IF(JSON_VALID(mesh_terms),mesh_terms,'[]'))>0) AS has_mesh,
       ROUND(100.0*SUM(JSON_LENGTH(IF(JSON_VALID(mesh_terms),mesh_terms,'[]'))>0)/COUNT(*),1) AS pct
FROM publication WHERE year IS NOT NULL GROUP BY years_old ORDER BY years_old;

-- f) topic-attribution coverage — publication level
SELECT COUNT(DISTINCT p.pmid) AS total_pubs, COUNT(DISTINCT pt.pmid) AS attributed_pubs,
       ROUND(100.0*COUNT(DISTINCT pt.pmid)/COUNT(DISTINCT p.pmid),1) AS pct
FROM publication p LEFT JOIN publication_topic pt ON pt.pmid=p.pmid;

-- g) topic-attribution coverage — scholar level (headline)
SELECT COALESCE(s.role_category,'(null)') AS role_category, COUNT(*) AS active_scholars,
       SUM(att.cwid IS NOT NULL) AS with_attributed_pub,
       ROUND(100.0*SUM(att.cwid IS NOT NULL)/COUNT(*),1) AS pct
FROM scholar s
LEFT JOIN (SELECT DISTINCT cwid FROM publication_topic) att ON att.cwid=s.cwid
WHERE s.deleted_at IS NULL AND s.status='active'
GROUP BY COALESCE(s.role_category,'(null)') WITH ROLLUP;

-- h) authorship-position distribution — scholars with >=5 pubs
SELECT CASE WHEN pa.n_pubs>=20 THEN '>=20 pubs' WHEN pa.n_pubs>=5 THEN '5-19 pubs' END AS pub_bucket,
       COUNT(*) AS scholars,
       ROUND(AVG(pa.frac_first),3) AS avg_frac_first,
       ROUND(AVG(pa.frac_last),3)  AS avg_frac_last,
       ROUND(AVG(pa.frac_middle),3) AS avg_frac_middle
FROM (SELECT cwid, COUNT(*) AS n_pubs,
             SUM(is_first)/COUNT(*) AS frac_first,
             SUM(is_last)/COUNT(*)  AS frac_last,
             SUM(is_first=0 AND is_last=0)/COUNT(*) AS frac_middle
      FROM publication_author WHERE cwid IS NOT NULL GROUP BY cwid) pa
JOIN scholar s ON s.cwid=pa.cwid AND s.deleted_at IS NULL AND s.status='active'
WHERE pa.n_pubs>=5 GROUP BY pub_bucket;

-- i) authorship-position distribution — full corpus
SELECT COUNT(*) AS wcm_authorship_rows,
       ROUND(100.0*SUM(is_first)/COUNT(*),1) AS pct_first,
       ROUND(100.0*SUM(is_last)/COUNT(*),1)  AS pct_last,
       ROUND(100.0*SUM(is_penultimate)/COUNT(*),1) AS pct_penultimate,
       ROUND(100.0*SUM(is_first=0 AND is_last=0)/COUNT(*),1) AS pct_middle
FROM publication_author WHERE cwid IS NOT NULL;
```

Audits (e) and (k)/(m)/(n) are omitted — see §1 and §8.
