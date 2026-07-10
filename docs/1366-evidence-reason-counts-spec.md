# Spec — #1366: counted, stacked evidence reason lines on People cards

**Issue:** #1366 · **Date:** 2026-06-30 · **Status:** SIGNED-OFF model, ready to build
**Supersedes scope of:** `docs/1366-evidence-row-counts-handoff.md` (counts only). Adds line **stacking** + exemplar **de-dup**.
**Follow-up (deferred):** #1367 — clinical MeSH-mapped count + subspecialty/expertise-type ETL.
**Flag:** `SEARCH_EVIDENCE_REASON_COUNTS` (staging-on / prod-off). Off ⇒ today's single-line, label-only behavior.

## Goal

Every People-card reason line says *how much* evidence backs the match (`N of M publications`), and the first-class match kinds (method, concept, research-area) **stack** instead of one suppressing the others.

## 1. Evidence model — three first-class lines + a fallback

Today `hit.evidence` is a **single** `ResultEvidence` chosen by priority (method > topic > concept) — research-area is effectively a fallback and never co-shows with concept. Change: **method, concept, and research-area are each first-class**, shown (and counted) whenever they match, stacked in this order. Keyword is the catch-all when none of the three match. Clinical is an independent label-only line.

Per-scholar predicates (page-scoped, already computed):
- **M** = method match (`methodReasonByCwid.has(cwid)`)
- **C** = tagged-concept match (`reasonCounts.tagged > 0` AND a resolved descriptor name)
- **A** = research-area match (matched topic slug ∩ `areasOfInterest`)
- **K** = keyword/mention (`reasonCounts.mention > 0`) · **CL** = clinical exact match

```
FIRST-CLASS (each shown when it matches, stacked, counted):
  1. method        ⚙  Anti-obesity pharmacotherapy · 7 of 41 publications
  2. concept       #  5 of 41 publications tagged Obesity
  3. research area ▣  Endocrinology · 12 of 41 publications

FALLBACK (only when NOT M and NOT C and NOT A):
  4. keyword       "  3 of 41 publications mention "glp-1"

INDEPENDENT (when CL — label-only, no count, #1367):
     clinical      ✚  Board certified in Endocrinology   (or "Clinical specialty: …")
```

- Lines shown = `[method if M] + [concept if C] + [area if A]`; if none of M/C/A then `[keyword if K]`; plus `[clinical if CL]`.
- The comma-separated **areas context row** (`HumanizedAreas`) still renders below, as today.
- `hit.evidence` becomes an **ordered list** of evidence lines (was a single value). Render maps over it.

## 2. Counts — `N of M publications`

M (denominator) = scholar total pub count (`pubCount`, on the hit). N clamps to M (`Math.min(n, pubCount)`).

| line | N | source | query cost |
|---|---|---|---|
| method | distinct pubs in matched family | `ScholarFamily.pmidCount`, precomputed onto people doc as `methodFamilyCounts{label→count}` | 0 (reindex) |
| concept | distinct tagged pubs | `reasonCounts.tagged` (exists) | 0 |
| research area | distinct on-topic pubs | extend the page-wide `pageCwids` agg with a topic-id filter + `cardinality(pmid)` sub-agg | 0 extra (same round-trip) |
| keyword | distinct mentioning pubs | `reasonCounts.mention` (exists) | 0 |
| clinical | — none — label-only (#1367) | — | — |

**Count overlap across lines is allowed** (a pub may count toward method, concept, and area).

## 3. Exemplar de-dup (the one hard constraint)

Counts may overlap; **representative papers must be globally disjoint** across the method / concept / area disclosures.

- Concept reps are **eager** (`reasonReps`, server-side, ≤3). Method + area exemplars are **lazy**, both via the shared route `GET /api/scholar/[cwid]/method-exemplar?family=…` / `?topic=…`.
- Mechanism — a per-card **claimed-pmid set**, seeded with the concept rep pmids (always reserved, even if that disclosure is collapsed). Each lazy exemplar fetch sends `&exclude=<claimed>` and adds its returned pmids to `claimed`.
- Result: disjoint **regardless of expand order** (whoever expands first owns a shared pmid; the user's constraint is "no redundancy," not a fixed owner). Counts unchanged.
- Route change: the shared exemplar route accepts an `exclude` pmid list and filters before taking its top-N.

## 4. Render

`components/search/result-evidence.tsx` + `components/search/people-result-card.tsx`:
- `evidence` is now a list → render each as a `MatchAwareReason`, passing `prefix={`${n} of ${m} publications`}` (the `prefix` slot exists, #1361). Clinical line passes no prefix.
- Seed the claimed-pmid set from the concept reps; pass `&exclude=` on each lazy exemplar fetch.

## 5. Data / ETL

`lib/search-index-docs.ts` `buildPeopleDoc` — in the **existing** `famRows` loop (gated visible families), add `pmidCount` to the `select` and emit `methodFamilyCounts: { [familyLabel]: pmidCount }` (omit-on-empty, like `methodFamily`). **Requires a people reindex** (`npm run search:index -- --people-only`) on staging; a not-yet-reindexed doc shows no method count (graceful, never a 500).

## 6. Flag + infra

- `lib/api/search-flags.ts` — add `SEARCH_EVIDENCE_REASON_COUNTS` (default off). Off ⇒ single-line, label-only, no stacking, no counts (byte-identical to today).
- `cdk/lib/app-stack.ts` — wire per-env (staging on, prod off); regen snapshot (`cd cdk && npm ci && npm test -- -u`, commit only the `.snap`).

## 7. Tests (vitest)

| case | assert |
|---|---|
| M & C & A | three lines, in order; each counted from its source; exemplar pmids disjoint across all three |
| M & C | two lines; method + concept counted; exemplars disjoint |
| M only / C only / A only | one corresponding counted line |
| none of M/C/A, K | keyword fallback line, counted |
| CL | clinical label-only line, no count; board-cert vs specialty label correct |
| flag off | single line, no count, no stacking — today's behavior / snapshot unchanged |

Extend: `tests/unit/result-evidence-card.test.tsx`, `tests/unit/people-result-card-funding.test.tsx`, the page-search reason-count test.

## 8. Verify (before push)

- Full `npx vitest run --maxWorkers=4` (NOT targeted), `npm run typecheck`, `eslint` touched files.
- **`osRoundTrips` unchanged** pre/post (the D3 SLI) for a representative query set — the gate.
- Latency p50/p95 unchanged: `HOST=https://scholars-staging.weill.cornell.edu scripts/search-eval/eval.sh` pre/post.
- cdk snapshot regenerated.

## Key files (re-grounded vs origin/master)

- `lib/api/search.ts` — `resolveHitEvidence` (~2925; emit the ordered list), `reasonCounts`/`reasonReps`/page agg (~2606–2825), `evidence` union (~290–305).
- `lib/search-index-docs.ts` — `buildPeopleDoc` famRows loop (~1106), emit `methodFamilyCounts`.
- `components/search/result-evidence.tsx`, `components/search/people-result-card.tsx` — list render + claimed-set/`exclude`.
- `app/api/scholar/[cwid]/method-exemplar/route.ts` — accept `exclude` pmids.
- `lib/api/search-flags.ts`, `cdk/lib/app-stack.ts` — flag.
