# Finding: common lay-term queries fail MeSH mapping (→ #1258)

_Surfaced 2026-06-30 during the search author-rank/clinical investigation
(`docs/search-author-rank-clinical-signal-handoff.md`), via the archetype gold-set
baseline. Routed here for the #1258 lay-term anchor/alias epic — **not** fixed on the
author-rank branch (keeps the epics unmuddled)._

## The finding

On the live staging People search, common **lay/short forms** of MeSH terms do **not**
resolve to a descriptor, so `meshMapped=false` and the query drops to keyword fallback —
which craters ranking for *every* archetype on those queries:

| query | `meshMapped` | gold-set medRank / MRR (flag-off baseline) |
|---|---|---|
| `diabetes` | **false** | medRank **198**, MRR **0.026** |
| `diabetes mellitus` | true (exact) | — |
| `alzheimer` / `alzheimer's` | **false** | medRank **20**, MRR 0.048 |
| `alzheimer disease` | true (exact) | — |
| `obesity` / `hypertension` / `CRISPR` / `FMT` | true (exact) | (rank normally) |

Contrast: `diabetes mellitus` and `alzheimer disease` (the full MeSH descriptor names) map
fine. Only the colloquial short forms miss.

## Why (mechanism)

`resolveMeshDescriptor()` (`lib/api/search-taxonomy.ts:1300`) looks the normalized query up
in `getMeshMap().byForm` (`:1007`), which is built from three sources:
1. MeSH **descriptor names** (`mesh_descriptor.name`),
2. NLM **entry terms** (`mesh_descriptor.entry_terms`),
3. **curated aliases** (`mesh_curated_alias`, alias→descriptorUi).

Lay terms like "diabetes" are **not** NLM entry terms (entry terms are still formal
terminology, e.g. "NIDDM", "Type 2 Diabetes Mellitus"). So a generic entry-term path can't
fix this class — it requires a **curated alias** row.

When `meshMapped=false`, `classifyPeopleQuery()` (`lib/api/people-query-shape.ts:127`) routes
a short single-token query to **`unclassified`** (not `topic`), losing `meshDescendantUis`
expansion and the concept-axis concentration boost — hence the crater.

## Current state of the fix

- **The alias mechanism already exists** (`etl/mesh-aliases/`, `mesh_curated_alias` table; #642/#1258).
- **`Alzheimer's`→D000544 alias is already in `etl/mesh-aliases/curated.csv` on master** (`:59`) —
  but staging still shows `meshMapped=false` for `alzheimer's`, i.e. the row is **merged in code
  but not active on staging** (the `etl:mesh-aliases` load hasn't run there since it was added).
  Commit `efe98b21` says as much: *"headline lay-term wins (diabetes/alzheimer's) STILL NEED the
  #1258 alias rows."*
- **`diabetes`→D003920 alias is genuinely missing** (only the descriptor name "Diabetes Mellitus"
  exists). `diabetic` likely too.
- 138 anchor + alias candidates are already drafted (`etl/mesh-aliases/curated.candidates.csv`,
  `etl/mesh-anchors/curated.candidates.csv`, `docs/mesh-anchor-lay-term-candidates.csv`).

## Recommended fix (low-cost, no reindex, no code, no flag)

1. Add the missing top lay-term **alias** rows to `etl/mesh-aliases/curated.csv`, e.g.:
   ```csv
   Diabetes,D003920,"#1258 lay-term alias -> Diabetes Mellitus"
   Diabetic,D003920,"#1258 lay-term alias -> Diabetes Mellitus"
   ```
   (sweep the candidates file for the rest of the high-traffic lay terms).
2. **Run `etl:mesh-aliases` on staging** to load the table — this alone activates the
   already-merged rows (Alzheimer's, etc.). `getMeshMap()` reads the DB, so no reindex/image roll.
3. Re-probe: `?type=people&q=diabetes` should return `meshMapped=true`; re-run
   `scripts/search-eval/eval.sh` and confirm `diabetes`/`alzheimer's` medRank collapses toward the
   other (mapped) queries.

## Caveats to verify when activating

- Confirm `normalizeForMatch` collapses the apostrophe/possessive so the query `alzheimer's`
  (→ `alzheimers`) matches the stored alias `Alzheimer's` (the docs candidate flagged this as
  "needs-alias (apostrophe/possessive)"). The bare `alzheimer` (no `'s`) will still miss unless a
  separate alias is added.
- Belongs to the #1258/#642 epic (open: `feat/1258-promote-curated-anchors`, mesh-aliases). Fold
  this into that work rather than the author-rank branch.
