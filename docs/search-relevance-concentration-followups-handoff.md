# Search-Relevance "Concentration over Volume" — Follow-ups Handoff

_Written 2026-06-30, after the #1342–#1348 ranking stream merged. Companion to
`docs/search-relevance-analysis.md` (the original audit) and `scripts/search-eval/`
(the A/B harness)._

---

## TL;DR

The audit's headline fix — "rank specialists by **on-topic concentration**, not
total volume" — was **implemented backwards** and caught only by a staging A/B. The
concept-axis half is now fixed and merged (#1353). **The curated half (#1336), which
is what actually handles `obesity`/`hypertension`, still ranks by volume — that's the
single highest-leverage next step (#1363).**

| PR | What it was | What actually shipped |
|---|---|---|
| #1352 | MeSH resolver sweep (#1342/#1346/#1348) | merged, flags staging-on/prod-off |
| #1353 | People ranking (#1343/#1344/#1345) | merged — **#1343 reworked** to fraction tiering, **0.5 down-weight removed** |
| #1356 | division-shape routing (#1347 code half) | merged, `SEARCH_PEOPLE_DIVISION_SHAPE` dark |

All seven issues (#1342–#1348) are **open**, narrowed to their precise remaining
step (mostly "prod flip after A/B"). New issue **#1363** tracks the curated-path fix.

**Post-merge staging baseline (2026-06-30, master image, `AREA_BOOST=on` / `FACULTY=off`):**
`meanMRR=0.144, top20=20/51` over the 8-query gold set — up from **0.125** pre-rollout
(+15%), no merge regression. The concept-axis fraction fix is live (fecal: Longman #1,
Crawford #2, Peled #3). The `top20` dip (22→20) is the known #1345 faculty-off diabetes
regression. **This 0.144 is the number #1363 (curated-path fix) must beat** — and the
faculty-off contribution should be re-checked once #1363 lands (step 3).

---

## The core finding (don't re-derive this)

The People ranking applies an **area-concentration boost**: scholars who are
"concentrated" on the query's topic get a large additive weight (8 / 4 / 1.5 by
tier) in the prominence `function_score`. There are **two independent sources** that
feed the **same** `buildAreaBoostFunctions` tiering slot:

1. **Concept-axis** — `getConceptScholarConcentration()` in `lib/api/search.ts`.
   OpenSearch agg over `scholars-publications`. Fires for MeSH-concept queries with
   **no** curated Research Area (e.g. `fecal microbiota transplantation`).
   **← FIXED in #1353.**
2. **Curated area** — `getAreaScholarConcentration()` in `lib/api/topics.ts`.
   Prisma query over `publicationTopic`. Fires for queries that **do** map to a
   curated Research Area (`obesity`, `hypertension`, …). Pre-empts source #1.
   **← still volume-based = #1363.**

**The bug:** both sources ranked scholars by *amount* of on-topic output (raw
`doc_count` for concept-axis; summed impact for curated), tiered by fraction-of-max.
That rewards **high-volume** authors who happen to have many on-topic pubs — the exact
volume double-count the boost was meant to fix. A ~900-pub cardiologist with 20
obesity pubs out-tiered a 30-pub obesity specialist.

**Empirical proof (staging A/B, digest-pinned branch image, 4-cell decomposition):**

```
                    base → +boost(facON) → +facOFF → +0.5downwt
hypertension MRR     91  →   91          →  97     →   95
pediatric CHD MRR   125  →  125          → 250     →  200
OVERALL meanMRR    .125  → .127          → .141    → .135
```

- The concept boost (faculty held constant) moved **almost nothing** — the wins came
  from the **faculty-off** step (#1345), not the boost.
- Turning the boost **OFF entirely ranked hypertension specialists HIGHER**
  (Okin #37→#18, Alderman #46→#28, Devereux #2→#1). The boost was **actively
  suppressing** them.
- The 0.5 down-weight was **net-negative** (.141→.135): inside `ln1p` it's a
  near-uniform shift that pushes specialists back down.
- **Data is healthy** — an in-VPC probe of `scholars-publications` (177k docs,
  `meshDescriptorUi`/`wcmAuthorCwids` 88/98% populated; the obesity agg returns
  `ljaronne=122, aps2004=30, rbdevere=18`). This is a **ranking-formula** problem,
  not a reindex/data gap.

**The #1353 fix:** `getConceptScholarConcentration` now scores by
`n² / total` (on-topic count × on-topic fraction) with a `CONCEPT_CONCENTRATION_MIN_PUBS`
floor, so a niche specialist out-tiers an incidental generalist while a genuine
high-output expert still leads. `buildAreaBoostFunctions` (frac-of-max tiering) is
unchanged. Re-A/B confirmed: `fecal` Peled #5→#3, Crawford #3→#2; every other query
byte-identical (correctly scoped). meanMRR .127→.130.

---

## Next steps (prioritized)

### 1. #1363 — fraction-fix the curated path (DO FIRST; highest leverage)

`obesity`/`hypertension` and most real specialist queries go through
`getAreaScholarConcentration` (`lib/api/topics.ts`), which returns `{cwid, total}`
where `total` = **summed `scorePublication` impact** over the scholar's first/last-
author pubs in the topic. Summed impact still correlates with volume → same flaw.

**The fix (mirror #1353):** normalize by the scholar's total output. Concretely,
score by `topicImpact² / totalImpact` (or `topicImpact × topicImpact/totalImpact`)
where `totalImpact` = that scholar's summed impact across **all** topics. The
`publicationTopic` table already has per-scholar per-topic rows, so the denominator
is one extra grouped query (or a join) — no reindex. Add a min-pubs/min-impact floor
like the concept-axis path.

**Critical A/B design — include `boost-off` as a control.** The data already showed
boost-*off* beat raw-boost for hypertension. So the real question is **"does
fraction-corrected boost beat NO boost?"** Run three cells per query:
`AREA_BOOST=off` vs `AREA_BOOST=on` (raw, = today's master) vs `AREA_BOOST=on`
(fraction-fixed). If fraction-fixed ≈ boost-off, the answer is to **weaken or remove**
the boost, not re-tier it. Let the numbers decide — don't assume re-tiering wins.

**Expected outcome to validate:** `obesity` should lift Igel (#183) and Aras (#304);
`hypertension` should lift Alderman/Wachtell/Okin without dropping Devereux.

### 2. Broaden the eval gold set (do alongside #1363 — it's the measurement)

`fixtures.json` has **one** clear concept-axis query (`fecal`). You cannot measure
#1363 or anything downstream with that. Add expert-labeled (or analyst-derived, noted
as such) specialist lists for these archetypes — each tests a specific lever:

| Archetype | Why / which lever | Seed queries |
|---|---|---|
| Curated-area concept | #1363 (curated boost) | `obesity`✓, `hypertension`✓, `heart failure`, `breast cancer`, `inflammatory bowel disease` |
| Concept-axis (no curated area) | #1353 fraction fix | `fecal microbiota transplantation`✓, plus narrow procedures/conditions that *don't* map to a Research Area |
| Multi-word specialist | #1344 phrase boost | `pediatric congenital heart surgery` (Bacha), `minimally invasive spine surgery` |
| Acronym | #1346 sense guard | `CAR` (→ CAR-T, not Automobiles), `PET`, `MS` |
| Lay / possessive | #1342 normalization | `diabetes`✓, `alzheimer's`✓, `lou gehrig's disease` |
| Division name | #1347 division-shape | `Cardiology`, `Endocrinology`, `Infectious Diseases` |

To classify whether a query is concept-axis vs curated: deploy the branch with
`AREA_BOOST` on, probe with `AREA_BOOST` off — if it changes AND `B0f ≈ baseline`,
it's curated; if `B0f ≠ baseline`, it's concept-axis. (See the A/B method below.)

**Commit the harness fix while you're here:** `scripts/search-eval/` has an
uncommitted ARG_MAX fix (the `jq --argjson` → stdin change for >4k-result queries)
plus the obesity/pediatric-CHD fixtures, currently on `docs/spotlight-pipeline`.
Land it (with this doc) via a fresh-off-master PR.

### 3. Re-evaluate #1345 (faculty lever) AFTER #1363 — its tradeoff may dissolve

The faculty-off lever's only value was lifting buried non-FT specialists — which is
exactly what a *correct* concentration boost does. Today it ships as a blunt on/off
with a real **diabetes regression** (Tchang #117→#199, the all-FT metabolism cluster
loses its prior). Once #1363 lands and the boost lifts true specialists properly,
**keeping the faculty prior may no longer bury anyone** — letting us avoid the
regression entirely. Don't make a prod decision on #1345 until you've re-run the A/B
with #1363 in place. Sequencing matters.

### 4. #1344 phrase boost — quick independent staging A/B

Code-complete but `SEARCH_PEOPLE_PHRASE_BOOST` is **dark** (not even in cdk). Wire it
staging-on (add to `app-stack.ts`, regen snapshot, `cdk deploy Sps-App-staging`),
re-A/B the multi-word archetype (`pediatric congenital heart surgery`). Low effort,
isolated from #1363.

### Deeper / reindex-gated (later)

- **`minimum_should_match` over-broadening** (#1344's untouched half) — the 4,558-
  result dilution for multi-word queries is the shared cross_fields msm (`2<-34%`).
  The PR punted because it's shared with the pub tab. Worth investigating whether the
  **People-tab** msm can be tightened independently (the pub tab's EHR over-collapse
  is the constraint that blocked the global change).
- **#1347 chair/chief leadership boost** — a no-op until `chiefCwid`/`chairCwid` are
  indexed (ETL/reindex).
- **#1343 method-tag depth** — method-family-tagged hits expose no per-scholar pub
  count, so they can't be concentration-scored without a reindex.

### Systemic: make the relevance eval a repeatable gate

This whole episode — a **shipped** feature (#1336) silently suppressing specialists,
caught only by a manual A/B — is the argument for it. Unit tests pin query *bodies*,
not *rankings*. Wiring `scripts/search-eval` (it already emits machine-readable JSON
via `JSON_OUT=`) into the review flow, with a small gold set and a meanMRR
regression threshold, would catch the next #1336 before it ships.

---

## Tooling & method (how to actually iterate)

### The A/B harness (`scripts/search-eval/`)

```bash
cd scripts/search-eval
./eval.sh > before.txt      # full gold-set scorecard
# ...deploy a change to staging (below)...
./eval.sh > after.txt
diff before.txt after.txt   # deterministic per-query rank/MRR movement
./probe.sh "obesity" "Aronne,Igel"   # one-query diagnostic + expected ranks
```
Staging search API is **public from WCM** (no SSO). `curl -4`. The harness
cache-busts per request. `JSON_OUT=run.json ./eval.sh` for machine-readable output.

### Race-proof staging deploy (IMPORTANT — learned the hard way)

A branch staging deploy is **not** just `gh workflow run deploy.yml`. The mutable
`:latest` tag gets **clobbered by concurrent master CD** (it happened mid-rollout —
#1358 merged and overwrote `:latest` between the image roll and the cdk flag deploy,
so staging silently ran master code and the A/B was byte-identical for the wrong
reason). For a valid A/B, **pin the running task to the branch image digest**:

```bash
# 1. roll the branch image
gh workflow run deploy.yml --ref <branch> -f env=staging   # wait for SUCCESS (check conclusion, not the watch exit)
# 2. get the immutable digest for the branch sha
aws ecr describe-images --repository-name scholars-app-staging \
  --image-ids imageTag=<full-branch-sha> --query 'imageDetails[0].imageDigest' --output text
# 3. register a task-def pinned to that digest (base on the current rev, swap the app image to ...@sha256:<digest>,
#    set the flags you want to A/B), update-service --force-new-deployment
# 4. aws ecs wait services-stable; VERIFY the running task's imageDigest == the branch digest before every eval
# 5. restore afterward: update-service --task-definition <a :latest-based rev> --force-new-deployment
#    (deploy.yml force-news WITHOUT --task-definition, so a digest-pin BLOCKS CD self-heal — must restore)
```
Flag env-vars only take effect via the task-def (cdk or the hand-pinned one) — the
image roll alone does **not** apply them. Env-var-only A/B cells (e.g. faculty on/off)
are a cheap task-def re-register on the same pinned digest, no rebuild.

### In-VPC OpenSearch probe (raw index inspection)

The OS domain is VPC-only. To query it directly (e.g. confirm an agg returns data),
`run-task` on `sps-etl-staging` (has `OPENSEARCH_NODE` + `OPENSEARCH_USER/PASS`
baked) with a `node -e` command override using built-in `https` + basic auth — never
print the password. Network config = the app service's subnets + SG. Read the output
from the `/aws/ecs/sps-etl-staging` log stream. (See `os-probe.js` pattern from this
session.)

---

## Key files

| File | What |
|---|---|
| `lib/api/search.ts` | `getConceptScholarConcentration` (#1353, fraction-fixed), `searchPeople`, `buildAreaBoostFunctions`, prominence `function_score` |
| `lib/api/topics.ts` | `getAreaScholarConcentration` (#1363 target — still volume-based) |
| `lib/search.ts` | `AREA_BOOST_W_*` weights (8/4/1.5), `AREA_BOOST_*_FRAC` cutoffs, `CONCEPT_CONCENTRATION_MIN_PUBS`, prominence constants |
| `lib/api/search-flags.ts` | flag resolvers (`resolveSearchPeopleAreaBoost`, `…FacultyProminence`, `…DivisionShape`, `…PhraseBoost`) |
| `app/api/search/route.ts` + `app/(public)/search/page.tsx` | route + SSR; **both** resolve flags for parity — change them together |
| `cdk/lib/app-stack.ts` | flag env-var defaults per env (regen snapshot on any change: `cd cdk && npm test -- -u`) |
| `scripts/search-eval/` | the A/B harness |
| `docs/search-relevance-analysis.md` | the original audit |

## Gotchas

- **route + SSR parity:** any `searchPeople` opt resolved from a flag is wired in
  BOTH `route.ts` and `page.tsx`. Grep `*.ts` AND `*.tsx` when adding/removing one
  (a `--include="*.ts"`-only grep missed the SSR import this session and broke the
  build).
- **Worktree staleness:** the search worktree symlinks `node_modules` to the
  canonical checkout (which lags master). `vis-network` tsc errors and an
  `edit-page.test.tsx` failure are local artifacts — green in CI. Run
  `npx prisma generate` in the worktree after merging master (the generated client
  is gitignored and goes stale → spurious `matchRel`-style type errors).
- **cdk snapshot:** any `app-stack.ts` env change fails `app-stack.test.ts` until
  regenerated (`cd cdk && npm test -- -u`). Two PRs both touching app-stack → the
  snapshot auto-merge can land stale; `cdk` CI on the merge commit catches it.
- **`getAreaScholarConcentration` vs `getConceptScholarConcentration`** are different
  code (Prisma vs OpenSearch) feeding the same boost — fixing one does NOT touch the
  queries handled by the other.
