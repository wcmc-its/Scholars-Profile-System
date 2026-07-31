# People-search relevance ranking

How a query typed into the People tab becomes an ordered list of scholars. Written for an engineer with
no prior context on this subsystem.

Grounded at `origin/master` 63d56596. Every claim carries a `file:line` citation; if a line has drifted,
re-ground with `git show origin/master:<path>` rather than trusting the number.

This document is **descriptive** — it says what the code does. For what each layer is _allowed_ to do,
and the register of open violations, see [`search-relevance-contract.md`](./search-relevance-contract.md).
Changing ranking or evidence display means satisfying that contract, not just matching this description.

Scope: `searchPeople` (`lib/api/search.ts:1537`). The Publications and Funding tabs use
`searchPublications` / `searchFunding`, which share the MeSH resolver but none of the ranking machinery
described here. See [Traps](#traps).

## The formula

A people search runs one OpenSearch request whose `query` is a two-deep `function_score` sandwich around
a `bool`. Reading outward:

```
final = BM25(topic bool)
        x  MESH_ATTRIBUTION_WEIGHT[tier]      inner, multiply
        x  PEOPLE_METHOD_FAMILY_TAG_WEIGHT    inner, multiply
        x  productivity (1.2 | 1.1)           inner, multiply
        x  sparse decay (0.7)                 inner, multiply
        x  ( 1.0                              outer, sum -> multiply
            + ln(1 + publicationCount)                     [flag: see below]
            + 1.0   if personType == full_time_faculty     [flag]
            + 0.5   if hasActiveGrants
            + 3.0 | 1.5 | 0.75   if cwid in an area-concentration tier
            + 3.0   if the clinical filter matches )
```

The volume term has a second shape. Under `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped` (#2068, default
`off`, which is what both envs serve today) the `ln(1 + publicationCount)` line is replaced, on the
topic / hybrid / `unclassified` shapes only, by exactly ONE band weight from
`PEOPLE_PROMINENCE_PUBCOUNT_BANDS`:

```
            + 3.0   if publicationCount >= 200             capped only
            + 2.75  if 100..199
            + 2.5   if 50..99
            + 2.0   if 20..49
            + 1.25  if 5..19
            + 0.5   if 1..4
            + 0     if 0   (matches no band, as ln1p(0) = 0 did)
```

The bands are mutually exclusive, so the contribution is one weight, never a sum of two, and the
ceiling is `PEOPLE_PROMINENCE_PUBCOUNT_CEILING` = 3.0 (derived from the table by `Math.max`, not a
parallel literal). `name` and `department` keep the unbounded factor in both modes.

Structure, verbatim:

- Outer wrapper — `function_score { query: innerScoringQuery, functions: prominenceFunctions,
  score_mode: "sum", boost_mode: "multiply" }` (`lib/api/search.ts:3008-3017`). Functions array built at
  `lib/api/search.ts:2919-2953`.
- Inner wrapper (topic shape only) — `function_score { query: baseQuery, functions: scoreFunctions,
  score_mode: "multiply", boost_mode: "multiply" }` (`lib/api/search.ts:2986-2995`). Functions built at
  `lib/api/search.ts:2810-2855`.
- `baseQuery` = `{ bool: { must, filter: queryFilter } }` (`lib/api/search.ts:2986`).

Constants: `PEOPLE_PROMINENCE_BASE_WEIGHT` 1.0, `PEOPLE_PROMINENCE_PUBCOUNT_FACTOR` 1,
`PEOPLE_PROMINENCE_FACULTY_WEIGHT` 1.0, `PEOPLE_PROMINENCE_GRANT_WEIGHT` 0.5;
`AREA_BOOST_W_HI` 3 / `_MID` 1.5 / `_LO` 0.75 — all in `lib/search.ts`, cited by symbol because the
#2068 insertion shifted every line anchor past the prominence block; clinical weight default 3
(`lib/api/search-flags.ts:1205-1209`).

Under `score_mode: "sum"` only functions whose `filter` matches contribute. `BASE` and the
`field_value_factor` are unfiltered, so **in the default (`off`) mode** the outer multiplier has a hard
floor of 1.0 and no ceiling. There is no `max_boost`, no `min_score`, and no `script_score` anywhere in
the people body in either mode — `grep -n max_boost lib/api/search.ts` returns exactly one line, and it
is the comment warning against adding one (contract rule O4).

Under `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped` the volume term becomes a filtered step ladder, so on the
topic / hybrid / `unclassified` shapes the multiplier gains a stated ceiling: 1.0 (BASE) + 3.0 (volume)
+ 1.0 (faculty) + 0.5 (grants) + 3.0 (area hi) + 3.0 (clinical) = 11.5. The floor of 1.0 is unchanged,
because P = 0 matches no band exactly as `ln1p(0) = 0` contributed nothing.

Default sort is `_score` (`lib/api/search.ts:2676-2686`), so this product is the display order.

### Worked example

Two scholars, prod flag posture, topic shape, an `exact`-tier MeSH resolution, no method family, neither
scholar sparse, neither clinically matched.

| | Scholar A | Scholar B |
|---|---|---|
| Raw BM25 on the topic bool | 30.0 | **34.0** |
| MeSH attribution (exact tier, x1.5) | 45.0 | 51.0 |
| Productivity (>= 20 pubs, x1.2) | **54.0** | **61.2** |
| BASE | 1.0 | 1.0 |
| `ln(1 + publicationCount)` — 250 vs 150 pubs | 5.5255 | 5.0173 |
| Faculty (+1.0) | 1.0 | 1.0 |
| Active grants (+0.5) | 0.5 | 0.5 |
| Area concentration tier | **+3.0 (hi)** | **+0.75 (lo)** |
| Outer multiplier M | **11.0255** | **8.2673** |
| **Final** | **595.37** | **505.96** |

Scholar B matches the text 13% better and finishes 18% lower. One area tier step is worth more than the
entire BM25 spread. This is the whole point of the section: a text-matching defect and a wrapper defect
look identical from the result list, and the wrapper is almost always the larger term.

Two identities worth internalising, because the additive terms sit alongside `ln(1 + P)`:

- `+3.0` (one area-hi tier) is arithmetically equivalent to multiplying `(1 + publicationCount)` by
  `e^3` ~= 20.1.
- The hi-vs-lo gap of `+2.25` is equivalent to `e^2.25` ~= 9.5x the publication count.
- `+1.0` (faculty) ~= `e` ~= 2.72x; `+0.5` (grants) ~= 1.65x.

The realistic outer range is 1.0 (no pubs, nothing set) to ~14.7 (500 pubs, faculty, grants, area-hi,
clinical) — about a 3x spread between two plausibly-scoring scholars, against a measured BM25 spread of
1.14x. See [Known defects](#known-defects).

## Query traversal

A query passes through five layers in this order. Layers 1-3 can change **which** scholars come back;
layers 4-5 only change **their order**.

## Layer 1 — shape selection

Two stages, with two different vocabularies that share a type name.

### Stage 1: `classifyPeopleQuery`

A pure synchronous lexical function (`lib/api/people-query-shape.ts:126-173`) taking the raw query, a
single boolean `meshResolved`, and boot-cached lookup sets. Returns one of seven **classifier** shapes:
`cwid | name | department | topic | hybrid | unclassified | empty` (`lib/api/people-query-shape.ts:27-34`).

Tokenization is `trimmed.toLowerCase().split(/\s+/)` (`lib/api/people-query-shape.ts:133`). Whitespace
only — no punctuation stripping, no diacritic folding, no stemming. Every downstream lookup is exact
string equality.

Signals:

| Signal | Rule | Line |
|---|---|---|
| `cwid` | single token in `knownCwids` (set membership, not a format regex) | `:137` |
| `surnameAnchor` | `tokens[0]` **or** `tokens[last]` in `knownSurnames`; middle tokens never fire | `:144-146` |
| `departmentLeftover` | longest **prefix** match of `tokens.slice(0, n)`, n from `min(len, 6)` down to 1 | `:90-101` |
| `departmentSignal` / `departmentHasLeftover` | `leftover !== null` / `leftover.length > 0` | `:157-158` |
| `topicSignal` | `meshResolved \|\| tokens.length >= 4` — the only token-count threshold in the file | `:161` |

`DEPARTMENT_NOISE` = `{department, dept, division, the, of, and, &}` (`:41-49`) is stripped from the
**leftover only** (`:97`), never from the prefix being matched. That asymmetry is why `cardiology
department` classifies as `department` while `department of cardiology` matches no prefix and falls to
`topic`/`unclassified`. `MAX_DEPARTMENT_WORDS = 6` (`:52`) is a hard ceiling — a seven-word department
name is unreachable.

The eight-rung ladder (`lib/api/people-query-shape.ts:131-172`), first match wins:

1. `trimmed.length === 0` -> `empty`
2. single known CWID -> `cwid`
3. `departmentSignal && !departmentHasLeftover` -> `department` (#528: pure department beats a surname collision)
4. `surnameAnchor && topicSignal` -> `hybrid`
5. `departmentHasLeftover` -> `hybrid`
6. `surnameAnchor` -> `name`
7. `topicSignal` -> `topic`
8. -> `unclassified`

The SPEC's "1-3 token name query" constraint is emergent, not coded: rung 6 is reachable only when
`topicSignal` is false, which implies `< 4` tokens and `meshResolved === false`.

`hybrid` has two independent productions (rungs 4 and 5) that are indistinguishable downstream.

### Vocabulary provenance (mixed index / DB)

| Set | Source | Line |
|---|---|---|
| `knownSurnames` | OpenSearch `terms` agg over the **indexed** `lastNameSort` keyword, `SURNAME_AGG_SIZE = 20000` | `lib/api/people-classifier-sets.ts:50, 81-96` |
| `knownCwids`, `knownDepartments` | one Prisma `scholar.findMany({ deletedAt: null, status: "active" })` | `:103-118` |
| `knownDivisions` | Prisma `division.findMany` -> `name -> ["<deptCode>--<code>"]` | `:125-138` |

Cache TTL 24h (`:25`), refresh timeout 2000ms (`:43`), single `inflight` memo (`:78, :187`), and on
failure `EMPTY_SETS` returned **uncached** so the next request retries (`:70-75, :193-201`). Pre-warmed
at `lib/warmup.ts:111`.

Consequence of the split: a surname-vocabulary fix needs a **people reindex**; a department-vocabulary
fix takes effect at the next 24h refresh. And under `EMPTY_SETS` degradation no query can produce
`cwid`/`name`/`department`/`hybrid` at all — everything becomes `topic` or `unclassified` and every
request runs the topic body, with no distinguishing telemetry value.

### Stage 2: template routing

`searchPeople` maps **five** of the seven classifier shapes onto four v3 template bodies
(`lib/api/search.ts:1915-1949`). Every gate additionally requires `relevanceMode === "v3"` (the default
when the caller omits it, `:1915`) and `trimmed.length > 0`.

| Classifier shape | Template | Gate |
|---|---|---|
| `name` | name body | `:1916-1917` |
| `department` | dept body | `:1936-1937` |
| `hybrid` | hybrid body | `:1948-1949` |
| `topic` | topic body | `:1924-1927` |
| `unclassified` | **topic body** | `:1924-1927` |
| `cwid` | none — falls to the `restructured_msm` fallback | |
| `empty` | none — `match_all` browse body at `:2313-2314` | |

The function also computes a separate seven-value **template** enum
(`restructured_msm | name_template | topic_template | department_template | hybrid_template |
concept_filtered | concept_fallback`, `lib/api/search.ts:1085-1092`) via a last-write-wins ladder at
`:1955-1959`. It shares the type name `PeopleQueryShape` with the classifier enum and shares **zero**
values; `search.ts:133` imports the classifier type under the alias `PeopleQueryClassification`.

Which one you are looking at depends on the surface:

- The people structured log emits the **classifier** value (`app/api/search/route.ts:722-728`, with the
  #308 §9 note at `:718-721` saying so explicitly). Log archives predating that change are not comparable.
- The **template** value reaches the JSON response body only, via `jsonWithTiming`
  (`app/api/search/route.ts:756-764`).
- The docblock at `lib/api/search.ts:1099-1100` calls the template enum "telemetry-only". That is wrong:
  `app/(public)/search/page.tsx:1398-1406` filters the rendered list to evidence-bearing hits when
  `result.queryShape === "topic_template" && scope !== "concept"`.

### What shape selection decides

**SET.** Three ways:

1. The body it selects. The name body scores only name fields (`lib/api/search.ts:2115-2134`), so no
   scholar can be admitted on publication, AOI, or overview evidence.
2. The SSR evidence fold above — under `topic_template` in non-concept scope, hits with no research or
   affiliation evidence are hidden from the rendered list (`app/(public)/search/page.tsx:1398-1406`).
3. `SEARCH_PEOPLE_DIVISION_SHAPE` additionally unions a division roster into the `deptDiv` filter
   (`app/api/search/route.ts:563-570`), which is a real result-set narrowing. Off in both envs.

**ORDER.** The outer prominence wrapper only applies when a template matched:
`applyProminence = applyNameTemplate || applyDeptTemplate || applyHybridTemplate || applyTopicTemplate`
(`lib/api/search.ts:2873-2877`). A `cwid`/`empty` query, or any query under
`SEARCH_PEOPLE_RELEVANCE_MODE=legacy`, gets no prominence multiplier at all. Similarly the area boost and
clinical boost are gated `(applyTopicTemplate || applyHybridTemplate)` (`:2881-2886`, `:2910-2918`) and
the dept leadership boost is gated `applyDeptTemplate` (`:2964-2967`), so shape selection silently
decides which boosts exist.

### Template bodies

**Name** (`lib/api/search.ts:2115-2134`) — `bool.should` msm 1 over five clauses: `match_phrase
preferredName slop 2 ^30`, `match preferredName ^10`, `match_phrase fullName slop 2 ^30`, `match fullName
^10`, `term lastNameSort ^25`. **SET + ORDER.** Note the plain `match` clauses run the *whole* query
string with default OR semantics against the indexed `preferredName` (which is `displayName`,
`lib/search-index-docs.ts:1047, 1332`) — a non-name token in the query is not inert, it is scored, just
scored only against name fields.

**Department** (`lib/api/search.ts:2144-2153`) — `match_phrase primaryDepartment ^20`, `match primaryTitle
^8`, `match preferredName ^2`, `match fullName ^2`, `match areasOfInterest ^1`, msm 1. **SET + ORDER.**
No publication fields. As executed a dept request is still wrapped in up to two `function_score`s — the
leadership one (`:2996-3004`, `score_mode: "max"`) and the outer prominence one.

**Hybrid** (`lib/api/search.ts:2163-2195`) — the five name clauses verbatim, plus a no-msm `cross_fields`
topic ladder and the abstracts should-clause, summed in one `bool.should` msm 1. Additive by design: an
anchored name pins rank 1 while topic evidence orders the tail. **SET + ORDER.**

**Topic** — Layer 2 below.

**CWID path** — no template. The exact-CWID hit comes from an outer should arm present on every
non-empty query regardless of shape: `{ term: { cwid: { value: trimmed.toLowerCase(), boost: 100 } } }`
(`lib/api/search.ts:2296`). That 100 is a **multiplier on the term query's BM25**, not a flat +100; with
`cwid` mapped as `keyword` (`lib/search.ts:169`, norms off, tf 1) the contribution lands around 100 x ~19
~= 1900. **SET + ORDER.**

## Layer 2 — the lexical inner query (topic body)

`lib/api/search.ts:2197-2242`. One `bool`, plus the enclosing should-pair.

### The admission gate

`bool.must` holds exactly one element (`lib/api/search.ts:2217-2225`):

```
{ multi_match: { query: trimmed,
                 fields: peopleTopicFields(),
                 type: "cross_fields",
                 operator: "or",
                 minimum_should_match: PEOPLE_RESTRUCTURED_MSM } }
```

**SET.** This is the only clause inside the topic bool that can admit. Everything else in the bool is a
`should`.

Three admission paths exist *outside* the bool, which is why "the must clause is the whole gate" is only
true at this layer: the sibling `term{cwid}^100` arm under `minimum_should_match: 1`
(`lib/api/search.ts:2292-2312`), the always-on `queryFilter` (facets, A-Z prefix, the concept set gate),
and the escalation described in Layer 3, which demotes this must to optional.

### Field ladder

`peopleTopicFields()` (`lib/api/search.ts:2075-2078`) spreads
`PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS` (`lib/search.ts:741-750`):

| Field | Boost | Content |
|---|---|---|
| `preferredName` | 1 | discrete |
| `fullName` | 1 | discrete |
| `areasOfInterest` | 3 | **blob** — `topicAssignments.map(t => t.topic).join(" ")` (`lib/search-index-docs.ts:1011`) |
| `primaryTitle` | 3 | discrete |
| `primaryDepartment` | 1 | discrete |
| `overview` | 2 | **blob** — profile prose |
| `publicationTitles` | 6 | **blob** — see below |
| `publicationMesh` | 4 | **blob** — see below |
| `methodFamily` | 4 | appended when `SEARCH_PEOPLE_METHOD_FAMILY` is on (`lib/api/search.ts:2044, 2077`) |

Compare the non-topic default ladder (`lib/search.ts:662-671`): name 10, AOI 6, titles 1, mesh 0.5. The
topic ladder inverts that deliberately — a topic query is not a name query.

**`methodFamily` is SET-affecting**, because it joins the msm-bearing `must`. It does *not* change msm
token accounting — required-token count is a function of the analyzed **query**, not the field list
(`lib/search.ts:701-702`, and the code says so at `lib/api/search.ts:2034-2036`). It adds one more place a
token can be found.

### Why `cross_fields` + `operator: "or"`

`cross_fields` blends the field group as one big field for IDF and matching, so a scholar whose three
query tokens land in three *different* fields still satisfies msm. Under `best_fields` msm is evaluated
per field against the single best-matching field, and that scholar fails. Rationale, including the v2.2
spec correction, at `lib/api/search.ts:2015-2033`.

`cross_fields` groups by analyzer. All nine ladder fields use `scholar_text` (`lib/search.ts:173, 182,
190, 193, 206, 227, 236, 237, 311-314`), so they form one blended group.

`operator: "or"` because OpenSearch **ignores** `minimum_should_match` when `operator` is `and`
(`lib/api/search.ts:2027-2032`). Note the inline justification there still quotes "25% missing", which is
the retired v2.1 figure; the shipped constant is 34%.

`tie_breaker` is never set anywhere in `lib/` or `app/` (grep-verified), so it takes the OpenSearch
default 0.0: per query term only the single best-scoring field in the group contributes. A term present
in both `publicationTitles` and `publicationMesh` scores `max(6x..., 4x...)`, not the sum. Modelling the
ladder as additive across fields over-predicts.

### The msm table

`PEOPLE_RESTRUCTURED_MSM = "2<-34%"` (`lib/search.ts:724`). Required analyzed tokens:

| Analyzed tokens | 1 | 2 | 3 | 4 | 5 | 8 |
|---|---|---|---|---|---|---|
| Required | 1 | 2 | 2 | 3 | 4 | 6 |

Reads as: `<= 2` tokens require all; `> 2` allow up to 34% missing. History at `lib/search.ts:704-719` —
v2.0's `"-0% 3<-25%"` is invalid OpenSearch syntax and throws; v2.1's `"3<-25%"` required all three tokens
on 3-token queries and cut a 3-token headline query from 4,303 to 155 in prod; v2.2 changed only the
3-token row. 34% rather than 33% because `floor(0.33 * 3) = 0`.

Tokens are **post-analysis**. `scholar_text` = standard tokenizer + `[lowercase, alnum_delimiter,
flatten_graph, english_stop, english_stemmer]` (`lib/search.ts:118-133`), applied at index *and* query
time (no `search_analyzer` override). So a three-word query with a stopword is a two-token query for msm
purposes. `alnum_delimiter` + `flatten_graph` split letter/digit boundaries so `covid19` and `covid-19`
share a token set; without it the People tab collapsed from ~1,425 to 9 (#725, `lib/search.ts:121-127`).

### Scoring-only `should` clauses

One to four clauses, none of which can admit (`lib/api/search.ts:2227-2240`):

| Clause | Boost | Constant | Flag |
|---|---|---|---|
| `match publicationAbstracts` | 0.5 | `PEOPLE_TOPIC_ABSTRACTS_BOOST`, `lib/search.ts:758` | always |
| `match methodContext` | **0.8** | `PEOPLE_TOPIC_METHOD_CONTEXT_BOOST`, `lib/search.ts:693` | `SEARCH_PEOPLE_METHOD_CONTEXT` |
| `match_phrase publicationTitles slop 8` | 6 | inline, `lib/api/search.ts:2103-2109` | `SEARCH_PEOPLE_PHRASE_BOOST` |
| `match_phrase areasOfInterest slop 4` | 4 | inline, same builder | `SEARCH_PEOPLE_PHRASE_BOOST` |

All **ORDER**. The abstracts and methodContext blobs are excluded from the `must` ladder on purpose: each
is a concatenation of every abstract / every method sentence on the scholar, and clears any per-field
token-coverage threshold on its own, defeating msm (`lib/search.ts:654-661`, restated at
`lib/api/search.ts:2007-2014`).

`PEOPLE_METHOD_CONTEXT_BOOST = 0.5` (`lib/search.ts:690`) is the **fallback body's** value
(`lib/api/search.ts:2271`), reached only under legacy mode or an unrouted shape. On a normal v3 topic
query the value is 0.8.

### What the blob fields actually contain

This is the BM25 length-normalisation story, and it matters for anyone calibrating the ladder.

- `publicationTitles` = `titleParts.join(" ")`, a **single string** (`lib/search-index-docs.ts:1352`),
  where each kept authorship pushes the title `weight` times (`:844`) with
  `AUTHORSHIP_WEIGHTS = { firstOrLast: 10, secondOrPenultimate: 4, middle: 1 }` (`:55-59`).
- `publicationMesh` = `meshParts.join(" ")` (`:1353`), each surviving label pushed `agg.weightedCount`
  times — the sum of authorship weights across the pubs carrying it (`:878, :915`).
- `publicationAbstracts` = `abstractParts.join(" ")`, **one copy per distinct pmid**, no repetition
  (`:846-850, :1378`). The mapping notes abstracts run 50-200x longer than titles
  (`lib/search.ts:254-258`).
- `publicationMesh` is gated: a label enters only if it appears on >= 2 kept pubs **or** on any
  first/last-author pub (`lib/search-index-docs.ts:914`, same gate for `publicationMeshUi` at `:923`). The
  ^4 field is a filtered, not complete, view.

The docblock at `lib/search.ts:100-104` says index-time pre-multiplication means the search-time boost is
"the spec value without further math". That holds for the boost and ignores norms: repeating a
first/last-author title 10x inflates `fieldLength`, BM25 divides by it, and `k1` saturation caps the tf
gain. The two effects partially cancel — and cancel most in the two highest-boosted fields. Any
calibration assuming "boost 6 means 6x" is assuming something norms do not deliver.

Suppressed authorships and dark pmids are skipped from all three blobs *and* from `publicationCount`
(`lib/search-index-docs.ts:836`, `publicationCount: kept` at `:1384`), so the blob length and the outer
`ln1p(publicationCount)` derive from one consistent set.

### Generic-term demotion

When `SEARCH_GENERIC_TERM_DEMOTE=on` and the stripped `contentQuery` differs from the full query
(`lib/api/search.ts:1855-1859`), the single must clause is replaced by `demoteScoringClause`
(`:2209-2216` -> `:1196-1230`):

```
bool { must:   [ multi_match(contentQuery, same fields, cross_fields, or, msm) ],
       should: [ multi_match(fullQuery,    same fields, cross_fields, or, boost: 0.1) ] }
```

`GENERIC_DISCOUNT_BOOST = 0.1` (`lib/api/search.ts:1187`). **SET** (the gate moves to the content query)
**and ORDER** (the full query becomes a tiebreak). Every scoring-only should also switches to
`contentQuery` (`:2231, :2237, :2239`), while the fallback body keeps `trimmed` (`:2265, :2271`).

The discount arm carries no msm — an asymmetry, harmless today because it sits inside a bool that has a
must.

### `match=exact` — `exactWordNarrowing`

`exactWordNarrowing = applyTopicTemplate && opts.scope === "exact" && trimmed.length > 0`
(`lib/api/search.ts:2523-2524`). Topic shape only; the name and dept bodies stay byte-identical.

Two parallel round-trips run `collectCwidsByLiteralText` (`lib/api/search.ts:1334-1367`, `cross_fields` +
`operator: "and"`) against the publications index (`title^4, abstract^1` -> `wcmAuthorCwids`) and the
funding index (`title^4, abstract^1, keywordsText^1` -> `wcmInvestigatorCwids`), each capped at
`EXACT_WORD_CWID_CAP = CWID_AGG_CAP = 25000` (`:1332, :1249`). The result is **appended** to
`topicBool.must` (`:2552-2578`) as a `bool.should` msm 1:

- `terms{cwid: exactPubCwids}` — spread **conditionally**, only when non-empty (`:2557`)
- `terms{cwid: exactGrantCwids}` — likewise (`:2558`)
- `multi_match{ overview^2, areasOfInterest^3, clinicalSpecialties^2, clinicalExpertise^2, cross_fields,
  operator: "and" }` — always present

**SET and ORDER.** Appended, never replacing: the comment at `:2545-2551` records that replacing the must
made `exact` *broader* than the default on staging (`climate` 50 -> 142, `food insecurity` 34 -> 77),
because the publications lookup returns every author of every matching paper. And because all three arms
are scoring clauses summing into the inner score, `exact` reorders as well as narrows.

When both literal-text lookups return nothing, the conjunct collapses to the self-described-profile
`cross_fields` + `operator: "and"` clause alone — a much harder gate than the three-arm shape suggests,
and the mechanism by which `exact` can empty a page.

## Layer 3 — the MeSH concept layer

At most one `MeshResolution` reaches `searchPeople`. Note the resolver itself may run up to twice per
request: `matchQueryToTaxonomy(q)` at `app/api/search/route.ts:167` and, when the #692 generic strip fired
and the full query did not resolve, `matchQueryToTaxonomy(contentQuery)` at `:181`. The retry can
**replace** the resolution outright (`:159, :162`), swapping `descendantUis` wholesale.

`descendantUis` is the downward tree-number prefix walk `[self, ...descendants]`, hard-capped at
`DESCENDANT_HARD_CAP = 200` (`lib/api/search-taxonomy.ts:965, 1030-1065`), stamped at `:1444`. Do not
confuse it with `ancestorTreeNumbers` (`:1446-1448`), the **upward**, cap-free closure that feeds only the
clinical boost.

### Where the descendant set touches the people query

Three places affect set or order. A fourth, the `attributionMatch` telemetry filter-agg
(`lib/api/search.ts:2773-2790`, always set by the JSON route at `app/api/search/route.ts:651`), affects
neither.

**1. The `match=concept` result-set gate — SET.** `queryFilter.push({ terms: { publicationMeshUi:
meshDescendantUis } })` (`lib/api/search.ts:2385-2403`). Fires on `scope === "concept" &&
meshDescendantUis.length > 0`, nothing else. It sits in the always-on filter, so the hit list, the facet
aggregations and the count-only badge all shrink together. When `SEARCH_PEOPLE_CONCEPT_GRANT_AXIS` is on
the gate widens to a should over publication-tagged **or** grant-funded-on-concept (`:2390-2401`), with a
matching scoring arm at boost 0.1 (`:2304-2306`) — a real set widening, and enabled only by `concept`
scope, never by `expanded`.

**2. Escalate-on-sparse — SET.** Predicate (`lib/api/search.ts:2438-2443`):

```
applyTopicTemplate
  && opts.scope !== "concept"
  && meshDescendantUis.length > 0
  && !opts.meshAmbiguous
  && (opts.meshMatchedFormLength ?? 0) >= MESH_MIN_MATCHED_FORM_LEN   // 4
```

Note what is **absent**: `meshMatchTier` and anchor status. An unanchored entry-term escalates by design
(`:2418-2420`). `concept` is excluded on purpose — OR-ing the same terms clause into the must would
satisfy msm for every already-gated doc and widen concept scope from "lexical AND tagged" to "all tagged"
(`:2430-2437`).

When the lexical total is below `MESH_ESCALATION_THRESHOLD = 50` (`lib/search.ts:998`),
`applyConceptEscalation` (`lib/api/search.ts:2473-2504`) **mutates `topicBool.must` in place** into:

```
[ bool { should: [ bool { should: <the original must>, msm: 1, _name: LEXICAL_ADMIT_CLAUSE },
                   terms { publicationMeshUi, boost: MESH_ADMIT_WEIGHT[tier], _name: MESH_ADMIT_CLAUSE } ],
         minimum_should_match: 1 } ]
```

After escalation a scholar with **zero** lexical match is admitted on the tag alone. Three firing sites:
`:2604` (precount path, flag on), `:2637` (count-only badge path), and `:3211` (the full search — the one
behind the list the user sees). The flag-off path pays a **second** full search including aggs and
hydration, re-dispatching the same mutated `body` object (`:3207-3216`).

**3. `MESH_ATTRIBUTION_WEIGHT` — ORDER.** `{ filter: terms{publicationMeshUi: descendantUis}, weight:
MESH_ATTRIBUTION_WEIGHT[tier] }` pushed at `lib/api/search.ts:2812-2819` into the **inner** multiplicative
`function_score`. Its only guard is `applyTopicTemplate && meshDescendantUis.length > 0` — independent of
escalation, of the sparse count, and of scope. On a normal non-sparse `expanded` query this reorder plus
the area boost is the concept layer's entire query-side footprint.

### Tiers

`meshMatchTier(confidence, anchorCount, { fullQueryMatch })` (`lib/search.ts:813-830`): `partial` ->
`partial`; `exact` -> `exact`; `fullQueryMatch` -> `exact` (checked **before** the anchor test); else
`anchorCount > 0 ? "anchored-entry" : "entry"`.

| Tier | `MESH_ADMIT_WEIGHT` (`lib/search.ts:964-969`) | `MESH_ATTRIBUTION_WEIGHT` (`:971-976`) |
|---|---|---|
| exact | 0.1 | 1.5 |
| anchored-entry | 0.05 | 1.3 |
| entry | 0.03 | 1.15 |
| partial | 0.01 | 1.05 |

`meshTier` is read at exactly three lines in `lib/api/search.ts` — the `?? "exact"` default at `:2409`,
the admit boost at `:2495`, the attribution weight at `:2818`. Both reads are weight lookups. **The tier
is ORDER-only end to end**, and `lib/search.ts:962-963` says so: "Admission/recall is unchanged — this is
ordering only."

`MESH_ADMIT_WEIGHT` reads like an admission threshold and is not one. It is the constant score of a
clause whose **presence** does the admitting. Setting all four values to 0 would admit exactly the same
documents. One nuance: because the two escalation arms sit in one `should` with msm 1, a doc matching
both sums both scores, so the admit weight also perturbs ordering among lexical hits on the escalated
path — not only within the concept-only tail.

The sub-BM25 band is deliberate (`lib/search.ts:952-963`), but its worked case — `0.1 x 1.5 x 1.2 x 8.7 =
1.6` — predates the area tier, the clinical term and the x2.0 method-family tier, all three live in both
envs. Recomputed with today's terms: `0.1 x 1.5 x 2.0 x 1.2 x 14.7` ~= 5.3, more than triple. Treat the
"concept-only admits cannot outrank lexical hits" guarantee as unverified since #1363/#1836.

### Curated topic anchors

There is **no anchor query clause on the people branch**. `reciterParentTopicId` appears in
`lib/api/search.ts` only at `:4398` and `:4429`, both inside `searchPublications`. Anyone porting
intuition from the publications `concept_expanded` / `concept_filtered` bodies will wrongly expect an
anchor admission arm here.

On people, anchors act three ways:

- **SET, indirectly** — `rankedDescriptorCandidates` breaks ties on anchor-exists
  (`lib/api/search-taxonomy.ts:1323-1325`) before `localPubCoverage` (`:1330-1332`). A different winning
  descriptor is a different `descendantUis`.
- **ORDER** — anchor count feeds the tier (`lib/search.ts:829`).
- **ORDER** — the #1258 fold-in injects anchored parent topics into `taxonomyMatch.areas` at similarity
  1.0 (`lib/api/search-taxonomy.ts:681-693`), which feeds the area boost. Note this is a *tie* at 1.0, not
  automatic first place: an exact name match also scores 1.0 (`:668`) and the tie breaks on
  `scholarCount` (`:817-830`).

### Resolver miss paths (all upstream, all SET-affecting)

| Path | Result | Flag | Line |
|---|---|---|---|
| singularize retry | resolves at `partial` | `SEARCH_MESH_QUERY_NORMALIZATION` | `search-taxonomy.ts:1383-1395` |
| contiguous-window decompose | resolves at `partial` | `SEARCH_MESH_RESOLUTION_FALLBACK` | `:1399-1401` |
| window coverage guard | suppresses a window hit | `SEARCH_MESH_RESOLVE_TOKEN_COVERAGE` | `:1519-1521` |
| acronym sense guard | returns **null** | `SEARCH_ACRONYM_SENSE_GUARD` | `:1412-1419` |
| `scope=exact` | resolution nulled by callers | URL param | `route.ts:226, 584` |

These change **whether and which** descriptor resolves, and therefore whether every mechanic above exists
at all. They are the genuinely set-changing MeSH levers; the tier and its parity flag are not.

## Layer 4 — the inner multiplicative `function_score`

`lib/api/search.ts:2986-2995`, `score_mode: "multiply"`, `boost_mode: "multiply"`. Applied only when
`applyTopicTemplate && scoreFunctions.length > 0`. Everything here is **ORDER**.

| Function | Filter | Weight | Line |
|---|---|---|---|
| MeSH attribution | `terms{publicationMeshUi: descendantUis}` | 1.5 / 1.3 / 1.15 / 1.05 by tier | `:2812-2820` |
| Method-family tier | `match_phrase{methodFamily: <resolved family>}` | **2.0** (`lib/search.ts:991`) | `:2827-2832` |
| Productive author | `range{publicationCount: gte 20}` | 1.2 | `:2833-2837` |
| Productive author | `range{publicationCount: gte 5, lt 20}` | 1.1 | `:2838-2840` |
| Sparse decay | `bool.must[overviewLength <= 200, aoiTermCount < 3, publicationCount == 0]` | **0.7** | `:2841-2854` |

The two productivity ranges are mutually exclusive. Sparse decay is gated `applySparseDecay =
applyTopicTemplate && !applySparseFilter` (`:2809`), where `applySparseFilter = filters.includeIncomplete
=== false` (`:2002`). Both public callers leave `includeIncomplete` `undefined` on a normal request
(`app/api/search/route.ts:539-541` maps an absent param to `undefined`; the SSR page never sends it), so
the decay function is present on both paths — it multiplies only the docs matching the triple-sparse
filter.

Attribution is omitted entirely when no descriptor resolved. `methodFamilyTierLabel` is non-null only
when `resolvePeopleMethodFamilyTier() && applyTopicTemplate` and the taxonomy resolved a single family
(`:2053-2056`); it reads `opts.matchAwareContext` **directly**, so it does not depend on
`SEARCH_PEOPLE_MATCH_AWARE_SNIPPET` or `SEARCH_RESULT_EVIDENCE`.

Inner multiplier range: 0.7 to `1.5 x 2.0 x 1.2 = 3.6`.

Dept shape gets a different inner wrapper — `score_mode: "max"`, chair 3.0 / chief 1.5
(`lib/api/search.ts:2968-2979, 2996-3005`; `PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT` / `_CHIEF_WEIGHT` in
`lib/search.ts`) — mutually exclusive with the topic
branch. Its opt defaults to **off** inside `searchPeople` (`(opts.deptLeadershipBoost ?? false)`,
`:2966`); the flag's documented default-on reaches the query only because both public callers pass it
explicitly (`route.ts:703`, `page.tsx:550`).

## Layer 5 — the outer prominence wrapper

`lib/api/search.ts:3008-3017`, `score_mode: "sum"`, `boost_mode: "multiply"`. Functions at `:2919-2953`.
Applies to all four v3 shapes. Everything here is **ORDER**.

**1. BASE — `{ weight: 1.0 }`, no filter** (`:2921`). Applies to every doc; it is what floors M at 1.0, so
a zero-pub non-faculty scholar keeps its inner score rather than being zeroed.

**2. Publication count — TWO MODES**, selected by `SEARCH_PEOPLE_PUBCOUNT_DAMPEN` (#2068). This is the
scholar's **total** indexed pub count, not the on-topic count — a pure volume prior with zero topical
relation, in either mode. (Two *modes* of the lever; the capped mode applies to *three* query
**shapes** — topic, hybrid, unclassified. The two counts are unrelated.)

*Mode `off` (default; what both envs serve today), and all four shapes:* `field_value_factor { field:
"publicationCount", modifier: "ln1p", factor: 1, missing: 0 }`, **no filter**. Contribution is exactly
`ln(1 + publicationCount)`, unbounded — contract violation O3.

| Pubs | 30 | 50 | 100 | 250 | 500 |
|---|---|---|---|---|---|
| `ln(1+P)` | 3.434 | 3.932 | 4.615 | 5.525 | 6.217 |

Across a plausible 30-500 band this single term contributes a 2.78-point swing.

*Mode `capped`, and only on the topic / hybrid / `unclassified` shapes:* the factor is replaced by one
`{ filter: range{publicationCount}, weight }` clause per band of `PEOPLE_PROMINENCE_PUBCOUNT_BANDS`. The
bands are mutually exclusive, so exactly one weight lands in the sum:

| Pubs | 0 | 1-4 | 5-19 | 20-49 | 50-99 | 100-199 | >= 200 |
|---|---|---|---|---|---|---|---|
| band weight | 0 | 0.5 | 1.25 | 2.0 | 2.5 | 2.75 | **3.0** |

Ceiling `PEOPLE_PROMINENCE_PUBCOUNT_CEILING` = 3.0, derived from the table. `name` and `department`
keep the `off` shape regardless of the flag. **Sizing a lever off the `ln(1+P)` table above is only
valid in `off` mode** — see [the faculty interaction](#the-faculty-interaction-under-capped) below.

#### The faculty interaction under `capped`

Capping one addend of a `score_mode: sum` raises every other term's SHARE. Over the measured 8-219
tagged-pub range the volume span falls from `ln1p(219) - ln1p(8)` = 3.197 to `3.0 - 1.25` = 1.75, so the
+1.0 faculty weight goes from **31.3% to 57.1%** of the volume span; across 80 captured top-10 docs the
employment prior's share of the outer sum rises **16.3% -> 21.8% (x1.34)**.

That produces inversions the default mode does not have. Prod posture, 50-pub full-time faculty vs
580-pub affiliated, no grants:

| | 50-pub full-time faculty | 580-pub affiliated | winner |
|---|---|---|---|
| `off` | `1 + ln1p(50) + 1.0` = **5.932** | `1 + ln1p(580)` = **7.365** | the 580-pub scholar |
| `capped` | `1 + 2.5 + 1.0` = **4.5** | `1 + 3.0` = **4.0** | the 50-pub faculty |

`SEARCH_PEOPLE_FACULTY_PROMINENCE` is itself env-divergent today (staging `off`, prod `on`), so a
staging A/B of the volume lever measures a sum composition prod will not serve: staging has no +1.0
faculty term whose share could rise. Size the prod effect from the prod posture.

**3. Faculty — `{ filter: term{personType: "full_time_faculty"}, weight: 1.0 }`** (`:2932-2939`), spread in
only when `opts.facultyProminence !== false`. Both public callers pass
`resolveSearchPeopleFacultyProminence()` (`route.ts:706`, `page.tsx:553`), which is `!== "off"`
(`search-flags.ts:341-343`). **CDK wires this staging `off` / prod `on`** (`cdk/lib/app-stack.ts:1799`) —
the single per-env divergence on the always-on scoring path.

**4. Active grants — `{ filter: term{hasActiveGrants: true}, weight: 0.5 }`** (`:2942-2949`). There is **no
env flag** — grep-verified, the only caller that sets `grantProminence: false` is the Matcha spine
(`lib/api/matcha-spine-run.ts:446`). Public people search always carries the +0.5, with no rollback lever.

**5. Area concentration — `{ filter: terms{cwid: [...]}, weight: 3 | 1.5 | 0.75 }`**, gated
`(applyTopicTemplate || applyHybridTemplate) && opts.areaConcentration?.length > 0` (`:2881-2886`). Built
by `buildAreaBoostFunctions` (`:1426-1451`): `frac = total / concentration[0].total`; `>= 0.5` -> hi,
`>= 0.2` -> mid, else lo (`AREA_BOOST_HI_FRAC` / `AREA_BOOST_MID_FRAC` in `lib/search.ts`). At most
three clauses; the if/else-if/else makes
tiers mutually exclusive, so exactly one fires per scholar.

The filter is a **bare cwid membership list**. Nothing in the clause references the query, the resolved
descriptor, or any field the doc matched on. A scholar on the hi list receives +3 however weakly they
matched. This is the single largest reorder lever in the wrapper and the subject of
[Known defects](#known-defects).

Where `areaConcentration` comes from — two arms, resolved in the **callers**, arm 1 winning whenever both
could apply:

- **Arm 1 (curated Research Area).** `resolveSearchPeopleAreaBoost() && !meshOff && taxonomyMatch.state
  === "matches" && taxonomyMatch.areas.length > 0`, then `getAreaScholarConcentration(parentTopicId,
  subtopicId, 200)` (`route.ts:613-629`, `page.tsx:490-507`). `getAreaScholarConcentration`
  (`lib/api/topics.ts:281-386`) carves hard: `authorPosition in [first, last]`, `year >= 2020`, scholar
  active with `roleCategory in SEARCH_BOOST_ELIGIBLE_ROLES`, publication type not excluded, and >= 3
  distinct on-topic pmids. Score is `topicImpact^2 / max(totalImpact, topicImpact)`.
- **Arm 2 (concept axis, #1343).** Runs only when arm 1 produced nothing (`route.ts:634-644`,
  `page.tsx:511-522`). `getConceptScholarConcentration(descendantUis, 200)` (`lib/api/search.ts:1480-1535`)
  runs two publications-index aggs — `terms{wcmAuthorCwids, size: limit}` over docs filtered to
  `meshDescriptorUi in descendantUis`, then each survivor's whole-index total pinned via `include` — and
  scores `n^2 / max(total, 1)`. No author-position carve, no year floor, no role carve.

The two arms are **not the same signal and not interchangeable**. A middle-author-heavy or pre-2020-heavy
scholar is structurally invisible to arm 1 and fully visible to arm 2. Which arm runs depends only on
whether `taxonomyMatch.areas` was non-empty.

**6. Clinical specialty — weight 3** (`:2910-2918`), gated `(applyTopicTemplate || applyHybridTemplate) &&
resolveSearchPeopleClinicalFn() && trimmed.length > 0`. Filter (`:2898-2909`): when the MeSH ancestor
closure is non-empty, `bool{ should: [ match{clinicalSpecialties: trimmed}, terms{clinicalSpecialtyMeshTree:
closure} ], msm: 1 }` — one bool, so the weight fires once even if both arms match; otherwise the bare
`match`. The `terms` arm is an **uncapped** tree-number subsumption, so a system-root anchor matches
broadly.

Area and clinical stack additively and are not mutually exclusive: `+6` is `e^6` ~= 403x the publication
count. Nothing caps it.

## Flag inventory

Every value below is the **CDK-wired** value at `cdk/lib/app-stack.ts`. It is not the runtime value — see
[Traps](#traps).

### Levers that change the admitted SET

| Flag | Code default | Staging | Prod | Effect | Code |
|---|---|---|---|---|---|
| `SEARCH_PEOPLE_METHOD_FAMILY` | off | on `:1695` | on | Adds `methodFamily^4` (topic) / `^3` (fallback) to the msm-bearing `must`. Needs a reindex first. | `search-flags.ts:728-730`; `search.ts:2044, 2077-2086` |
| `SEARCH_PEOPLE_CONCEPT_GRANT_AXIS` | off | on `:1901` | on | Under `match=concept` only: unions grant-funded-on-concept cwids into the gate at boost 0.1. | `search-flags.ts:999-1001`; `search.ts:2282-2306` |
| `SEARCH_PEOPLE_DIVISION_SHAPE` | off | off `:1792` | off | Routes a bare division query to the dept template **and** scopes it to that division's roster. Dark everywhere; needs a staging A/B. | `search-flags.ts:325-327`; `route.ts:563-570` |
| `SEARCH_GENERIC_TERM_DEMOTE` | off | on `:1624` | on | At `on` the gate moves to the stripped content query. | `search-flags.ts:443-452`; `search.ts:1855-1859` |
| `SEARCH_MESH_RESOLUTION_FALLBACK` | off | **on** `:1916` | **off** | Window decompose-and-resolve on a full-query miss, at `partial`. Decides whether a descriptor exists at all. | `search-flags.ts:1017-1019`; `search-taxonomy.ts:1399` |
| `SEARCH_MESH_RESOLVE_TOKEN_COVERAGE` | off | off `:1966` | off | Majority-coverage guard on the window fallback. Flipped on in staging 2026-07-26 and reverted the same day (resolution 33/35 -> 22/35). No-op in prod anyway. | `search-flags.ts:1070-1072`; `search-taxonomy.ts:1556` |
| `SEARCH_MESH_QUERY_NORMALIZATION` | off | on `:2004` | on | Singularize retry at `partial`. | `search-flags.ts:1129-1131`; `search-taxonomy.ts:1383` |
| `SEARCH_ACRONYM_SENSE_GUARD` | off | on `:2012` | on | **Suppresses** a resolution, dropping the query to pure BM25. | `search-flags.ts:1145-1147`; `search-taxonomy.ts:1413` |

### Levers that change ORDER only

| Flag | Code default | Staging | Prod | Effect | Code |
|---|---|---|---|---|---|
| `SEARCH_PEOPLE_FACULTY_PROMINENCE` | on (`!== "off"`) | **off** `:1799` | **on** | The flat +1.0 faculty term in the outer sum. | `search-flags.ts:341-343`; `search.ts:2932-2939` |
| `SEARCH_PEOPLE_PUBCOUNT_DAMPEN` | off (`=== "capped"`) | off `:1860` | off | Replaces the unbounded `ln1p(publicationCount)` factor with the `PEOPLE_PROMINENCE_PUBCOUNT_BANDS` step ladder, ceiling 3.0 (contract O3). **Topic / hybrid / `unclassified` only** — `name` and `department` keep the factor. **Cannot change the set** (a `function_score` function over already-matched docs). Raises the faculty term's share of the same sum 16.3% -> 21.8%; see [the faculty interaction](#the-faculty-interaction-under-capped). Also reached by the Matcha spine, which **pins it `off`** (`matcha-spine-run.ts`, `retrieveCluster`) so the spine never inherits a /search A/B. | `search-flags.ts:345, 386-388`; `search.ts:3046-3069` |
| `SEARCH_PEOPLE_AREA_BOOST` | off | on `:1777` | on | Gates **both** concentration arms; the +3/+1.5/+0.75 tiers. Largest ranking lever on people. | `search-flags.ts:463-465`; `search.ts:1426-1451, 2881-2886` |
| `SEARCH_PEOPLE_CLINICAL_FN` | off | on `:1734` | on | The +3 clinical term. | `search-flags.ts:1183-1185`; `search.ts:2910-2918` |
| `SEARCH_PEOPLE_CLINICAL_MESH_ANCHOR` | off | on `:1744` | on | Sub-toggle; ORs the uncapped `clinicalSpecialtyMeshTree` closure into the same weight. Inert in prod until a prod people reindex carries the anchor fields (`cdk:1741-1743`). | `search-flags.ts:1198-1200`; `search.ts:2073-2074, 2896-2904` |
| `SEARCH_PEOPLE_METHOD_FAMILY_TIER` | off | on `:1707` | on | The inner x2.0 — largest single inner factor. | `search-flags.ts:769-771`; `search.ts:2827-2832` |
| `SEARCH_PEOPLE_METHOD_CONTEXT` | off | on `:1717` | on | Scoring-only should at 0.8 (topic) / 0.5 (fallback). Never admits. | `search-flags.ts:748-750`; `search.ts:2093-2096` |
| `SEARCH_PEOPLE_PHRASE_BOOST` | off | on `:1784` | on | Scoring-only `match_phrase` pair (titles slop 8 boost 6, AOI slop 4 boost 4). Never admits. | `search-flags.ts:357-359`; `search.ts:2102-2109` |
| `SEARCH_MESH_ENTRY_TIER_PARITY` | off | **on** `:1996` | **off** | Promotes a verbatim entry-term hit `entry` -> `exact`: attribution 1.15 -> 1.5, admit 0.03 -> 0.1. **Cannot change the set.** Also read by the Matcha spine (`matcha-spine-run.ts:68, 436`). | `search-flags.ts:1112-1114`; `search.ts:813-830` |

### Result-neutral, presentation-only, and not-wired

| Flag | Wired | Note |
|---|---|---|
| `SEARCH_PEOPLE_CONCEPT_PRECOUNT` | off both `:1881` | Chooses **how** the sparse count is sourced, not whether escalation happens. The CDK comment at `:1867-1868` claims the resolver reads `!== "off"`; it reads `=== "on"` (`search-flags.ts:984`), so unset means OFF, not on. Deployed behaviour is unaffected because CDK sets the literal; a local run inherits the wrong expectation. |
| `SEARCH_PEOPLE_CLINICAL_BOARD_OVER_TAGGED` / `_SPECIALTY_OVER_TAGGED` | "6" / "4" both `:1723-1724` | Evidence-reason precedence only. Not ranking. |
| `SEARCH_PEOPLE_MATCH_EXPLAIN` `:1634`, `_SNIPPET_REPRESENTATIVE_PUB` `:1646`, `_REASON_FROM_DOC` `:1661`, `_MATCH_AWARE_SNIPPET` `:1751`, `SEARCH_RESULT_EVIDENCE` `:1758`, `SEARCH_EVIDENCE_ROWS` `:1765`, `SEARCH_EVIDENCE_REASON_COUNTS` `:1772`, `SEARCH_PEOPLE_CONCEPT_HINT` `:1807`, `SEARCH_SHELL_STREAMING` `:1853` | on/off as listed | Presentation only. None touches the query predicate, the score, or the result set. |
| `SEARCH_PEOPLE_RELEVANCE_MODE` | **not wired** — allowlisted `flag-parity-allowlist.txt:58` | Code default `v3`. `legacy` disables all four templates and therefore prominence, area, clinical, method-tier, phrase, and leadership. Not a total kill switch: `SEARCH_PEOPLE_METHOD_FAMILY` still admits via `methodFamily^3` on the fallback body (`search.ts:2079-2082 -> :2254`) and `_METHOD_CONTEXT` still fires at `:2271`. |
| `SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST` | **not wired** — `:57` | Code default on. Chair 3.0 / chief 1.5, dept shape only. |
| `SEARCH_PEOPLE_CLINICAL_FN_WEIGHT` | **not wired** — `:56` | Code default 3. |
| `SEARCH_AREA_BOOST_W_HI` / `_MID` / `_LO` | **not wired** — `:44-46` | Code defaults 3 / 1.5 / 0.75. `0` is a valid disabling override (`search.ts:1447-1449`). |

Do not describe the unwired four as "off in prod" — they are simply not in the environment, and there is
no per-env dial for them without adding a CDK entry (which then invalidates the snapshot: `cd cdk && npm
test -- -u`).

Adjacent, do not conflate: `SEARCH_RANKING_V2` (`search.ts:5558`) ranks the **autocomplete dropdown**, not
people search. `SEARCH_REQUIRE_DISPLAYABLE_AUTHOR` (`search-index-docs.ts:522`) is index-time on
publication docs. `SEARCH_OS_REQUEST_TIMEOUT_MS` (`lib/search.ts:24`) can degrade a response but does not
reorder.

### The URL scope is the largest lever and is not an env flag

`?match=exact|expanded|concept`, parsed by `parseScopeParam` (`lib/api/search-flags.ts:94-121`) and
bridged by `scopeToMeshParams` (`:126-128`).

- `expanded` — the default. Byte-identical to the pre-scope query. Installs nothing.
- `concept` — installs the hard `terms{publicationMeshUi}` result-set gate; the only value that does.
- `exact` — nulls the resolution upstream (`route.ts:226, 584`), which drops the attribution multiplier,
  makes escalation structurally impossible, nulls the clinical closure, and suppresses **both** area-boost
  arms. It also adds the literal-match conjunct described in Layer 2.

Never compare two people result sets without pinning this parameter.

## How to measure this

### Read-only `_explain` against staging OpenSearch

`scripts/run-staging-probe.sh` gzips a `scripts/*.ts` file, ships it as a container override to the
existing `sps-etl-staging` task definition, decodes it to `/tmp/__probe.ts` inside the container, runs it
with `tsx`, and tails the CloudWatch stream back. `DATABASE_URL` is forced onto the SELECT-only Aurora
user, so a probe physically cannot write.

Two constraints follow from the mechanism, and both are non-obvious:

1. **Node built-ins only.** The probe executes from `/tmp`, so Node's module resolution walks
   `/tmp/node_modules` then `/node_modules` and never reaches the app's tree. `import { Client } from
   "@opensearch-project/opensearch"` fails. Use `node:https` and hand-roll the request.
2. **Credentials come from the ETL task definition's `secrets[]`**, already injected as
   `OPENSEARCH_NODE` (an `https://` endpoint), `OPENSEARCH_USER`, `OPENSEARCH_PASS`
   (`cdk/lib/etl-stack.ts:1567-1589`). Read them from `process.env`; never hardcode.

The people index is `scholars-people` (`PEOPLE_INDEX`, `lib/search.ts:93`).

Probe skeleton:

```ts
// scripts/tmp-explain-probe.ts — read-only. Node built-ins only (runs from /tmp).
import https from "node:https";

const node = process.env.OPENSEARCH_NODE!;          // https://<endpoint>
const auth = Buffer.from(
  `${process.env.OPENSEARCH_USER}:${process.env.OPENSEARCH_PASS}`,
).toString("base64");

function os(path: string, body: unknown): Promise<any> {
  const payload = JSON.stringify(body);
  const u = new URL(path, node);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { "content-type": "application/json",
                   "content-length": Buffer.byteLength(payload),
                   authorization: `Basic ${auth}` } },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
                 res.on("end", () => resolve(JSON.parse(d))); },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// 1. Find the doc ids for the scholars you care about.
// 2. Explain each against the BARE bool only — no function_score wrappers.
//    This is what isolates the text layer from the ranking layers.
const bareBool = { bool: { must: [ /* the topic multi_match, verbatim */ ] } };
for (const id of ["<docId>"]) {
  const r = await os(`/scholars-people/_explain/${id}`, { query: bareBool });
  console.log(id, r.explanation?.value);
}
```

Run it: `scripts/run-staging-probe.sh scripts/tmp-explain-probe.ts staging`.

**Explain the bare `bool`, not the full body.** If you explain the assembled `body` from `searchPeople`,
the returned value already contains the attribution weight, the x2.0 method-family tier, the productivity
factor, the sparse decay, and the outer prominence sum — and you have measured nothing about text
matching. Explaining `{ bool: { must, filter } }` alone gives you the BM25 layer; the ratio between that
and the displayed `_score` is the combined wrapper factor.

Prod is intentionally not wired into the probe script (see its header). Add the `Sps-Network-prod` subnets
and SG before pointing it there.

### Black-box decomposition via `?match=`

`/api/search?q=<query>&type=people&match=exact|expanded|concept` gives a layer decomposition with no AWS
access at all. Staging's search API is reachable from a WCM IP without SSO.

- `expanded` vs `exact` — the delta is the entire concept layer: attribution multiplier, escalation, and
  **both** area-boost arms. Not a clean isolation of any one of them.
- `expanded` vs `concept` — `concept` installs the set gate. Compare `total` first.
- Diff `total` with a parameter on and off: **identical `total` means the lever ranks rather than
  filters.**

**The parameter is `match=`, not `scope=`.** `parseScopeParam` reads only `match` and the legacy `mesh`
alias; anything else falls through to the default `expanded` (`lib/api/search-flags.ts:105-120`). Because
`expanded` is byte-identical to sending no parameter, a typo produces a *successful* 200 with a plausible
result set and no warning anywhere.

**The tell for a silently-ignored parameter is identical `total` AND identical order.** Identical `total`
alone is ambiguous — it is also the correct signature of a pure ranking lever. If both the count and the
top-N ordering are byte-identical between your "on" and "off" runs, you did not change anything; check the
parameter name before drawing a conclusion.

Both callers parse identically, so the SSR page and the JSON route agree on scope. They can still
diverge on the **classified shape**: `app/api/search/route.ts:125-128` gates strip-retry adoption on
`stripKeptEnough` (#1980) and the SSR mirror at `app/(public)/search/page.tsx:263-286` has no such gate.
A query whose strip removed more than half its tokens can be `topic` on the page and `unclassified` via
the API.

## Known defects

### The area boost credits an area that need not be the queried concept (#2018)

Measured on staging 2026-07-28, `q=<a two-word therapy concept>&type=people`, probed across all three
scopes. Scholars anonymised; scores and counts verbatim.

**On pure lexical, the tag-rich scholar already wins.**

| `match=exact` (MeSH off) | score |
|---|---|
| 1. Scholar A | 2098 |
| **2. Scholar C** | **1645** |
| 3. Scholar G | 1587 |
| **4. Scholar B** | **1549** |

**The concept-layer boost tracks the area rollup count, not the tagged-descriptor count.**

| Scholar | `exact` | `expanded` | boost | pubs tagged with the queried descriptor | contributing area (scholar count) |
|---|---|---|---|---|---|
| A | 2098 | 3111 | **+1013** | 140 | on-concept area (21) |
| **B** | 1549 | 2056 | **+507** | **3** | **an off-concept area (20)** |
| G | 1587 | 1729 | +142 | 36 | on-concept area (7) |
| **C** | 1645 | 1768 | **+123** | **34** | a different area (7) |
| H | 1435 | 1547 | +112 | 3 | unrelated area (4) |
| I | 1320 | 1382 | +62 | 4 | on-concept area (2) |

The boost is monotonic in the **area** count (21, 20, 7, 7, 4, 2 -> 1013, 507, 142, 123, 112, 62) and
shows no relationship to the tagged count: 3 tagged earns +507 while 34 tagged earns +123. Scholar B's
contributing area is not the queried concept. The arm meant to reward on-concept evidence is tracking the
size of an off-concept area rollup.

The mechanism is exactly what Layer 5 describes: the filter is `terms{cwid: [...]}` with no reference to
the query (`lib/api/search.ts:1447-1449`), and the credited area is `taxonomyMatch.areas[0]`
(`route.ts:619`) — which is **not** `taxonomyMatch.primary`. `areas` sorts similarity-first
(`search-taxonomy.ts:817-830`) while `primary` sorts scholarCount-first (`:610-628`), so the headline chip
the user sees is not necessarily the area whose concentration was credited. A subtopic-grained query that
resolves to a parent gets whole-parent concentration (`route.ts:620-621`), so a sibling-subtopic
specialist is tiered identically to the on-query specialist.

Two further consequences of the tiering being **relative**: `frac = total / concentration[0].total`
(`:1436`), so a skewed area pushes almost everyone to LO while a flat area puts many at HI. The same
scholar can be HI in one area and LO in another with identical work. And `AREA_BOOST_TOP_N` (500 since
PR #2098, previously 200) is a cliff — in arm 2 the candidates come from a `terms` agg ordered by
`doc_count` (`:1502`), i.e. they are the highest-**volume** on-topic authors, reranked by concentration
only afterwards. A genuinely concentrated low-volume specialist outside the cap by raw count gets
exactly 0.

⚠ **The two arms truncate on different orderings, and only arm 1's was measured.** Arm 1
(`CONCEPT_ARM_FIRST`, on in both envs) sorts by `n²/total` — the quantity being boosted — and then
slices, so the cap there is an approximation error that closes as the cap grows; PR #2098 measured it
converging by 300 on every panel query and raised the cap to 500 on that basis. Arm 2 slices a
**volume**-ordered list, so its cliff is not self-correcting in the same way: raising the cap admits
more high-volume authors, which is not the same as admitting the concentrated specialists it excludes.
The PR #2098 measurement does **not** cover arm 2, and a low-volume specialist can still score exactly 0
there at any cap.

`match=concept` filters but does not re-rank: `total` falls 919 -> 138 while the scores move by at most 3
points (3111 -> 3114, 2056 -> 2056, 1768 -> 1770). "Concept only" cuts the set by 85% and leaves the
ordering inside it lexically seeded, which is probably not what the label implies.

### The volume prior, and the wrapper inverting a sane BM25 order

An OpenSearch `_explain` on staging for the same query returned this raw BM25 ordering against the bare
bool:

| Scholar | raw BM25 | displayed rank |
|---|---|---|
| C | 34.84 | 3 |
| D | 34.78 | 9 |
| A | 34.59 | 1 |
| E | 33.36 | 15 |
| B | 32.14 | 2 |
| F | 30.48 | 8 |

The text layer orders these six sensibly and spans 34.84 / 30.48 = **1.14x**. The displayed order is
almost uncorrelated with it. Nothing in the text-matching layer produced that; the wrapper did.

The arithmetic is not close. Against a 1.14x text spread:

- one area tier step is worth `e^3` ~= 20.1x the publication count, and the hi-vs-lo gap `e^2.25` ~= 9.5x;
- `ln(1 + publicationCount)` alone swings 2.78 points across a 30-500 pub band, which at the low end of
  M is itself larger than the entire BM25 spread;
- area + clinical together is +6, `e^6` ~= 403x.

The `publicationCount` term deserves separate emphasis. It is the scholar's total indexed publication
count with no topical relation whatsoever, it is unfiltered so it applies to every document, and it enters
the same additive sum as the topical signals. Two scholars whose on-topic evidence is identical are
separated by their career volume, monotonically, with no cap.

Caveats on the evidence, stated rather than glossed:

- Six data points in the boost table, and area cannot be fully separated from other per-scholar factors
  without per-hit match-explain output. The direction is clear; the coefficient is not.
- If the `_explain` above ran against the assembled body rather than the bare `bool`, those values
  already contain the inner multipliers and the true text-only spread is even narrower than 1.14x — which
  strengthens the conclusion but means the number is a bound, not a measurement. Re-run against
  `{ bool: { must, filter } }` alone to settle it.
- The staging task definition has `SEARCH_PEOPLE_FACULTY_PROMINENCE=off`, so any reconstruction of a
  staging ordering must drop the +1.0 faculty term. Staging and prod are not the same function.

Related bound: `SEARCH_MESH_ENTRY_TIER_PARITY` multiplies the attribution weight, which is a minority
component of the total. It is necessary but not sufficient for this class of inversion.

### The method-family tier is the largest single demotion, and it is a coverage cliff

Measured on the same staging query. Dividing each scholar's app score (`match=exact`) by their raw BM25
against the bare `bool` isolates everything applied above the text layer:

| scholar | method-family match | raw BM25 | app score | ratio |
|---|---|---|---|---|
| A | yes | 34.59 | 2098 | 60.7 |
| B | yes | 32.14 | 1549 | 48.2 |
| C | yes | 34.84 | 1645 | 47.2 |
| F | yes | 30.48 | 1217 | 39.9 |
| **D** | **no** | **34.78** | **748** | **21.5** |
| **E** | **no** | **33.36** | **728** | **21.8** |

The set separates perfectly on one binary: every scholar carrying a method-family tag lands at 39.9-60.7,
every scholar without lands at 21.7. The group means are 49.0 and 21.7, a quotient of **2.26** against
`PEOPLE_METHOD_FAMILY_TAG_WEIGHT = 2.0` (`lib/search.ts:991`); the residual 0.26 is absorbed by the
differing `ln(1 + publicationCount)` and area tiers. Scholars D and E have the two highest
tagged-descriptor shares in the set (42.5% and 39.3%) and finish 9th and 15th.

This is a **coverage** cliff, not a relevance judgement. The tier is binary — `match_phrase{methodFamily}`
either fires or it does not (`lib/api/search.ts:2827-2832`) — so a scholar whose work uses the method but
whose publications were never method-indexed takes a flat halving against an otherwise identical peer. It
is the largest single factor in the pipeline and it rewards an ETL annotation, not the query.

Read this before proposing a fix to the area boost or the volume prior: **neither of those touches this
term.** A ranking fix aimed at #2018 will not move a scholar demoted by a missing method tag.

**Confirmed by reconstruction, without a deploy.** `match=exact` sets `meshOff`
(`lib/api/search-flags.ts:126-128`), and both area-concentration blocks are gated on `!meshOff`
(`app/api/search/route.ts:613, 635`). So under `exact` there is no MeSH attribution, no concept
admission and **no area term at all** — the score reduces to

```
app = BM25  x  2.0^(method tag)  x  productivity  x  ( 1 + ln(1 + publicationCount)
                                                       + 0.5 if active grants )
```

with the faculty term absent on staging (`SEARCH_PEOPLE_FACULTY_PROMINENCE=off`). Fitting that to the six
measured scores leaves a residual constant of **3.60-3.71, a 2.9% spread** — against a 2.8x separation
before the method term is applied. One binary factor collapses two disjoint groups into one band.

This also validates the measurement method for #2018 above: because the area boost is absent under
`exact` and present under `expanded`, the `exact -> expanded` delta genuinely does contain the area term,
so attributing that delta's monotonicity to the area rollup is sound.

Caveats: n=6. The residual is not fully pinned — the fit tightens from 9.9% to 2.9% if the grants term is
credited to all six, but two of them carry `hasActiveGrants: false`, so roughly +0.5 is reaching them from
something not yet identified. That is a small unexplained term, not a competing explanation for the 2x.
`SEARCH_PEOPLE_METHOD_FAMILY_TIER=off` would still isolate it exactly, at the cost of a staging deploy.

### Latent: `position_increment_gap` and the phrase boost

`lib/api/search.ts:2099` justifies the #1344 phrase slop as "kept well below the default
`position_increment_gap` of 100 so a phrase can't bridge two unrelated titles in the concatenated
`publicationTitles` rollup". The 100 default is real and the mapping correctly does not override it —
but `position_increment_gap` only inserts positions between elements of an **array** of values, and
`publicationTitles` is `titleParts.join(" ")`, a single string (`lib/search-index-docs.ts:1352`). Adjacent
titles occupy adjacent token positions, so a slop-8 `match_phrase` can straddle the boundary between two
papers. `SEARCH_PEOPLE_PHRASE_BOOST` is on in both envs, so this is live, not latent.

### Misleading rationale on `areasOfInterest`

`lib/search.ts:733` justifies dropping `areasOfInterest` 6 -> 3 as "down-weight self-reported signal". The
indexed field is not self-reported: it is `s.topicAssignments.map(t => t.topic).join(" ")`
(`lib/search-index-docs.ts:1011`), ordered by assignment score, sourced from ReciterAI/ETL. The weight may
still be right; the stated reason does not match what is in the field.

## Traps

**A CDK flag value is not the runtime value.** Flags live in the `sps-app-<env>` task definition
environment built by `cdk/lib/app-stack.ts` (per-env ternaries on `envConfig.envName`, `:178`) — **not in
the image**. CD re-rolls the image only. A merged or edited flag stays `undefined` at runtime and dark
until an explicit `cdk deploy Sps-App-<env>`. Read the **running** task definition before asserting live
posture, and note that on prod `containerDefinitions[0]` is `otel-collector` — the app is index 1, so a
JMESPath query against `[0]` returns empty and reads as "flag absent".

The consequence is not theoretical. A flag can be "off in prod" because it is *absent* rather than
because the wired value is `off`, and those two states diverge the moment someone deploys. This applies
with most force to `SEARCH_PEOPLE_FACULTY_PROMINENCE`, the single most consequential per-env ranking
divergence: if staging's running revision predates that entry, staging is silently running the prod
wrapper and any staging-vs-prod ranking comparison is invalid.

**A tier change cannot move the result set.** `meshMatchTier` is read at two sites, both weight lookups
(`lib/api/search.ts:2495, 2818`), and it is absent from `meshConceptEligible` (`:2438-2443`).
`MESH_ADMIT_WEIGHT` is the score of a clause whose presence admits; zeroing all four values would admit
identical documents. So `SEARCH_MESH_ENTRY_TIER_PARITY` is a pure reorder and cannot change a total or a
badge count. Tuning any weight to fix a missing-scholar complaint is a category error — look at the
[SET levers](#levers-that-change-the-admitted-set) instead.

**`searchPublications` takes no `meshMatchTier`.** Its options accept `meshResolution` and `meshStrict`
only (`lib/api/search.ts:4158-4181`), and `meshMatchTier` appears in `lib/api/search.ts` solely inside the
`searchPeople` options type (`:1615`) and its one read (`:2409`). People-tier work is invisible to the
Publications tab. Conversely, `concept_expanded` / `concept_filtered` / `concept_fallback` are
**publications** shapes assigned only inside `searchPublications` (`:4344, :4433, :4436`); the two reserved
people values are declared and never assigned. No people query can produce any of the three.

**The two shape ladders run in different orders.** The telemetry label ladder is name -> topic -> dept ->
hybrid, last-write-wins (`:1955-1959`); the body ternary is name -> dept -> hybrid -> topic,
first-match-wins (`:2128-2242`). They agree today only because `opts.shape` is a single discriminant, so
at most one `apply*` boolean is true. Nothing asserts that invariant. If a future change makes two true
simultaneously, the logged shape and the executed body diverge silently.

**The escalation mutates shared objects in place.** `topicBool.must` is reassigned at `:2478`, and `must`,
the facet aggregations and the count-only body all hold references to the same object. Any instrumentation
that snapshots `body` before the first dispatch reports the pre-escalation query. Relatedly,
`matched_queries` may be empty on a hit even when a named clause fired — the code documents at
`:2467-2471` that named-query reporting does not reliably survive the outer `function_score`, so it is an
unreliable diagnostic through the full body.

**The offline dry-run harness defaults to the opposite mode from production.**
`scripts/people-relevance-dryrun.ts:63-64` reads `SEARCH_PEOPLE_RELEVANCE_MODE === "v3" ? "v3" :
"legacy"`, while production's resolver is `=== "legacy" ? "legacy" : "v3"`
(`lib/api/search-flags.ts:53`). With the variable unset — the deployed state, since the flag is
allowlisted rather than wired — production runs v3 and the harness runs **legacy**. Any Recall@ number
from an unset-env dry-run measured a body production does not run. The harness also omits
`knownDivisions` (`:83-89`), so it can never exercise division routing.

**`opts.meshMatchTier ?? "exact"`** (`:2409`) defaults an un-threaded caller to the **highest** weights.
A harness that passes `meshDescendantUis` but forgets `meshMatchTier` silently measures the exact tier, so
a tier A/B run that way is invalid.

**Anchor-dependent findings do not transfer between environments.** `mesh_curated_topic_anchor` has
drifted — 85 distinct descriptors in prod against 349 in staging. Anchors feed the tier (order) and the
descriptor tiebreak (set) and the area fold-in (order), so `areas[0]`, and therefore which area's
concentration is credited, can differ between environments for the identical query. Check the table before
generalising a staging result.

**`DESCENDANT_HARD_CAP = 200` truncates in tree-walk order** (`search-taxonomy.ts:1060-1062`). Under
`match=concept` a broad descriptor's admitted set is a semi-arbitrary 200-descriptor prefix of the
subtree. Do not describe the concept gate as "the whole subtree"; the repo documents the resulting
undercount at `lib/api/search.ts:532-539`.

**`lastNameSort` pollution reaches the classifier, and a code-only fix is inert.** `lastNameSort` is
written by the ETL as `extractLastNameSort(s.preferredName)` (`lib/search-index-docs.ts:1333`), which
returns the last whitespace token after stripping only generational/honorific suffixes
(`lib/name-sort.ts:10, 17-24`). Where `preferredName` carries a `" - <OrgUnit>"` suffix, the org-unit word
becomes the sort key — and `loadSurnames` aggregates that **indexed** field into `knownSurnames`
(`people-classifier-sets.ts:87`), so department words become first-class surnames, `surnameAnchor` fires
on the trailing token, and rung 6 returns `name`. The same corrupted key drives the A-Z browse prefix
filter (`search.ts:2374`, which is in `queryFilter`, so it changes the set and the facet counts) and the
last-name sort clause (`:2682`). Fixing `extractLastNameSort` alone changes nothing until a people reindex
lands and the 24h classifier cache expires. Any fix that blacklists department words from `knownSurnames`
instead of fixing extraction needs the surname/department overlap enumerated first — some of those tokens
are legitimate surnames somewhere in the corpus.

**This repository is public.** Never commit scholar names, CWIDs, `preferredName` strings, host IPs,
campus CIDRs, or internal hostnames. Several already-committed files contain real names in comments and
measured before/after tables; that is prior art, not licence to add more. Quoting those passages into a
new document republishes them in a fresh, greppable location.
