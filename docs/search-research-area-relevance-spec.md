# Search: promote Research-Area concentration in People ranking

**Status:** Draft spec — awaiting approval before implementation.
**Author:** (investigation 2026-06-28)
**Scope:** `/search` People (Scholars) tab ranking only. Publications/Funding tabs
unchanged. Companion to the merged **evidence-rows** work (#1334, `SEARCH_EVIDENCE_ROWS`):
that fixed *how a matched scholar is explained* ("match evidence"); this fixes *which
scholars rank, and in what order* ("relevance"). The two are independent.

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
| **Research Area** | Aurora rollup `getTopScholarsForTopic` / `getTopScholarsForSubtopic` over `publication_topic` (`lib/api/topics.ts`) — **graded distinct-pmid count**, D-13/D-14 first/senior carve | **not consulted by People search at all** — it lives in a different store (Aurora), feeds the topic *page*, never the People index ranking |

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

### 3.1 Mechanism — graded concentration boost in the existing `function_score`

When the People query is topic/hybrid shape **and** the query resolved to a Research
Area (parent topic) and/or subtopic above a confidence floor:

1. **Resolve the area.** `matchQueryToTaxonomy` already ranks matched areas for the
   header chip (#709, `lib/api/search-taxonomy.ts`). Take the **top** matched
   parent-topic id (and subtopic id if one resolved) and its match strength. Proceed
   only if strength ≥ `AREA_BOOST_MIN_CONFIDENCE` (OQ-6).
2. **Pull the area's ranked scholars** from the existing **cached** rollup — a lean
   projection of `getTopScholarsForSubtopic` (preferred when a subtopic resolved) else
   `getTopScholarsForTopic`: `[{ cwid, areaPubs }]`, top `AREA_BOOST_TOP_N` (e.g. 200).
   No card hydration — just cwid + distinct-pmid count.
3. **Apply the concentration floor.** Drop scholars with `areaPubs < AREA_BOOST_MIN_PUBS`
   (e.g. 3). This is what kills "1 of 286": a single tangential pub earns **no** boost.
4. **Bucket by concentration and boost.** Add tiered `filter`/`weight` clauses to the
   **prominence `function_score`** (the slot already wrapping the topic body,
   `lib/api/search.ts` ~2060), keyed on cwid:

   ```
   { filter: { terms: { cwid: tierHi  } }, weight: AREA_BOOST_W_HI  }   // areaPubs ≥ 20
   { filter: { terms: { cwid: tierMid } }, weight: AREA_BOOST_W_MID }   // 8–19
   { filter: { terms: { cwid: tierLo  } }, weight: AREA_BOOST_W_LO  }   // 3–7
   ```

   Buckets (not a continuous score) keep the query small and the weights legible/
   tunable. Additive within the function_score, so it composes with prominence the same
   way the §6.1.3 attribution boost does — graded concentration can now overcome the
   `ln1p(publicationCount)` lift that today floats generalists.

**Why this is reorder-only by construction:** a `function_score` `filter` clause scores
only docs *already* in the result set; a cwid not matched by the query's `must`/`filter`
contributes nothing. So the MVP cannot change the total or the facets — only the order
of who's already there. (Admission/recall is OQ-1.)

**Why buckets, not the binary `terms` boost the concept axis uses:** the concept axis
failed *because* it's binary. A uniform cwid boost would repeat that mistake. Buckets
restore the graded property that makes the topic page correct.

### 3.2 Gating (inert where it shouldn't fire)

- Topic/hybrid shape only — never name or department shape.
- Only when an area resolves above `AREA_BOOST_MIN_CONFIDENCE`.
- Concentration floor `AREA_BOOST_MIN_PUBS` per scholar.
- Bounded to `AREA_BOOST_TOP_N`; if the area has more qualifying scholars than N,
  `log()` the truncation (no silent cap) — beyond N, lexical order stands.
- Flag off ⇒ no rollup fetch, no clauses, byte-identical query.

### 3.3 Granularity — prefer subtopic when one resolved (OQ-2)

A broad query → broad area is fine (`children's health` → Pediatrics & Neonatology).
But a narrow query that merely rolls up to a broad area would get flooded by area
generalists. So when `matchQueryToTaxonomy` resolves a **subtopic**, boost by
**subtopic** concentration (`getTopScholarsForSubtopic`); else fall back to parent-area
concentration. Subtopic is the more precise, false-positive-resistant signal.

---

## 4. Files touched (estimate)

| File | Change |
|---|---|
| `lib/api/search.ts` | tiered area-concentration clauses in the prominence `function_score`; gate on resolved area + floor; thread the cwid→areaPubs map in via opts |
| `lib/api/topics.ts` | lean `getAreaScholarConcentration(topicId, subtopicId?, topN)` → `[{cwid, areaPubs}]` reusing the existing rollup query (no card hydration); reuse the cache |
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
- Bucketing: a 26-pub scholar lands in `tierHi`, a 4-pub in `tierLo`, a 2-pub gets **no**
  clause (floor).
- Gate: name-shape and dept-shape queries emit no area clauses; flag-off query is
  byte-identical to master.
- Subtopic preference: when a subtopic resolves, the concentration map comes from
  `getTopScholarsForSubtopic`, not the parent.
- Reorder-only invariant: with the flag on, `total` and facet counts equal the flag-off
  run for the same query (no admission).

**Eval (staging, flag-off vs flag-on)** — run `children's health` + a set of
area-mapping queries (e.g. *heart failure*, *breast cancer*, *substance use disorder*,
*medical education*) and assert:
- (a) the area's known top scholars (from `/topics/<slug>`) rise into top-K;
- (b) prolific off-topic / "1 of M" rows fall out of top-K;
- (c) **control queries** that don't map to an area (a name; a narrow method like
  *Seahorse metabolic flux*) are byte-identical (flag inert);
- (d) snapshot the top-20 ordering delta per query for review.

**Audit SQL (preview the boost source vs. the topic page)** — for a parent topic,
confirm the concentration ranking the boost will use matches the topic page's. Mirror
the **exact** D-13/D-14 first/senior-author carve from `getTopScholarsForTopic` (do not
invent columns — copy its predicate):

```sql
-- Top scholars by distinct-pmid concentration for one Research Area.
-- NOTE: add the D-13/D-14 authorship-position carve exactly as getTopScholarsForTopic applies it.
SELECT cwid, COUNT(DISTINCT pmid) AS area_pubs
FROM publication_topic
WHERE parent_topic_id = 'pediatrics_neonatology'
  -- AND <first-or-senior-author carve — mirror getTopScholarsForTopic>
GROUP BY cwid
ORDER BY area_pubs DESC
LIMIT 25;
```

The result should match the order shown on `/topics/pediatrics_neonatology`
("Nellis · 26 pubs tagged", …). If it doesn't, the boost source is wrong — stop.

---

## 7. Open questions

- **OQ-1 — reorder vs admission.** MVP reorders scholars already in the set (no
  count/facet change). If the area's top experts aren't in the lexical set for a query,
  reorder can't surface them; a follow-up `should`/`terms{cwid}` admission (gated like
  #726, but topic-sourced) would add recall **at the cost of changing counts/facets**.
  Recommend: **reorder-first MVP**; measure how often experts are absent before
  investing in admission.
- **OQ-2 — granularity.** Recommend subtopic-when-resolved, else parent area (§3.3).
- **OQ-3 — blend vs new scope.** Recommend blending into the default Relevance sort, not
  a discoverable "Research area" scope (a scope users must find won't fix the default).
- **OQ-4 — weights & floor.** `AREA_BOOST_W_{HI,MID,LO}`, `AREA_BOOST_MIN_PUBS`,
  bucket cutoffs, `AREA_BOOST_TOP_N` — all eval-driven; the §6 eval tunes them.
- **OQ-5 — interaction with #726 MeSH escalation.** Orthogonal: escalation is
  sparse-admission, this is dense-reorder. They can co-fire (both add additive
  function-score weight); confirm no surprising double-lift in the eval.
- **OQ-6 — area-match confidence threshold.** Reuse the #709 area ranking; pick a
  strength floor (`AREA_BOOST_MIN_CONFIDENCE`) so a weak/incidental area mapping doesn't
  trigger a boost. The "· 387" chip count is itself a coarse strength cue.

---

## 8. Risk / restraint

The architecture intentionally gated concept influence to sparse pages to protect
healthy dense lexical rankings (the #726 "ranking-restraint" guarantee). This spec
reshapes dense pages **on purpose** — but stays restraint-safe by: (a) being
reorder-only (no set/facet change); (b) firing only on a confident area match with a
per-scholar concentration floor; (c) shipping behind a default-off flag with a
control-query eval proving non-area queries are byte-identical before any prod flip.
