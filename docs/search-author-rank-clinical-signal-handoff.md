# Search Relevance — Author Rank & Clinical Signal Handoff

_Written 2026-06-30. Follow-on to `docs/search-relevance-concentration-followups-handoff.md`
(the boost rework) and `docs/search-relevance-analysis.md` (the original audit). This doc
covers the **base-relevance** investigation that the boost work pointed to as the real lever._

---

## TL;DR

The People-search **boost** is settled (PR #1365). Tuning it further is low-leverage —
proven by a negative experiment. The actual reason genuine specialists rank low (e.g.
Leon Igel, an obesity-medicine clinician, ranked **#153** on `obesity`) is **base
relevance**, and base relevance splits into **two populations that need two different
levers**:

1. **Clinician-experts** (Igel) — expertise lives in **clinical/POPS signal** (board
   certs, specialties, bio), most of which is **dark today**. → **Track A** (cheaper, higher-precision).
2. **Research-specialists / methods scientists** — expertise lives in **publication
   authorship**, currently scored by a saturating BM25 term-repetition hack. → **Track B**
   (an authorship-expertise restructure).

Igel is a Track-A case; no amount of authorship tuning surfaces him. Both tracks are
gated by **archetype-labeled gold sets** that don't exist yet.

---

## What's already settled (do NOT redo)

- **PR #1365** `fix/1363-area-concentration` — concentration fraction-fix (`topicImpact²/totalImpact`)
  + research-roles widening (`SEARCH_BOOST_ELIGIBLE_ROLES` = FT + affiliated + postdoc + fellow)
  + softened boost weights `AREA_BOOST_W_*` **8/4/1.5 → 3/1.5/0.75**. **MERGEABLE / CLEAN, NOT merged.**
  Digest-pinned staging A/B validated it (softening lifts genuinely-suppressed specialists,
  e.g. hypertension Okin #24→#7; affiliated experts become boost-eligible). Rides the existing
  `SEARCH_PEOPLE_AREA_BOOST` flag (staging-on/prod-off), no new flag. Staging restored to master.
- **Concentration-exponent experiment = NEGATIVE result.** Branch `exp/concentration-exponent`
  added an env-tunable exponent `SEARCH_CONCENTRATION_EXPONENT` (default 2) to sweep `n^p/total`
  on both paths. Digest-pinned sweep p=2/1.5/1: the buried specialists **barely moved** (Igel
  #153 unmoved at every p; hypertension specialists flat-to-slightly-worse at low p). **The boost
  formula is not the lever** — with softened weights the boost is a minor additive factor, and
  the deeply-buried specialists aren't getting meaningful boost at any exponent. **Discard the
  `exp/` branch; keep `n²/total`.** (Detail in `project_search_relevance_audit_issues` memory.)

---

## The core finding (don't re-derive)

### Why Igel (#153 on `obesity`) is buried — two independent root causes

**1. "Author rank" = BM25 over concatenated rollups.** For a topic query the dominant fields
are `publicationTitles^6`, `publicationMesh^4`, `areasOfInterest^3`, `overview^2`
(`PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS`, `lib/search.ts:686`). Author position is encoded by
**index-time term repetition**: each pub's terms are pushed `AUTHORSHIP_WEIGHTS[kind]` times —
`firstOrLast:10, secondOrPenultimate:4, middle:1` (`lib/search-index-docs.ts:54`,
`classifyAuthorship` `:62`). Two structural problems:
- **BM25 TF saturates** (`k1`≈1.2) and **length-normalizes** (`b`). So 10/4/1 is **not** a linear
  credit ratio — effective contribution of tf=1/4/10 ≈ **0.45 / 0.77 / 0.89**, i.e. real ratio
  ≈ **1 : 1.7 : 2**, not 1:4:10. A long-CV scholar's terms get length-discounted regardless of weight.
- **On-topic count is not a first-class signal** — it's diluted inside the concatenated blob.

**2. The clinical/POPS signal — Igel's real expertise — is dark.** Igel is board-certified by the
**American Board of Obesity Medicine** (DABOM), Director of the Comprehensive Weight Control
Center, and Program Director of the Obesity Medicine fellowship (weillcornell.org). None of this
ranks today:
- `SEARCH_PEOPLE_CLINICAL = "off"` in **both** envs (`cdk/lib/app-stack.ts:1445`; resolver
  `lib/api/search-flags.ts:1026` defaults off). So `clinicalSpecialties^3` / `clinicalExpertise^2`
  contribute **zero**.
- **The board NAME is never indexed.** POPS gives `{board, specialty}`; only the mapped `specialty`
  reaches search (`clinicalBoardSet`/`clinicalSpecialties`, `lib/search-index-docs.ts:1154-1193`).
  "American Board of Obesity **Medicine**" reaches no searchable field; if POPS has no mapped
  specialty for the cert, it's dropped entirely.
- The **bio / personal statement** (the richest free-text obesity signal) is **not pulled** by POPS
  (`etl/pops/index.ts` imports specialties + expertise only). `overview` is a separate, sparser field.

### Igel is a clinician-expert, not a research-output specialist (load-bearing)

Authorship-position mix (local DB, `lei9004`): **29 pubs, 21% anchor (6 first/last), 28%
penultimate (8), 55% middle (16), avg team size 6.8.** His publication footprint is modest and
mostly non-anchor — on a pure bibliometric query, #153 is arguably **not wrong**. His claim to
"obesity expert" is **clinical**. ⇒ **Track A is his lever; Track B is for a different population.**
(Contrast in the same query: Sharrock 65% anchor = senior PI; Mongan 18% anchor / 111 middle of
191 = methods/collaboration-heavy. These are the archetypes the gold sets must separate.)

### Authorship data: pure byline position, no equal-contribution

`is_first ⇔ position == 1` and `is_last ⇔ position == total_authors`, **exactly, 0 exceptions**
(`publication_author`; `is_first` fired 48,958× at pos 1 / 0× elsewhere; `is_last` 72,460× at end
/ 0× before). **No co-first / co-last / `EqualContrib` data exists in the pipeline.** Consequences:
- The co-anchor "taper" idea is **dead** — there's nothing to dampen.
- The opposite gap is real: a genuine co-first at byline-2 (or co-last at penultimate) is recorded
  `is_first/​is_last = false` and **demoted** from anchor (10) to second/middle (4/1). The scheme
  **under-credits shared leadership**. Fixing it = parse PubMed `EqualContrib="Y"` upstream (ETL),
  weighed against its known-spotty coverage — a separate enrichment, not a blocker.

---

## Two tracks (prioritized)

### TRACK A — Clinical / POPS signal (do first; cheaper, higher precision; rescues clinician-experts)

1. **Verify the staging people-index actually has the clinical fields populated** (in-VPC OS probe:
   does Igel's doc carry `clinicalSpecialties` / `clinicalBoardSet` / `clinicalExpertise`?). This
   decides whether step 2 is a flag flip or a populate-first job.
2. **Flip `SEARCH_PEOPLE_CLINICAL` on** (after an `etl:pops` run + reindex if not populated), re-probe
   `obesity` for Igel. Cheapest possible test of whether the board-cert specialty lifts him.
3. **Index the board NAME** — add `popsBoardCertifications[].board` (or fix the ABOM→"Obesity
   Medicine" specialty mapping) to a searchable clinical field. A board cert is the most
   authoritative, highest-precision expertise signal available; throwing away "Obesity Medicine" is
   the single clearest miss.
4. **Pull the weillcornell.org bio / personal statement** into a searchable field. Rich expertise prose.

### TRACK B — Authorship-expertise restructure (bigger; for research-specialists / methods scientists)

The design discussion (2026-06-30) converged. The recommendations **collectively describe replacing
BM25-term-repetition with an explicit, position+size weighted, per-author-per-topic expertise score**,
because the additions don't fit the current mechanism (you can't repeat a title `1/√N` times). You
are **~80% there**: `publication_topic` already holds per-(scholar, topic) rows with `authorPosition`
+ per-row score; `getAreaScholarConcentration` already computes a query-time aggregate. The work:

- **Promote that aggregate from the weak additive boost (proven low-leverage) into a first-class
  ranking term**, and make it **query-tunable** (so back-test cells don't each need a reindex).
- **Settled design decisions:**
  - Keep **discrete tiers** (explainable to faculty) and **first == last** (splitting penalizes
    early-career first-authors; not a clear win).
  - Generalize authorship credit from the boost's binary D-13 first/last-only carve to the
    **10/4/1** scheme, applied consistently (see "unify" below).
  - **Add `1/√N` size normalization** (`total_authors`, **100% populated**, avg 9.4, max 5154) on
    the **non-anchor bands**; anchors exempt (leading a 120-author trial is a feature). The **floor/cap
    (~12)** is the real decision because of the heavy N-tail.
  - **Positional meaning decays with N** — "penultimate = senior co-author" only holds at small N, so
    the size term should reach the **penultimate band too** (or band assignment becomes N-aware).
    Don't exempt penultimate wholesale.
  - **DROP co-anchor handling** entirely (no data; see above).
  - **Key the methods-scientist fallback off positional concentration, not size-normalized credit** —
    a methods scientist is a high-N middle author, so `1/√N` (within-paper) and a rank-discounted sum
    (across-paper) would **double-suppress** them. This guardrail is **non-optional** once the size
    term exists.
  - **Rank-discounted sum** handles "many relevant papers"; size/position handles "within-paper
    credit." Keep the two axes orthogonal — don't let both penalize the same thing.
- **Unify, don't fork.** There are currently **three disagreeing authorship-credit schemes**: the
  rollup (10/4/1), the concentration boost (D-13 first/last-only, middle=0), and `publicationMeshUi`
  (binary: UI present if on ≥2 pubs any position OR 1 first/last). They produce a scholar who ranks
  differently depending on which surface renders them. The restructure is the only clean moment to
  collapse them into one scheme.

### PREREQUISITE (gates the back-test for both tracks)

Build **archetype-labeled gold sets** — clinician-expert, research-specialist (anchor-heavy PI),
methods-scientist (high-N middle). The lever differs by archetype, so a mixed gold set chases a lever
that can't move half the targets. Until these exist, weight-tuning is theater. (Extends the
"broaden the eval gold set" step in the prior handoff; the harness is `scripts/search-eval/`.)

### SEPARATE ETL enrichment (optional)

Parse PubMed `EqualContrib="Y"` so co-first/co-last get anchor credit. Weigh against coverage; not a
blocker.

---

## Gotchas

- **AUTHORSHIP_WEIGHTS changes require a full people-index REINDEX** — the weights are baked in at
  index time via term repetition. A `middle∈{1,2} × second∈{3,4,5}` sweep = up to 6 reindexes. And
  per BM25 saturation, `second 3/4/5` are nearly indistinguishable in ranking — **`middle 1→2` is the
  only integer that meaningfully moves anything**. This is the strongest argument for the
  query-tunable restructure before any sweeping.
- **Local DB is schema-drifted** (canonical checkout is ~357 commits behind master). `first_author_count`
  / `last_author_count` are **per-scholar productivity stats on the `scholar` table** — NOT per-pub
  co-anchor counts. `total_authors`, `is_first/is_last/is_penultimate`, `position` are on
  `publication_author`. Confirm absolute numbers against staging/prod; ratios are representative.
- **Staging A/B infra** (from PR #1365 / exponent runs): pin **image digests** per cell (env-var-only
  cells are cheap task-def re-registers on one pinned digest). `deploy.yml --ref <branch>` **clobbers
  `:latest`** → restore = re-tag ECR `:latest`→master digest **and** `update-service` to rev 90
  (rev 90 points at the mutable `:latest`, so reverting the service alone is insufficient).
  `aws ecr put-image` re-serializes the manifest → a cosmetically-different `:latest` digest with
  identical master content; harmless, the next master CD tidies it. **Active master CD churn races
  the digest pin** — verify the running digest before every probe.

---

## Key files

| File | What |
|---|---|
| `lib/search-index-docs.ts` | `AUTHORSHIP_WEIGHTS` (:54), `classifyAuthorship` (:62), rollup builder + term repetition (:779+), clinical fields `clinicalSpecialties/clinicalBoardSet` (:1154-1193), `publicationMeshUi` threshold, `overview` |
| `lib/search.ts` | `PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS` (:686), `PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS` (:607), `AREA_BOOST_W_*` (:875), `CONCEPT_CONCENTRATION_MIN_PUBS` (:894), `concentrationExponent` (exp branch only) |
| `lib/api/search.ts` | `peopleTopicFields`/`peopleDefaultFields` + `clinicalFields` (:1593), `getConceptScholarConcentration` (:1121), prominence `function_score` (`score_mode:sum, boost_mode:multiply`), area-boost gating (:2283) |
| `lib/api/topics.ts` | `getAreaScholarConcentration` (curated/Prisma concentration; #1365 fraction-fix + role widening) |
| `lib/api/search-flags.ts` | `resolveSearchPeopleClinical` (:1026), `resolveSearchPeopleAreaBoost`, `resolveSearchPeopleFacultyProminence` |
| `etl/pops/index.ts` | POPS clinical ETL — pulls specialties + expertise + boardSet; **drops the board NAME**; no bio/personal-statement |
| `cdk/lib/app-stack.ts` | `SEARCH_PEOPLE_CLINICAL` "off" both envs (:1445), `SEARCH_PEOPLE_AREA_BOOST`/`FACULTY_PROMINENCE` |
| `prisma/schema.prisma` | `Scholar.firstAuthorCount/lastAuthorCount` (:96-97, per-scholar), `PublicationAuthor.totalAuthors/position/isFirst/isLast/isPenultimate` (:916+) |
| `scripts/search-eval/` | curl+jq A/B harness (gold set lives here; archetype sets to be added) |

---

## Reusable queries (run from the canonical checkout)

```bash
# host MariaDB (canonical); --no-defaults is load-bearing
mysql --no-defaults --socket=/tmp/mysql.sock -u paulalbert scholars
```

```sql
-- Author-position is pure byline position (no equal-contribution captured):
SELECT SUM(is_first AND position=1)             AS first_at_pos1,
       SUM(is_first AND position<>1)            AS first_beyond_pos1,   -- = 0
       SUM(is_last  AND position=total_authors) AS last_at_end,
       SUM(is_last  AND position<>total_authors) AS last_before_end     -- = 0
FROM publication_author;

-- Team-size (N) distribution for the 1/√N term (100% populated):
SELECT MIN(total_authors), ROUND(AVG(total_authors),1), MAX(total_authors),
       SUM(total_authors IS NULL) FROM publication_author;

-- A scholar's authorship-position mix + typical team size (archetype check):
SELECT s.cwid, s.preferred_name, COUNT(*) AS pubs,
       ROUND(100*AVG(pa.is_first OR pa.is_last),1) AS anchor_pct,
       SUM(pa.is_penultimate) AS penult,
       SUM(NOT pa.is_first AND NOT pa.is_last AND NOT pa.is_penultimate) AS middle,
       ROUND(AVG(pa.total_authors),1) AS avg_N
FROM scholar s JOIN publication_author pa ON pa.cwid = s.cwid
WHERE s.preferred_name LIKE '%Igel%'
GROUP BY s.cwid, s.preferred_name;
```

```bash
# Staging search API is public from WCM (no SSO), curl -4; ?type=people&q=obesity&page=N
# (drives the eval harness; see scripts/search-eval/lib.sh)
```

---

## Recommended next action

Start **Track A step 1** — in-VPC probe of the staging people-index for Igel's clinical/board fields.
It's read-only, ~minutes, and the single result forks the whole clinician-expert track (flag-flip vs
populate-then-flip). Everything in Track B is gated on the archetype gold sets, so it shouldn't start
until those exist.
