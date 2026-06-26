# Spec — opportunity prestige signal for the funding matcher

**Status:** DRAFT for review (not implemented); corrected per multi-agent validation 2026-06-26. **Date:** 2026-06-26.
**Audience:** ReciterAI engineering (computes + emits) **+** SPS (consumes: axis + badge + sort).
**Ships with:** `funding-mesh-assignment-spec.md` as **GRANT# contract v2** (same item, same transition/health-smoke pattern — see §6).
**Roadmap:** `funding-matcher-accuracy.md`. **Matcher:** `lib/api/match-opportunities.ts`.

---

## 0. TL;DR

Capture, per opportunity, a **prestige score** ∈ [0,1] computed **upstream in ReciterAI** from four inputs (mechanism tier · award size · curated sponsor tier · selectivity), emitted on the `GRANT#` item with its sub-components for transparency. SPS uses it three ways (all chosen):

1. **Display badge** — mechanism + ceiling + a prestige tier label on each rec.
2. **Full ranking axis** — a weighted `prestige` term in the matcher, **guarded** so it can't override fit.
3. **User-controlled sort** — a "Best fit ⇄ Prestige" toggle so the human picks the objective.

**The guardrail that makes a full axis safe** (we just spent #1296 removing high-prestige-zero-fit honorific prizes — do not reintroduce that):
- **Default sort = fit.** Prestige weight in the default blend starts **conservative (eval-tuned, may be 0 at launch)**; the user opts into prestige-weighting via the sort toggle.
- **Topic-relevance floor.** The prestige term applies **only to opportunities above a minimum `topicAffinity`** — so prestige can reorder *relevant* grants but can never float an off-topic one up.
- **Orthogonal to actionability.** Prestige ranks *among applyable* opportunities; it must not float honorific-but-unwinnable prizes. ⚠️ **This is NOT automatic.** The #1296 honorific exclusion is (a) unmerged, (b) forward-matcher-only, and (c) a title regex — and the reverse RD `find-researchers` view never calls the matcher, so a prestige sort there would float the curated prizes straight to the top. The curated corpus *is* the prize set and prestige scores it HIGH (top sponsor + purse), so the topic-relevance floor doesn't help (prizes clear topic affinity by design). **Required fix before any prestige surface ships:** make honorific-exclusion a *data property* — emit an `is_honorific` / `non_applyable` flag on the `GRANT#` item so every consumer (forward matcher, reverse browse, badge, sort) inherits it. Do not ship badge or sort until that flag is emitted and applied on all surfaces.

---

## 1. Why upstream, and why a score + components

- **Upstream (ReciterAI):** the same call you made for MeSH. ReciterAI owns ingest and already parses NIH activity codes; selectivity/sponsor-tier data is best sourced where the opportunity is ingested. SPS should consume a finished signal, not re-derive sponsor tiers.
- **Score + components (not just a scalar):** emit the sub-scores so SPS can (a) explain the badge ("R01 · $500k/yr · top-tier sponsor"), (b) re-weight components without an upstream change, and (c) let the eval attribute lift to a specific input. Mirrors how `mesh_vector` carries per-term scores and `topic_vector` carries rationale.

---

## 2. Data contract — ReciterAI → SPS

Adds to the `GRANT#` item (alongside `mesh_vector` from the companion spec).

| Attr | Type | Req | Notes |
|---|---|---|---|
| `prestige` | object | ✅ | The block below. Always present for `is_research` opps. |
| `prestige.score` | number [0,1] | ✅ | Composite (§3). The matcher axis input. |
| `prestige.mechanism_tier` | number [0,1] | ✅ | Normalized mechanism/activity-code rank (§3.1). |
| `prestige.size_bucket` | number [0,1] | ✅ | Log-scaled award ceiling (§3.2). `0` if unknown. |
| `prestige.sponsor_tier` | number [0,1] | ✅ | Curated sponsor prominence (§3.3). Neutral `0.5` if sponsor not in the table. |
| `prestige.selectivity` | number [0,1] \| null | ⬜ | `1 − award_rate` where sourced; `null` when unknown (§3.4). |
| `prestige.label` | string | ✅ | Short human tier for the badge, e.g. `"Flagship"` / `"Major"` / `"Standard"` (§3.5). |
| `prestige.rationale` | string | ⬜ | One line for the QA tab ("R01, $500k ceiling, NIH"). |

Rules:
- `score` is on a fixed, documented scale (§3) so it's comparable across opps and stable across re-ingests. Do not rescale per-batch.
- `selectivity = null` is honest-unknown — SPS treats it as "no signal," NOT as 0. **Never fabricate an award rate.**
- Prestige is **opportunity-intrinsic** — it does NOT encode the scholar or their stage. Stage-appropriateness stays the matcher's existing `stage` axis (§4.2 / open decision #1).

---

## 3. ReciterAI responsibility — computing the score

`prestige.score = clamp01( Σ wᵢ·signalᵢ  /  Σ wᵢ )` over the **present** signals only — a true convex combination. Starting weights `wM=0.4, wZ=0.2, wS=0.2, wL=0.2` (tunable). When a signal is honest-unknown (selectivity null, or unparseable/missing ceiling — see §3.2), **drop its term and renormalize over the remaining weights** — do NOT fall back to another signal. (The earlier `selectivity ?? sponsor_tier` fallback double-counted `sponsor_tier` in the common null case — 0.2+0.2=0.4 — so the score depended on data availability, violating §2's comparable/stable contract.) Emit every sub-score regardless of the blend.

### 3.1 mechanism_tier
Rank by funding mechanism / NIH activity code. Indicative ordering (curate the full map upstream):
`P*/U*/DP* program & flagship` ≈ 1.0 · `R01/R35` ≈ 0.85 · `K-series` ≈ 0.7 (career) · `R21/R03/pilot` ≈ 0.4 · `unknown/foundation-generic` ≈ 0.3.
⚠️ **Scope check (grounded):** the existing activity-code parse is best-effort over the grants_gov opportunity-number string and **misses multi-letter prefixes** (`DP1`/`DP2` → `None`, yet DP* is listed flagship ≈1.0) — extend the parser to two-letter prefixes. All **168 curated** awards (and any non-NIH number) have `mechanism == ''`. Trigger the null-mechanism path on `mechanism == ''` (not only `status == 'forecasted'`): infer from text or default 0.3.

### 3.2 size_bucket
**Fixed-anchor** log scale (NOT corpus min-max — that would re-scale every opp's score whenever one new large-ceiling opp lands, violating §2's "stable across re-ingests"): `clamp01( (log10(ceiling) − log10(LO)) / (log10(HI) − log10(LO)) )` with `LO = $10k`, `HI = $10M`. Use **annual** ceiling where the source distinguishes total vs annual (note which in `rationale`). **Unknown/unparseable ceiling = no-signal** (drop the term and renormalize per §3, *not* `0`) — curated/foundation amounts are free text (`"Medal + $25,000"`, `"SEK 6 million"`) that won't parse, and scoring them `0` would systematically drag curated prestige down rather than leaving it neutral.

### 3.3 sponsor_tier (curated — the ongoing-cost input)
A maintained sponsor→tier table (NIH ICs, HHMI, major societies, top foundations → high; generic/regional → mid/low). Sponsor not in the table → neutral `0.5`. This is the one input with real curation cost; keep the table small and versioned.

### 3.4 selectivity (best-effort)
`1 − award_rate` (or applicant-pool proxy) where reliably sourceable; else `null`. Do not guess. Document the source per value if used.

### 3.5 label
Bucketize `score`: e.g. `≥0.8 "Flagship"`, `≥0.55 "Major"`, else `"Standard"`. Thresholds are an open decision (§7).

### 3.6 Acceptance
- Every `is_research` opp carries a `prestige` block with a non-null `score`.
- Spot-audit 25: human-judged tier ordering agrees with `label` for ≥80% (e.g. an R01 outranks a pilot R03).

---

## 4. SPS responsibility — consume (axis + badge + sort)

### 4.1 Ingest + read
- `prisma/schema.prisma` model `Opportunity` (~`:407`): add `prestige Json?  @map("prestige")`.
- `grant-opportunity-mapper.ts` / `grant-opportunity-etl.ts`: passthrough like `mesh_vector`.
- Search-index doc (`lib/search.ts:988-1010`) + matcher read (`match-opportunities.ts:301`): surface `prestige` on the candidate.

### 4.2 Ranking axis (the guarded "full axis")
Extend `MatchAxes` (`match-opportunities.ts:21-31`), `MatchWeights` / `DEFAULT_WEIGHTS` (`:28-31`) and `combineScore` (`:74-79`) with a `prestige` term. **Gate prestige on topic relevance by MULTIPLYING it by `topicAffinity`** — the same continuous device the existing `stage` term already uses (`stage·topic`), not a hard floor:
```
combineScore = topic·1.0 + stage·0.5·topic + meshTerm·wMT + meshDisease·wMD + deadline·0.1 + weights.prestige·axes.prestige·axes.topicAffinity
```
- This avoids a discontinuity (a hard `topicAffinity >= TOPIC_FLOOR` gate jumps `0 → weights.prestige·axes.prestige` at the threshold) and removes a second tunable. It also avoids colliding with the existing `RankOptions.topicFloor` hard-drop in `rankCandidates`. A near-zero-topic opp gets near-zero prestige contribution automatically; an off-topic prize can never float up.
- `weights.prestige` is **eval-tuned and starts at 0** — launch as display + sort only, raise the default-blend weight only after the Track-A eval shows it doesn't hurt actionable-grant precision (open decision §7).
- ⚠️ This change edits the SAME `MatchAxes` / `DEFAULT_WEIGHTS` / `combineScore` that the companion MeSH spec splits (`mesh` → `meshTerm` + `meshDisease`). Land them as ONE coordinated change (or strictly sequence) with a single source of truth for the weight vector — independent PRs will collide on the type and the literal.

### 4.3 Display badge
On `components/edit/grant-recs-card.tsx`: show `prestige.label` + `mechanism` + formatted ceiling (e.g. **"Flagship · R01 · up to $500k/yr"**). Tooltip = `prestige.rationale`. Render the prestige sub-bar alongside the existing topic/stage/mesh/deadline axis bars (but per [[project_topic_score_is_internal]], surface the *prestige* axis, not internal per-topic scores).

### 4.4 User-controlled sort
A segmented control on the grant-recs view: **Best fit** (default, current `defaultScore` order) ⇄ **Prestige** (order by `prestige.score`, fit shown but secondary). **Reuse the existing sort abstraction** — the matcher has `RankSort` + a `SORT_KEY` map; add a `prestige` key there.
⚠️ **Correction (grounded):** the sort is **server-side, not client-side** — `grant-recs-card.tsx` fetches `?sort=${sort}&limit=25` with `useEffect` dep `[cwid, sort]`, so changing the chip **re-queries the server** and only the top-25-by-active-key are ever materialized client-side. The original "client-side over already-fetched recs, no refetch (like find-researchers.tsx)" claim is false for this view, and it self-contradicted "add a key to the server-side `SORT_KEY`." Pick one: **(a)** accept that a prestige sort re-queries and orders the server-side top-25 by prestige (simplest, consistent with the existing chips), or **(b)** raise/drop the `LIMIT` and convert all chips (Fit/Deadline/Stage/Prestige) to a genuine client-side re-sort over the full fetched set. (a) is the lazy default. Persist the choice in the view; default **Best fit**.

---

## 5. Audience note (worth a product gut-check)

Prestige matters **more to research-development staff** (strategic "what big grants could our people win") than to a scholar (who wants *winnable fit*). The forward "Grants for me" matcher is scholar-facing; the reverse `find-researchers` is RD-facing. Consider whether prestige-sorting should lead in the **reverse** view and be quieter (badge only) in the scholar view. (Open decision §7.)

## 6. Rollout (shared with the MeSH spec — GRANT# contract v2)

1. ReciterAI emits `prestige` (+`mesh_vector`) to **staging** `reciterai` → `etl:dynamodb` re-project → reindex.
2. Gate the prestige **axis weight** behind the same matcher flag (default off / weight 0); the **badge + sort** can ship on (low risk). Flag wired per-env in `cdk/lib/app-stack.ts`, regenerate the app-stack snapshot.
3. **Eval (Track-A, `funding-matcher-accuracy-handoff.md` §4):** does a non-zero prestige weight change actionable-grant precision@N? Tune `weights.prestige` + `TOPIC_FLOOR` from the result before prod.
4. **Health smoke:** extend the new opportunities-index smoke (companion spec §8) to also assert `> X%` of opps carry a non-null `prestige.score`.

## 7. Open decisions (sign-off before build)

1. **Stage-relative prestige?** Should a K99/ESI award read as "Flagship *for a junior*" (prestige scaled by stage-fit), or stay stage-agnostic with the `stage` axis doing that work? (Affects §4.2.)
2. **`weights.prestige` + `TOPIC_FLOOR` starting values** — eval-set, but pick launch defaults (recommend weight 0 = display+sort only at launch).
3. **`label` thresholds** (§3.5).
4. **Sponsor-tier table ownership + cadence** — who maintains it, how often (§3.3).
5. **Scholar view vs RD view** — does prestige-sort lead in `find-researchers` and stay badge-only in `Grants for me`? (§5.)
6. **Selectivity** — is any reliable award-rate source worth wiring, or ship with `selectivity: null` (the other three inputs) for v1?

---

*No code changed. Design contract; implementation waits on sign-off. Companion to `funding-mesh-assignment-spec.md` — both are upstream-computed opportunity attributes on the same `GRANT#` item.*
