# Spec — opportunity prestige signal for the funding matcher

**Status:** DRAFT for review (not implemented); corrected per multi-agent validation 2026-06-26. **Date:** 2026-06-26.
**Audience:** ReciterAI engineering (computes + emits) **+** SPS (consumes: axis + badge + sort).
**Ships with:** `funding-mesh-assignment-spec.md` as **GRANT# contract v2** (same item, same transition/health-smoke pattern — see §6).
**Roadmap:** `funding-matcher-accuracy.md`. **Matcher:** `lib/api/match-opportunities.ts`.

---

## 0. TL;DR

Capture, per opportunity, a **prestige score** ∈ [0,1] computed **upstream in ReciterAI** from four inputs (mechanism tier · award size · curated sponsor tier · selectivity), emitted on the `GRANT#` item with its sub-components for transparency. SPS uses it three ways (all chosen):

1. **Display badge** — mechanism + ceiling + a prestige tier label on each rec.
2. **Prestige-FIT ranking (two-sided band, not "higher is better").** Prestige is matched to the scholar's own standing: an opp whose prestige sits far **below** the scholar's level (a $25k pilot for an established PI — a *trifle*) **or** far **above** it (a Breakthrough Prize / flagship P50 for a junior — *not ready*) is softly down-weighted; in-band opps are untouched. Implemented as a **multiplicative dampener** (§4.2) — it can only *suppress* mismatches, never boost, so it cannot override topical fit. Needs a scholar-side **prestige band** (§4.5), the other half of the signal.
3. **User-controlled sort** — a "Best fit ⇄ Prestige" toggle. *Best fit* = the band-fit dampened ranking; *Prestige* = raw opp prestige magnitude (the research-development "show me the biggest grants" view, §5).

**Why this is safe** (we just spent #1296 removing high-prestige-zero-fit honorific prizes — do not reintroduce that):
- **Default sort = fit.** The dampener `penaltyWeight` starts **conservative (eval-tuned, may be 0 at launch)**; the user opts into magnitude ordering via the sort toggle.
- **Dampener-only.** Prestige-fit is a multiplier **≤ 1**, so it can only sink out-of-band opps, never float one up — **no topic floor needed** (and nothing collides with `RankOptions.topicFloor`).
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
| `prestige.size_bucket` | number [0,1] \| null | ⬜ | Fixed-anchor log of award ceiling (§3.2). `null` when the ceiling is unknown/unparseable — no-signal, dropped + renormalized; **never 0**. |
| `prestige.sponsor_tier` | number [0,1] \| null | ⬜ | Curated sponsor prominence (§3.3). `null` in v1 (curated table deferred — §3.3 / §7.4); when built, neutral `0.5` if sponsor absent from the table. |
| `prestige.selectivity` | number [0,1] \| null | ⬜ | `1 − award_rate` where sourced; `null` when unknown (§3.4). |
| `prestige.label` | string | ✅ | Short human tier for the badge, e.g. `"Flagship"` / `"Major"` / `"Standard"` (§3.5). |
| `prestige.rationale` | string | ⬜ | One line for the QA tab ("R01, $500k ceiling, NIH"). |

Rules:
- `score` is on a fixed, documented scale (§3) so it's comparable across opps and stable across re-ingests. Do not rescale per-batch.
- `selectivity = null` is honest-unknown — SPS treats it as "no signal," NOT as 0. **Never fabricate an award rate.**
- The prestige **score** (§3) is **opportunity-intrinsic** — it does NOT encode the scholar. The scholar match happens at rank time: the §4.2 prestige-FIT band compares opp prestige to the scholar's *standing* band (§4.5), which is deliberately NOT career stage. Career-stage appropriateness stays the separate `stage` axis (§7.1 RESOLVED).

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

### 4.2 Prestige-fit dampener (the ranking effect)
Add `prestigeFit ∈ [0,1]` to `MatchAxes` (`match-opportunities.ts:21-31`) — the **proximity of the opp's prestige to the scholar's band** (§4.5), NOT the opp's raw magnitude. Apply it as a **multiplicative dampener** on the rest of the blend (do NOT add a magnitude term — the two archetypes are about *suppressing* mismatches, not boosting prestige):
```
relevance     = topic·1.0 + stage·0.5·topic + meshTerm·wMT + meshDisease·wMD + deadline·0.1     // unchanged
prestigeFit   = bandFit(oppPrestige, scholarBand)                                                 // §4.5, ∈[0,1], 1 = in band
dampener      = 1 − weights.prestigePenalty·(1 − prestigeFit)                                     // ∈ [1−penalty, 1]
combineScore  = relevance · dampener
```
- **bandFit** is symmetric soft proximity: `bandFit = clamp01( 1 − max(0, |oppPrestige − scholarBand| − BAND) / SLOPE )` — full credit within a tolerance `BAND` of the scholar's level, linear decay beyond by `SLOPE`. (Asymmetry — punish "too lofty for a junior" harder than "too trifling for a senior" — is a tunable, open decision §7; you chose symmetric for v1.)
- **Dampener, not a boost:** `dampener ≤ 1`, so an out-of-band opp is scaled *down* but a topically-excellent one can still out-rank a mediocre in-band one ("sinks but can still appear"). It can never lift an off-topic opp — hence no topic floor.
- `weights.prestigePenalty` is **eval-tuned and starts at 0** (= dampener ≡ 1, display + sort only). Raise only after the Track-A eval shows band-fit doesn't hurt actionable-grant precision (§7).
- ⚠️ This edits the SAME `MatchAxes` / `combineScore` the companion MeSH spec splits (`mesh` → `meshTerm` + `meshDisease`). Land them as ONE coordinated change (or strictly sequence) with a single source of truth for the axis/weight vector — independent PRs will collide on the type and the literal.

### 4.3 Display badge
On `components/edit/grant-recs-card.tsx`: show `prestige.label` + `mechanism` + formatted ceiling (e.g. **"Flagship · R01 · up to $500k/yr"**). Tooltip = `prestige.rationale`. Render the prestige sub-bar alongside the existing topic/stage/mesh/deadline axis bars (but per [[project_topic_score_is_internal]], surface the *prestige* axis, not internal per-topic scores).

### 4.4 User-controlled sort
A segmented control on the grant-recs view: **Best fit** (default, current `defaultScore` order) ⇄ **Prestige** (order by `prestige.score`, fit shown but secondary). **Reuse the existing sort abstraction** — the matcher has `RankSort` + a `SORT_KEY` map; add a `prestige` key there.
⚠️ **Correction (grounded):** the sort is **server-side, not client-side** — `grant-recs-card.tsx` fetches `?sort=${sort}&limit=25` with `useEffect` dep `[cwid, sort]`, so changing the chip **re-queries the server** and only the top-25-by-active-key are ever materialized client-side. The original "client-side over already-fetched recs, no refetch (like find-researchers.tsx)" claim is false for this view, and it self-contradicted "add a key to the server-side `SORT_KEY`." Pick one: **(a)** accept that a prestige sort re-queries and orders the server-side top-25 by prestige (simplest, consistent with the existing chips), or **(b)** raise/drop the `LIMIT` and convert all chips (Fit/Deadline/Stage/Prestige) to a genuine client-side re-sort over the full fetched set. (a) is the lazy default. Persist the choice in the view; default **Best fit**.

### 4.5 Scholar prestige band — the other half (SPS-computed)

The opp prestige score (§3) is half the signal; the dampener needs the **scholar's own standing** to know what's in-band. Compute `scholarBand ∈ [0,1]` on the **same scale** as opp prestige, from the three inputs you chose (**not** career stage — that stays the separate `stage` axis):

```
scholarBand = clamp01( Σ wᵢ·signalᵢ / Σ wᵢ )   over PRESENT signals only (convex combo, renormalize on unknowns — same rule as §3)
  fundingTrack  (wF≈0.5) — the high-water mark of grants the scholar has HELD, scored on the SAME mechanism_tier scale as §3.1
                          (held an R01/R35 → high; only pilots → low; none → drop the term). Source: Scholar.grants / Scholar.nihProfiles.
  standing      (wP≈0.3) — normalized productivity/impact percentile (pub volume, citations, senior-authorship share).
                          Source: the people index / existing impact metric. ⚠️ overlaps topic somewhat — keep it a percentile, not raw counts.
  rank          (wR≈0.2) — faculty title → ordinal (Asst<Assoc<Full). Source: scholar primaryTitle/appointments; drop if missing/unparseable.
```
- **fundingTrack is the strongest "reachable prestige" evidence** (a junior who already holds an R01 has a high band despite a short clock — which is exactly why career stage is deliberately excluded here).
- Honest-unknown: a scholar with no grant history drops `fundingTrack` and leans on standing+rank — do **not** floor them to 0 (that would over-suppress and mislabel early-but-strong scholars as "not ready").
- **Where:** compute in `matchOpportunitiesForScholar` alongside `scholarTopicVector` / `scholarCareerStage` (load grants + title + standing there), or precompute on the people index (like the §6 MeSH-vector parity). Build-detail, eval-tune the weights.

---

## 5. Audience note (worth a product gut-check)

Prestige matters **more to research-development staff** (strategic "what big grants could our people win") than to a scholar (who wants *winnable fit*). The forward "Grants for me" matcher is scholar-facing; the reverse `find-researchers` is RD-facing. Consider whether prestige-sorting should lead in the **reverse** view and be quieter (badge only) in the scholar view. (Open decision §7.)

## 6. Rollout (shared with the MeSH spec — GRANT# contract v2)

1. ReciterAI emits `prestige` (+`mesh_vector`) to **staging** `reciterai` → `etl:dynamodb` re-project → reindex.
2. Gate the prestige **axis weight** behind the same matcher flag (default off / weight 0); the **badge + sort** can ship on (low risk). Flag wired per-env in `cdk/lib/app-stack.ts`, regenerate the app-stack snapshot.
3. **Eval (Track-A, `funding-matcher-accuracy-handoff.md` §4):** does a non-zero `prestigePenalty` change actionable-grant precision@N? Tune `prestigePenalty` + the band params (`BAND`, `SLOPE`) from the result before prod.
4. **Health smoke:** extend the new opportunities-index smoke (companion spec §8) to also assert `> X%` of opps carry a non-null `prestige.score`.

## 7. Open decisions (sign-off before build)

1. **Stage-relative prestige?** — **RESOLVED: No.** The band is *standing*-based (§4.5: funding track + productivity + rank), and the `stage` axis stays the separate career-clock signal. Deliberately excludes career stage.
2. **`prestigePenalty` + `BAND` / `SLOPE` starting values** — eval-set; launch `prestigePenalty = 0` (badge + magnitude-sort only, no dampening) until Track-A clears it.
3. **`label` thresholds** (§3.5) — provisional ≥0.8 Flagship / ≥0.55 Major; derive final cuts from the corpus histogram.
4. **Sponsor-tier table ownership + cadence** (§3.3) — deferred in producer v1 (`sponsor_tier: null`, renormalized); ReciterAI-owned `config/sponsor_tiers.json` when built.
5. **Scholar view vs RD view** — prestige-sort leads in `find-researchers` (RD), badge-only/quieter in scholar "Grants for me" (§5).
6. **Selectivity** — ship `null` for v1 (no reliable award-rate source).
7. **Band-fit specifics (§4.2/§4.5):** symmetric vs asymmetric penalty (v1 symmetric); the scholar-band `standing` metric source + weights `wF/wP/wR`; whether to precompute `scholarBand` on the people index vs per-request.

---

*No code changed. Design contract; implementation waits on sign-off. Companion to `funding-mesh-assignment-spec.md` — both are upstream-computed opportunity attributes on the same `GRANT#` item.*
