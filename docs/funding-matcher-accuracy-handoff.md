# Funding matcher accuracy — handoff & next steps

Last updated: 2026-06-26. Companion to `docs/funding-matcher-accuracy.md` (levers +
eval design + pilot results §3.5). This doc is the operational "what to do next."

---

## 1. Status snapshot

| PR | What | State |
|---|---|---|
| **#1292** | Superuser QA lens — unhide the "Grants for me" tab for superuser regardless of `SELF_EDIT_GRANT_RECS` (still off for users) | **MERGED** (`6d62a868`) |
| **#1294** | This doc + the accuracy roadmap | OPEN |
| **#1295** | Recency + authorship weighting in `scholarTopicVector` | OPEN, CI green |
| **#1296** | Exclude honorific prizes (`isHonorificAward`) from the forward matcher (§2.9) | OPEN, CI green |

**Nothing is live to scholars.** The forward "Grants for me" matcher is
**superuser-only** (the `SELF_EDIT_GRANT_RECS` flag is `"off"` in both envs —
`cdk/lib/app-stack.ts`). #1295/#1296 change the matcher, so once they merge +
deploy they affect the **superuser QA lens only**, not users.

---

## 2. Immediate next steps (in order)

### Step 1 — Review + merge the three open PRs
- #1294 (doc), #1295 (vector weighting), #1296 (prize filter). All independent;
  merge order is free. #1295 and #1296 both touch `lib/api/match-opportunities.ts`
  in **different regions** and both append to the same import block in
  `tests/unit/match-opportunities.test.ts` — expect a **one-line import-list
  rebase** on whichever merges second (trivial).

### Step 2 — Deploy to staging, then re-run the eval to MEASURE the lift
The pilot (§3.5) was on the *pre-change* matcher. To measure the actual
improvement you must deploy, because the prize filter changes which deeper grants
surface (can't be simulated locally):
1. Merge #1295 + #1296 → `cdk deploy Sps-App-staging` (or the CD image roll).
2. Re-run the Track-A eval (see §4). Compare precision@N, the award %, and the
   facet-failure histogram against the §3.5 baseline.
- **Expectation:** award pollution (63% → ~0%); precision should approach the
  actionable-grant precision the pilot already measured (**~78%**).

### Step 3 — §2.2 the dead MeSH axis (DECISION NEEDED)
`meshOverlap = 0` on **100%** of pilot pairs — the 0.25-weighted axis does nothing.
Investigate which side is empty:
- Scholar side: `publicationMeshUi` on the `scholars-people` OpenSearch index
  (read in `matchOpportunitiesForScholar`, ~line 251).
- Opportunity side: `meshDescriptorUi` on the `Opportunity` row / opportunities index.

Then **decide**:
- **(a) Drop it** — remove the 0.25 weight (reallocate to topic), simplest, if MeSH
  won't be populated soon. Pure change to `DEFAULT_WEIGHTS`.
- **(b) Populate + upgrade** — fill MeSH on both sides (upstream/ETL), then implement
  **MeSH tree-aware overlap** (§2.2) so parent/child terms partially match. Bigger,
  unlocks §2.3.

### Step 4 — §2.3 disease-facet alignment (depends on Step 3b)
Top failure **among real grants** (disease mismatch 6/18). Bucket MeSH by tree
category (C=disease, E=method, M=population…) and require/boost disease-facet
overlap. **Prerequisite: MeSH must be populated (Step 3b).** Also the most useful
"why is this rec weak" signal to surface in the QA tab.

### Step 5 — §3.2 Track-B grant backtest (bigger, separate)
Use recently-awarded grants as ground truth. Requires **indexing grants** into the
same topic/MeSH/facet shape as opportunities (grants are in reciterdb via
`scholar.grants` but have no topic representation). See §3.2/§3.3 in the roadmap
for the build + the bias caveats (selection bias, temporal leakage, corpus
coverage).

---

## 3. Open decisions

1. **MeSH axis: drop vs populate** (Step 3) — needs a product call on whether MeSH
   is worth populating or the weight should just be removed.
2. **Prize filter: heuristic vs typed field** — #1296 uses a title heuristic with a
   known ceiling (a real grant titled "…Award" with no activity code is dropped).
   The durable fix is an upstream `opportunityType`/`isAward` from the ReciterAI
   ingest (engine, out of this repo). Decide whether to invest upstream.
3. **IDF lever (§2.1)** — deferred; needs a *cached* corpus document-frequency map
   (a per-request full-table scan is wrong). Worth it only if topic over-breadth
   shows up after the corpus is de-polluted.
4. **Roll out to scholars** — independent of all the above: flip
   `SELF_EDIT_GRANT_RECS` on once the recs are judged good enough. Until then this
   is all QA-lens-only.

---

## 4. How to re-run the Track-A eval (reproducible)

The eval ran entirely against **staging public routes** (no SSO, reachable from a
laptop). The scratchpad artifacts are session-local and will be gone — the
*method* is what matters:

**Reachable public routes (no SSO):**
- `GET /api/search?q=<term>` → `hits[]` with `cwid, primaryTitle, primaryDepartment,
  humanizedAreas, roleCategory` — the **sample-cwid source**.
- `GET /api/scholars/[cwid]/opportunities?limit=N` → ranked recs with `axes` +
  `defaultScore` + `opportunityId`.
- `GET /api/opportunities/[id]` → `synopsis`, `source`, `mechanism`, etc.
- `GET /api/scholars/[cwid]` → `overview`, title, dept (scholar context for judge).

**Gated / unusable anonymously:** `/api/opportunities` (browse, 403),
`/api/directory/people` (SSO LDAP).

**Pipeline:**
1. Pull a sample of cwids from `/api/search` across several broad terms (cancer,
   cardiology, informatics, …), dedup. **For v2: stratify by career stage** — the
   search seeds *senior* faculty, so the pilot had no early-career scholars and the
   stage-fit signal was unreliable. Pull early-career via `roleCategory` or a
   different query.
3. For each cwid: fetch context (`/api/scholars/[cwid]`) + top-N recs
   (`/api/scholars/[cwid]/opportunities`) + each opp's synopsis. Write one JSON file
   per (scholar, opp) pair so the judge agents `Read` them (keep the heavy text out
   of the Workflow args).
4. Run a Workflow: one LLM judge (`model: 'sonnet'`) per pair, **blind to the
   matcher score**, returning a structured verdict (relevance 0–3 + per-facet
   match/mismatch + isAwardNotGrant). Aggregate precision@N + facet-failure
   histogram in pure JS.

**Gotchas (cost me time — don't repeat):**
- The Workflow **`args` channel arrived `undefined` at runtime** for a ~10KB
  payload. Fix: **embed the data as a `const` in the script** (generate the script
  with Python injecting the JSON), not via `args`.
- **Blind the judge to the matcher score** — otherwise it anchors on the system's
  confidence.
- **Headline precision@N lies** when the corpus is polluted (prizes rated
  "topically plausible"). Always also report **actionable-grant-only** precision and
  the award %.

**v2 improvements:** add the adversarial/second-judge pass (§3.1.2) so disagreements
route to a human queue; stratified stage-diverse sample; larger N; deeper top-N.

---

## 5. Key architecture facts (for whoever picks this up)

- Forward matcher: `matchOpportunitiesForScholar(cwid)` in
  `lib/api/match-opportunities.ts`. Two-stage: OpenSearch candidate retrieval
  (hard filters: status, `us_eligible`, stage flag) → app-side `rankCandidates`
  over distinct axes. Score = `combineScore` = `1.0·topic + 0.5·stage·topic +
  0.25·mesh + 0.1·deadline`.
- Scholar topic vector: `scholarTopicVector` — L2-normalized sum of
  `publication_topic.score`, year ≥ 2020. (#1295 adds recency + authorship
  weighting.)
- Reverse matcher (find-researchers): `rankResearchers` /
  `rankResearchersForOpportunity` — already first/last-author gated.
- Corpus: `Opportunity` model. `source ∈ {grants_gov (real NOFOs, carry NIH
  activity codes), wcm_curated (currently ALL honorific prizes)}`. No upstream
  `opportunityType`. `mechanism` is null for forecasted; `isResearch` true for all;
  prizes carry `estimatedFunding` (prize money) so $ doesn't discriminate.
- QA surface: superuser → `/edit/scholar/<cwid>?attr=grant-recs` (the "Grants for
  me" tab, rendered by `components/edit/grant-recs-card.tsx`).
