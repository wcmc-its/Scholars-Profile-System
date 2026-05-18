# People-tab Relevance — PR-1 Baseline

**Status: DRAFT — not frozen.** This is the *mechanical half* of issue
[#362](https://github.com/wcmc-its/Scholars-Profile-System/issues/362) (People
relevance PR-1 eval): the SPEC §11 audit and a *candidate* §3.1 labeled set,
produced ahead of an assigned owner per #362's own scoping ("the §11 audit and a
draft 12-query labeled set can be produced ahead of time"). The *judgment half*
— validating and **freezing** the labeled set, and running and **signing off**
the §4 Recall@3 baseline — is pending a human eval owner (§10).

**Gate:** PR-2 ([#309](https://github.com/wcmc-its/Scholars-Profile-System/issues/309),
name-shape template) must not begin until §6 is frozen and §7 is captured —
this document is PR-2's 0.95 name-shape acceptance and rollback target.

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
| §3.1 12-query labeled set | 🟡 **Candidate draft** — §6 below; owner validates + freezes |
| §4 Recall@3 baseline under `legacy` mode | ⛔ **Not run** — §7 is the owner's action (needs the frozen set + a live `scholars-people` index) |

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

---

## 6. §3.1 candidate labeled set — DRAFT (12 queries)

Per SPEC §3.1: 12 queries (4 name / 4 topic / 2 department / 2 hybrid), each
with 1–3 scholar slugs that should appear in the top 3, and a one-line
rationale. **This is a candidate draft for the eval owner to validate, adjust,
and freeze (§10).** All slugs are real, active scholars in the snapshot.
Subjects were chosen from corpus data (surname frequency, pub counts,
`publication_topic` attribution depth, department headcount), not query
traffic — traffic-grounded representativeness (audit n) is a later revisit (§8).

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

**Open judgment calls for the owner (do not freeze without resolving):**
- **#4** — with 18 tied surname matches, the name template alone cannot
  *disambiguate among Wongs*; it can only stop *non-Wong* results. Confirm the
  intent is "top-3 are all real Wongs" (SPEC §3.2's framing) and that the three
  named Wongs are the right representatives.
- **#8** — confirm the broad-domain labeled answer; see the row's note.
- **Reuse:** `iadecola` anchors #1 and #11 (intentional — same scholar via two
  shapes); `rulla-tamimi` anchors #6 and #10. Acceptable, but the owner may
  prefer fully disjoint subjects.
- Scholars 5/6/7/8 selected by `publication_topic` attribution depth; sense-check
  against domain knowledge before freezing.

Once validated, freeze this section verbatim (SPEC §3.1: "Frozen at first
capture; revisable only at major-version flips").

---

## 7. §4 Recall@3 baseline — OWNER ACTION (not yet run)

The §4 baseline — top-3 results and per-shape Recall@3 for each §6 query under
`SEARCH_PEOPLE_RELEVANCE_MODE=legacy` — is **not captured here**. It requires
the labeled set frozen (§6) and a populated `scholars-people` OpenSearch index,
and its sign-off is the eval owner's. It is PR-2's hard rollback target.

**Prerequisites**
1. §6 validated and frozen.
2. `scholars-people` OpenSearch index present and current (a prior session
   handoff recorded it had gone missing — confirm before measuring; rebuild via
   the search-index ETL if absent).

**Protocol**
1. With `SEARCH_PEOPLE_RELEVANCE_MODE=legacy` (the default), for each of the 12
   queries run a People-tab relevance search (`/api/search?type=people&q=…&sort=relevance`).
2. Record the top-3 result slugs.
3. Recall@3 = (labeled scholars appearing in top-3) ÷ (labeled scholars total),
   computed per shape and overall. Capture mean rank of each labeled scholar
   that appears (§3.3).
4. Fill the table below; freeze it.

| Shape | Queries | Recall@3 (legacy) | PR-2/3/4 target | Gate |
| --- | --- | --- | --- | --- |
| Name | #1–4 | _TBD_ | 0.95 | **Hard floor — PR-2 rolls back if not cleared** |
| Topic | #5–8 | _TBD_ | 0.65 | Directional — "should improve" |
| Department | #9–10 | _TBD_ | 0.90 | Directional |
| Hybrid | #11–12 | _TBD_ | 0.75 | Directional |
| **Overall** | all 12 | _TBD_ | — | — |

Frozen here, never refreshed (SPEC §4). A v3 flag-flip that fails to beat the
name-shape number is reverted; a regression on another shape is a review flag.

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

Assigning an eval owner is the remaining #362 blocker. With this draft in hand,
the owner's task is review-and-freeze, not from-scratch construction:

- [ ] Review §6 — adjust queries / labeled slugs as needed; resolve the open
      judgment calls (#4, #8, reuse).
- [ ] **Freeze §6** — once frozen, revisable only at a major-version flip.
- [ ] Confirm the `scholars-people` index is present (§7 prerequisite 2).
- [ ] Run §7 — capture per-shape and overall Recall@3 under `legacy`.
- [ ] **Sign off §7** — fill the table; this becomes PR-2's rollback target.
- [ ] Confirm #309 (PR-2) may begin.

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
