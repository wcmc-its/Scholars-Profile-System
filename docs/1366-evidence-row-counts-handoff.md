# Handoff — #1366: count every People-card evidence reason line (no per-card fan-out)

**Issue:** #1366 · **Date:** 2026-06-29 · **Status:** not started (spec + this handoff only)

## What this is

The People search result card shows a one-line "reason" per scholar (why they matched), with an optional disclosure (KEY PAPERS / KEY FUNDING). Two evidence kinds already show a count on the reason line — **Publications** ("N of M publications mention 'q'") and **Funding** ("N of M grants tagged/mention", shipped in #1364). The rest are **label-only**:

| kind | reason line today | target |
|---|---|---|
| `method` | `Anti-obesity pharmacotherapy` | `Anti-obesity pharmacotherapy · N publications` |
| `topic` / `area` | `<research area>` | `<area> · N publications` |
| `clinical` | `<label>` | `<label> · N <unit>` (unit = open question) |
| `concept` | concept label | `N publications tagged <Concept>` |

Goal: every reason line tells the user *how much* evidence backs the match, uniformly.

## Already shipped (don't redo)

- **#1364** — 2b funding concept matching + reason split, **and Option A**: the KEY PAPERS / KEY FUNDING **disclosure headers** now show "3 of 8" (truncated) / bare total. Disclosure-header counts are DONE. This issue is the **reason lines** only.
- Publications + Funding reason-line counts: DONE.

## The hard constraint (this is the whole point of the issue)

**No performance regression — specifically, no new per-card OpenSearch round-trips.**

Why it's a real trap: the method/topic **representative papers** are fetched lazily, per-card, on expand (`GET /api/scholar/[cwid]/method-exemplar`) *exactly* to avoid N round-trips per search page. The naïve way to get a method count is to call that route (or `searchFunding`-style per card) up front — that's one extra OpenSearch hit × every result on the page. **Do not do that.**

### Perf gate (acceptance — both blocking)
1. **`osRoundTrips` must not increase.** It's a request-scoped OpenSearch round-trip counter (`lib/api/os-round-trips.ts`, `getOsRoundTripCount()`), logged on every `search_query` line in `app/api/search/route.ts` (the D3 SLI). Capture it for a representative query set before/after — same number.
2. **Latency p50/p95 unchanged** on staging via the existing harness: `scripts/search-eval/` (`HOST=https://scholars-staging.weill.cornell.edu ./eval.sh`). Run pre/post.

## The mechanism to extend (NOT reinvent)

The People search already computes per-scholar pub counts for the **whole page in one shot** — this is how the Publications count works with zero per-card cost. Two existing patterns, in order of preference:

### Pattern 1 (BEST — zero round-trips): precompute on the scholar doc, O(1) lookup
`_source.meshSubtreeCounts` is **indexed on the scholar doc** at ETL time; the tagged pub count is read via `taggedCountFromDoc(_source.meshSubtreeCounts, resolvedConceptUi)` — an **O(1) map lookup, no query**. (See `lib/api/search.ts`, the `reasonCounts` block ~`search.ts:2606`, and `meshSubtreeCounts` in `etl/search-index` / `lib/search-index-docs.ts`.)

→ The analogous move for method/area: at index time, compute and store per-scholar **`methodFamilyCounts`** and **`areaCounts`** maps on the scholar doc (key = family/area id, value = distinct on-topic pmid count). Then the reason-line count is the same O(1) `_source` lookup — **provably zero query-time round-trips**. This is the recommended approach; it mirrors `meshSubtreeCounts` exactly.

### Pattern 2 (acceptable if precompute is infeasible): one page-wide aggregation
The `reasonCounts` Map is built from a **single** publications-index aggregation over `pageCwids` (the page's scholars), using `cardinality(pmid)` sub-aggs (`search.ts` ~2606–2700). Extend that ONE aggregation with method-family / area filter+cardinality sub-aggs so the counts come back in the **same** request. Still one round-trip for the page — but verify it doesn't tip `osRoundTrips` or latency (an extra agg on an existing query is usually free; a second query is not).

### NEVER
- Per-card `/method-exemplar` or `/grants`-style fetch for the count. That's the regression the issue exists to prevent.

## Render side (cheap — the count slot already exists)

`MatchAwareReason` (`components/search/match-reason.tsx`) already takes a **`prefix`** prop (normal-weight count text before the semibold label) — that's how Funding renders "N of M grants". Today the method/topic reason lines render it with **no prefix**:

```tsx
// components/search/people-result-card.tsx — snippetLine
reason.kind === "method" ? <MatchAwareReason kind="method" label={reason.family} />
                         : <MatchAwareReason kind="topic"  label={reason.label} />
```
(There's a parallel render in `components/search/result-evidence.tsx` for the `ResultEvidence` path — update both, or whichever the live reason path uses; confirm with a staging snapshot.)

→ Add `prefix={`${n} publications`}` (or `${n} of ${m}`) once the count is on the hit / in `reasonCounts`. No new component, no new prop. The count must be available **at first render** (not on expand), which is why it has to ride the hit / page-wide agg, not the lazy exemplar.

## Recommended plan

1. **Decide count semantics per type** (see open questions). Lean: method/area = distinct on-topic pub count, bare "N publications" (no "of M"); concept = reuse `reasonCounts.tagged`.
2. **Data**: precompute `methodFamilyCounts` + `areaCounts` on the scholar doc (Pattern 1) in `etl/search-index` + `lib/search-index-docs.ts`, mirroring `meshSubtreeCounts`. Reindex (`npm run search:index` / `--people-only`).
3. **Wire**: surface the per-scholar count on the hit's reason object (where `reasonCounts` / the method/topic reason is assembled in `lib/api/search.ts`), and pass it as `prefix` in the two `MatchAwareReason` call sites.
4. **Concept**: likely just surface `reasonCounts.tagged` on the concept reason line — may need no new data.
5. **Clinical**: blocked on the product decision (unit). Can ship method/area/concept first and leave clinical for a follow-up.
6. **Flag**: counts widen the reason line (no recall change), so a flag is optional — but if you want a clean A/B, a presentation flag (`SEARCH_EVIDENCE_REASON_COUNTS`, default off → wire in `lib/api/search-flags.ts` + `cdk/lib/app-stack.ts` per-env + regen the cdk snapshot, see below). If it's purely additive and low-risk, ship unflagged.

## Verification checklist (before push)

- [ ] **Full** vitest (`npx vitest run --maxWorkers=4`) — NOT a targeted run (CI runs all ~6.3k; targeted runs have missed cross-file regressions here).
- [ ] `npm run typecheck`, `npx eslint <touched files>`.
- [ ] **`osRoundTrips` unchanged**: log/inspect the D3 SLI for a query set pre/post (the gate).
- [ ] Latency unchanged: `scripts/search-eval/eval.sh` against staging, pre/post.
- [ ] If a new flag: `cd cdk && npm ci && npm test -- -u` and commit only the `.snap` (the app-stack snapshot fails the `cdk` gate otherwise; worktree-root `npm ci` skips cdk's separate lockfile).
- [ ] Tests to extend: `tests/unit/result-evidence-card.test.tsx` (reason-line render), `tests/unit/people-result-card-funding.test.tsx` (card render), the people-search test that asserts `reasonCounts` (search `tests/unit/*reason*` / `*concept*`).

## Open product questions (resolve before wiring)

- **Clinical** count unit — clinical-trial count? on-topic pubs? Needs a decision; gates that type only.
- **Denominator** — "N of M" (M = scholar total) like Publications/Funding, or bare "N publications"? Lean bare-N for method/area unless an M reads naturally.
- **Concept** — confirm `reasonCounts.tagged` already supplies it (then it's render-only, no data work).

## Key files

- `lib/api/search.ts` — `reasonCounts` Map + the page-wide pub agg (~2606); `taggedCountFromDoc` doc-sourced fast path.
- `lib/search-index-docs.ts` + `etl/search-index/` — where `meshSubtreeCounts` is built; add `methodFamilyCounts`/`areaCounts` here (Pattern 1).
- `components/search/match-reason.tsx` — `MatchAwareReason` (`prefix` prop is the count slot); `RepresentativePapers` / `KeyFunding` (headers — already counted, #1364).
- `components/search/people-result-card.tsx` + `components/search/result-evidence.tsx` — the reason-line render call sites.
- `app/api/search/route.ts` + `lib/api/os-round-trips.ts` — the `osRoundTrips` perf gate.
- `scripts/search-eval/` — latency harness.

## Context links

- #1364 (merged) — 2b + Option A (disclosure-header counts).
- #1359 — Tier 2 parent (remaining: staging A/B + prod flag flip).
- #1361 — the reason-line emphasis/prefix pattern this inherits.
