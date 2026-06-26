# Handoff — SPS prestige consumer (badge + sort + guarded axis)

**Date:** 2026-06-26. **Status:** producer DONE upstream; SPS consumer NOT started.
**Implements:** `funding-opportunity-prestige-spec.md` §4 (validation-corrected).
**Companion already shipped (SPS):** `feat/mesh-flat-fill` (MeSH flat-fill) — independent of this.

---

## 0. What's already done (upstream, ReciterAI)

Branch `feat/prestige-producer` (ReciterAI):
- `build_grant_item` now emits two attrs on every `GRANT#` item:
  - `prestige` (Map): `{score, mechanism_tier, size_bucket|null, sponsor_tier:null, selectivity:null, label, rationale}`. `score`∈[0,1]; `label`∈{Flagship,Major,Standard}. v1 blend = mechanism_tier + size_bucket only (sponsor/selectivity deferred → null, renormalized).
  - `is_honorific` (BOOL): nomination-based recognition (prize/medal/lectureship, or a recognition "Award" with no NIH activity code).
- `backfill_prestige.py` populates existing items without a re-score (`--apply`, STAGING first).

**SPS sees nothing until the steps below land** — there is no `prestige`/`is_honorific` column, mapper, or read path yet.

---

## 1. DO FIRST — the honorific safety gate (validation RISK-HIGH ×2)

The reverse RD view `components/.../find-researchers.tsx` lists opportunities **without calling the matcher** (`matchOpportunitiesForScholar`), so it inherits NO honorific filter. The curated corpus *is* the prize set and prestige scores it HIGH — a prestige sort there would float Gruber/Crafoord/NAS-medal/lectureship prizes straight to the top. #1296 (the title-regex exclusion) is unmerged + forward-matcher-only.

**Gate:** in any prestige-ordered list (forward or reverse), exclude/deprioritize `is_honorific === true`. Wire it at the data read so EVERY surface inherits it — not per-view. Do not ship the badge or the sort until this filter is in place and tested on the reverse view.

---

## 2. Plumbing (mirror the existing `meshDescriptorUi` passthrough exactly)

1. **Prisma schema** (`prisma/schema.prisma`, `Opportunity` model ~:407, beside `meshDescriptorUi`):
   ```prisma
   prestige     Json?    @map("prestige")
   isHonorific  Boolean? @map("is_honorific")
   ```
   Generate a migration; nullable, no backfill (rows fill on next reproject).
2. **DDB→Prisma mapper** (`etl/dynamodb/grant-opportunity-mapper.ts` — input type ~:43, coerce ~:181/:207-209): pass `prestige` through as `Prisma.InputJsonValue`/`Prisma.JsonNull` (same shape as `mesh_descriptor_ui`); map `is_honorific` BOOL → `isHonorific`.
3. **ETL upsert** (`etl/dynamodb/grant-opportunity-etl.ts` ~:97): add `prestige`, `isHonorific` to the write (passthrough).
4. **Index row + doc** (`lib/search.ts` — `OpportunityIndexRow` ~:965, `buildOpportunityDoc` ~:979-1010): carry `prestige` (object) + `isHonorific` (bool) onto the OpenSearch opportunity doc.
5. **Index select** (`etl/search-index/index.ts` `indexOpportunities` findMany ~:563-580): add `prestige: true, isHonorific: true`.

## 3. Matcher (`lib/api/match-opportunities.ts`)

⚠️ This file is ALSO edited by the MeSH spec (mesh→meshTerm+meshDisease). Coordinate / sequence so the two don't collide on `MatchAxes`/`DEFAULT_WEIGHTS`/`combineScore`.

- `OpportunityCandidate` (~:93): add `prestige?: { score: number; ... }`, `isHonorific?: boolean`; read from the doc (~:301).
- `MatchAxes` (~:21-31): add `prestige: number` (= `candidate.prestige?.score ?? 0`).
- `DEFAULT_WEIGHTS` (~:28-31): add `prestige: 0` (launch weight 0 — badge+sort only).
- `combineScore` (~:74-79): add `weights.prestige * axes.prestige * axes.topicAffinity` — **multiply by topicAffinity** (continuous gate, like the `stage` term), NOT a hard `TOPIC_FLOOR` (corrected spec §4.2 — the floor was a discontinuity + collided with `RankOptions.topicFloor`).
- Sort: add a `prestige` key to the existing `SORT_KEY`/`RankSort` map (~:133).

## 4. UI (`components/edit/grant-recs-card.tsx`)

- **Badge:** render `prestige.label` + mechanism + formatted ceiling (e.g. "Flagship · R01 · up to $500k/yr"); tooltip = `prestige.rationale`. Surface the prestige AXIS bar, not internal per-topic scores ([[project_topic_score_is_internal]]).
- **Sort toggle:** "Best fit ⇄ Prestige" segmented control. ⚠️ The grant-recs sort is **server-side** (`?sort=&limit=25`, `useEffect([cwid, sort])`) — the spec's "client-side, no refetch" claim is WRONG (corrected §4.4). Lazy path: add a `prestige` value to the `sort` param so it re-queries top-25-by-prestige. Default **Best fit**.
- Per §5: lead with the prestige sort in the RD `find-researchers` view; keep it badge-only (or quieter) in the scholar "Grants for me" view.

## 5. Flag + smoke

- **CDK** (`cdk/lib/app-stack.ts`): per-env flag for the prestige axis weight (default 0 = badge+sort only); regenerate the app-stack snapshot (flag-parity rule). Badge + sort can ship on; only the *axis weight* is gated.
- **Smoke** (`etl/search-index/index.ts`): extend `assertOpportunitiesIndexHealth` (added on `feat/mesh-flat-fill`) to also soft-warn on `prestige.score` coverage.

## 6. Open decisions (validation §7 recommendations — confirm)

1. Stage-relative prestige? **No** — stage-agnostic; the `stage` axis already handles stage-fit.
2. `weights.prestige` launch default **0** (badge+sort only); raise only after Track-A shows no actionable-precision loss. Rename the gate to avoid colliding with `RankOptions.topicFloor`.
3. `label` thresholds (≥0.8 Flagship / ≥0.55 Major) — provisional; derive final cuts from the corpus histogram.
4. `sponsor_tier` table — ReciterAI-owned `config/sponsor_tiers.json` when built (deferred in producer v1).
5. Prestige-sort leads in RD `find-researchers`, badge-only in scholar view.
6. Selectivity — ship null (no source).

## 7. Sequence & verify

1. Land §2 plumbing + §1 honorific gate.
2. ReciterAI: `python -m pipeline_grants.backfill_prestige --apply` (STAGING) → SPS `etl:dynamodb` reproject → `search:index:opportunities` reindex.
3. Verify: opp docs carry `prestige`; reverse view with prestige sort does NOT surface `is_honorific` prizes; badge renders.
4. Add the matcher axis (weight 0) + sort toggle; flip the weight only after Track-A eval.

**Tests:** mirror `tests/unit/match-opportunities.test.ts` (axis weight + sort), `grant-opportunity-mapper.test.ts` (passthrough), `opportunity-index-doc.test.ts` (doc carries prestige). Runner: `npx vitest run`. Worktree note: a fresh worktree needs `node_modules` + `lib/generated` symlinked from the canonical checkout.
