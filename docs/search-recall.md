# Search recall — why some obvious queries return too few people

**What this answers.** "Why does searching **`covid19`** return 9 scholars when **`covid-19`** returns 1,425?" and "Why does **`tylenol`** return *nobody* when WCM clearly has acetaminophen researchers?" Two independent recall gaps on the People (and Funding) tabs, their root causes, the fixes, and the design for the concept-recall enhancement. Companion to [`search.md`](./search.md) (how results are *ranked*) and [`taxonomy-aware-search.md`](./taxonomy-aware-search.md) (MeSH re-weighting). This doc is about *admission* — who gets into the result set in the first place.

**Status (2026-06-03).**
- **Cause A — alphanumeric tokenization:** fix in review — **#725 / PR #727**. Needs a reindex to take effect (see sequencing below).
- **Cause B — MeSH concept resolution is ranking-only:** design locked, implementation in progress — **#726**.
- Neither is the concept-scope gate from #718 (that's a separate, opt-in surface).

All counts below are live measurements against the dev index (`/api/search?type=people`, and OpenSearch `_analyze` / `_count`), re-confirmed on a second pass — not estimates.

---

## TL;DR

| Query | People today | Should be ~ | Cause |
|---|---|---|---|
| `covid19` | **9** | 1,425 | A — the analyzer fuses `covid19` into one token that never matches the indexed `COVID-19` (`covid`+`19`) |
| `tylenol` | **0** | ≥20 | B — resolves to the *Acetaminophen* descriptor, but that resolution only re-ranks; it never *admits* |
| `lou gehrig disease` | **1** | ~36 | B — resolves to *Amyotrophic Lateral Sclerosis* via an entry term; admission ignores it |

The two causes are orthogonal: A is a **lexical** (tokenizer) bug; B is a **semantic** (concept-admission) gap. A query can hit either or both.

---

## Cause A — alphanumeric tokenization (#725)

### Symptom
`covid19` → **9** people; `covid-19` → **1,425**. Identical across `match=exact|expanded|concept`, so it is **not** the #718 concept-scope gate. Funding shows the same: `covid19` → 0, `covid-19` → 103.

### Root cause
The People and Funding indices analyze text with a bare `standard` tokenizer (`scholar_text`, `funding_text` in [`lib/search.ts`](../lib/search.ts)) — `lowercase` + `english_stop` + `english_stemmer`, **no letter↔digit handling**. Live `_analyze`:

```
covid19  -> [covid19]      (one fused token)
COVID-19 -> [covid, 19]    (hyphen splits)
```

The MeSH heading "COVID-19" is indexed in `publicationMesh` as the two tokens `covid` (792 docs) + `19` (802 docs); the fused token `covid19` occurs in **zero** of them. So the query token never matches and admission floors at the 9 docs that literally wrote "COVID19".

It is **general and bidirectional** — whichever surface form the corpus indexes is the only one that matches:

| | glued query | hyphenated query |
|---|---|---|
| hyphen-dominant term | `covid19` 9, `sarscov2` 0, `il6` 16, `pdl1` 6 | `covid-19` 1425, `sars-cov-2` 464, `il-6` 128, `pd-l1` 126 |
| glued-dominant term | `p53` 231, `cd4` 227, `her2` 171 | `p-53` 5, `cd-4` 58, `her-2` 108 |

`pub_text` (Publications) was tested **clean** (`covid19` 3,749 ≈ `covid-19` 3,739) and is intentionally left alone.

### Fix
A **named** `alnum_delimiter` filter (`word_delimiter_graph` with `split_on_numerics` + `preserve_original` + word/number parts) followed by `flatten_graph`, added to `scholar_text` and `funding_text` at **index and search time**. It splits letter↔digit boundaries while keeping the fused original, so `covid19`, `covid-19`, and `covid 19` share a token set. No `catenate_*` — the standard tokenizer already strips hyphens, so there's nothing to re-join, and a duplicate same-position token skews BM25.

`scholar_suggest` (autocomplete) is **not** changed: it relies on keeping CWIDs like `pja9004` fused.

### Validation (throwaway reindex of the live people index, new analyzer)

| query | before | after |
|---|---|---|
| `covid19` | 9 | **1,424** |
| `covid-19` | 1,425 | 1,426 |
| `p53` | 231 | 232 (no balloon) |
| `p-53` | 5 | 257 (mirror recovers) |
| `diabetes` / `cardiology` | 691 / 126 | 691 / 126 (no regression) |
| bare `2` | 1,936 | 2,474 (+28%) |

396 search unit tests pass.

### ⚠️ Deploy sequencing (important)
This is an **index-time** analyzer change with **no `search_analyzer` override**, so the search side goes live the instant it deploys — `covid19` starts returning ~1,425 immediately (its split parts match the *old* hyphen-indexed docs) — **but glued-dominant terms (`p53`/`cd4`/`her2`) regress until the index is rebuilt**. Deploy the analyzer change and the `search:index:people` + `search:index:funding` reindex **together**. #725 stays open until the reindex lands.

### Known residual limits (accepted)
- **Multi-segment** hyphenated terms (`sars-cov-2`↔`sarscov2`, `pd-l1`↔`pdl1`) only partially reconcile — word_delimiter can't recover internal word boundaries. No worse than today.
- **Bare single-number** queries over-match modestly (`2` +28%) — degenerate inputs; real multi-token queries are unaffected (MSM `2<-34%` requires ≥2 tokens).

---

## Cause B — MeSH concept resolution is ranking-only (#726)

### The machinery that already exists
`resolveMeshDescriptor()` ([`lib/api/search-taxonomy.ts`](../lib/api/search-taxonomy.ts)) resolves a query to a MeSH descriptor via normalized **name + entry-term** matching, and it works well:

```
microbiome  -> Microbiota (D064307)    conf=entry-term  matched="Microbiome"
tylenol     -> Acetaminophen           conf=entry-term  matched="Tylenol"
2019 ncov   -> SARS-CoV-2 (D000086402) conf=entry-term  matched="2019-nCoV"
il6         -> Interleukin-6 (D015850) conf=entry-term  matched="IL-6"
covid19     -> COVID-19 (D000086382)   conf=exact
```

**How `microbiome → Microbiota` happens** (the entry-term pipeline, end to end):
1. NLM MeSH XML: descriptor D064307 is named "Microbiota"; its `<ConceptList>` lists "Microbiome", "Microbial Community", etc. as `<Term>`s.
2. [`etl/mesh-descriptors/parser.ts`](../etl/mesh-descriptors/parser.ts) — *"Every Term/String anywhere in ConceptList contributes to entryTerms."*
3. [`etl/mesh-descriptors/index.ts`](../etl/mesh-descriptors/index.ts) stores them in the `mesh_descriptor.entry_terms` JSON column.
4. The resolver builds a `byForm` map keyed on `normalizeForMatch(name | each entry term)` (lowercase + strip non-alphanumeric); the query hits the key the entry term registered.

### The gap
The resolved `descendantUis` are wired **ranking-only** — a ×1.5 `function_score` weight ([`lib/api/search.ts:950`](../lib/api/search.ts)) and a telemetry aggregation — they **never admit a document**. The only surface that admits via `publicationMeshUi` is the opt-in `scope === "concept"` gate (which the `/api/search` people branch ignores, per #718).

So entry-term resolution can't expand recall. `tylenol` returns **0** (nobody writes "Tylenol" in a paper) even though 20 scholars carry the Acetaminophen descriptor; `microbiome` *looks* fine (207, because it's a real English word) but only because the lexical path caught it — the resolution added nothing.

### Design — admit generously, rank by match type
Decision: set the sparse threshold at **T = 50** and make relevance reward the *type* of match, so weaker matches fill in **below** the precise ones instead of diluting the top. **Recall is an admission question; precision is a ranking question.**

**Admission:** when the lexical result is sparse (< 50), OR `{ terms: { publicationMeshUi: descendantUis } }` into the topic-template `must` (via a `should` + `minimum_should_match: 1`), so a scholar who carries the descriptor but didn't lexically match is still admitted.

**Ranking — the match-type reward ladder (strongest → weakest):**
1. **Lexical** — query terms present in the scholar's fields. Full BM25. Always on top.
2. **MeSH exact-name** descriptor — strong.
3. **MeSH anchored entry-term** (entry term + curated topic anchor) — medium.
4. **MeSH unanchored entry-term** — low (the floor tier).
   *(finer: a direct descriptor-UI match outranks a subsumed-descendant match.)*

Concept-only docs carry ~0 BM25, so they already sort beneath lexical hits; the tier weight (computed at query-build from the resolver's `confidence` + `curatedTopicAnchors`, threaded through `searchPeople`) just orders them and caps how near the lexical band they can climb. The existing flat ×1.5 attribution boost becomes this graduated weight.

**Why T=50 is safe with ranking:** `heart attack` (49 lexical) shows its 49 literal matches first and the broader Myocardial-Infarction descriptor people *below* — nothing good is pushed down. Escalation is a recall **floor** (don't hand someone a near-empty page), not a recall maximizer.

### What ranking does *not* solve — the one guard
**Wrong-resolution-on-an-empty-page.** If lexical ≈ 0 **and** the resolution is a low-confidence unanchored entry term that's *wrong*, the wrong cluster is all the user sees (ranked low, but alone). So admission keeps a **confidence floor**: don't admit an unanchored low-confidence resolution as the *sole* content. Exact / anchored resolutions are always fine.

### Where escalation fires — and where it correctly doesn't

| query | lexical | resolves to (entry term) | descriptor pop. | escalation |
|---|---|---|---|---|
| `tylenol` | 0 | Acetaminophen | 20 | **0 → 20** |
| `lou gehrig disease` | 1 | Amyotrophic Lateral Sclerosis | 36 | **1 → 36** |
| `shingles` | 1 | Herpes Zoster | 30 | **1 → 30** |
| `heart attack` | 49 | Myocardial Infarction | 180 | **none** (≥ T — don't dilute a real page) |
| `vitamin c` | 129 | Ascorbic Acid | 14 | **none** (lexical already broader) |
| `ringing in the ears` | 4 | *(no resolution)* | — | **none** (NLM has no matching entry term) |

### Boundaries
- The descriptor-UI rollup (`publicationMeshUi`) is **MEDLINE-only and min-evidence-filtered**, so it tops out *below* the lexical set (784 for covid vs the lexical 1,425). It complements, never replaces, Cause A's fix.
- It does nothing for **Funding** (no MeSH) or **non-descriptor** terms (`p53` doesn't resolve) — those rely on Cause A.
- Very informal phrases (`ringing in the ears`, `water on the brain`) don't resolve at all — a separate lay-synonym coverage gap, not addressed here.

---

## How the two relate
Cause A gives **lexical breadth + parity** (`covid19` == `covid-19`) across all fields, plus Funding. Cause B adds a **concept floor with synonym recall** (`tylenol`, `2019-nCoV`, `coronavirus disease 2019` find the right people). Once A lands, B's escalation fires only for genuinely niche concept queries — a quiet floor, not a common path.

## Design decisions (log)
- **Resolution drives ranking, then admission — not a replacement for lexical.** Lexical recall is broader and catches recent/non-MEDLINE pubs the descriptor rollup misses.
- **T = 50, not 10** — chosen deliberately *because* match-type ranking neutralizes dilution. Without that ranking, a lower threshold (~one page) would be the safer choice.
- **Confidence floor on admission** — the one failure mode ranking can't fix (wrong resolution + empty page).
- **`scholar_suggest` excluded from the alphanumeric split** — CWIDs must stay fused.

## Reproduce / validate
- Counts: `curl -s -G localhost:3002/api/search --data-urlencode q=<term> --data-urlencode type=people` → `.total`.
- Tokenization: OpenSearch `_analyze` with the candidate analyzer (`tokenizer: standard`, filter chain incl. `word_delimiter_graph`).
- Query behavior without touching the live alias: `_reindex` the live index into a throwaway index with the new mapping, query both, then delete it (the method used for the tables above).

## Tracking
- **#725** — alphanumeric tokenization fix (People + Funding). PR **#727**. Open until the post-deploy reindex lands.
- **#726** — MeSH descriptor-UI admission + match-type ranking. In progress.
- Related: #718 (concept-scope gate / API-ignores-scope), #298 (publications-side concept fallback), #642 (`mesh_curated_alias` layer), #259 (MeSH resolution + descendant subsumption).
