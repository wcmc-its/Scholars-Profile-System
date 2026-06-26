# Spec — weighted MeSH assignment for funding opportunities

**Status:** DRAFT for review (not implemented); corrected per multi-agent validation 2026-06-26. **Date:** 2026-06-26.
**Audience:** ReciterAI engineering (the `pipeline_grants` engine) **+** SPS (consumer).
**Companion:** `funding-mesh-axis-decision.md` (why the axis is dead), `funding-matcher-accuracy.md` §2.2/§2.3 (levers). The `GRANT#` item contract this extends is **code-defined** today — ReciterAI `pipeline_grants` `build_grant_item` (emit) + SPS `etl/dynamodb/grant-opportunity-mapper.ts` (ingest); a `grantrecs-reciterai-opportunity-handoff.md` was cited but **does not exist on disk** — treat the code as the contract until that doc is written.

---

## 0. TL;DR

Today `opportunity.mesh_descriptor_ui` is **0/831 populated** (all JSON-null) because ReciterAI emits no MeSH. This spec defines:

1. **ReciterAI** assigns MeSH descriptors to each opportunity **from its text** (synopsis/title), each with a **term-importance score** ∈ (0,1], and emits them as a **weighted vector** on the `GRANT#` item.
2. **SPS** consumes the vector, derives MeSH **tree facets** (disease/method/…) from its own vocabulary, and upgrades the matcher from flat Jaccard to a **weighted, tree-aware, disease-faceted overlap** — and gives the scholar side a **parallel weighted MeSH vector** so both sides are comparable.

**Hard rule (non-negotiable):** opportunity MeSH MUST be derived from opportunity **text**, never from its `topic_vector`. Deriving it from topics is circular with the existing `topicAffinity` axis (weight 1.0) and adds zero independent signal. (`mesh_curated_topic_anchor` exists — `prisma/schema.prisma:994-1002` — and MUST NOT be used as the source.)

> **Enforcement (the hard rule is prose-only otherwise — a circular emission looks identical on the wire):** (1) the extractor function MUST NOT receive `topic_vector` / anchor as an argument — assert this at the call site; (2) emit per-UI **text provenance** (char offset for lookup terms; source-concept + snippet for LLM terms); (3) drop/flag any emitted UI whose name/entry-term is **not present in title+synopsis**. Without these three, "derived from text" is unverifiable in review.

> ⚠️ The legacy `meshDescriptorUi` field's schema comment (`prisma/schema.prisma:406`) literally reads *"anchored to the opportunity's top topics"* — that topic-anchored intent is exactly the circular design this spec rejects (and the field is 100% empty anyway). `mesh_vector` supersedes it with **text-only** derivation; the `:406` comment must be corrected when the new field lands.

---

## 1. Why weighted (the term-importance requirement)

A flat descriptor set forces flat Jaccard (`lib/api/match-opportunities.ts:51-59`), which:
- treats "the one disease this NOFO is about" and "a method mentioned in passing" identically, and
- scores 0 for any non-identical UI even when terms are parent/child.

A **weighted vector** `[{ui, score}]` mirrors the topic vector (`topic_vector` = `[{topic_id, score, rationale}]`) and unlocks:
- **weighted cosine overlap** (the same math already in `topicAffinity`, `match-opportunities.ts:36-48`),
- **facet weighting** — sum the weight in the disease (tree-C) facet to drive §2.3,
- **explainability** — "matched on *Breast Neoplasms* (0.9)" in the QA tab.

---

## 2. Data contract — ReciterAI → SPS

Extends the `GRANT#` item (code-defined contract — see header). **Add** one field; keep the legacy flat field for one transition window.

| Attr | Type | Req | Notes |
|---|---|---|---|
| `mesh_vector` | `[{ui: string, score: number}]` | ✅ (may be `[]`) | NEW. `ui` = NLM descriptor UI (e.g. `"D001943"`). `score` ∈ (0,1] = term importance (§3). Sorted desc by score. Cap at top **8** terms/opp. |
| `mesh_descriptor_ui` | `string[]` | deprecated | Existing field (`grant-opportunity-mapper.ts:43,181`). During transition, emit `= mesh_vector.map(t=>t.ui)`. SPS drops its read once `mesh_vector` is live in prod. |

Rules:
- `ui` MUST be a real NLM descriptor UI. **Authoritative validation is SPS-side**: at facet-join (§5.2) SPS drops any `ui` absent from its `mesh_descriptor` table (retired/unresolvable) and logs the count — there is no MeSH-year column, table presence is the authority. ReciterAI should still emit current-year UIs and never invent one.
- `score` is raw salience, **not** normalized — SPS L2-normalizes at compare time (mirrors `scholarTopicVector`). Do not pre-normalize.
- Empty is valid: an opp with no resolvable MeSH emits `mesh_vector: []` → the axis contributes 0 for it (no error, no fabrication).
- **Do NOT** emit tree numbers or facets — SPS derives those from its `mesh_descriptor` table (§5.2). Keeps the upstream contract minimal and the vocabulary single-sourced.

---

## 3. ReciterAI responsibility — extraction + importance scoring

**Input:** opportunity `title` + `synopsis` (both available on the source record).
**Output:** `mesh_vector` per §2.

### 3.1 Extraction (lookup → LLM, per §2.2)
1. **Entry-term lookup first** (deterministic): match title/synopsis spans against MeSH descriptor **names + entry terms** (the NLM synonym/variant set). High precision, free, auditable.
2. **LLM fallback** for concepts lookup misses: prompt the model to extract the opportunity's MeSH-relevant concepts from the text, then **resolve each extracted concept back to a descriptor UI via the vocabulary** (never let the LLM invent a UI). One-time over the corpus (~831 opps) → cheap; incremental per new opp thereafter.

> Use the latest capable Claude model for the LLM pass (see SPS `claude-api` guidance / About-page scoring conventions). Blind the extractor to the topic vector so it reads the text, not our prior.

### 3.2 Importance score ∈ (0,1]
Define `score` as a bounded blend (tune the weights, but keep it explicit and logged per term for audit):

```
score = clamp01( 0.6·salience + 0.25·prominence + 0.15·specificity )
```
- **salience** — LLM-rated 0-1 "how central is this concept to the funded work" (lookup-only terms get a **neutral 0.5**, not 0.6 — 0.6 plus a title prominence hit could auto-promote an incidental exact match past the 0.7 "major" threshold with no centrality judgment; alternatively exclude lookup-only terms from the major flag).
- **prominence** — 1.0 if the term (or an entry-term) appears in the **title**, 0.6 if only in the synopsis, scaled by mention count (saturating).
- **specificity** ∈ **[0,1]** — deeper MeSH tree depth → higher (a leaf disease beats a top-level category). MUST be bounded: raw tree depth is ~1–13, so `0.15·depth` would reach ~2 and saturate `clamp01`, drowning salience/prominence. Use `clamp01(depth / DMAX)` (DMAX ≈ 12) or `1 − λ^depth`, and take the **MAX** depth across the descriptor's (multiple) tree numbers.

Flag the top concept(s) `score ≥ 0.7` as the opp's **major** descriptors (the NLM major/minor distinction) — SPS may weight major-facet matches harder.

**Drop any term with `score ≤ 0.05` before emitting** — `clamp01` can yield 0, but the contract is the open interval (0,1]; a 0-weight term is noise.

### 3.3 Acceptance for ReciterAI
- ≥ **70%** of `is_research` opportunities emit a non-empty `mesh_vector` (the rest genuinely lack indexable disease/method content — log them).
- Spot-audit 25 opps: the top-1 descriptor is human-judged correct for ≥ 80%.

---

## 4. The matcher upgrade — SPS (the consumer math)

Replace flat Jaccard (`meshOverlap`, `match-opportunities.ts:51-59`) with a weighted, tree-aware, faceted overlap. Both sides are weighted vectors `{ui: weight}` (scholar side per §6), each **L2-normalized** before compare.

### 4.1 Base — weighted cosine
`meshCosine(S, O) = Σ_ui S[ui]·O[ui]` over the shared UI set (identical to `topicAffinity`, `match-opportunities.ts:36-48`). Reuse that helper; do not reimplement.

### 4.2 Tree-aware credit (§2.2)
Expand each side to include **ancestor UIs** at a decayed weight so parent/child partially match, then hand the fully-expanded vectors to `topicAffinity` (which L2-normalizes each internally). Exact algorithm:
```
1. expandedS = scholarVec; for each (ui,w) in scholarVec: add each ancestor(ui) at w·λ^dist   (λ ≈ 0.5, dist = tree levels up)
2. expandedO = oppVec;     for each (ui,w) in oppVec:     add each ancestor(ui) at w·λ^dist
   (when an ancestor is reachable twice, keep the MAX weight, not the sum)
3. cosine = topicAffinity(expandedS, expandedO)   // topicAffinity L2-normalizes internally
```
> **Correction:** there is **no "expand-first vs normalize-first" ordering effect** — the final op is plain cosine (scale-invariant), the decay is multiplicative, and dedup-MAX is positively homogeneous, so pre-normalizing cancels out. The only real requirement is "pass the fully-expanded vector to `topicAffinity`." The earlier "order is load-bearing / normalizing first understates it" warning was false; ignore it.
> **Helper note:** the cited `ancestorUisFor` is **distance-blind and dedups first-seen**, so it cannot drive `λ^dist` or the MAX-over-paths rule. Build the decay expansion from `buildMeshAncestorIndex` + `treeNumberPrefixes` (`lib/mesh-tree-ancestors.ts`) — walk the tree-number prefixes (prefix index = levels-up = `dist`), apply `w·λ^k`, accumulate with MAX. This decay expansion is **genuinely new code**, not a call to the existing helper.

Now `D001943` (Breast Neoplasms) vs `D009369` (Neoplasms) earns partial credit instead of 0.

### 4.3 Disease-facet alignment (§2.3 — the real lever)
Facet both vectors by **tree category** = first letter of a tree number (`mesh_descriptor.treeNumbers`, `prisma/schema.prisma:957`): `C` = Diseases, `E` = Techniques/Equipment, `M`/`N`/… others.
> ⚠️ **Descriptors are polyhierarchical** — `treeNumbers` is a LIST (e.g. `["C04.557.470","C16.131.077"]`), so "first letter of *the* tree number" is order-dependent and silently drops a disease whose first-listed number is non-`C`. Facets **overlap, they do not partition**: a UI is in the disease facet iff **ANY** of its `treeNumbers` starts with `C`. §4.3 and §5.2 MUST use this identical "any tree number" rule.
- Compute a **disease-facet cosine** `meshDiseaseOverlap` = §4.1–4.2 restricted to descriptors with **any** tree-`C` number.
- Surface it as a **distinct axis** (not folded into the flat term), so the matcher can weight it and the QA tab can show "disease facet: aligned / MISMATCH" — the top failure among real grants.

### 4.4 New axes + weights
`MatchAxes`/`DEFAULT_WEIGHTS` (`match-opportunities.ts:24-31`) change from one `mesh` term to two, e.g.:
```
{ topic: 1.0, stage: 0.5, meshTerm: 0.15, meshDisease: 0.25, deadline: 0.1 }
```
Final weights are **eval-tuned** (Step §7), not guessed. The flat `mesh: 0.25` is retired.

---

## 5. SPS responsibility — plumbing

### 5.1 Ingest
- `grant-opportunity-mapper.ts:207-209`: map `mesh_vector` → a new `mesh_vector` JSON column on `Opportunity` (alongside, then replacing, `mesh_descriptor_ui`). `Prisma.JsonNull` only when the field is truly **absent** from the item; `[]` when ReciterAI ran but resolved nothing (the two are distinct and the health smoke §8 cares).
- `prisma/schema.prisma` model `Opportunity` (~`:407`): add `meshVector Json?  @map("mesh_vector")` (nullable; no backfill — rows stay `Prisma.JsonNull` until ReciterAI re-emits).
- **Transition:** for one window (~3 months) ReciterAI emits BOTH fields and the SPS read path prefers `mesh_vector`, falling back to the flat `mesh_descriptor_ui` only when `mesh_vector` is null. If both are present and disagree, **`mesh_vector` wins** (the flat field is deprecated). After the window: SPS drops the flat field from the read path entirely.

### 5.2 Facet derivation (SPS owns the vocabulary)
At search-index build (`indexOpportunities`, `etl/search-index/index.ts:561-581`), join each opp's `mesh_vector` UIs to `mesh_descriptor.treeNumbers` (and drop UIs absent from `mesh_descriptor` per §2), then emit on the OpenSearch opportunity doc (`lib/search.ts:988-1010`):
  - `meshVector: [{ui, score}]` — the full weighted vector (the matcher's primary input).
  - `meshDiseaseUi: string[]` — just the tree-`C` UIs (weights still come from `meshVector`). This is a **query-time-speed cache** for the §4.3 disease-facet restriction; the matcher *could* re-derive it from `meshVector` + the descriptor table, but precomputing avoids a per-request vocabulary join.

### 5.3 Matcher read
`match-opportunities.ts:301` reads `meshVector` (weighted) instead of the flat `meshDescriptorUi`; feed §4.

---

## 6. Scholar-side parity (required for a weighted compare)

A weighted opp vector is useless against a flat scholar set — the scholar side needs weights too. Build `publicationMeshVector` mirroring `publicationMeshUi` (`lib/search-index-docs.ts:837-865`) **and** the #1295 topic-vector weighting:
```
weight(ui) = Σ over pubs carrying ui of ( authorshipWeight(pub) · recencyWeight(pub.year) )
```
- Keep the existing **min-evidence admission gate** (≥2 distinct pubs OR any first/last-author pub) — `search-index-docs.ts:861-865`.
- `authorshipWeight` / `recencyWeight`: ⚠️ **do NOT reuse `lib/ranking.ts` here.** Those are a *hard* `scholarCentric` 1/0 filter + a step recency curve — inconsistent with #1295's *soft* scheme, which is what the topic vector actually uses (`AUTHOR_POSITION_WEIGHT` = first/last 1.0, penultimate 0.5, middle 0.25; recency `0.5^(age/5)`). Weighting the MeSH vector on `ranking.ts` (1/0) while the topic vector weights on #1295 (1/1/0.5/0.25) makes the two vectors *inconsistent*, the opposite of the stated goal. **Reuse #1295's exported `scholarTopicRowWeight`** (`match-opportunities.ts:202` on `feat/funding-vector-precision`) as the single shared helper — or state plainly that the divergence is deliberate. Either way, coordinate with PR **#1295** (open, `feat/funding-vector-precision`) so both vectors weight the same way. ⚠️ Note: `scholarTopicVector` (`match-opportunities.ts:187`) does **not** currently call these — it sums pre-computed `publicationTopic` scores — so this MeSH-vector weighting is **new code reusing the primitive**, not a copy of an existing weighted-vector builder.
- L2-normalize at compare time, not at write time.
- Emit on the people index next to `publicationMeshUi` (keep the flat field for the existing search `terms` clauses — `lib/api/search.ts` uses `publicationMeshUi` for concept admission; do **not** break those).

---

## 7. Rollout, flags, eval

1. **Flag:** gate the new axes behind a matcher flag (default off) so deploy ≠ behavior change; the forward matcher is already superuser-only (`SELF_EDIT_GRANT_RECS` off). Wire it in `cdk/lib/app-stack.ts` per-env (flag-parity rule), regenerate the app-stack snapshot.
2. **Sequence:** ReciterAI emits to **staging** `reciterai` table → SPS `etl:dynamodb` re-projects → reindex → enable flag on staging.
3. **Measure the lift** with the Track-A eval (`funding-matcher-accuracy-handoff.md` §4): compare precision@N **and the disease-facet failure histogram** before/after. Tune §4.4 weights from the result. Only then prod.

## 8. No-silent-rot guard

Add the **missing** opportunities-index health smoke (none exists today — only people/pubs/funding, `etl/search-index/index.ts:663-665`): after `indexOpportunities`, count opps carrying `JSON_TYPE(mesh_vector)='ARRAY'` with ≥1 term, **soft-warn below 50%** (tracks §3.3's ≥70% emit target with headroom for genuinely un-indexable opps).
- ⚠️ **Ship soft-warn FIRST; flip to hard-fail-at-0 only after prod emit is confirmed** (or gate the hard-fail behind the §7 rollout flag). A hard-fail-at-0 reaching prod *before* ReciterAI prod-emits `mesh_vector` would abort the opportunities reindex (smokes run after fill, can poison a combined run). Document the order: prod emit → `etl:dynamodb` reproject → reindex → enable hard-fail.
- **Must** test `JSON_TYPE='ARRAY'`, not `IS NOT NULL` — a freshly-added nullable column is SQL `NULL` (`Prisma.DbNull`); an explicitly-cleared one is `Prisma.JsonNull` (a JSON scalar `null` that **passes `IS NOT NULL` and has `JSON_LENGTH`=1**); plus `[]` and `[terms]` — **four** states, not three. All three non-array states correctly fail `JSON_TYPE='ARRAY'` (this is exactly why 0/831 went unnoticed under a naïve `IS NOT NULL` check). The read-fallback (§5.1) must treat `DbNull` and `JsonNull` identically.
- Add a **facet-join drop-rate soft-warn** too: if ReciterAI carries its own MeSH vintage, a high share of UIs dropped at the §5.2 facet-join (retired/version-skew) would quietly re-starve the axis — a 0/831 recurrence one layer down. Pin/record the MeSH vintage on both sides.

---

## 9. Edge cases

| Case | Behavior |
|---|---|
| Opp synopsis blank | Fall back to `title`; if still empty → `mesh_vector: []` |
| LLM returns a concept with no descriptor | Drop it (never invent a UI) |
| Retired/invalid UI from upstream | SPS drops on facet-join (no match in `mesh_descriptor`); log count |
| Opp with terms only outside tree-C | `meshDiseaseOverlap` = 0; `meshTerm` still scores; QA shows "no disease facet" |
| Scholar with no qualifying MeSH | `publicationMeshVector` omitted (omit-on-empty); both mesh axes → 0, topic/stage carry |
| `mesh_vector` present but `mesh_descriptor_ui` absent (post-transition) | SPS reads `mesh_vector` only |
| Non-research opp | ReciterAI does not index (out of `is_research` scope) |

## 10. Open decisions (need sign-off before build)

1. **λ (tree-decay) and the §4.4 weights** — set by eval, but pick starting values together.
2. **Major/minor use** — do we boost major-facet matches, or just expose them? (Default: expose now, boost only if eval shows lift.)
3. **Transition window** — how long SPS keeps reading the flat `mesh_descriptor_ui` before requiring `mesh_vector`.
4. **Cap at 8 terms/opp** — confirm; raise if synopses are concept-dense.
5. **Scholar vector recompute cost** — `publicationMeshVector` adds work to the people-index build; confirm acceptable vs. computing weights at query time.

---

*No code changed. This is a design contract; implementation waits on sign-off (per "plan first, then build").*
