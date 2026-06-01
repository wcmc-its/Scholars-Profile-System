# Relevance Search

How the unified search at `/search` ranks **people**, **publications**, and **grants**, and what signals back each rank.

Sibling docs: `browse-vs-search.md` (when to browse vs. search), `search-publications.md` (example-driven walkthrough of the pub tab, including MeSH-aware behavior), `taxonomy-aware-search.md` (the v2.x SPEC behind the MeSH work), `ADR-001-runtime-dal-vs-etl-transform.md` (why ranking signals are pre-computed in ETL).

---

## Architecture at a glance

| Concern | Where it lives |
|---|---|
| Index builder | `etl/search-index/index.ts` |
| Index mappings + boosts | `lib/search.ts` |
| People / Publications query | `lib/api/search.ts` |
| Grants query | `lib/api/search-funding.ts` |
| Taxonomy callout | `lib/api/search-taxonomy.ts` (substring match against curated topics/subtopics) |
| Autocomplete (mixed entities) | `suggestEntities()` in `lib/api/search.ts` |

Three OpenSearch indices, one document type each:

- `scholars-people` — one doc per active scholar (~9k docs)
- `scholars-publications` — one doc per PMID (~90k docs)
- `scholars-funding` — one doc per **project** (Account_Number), pre-deduped across per-(scholar, account) Grant rows

A single query string is fanned out to all three indices in parallel; each tab renders independently with its own facets, sort options, and pagination (PAGE_SIZE = 20 throughout).

---

## How relevance is computed

### People (`searchPeople` / `scholars-people`)

People-tab relevance is **shape-routed** (people-relevance SPEC §6.1; the default since PR-5, #312). A lexical classifier labels each query — `name`, `topic`, `department`, `hybrid`, `cwid`, or `unclassified` — and each shape gets a ranking template tuned to it, because no single strategy wins across "cantley" (known-item lookup), "ras signaling pancreatic cancer" (topical), and "cardiology" (department):

- **`name`** — name fields only (`preferredName`/`fullName` phrase + match, `lastNameSort` term). A surname no longer fans in unrelated scholars through their publication text.
- **`topic` / `unclassified`** — a `cross_fields` body that leads with publication-derived evidence (`publicationTitles`, `publicationMesh`) over self-reported `areasOfInterest`, wrapped in a multiplicative `function_score`: a topic-attribution boost (scholars whose pubs carry a descendant of the resolved MeSH descriptor), a productive-author multiplier, and a sparse-profile decay.
- **`department`** — `primaryDepartment` (20) + `primaryTitle` (8) + a soft `preferredName`/`fullName` fallback (2). No publication fields.
- **`hybrid`** (e.g. "cantley ras") — the name template's clauses plus the topic boost ladder, summed additively so the named scholar pins to the top while the remaining terms still rank everyone else by topical evidence.
- **`cwid` / unrouted** — the **restructured body**: `cross_fields` + minimum-should-match (`2<-34%`) over the high-evidence fields, with `publicationAbstracts` in a scoring-only `should`. This is also the body the `legacy` rollback mode applies to every shape.

Set `SEARCH_PEOPLE_RELEVANCE_MODE=legacy` to roll the whole tab back to the restructured body (the pre-#312 behavior) without redeploying. (PR-5 retired the older `SEARCH_PEOPLE_QUERY_RESTRUCTURE` flag and its flat `best_fields` body.)

Cross-cutting mechanics (every shape):

- **CWID short-circuit.** If the trimmed query lowercased exactly matches a `cwid` keyword, that doc gets `boost: 100`, so pasting `lcc2010` always pins Cantley at the top regardless of name overlap.
- **Authorship weighting at index time.** Titles and MeSH for first/last-author papers are repeated 10× in the field; second/penultimate 4×; middle 1×. The query-time boost is then the spec value without further math — how a consistent first-author on "kinase signaling" outranks a one-time middle author.
- **MeSH minimum-evidence threshold.** A MeSH term is contributed only when it appears in ≥2 of the scholar's pubs OR in ≥1 first/last-author pub. Filters drive-by single-mention noise before it ever reaches the index.
- **English stemming + stopwords.** Custom `scholar_text` analyzer strips English stopwords and stems, so "comorbidity" / "comorbidities" are interchangeable and queries like "psychiatric comorbidities **in** serious illness" don't flood with profiles whose only commonality is "in".

Sort options: relevance (default `_score`), Last name A–Z (uses dedicated `lastNameSort` keyword to avoid sorting "Given Last" by first name), Most recent publication.

### Publications (`searchPublications` / `scholars-publications`)

`multi_match` with these boosts:

| Field | Boost |
|---|---|
| `title` | 4 |
| `meshTerms` | 2 |
| `authorNames` | 2 |
| `journal` | 1 |
| `abstract` | 0.5 |

`best_fields` scoring (multi_match default) ensures the strongest single-field match dominates — a passing abstract mention can't outrank a direct title hit. Sort options: relevance, year (newest first), citation count.

On the **relevance** sort the BM25 `_score` is multiplied by a recency tilt — a `function_score` Gaussian decay on `year` so recent work isn't buried under foundational old papers (issue #645, `SEARCH_PUB_RELEVANCE_RECENCY`, default `gentle`, ceiling 3×). Keyword match stays primary (old papers floored at 1×); explicit `year`/`citations`/`impact`/`recency` sorts are unwrapped. Mechanism + calibration: `docs/search-recency-relevance-spec.md`; pub-tab explainer: `docs/search-publications.md`.

### Grants (`searchFunding` / `scholars-funding`)

`multi_match` with these boosts:

| Field | Boost |
|---|---|
| `title` | 4 |
| `sponsorText` | 2 (concatenated canonical short + full + raw + aliases for prime AND direct sponsor) |
| `peopleNames` | 1 (WCM scholars on the project) |
| `abstract` | 1 (RePORTER / NSF / PCORI / CDMRP / Gates) |

Sort options: relevance, end date (active first via script-sort using a 12-month NCE grace window), start date, publication count.

`status` (active / ending_soon / recently_ended) is **not** a stored field — the NCE grace window means the bucket would drift between re-indexes — so it's computed at query time as date ranges over `endDate`.

---

## Filter / facet model (shared across all three tabs)

Every facet axis is **multi-select**, with `OR` within an axis and `AND` across axes. To make this work with intuitive "if I tick this next, what would I get?" bucket counts, the query body is split:

- **Always-on filters** (sparse-profile cull, topic pre-filter) live on the main query so aggregations respect them.
- **User-axis filters** move to `post_filter`, so each per-facet aggregation can re-apply only the **other** axes and produce correct excluding-self counts. Without this split, ticking "Full-time faculty" would collapse the Person Type list to a single bucket.

This pattern is used identically in `searchPeople`, `searchPublications`, and `searchFunding`.

### Per-tab facets

| Tab | Facets |
|---|---|
| People | Department/Division (composite keyword `deptCode--divCode`), Person Type, Activity (`has_grants`, `recent_pub` = last 2 years) |
| Publications | Year range, Publication Type, Journal (top 500 by count + client-side typeahead), WCM Author Position (first / senior / middle), WCM Author (top 500, hydrated server-side with name/slug/avatar; cardinality sub-agg surfaces true distinct count), Mentoring Programs (MD / MD-PhD / ECR via precomputed pmid buckets) |
| Grants | Funder (prime), Direct Funder (subaward issuer), Program Type, Mechanism (NIH activity code), Status (active / ending soon / recently ended), Department (lead PI's primary appointment), Role (PI / Multi-PI / Co-I), Investigator (top 500, hydrated) |

---

## Autocomplete

`suggestEntities()` returns a mixed ranked list of **people, parent topics, subtopics, departments, divisions, centers, institutes** — fired at 2 chars, capped at `perKind = 3` per source. The people side uses the OpenSearch completion suggester on the `nameSuggest` field, indexed with:

- The canonical preferredName
- Trailing-token slices ("Cary Reid", "Reid" for "M. Cary Reid") so middle-token prefixes match
- A `firstLastSlice` ("Ronald Crystal" for "Ronald G. Crystal") so users typing first+last find names with middle initials
- A digit-preserving `scholar_suggest` analyzer so CWIDs like `pja9004` survive (the default `simple` analyzer would strip the digits)

The other entity types are direct Prisma `contains` lookups against `Topic.label`, `Subtopic.label`, `Department.name`, `Division.name`, `Center.name`. (Subtopic match-on-`label` rather than `displayName` is intentional per Phase 3 D-19: `label` is the synthesis-canonical field; users typing research-domain words match it more reliably.)

A separate **taxonomy-match callout** above the result tabs (`matchQueryToTaxonomy()`) does a normalized substring match (lowercase + strip non-alphanumeric, so "cardio-oncology" / "cardio oncology" / "cardiooncology" collapse) against curated parent topics and subtopics, ranks by entity type → scholarCount → similarity → name, and surfaces the best curated landing page when one exists.

---

## Signals: what we use and what we could

### Currently in production

| Signal | Source | Surface | Coverage |
|---|---|---|---|
| Preferred / full name | Faculty Profiles → Scholar table | People (boost 10), autocomplete | ~100% of active scholars |
| Areas of interest | Faculty Profiles free-text | People (boost 6) | Sparse — only scholars who maintain a profile (estimated ~50%) |
| Primary title + department | Faculty Profiles + ED feed | People (boost 4 / 3), facets | ~100% (ED is authoritative) |
| Bio overview | Faculty Profiles → `Scholar.overview` | People (boost 2) | ~30–50% (long tail of scholars with no bio) |
| Publication titles | ReCiter → Publication table | People (boost 1, authorship-weighted), Publications (boost 4) | ~100% of papers ReCiter has accepted (~90k); coverage gap is unconfirmed pubs in pending/rejected state |
| MeSH terms | PubMed via ReCiter | People (boost 0.5, authorship-weighted, ≥2-pub or first/last threshold), Publications (boost 2) | ~90% of indexed pubs (NLM lag for newest papers; non-MEDLINE journals never get MeSH) |
| Abstracts | PubMed via ReCiter | People (boost 0.3, one copy per pub), Publications (boost 0.5) | ~95% of indexed pubs |
| Author names (free-text) | ReCiter author rows | Publications (boost 2) | ~100% of indexed pubs |
| WCM author identity | `publication_author` join | Publications facet, chip rendering, role buckets (first/senior/middle) | ~100% for WCM-affiliated authors |
| Journal | NLM journal table | Publications (boost 1), facet | ~100% |
| Citation count | NIH iCite | Publications sort | ~100% of indexed pubs (lag of weeks) |
| Mentoring relationships | Mentoring rollups (`mentoring-pmids`) | Publications facet (MD / MD-PhD / ECR) | Limited to known mentor-mentee pairs in WCM training programs |
| Project title + abstract + sponsor + people | InfoEd + RePORTER / NSF / PCORI / CDMRP / Gates | Grants relevance | Title/sponsor ~100%; abstract present for ~60–80% (federal awards strong, industry awards rarely have public abstracts; abstractSource records origin) |
| Award number / mechanism / NIH IC | InfoEd | Grants facet, deep links | ~100% for NIH; mechanism is null for non-NIH funders |
| Active grants flag | InfoEd end_date + NCE grace | People activity facet | ~100% |
| Topic / subtopic attribution | ReciterAI synthesis | Taxonomy callout, topic pre-filter on People search | High for scholars with ≥3 pubs in the relevant area; long tail of one-off pubs not attributed |
| Recent publication date | Publication table | People sort + activity facet | ~100% |
| CWID exact match | Scholar table | People (boost 100 short-circuit), autocomplete | ~100% |

### Plausible future signals (not yet wired)

| Signal | Why it would help | Coverage outlook |
|---|---|---|
| Co-authorship graph proximity | Personalized re-rank: when one scholar is logged in, surface their collaborators' work first | Derivable from `publication_author`; full coverage |
| Citation-weighted authorship | Boost a scholar on a topic when they're a high-citation first/last author there, not just frequent | iCite covers ~100% of PubMed-indexed pubs |
| Embedding similarity (titles + abstracts) | Catches semantic matches the BM25 + stem layer misses ("cardiac aging" ≈ "senescence in cardiomyocytes") | Would need an indexer step + `dense_vector` field; coverage limited only by abstract availability |
| Journal impact / quartile | Tiebreaker on Publications relevance sort | NLM + JCR or SCImago; ~95% of cited journals |
| Grant → publication acknowledgement strength | Currently we link via NIH grant numbers in PubMed and project-level rollup; scholar-level acknowledgement strength could weight grants | RePORTER pub-link present for ~80% of NIH projects; weaker on industry |
| Funder canonical alias graph | "Bristol Myers Squibb" / "BMS" / "BMSCO" already collapse on grants via `sponsorText`; could extend to people search | Already maintained for InfoEd ETL |
| Trial registry (ClinicalTrials.gov) | Surface PIs by active trial topic | NCT linkage exists but not indexed |
| Patent records | Surface inventors by topic | USPTO assignee parse needed; coverage ~70% for WCM faculty |
| Peer-review activity | Editorial board / reviewer roles as a "domain expert" signal | No structured source today |
| Course catalog | Surface educators by teaching topic | Jenzabar export available; not currently indexed |
| Click-through telemetry | Re-rank by historical CTR per (query, result) | Need analytics warehouse first; cold-start problem for long tail |

### Known coverage gaps

- **Bio overview** is the weakest first-class signal — many scholars have an empty `overview` and rely on areasOfInterest + publication titles to surface for thematic queries.
- **MeSH lag**: papers added in the last ~6 months may not have MeSH yet, so a brand-new scholar with all-recent pubs is under-represented in topic-based people search until NLM catches up.
- **Subaward topology**: `directSponsor` is captured but the chain (prime → first sub → us) is flattened to two hops; multi-hop subawards lose their middle nodes.
- **Sparse profiles**: the `isComplete` flag (overview + ≥3 pubs + active grant) is computed at index time but no longer applied by default (#152) — the directory baseline shows every active scholar. Callers can opt back in by passing `includeIncomplete: false`.
- **Topics / subtopics** depend on ReciterAI rollups; scholars whose pubs haven't been attributed yet won't show in the topic pre-filter even when their pub titles match the query.

## Index rebuilds (alias swap)

The three names referenced by the query path -- `scholars-people`, `scholars-publications`, `scholars-funding` -- are OpenSearch aliases, not concrete indices. Each alias points at a versioned concrete index (`scholars-people-v3`, etc.). Rebuilds happen via the alias-swap pattern (B18, #117) implemented in `etl/search-index/alias-swap.ts`; the goal is zero unavailability window during the multi-minute bulk-write.

### Mechanism

A rebuild against, e.g., `scholars-people`:

1. **Resolve current state.** Is `scholars-people` an alias (and if so, at which target), a concrete index (pre-B18 deployed state), or absent (fresh deploy)?
2. **Pick next version.** From `alias` state, parse the `-v{N}` suffix and pick `-v{N+1}`. From `index` or `absent` state, pick `-v1`.
3. **Create the new concrete index** with the mapping. Existing reads against `scholars-people` continue to land on the old target.
4. **Bulk-write all documents** into the new concrete index. Multi-minute step at scale; the alias still points at the old index, so query results are stable.
5. **Atomically swap the alias** via `POST /_aliases` with an action body that adds the alias to the new concrete index and either removes it from the old concrete index (`alias` state) or deletes the old concrete index (`index` state, first-time bootstrap migration) -- both in a single OpenSearch cluster-state transition.
6. **Prune old versions.** Retention default is 2: the just-promoted version and the immediately-previous version are kept; older are deleted. Adjust per-call via the `retain` argument.

The rebuild orchestrator lives in `etl/search-index/index.ts`; the mechanism in `etl/search-index/alias-swap.ts`. Unit-test coverage (mocked OpenSearch client) is in `tests/unit/etl-alias-swap.test.ts`.

### Bootstrap migration

The first run of the new code per env converts the existing concrete `scholars-people` (etc.) into an aliased form. This is the only step with a *brief* window where reads against the alias name miss: the `_aliases` body uses `remove_index` to delete the old concrete index in the same atomic call that adds the alias pointing at `-v1`. Single-digit-millisecond unavailability window per index, versus the multi-minute destructive window of the pre-B18 ensure-index flow. Recommend running the first rebuild during low-traffic hours; subsequent rebuilds have zero window.

### Rollback

Roll the alias back to the previous version when a fresh rebuild ships semantically-bad data (e.g. ETL bug populates docs with `null` MeSH terms). With `retain=2` the previous version is still on disk:

```sh
# 1. Identify the current and previous versions.
curl -s "$OPENSEARCH_NODE/_alias/scholars-people" | jq .
# returns { "scholars-people-v4": { "aliases": { "scholars-people": {} } } }
# look at the list of versioned indices to find scholars-people-v3 (the previous):
curl -s "$OPENSEARCH_NODE/_cat/indices/scholars-people-v*?h=index&format=json"

# 2. Repoint the alias atomically.
curl -s -XPOST "$OPENSEARCH_NODE/_aliases" -H 'content-type: application/json' -d '{
  "actions": [
    { "remove": { "index": "scholars-people-v4", "alias": "scholars-people" } },
    { "add":    { "index": "scholars-people-v3", "alias": "scholars-people" } }
  ]
}'
```

We deliberately do not ship a wrapped CLI for this because the operator inputs are too situational to script safely (which prior version to roll back to depends on which one was last known good, and the same call shape covers all three aliases). The runbook procedure above is the contract.

### Retention tuning

The default of 2 covers "roll back to immediately-previous." Bump higher when shipping a known-risky rebuild (e.g. a new mapping shape) by passing `retain: 5` once and reverting on the next deploy. Per-call override; no env-config knob (the right value is situational, not per-env).
