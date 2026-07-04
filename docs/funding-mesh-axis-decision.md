# Decision memo — Step 3: the dead MeSH axis (`meshOverlap`)

**Verdict (line 1):** The failure mode is **EMPTY SIDE, not exact-match miss** — `meshOverlap` is structurally 0 on 100% of scholar×opportunity pairs because the **opportunity** side (`opportunity.mesh_descriptor_ui`) is systematically empty, while the scholar side is corpus-wide alive and CI-guarded.

**Verdict (line 2):** ✅ **MEASURED on staging (2026-06-26)** — a per-source `JSON_TYPE` probe of the `opportunity` table: **0 / 831** opportunities carry a MeSH descriptor array. Every row's `mesh_descriptor_ui` is JSON-`null` (`grants_gov` 634/634 null, `wcm_curated` 197/197 null; `JSON_TYPE='ARRAY'` count = 0). The opp side is empty in fact, not just by inference. ⚠️ A naïve `IS NOT NULL AND JSON_LENGTH > 0` filter *lies* here — `Prisma.JsonNull` stores a JSON scalar `null`, which passes `IS NOT NULL` and has `JSON_LENGTH` = 1; the only correct test is `JSON_TYPE(mesh_descriptor_ui) = 'ARRAY'`.

---

## 1. Why "empty side", not "exact-match miss"

| Side | State | Evidence |
|---|---|---|
| **Scholar** (`publicationMeshUi`) | **Alive, corpus-wide, CI-guarded** | Writer `lib/search-index-docs.ts:861-865` (min-evidence gate), omit-on-empty at `:1166`. HARD smoke `etl/search-index/index.ts:431-440` throws if zero people docs carry `D001943` (Breast Neoplasms); invoked from `assertPeopleIndexHealth` (`:663`). |
| **Opportunity** (`meshDescriptorUi`) | **EMPTY — 0/831 carry an array; all JSON-null (measured 2026-06-26)** | Pure passthrough of ReciterAI's emitted `mesh_descriptor_ui` (`etl/dynamodb/grant-opportunity-mapper.ts:43,181,207-209` → `Prisma.JsonNull` when absent) → upsert `grant-opportunity-etl.ts:97` → schema `prisma/schema.prisma:407` (nullable) → reindex `etl/search-index/index.ts:577` (**no opportunities-index health smoke** — only people/pubs/funding at `:663-665`) → projection `lib/search.ts:1002` (`null → []`). |

Because `meshOverlap` (`lib/api/match-opportunities.ts:51-59`) returns 0 whenever **either** set is empty, an empty opp side forces the axis to 0 on every pair regardless of the scholar side. The scholar side being provably alive + the absence of any opp-side health gate is exactly the asymmetry the pilot saw (`funding-matcher-accuracy.md:245`, "meshOverlap=0 on 100%"). A populated-but-disjoint (parent/child) mismatch is **ruled out** by the same asymmetry — there is nothing on the opp side to be disjoint *from*.

> No SPS code derives opp MeSH from synopsis/title/topicVector. The only live path that fills `opportunity.mesh_descriptor_ui` is the verbatim copy of ReciterAI's field. If ReciterAI omits it, every downstream step yields `[]`.

---

## 2. The two options (as the handoff frames them — `funding-matcher-accuracy-handoff.md:43-55`)

### Option (a) — DROP the 0.25 mesh weight, reallocate to topic

Pure change to `DEFAULT_WEIGHTS` (`lib/api/match-opportunities.ts:31`). `combineScore` keeps the inert `weights.mesh * axes.meshOverlap` term (now multiplied by 0); no algorithm change. **Do NOT apply — shown for the decision only.**

```diff
--- a/lib/api/match-opportunities.ts
+++ b/lib/api/match-opportunities.ts
@@ export const DEFAULT_WEIGHTS
-export const DEFAULT_WEIGHTS: MatchWeights = { topic: 1.0, stage: 0.5, mesh: 0.25, deadline: 0.1 };
+export const DEFAULT_WEIGHTS: MatchWeights = { topic: 1.25, stage: 0.5, mesh: 0, deadline: 0.1 };
```

- **Ranking effect today: ZERO.** Since `meshOverlap` is already 0 on every pair, the `0.25·mesh` term contributes nothing now; dropping it changes no current ordering. Reallocating +0.25 into `topic` is the only behavioral change and it sharpens the axis that actually fires.
- **Tests to update:** `tests/unit/match-opportunities.test.ts` references `DEFAULT_WEIGHTS` / `combineScore` and asserts mesh-weight behavior (`:62-66` "custom weights change the blend"; `:132-141` "mesh-heavy promotes b"). Those use explicit `{ ...DEFAULT_WEIGHTS, mesh: N }` overrides, so they survive a default of `mesh: 0`, but the expected `defaultScore` numbers in any test that blends with the old `topic: 1.0` would shift and need re-baselining. Re-run the suite (`--maxWorkers=4`) and update fixtures accordingly.

### Option (b) — POPULATE + upgrade to §2.2 tree-aware overlap

- **MOOT / blocked while the opp side is empty.** Folding `[]` up the MeSH tree still yields `[]`; a tree-aware `meshOverlap` is still 0 on every pair. Tree-aware work (replace exact-set Jaccard with ancestor-folded, tree-distance-weighted overlap; infra already in-repo: `lib/mesh-tree-ancestors.ts`, no new data) is strictly a **step-3b** activity that only pays off *after* the opp side is filled.
- **Real prerequisite = upstream.** The opp side is 100% ReciterAI-dependent passthrough. The blocking dependency is **ReciterAI emitting `mesh_descriptor_ui` per opportunity** (`grantrecs-reciterai-opportunity-handoff.md`), which today is tagged `[upstream, ReciterAI]` with only "audit how generated" — no PR, no confirmed emit (`funding-matcher-accuracy.md:103-106`).
- **Even if populated, the flat 0.25 axis is the wrong target.** §2.3's faceted / disease-weighted overlap supersedes the flat Jaccard term, so any future MeSH-derivation investment should feed §2.3, not revive the flat `meshOverlap`.
- SPS *could* self-populate opp MeSH in-repo (one-time lookup over the ~237-opp `topicVector`, reusing #1258 anchors + `lib/mesh-tree-ancestors`) but that is **new code that does not exist today**.

---

## 3. Recommendation — PRODUCT DECISION REQUIRED (open decision §3.1)

**Lean: DROP now (option a)** — keeping a 0.25 weight on an axis that is 0 on 100% of pairs is dead, misleading weight with zero current ranking value, and the cheaper higher-precision levers (§2.9 honorific-award exclusion — 63% of *all* recs are honorific prizes; 76% of the *bad* recs are prizes — in flight as #1296; then §2.3 disease facet) are explicitly prioritized ahead of any MeSH revival.

This is **not mine to land.** Drop-vs-invest-upstream is an **open product decision (handoff §3.1)**. The empirical opp-coverage count is now **measured: 0/831** (all JSON-null). Before committing option (a):
1. ~~Re-run the staging coverage query~~ **DONE (2026-06-26)** — measured 0/831 opportunities carry a MeSH array (`JSON_TYPE='ARRAY'` count = 0; the rest are JSON-`null`). The claim is measured, not inferred.
2. Get explicit user/owner sign-off on drop vs. fund the ReciterAI emit.

**No code change has been applied. The diff above is illustrative only.**
