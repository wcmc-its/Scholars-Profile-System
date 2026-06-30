# Search Author-Rank & Clinical Signal — Handoff 2 (investigation + B2 shipped)

_Written 2026-06-30. Successor to `docs/search-author-rank-clinical-signal-handoff.md`. Covers
the full investigation that handoff pointed to, the findings that reshaped it, and the one
ranking lever that survived and was built (B2). All work is on branch
`feat/search-rank-clinical-signal` (worktree `~/worktrees/sps-search-rank`) → **PR #1372** (review-only)._

---

## TL;DR

The original handoff split the work into **Track A** (clinical signal, "cheap, do first") and
**Track B** (authorship-expertise restructure, "big"). Empirical, non-destructive in-VPC A/B
testing **refuted most of it** and converged on a single real ranking lever:

- **Track A as written (flip `SEARCH_PEOPLE_CLINICAL`) is INERT** — clinical as a `cross_fields`
  text field is swallowed by the blend; zero movement (Igel #183→#183).
- **B1 (authorship restructure) + B3 (scheme-unify) are REFUTED** — the "buried methods-scientist"
  exemplar (Mason) was a **data bug** (0 attributed pubs in staging); cleanly-attributed
  methods-scientists already rank fine.
- **B2 — clinical-as-function_score — is the one real lever, and it's BUILT** (flag-gated, off by
  default). Measured: obesity Igel **#183→#12**, Aras **#304→#16**; diabetes Igel **#248→#7**.
- Two non-ranking issues surfaced and were routed: a **lay-term MeSH-mapping gap** (→ #1258) and a
  **per-author attribution gap** (→ data/ReCiter team).

**Foundation:** PR **#1365** (concentration fraction-fix + softened weights + the `scripts/search-eval/`
harness) was **merged to master** (`816c0a99`) this session at the user's direction — it was NOT on
master before. Everything below builds on it.

---

## Status board

| item | state |
|---|---|
| #1365 (concentration baseline + eval harness) | **MERGED** to master `816c0a99` |
| PR #1372 (this work, 7 commits) | **OPEN, review-only.** cdk + Orca green; `build` running at handoff time — confirm green before any merge. MERGEABLE. |
| B2 clinical-as-function_score | **BUILT + locally verified** (full vitest 6339, tsc, cdk 500). Flag `SEARCH_PEOPLE_CLINICAL_FN` **off** both envs. Not yet A/B'd on a real staging deploy. |
| Track A (text-field flag flip) | **Abandoned** — proven inert. `app-stack.ts` flag edit reverted. |
| B1 / B3 | **Dropped** — refuted by the gold data. |
| Mason attribution bug | **Diagnosed, needs routing** to data/ReCiter team. |
| Finding C (lay-term aliases) | **Documented, routed to #1258.** |

---

## What's in PR #1372 (7 commits)

1. `db77e89a` — **archetype-labeled gold sets** + cwid-robust matching (`scripts/search-eval/`).
2. `a87ccf45` — Finding C doc (lay-term meshMapped gap → #1258).
3. `d717198d` — Track A inert finding.
4. `5ea5cbf5` — Track B plan (original, now partly superseded by the diagnostics below).
5. `2be087dc` — Track B pre-build diagnostic (authorship premise refuted).
6. `8ecf633c` — Mason attribution + re-scope finding.
7. `92884d77` — **B2 implementation** (the only code/ranking change; everything else is docs/tests).

---

## The findings (with evidence + doc pointers)

### 1. Grounding corrected 5 handoff claims (vs master)
`AUTHORSHIP_WEIGHTS` 10/4/1, field boosts, clinical-fields-gated-off, `publicationMeshUi` binary,
`getConceptScholarConcentration` n²/total — all confirmed. Corrections: #1365 + the harness were
**not on master** (now merged); POPS ETL **does** store the board name (the *index builder* drops
it, not the ETL); Igel live rank was **#153** (harness, cwid-matched), not #140.

### 2. Track A (clinical flag) is INERT — `docs/search-trackA-clinical-inert-finding.md`
Non-destructive in-VPC A/B (call the real `searchPeople`, toggle `process.env.SEARCH_PEOPLE_CLINICAL`):
**zero** movement, 26 gold scholars × 4 queries. Cause: the people topic query is one `cross_fields`
multi_match; `cross_fields` blends to the **dominant** field, so `clinicalSpecialties^3` (8.74) is
swallowed by Igel's `publicationTitles^6` (29.75) / `publicationMesh^4` (22.27). Holds at
`feat/pops-clinical-tune`'s `^5` too (needs ~`^11`). Separately, Igel is buried by the
**function_score multipliers** (final 248 ≈ 8× text 29.75), which text fields can't touch.

### 3. meshMapped lay-term gap — `docs/search-meshmapped-layterm-gap-finding.md` (→ #1258)
`diabetes` / `alzheimer's` resolve to `meshMapped=false` → keyword fallback → every archetype craters
(diabetes gold medRank 198). `resolveMeshDescriptor` (`lib/api/search-taxonomy.ts`) matches descriptor
names + NLM entry-terms + `mesh_curated_alias` only; lay terms need a **curated alias** row. The
`Alzheimer's`→D000544 alias exists in `etl/mesh-aliases/curated.csv` but isn't loaded on staging
(`etl:mesh-aliases` not run there); `diabetes`→D003920 is missing. Fix = curated alias rows + ETL,
no code/reindex. Belongs to #1258/#642.

### 4. B1/B3 refuted; the methods-scientist burial was a data bug — `docs/search-trackB-prebuild-diagnostic.md` + `docs/search-mason-attribution-and-rescope-finding.md`
- B0 (tuning weights) is inert (concentration gives buried scholars ~0).
- The concept path (`getConceptScholarConcentration`, the OS/MeSH route real queries use) counts
  `wcmAuthorCwids` **regardless of author position** → B1's "count middle authors / 1/√N" is moot.
- The curated path already ranks Mason **top-tier** in `single_cell_spatial_biology` (conc 0.47).
- **Christopher Mason (`chm2042`) = data bug:** `publicationCount=0` in the staging people index, 0
  `wcmAuthorCwids` attribution in the pub index (8 sampled pmids 404), despite 468 local
  `publication_author` rows. **1 of 40 probed gold scholars** (only him). His #706 was a confound.
- Cleanly-attributed methods-scientists rank fine (scRNA Betel #11/Landau #6/Elemento #28; CRISPR
  Dow #1/Vardhana #32) even with an empty concept pool → **no methods ranking lever needed.**

### 5. B2 (clinical-as-function_score) WORKS — built in `92884d77`
The lever everything pointed to: a **function_score** boost (not a text field) on docs whose
board-derived `clinicalSpecialties` match the query.

---

## B2 — what was built (commit `92884d77`)

- **Mechanism:** in `searchPeople` (`lib/api/search.ts`), an additive function on the outer
  prominence `function_score` (`score_mode: sum, boost_mode: multiply`):
  `{ filter: { match: { clinicalSpecialties: <trimmed query> } }, weight: W }`. Topic/hybrid shapes
  only (like the area boost). Bypasses the cross_fields blend that made Track A inert.
- **Keyed on `clinicalSpecialties` ONLY** (board-derived, high precision). The prototype showed
  `clinicalExpertise` free-text is too noisy: including it **regressed hypertension** (boosted 68
  spurious matchers above Devereux/Okin). Specialties-only → condition queries with no board
  specialty (hypertension) get **0 matchers → safe no-op**.
- **Flags** (`lib/api/search-flags.ts`, wired in `cdk/lib/app-stack.ts` both envs):
  - `SEARCH_PEOPLE_CLINICAL_FN` = `"off"` (default; topic/hybrid only).
  - `SEARCH_PEOPLE_CLINICAL_FN_WEIGHT` (code default **3**) — query-tunable, **no reindex**.
- **Validation (non-destructive, in-VPC):** obesity Igel #183→#12, Aras #304→#16, Tchang #23→#6,
  Shukla #2→#1; diabetes Igel #248→#7, Tchang #112→#5 (lifts clinicians even past the
  meshMapped=false crater); hypertension 0 matchers → unchanged.
- **Tests:** `tests/unit/search-people-prominence.test.ts` (inclusion / weight-tunability /
  shape-gating / flag-off byte-identical). Full vitest **6339 pass**, tsc clean, cdk **500 pass**,
  snapshot regenerated (+8 lines, flag only).

---

## Remaining work (prioritized, with commands)

### A. Confirm CI green on #1372, then decide merge
```bash
gh pr checks 1372            # build was still running at handoff
```
Review-only until the user says merge. Note: the docs describe an *abandoned* Track A and a
*refuted* B1 — keep them (they're the evidence trail) or prune to taste before merge.

### B. Real staging A/B for B2, then flag-flip (the validation gate before prod)
The non-destructive probe validated the *formula*; a real staging A/B needs B2's code running on
staging. **Use an IMAGE roll, NOT a cdk deploy** (a cdk deploy of a master-based stack would strip
#1366's `SEARCH_EVIDENCE_REASON_COUNTS` / `SEARCH_PEOPLE_CONCENTRATION` — staging runs feat/1366's cdk):
```bash
gh workflow run deploy.yml --ref feat/search-rank-clinical-signal -f env=staging   # rolls staging IMAGE (safe re: flags)
```
Then activate the flag in-process via the in-VPC probe (toggle `SEARCH_PEOPLE_CLINICAL_FN`), or flip
it for real (needs a cdk deploy — coordinate with #1366 so its flags aren't stripped; or fold both
flag sets into one deploy). Re-run the gold A/B (`scripts/search-eval/eval.sh`, per-archetype
scorecard) and confirm clinician-experts rise with no research/methods regression. Tune
`SEARCH_PEOPLE_CLINICAL_FN_WEIGHT` if needed (no reindex). Restore staging image to master after
(`deploy.yml --ref master -f env=staging`).

### C. Route the Mason-type author-attribution gap → data/ReCiter team
`chm2042` has 0 attributed pubs in staging despite 468 local rows — he's invisible on every topical
query, independent of ranking. File against the ReCiter/identity or people/pub-index author-linkage
pipeline. Check scope beyond the gold set (how many active scholars have `publicationCount=0`).

### D. Gold-set labels — domain review + drop/flag Mason
The archetype labels in `scripts/search-eval/fixtures.json` are **data-derived, pending domain
review** — especially the `clinician-but-high-N` physician-scientists (Horn/Scherl/Lukin/James Lo)
and `clinician-scientist` PIs (Aronne/August/Mann/Bacha). Mason is a confounded exemplar (drop or
flag until his attribution is fixed). 4 entries (Battat/Gogokhia/de Leon/Pereira) are
`absent-from-index` (recall-impossible) and can be dropped.

### E. Finding C → #1258
Add `diabetes`→D003920 (and other top lay terms) to `etl/mesh-aliases/curated.csv`, run
`etl:mesh-aliases` on staging to activate the already-merged rows (Alzheimer's, …), re-probe
`?type=people&q=diabetes` for `meshMapped=true`.

---

## Gotchas (load-bearing)

- **Staging is contended by #1366.** A `cdk deploy Sps-App-staging` from a master-based stack STRIPS
  #1366's `SEARCH_EVIDENCE_REASON_COUNTS` + `SEARCH_PEOPLE_CONCENTRATION` (verified via `cdk diff`).
  Use image rolls + in-VPC probes; coordinate any cdk flag flip.
- **The non-destructive A/B pattern** (reused all session): `scripts/run-staging-probe.sh <probe.ts>
  staging` ships a read-only tsx probe to the staging ETL Fargate task. It runs the **container's
  deployed code** (so it can't test uncommitted lib changes), but it can `import { searchPeople }`
  and toggle `process.env` flags in-process, and inject `areaConcentration` to prototype a
  function_score boost without deploying. The ETL container lacks `next/server` — call `searchPeople`
  directly (replicate the route's opts from `lib/api/*`, all framework-free), don't import the route
  handler. Force staging flag values (`SEARCH_PEOPLE_AREA_BOOST=on`, `FACULTY_PROMINENCE=off`) and
  validate probe-off against the public-API baseline.
- **Public staging search API** is reachable from WCM, no SSO: `curl -4
  'https://scholars-staging.weill.cornell.edu/api/search?type=people&q=obesity&page=N'`. Drives
  `scripts/search-eval/`.
- **Local DB is schema-drifted** (~360 behind): has `publication_author`/`publication_topic` with
  representative ratios, but **not** the POPS columns or the OS indices. Authorship-mix classification
  works locally; clinical-axis + concept-concentration need staging probes. Mason's 468 local rows vs
  0 staging attribution is the smoking gun for the data bug.
- **cross_fields blends to the dominant field** — the core reason text-field clinical boosts (Track A,
  pops-tune `^5`) are inert. Function_score boosts (B2) are the only structure that lifts a scholar
  whose pub text already matches.

---

## Key files & docs

| path | what |
|---|---|
| `lib/api/search.ts` | `searchPeople` (B2 boost ~`prominenceFunctions`), `getConceptScholarConcentration` (:1121, concept n²/total), `buildAreaBoostFunctions` (:1072) |
| `lib/api/search-flags.ts` | `resolveSearchPeopleClinicalFn` / `…FnWeight` (B2), `resolveSearchPeopleClinical` (inert text variant) |
| `lib/api/topics.ts` | `getAreaScholarConcentration` (curated path, topicImpact²/totalImpact) |
| `lib/api/search-taxonomy.ts` | `resolveMeshDescriptor` / `getMeshMap` (the meshMapped gap) |
| `cdk/lib/app-stack.ts` | `SEARCH_PEOPLE_CLINICAL_FN` (:~1447), `SEARCH_PEOPLE_CLINICAL` |
| `scripts/search-eval/` | archetype gold-set harness (per-archetype scorecard) |
| `scripts/run-staging-probe.sh` | the in-VPC read-only probe runner |
| `docs/search-trackA-clinical-inert-finding.md` | Track A inert (the redirect) |
| `docs/search-trackB-prebuild-diagnostic.md` | B1 premise refuted |
| `docs/search-mason-attribution-and-rescope-finding.md` | Mason data bug + re-scope |
| `docs/search-meshmapped-layterm-gap-finding.md` | Finding C (#1258) |
| `docs/search-trackB-authorship-expertise-plan.md` | original Track B plan (B2 survived; B1/B3 dropped) |

---

## Recommended next action

Confirm CI green on #1372, then **B (staging A/B for B2)** — it's the validation gate before B2 can
roll to prod, and it's the natural close on the one ranking lever the investigation produced. In
parallel, **C (route the Mason attribution bug)** is cheap and high real-world impact. Everything
else (D gold labels, E #1258) is independent cleanup.
