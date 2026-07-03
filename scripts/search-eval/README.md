# scholar-search relevance harness

Repeatable, dependency-free tooling for iterating on scholar-search ranking
(companion to `docs/search-relevance-analysis.md`). Pure `bash` + `curl` + `jq` —
no build, no install. Run from the **WCM network** (the staging search API is
public from WCM, no SSO).

## Files

| file | what |
|---|---|
| `probe.sh` | one-query diagnostic: interpretation + top 15 + (optional) expected-scholar ranks |
| `eval.sh` | run the gold fixture set → a diffable scorecard (the A/B harness) |
| `fixtures.json` | expert-labeled `query → expected scholars` gold set (edit/extend freely) |
| `lib.sh` | `fetch_combined`: pages a query, dedupes by cwid, sorts by `relevanceScore` |
| `score_query.jq` | scores one query's results against an expected list (rank, MRR, top-N) |
| `compare.sh` | diffs a fresh run against `baselines/staging.json`, fails on a threshold breach |
| `baselines/staging.json` | checked-in scored baseline (`JSON_OUT` results + run metadata) |

## Quick start

```bash
cd scripts/search-eval

# Diagnose a single query (interpretation + top 15)
./probe.sh "diabetes"

# ...with an expected-scholar check
./probe.sh "diabetes" "Aronne,Shukla,Tchang,Igel"

# Full regression scorecard over the gold set
./eval.sh
```

## Rapid-iteration (A/B) loop

The whole point: change a ranking knob, redeploy staging, re-score, diff.

```bash
./eval.sh > before.txt
#   ... make a change and get it onto staging (see "Deploying a change" below) ...
./eval.sh > after.txt
diff before.txt after.txt          # rank/MRR movement per query, deterministic
```

`eval.sh` output is stable (sorted), so `diff` shows exactly which expected
scholars moved and how the per-query `MRR` / `top20` changed. `JSON_OUT=run.json
./eval.sh` also writes machine-readable results for a workflow to consume.

## Baseline & regression gate (`compare.sh`)

`baselines/staging.json` is a **checked-in scored baseline**: the `JSON_OUT` results
array wrapped in a `meta` block (capture date, the pinned staging image digest + git sha
+ task-def revision, per-query `meshMapped`/`total`, and the overall roll-up). Because it
is committed, a relevance regression becomes a **red diff** and re-baselining is a
**reviewed PR** (snapshot-test style) — never an unattended overwrite.

```bash
# Re-score staging, then gate the fresh run against the committed baseline:
JSON_OUT=fresh.json ./eval.sh >/dev/null
./compare.sh baselines/staging.json fresh.json      # exit 0 = pass, non-zero = breach
#   or stream a bare JSON_OUT array straight in:
JSON_OUT=/dev/stdout ./eval.sh 2>/dev/null | ./compare.sh
```

`compare.sh` accepts either the wrapped baseline (`{meta, results}`) or a bare `JSON_OUT`
array for both inputs, and **exits non-zero** on any of the issue #1444 thresholds:

| threshold | env knob | default |
|---|---|---|
| OVERALL `meanMRR` relative drop | `MRR_DROP` | `0.10` (>10% fails) |
| any single-archetype `MRR` relative drop | `ARCH_DROP` | `0.20` (>20% fails) |
| a pinned top-anchor falling out of its max rank | _(hard-coded `PINS`)_ | Devereux top-3 on `hypertension`; Bacha top-3 on `pediatric congenital heart surgery` |

Pinned anchors are documented, stable #1–#3 results from the audit docs / the 2026-07-02
A/B cells; extend the `PINS` array in `compare.sh` as new anchors are agreed.

### Re-baselining (reviewed PR)

1. Confirm staging serves the intended image (`git sha` in the baseline `meta` should be
   the master commit you want to bless).
2. `JSON_OUT=baselines/staging.raw.json ./eval.sh` (full run; a full pass takes a couple
   of minutes), then rebuild `baselines/staging.json` with a refreshed `meta` block.
3. Open a PR — the reviewer eyeballs the score movement before it becomes the new floor.
   Never re-baseline to make a red `compare.sh` pass without that review.

### Metrics
- **rank** — position among all results (`MISS` = beyond `MAX_PAGES`; bump it for deep checks).
- **top10 / top20** — how many expected scholars landed in the top N.
- **medianRank** — median rank of the found expected scholars.
- **MRR** — mean reciprocal rank over the expected list (1.0 = all at #1; rewards top placement). Watch `OVERALL meanMRR` as the single headline number.

## Archetype labels (per-expected-scholar)

Each `expected` entry is either a bare regex (legacy) or an object
`{re, cwid, arch}`. `cwid` enables **exact** matching (robust to namesakes — e.g.
"Igel" vs "N*igel*"); `arch` is a data-derived **archetype** so `eval.sh` can break
the scorecard down per archetype (the lever that lifts one archetype often can't move
another, so a mixed average hides it):

- **clinician-expert** — expertise lives in clinical/POPS signal; non-anchor-heavy. Lever: clinical fields (`SEARCH_PEOPLE_CLINICAL`).
- **research-pi** — anchor-heavy (first/last) senior author; pub signal carries them.
- **methods-scientist** — high-N middle author, no clinical signal; prone to BM25 term-dilution + length-norm suppression (e.g. C. Mason, a 468-pub genomics PI, is `#MISS` on CRISPR). Lever: authorship-expertise restructure — **with** a `1/√N` double-suppression guardrail.

Two-axis rule (reproducible): `anchor≥50 → research-pi`; else `clinSpec>0 → clinician-expert`;
else `avgN≥8 → methods-scientist`; else `research-specialist`. Authorship mix is from the
`publication_author` table; clinical-field presence from the staging people-index. **Labels
are data-derived and pending domain-expert review** — borderline physician-scientists carry a
`clinician-but-high-N` / `clinician-scientist` flag in the build's review table.

`{"re": ..., "status": "absent-from-index"}` marks an expected scholar **not present in the
people index at all** (a recall gap, not a ranking one) — it always scores `MISS`.

## Knobs (env vars)

| var | default | use |
|---|---|---|
| `HOST` | `https://scholars-staging.weill.cornell.edu` | set to `https://scholars.weill.cornell.edu` to probe **prod** |
| `MAX_PAGES` | `80` (top 1600) | raise to find expected scholars ranked deep |
| `JSON_OUT` | _(unset)_ | path to also dump `eval.sh` results as JSON |

## Deploying a change to staging (for the A/B loop)

Ranking lives in `lib/api/search.ts` (`searchPeople`) + `lib/search.ts` (boost
constants: `PEOPLE_*_FIELD_BOOSTS`, `PEOPLE_PROMINENCE_*`, `MESH_*_WEIGHT`, …).
Two deploy paths (they are separate — see project memory / `docs/`):

- **Code change (weights, query shape):** push the branch, then roll the staging
  image: `gh workflow run deploy.yml --ref <branch> -f env=staging`.
- **New flag / env var:** also needs `cdk deploy --exclusively Sps-App-staging -c env=staging`
  from the branch (the image roll does *not* apply CDK env changes).

Then re-run `./eval.sh`. Staging is a mutable `:latest` target shared with other
work — record the date + `meshMapped`/`total` in the interpretation line when you
capture a baseline.

## Caveats
- `relevanceScore` **is** the pagination sort key (verified) — but always use the
  deduped+sorted `fetch_combined` output, never raw page order.
- `matched` (on-topic pub count) and `roleCategory` (= personType) are read straight
  from the hit; method-family-tagged hits expose **no** `matched` count (the tag is
  binary) — see `docs/search-relevance-analysis.md` §12.
- Expected lists encode human judgment; treat the scorecard as a regression signal,
  not ground truth. Extend `fixtures.json` as new query archetypes come up.
- The failure-class fixtures (from `CAR` onward — #1342/#1344/#1345/#1346/#1348/#1367)
  were derived from the audit docs and verified live, but several are **forward guards**:
  the interpretation bugs the audit found no longer reproduce on current staging (e.g.
  CAR/PET now fall to BM25 instead of resolving to Automobiles/Pets), so those fixtures
  lock in the corrected expected sets rather than catch a live failure. Their archetype
  labels are provisional proxies pending the same domain-expert review as the original set
  (see `fixtures.json` `_note_failure_classes`).
```
