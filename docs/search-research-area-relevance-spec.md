# Search: promote Research-Area concentration in People ranking

**Status:** Draft spec — awaiting approval before implementation.
**Author:** (investigation 2026-06-28)
**Scope:** `/search` People (Scholars) tab ranking only. Publications/Funding tabs
unchanged. Companion to the merged **evidence-rows** work (#1334, `SEARCH_EVIDENCE_ROWS`):
that fixed *how a matched scholar is explained* ("match evidence"); this fixes *which
scholars rank, and in what order* ("relevance"). The two are independent.

**Decisions (locked 2026-06-28):**
- **D1 — boost magnitude = relevance(term match) × breadth(coverage).** Not flat
  count buckets. This equals the topic page's existing per-scholar `total` (§3.1).
- **D2 — granularity is not a hard "prefer subtopic" rule.** It falls out of the
  relevance×coverage score at whichever topic level the query resolved to (§3.3).
- **D3 — blend into the default Relevance sort.** No new user-facing scope.
- **D4 — reorder-only MVP** (no result-set/facet change); admission is a follow-up (OQ-1).

---

## 1. Problem

For a topic query that maps cleanly to a Research Area, the People tab ranks the
wrong scholars at the top. Worked example — `children's health` (staging,
2026-06-28):

- The query resolves to the Research Area **Pediatrics & Neonatology** (the chip
  "Pediatrics & Neonatology · 387" is already drawn on the result page) and to the
  MeSH descriptor **Child Health**.
- **Default ("Word + concepts")**: a prolific Infectious-Diseases author (161 pubs,
  no child-health focus) ranks **#2**, above an actual Pediatrics professor. His
  evidence resolves to `none`.
- **"Concept only"**: better, but the top is still prolific generalists with **"1 of
  286 / 1 of 257 publications tagged Child Health"** — a *single tangential* paper —
  while a focused child psychiatrist ("1 of 4") sinks.
- **By contrast**, the Research-Area page `/topics/pediatrics_neonatology` ranks the
  *right* people — Nellis (#1, "26 pubs tagged"), Grinspan, Traube, Permar — because
  it ranks by **graded concentration in the area**, not a binary token/descriptor hit.

### 1.1 Root cause — the ranking axis is wrong, and the right axis isn't wired in

Three matching axes exist; the strongest one never reaches People ranking:

| Axis | Mechanism (today) | Why it mis-ranks |
|---|---|---|
| **Keyword** | BM25 `cross_fields` over people text (`lib/api/search.ts`) | a generic token ("child"/"health") admits off-topic authors; prominence floats them |
| **Concept (MeSH)** | `terms{publicationMeshUi: descendantUis}`, **escalation-gated** to sparse pages (#726, `MESH_ESCALATION_THRESHOLD=50`) | **binary per-descriptor** — "1 of 286 tagged" == "100 of 130 tagged"; on a dense page (815) it doesn't even fire |
| **Research Area** | Aurora rollup `getTopScholarsForTopic` / `getTopScholarsForSubtopic` over `publication_topic` (`lib/api/topics.ts`) — **graded relevance×coverage** (`Σ` per-pub topic score, D-13/D-14 first/senior carve) | **not consulted by People search at all** — it lives in a different store (Aurora), feeds the topic *page*, never the People index ranking |

The prominence `function_score` (`publicationCount` via `ln1p`, + faculty + active-grants;
`PEOPLE_PROMINENCE_*` in `lib/search.ts`) then multiplies whatever weak topical score
the first two axes produce, so **prolific-but-off-topic beats focused-but-smaller**.

The Research-Area rollup is the high-precision, *graded* signal that already ranks the
right people on the topic page. The fix is to let it shape People ranking when the
query maps to an area.

---

## 2. Goals / non-goals

**Goals**
- When a topic query maps to a Research Area (and/or subtopic) with a confident match,
  rank scholars by their **concentration in that area** — lifting the focused experts
  and demoting prolific generalists with one tangential pub.
- Reuse the existing Aurora rollup (the topic page's ranking) — **no reindex**, no new
  ETL field for the MVP.
- Keep the change inert on queries that don't map to an area (names, departments,
  narrow methods), and byte-identical with the flag off.

**Non-goals**
- **No result-SET change in the MVP.** The boost reorders scholars *already* matched;
  it does not admit new scholars (that's the OQ-1 follow-up). So total count and facet
  counts are unchanged.
- Not surfacing `publication_topic.score` anywhere — the boost uses distinct-pmid
  **count/rank**, never the internal per-topic relevance score (internal-only).
- Not a new user-facing scope. Promotion blends into the default Relevance sort
  (OQ-3); the existing Exact/Word+concepts/Concept-only toggle is untouched.
- Display of *why* a scholar matched is the merged evidence-rows feature (#1334), out
  of scope here.

---

## 3. Design

### 3.1 The boost magnitude — relevance × coverage (D1)

**Per scholar, the boost = (relevance of term match) × (breadth of coverage).** This is
not a new metric to invent — it is *already computed*, exactly, by the topic page's
scholar ranking (`getTopScholarsForTopic` / `getTopScholarsForSubtopic`,
`lib/api/topics.ts`):

```
total(scholar) = Σ  scorePublication( reciteraiImpact = publication_topic.score,
       pub ∈ scholar's      "top_scholars" recency curve )
   first/last-authored,
   recent, in-topic pubs
```

- each pub contributes its **per-pub term-relevance** (`publication_topic.score`, the
  internal ReCiterAI parent-topic score, recency-weighted) — the *relevance* factor;
- **summing over the scholar's in-topic pubs** is the *coverage/breadth* factor;
- so `total = (mean per-pub relevance) × (count) = relevance × coverage` — precisely D1,
  and precisely the number that ranks Nellis #1 on the page you validated.

Reusing `total` (rather than a fresh formula) **guarantees the People-search order
matches the topic page** for the matched area — the behaviour you confirmed is good.

> **Internal-score note:** `publication_topic.score` is internal-only — used here purely
> as ranking input via the existing `scorePublication`, never displayed (the "match
> evidence" line is the merged #1334 feature). Consistent with the internal-only rule.

### 3.2 Mechanism — inject `total` into the People `function_score`

When the People query is topic/hybrid shape **and** the query resolved to a topic
(parent area and/or subtopic) above `AREA_BOOST_MIN_CONFIDENCE` (OQ-6):

1. **Resolve the matched topic.** `matchQueryToTaxonomy` already ranks matched areas for
   the header chip (#709, `search-taxonomy.ts`). Take the top matched topic id (subtopic
   if one resolved, §3.3) and its match strength.
2. **Pull the ranked scholars + their `total`** from the existing **cached** rollup via
   a lean accessor `getAreaScholarConcentration(topicId, …)` that reuses the
   `getTopScholarsForTopic` aggregation but returns `[{ cwid, total }]` (today that
   function computes `total` then discards it — just expose it), top `AREA_BOOST_TOP_N`
   (e.g. 200). No card hydration.
3. **Encode `total` as weight tiers keyed on cwid** in the **prominence
   `function_score`** (the slot already wrapping the topic body, `search.ts` ~2060).
   OpenSearch can't take a continuous per-doc external weight without an index field, so
   bucket `total` into a few tiers — but the tiering is by **relevance×coverage `total`**,
   not raw count:

   ```
   { filter: { terms: { cwid: tierHi  } }, weight: AREA_BOOST_W_HI  }   // top total band
   { filter: { terms: { cwid: tierMid } }, weight: AREA_BOOST_W_MID }
   { filter: { terms: { cwid: tierLo  } }, weight: AREA_BOOST_W_LO  }
   ```

   Additive within the function_score, composing with prominence the same way the
   §6.1.3 attribution boost does — so relevance×coverage can overcome the
   `ln1p(publicationCount)` lift that today floats generalists. (Continuous-weight
   alternative = reindex `total` as a doc field + `script_score`/`field_value_factor` —
   the "proper path", OQ-7.)

**A scholar with one tangential pub never qualifies** — their `total` is tiny (one
low-relevance term, recency-damped), so they fall below the lowest tier. That is what
kills the "1 of 286" case, *without* a separate count floor: relevance×coverage already
encodes it.

**Reorder-only by construction (D4):** a `function_score` `filter` clause scores only
docs *already* in the result set; a cwid not matched by the query's `must`/`filter`
contributes nothing. The MVP cannot change the total or facets — only order.

### 3.2 Gating (inert where it shouldn't fire)

- Topic/hybrid shape only — never name or department shape.
- Only when an area resolves above `AREA_BOOST_MIN_CONFIDENCE`.
- Concentration floor `AREA_BOOST_MIN_PUBS` per scholar.
- Bounded to `AREA_BOOST_TOP_N`; if the area has more qualifying scholars than N,
  `log()` the truncation (no silent cap) — beyond N, lexical order stands.
- Flag off ⇒ no rollup fetch, no clauses, byte-identical query.

### 3.3 Granularity — no hard subtopic rule; the score carries it (D2)

We do **not** hard-prefer subtopic. We compute relevance×coverage `total` at whichever
level the query resolved to: if `matchQueryToTaxonomy` resolved a **subtopic**, use the
subtopic `total` (`getTopScholarsForSubtopic`) — its per-pub relevance is naturally more
term-specific, so a narrow query won't get flooded by broad-area generalists; if only a
parent area resolved, use the parent-area `total`. Either way the magnitude is the same
relevance×coverage quantity (D1) — granularity changes *which* pubs count and *how
relevant* each is, not the formula.

---

## 4. Files touched (estimate)

| File | Change |
|---|---|
| `lib/api/search.ts` | `total`-tiered cwid clauses in the prominence `function_score`; gate on resolved topic; thread the cwid→`total` map in via opts |
| `lib/api/topics.ts` | lean `getAreaScholarConcentration(topicId, subtopicId?, topN)` → `[{cwid, total}]` — reuse the `getTopScholarsForTopic`/`Subtopic` aggregation and **expose the `total` it already computes** (currently discarded); reuse the cache |
| `lib/api/search-taxonomy.ts` | expose the top resolved parent-topic/subtopic id + match strength to the People path (already computed for #709) |
| `app/api/search/route.ts` | resolve flag; when topic-shape + area resolved + flag on, fetch concentration map and pass into `searchPeople` opts |
| `lib/api/search-flags.ts` | `resolveSearchPeopleAreaBoost()` (`off`/`on`; or `off`/`reorder`/`admit` if OQ-1 lands here) |
| `lib/search.ts` | `AREA_BOOST_*` weight/threshold constants |
| `cdk/lib/app-stack.ts` | `SEARCH_PEOPLE_AREA_BOOST` per-env (+ `cd cdk && npm ci && npm test -- -u` snapshot regen) |
| `tests/unit/search-*.test.ts` | bucket boost, gate, concentration floor, flag-off byte-identical, name/dept inert, subtopic-preferred-over-parent |

---

## 5. Flags & rollout

- **`SEARCH_PEOPLE_AREA_BOOST`** (default **off**), `=== "on"` opt-in, staging-first.
  Wire per-env in `cdk/lib/app-stack.ts` (flag parity: local `.env.local` == deployed).
- Rollout: land dark → flip **staging** via `cdk deploy --exclusively Sps-App-staging
  -c env=staging` → run the §6 eval → prod flip after soak.
- No reindex; resolve-time only (one cached Aurora rollup read per area-resolved query).

---

## 6. Testing & eval

**Unit**
- Tiering by `total`: a high-`total` scholar lands in `tierHi`, a low-`total` in
  `tierLo`; a one-tangential-pub scholar (tiny `total`) gets **no** clause.
- `getAreaScholarConcentration` returns the **same `total`/order** as the topic page's
  `getTopScholarsForTopic` for the same topic (shared aggregation).
- Gate: name-shape and dept-shape queries emit no area clauses; flag-off query is
  byte-identical to master.
- Granularity: when a subtopic resolves, the `total` map comes from
  `getTopScholarsForSubtopic`, not the parent.
- Reorder-only invariant: with the flag on, `total` (result count) and facet counts
  equal the flag-off run for the same query (no admission).

**Eval (staging, flag-off vs flag-on)** — run `children's health` + a set of
area-mapping queries (e.g. *heart failure*, *breast cancer*, *substance use disorder*,
*medical education*) and assert:
- (a) the area's known top scholars (from `/topics/<slug>`) rise into top-K;
- (b) prolific off-topic / "1 of M" rows fall out of top-K;
- (c) **control queries** that don't map to an area (a name; a narrow method like
  *Seahorse metabolic flux*) are byte-identical (flag inert);
- (d) snapshot the top-20 ordering delta per query for review.

**Audit SQL (approximate preview of the boost source)** — the exact magnitude is
`Σ scorePublication(…)` with the app-side `"top_scholars"` recency curve, so pure SQL is
only an approximation (it omits the recency transform). Use it to sanity-check the source
table and carve; **exact parity comes from reusing `getTopScholarsForTopic`**, not this
query. Carve mirrors that function: `authorPosition IN ('first','last')` (D-13),
`year >= RECITERAI_YEAR_FLOOR` (D-15), scholar active/non-deleted/FT-eligible (D-14),
publication type not in `FEED_EXCLUDED_TYPES`.

```sql
-- APPROX: SUM of per-pub topic relevance (no recency curve) ≈ relevance × coverage.
SELECT pt.cwid,
       COUNT(DISTINCT pt.pmid)            AS area_pubs,      -- coverage
       SUM(pt.score)                      AS approx_total    -- ≈ relevance × coverage
FROM publication_topic pt
JOIN scholar s        ON s.cwid = pt.cwid
JOIN publication p    ON p.pmid = pt.pmid
WHERE pt.parent_topic_id = 'pediatrics_neonatology'
  AND pt.author_position IN ('first','last')
  AND pt.year >= /* RECITERAI_YEAR_FLOOR */ 0
  AND s.deleted_at IS NULL AND s.status = 'active'
  -- AND s.role_category IN (<TOP_SCHOLARS_ELIGIBLE_ROLES>)
  -- AND p.publication_type NOT IN (<FEED_EXCLUDED_TYPES>)
GROUP BY pt.cwid
ORDER BY approx_total DESC
LIMIT 25;
```

The order should *approximate* `/topics/pediatrics_neonatology` ("Nellis · 26 pubs
tagged", …). Exact-match the recency-weighted order by reusing the function, not the SQL.

---

## 7. Open questions

- **OQ-1 — reorder vs admission.** *Resolved → D4 (reorder-only MVP).* Follow-up: if the
  area's top experts aren't in the lexical set for a query, reorder can't surface them; a
  topic-sourced `should`/`terms{cwid}` admission (gated like #726) adds recall **at the
  cost of changing counts/facets**. Measure how often experts are absent before building it.
- **OQ-2 — granularity.** *Resolved → D2 (score carries it, §3.3).*
- **OQ-3 — blend vs new scope.** *Resolved → D3 (blend into default Relevance).*
- **OQ-4 — weights & tier cutoffs.** `AREA_BOOST_W_{HI,MID,LO}`, the `total` band
  boundaries, and `AREA_BOOST_TOP_N` — all eval-driven; the §6 eval tunes them. (No
  separate pub-count floor: relevance×coverage `total` already starves the
  one-tangential-pub case.)
- **OQ-5 — interaction with #726 MeSH escalation.** Orthogonal: escalation is
  sparse-admission, this is dense-reorder. They can co-fire (both add additive
  function-score weight); confirm no surprising double-lift in the eval.
- **OQ-6 — topic-match confidence threshold.** Reuse the #709 area ranking; pick a
  strength floor (`AREA_BOOST_MIN_CONFIDENCE`) so a weak/incidental topic mapping doesn't
  trigger a boost. The "· 387" chip count is itself a coarse strength cue.
- **OQ-7 — continuous weight (the "proper path").** Tiering `total` into 3 bands is an
  OpenSearch encoding workaround. Denormalizing each scholar's per-topic `total` into the
  people index (an ETL field + reindex) would allow a true continuous `script_score` /
  `field_value_factor` — smoother ordering, no per-query Aurora read. Worth it only if the
  tiered MVP proves the signal; defer.

---

## 8. Risk / restraint

The architecture intentionally gated concept influence to sparse pages to protect
healthy dense lexical rankings (the #726 "ranking-restraint" guarantee). This spec
reshapes dense pages **on purpose** — but stays restraint-safe by: (a) being
reorder-only (no set/facet change); (b) firing only on a confident topic match, with
relevance×coverage `total` starving the one-tangential-pub case; (c) shipping behind a
default-off flag with a
control-query eval proving non-area queries are byte-identical before any prod flip.
