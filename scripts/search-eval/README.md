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

### Metrics
- **rank** — position among all results (`MISS` = beyond `MAX_PAGES`; bump it for deep checks).
- **top10 / top20** — how many expected scholars landed in the top N.
- **medianRank** — median rank of the found expected scholars.
- **MRR** — mean reciprocal rank over the expected list (1.0 = all at #1; rewards top placement). Watch `OVERALL meanMRR` as the single headline number.

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
```
