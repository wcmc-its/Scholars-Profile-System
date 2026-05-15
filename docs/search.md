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

A `multi_match` over a fixed field set with per-field boosts:

| Field | Boost | What it captures |
|---|---|---|
| `preferredName` | 10 | Display name (e.g. "Lewis C. Cantley") |
| `fullName` | 10 | Full legal name + alternate forms |
| `areasOfInterest` | 6 | Self-reported research interests (free-text) |
| `primaryTitle` | 4 | "Professor of Medicine", etc. |
| `primaryDepartment` | 3 | Department display string |
| `overview` | 2 | Bio paragraph from Faculty Profiles / VIVO |
| `publicationTitles` | 1 | Concatenated titles, **authorship-weighted** |
| `publicationMesh` | 0.5 | MeSH terms from the scholar's pubs, authorship-weighted |
| `publicationAbstracts` | 0.3 | Concatenated abstracts (one copy per pub) |

Two extra wrinkles on top of the multi_match:

- **CWID short-circuit.** If the trimmed query lowercased exactly matches a `cwid` keyword, that doc gets `boost: 100`, so pasting `lcc2010` always pins Cantley at the top regardless of name overlap.
- **Authorship weighting at index time.** Titles and MeSH for first/last-author papers are repeated 10× in the field; second/penultimate 4×; middle 1×. The query-time boost is then the spec value (×1, ×0.5) without further math. This is how a scholar who is consistently first-author on "kinase signaling" papers outranks one who appeared as middle author on a single such paper.
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
