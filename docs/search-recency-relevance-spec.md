# SPEC — Recency-weighted Relevance (publications tab)

Status: **IMPLEMENTED** 2026-06-01 (#645) — shipped on by default (`gentle`); test matrix §10 green. §14 decisions resolved (ship `gentle`, iterate via the §11 levers).
Owner: search.
Companions: `docs/search-publications.md` (explainer), `docs/search.md` (architecture), `docs/taxonomy-aware-search.md` (the MeSH-aware SPEC this rides on top of).
Issue: [#645](https://github.com/wcmc-its/Scholars-Profile-System/issues/645).

---

## 1. Problem

On the publications tab, **Relevance** is the default sort. It is pure BM25 — `_score` from the `multi_match` + per-field boosts, with **no recency signal at all**:

```
lib/api/search.ts:1512   const sortClause = [];
                         // sort === "relevance"  → no sort clause → _score (BM25) order
```

Reproducer (local): `http://localhost:3002/search?q=cancer&type=publications` ranks a **c.1999** paper at the top. For a broad, evergreen query like `cancer`, a foundational 1999 paper can out-BM25 every recent paper (heavy title/MeSH term-frequency, long history), so it sits above work from the last few years. For a directory whose value proposition is *current* WCM scholarship, "the top hit is 27 years old" reads as broken even though BM25 is doing exactly what BM25 does.

We want **Relevance = keyword match, tilted toward recent** — keyword match stays the necessary, primary signal; recency becomes a secondary modifier that breaks near-ties and damps stale-but-keyword-heavy papers, **without** letting a weakly-matching new paper leapfrog a strongly-matching old one.

**Calibration anchor (from the owner):** a current paper (~2024) should outrank an equally-matching ~2001 paper by about **3 : 1**.

---

## 2. Goals / non-goals

**Goals**
- G1. A recent paper and an old paper with comparable keyword match → recent ranks higher (target ≈ 3× for a current-vs-2001 pair, §5.4).
- G2. Keyword relevance stays primary: recency can re-order near-peers, it cannot manufacture relevance for an off-topic recent paper. An old paper is never penalized *below* its BM25 (floor = 1×); only recent papers are *lifted*.
- G3. Tunable, observable, and reversible by env flag with no reindex and no redeploy.
- G4. Applies to **every** relevance-sorted shape (the §1.2 keyword path **and** the concept_expanded / strict MeSH paths) — a stale paper surfaced via a MeSH descriptor should also be damped.

**Non-goals**
- N1. Not a new sort option. The existing **Recency** sort (`year desc`, flag-gated, §1.8) already serves users who want a *pure chronological* list. This SPEC changes what **Relevance** *means*; it adds no dropdown entry. (See §4.)
- N2. No new index field and no ETL change. We reuse the already-indexed `year`.
- N3. Does not change which documents *match* (admission). It only re-scores the matched set. (Corollary in §9: it cannot rescue recent papers that fail admission because NLM hasn't applied MeSH yet — that upstream lag is untouched.)
- N4. People tab and Grants tab are out of scope. People-tab relevance has its own v3 stack (`SEARCH_PEOPLE_RELEVANCE_MODE`); a parallel recency treatment there is a separate decision.

---

## 3. Signal field: `year`, not `dateAddedToEntrez`

The index carries two time fields (`lib/search.ts:239,242`):

| Field | Type | Meaning | Use here |
|---|---|---|---|
| `year` | `integer` | Publication year (PubMed) | **Decay origin.** This is the "recency" a user perceives. |
| `dateAddedToEntrez` | `date` | When PubMed ingested the record | Not used. A re-indexed old paper can have a recent Entrez date; it is the wrong notion of "recent". Already the *tiebreak* in the separate Recency sort. |

`year` is `Int?` (nullable) in the source (`publication.year`, `prisma/schema.prisma`). Null handling is specified in §8.

---

## 4. This is not the "Recency" sort

Keep these distinct in code, docs, and UI:

| | **Recency** sort (existing, §1.8, flag-gated) | **Relevance** with recency tilt (this SPEC) |
|---|---|---|
| Primary key | `year desc` (hard chronological) | BM25 `_score` |
| Role of keyword match | tiebreak only | the dominant signal |
| Role of year | the sort key | a bounded multiplier on `_score` |
| A weak-match 2026 paper vs strong-match 1999 paper | 2026 wins (it's newer) | 1999 can still win if its match is much stronger |
| Surfaced as | a dropdown option | the meaning of the default |

If a user genuinely wants strictly-newest-first, that is the Recency sort. This SPEC fixes the *default* so the common case stops looking broken.

---

## 5. Mechanism

Wrap the existing `query` (the `bool` built at `lib/api/search.ts:1565`) in a `function_score` with a **Gaussian decay** on `year`, applied **only on the relevance path** (when `sortClause` is empty). This mirrors the established pattern already in this file for the People-tab dept-leadership boost (`lib/api/search.ts:1051`, multiplicative `function_score` wrapper gated by its own flag).

### 5.1 Composition: bounded-additive multiplier (`gentle`) — shipped default

Recency is a **bounded lift**: oldest papers keep 100% of their BM25 (floor 1×), the freshest get up to **(1 + W)× = 3×**. Keyword order can never be inverted by more than the 3× ceiling — exactly the "keyword stays primary, recency tilts" contract (G2).

```jsonc
{ "function_score": {
    "query": { /* the existing bool, unchanged */ },
    "functions": [
      { "weight": 1 },                                    // constant floor → factor never < 1×
      { "filter": { "exists": { "field": "year" } },      // missing-year → falls to the floor (E1)
        "gauss": { "year": { "origin": 2026, "offset": 2, "scale": 8, "decay": 0.5 } },
        "weight": 2 }                                      // W = 2.0  → ceiling (1+W) = 3×
    ],
    "score_mode": "sum",        // 1 + W·g(year)  ∈ [1, 3]
    "boost_mode": "multiply"    // final = bm25 × (1 + W·g(year))
}}
```

`origin: 2026` is illustrative — it is the **current year at query time**, sourced through an injectable clock (§7), not a literal. The gauss function carries an `exists: year` filter so a missing/null `year` contributes nothing to the `sum` (→ floor 1×) rather than OpenSearch's neutral 1.0, which under `sum` would read as max freshness (1 + 2·1 = 3×) and float unknown-date papers to the top — see §8 E1.

### 5.2 Why Gaussian (not exp / linear)

- `gauss` plateaus near the origin and **never reaches zero** — an old paper is damped, not excluded. A perfect-match 1999 paper still appears, just lower. ✔ G2.
- `exp` is steepest at the origin → penalizes 2-3-year-old papers hard; too punitive for an academic corpus with normal publication lag.
- `linear` hits **zero** at `origin − (offset+scale)` and stays there → silently drops everything older than ~2016 from the scored set. ✘ violates G2.

### 5.3 Parameters (hardcoded constants, with rationale)

| Param | Value | Rationale |
|---|---|---|
| `origin` | current calendar year | "now". Sourced at query time (§7) — **not** indexed. |
| `offset` | `2` | A 2-year plateau: the last ~2 years (incl. the owner's "2024" anchor relative to a 2026 now) are treated as equally fresh = full 3×. Absorbs publication/epub lag and ahead-of-print `year ≥ origin` (§8). |
| `scale` | `8` | Distance past the plateau at which the *gauss term* hits `decay`. Half-weight year ≈ `origin−10` (≈2016 today): a 2016 paper sits at the 2× midpoint. Tuned jointly with `W` to hit the 3:1 anchor (§5.4). |
| `decay` | `0.5` | Gauss value at `scale`. Standard. |
| `W` | `2.0` | Freshest papers → (1+W) = **3×**; oldest → 1×. The cap on how much recency can re-order keyword results, and the knob that sets the 3:1 current-vs-2001 ratio. |

### 5.4 Calibration table (these exact constants, origin = 2026)

`d = max(0, |origin − year| − offset)`; `g = exp(−d²/(2σ²))`, `σ² = −scale²/(2·ln decay) ≈ 46.17`; multiplier `M = 1 + 2·g`.

| Publication year | gauss `g` | **multiplier `M`** |
|---|---|---|
| 2026 / 2025 / 2024 | 1.000 | **3.00×** |
| 2022 | 0.958 | 2.92× |
| 2020 | 0.841 | 2.68× |
| 2018 | 0.677 | 2.35× |
| 2016 | 0.500 | 2.00× |
| 2014 | 0.339 | 1.68× |
| 2012 | 0.210 | 1.42× |
| 2010 | 0.120 | 1.24× |
| 2006 | 0.030 | 1.06× |
| **2001** | 0.003 | **1.01×** |
| 1999 (reproducer) | 0.001 | 1.00× |

**Anchor check:** `M(2024) / M(2001) = 3.00 / 1.01 = 2.98 ≈ 3 : 1` ✔. The 1999 reproducer is at 1.00× (full damping of the boost) while current peers get 3×, so it drops below any recent paper whose keyword match is within a 3× band of it.

This ratio is between *ages*, so it holds as "now" advances: a current paper vs a 25-year-old paper stays ≈3:1 next year too (the literal years shift, the age relationship doesn't).

### 5.5 Escalation lever (not the default)

Keep one more flag value, `strong` = pure multiplicative decay (`final = bm25 × g`, no constant floor), available as a no-redeploy lever if iteration shows `gentle` still can't move a very-high-BM25 evergreen hit. It damps old papers toward (never to) zero — more aggressive, riskier for foundational work. Off unless explicitly set. Emitted as a single filtered gauss so missing-year stays neutral the same way it does under `gentle`:

```jsonc
{ "function_score": {
    "query": { /* the existing bool, unchanged */ },
    "functions": [
      { "filter": { "exists": { "field": "year" } },
        "gauss": { "year": { "origin": 2026, "offset": 2, "scale": 8, "decay": 0.5 } } }
    ],
    "score_mode": "multiply",   // single function; multiply == sum here
    "boost_mode": "multiply"    // final = bm25 × g(year);  missing year → no function → 1×
}}
```

---

## 6. Flag and rollout — ship on, iterate

New flag in `lib/api/search-flags.ts`, resolver alongside the others:

```ts
export type PubRecencyMode = "off" | "gentle" | "strong";

/** Issue #645 — recency tilt on the pub-tab Relevance sort. Wraps the
 *  relevance-path query in a function_score gauss decay on `year`.
 *  Separate flag from SEARCH_PUB_TAB_* so it has an independent rollback.
 *  Default "gentle" (shipped on; best-guess calibration, iterate from there). */
export function resolvePubRecencyMode(): PubRecencyMode {
  const v = process.env.SEARCH_PUB_RELEVANCE_RECENCY;
  if (v === "off" || v === "gentle" || v === "strong") return v;
  return "gentle";
}
```

| Env | Effect |
|---|---|
| *(unset)* / `=gentle` | **Default.** Bounded-additive tilt, ceiling 3× (§5). |
| `=off` | One-flip rollback. No wrapper; `body.query` byte-identical to pre-feature. |
| `=strong` | Escalation lever (§5.5). |

**Single PR, on by default.** Per the owner's "ship our best guess and iterate" call, this does not ship dark behind a flag-flip gate. Iteration is a constant tweak (`W` / `scale`) or a flag flip to `strong`/`off` — no reindex, no redeploy of the index, consistent with the §Rollback-knobs section of `search-publications.md`.

**Existing-test migration (required, see §10):** the structural tests in `tests/unit/search-pub-query-shape.test.ts` read `body.query.bool.*` directly. Because the default is now `gentle`, those tests must set `SEARCH_PUB_RELEVANCE_RECENCY=off` in their setup so they keep asserting the *admission* bool (an orthogonal concern). The new recency wrapper is owned by the new test file.

---

## 7. Determinism: where `origin` comes from

`origin` is the current year — a moving value. Two consequences:

1. **No ETL precompute.** We deliberately do *not* index an `ageYears` / `recencyDecay` field. ADR-001 says precompute ranking *inputs* in ETL — `year` already is. The decay *origin* is inherently query-time; baking it at index time would drift until the next reindex and silently re-rank against a stale "now". The runtime gauss on the indexed `year` is cheap and always-fresh.
2. **Testability.** Source the year through an injectable clock so structural/snapshot tests pin it:
   ```ts
   const originYear = nowYear ?? new Date().getUTCFullYear();
   ```
   Tests pass `nowYear` (the implemented seam; simpler than fake timers) so the emitted `origin: 2026` is deterministic and §5.4 is reproducible in assertions. **Do not** inline a bare `new Date().getFullYear()` at the construction site without the injection seam — it makes the body untestable and drifts the snapshot every Jan 1. Implemented as an optional `nowYear?: number` param on `searchPublications`, defaulting to `new Date().getUTCFullYear()`.

---

## 8. Edge-case behavior

| # | Case | Behavior | Why |
|---|---|---|---|
| E1 | `year` is `null` (rare; `year Int?`) | The gauss carries a `filter: { exists: { field: "year" } }`, so for a missing-year doc the gauss function is **not applied**: under `gentle`'s `sum` only the constant `{weight:1}` contributes → **1×**; under `strong` no function applies → function_score neutral → **1×**. | We **don't** rely on OpenSearch's missing-field default. Under `gentle`'s `sum`, a neutral 1.0 from the decay would read as max freshness (`1 + 2·1 = 3×`) and float unknown-date papers to the top — the explicit `exists` filter forces the floor instead. Locked by test T7. |
| E2 | `year` > origin (ahead-of-print / epub `year`, e.g. 2027 today) | Within the offset plateau (\|2026−2027\|=1 ≤ 2) → factor 1.0 → full 3×. Never penalized. | Gauss is symmetric; offset≥2 absorbs the look-ahead. |
| E3 | sort = `year` / `citations` / `impact` / `recency` (explicit sort) | **No wrapper.** `sortClause` non-empty → `_score` overridden anyway; we also skip the `function_score` so those bodies stay byte-identical and we don't pay scoring cost. | The tilt is a property of *Relevance*, not of explicit sorts. |
| E4 | `queryShape = concept_expanded` (admission in top-level `should`+msm:1, `must` empty) | Wrapper goes around the **whole `query`** → works unchanged; a stale paper admitted via a MeSH descendant is damped too (G4). | Wrapping `query` is shape-agnostic, like the People wrapper at `:1051`. |
| E5 | `queryShape = concept_filtered` (strict) / §1.2 | Same — wrapper around `query`. This **changes the strict-mode body while the flag is on**; the §7.2 "strict body byte-identical" guarantee is re-stated as "byte-identical modulo the recency wrapper, which is absent when `…=off`." | The guarantee's purpose (clean rollback) is preserved: `=off` restores byte-identity. |
| E6 | `opts.countOnly` (inactive-tab badge) | Use the **unwrapped** `query` (existing `size:0` count body at `:1593`). | Scoring is irrelevant to a count; decay multiplies scores, never changes the matched set → the total is provably identical. |
| E7 | Facet aggregations (`aggBoolFor`, `:1550`) | Unchanged — aggs already run against the **unscored** bool. | Decay touches `_score` only; bucket counts reflect admission, not ranking. |
| E8 | Very strong old match (legitimate foundational paper, high BM25) | Retains ≥1× BM25 and can still rank #1 if its match dominates by >3×. | Why `gentle` (floor 1×, ceiling 3×) is the default, not `strong` (G2). |

---

## 9. Interaction with the MeSH-lag gap (call out, don't pretend to fix)

`search-publications.md` documents that NLM applies MeSH headings 6–18 months late, so the newest papers often *fail* concept-expanded admission (no `meshDescriptorUi`). Recency-tilting **re-scores the admitted set only** — it cannot surface a recent paper that was never admitted. So this SPEC makes admitted-recent papers rank higher but does **not** close the lag gap (that remains the abstract-BM25 fallback path described upstream). Stated so the §11 verification doesn't credit/blame the tilt for an admission effect.

---

## 10. Test matrix

New file `tests/unit/search-pub-recency.test.ts` (mirrors the capture-the-body harness in `search-pub-query-shape.test.ts`). All assert on the body emitted by `searchPublications` with `nowYear: 2026` passed for a deterministic origin. **Shipped — all 9 cases green.**

| # | Flag | sort | Assert |
|---|---|---|---|
| T0 | — | — | **Migration:** `search-pub-query-shape.test.ts` sets `…=off` via file-level hooks → its `body.query.bool.*` assertions are unchanged. |
| T1 | `off` | relevance | `body.query` has **no** `function_score`; `recencyMode="off"`, `recencyOriginYear=null` (rollback assertion). |
| T2 | `gentle` (default) | relevance | `function_score.functions = [{weight:1}, {filter:{exists:{field:"year"}}, gauss:{year:{origin:2026,offset:2,scale:8,decay:0.5}}, weight:2}]`; `score_mode:"sum"`, `boost_mode:"multiply"`; inner `query.bool` is the un-wrapped admission; `recencyOriginYear=2026`. |
| T3 | `strong` | relevance | `function_score.functions = [{filter:{exists:{field:"year"}}, gauss:{year:{…}}}]` (single, no `{weight:1}` floor); `boost_mode:"multiply"`. |
| T4 | `gentle` | `year` | **No** `function_score` (E3); `sort:[{year:"desc"}]`; `recencyOriginYear=null`. |
| T5 | `gentle` | relevance, `countOnly` | count body has `size:0` and the unwrapped `query.bool` (E6). |
| T6 | `gentle` | relevance, `queryShape=concept_expanded` | `function_score.query.bool` carries the 4-clause `should`+`msm:1` admission, no `must` (E4). |
| T7 | `gentle` | relevance, missing-year | the gauss function carries `filter:{exists:{field:"year"}}` (E1). |
| T8 | parsing | — | `resolvePubRecencyMode()` maps off/gentle/strong verbatim; unset and garbage → `"gentle"`. |
| T9 | calibration | — | recompute `M` from the **emitted** gauss params: `M(2024)≈3`, `M(2024)/M(2001)≈3`, `M(1999)∈[1,1.1)` (guards against a constant edit silently breaking the anchor). |

Telemetry wiring (`recencyMode` / `recencyOriginYear` on the `search_query` log line) is asserted in `tests/unit/analytics-search-log.test.ts`.

---

## 11. Post-ship verification & iteration

We ship the best-guess constants; verify on real data and tune `W`/`scale` if needed (no reindex).

**(a) Eyeball the reproducer** — confirm the 1999 `cancer` paper is no longer top-3 on `=gentle`, and a domain reader doesn't see a *current* right-answer pushed down. Flip `=off` to A/B against today.

**(b) Corpus shape** — canonical DB (`mysql --no-defaults --socket=/tmp/mysql.sock -u paulalbert scholars`):

```sql
-- Year histogram of the indexed pub corpus (is the boost zone where the mass is?)
SELECT year, COUNT(*) AS pubs
FROM publication
WHERE year IS NOT NULL
GROUP BY year ORDER BY year DESC;

-- NULL-year blast radius (E1)
SELECT COUNT(*) AS null_year_pubs FROM publication WHERE year IS NULL;
```

**(c) Characterize the evergreen-old hits** the tilt is meant to demote:

```sql
-- Old-but-loud "cancer" candidates: the papers BM25 floats up today.
-- Cross-check how far §5.4 should push the pre-2005 ones.
SELECT pmid, year, citation_count, LEFT(title, 90) AS title
FROM publication
WHERE (title LIKE '%cancer%' OR abstract LIKE '%cancer%')
  AND year IS NOT NULL
ORDER BY (year < 2010) DESC, citation_count DESC
LIMIT 40;
```

**(d) Latency** — a single `function_score` over an indexed numeric is sub-millisecond; assert the §3.1(c) `searchLatencyMs` guardrail in `search-publications.md` doesn't regress, don't assume.

**Tuning levers if it feels wrong** (all no-redeploy): raise/lower `W` to change the ceiling (3× ↔ stronger/weaker), raise/lower `scale` to widen/narrow the boost zone, or flip to `strong` for hard demotion of evergreen-old hits.

---

## 12. Telemetry

Add to the existing `search_query` log line (`search-publications.md` §Telemetry):

```jsonc
"recencyMode": "gentle",          // off | gentle | strong  (resolved)
"recencyOriginYear": 2026         // the origin actually used (catches clock/seam bugs)
```

Lets the post-ship retro plot rank-position-vs-year and confirm the tilt is acting with the right origin.

---

## 13. Doc touchpoints (done)

- ✅ `docs/search-publications.md` → **Sort options** table now notes the recency-tilted Relevance; flag added to **Rollback knobs**; `recencyMode`/`recencyOriginYear` added to the telemetry block.
- ✅ `docs/search.md` → relevance-computation section notes the recency multiplier on the pub-tab relevance path.
- ✅ `lib/api/search-flags.ts` → `resolvePubRecencyMode()` resolver, house-style comment block.

---

## 14. Decisions (resolved 2026-06-01)

1. **Composition / strength** — `gentle` bounded-additive (keyword stays primary, old papers floored at 1×), tuned to a **3:1 current-vs-2001 ratio**: `W=2` (ceiling 3×), `offset=2`, `scale=8`, `decay=0.5`. `strong` retained as an escalation lever (§5.5).
2. **Rollout** — ship **on by default** (`gentle`) in a single PR with our best-guess constants; iterate via the §11 levers. Not staged behind a dark flag.
3. **Tuning surface** — constants hardcoded; one tri-valued flag (`off`/`gentle`/`strong`). Revisit only if iteration wants per-deploy `scale`/`W` tuning.
