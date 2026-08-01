/**
 * OpenSearch client + index mapping helpers (decision #7).
 *
 * Two indices per spec: `people` and `publications`. Per-field boost weights
 * (spec lines 156, 165) are applied at QUERY time via multi_match — not at
 * index time. Authorship-weighted contributions (×1.0 / ×0.4 / ×0.1) ARE
 * applied at index time via term repetition into the publication_titles and
 * publication_mesh fields on the people document.
 *
 * Production target: AWS OpenSearch Service (managed, IAM-integrated).
 * Local dev: docker container at OPENSEARCH_NODE.
 */
import { Client, type ClientOptions } from "@opensearch-project/opensearch";
import { isInOsRequestScope, recordOsRoundTrip } from "@/lib/api/os-round-trips";
// #1980 fix (2) — dependency-free leaf module (no Prisma graph), so importing it here
// carries none of the risk `isFullQueryMeshMatch`'s docblock (lib/api/normalize.ts)
// warns about for THIS module's own wholesale `vi.mock("@/lib/search")` suites.
import { singularizeForMatch } from "@/lib/api/normalize";

let _client: Client | null = null;

// Interactive-path request timeout. Without an override the client waits its
// 30s default on a wedged node/shard — an eternity for a user-facing search.
// Applied per-call (only inside a request scope), NOT on the client options,
// because ETL index builds share this singleton and legitimately run long.
// Env-tunable; 5s is ~10× the healthy p99 of the heaviest people query.
const OS_REQUEST_PATH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SEARCH_OS_REQUEST_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 5_000;
})();

/**
 * Build the OpenSearch client options from the environment.
 *
 * Production is an AWS OpenSearch domain with fine-grained access control +
 * the internal user database (see cdk/lib/data-stack.ts): the client
 * authenticates with an `Authorization: Basic` header, NOT SigV4, so we pass
 * `auth: { username, password }` from `OPENSEARCH_USER` / `OPENSEARCH_PASS`.
 * `OPENSEARCH_NODE` is the `https://`-scheme domain endpoint, injected by the
 * app + ETL task definitions. Local dev runs an unauthenticated docker
 * container, so auth is omitted when the credential vars are absent.
 *
 * Pure (reads only `env`) so it can be unit-tested without constructing a
 * real client.
 */
export function searchClientOptions(
  env: Record<string, string | undefined> = process.env,
): ClientOptions {
  const node = env.OPENSEARCH_NODE ?? "http://localhost:9200";
  const username = env.OPENSEARCH_USER;
  const password = env.OPENSEARCH_PASS;
  return username && password
    ? { node, auth: { username, password } }
    : { node };
}

export function searchClient(): Client {
  if (_client) return _client;
  const client = new Client(searchClientOptions());
  // D3 SLI — wrap `.search` ONCE at construction so every request-path
  // OpenSearch round-trip increments the active per-request counter
  // (lib/api/os-round-trips.ts). `recordOsRoundTrip` is inert outside a
  // `runWithOsRoundTripCounter` scope, so ETL / index-build calls through the
  // same singleton are unaffected.
  //
  // Inside a request scope the wrapper also injects a fail-fast transport
  // timeout (+ a single retry) so a wedged node degrades a user search in
  // seconds, not the client's 30s default. Explicit per-call options win over
  // the injected defaults; out-of-scope (ETL) calls pass through untouched.
  const originalSearch = client.search.bind(client);
  client.search = function (...args: Parameters<typeof originalSearch>) {
    recordOsRoundTrip();
    if (isInOsRequestScope()) {
      const [params, options] = args as unknown as [unknown, Record<string, unknown> | undefined];
      return originalSearch(params as Parameters<typeof originalSearch>[0], {
        requestTimeout: OS_REQUEST_PATH_TIMEOUT_MS,
        maxRetries: 1,
        ...options,
      });
    }
    return originalSearch(...args);
  } as typeof client.search;
  _client = client;
  return _client;
}

// Since B18 (#117), each of the three names below is an OpenSearch ALIAS,
// not a concrete index. The alias points at a versioned concrete index
// (`scholars-people-v3`, etc.) created and atomically swapped by the
// rebuild flow in `etl/search-index/alias-swap.ts`. Application reads and
// writes against these constants resolve to the current versioned target
// transparently; rebuilds happen with zero unavailability window. The
// literal *values* of the three constants are stable -- env-to-env
// references (e.g. `_index` in bulk-write headers from the indexer) bind
// to these names and must not change without a coordinated cross-env
// rebuild.
export const PEOPLE_INDEX = "scholars-people";
export const PUBLICATIONS_INDEX = "scholars-publications";
export const FUNDING_INDEX = "scholars-funding";
// GrantRecs Phase 2 — funding OPPORTUNITIES (not awarded grants), projected
// from the `opportunity` MySQL table (itself fed by ReciterAI `GRANT#`).
export const OPPORTUNITIES_INDEX = "scholars-opportunities";

/**
 * Mapping for the people index. Note that authorship-weighted contributions
 * are pre-multiplied at index time (publication titles and MeSH terms appear
 * in the document N times based on authorship position), so the search-time
 * boost for those fields is the spec value (×1, ×0.5) without further math.
 */
export const peopleIndexMapping = {
  settings: {
    // Default `index.max_result_window` is 10000 — clicking page 501+
    // (with PAGE_SIZE 20) hits a 500 response. People index is small
    // (~9k docs) so 100k is fine; cheap insurance against future growth.
    "index.max_result_window": 100000,
    analysis: {
      analyzer: {
        // Custom analyzer that strips English stopwords and applies stemming
        // so queries like "psychiatric comorbidities IN serious illness" do
        // not flood with profiles whose only commonality is the word "in",
        // and "comorbidity" / "comorbidities" are interchangeable. (#20)
        scholar_text: {
          type: "custom" as const,
          tokenizer: "standard",
          // `alnum_delimiter` + `flatten_graph` split letter↔digit boundaries
          // (preserving the fused original) so "covid19" and "covid-19" share a
          // token set. Without it the standard tokenizer keeps "covid19" as one
          // token that never matches the indexed "COVID-19" (covid+19), and the
          // People tab collapses from ~1,425 to 9. Applied at index AND search
          // time — scholar_text has no search_analyzer override. (#725)
          filter: [
            "lowercase",
            "alnum_delimiter",
            "flatten_graph",
            "english_stop",
            "english_stemmer",
          ],
        },
        // The completion suggester's default analyzer is `simple`, which
        // strips digits — so a CWID like "pja9004" indexes as the bare
        // prefix "pja" and any digits-only-different query (e.g.
        // "pja2002") spuriously matches it. Use a digits-preserving
        // analyzer (standard tokenizer keeps letter+digit runs intact)
        // so CWIDs survive while names still tokenize cleanly. NOTE: kept
        // OFF the alnum_delimiter split so CWIDs stay fused (#725).
        scholar_suggest: {
          type: "custom" as const,
          tokenizer: "standard",
          filter: ["lowercase"],
        },
      },
      filter: {
        // #725 — split glued alphanumerics (covid19 -> covid+19, p53 -> p+53)
        // while keeping the fused original. `flatten_graph` (in the analyzer
        // chain) makes the multi-position output safe for the stop/stemmer
        // filters that follow. No `catenate_*`: the standard tokenizer already
        // strips hyphens, so there is nothing to re-join, and a duplicate
        // same-position token would skew BM25.
        alnum_delimiter: {
          type: "word_delimiter_graph",
          split_on_numerics: true,
          preserve_original: true,
          generate_word_parts: true,
          generate_number_parts: true,
        },
        english_stop: { type: "stop", stopwords: "_english_" },
        english_stemmer: { type: "stemmer", language: "english" },
      },
    },
  },
  mappings: {
    properties: {
      cwid: { type: "keyword" },
      slug: { type: "keyword" },
      preferredName: {
        type: "text",
        analyzer: "scholar_text",
        fields: { keyword: { type: "keyword" } },
      },
      // Lowercased surname for the People "Last name (A–Z)" sort. The
      // preferredName.keyword field is "Given Last" so it sorts by first
      // name; this dedicated field carries just the last token (with
      // generational suffixes stripped) so Sort=lastname returns the
      // expected alphabetical order. Issue #82.
      lastNameSort: { type: "keyword" },
      fullName: { type: "text", analyzer: "scholar_text" },
      // Autocomplete suggester (spec line 184: fires on 2 chars).
      // Suggests "name + primary title" (Stanford-style; FunReq Figure C).
      nameSuggest: {
        type: "completion",
        analyzer: "scholar_suggest",
        search_analyzer: "scholar_suggest",
      },
      primaryTitle: { type: "text", analyzer: "scholar_text" },
      primaryDepartment: {
        type: "text",
        analyzer: "scholar_text",
        fields: { keyword: { type: "keyword" } },
      },
      // FK-resolved department/division (issue #8 item 4): used for the
      // combined "Department / division" facet. The composite key is
      // `deptCode` for dept-only rows and `deptCode--divCode` for division
      // rows so a single `terms` aggregation produces both kinds of buckets.
      deptCode: { type: "keyword" },
      divCode: { type: "keyword" },
      deptName: { type: "keyword" },
      divisionName: { type: "keyword" },
      deptDivKey: { type: "keyword" },
      deptDivLabel: { type: "keyword" },
      areasOfInterest: { type: "text", analyzer: "scholar_text" },
      // People-tab "concepts" identity hint (SEARCH_PEOPLE_CONCEPT_HINT) — an
      // array of { ui, label } MeSH descriptor objects, read from `_source` only
      // (never queried/aggregated; the chips deep-link via the ui), so store it
      // but do not index: `object` + `enabled: false`. Applied on the next people
      // rebuild via the alias-swap (no extra recreate).
      topMeshTerms: { type: "object", enabled: false },
      // D-exact (search reason-from-doc) — per-concept distinct-publication
      // counts ({ [conceptDescriptorUi]: distinctPubs }) the People reason line
      // reads from `_source` at query time, so the broad-concept search needs no
      // publications-index reason agg. Source-only (never queried/aggregated):
      // `object` + `enabled: false`. OMITTED on scholars with no MeSH-tagged pub.
      // Served only when SEARCH_PEOPLE_REASON_FROM_DOC is on.
      meshSubtreeCounts: { type: "object", enabled: false },
      // #1366 — per-method-family distinct-pub counts for the reason-line "N of M".
      // Dynamic family-label keys ⇒ store in `_source` but DON'T index (object +
      // enabled:false), same as `meshSubtreeCounts`, to avoid a mapping explosion.
      methodFamilyCounts: { type: "object", enabled: false },
      // #1366 — per-parent-topic distinct-pub counts (dynamic topic-slug keys);
      // store in `_source`, don't index — same rationale as `methodFamilyCounts`.
      areaCounts: { type: "object", enabled: false },
      // #1367 Gap 1 — the clinical evidence line's "eligible" pool: the
      // scholar's count of visible pubs carrying ANY MeSH descriptor at all.
      // A plain scalar (unlike the per-key rollups above), so it's a real
      // `integer` field like `publicationCount` — not `object`/`enabled:false`.
      meshTaggedPubCount: { type: "integer" },
      // #1367 Gap 1 — per-specialty on-topic distinct-pub counts (dynamic
      // specialty-name keys) for the clinical evidence line's "N of M eligible
      // publications" display. Source-only (never queried/aggregated) — same
      // `object` + `enabled:false` convention as `areaCounts`/`meshSubtreeCounts`.
      clinicalOnTopicCounts: { type: "object", enabled: false },
      overview: { type: "text", analyzer: "scholar_text" },
      // Issue #310 / SPEC §6.1.5 — materialized inputs to the topic-shape
      // sparse-profile soft decay. The decay's "non-trivial" thresholds
      // (overview length > 200, >= 3 AOI topic terms) can't be evaluated
      // against the analyzed text fields above, so they're indexed as integers
      // the function_score range filter reads. `aoiTermCount` is the
      // topic-assignment count, not a token count of `areasOfInterest`.
      overviewLength: { type: "integer" },
      aoiTermCount: { type: "integer" },
      publicationTitles: { type: "text", analyzer: "scholar_text" },
      publicationMesh: { type: "text", analyzer: "scholar_text" },
      // Issue #310 / SPEC §6.1.3 — per-scholar rollup of MeSH descriptor UIs
      // (Dnnnnnn), min-evidence-filtered in the ETL like `publicationMesh`.
      // `keyword` (multi-valued) so the v3 topic-shape attribution boost can
      // run `terms: { publicationMeshUi: descendantUis }` — the descendant-UI
      // subsumption match that `publicationMesh` (analyzed label text) can't
      // express. Same field intent as the publications index `meshDescriptorUi`.
      // OMITTED on scholars with no surviving descriptor (omit-on-empty).
      publicationMeshUi: { type: "keyword" },
      // #1959 — the descriptors the min-evidence gate dropped from the field
      // above, narrowed to ancestors of a surviving descriptor. STORED, NOT
      // INDEXED (`object` + `enabled: false`): it is only ever read back via
      // `_source` so `alsoParent` can tell "absent" from "below the gate", never
      // filtered or aggregated on, so indexing it would only cost index size.
      // Note the gotcha this shares with the other `enabled: false` fields —
      // readable via `_source`, INVISIBLE to `exists` queries.
      publicationMeshUiBelowThreshold: { type: "object", enabled: false },
      // Issue #21 — concatenated abstract text from each scholar's
      // confirmed publications. ONE copy per paper (no authorship-position
      // repetition); abstracts are 50-200x longer than titles, so the
      // weighting signal is captured by titles + mesh and we don't pay the
      // index-size cost of repeating the body text.
      publicationAbstracts: { type: "text", analyzer: "scholar_text" },
      // Filter facets.
      hasActiveGrants: { type: "boolean" },
      // Issue #233 — PI facet derived fields.
      piRoleEver: { type: "boolean" },
      activePiGrantCount: { type: "integer" },
      isComplete: { type: "boolean" }, // sparse-profile filter (spec line 196)
      personType: { type: "keyword" }, // person-type filter (spec line 195)
      // Counters used in result snippets.
      publicationCount: { type: "integer" },
      // Issue #254 §10 — global-quartile output bucket (0..4; 4 = most
      // prolific). Drives the autocomplete §6 primary tiebreak (descending) in
      // `tiebreakPeople`; the ETL stamps it in a second pass over the people
      // docs (`etl/search-index/index.ts`). Not consulted by the people-tab
      // function_score, which reads raw `publicationCount` (#513).
      pubCountBucket: { type: "integer" },
      grantCount: { type: "integer" },
      // For "most recent publication" sort (spec line 194) and the
      // "Published in last 2 years" activity filter (issue #8 item 15).
      mostRecentPubDate: { type: "date" },
      // Issue #532 — dept-shape leadership signal. `chairOf` / `chiefOf` carry
      // the lowercased department / division name(s) this scholar leads. The
      // dept-template's function_score boost matches on `term { chairOf:
      // trimmed.toLowerCase() }`; the classifier's `knownDepartments` set is
      // built from the SAME lowercased dept names (lib/api/people-classifier-
      // sets.ts), so the field IS the same vocabulary the classifier already
      // used to route the shape. `is*` flags are convenience for downstream
      // sorts / filters and not consulted by the dept template. OMITTED on
      // scholars who are neither chair nor chief (omit-on-empty).
      leadership: {
        type: "object",
        properties: {
          isChair: { type: "boolean" },
          chairOf: { type: "keyword" },
          isChief: { type: "boolean" },
          chiefOf: { type: "keyword" },
        },
      },
      // Issue #824 §4c — per-scholar rollup of the scholar's overlay-VISIBLE
      // method-family LABELS plus those families' exemplar-tool display names
      // (e.g. "Single-cell RNA sequencing Seurat CellRanger CRISPR gene editing
      // Cas9"). Sourced from `ScholarFamily` rows filtered through the SAME
      // #800-suppression / #801-sensitivity gate every public Method surface
      // uses (`isFamilyPubliclyVisible`), so a suppressed or sensitive family
      // never leaks into public ranking. Analyzed `scholar_text` (same analyzer
      // as the other people-ladder fields) so a free-text method query
      // ("CRISPR", "single-cell RNA sequencing", "Seurat") ranks the scholar via
      // the cross_fields blended group, and the `.keyword` sub-field is reserved
      // for a future exact method-family facet. OMITTED on scholars with no
      // visible family (omit-on-empty, like `publicationMeshUi` / `leadership`).
      // The query-time boost on this field is behind the default-OFF
      // `SEARCH_PEOPLE_METHOD_FAMILY` flag (reindex-then-flip).
      methodFamily: {
        type: "text",
        analyzer: "scholar_text",
        fields: { keyword: { type: "keyword" } },
      },
      // #1119 — per-scholar rollup of the overlay-VISIBLE method families' tool-USAGE
      // snippets (the ReciterAI tool_context text, e.g. "a non-invasive automated
      // method of embryo evaluation that predicts ploidy"), deduped + joined. Same
      // #800/#801 gate as `methodFamily`, so a suppressed/sensitive family never
      // leaks. Analyzed `scholar_text` so a usage query ("embryo ploidy time-lapse")
      // ranks the scholar via the cross_fields group, matching the real language of
      // the work rather than just the tool's name. OMITTED on scholars with no
      // visible family-with-snippet (omit-on-empty). The query-time boost is behind
      // the default-OFF `SEARCH_PEOPLE_METHOD_CONTEXT` flag (reindex-then-flip);
      // prose, so it relies on the people MSM (#1090) and is boosted modestly.
      methodContext: {
        type: "text",
        analyzer: "scholar_text",
      },
      // POPS clinical specialty fields — populated from weillcornell.org board
      // certifications, primary specialties, and clinical expertise (problem_procedure)
      // by the etl/pops step. All three are OMIT-on-empty (scholars with no POPS data
      // carry none of these fields). The query-time boost and clinical:exact evidence
      // kind are gated behind SEARCH_PEOPLE_CLINICAL_FN. `clinicalExpertise` is indexed
      // but no live query path reads it (the removed text-field variant was its only one).
      //
      // `clinicalSpecialties` — board-cert ∪ primary specialties, deduped
      // case-insensitively; queried via the cross_fields multi_match at a conservative
      // boost so a specialty query ("cardiology") ranks the clinician. Analyzed
      // `scholar_text` (same analyzer as `areasOfInterest`) for stemming + stopwords.
      clinicalSpecialties: { type: "text", analyzer: "scholar_text" },
      // `clinicalExpertise` — POPS problem_procedure strings; loose signal only
      // (contributes to ranking but never earns a clinical reason line). Analyzed
      // `scholar_text` so multi-word expertise phrases tokenize consistently.
      clinicalExpertise: { type: "text", analyzer: "scholar_text" },
      // `clinicalBoardSet` — board-certified specialty strings ONLY (raw, keyword).
      // Not queried by the multi_match; read from `_source` at query time by
      // `resolveHitEvidence` to determine whether a matched specialty is board-cert
      // (label "Board certified in X") or primary-specialty-only ("Clinical specialty:
      // X"). Stored as a `keyword` array so an exact case-insensitive membership
      // check is possible without a DB round-trip. OMITTED when boardCertSpecialties
      // is empty (omit-on-empty).
      clinicalBoardSet: { type: "keyword" },
      // #1836 — `clinicalSpecialtyMeshTree`: the tree numbers of each specialty's
      // curated MeSH *disease* anchor (keyword array). The clinical boost matches
      // a query descriptor's ancestor tree-number closure against this with a
      // `terms` filter — cap-free subsumption (a "heart failure" query lights up a
      // cardiology-anchored `C14`). OMIT-on-empty; gated query-side by
      // SEARCH_PEOPLE_CLINICAL_MESH_ANCHOR. Populated by etl/pops → buildPeopleDoc.
      clinicalSpecialtyMeshTree: { type: "keyword" },
      // #1836 — `clinicalAnchors`: per-specialty {specialty, boardCertified, tree}
      // rows, `_source`-read ONLY (never queried) to label the clinical evidence
      // row for a disease-subtree match. `enabled: false` so it is stored but not
      // indexed. OMIT-on-empty.
      clinicalAnchors: { type: "object", enabled: false },
    },
  },
};

/**
 * Mapping for the publications index (separately searchable result type per
 * spec line 179). Authors are stored both as a flat string for search and as
 * an array of {cwid, slug, preferredName} objects for chip rendering.
 */
export const publicationsIndexMapping = {
  settings: {
    // Publications index has ~90k docs and broad queries return 10k+ hits;
    // raising past the OpenSearch default of 10000 so deep pagination
    // doesn't 500.
    "index.max_result_window": 100000,
    analysis: {
      analyzer: {
        pub_text: {
          type: "custom" as const,
          tokenizer: "standard",
          filter: ["lowercase", "english_stop", "english_stemmer"],
        },
      },
      filter: {
        english_stop: { type: "stop", stopwords: "_english_" },
        english_stemmer: { type: "stemmer", language: "english" },
      },
    },
  },
  mappings: {
    properties: {
      pmid: { type: "keyword" },
      title: { type: "text", analyzer: "pub_text" },
      journal: { type: "text", fields: { keyword: { type: "keyword" } } },
      year: { type: "integer" },
      publicationType: { type: "keyword" },
      citationCount: { type: "integer" },
      dateAddedToEntrez: { type: "date" },
      doi: { type: "keyword" },
      pmcid: { type: "keyword" },
      pubmedUrl: { type: "keyword" },
      meshTerms: { type: "text" },
      // Issue #259 — MeSH defaults rebalance. NLM "Unique Identifier" (Dnnnnnn)
      // for each descriptor on the pub. Queried via `terms` in the §5 concept_expanded
      // shape (PR 3). Multi-valued by storing as a JSON string array; OpenSearch
      // handles array-of-keyword natively. Field is OMITTED on docs with zero
      // derivable UIs (mesh_terms empty or all bare-string legacy rows) so
      // `_source` consumers can distinguish "no signal" from "[]". See SPEC §5.4.1.
      meshDescriptorUi: { type: "keyword" },
      // Issue #259 §1.6 — ReciterAI parent-topic IDs on each pub, used by
      // the OR-of-evidence pub filter's Path B (`terms` on a keyword field
      // is the natural shape for exact-value match on opaque topic-slug
      // IDs). Multi-valued by storing as a JSON array; OpenSearch handles
      // array-of-keyword natively. Field is OMITTED on docs with zero
      // `publication_topic` rows so `_source` consumers can distinguish
      // "no signal" from "[]" — see the ETL writer for the rationale.
      reciterParentTopicId: { type: "keyword" },
      // Issue #259 §1.8 — doc-level MAX `impactScore` across the pub's
      // `publication_topic` rows, indexed as a sortable float for the
      // "Impact" sort option on the pub-tab. Float (not scaled_float)
      // because Decimal(8,4) values fit well within IEEE 754 single
      // precision and we don't need exact-decimal semantics for ranking.
      // Field is OMITTED on docs with zero non-null impact rows so a
      // missing field reads as "no signal" rather than 0 (and so OpenSearch
      // sorts those docs last under desc).
      impactScore: { type: "float" },
      // Issue #259 §1.8 — per-(pmid, parentTopicId) MAX `impactScore`,
      // stored as a `_source`-only payload (not indexed) so the API can
      // compute the "Concept impact" badge value against the resolved
      // concept's anchored topics without a second MySQL hop. `enabled:
      // false` skips field indexing entirely; OpenSearch still returns the
      // raw payload in `_source`.
      topicImpacts: { type: "object", enabled: false },
      // Issue #316 PR-C follow-up — GPT-generated rubric justification for
      // `impactScore`. Pure pass-through (no search/sort use), stored as
      // a `_source` keyword field for the API to surface as the hover
      // tooltip text on the inline `Impact: NN` value. `index: false`
      // skips inverted-index allocation; the bytes still ride along in
      // `_source` like the field's nature requires.
      impactJustification: { type: "keyword", index: false, doc_values: false },
      // Issue #32 — abstract text on the publications index lets thematic
      // queries find the right paper, not just the right scholar (issue #21
      // already covers that on the people index). One abstract per doc, no
      // weight repetition; analyzed with the same `pub_text` analyzer as
      // title/authorNames so stemming and stopwords are consistent.
      abstract: { type: "text", analyzer: "pub_text" },
      authorNames: { type: "text", analyzer: "pub_text" },
      // WCM author position roles for the Publications-tab facet
      // (issue #8 follow-up). Keyword array of {first, senior, middle};
      // single-author papers get [first, senior]; co-first → first;
      // a paper appears in multiple buckets when distinct WCM authors
      // hold different positions.
      wcmAuthorPositions: { type: "keyword" },
      // Issue #88 — flat keyword array of WCM author CWIDs on each pub.
      // Denormalized from `wcmAuthors[].cwid` so the Author facet can run
      // a cheap top-level terms aggregation with exclude-self filter
      // semantics, identical to the wcmAuthorPositions pattern. The nested
      // `wcmAuthors` field stays for chip rendering on result rows.
      wcmAuthorCwids: { type: "keyword" },
      // Issue #837 — keyword array of the department key(s) of this pub's
      // displayable WCM authors (FK `deptCode`, or a `name:<deptName>`
      // long-tail key), denormalized from the per-author Scholar.deptCode the
      // indexer joins. Powers the Publications-tab Department facet's
      // `terms` filter + bucket aggregation, the same shape as
      // `wcmAuthorCwids`. OMITTED on pubs whose WCM authors carry no
      // department (omit-on-empty). Only consumed under
      // `SEARCH_PUB_DEPARTMENT_FILTER`; populated on every reindex so the
      // flag flip needs no second reindex.
      wcmAuthorDepartments: { type: "keyword" },
      // Pre-rendered author chips for the WCM-coauthor stack on results.
      wcmAuthors: {
        type: "nested",
        properties: {
          cwid: { type: "keyword" },
          slug: { type: "keyword" },
          preferredName: { type: "text" },
          position: { type: "integer" },
          // Per-person authorship role: sole | first | last | middle. `wcmAuthorPositions` above is
          // a paper-level UNION and cannot attribute a role to a person; this can. Adding it needs
          // a full publications reindex — it is a new field on an existing mapping, so documents
          // written before the reindex simply lack it, and every reader treats absent as unknown.
          role: { type: "keyword" },
        },
      },
    },
  },
};

/**
 * Mapping for the funding index (issue #80 items 4 + 5). One document per
 * *project* — pre-deduped at index time across the per-(scholar,
 * account_number) Grant rows so the search layer doesn't need a JS-side
 * group-by. Most facet axes index as keyword arrays so multi-select
 * filtering with `terms` queries OR within an axis cleanly.
 *
 * Status (active / ending_soon / recently_ended) is intentionally NOT a
 * stored field — the 12-month NCE grace window means the bucket would
 * drift between re-indexes. Status is computed at query time via date
 * range filters and range aggregations against `endDate`.
 */
export const fundingIndexMapping = {
  settings: {
    "index.max_result_window": 100000,
    analysis: {
      analyzer: {
        funding_text: {
          type: "custom" as const,
          tokenizer: "standard",
          // See scholar_text / #725: split letter↔digit boundaries so a funding
          // search for "covid19" matches grants indexed under "COVID-19"
          // (0 -> 103 scholars-funding hits). Index AND search time.
          filter: [
            "lowercase",
            "alnum_delimiter",
            "flatten_graph",
            "english_stop",
            "english_stemmer",
          ],
        },
      },
      filter: {
        // #725 — see scholar_text. Glued-alphanumeric split for funding titles,
        // sponsor text, and people names.
        alnum_delimiter: {
          type: "word_delimiter_graph",
          split_on_numerics: true,
          preserve_original: true,
          generate_word_parts: true,
          generate_number_parts: true,
        },
        english_stop: { type: "stop", stopwords: "_english_" },
        english_stemmer: { type: "stemmer", language: "english" },
      },
    },
  },
  mappings: {
    properties: {
      projectId: { type: "keyword" },
      title: { type: "text", analyzer: "funding_text" },
      // Concatenated sponsor strings — canonical short, full name, raw
      // form, and aliases — for both prime and direct. Lets a query like
      // "AstraZeneca" match a project even when only the alias resolved.
      sponsorText: { type: "text", analyzer: "funding_text" },
      // WCM scholar names on the project, joined for full-text match.
      peopleNames: { type: "text", analyzer: "funding_text" },

      // Facet axes. Multi-valued fields use `keyword` so `terms` filter
      // does an exact OR-within-axis. (issue #80 multi-select preserved.)
      primeSponsor: { type: "keyword" },
      directSponsor: { type: "keyword" },
      isSubaward: { type: "boolean" },
      programType: { type: "keyword" },
      mechanism: { type: "keyword" },
      nihIc: { type: "keyword" },
      department: { type: "keyword" },
      // Role keyword array per project — populated with every bucket the
      // project belongs to (PI, Multi-PI, Co-I) so a single `terms` filter
      // matches without post-aggregation logic.
      roles: { type: "keyword" },

      startDate: { type: "date" },
      endDate: { type: "date" },
      // Issue #86 — pub count per project, used for sort and as an
      // inline metric on result rows. Integer so OpenSearch can sort
      // doc-values without scripts.
      pubCount: { type: "integer" },
      // Issue #86 — RePORTER abstract for the project. Indexed for
      // full-text relevance so searching a topic word that appears only
      // in an abstract returns the project. Stored so the result row
      // can render a snippet.
      abstract: { type: "text", analyzer: "funding_text" },
      // Issue #92 — origin of the current `abstract`. Keyword for cheap
      // facet/eq lookups; surfaced as small "Source: NSF" attribution
      // under the expanded abstract.
      abstractSource: { type: "keyword" },
      // Issue #291 — NIH RePORTER project keywords. `keyword` (multi-valued)
      // for exact-value lookups and facet aggregations; `keywordsText` is the
      // analyzed form so a topical query contributes to relevance alongside
      // `abstract`. Both populated from `grant.keywords`.
      keywords: { type: "keyword" },
      keywordsText: { type: "text", analyzer: "funding_text" },
      // Issue #295 — `keywords` resolved to NLM MeSH descriptor UIs. `keyword`
      // (multi-valued); deliberately the same field name as the publications
      // index so one `terms` query template hits both. Queried via `terms`,
      // never aggregated as a facet.
      meshDescriptorUi: { type: "keyword" },
      // Funding reindex — distinct union of the MeSH descriptor UIs of the
      // project's FUNDED publications (vs `meshDescriptorUi` = RePORTER project
      // keywords). The concept result-set gate filters this ∩ descendantUis
      // when SEARCH_FUNDING_MESH_GATE=fundedPubMeshUi. `terms` only, never a
      // facet; populated by lib/funding-projection.ts.
      fundedPubMeshUi: { type: "keyword" },
      // Issue #86 — RePORTER application ID; outbound deep-link target
      // from the expanded result row.
      applId: { type: "integer" },
      // Issue #86 — top PUB_LIST_CAP pubs attributed to the project.
      // Stored (not indexed for search) so the row's expanded view can
      // render without an extra round-trip.
      publications: {
        type: "object",
        enabled: false,
      },

      // Hit-rendering payload — saved with the doc so a result page can
      // hydrate `FundingHit` without a Prisma round-trip.
      awardNumber: { type: "keyword" },
      primeSponsorRaw: { type: "keyword" },
      directSponsorRaw: { type: "keyword" },
      isMultiPi: { type: "boolean" },
      totalPeople: { type: "integer" },
      // Pre-rendered people chips (already sorted lead-PI first by indexer).
      people: {
        type: "nested",
        properties: {
          cwid: { type: "keyword" },
          slug: { type: "keyword" },
          preferredName: { type: "text" },
          role: { type: "keyword" },
        },
      },
      // Issue #94 — flat keyword array of WCM investigator CWIDs on each
      // project. Denormalized from `people[].cwid` so the Investigator
      // facet runs a cheap top-level terms aggregation, mirroring the
      // `wcmAuthorCwids` pattern on the Publications index.
      wcmInvestigatorCwids: { type: "keyword" },
    },
  },
};

/**
 * Boost weights for the funding-index multi_match query. Title carries
 * the strongest signal; sponsor text comes next so a query for a sponsor
 * name surfaces relevant projects; people names are informative but not
 * dominant (a sloppy people-name match shouldn't outrank a direct title hit).
 */
export const FUNDING_FIELD_BOOSTS: ReadonlyArray<string> = [
  "title^4",
  "sponsorText^2",
  "peopleNames^1",
  // Issue #86 — abstract-only matches are valuable but lower-signal than
  // a title hit. Boost 1 keeps it in the multi_match without dominating.
  "abstract^1",
  // Issue #291 — NIH RePORTER project keywords. Same low boost as abstract:
  // a topical keyword hit contributes to relevance without outranking a
  // direct title match.
  "keywordsText^1",
];

/**
 * High-evidence per-field boosts for the restructured people-index query
 * (issue #259 §1.1). Used in the multi_match must clause where
 * `minimum_should_match` applies meaningfully — none of these are blob
 * fields. publicationAbstracts is intentionally excluded: it's a
 * concatenated blob of every abstract on the scholar and clears any
 * per-field token-coverage threshold on its own, defeating msm.
 */
export const PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: ReadonlyArray<string> = [
  "preferredName^10",
  "fullName^10",
  "areasOfInterest^6",
  "primaryTitle^4",
  "primaryDepartment^3",
  "overview^2",
  "publicationTitles^1",
  "publicationMesh^0.5",
];

/**
 * Boost for `publicationAbstracts` on the people index when the restructured
 * query (issue #259 §1.1) is active. Lives in a scoring-only `should`
 * clause: contributes to BM25 ranking, cannot admit a doc on its own.
 */
export const PEOPLE_ABSTRACTS_BOOST = 0.3;

/**
 * #1119 — boost for the `methodContext` tool-usage prose on the people index when
 * SEARCH_PEOPLE_METHOD_CONTEXT is on. Like `publicationAbstracts`, this lives in a
 * scoring-only `should` clause — NOT in the cross_fields/msm `must` ladder — because
 * it is a multi-sentence prose blob that would otherwise let a term landing only in
 * usage prose satisfy minimum-should-match for the whole group and ADMIT an
 * off-topic scholar (the same reason abstracts are excluded; #1056/#1090). It can
 * nudge ranking but never admit a doc on its own. Modestly above the abstracts boost
 * (the text is curated usage language, more specific than a raw abstract).
 */
export const PEOPLE_METHOD_CONTEXT_BOOST = 0.5;
/** Topic-shape counterpart of {@link PEOPLE_METHOD_CONTEXT_BOOST} (raised, like the
 *  topic abstracts boost), still scoring-only. */
export const PEOPLE_TOPIC_METHOD_CONTEXT_BOOST = 0.8;

/**
 * Minimum-should-match expression for the restructured people query
 * (issue #259 §1.1, loosened in v2.2). Reads as: for ≤2 analyzed tokens
 * require all; for >2, allow up to 34% missing. Tokens are post-analysis
 * — `scholar_text` strips English stopwords first.
 *
 * Required-token table by analyzed-token count:
 *   1 → 1,  2 → 2,  3 → 2,  4 → 3,  5 → 4,  8 → 6
 *
 * The original spec wrote `"-0% 3<-25%"` which (a) is invalid OpenSearch
 * syntax — a bare `-0%` segment trips "For input string: \"-0%\"" — and
 * (b) required all tokens on 3-token queries, the modal length of concept
 * queries after stemmer collapse ("electronic health records" → 3 tokens).
 * The first issue was fixed in v2.1's clarification (`"3<-25%"` produces
 * the same table); the second surfaced during prod verification, when the
 * 3-token EHR headline query cut from 4,303 to 155 — far below the spec's
 * 1,000–2,500 band, because every scholar needed all three of
 * "electron"+"health"+"record" scattered across the high-evidence fields.
 *
 * "2<-34%" is the surgical loosening: only the 3-token row of the table
 * changes (3-required → 2-required, i.e. 1 of 3 tokens may be missing).
 * 1/2-token nominal queries are unaffected (must still match all tokens);
 * 4+-token queries are unaffected (msm boundary is still 25% effective).
 * 34%, not 33%, because `floor(0.33 * 3) = 0` (the floor-rounding bites
 * exactly at the boundary); 34% rounds up cleanly.
 *
 * Lifted to a constant because the msm DSL is easy to misread and the
 * exact string is asserted on by `tests/unit/search-msm-parser.test.ts`.
 */
export const PEOPLE_RESTRUCTURED_MSM = "2<-34%";

/**
 * Issue #310 / SPEC §6.1.3 — re-weighted high-evidence boost ladder for the v3
 * topic-shape template. Same field SET and `cross_fields` + msm shape as
 * `PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS`, but the weights pivot from "name/AOI
 * lead" to "pub-derived evidence leads":
 *
 *   - name fields drop 10 -> 1 (a topic query is not a name query)
 *   - `areasOfInterest` 6 -> 3 (down-weight self-reported signal; §5.1 bias)
 *   - `publicationTitles` 1 -> 6 and `publicationMesh` 0.5 -> 4 (auth-weighted,
 *     min-evidence-filtered pub evidence is the highest-confidence topic signal)
 *
 * `publicationAbstracts` stays in the scoring-only `should` clause at the
 * raised `PEOPLE_TOPIC_ABSTRACTS_BOOST` (0.5). Name-shape and department-shape
 * keep their own ladders (#309 / PR-4 #311).
 */
export const PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: ReadonlyArray<string> = [
  "preferredName^1",
  "fullName^1",
  "areasOfInterest^3",
  "primaryTitle^3",
  "primaryDepartment^1",
  "overview^2",
  "publicationTitles^6",
  "publicationMesh^4",
];

/**
 * Issue #310 / SPEC §6.1.3 — `publicationAbstracts` boost for the v3
 * topic-shape `should` clause (0.3 -> 0.5). Still scoring-only: a blob-only
 * abstract match can't admit a doc on its own (the must clause governs
 * admission), it only nudges ranking.
 */
export const PEOPLE_TOPIC_ABSTRACTS_BOOST = 0.5;

/**
 * #726 — MeSH concept-admission tiers + weights for the People topic template.
 *
 * When a query resolves to a MeSH descriptor, scholars carrying that descriptor
 * (`publicationMeshUi`) can be ADMITTED — not just boosted — but only when the
 * lexical result is sparse (escalate-on-sparse: a recall floor, not a
 * maximizer). Relevance rewards the *type* of match so weaker concept matches
 * rank below the precise lexical ones rather than diluting the top:
 *
 *   tier            from                                         trust
 *   exact           the WHOLE query matched a surface form of    highest
 *                   the descriptor — its name, or (parity flag
 *                   on) one of its entry terms
 *   anchored-entry  entry-term hit + a curated topic anchor      medium
 *   entry           entry-term hit, no anchor                    lowest (floor)
 *
 * `MESH_ADMIT_WEIGHT` is the `terms`-clause boost for concept-only admission;
 * concept-only docs carry ~0 BM25 and already sort beneath lexical hits, so the
 * weight just orders them by trust. `MESH_ATTRIBUTION_WEIGHT` graduates the
 * former flat ×1.5 attribution `function_score` by the same ladder.
 *
 * ENTRY-TERM TIER PARITY (`SEARCH_MESH_ENTRY_TIER_PARITY`, default OFF). "exact" used
 * to mean literally `query == descriptor name`, which made the tier a property of NLM's
 * choice of preferred label rather than of the match. Measured on prod 2026-07-27:
 * `gene therapy` and
 * `genetic therapy` resolve to the SAME descriptor (`Genetic Therapy`, D015316) and score
 * differently — entry-term (attribution 1.15 / admit 0.03, 921 scholars) vs exact
 * (1.5 / 0.1, 848 scholars), with only 2 of the top 6 scholars in common. Two spellings of
 * one concept, two different answers. So when the user's WHOLE query IS the entry term
 * (`isFullQueryMeshMatch`), the match is verbatim and earns the verbatim tier.
 *
 * `anchored-entry` is NOT dead code once parity is on. It still fires for an entry-term
 * resolution the user did not type in full — specifically the #692 generic-strip retry,
 * which re-resolves the STRIPPED `contentQuery` and can return an entry-term match that
 * covers all of the stripped query but only part of what the user typed. That is an
 * interpretation, not a verbatim hit, so it keeps the medium/floor tiers and the curated
 * anchor keeps deciding between them.
 *
 * The promotion is deliberately NOT done by rewriting `confidence` in the resolver:
 * `confidence` is read in ~8 other places (candidate sort, the #1346 acronym sense guard,
 * the fallback's single-token gate, `meshConfidenceRank`'s retry suppression,
 * `meshRetryIsSameDescriptorUpgrade`, the autocomplete subtitle, and the PUBLIC
 * `meshConfidence` field on `SearchInterpretation` plus both `search_query` log lines),
 * several of which would silently invert. The tier is the only thing that should move.
 */
// `partial` (lowest, below `entry`) is the decompose-and-resolve fallback tier
// (`SEARCH_MESH_RESOLUTION_FALLBACK`): the query did not match a descriptor
// outright, but a contiguous word-window of it did. It is an interpretation, not a
// verbatim match, so it admits/attributes beneath every real tier and never
// reorders lexical hits (concept-only docs carry ~0 BM25, so the weight just
// orders them by trust).
export type MeshMatchTier = "exact" | "anchored-entry" | "entry" | "partial";

export function meshMatchTier(
  confidence: "exact" | "entry-term" | "partial",
  anchorCount: number,
  // Optional so every existing call site — and the bare `vi.mock("@/lib/search")`
  // factories that stub this function — keeps compiling; omitted ⇒ pre-parity behavior.
  // Callers compute it as `parityFlagOn && isFullQueryMeshMatch(userQuery, matchedForm)`,
  // and must compare against the USER's query, never the #692-stripped `contentQuery`.
  opts?: { fullQueryMatch?: boolean },
): MeshMatchTier {
  if (confidence === "partial") return "partial";
  if (confidence === "exact") return "exact";
  // A verbatim entry-term hit is a verbatim match — see ENTRY-TERM TIER PARITY above.
  // Checked before the anchor test on purpose: once the whole query matched, whether a
  // human happened to curate a topic anchor for this descriptor is not evidence about
  // the match, and letting it downgrade a full-query hit is the original defect.
  if (opts?.fullQueryMatch) return "exact";
  return anchorCount > 0 ? "anchored-entry" : "entry";
}

/**
 * #1972 — order a resolution's confidence so callers can ask "is this one better?".
 * `null` (no resolution) is 0, so an unresolved query ranks below every resolution.
 *
 * Exists for the #692 generic-strip retry. That retry is gated on the full query having
 * MISSED, but `partial` — the decompose-and-resolve guess stamped by the window fallback
 * (`SEARCH_MESH_RESOLUTION_FALLBACK`) — is not a miss, so turning the fallback on
 * SUPPRESSED the retry and pre-empted a better answer. Measured 2026-07-26 over 35
 * free-typed queries, fallback off vs on: 16 gained, but 3 DEMOTED — `chronic fatigue`
 * resolved `Fatigue` at `exact` with the fallback off (strip `chronic`, resolve
 * `fatigue`) and only `partial` with it on. Same descriptor, a 10x lower
 * `MESH_ADMIT_WEIGHT`, and an identical confident "N of M publications tagged" line
 * either way — so nothing surfaced the downgrade.
 *
 * A verbatim match (`exact`/`entry-term`) still suppresses the retry: that is #692
 * §4.1's deliberate full-query-first rule, which protects descriptors built from filler
 * words ("gene therapy", "clinical trial").
 */
export function meshConfidenceRank(
  confidence: "exact" | "entry-term" | "partial" | null | undefined,
): number {
  if (confidence === "exact") return 3;
  if (confidence === "entry-term") return 2;
  if (confidence === "partial") return 1;
  return 0;
}

/** #1972 — a resolution weaker than a verbatim match must not suppress the #692 retry. */
export const MESH_RANK_VERBATIM = 2;

/**
 * #1980 — may a #692 generic-strip retry be adopted on the arm where the full query
 * resolved NOTHING? Only when the strip removed at most HALF the query's tokens.
 *
 * That arm is otherwise unguarded. `meshRetryIsSameDescriptorUpgrade` protects the case
 * where a concept already exists, but when nothing resolved there is no incumbent to
 * compare against, so the retry is adopted whatever it names.
 * `data/search/deprioritized-terms.json` contains the head nouns (`cells`, `disease`,
 * `health`, `patients`) while the words carrying the subject (`stem`, `kidney`, `policy`)
 * do not — so a 3-token query can strip to a bare token whose sense is unrelated to what
 * the user typed, and the retry then states it with no hedging.
 *
 * Measured in prod 2026-07-27, identically on the people AND publications branches:
 *
 *   stem cells effects      → `stem`   → Microscopy, Electron, Scanning Transmission
 *   kidney disease effects  → `kidney` → Kidney (the organ), not Kidney Diseases
 *   health policy effects   → `policy` → Policy, not Health Policy
 *
 * All three strip 2 of 3 tokens. The rule counts what was REMOVED, not what SURVIVED:
 * a survivor-majority rule would also reject the 2→1 strips #1972 measured as wins
 * (`asthma patients` → `Asthma`, `chronic fatigue` → `Fatigue`; 49 of them), because one
 * surviving token out of two is not a majority either. Removing exactly half is that
 * whole 2→1 class, and it stays admitted.
 *
 * Verified against the real `stripDeprioritized` (2026-07-27) — this closes 4 of the 6
 * rows #1980 tabulated and leaves two, which strip only half their tokens and so are out
 * of reach of a token-budget rule:
 *
 *   public health policy              → `public policy`   (1/3) → Public Policy
 *   coronary artery disease patients  → `coronary artery` (2/4) → Coronary Vessels
 *
 * Those need #1980's fix (2), `meshRetryDroppedWordUnrelated` below (reject a retry whose
 * descriptor is token-disjoint from the dropped words) or the longest-span window
 * fallback; fix (2) is now applied alongside this rule at both call sites.
 *
 * Deliberately does NOT gate the same-descriptor-upgrade arm: that one cannot swap the
 * concept, so how much was stripped to reach it does not matter.
 */
export function meshStripRemovedAtMostHalf(
  removedCount: number,
  totalCount: number,
): boolean {
  return removedCount * 2 <= totalCount;
}

/**
 * #1980 fix (2) — may a #692 generic-strip retry be adopted when its winning descriptor
 * is a MULTI-WORD match? Only when the descriptor's own vocabulary (its name or one of
 * its entry terms, tokenized) contains at least one of the words the strip DROPPED.
 *
 * Orthogonal to `meshStripRemovedAtMostHalf`, which counts what fraction of the query
 * survived — that budget is exhausted by these two rows, which both strip only HALF
 * their tokens (the same ratio as the admitted 2→1 class) yet land on the wrong concept:
 *
 *   public health policy              strip `health`             → Public Policy    (wrong)
 *   coronary artery disease patients  strip `disease`, `patients` → Coronary Vessels (wrong)
 *
 * Neither `Public Policy` nor `Coronary Vessels` — name or entry terms — contains
 * `health` or `disease` (verified against the real MeSH map, 2026-07-31). The dropped
 * word carried meaning the retry's descriptor doesn't capture; the query's actual concept
 * (`Health Policy`, `Coronary Artery Disease`) is exactly the compound that word would
 * have formed with what survived.
 *
 * Scoped to a MULTI-WORD retry match (`matchedContentQuery` has ≥2 tokens): a single
 * surviving token has no compound for a dropped word to have been absorbed into, so the
 * check does not apply and the #1972 2→1 class (49 measured wins) stays admitted —
 *
 *   asthma patients   strip `patients` → Asthma     (single-word match, exempt)
 *   cancer research   strip `research` → Neoplasms  (single-word match, exempt)
 *
 * — even though `Asthma`/`Neoplasms` ALSO share no token with `patients`/`research`
 * (verified the same way). Gating on the retry's own word count, not on the overlap
 * itself, is what keeps those admitted: this rule reaches the two-token rows the budget
 * rule cannot, without re-tightening the budget rule that would break the wins.
 */
export function meshRetryDroppedWordUnrelated(
  matchedContentQuery: string,
  droppedWords: readonly string[],
  retry: { name: string; entryTerms: readonly string[] } | null | undefined,
): boolean {
  if (!retry || droppedWords.length === 0) return false;
  const contentTokenCount = matchedContentQuery.trim().split(/\s+/).filter(Boolean).length;
  if (contentTokenCount < 2) return false;
  const wordTokens = (text: string): string[] =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => singularizeForMatch(t));
  const descriptorTokens = new Set(
    [retry.name, ...retry.entryTerms].flatMap(wordTokens),
  );
  return !droppedWords.some((w) => wordTokens(w).some((t) => descriptorTokens.has(t)));
}

/**
 * #1972 — may a #692 generic-strip retry REPLACE a resolution the full query already
 * produced? Only when it names the SAME descriptor at a strictly higher confidence.
 *
 * The retry resolves a SHORTER query, so it can land on a different descriptor than the
 * full query did. Letting it is a concept SWAP, not an upgrade — and the deprioritized
 * list contains the very tokens that carry the medical sense (`disease`, `cells`,
 * `patients`). Measured on deployed staging over 122 `<topic> <generic modifier>`
 * queries, comparing the guard with and without this constraint:
 *
 *   49  same descriptor, higher tier  — `Asthma`/partial → `Asthma`/exact
 *    9  concept swap, all worse       — `stem cells effects` strips BOTH `cells` and
 *                                       `effects`, leaving `stem`, which resolves to
 *                                       `Microscopy, Electron, Scanning Transmission`;
 *                                       `kidney disease effects` → `Kidney` (the organ);
 *                                       `health policy effects` → `Policy`
 *
 * Confidence-only upgrades are exactly the 49 and none of the 9. They are also safe by
 * construction for a curated-matched query, since the descriptor cannot change.
 *
 * 🔴 This rule applies ONLY when the matched window carried real content. Callers must
 * first check `isAllDeprioritized(current.matchedForm)`: the window fallback's size-1 arm
 * requires an exact descriptor NAME, so a lay entry-term topic loses to a filler token
 * that happens to be one — `cancer research` resolves `Research`/partial, `vaccine safety`
 * resolves `Safety`/partial, `diabetes prevalence` resolves `Prevalence`/partial (all
 * measured on staging with the retry neutralised). Those windows carry none of the query's
 * meaning, and the retry that recovers `Neoplasms` / `Vaccines` / `Diabetes Mellitus` is
 * the thing keeping head queries correct today. Applying descriptor-equality there would
 * pin them to the filler descriptor.
 *
 * When the full query resolved NOTHING there is no concept to protect and any resolution
 * beats none — callers keep their pre-#1972 behavior on that arm too.
 */
export function meshRetryIsSameDescriptorUpgrade(
  current: | { descriptorUi: string; confidence: "exact" | "entry-term" | "partial" }
    | null
    | undefined,
  retry: | { descriptorUi: string; confidence: "exact" | "entry-term" | "partial" }
    | null
    | undefined,
): boolean {
  if (!current || !retry) return false;
  if (retry.descriptorUi !== current.descriptorUi) return false;
  return meshConfidenceRank(retry.confidence) > meshConfidenceRank(current.confidence);
}

// #1254 — concept-only ADMIT weights sit in a deliberate sub-BM25 band. A doc
// admitted by concept expansion alone (no lexical hit) scores ONLY this constant
// (the admit `terms` clause is constant-score), so it must stay small enough that
// even after the per-doc prominence multiply (~8.7× for prolific funded faculty)
// it can never outrank a genuine lexical match. Worst case: exact 0.1 ×
// attribution 1.5 × productivity 1.2 × prominence 8.7 ≈ 1.6, which stays below a
// real topic BM25 (≥2–3 over publicationTitles^6 / publicationMesh^4) × prominence.
// The previous values (3 / 1.5 / 0.7 / 0.3) predated the #513 prominence multiply
// and let prolific concept-only scholars float to the top labelled "no specific
// match". Relative order (partial < entry < anchored-entry < exact) is preserved,
// so the concept-only tail still self-orders by match trust. Admission/recall is
// unchanged — this is ordering only.
export const MESH_ADMIT_WEIGHT: Record<MeshMatchTier, number> = {
  exact: 0.1,
  "anchored-entry": 0.05,
  entry: 0.03,
  partial: 0.01,
};

export const MESH_ATTRIBUTION_WEIGHT: Record<MeshMatchTier, number> = {
  exact: 1.5,
  "anchored-entry": 1.3,
  entry: 1.15,
  partial: 1.05,
};

/**
 * #1269 — multiplicative tier boost for scholars who have the searched method
 * family EXPLICITLY tagged (Axis-2), applied in the topic-shape function_score
 * alongside `MESH_ATTRIBUTION_WEIGHT`. The explicit tag is publication-derived
 * (the A2 pipeline extracts the method from the scholar's own work), so it is a
 * higher-precision "this scholar uses this method" signal than a bare MeSH
 * descendant match — it should outrank keyword-only matches. Composes
 * multiplicatively, so the four cases order as intended:
 *   tagged + MeSH (×1.5·2.0=3.0) > tagged-only (×2.0) > MeSH-only (×1.5) > neither (×1).
 * Calibration knob: raise toward a hard tier if a tagged scholar with modest
 * pub-volume still sinks below prolific keyword-only matches; lower if it over-
 * promotes. Gated by `SEARCH_PEOPLE_METHOD_FAMILY_TIER` (default OFF).
 */
export const PEOPLE_METHOD_FAMILY_TAG_WEIGHT = 2.0;

/**
 * #726 — escalate concept-admission only when the lexical result is this sparse.
 * Above it the page stands on its own, so we keep count = lexical and don't
 * dilute common queries.
 */
export const MESH_ESCALATION_THRESHOLD = 50;

/**
 * #726 — don't escalate on an ultra-short matched form (a 2–3 char token is the
 * most ambiguity-prone, where a wrong resolution on an otherwise-empty page does
 * the most damage). Paired with the resolver's `ambiguous` flag as the floor.
 */
export const MESH_MIN_MATCHED_FORM_LEN = 4;

/**
 * Issue #513 / `docs/people-relevance-baseline.md` §5.4 — v3 prominence factor.
 *
 * The legacy baseline carries no prominence signal, so prominent scholars sink
 * in large topic/department result sets and same-surname queries resolve
 * arbitrarily (#4 `wong` = 0/3: zero-pub namesakes outranked the three
 * high-output Wongs). These weights compose a function_score over the
 * name / department / hybrid bodies as:
 *
 *   final = text_score × ( BASE + VOLUME(publicationCount)
 *                          + FACULTY·[full_time_faculty] + GRANT·[hasActiveGrants] )
 *
 * (`score_mode: sum`, `boost_mode: multiply`).
 *
 * `VOLUME` has TWO MODES, selected by `SEARCH_PEOPLE_PUBCOUNT_DAMPEN` (#2068).
 * ("mode", never "shape" — in this codebase a *shape* is a People query shape
 * (topic / hybrid / unclassified / name / department / …), and the capped mode
 * applies to THREE of those. Two modes, three shapes; do not conflate them.)
 * `"off"` (default, and what both envs serve today) is the original
 * `ln1p(FACTOR · publicationCount)`; `"capped"` is the step ladder
 * {@link PEOPLE_PROMINENCE_PUBCOUNT_BANDS}, ceiling
 * {@link PEOPLE_PROMINENCE_PUBCOUNT_CEILING} = 3.0, on the topic / hybrid /
 * unclassified shapes only. Everything below describes the `"off"` shape unless
 * it says otherwise.
 *
 *   - **Publication count leads** — log-saturated (`ln1p`, so 250 vs 500 pubs
 *     doesn't run away). The dense signal (60.9% of active scholars have ≥1
 *     pub); the only variant that fixed #4 in the §5.4 probe (3/3).
 *   - **BASE** floors the multiplier at 1 so a no-pub, non-faculty scholar is
 *     left at its text score (×1) rather than zeroed (ln1p(0) = 0) — the
 *     `× log1p(grantCount)` probe was rejected precisely because it zeroed the
 *     84% with no grant.
 *   - **Full-time-faculty — a *meaningful additive* boost**, deliberately NOT an
 *     absolute first tier: under the `"off"` volume shape FACULTY stays below a
 *     typical publication-count gap, so a ≤17-pub full-time Wong can't outrank a
 *     250-pub affiliated Wong (1 + ln1p(17) + 1 = 4.89 < 1 + ln1p(250) = 6.52).
 *     #513 decision.
 *
 *     **This rule does NOT survive `SEARCH_PEOPLE_PUBCOUNT_DAMPEN=capped`, and the
 *     #513 decision it encodes is therefore in scope for any flip.** Capping the
 *     volume term compresses the very gap FACULTY was sized against: over the
 *     measured 8..219 tagged-pub range the volume span falls from 3.197 to 1.75,
 *     so +1.0 goes from 31.3% to 57.1% of it. Same pair, capped: a 50-pub
 *     full-time scholar (1 + 2.5 + 1 = 4.5) now OUTRANKS a 580-pub affiliated one
 *     (1 + 3.0 = 4.0), where the `"off"` shape ranks them 5.932 < 7.365. See the
 *     band table below and the interaction note in `cdk/lib/app-stack.ts`.
 *   - **Active grants — a *small additive* boost** (a "currently funded"
 *     tiebreaker), never a standalone multiplier (the signal is too sparse —
 *     12.5% — to lead).
 *
 * Selection bias toward established faculty is **accepted** by the eval owner
 * (prominent scholars should rank higher), overriding the SPEC §5.3 down-weight
 * caution for this factor. Weights are INITIAL — the 12-query calibration sweep
 * (which needs the production topic-template query + a reindexed cluster, the
 * same gate as the PR-5 flip) tunes them against the §7 frozen baseline.
 *
 * Topic-shape prominence rides as the OUTER (`sum`) function_score wrapping
 * the existing inner (`multiply`) attribution + productive-author + sparse-
 * decay function_score (§5.4 calibration follow-up). Additive-over-
 * multiplicative is load-bearing: composing a blunt multiplicative pub-count
 * factor with the topic multipliers blew up established authors
 * disproportionately ("melanoma distortion") in the §5.4 probe.
 */
export const PEOPLE_PROMINENCE_BASE_WEIGHT = 1.0;
export const PEOPLE_PROMINENCE_PUBCOUNT_FACTOR = 1;
export const PEOPLE_PROMINENCE_FACULTY_WEIGHT = 1.0;
export const PEOPLE_PROMINENCE_GRANT_WEIGHT = 0.5;
/** The `personType` (= `roleCategory`) value the faculty boost matches. */
export const PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE = "full_time_faculty";

/**
 * Issue #2068 — the CAPPED replacement for the unbounded `ln1p(publicationCount)`
 * volume prior (contract `docs/search-relevance-contract.md` open violation O3:
 * "every query-independent prior states a ceiling").
 *
 * Measured on `q=cancer`: everything the query contributes spans 1.38×, while the
 * tagged evidence being ranked on spans 27× (8 → 219 tagged pubs). Every other
 * query-derived term in the outer `score_mode: sum` is a step function (MeSH
 * attribution ×1.5/1.3/1.15 by match TYPE, the area boost a membership filter, the
 * method tier a flat ×2.0), so `ln1p(publicationCount)` is the only smoothly
 * increasing term in the sum and the one least related to the query.
 *
 * The replacement is an exact-ceiling step ladder: one `filter`+`weight` clause per
 * band, so the contribution to the sum is a STATED maximum instead of an
 * unbounded slope. Properties the bands must keep (each pinned by a test in
 * `tests/unit/search-people-pubcount-dampen.test.ts`):
 *
 *   - mutually exclusive — exactly one band matches any P ≥ 1, so the contribution
 *     to the `score_mode: sum` is exactly that band's weight (never a sum of two);
 *   - monotone non-decreasing in P;
 *   - a stated ceiling of {@link PEOPLE_PROMINENCE_PUBCOUNT_CEILING}, DERIVED from
 *     this table (not a parallel literal) so the two cannot drift;
 *   - P = 0 matches NO band and so contributes nothing, preserving today's
 *     `missing: 0` / `ln1p(0) = 0` semantics. There is deliberately no `lt: 1` band.
 *
 * ORDERING ONLY. These are `function_score` functions — they score documents the
 * query already matched. `publicationCount` appears in no filter/must/post_filter,
 * so `total` and every facet count are identical flag-on and flag-off.
 *
 * Bucketing on the indexed `pubCountBucket` field was REJECTED: it is
 * corpus-relative quartiles of the nonzero population, recomputed per index build,
 * so its cut points drift between builds and between staging and prod — a lever
 * built on it is not reproducible across the A/B that justifies it. `max_boost` on
 * the outer wrapper was also rejected: it caps the SUM and truncates the area and
 * clinical terms alongside the volume prior (contract rule O4).
 */
export const PEOPLE_PROMINENCE_PUBCOUNT_BANDS: ReadonlyArray<{
  /** Inclusive lower bound on `publicationCount`. */
  readonly gte: number;
  /** Exclusive upper bound; omitted on the top (ceiling) band. */
  readonly lt?: number;
  /** Additive contribution to the outer prominence `score_mode: sum`. */
  readonly weight: number;
}> = [
  { gte: 200, weight: 3.0 },
  { gte: 100, lt: 200, weight: 2.75 },
  { gte: 50, lt: 100, weight: 2.5 },
  { gte: 20, lt: 50, weight: 2.0 },
  { gte: 5, lt: 20, weight: 1.25 },
  { gte: 1, lt: 5, weight: 0.5 },
];

/**
 * The stated ceiling of the #2068 volume prior — the maximum a scholar's raw
 * publication count can add to the outer prominence sum. DERIVED from
 * {@link PEOPLE_PROMINENCE_PUBCOUNT_BANDS} (one source of truth), so editing a band
 * weight moves the ceiling rather than silently contradicting it.
 */
export const PEOPLE_PROMINENCE_PUBCOUNT_CEILING = Math.max(
  ...PEOPLE_PROMINENCE_PUBCOUNT_BANDS.map((b) => b.weight),
);

/**
 * Issue #532 — multiplicative weights for the dept-shape leadership boost.
 * The factor wraps the dept body in a `function_score` with `score_mode:
 * max` so a scholar who is both a chair AND a chief (rare) takes the
 * stronger of the two factors, not the product. Chair is weighted higher
 * than chief: dept-chair eminence > division-chief eminence on a dept-name
 * query. The initial weights are set conservatively — the boost must
 * promote a chair past *strong-publisher dept members*, which the v3
 * additive prominence factor already lifts; tuned by visual inspection of
 * the §3.2 12-query eval and revisited on production telemetry. Calibration
 * sweeping on the current 6-label dept set is calibration-on-noisy-set
 * territory (same finding as #312 PR-5 Open Q1 on the attribution factor).
 */
export const PEOPLE_DEPT_LEADERSHIP_CHAIR_WEIGHT = 3.0;
export const PEOPLE_DEPT_LEADERSHIP_CHIEF_WEIGHT = 1.5;

/**
 * Research-Area concentration boost (spec: docs/search-research-area-relevance-spec.md).
 * When a topic query resolves to a Research Area, scholars are lifted by their
 * relevance×coverage ranking in that area — the topic page's own per-scholar `total`
 * (Σ scorePublication over first/last-authored, recent, in-area pubs). The continuous
 * `total` is bucketed into 3 tiers (by fraction of the area's max `total`) and each
 * tier rides as an additive weight in the OUTER prominence `function_score` (same slot
 * as the #513 prominence factors), so concentration can overcome the
 * `ln1p(publicationCount)` lift that floats prolific generalists. Reorder-only: a
 * `filter` clause scores only docs already matched, so the result set/facets are
 * unchanged. Weights are INITIAL — tuned by the spec §6 dense-page eval.
 * ponytail: 3 static tiers; a reindexed per-scholar `total` field + script_score is
 * the smoother upgrade (spec OQ-7) once the signal is proven.
 */
// Prominence is `score_mode: sum` × relevance, where the non-boost terms sum to
// ~6 (mostly ln1p(publicationCount)). The original 8/4/1.5 made a top-tier boost
// DOUBLE the multiplier — concentration dominated relevance instead of informing it
// (the "huge FT boost" / method-tagged-ethics-prof-over-Rice distortion). Softened
// to a peer signal: a top tier now adds ~50% (6→9), reordering within a relevance
// band without overriding it. Still INITIAL — the staging A/B picks the final values.
export const AREA_BOOST_W_HI = 3;
export const AREA_BOOST_W_MID = 1.5;
export const AREA_BOOST_W_LO = 0.75;
/** Tier cutoffs as a fraction of the area's top `total` (the #1 scholar). */
export const AREA_BOOST_HI_FRAC = 0.5;
export const AREA_BOOST_MID_FRAC = 0.2;
/**
 * Cap on how many of the area's ranked scholars are pulled for the boost.
 *
 * PR #2098 (tracking issue #2097) — raised 200 → 500 on measurement. The list is sorted by the very quantity
 * being boosted (`n²/total`) and then sliced, so the cap is an approximation error:
 * below the point where the page stops changing, it returns a different ranking than
 * the one the scoring intends. Measured on staging across the 10-query panel, both
 * weights and both `AREA_BOOST_GRADED` postures, by sweeping `SEARCH_AREA_BOOST_TOP_N`
 * and finding the smallest value whose top 10 equals the top 10 at 2000:
 *
 *   every query converges at or below 300; 8 of 10 converge at or below 150
 *
 * At the old 200 the two broadest queries had NOT converged — page 1 was reordered
 * relative to the full-list answer, including a rank 1/2 swap on a broad disease
 * query. That was true at today's shipped `AREA_BOOST_W_HI = 3`, not only at the
 * proposed higher weight, so this is a live defect and not a pre-flip concern.
 *
 * 500 is 1.67× the worst observed convergence point. It is not larger because the
 * margin buys nothing measurable and a cap should stay a cap.
 *
 * ⚠ The stated original reason for 200 was `function_score` clause count. Measured
 * against it: origin latency on the broadest panel query is flat from 200 to 5000
 * (~0.25-0.30 s, 3 runs each, cache-busted). Re-measure before raising further —
 * this says the cost is not binding at 500, not that it never binds.
 */
export const AREA_BOOST_TOP_N = 500;
/**
 * Contract rule O8 — number of steps the graded area boost spans between
 * `AREA_BOOST_W_LO` and `AREA_BOOST_W_HI` when `SEARCH_PEOPLE_AREA_BOOST_GRADED` is on.
 *
 * The upstream `total` is a genuine magnitude — the concept arm's `n²/total` over the
 * publications index — and the three-band cut discards it: a 200-paper specialist and a
 * 3-paper one share a band whenever both clear `AREA_BOOST_HI_FRAC` of the area's top.
 * More bands is the whole change; the emitted clause shape is unchanged.
 *
 * ponytail: banded, not one clause per scholar. Continuous would mean up to
 *   AREA_BOOST_TOP_N (500) function_score clauses for a boost that only needs to
 *   reorder within a relevance band. Raise the band count before going continuous.
 */
export const AREA_BOOST_GRADED_BANDS = 10;
/**
 * #1343 — minimum on-topic pubs for a WCM author to be eligible for the
 * concept-axis concentration boost. Floors out 1–2-pub authors whose on-topic
 * fraction would otherwise spike them above genuine specialists.
 */
export const CONCEPT_CONCENTRATION_MIN_PUBS = 3;

/**
 * ADR-011 B1 — the share exponent's code default. `alpha = 1` is the shipped
 * `n²/total` formula (count × on-topic fraction, at full strength); `alpha =
 * 0` is pure count. `SEARCH_PEOPLE_CONCEPT_ALPHA` is a `?flags=`-overridable
 * A/B lever (staging-only) for the α × `W_HI` × `dampen` sweep — see
 * {@link concentrationScore}. Unset ⇒ byte-identical to today.
 */
export const CONCEPT_CONCENTRATION_ALPHA_DEFAULT = 1;

/**
 * ADR-011 B1 — `n · share^α`, generalising the shipped `n²/total` (count ×
 * on-topic fraction). At `alpha = 1` this is exactly `n * (n/total) =
 * n²/total`, byte-identical to today. At `alpha = 0` it collapses to pure
 * count (`n`), rewarding volume alone. The sweep's job is to locate where
 * between those two poles the prolific generalist stops beating the
 * mid-career specialist — see the ADR's worked example (318/900 vs 150/200).
 *
 * Extracted as its own pure function (not inlined in
 * `getConceptScholarConcentration`) so the formula is unit-testable without
 * mocking OpenSearch.
 */
export function concentrationScore(n: number, total: number, alpha: number): number {
  const share = n / Math.max(total, 1);
  return n * Math.pow(share, alpha);
}

/**
 * Boost weights used by the publications-index query builder.
 * (Not specified in spec for publications; reasonable defaults.)
 */
export const PUBLICATION_FIELD_BOOSTS: ReadonlyArray<string> = [
  "title^4",
  "meshTerms^2",
  "authorNames^2",
  "journal^1",
  // Issue #32 — abstract text contributes to thematic-query relevance on
  // the publications tab. Low boost so a passing mention can't outrank a
  // direct title hit; best_fields scoring keeps the strongest single-field
  // match dominant.
  "abstract^0.5",
];

/**
 * Minimum-should-match expression for the pub-tab query (issue #259 §1.2).
 * Same value as the people-tab counterpart today, but defined separately:
 * the two surfaces have independent rollback triggers (spec §1.12) and may
 * diverge later if abstract noise on one or the other forces a tune.
 *
 * `abstract` on the publications index is a single paper's abstract, not a
 * concatenated blob, so msm works on the existing flat shape — no field
 * restructure needed. See `PEOPLE_RESTRUCTURED_MSM` for the full rationale
 * on the `"2<-34%"` choice (it's the loosened form of the original spec
 * literal `"-0% 3<-25%"`, surgically fixing the 3-token boundary).
 */
export const PUBLICATIONS_RESTRUCTURED_MSM = "2<-34%";

/**
 * GrantRecs Phase 2 — mapping for the `scholars-opportunities` index. One
 * document per funding opportunity, projected from the `opportunity` MySQL row.
 * Mirrors the funding index: `opportunity_text` analyzer for free text; hard
 * filters (status / dates / eligibility / mechanism) as keyword/date/bool;
 * `topicIds` as a coarse retrieval keyword array. The full `topicVector` and
 * `appealByStage` ride along as NON-INDEXED `_source` payload (`enabled:false`)
 * so the app-layer composite re-rank reads them without a second DB round-trip —
 * the same trick as the publications index's `topicImpacts`. See spec §7.2.
 */
export const opportunitiesIndexMapping = {
  settings: {
    "index.max_result_window": 100000,
    analysis: {
      analyzer: {
        opportunity_text: {
          type: "custom" as const,
          tokenizer: "standard",
          filter: [
            "lowercase",
            "alnum_delimiter",
            "flatten_graph",
            "english_stop",
            "english_stemmer",
          ],
        },
      },
      filter: {
        alnum_delimiter: {
          type: "word_delimiter_graph",
          split_on_numerics: true,
          preserve_original: true,
          generate_word_parts: true,
          generate_number_parts: true,
        },
        english_stop: { type: "stop", stopwords: "_english_" },
        english_stemmer: { type: "stemmer", language: "english" },
      },
    },
  },
  mappings: {
    properties: {
      opportunityId: { type: "keyword" },
      title: { type: "text", analyzer: "opportunity_text" },
      synopsis: { type: "text", analyzer: "opportunity_text" },
      sponsorText: { type: "text", analyzer: "opportunity_text" },

      // Hard-filter axes.
      status: { type: "keyword" },
      mechanism: { type: "keyword" },
      // Honorific recognition (prize/medal/…) — excluded from recommendations +
      // prestige-ordered lists via `must_not term isHonorific:true`.
      isHonorific: { type: "boolean" },
      // Derived eligibility flags (us_eligible / faculty_eligible / ...).
      eligibilityFlags: { type: "keyword" },
      cfdaList: { type: "keyword" },
      openDate: { type: "date" },
      dueDate: { type: "date" },

      // Topic retrieval — coarse candidate gate. `topicIds` = the opportunity's
      // topics with score ≥ threshold (see buildOpportunityDoc); same field-name
      // convention as the publications/funding `meshDescriptorUi` so one `terms`
      // template hits them. Queried via `terms`, never a facet.
      primaryTopicId: { type: "keyword" },
      topicIds: { type: "keyword" },
      meshDescriptorUi: { type: "keyword" },

      // Sort/display scalars.
      awardCeiling: { type: "long" },
      numberOfAwards: { type: "integer" },
      sponsor: { type: "keyword" },

      // NON-INDEXED re-rank payload — returned in `_source`, never searched.
      topicVector: { type: "object", enabled: false },
      appealByStage: { type: "object", enabled: false },
      prestige: { type: "object", enabled: false },
    },
  },
};

/** Score threshold for promoting an opportunity topic into the coarse `topicIds` gate. */
export const OPPORTUNITY_TOPIC_GATE = 0.3;

/** A `topic_vector` entry as stored on the `opportunity` row. */
export type OpportunityTopicScore = { topic_id: string; score: number; rationale?: string };

/** The `opportunity` columns the index builder selects (Prisma row subset). */
export type OpportunityIndexRow = {
  opportunityId: string;
  title: string;
  synopsis: string;
  sponsor: string;
  status: string;
  mechanism: string | null;
  eligibilityFlags: unknown; // string[]
  cfdaList: unknown; // string[]
  openDate: Date | null;
  dueDate: Date | null;
  primaryTopicId: string | null;
  topicVector: unknown; // OpportunityTopicScore[]
  appealByStage: unknown; // { grad, postdoc, early, mid, senior }
  meshDescriptorUi: unknown; // string[] | null
  prestige: unknown; // { score, mechanism_tier, ... } | null
  isHonorific: boolean | null;
  awardCeiling: bigint | null;
  numberOfAwards: number | null;
};

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Pure: project one `opportunity` row to its OpenSearch document. Extracted so
 * the field shaping (topic gate, date serialization, `_source` payload) is
 * unit-testable without an indexer run.
 */
export function buildOpportunityDoc(
  row: OpportunityIndexRow,
  gate: number = OPPORTUNITY_TOPIC_GATE,
): { id: string; doc: Record<string, unknown> } {
  const topicVector = (Array.isArray(row.topicVector) ? row.topicVector : []) as OpportunityTopicScore[];
  const topicIds = topicVector
    .filter((t) => t && typeof t.topic_id === "string" && typeof t.score === "number" && t.score >= gate)
    .map((t) => t.topic_id);

  const doc: Record<string, unknown> = {
    opportunityId: row.opportunityId,
    title: row.title,
    synopsis: row.synopsis,
    sponsorText: row.sponsor,
    sponsor: row.sponsor,
    status: row.status,
    mechanism: row.mechanism ?? undefined,
    eligibilityFlags: asStringArray(row.eligibilityFlags),
    cfdaList: asStringArray(row.cfdaList),
    openDate: row.openDate ? row.openDate.toISOString() : undefined,
    dueDate: row.dueDate ? row.dueDate.toISOString() : undefined,
    primaryTopicId: row.primaryTopicId ?? undefined,
    topicIds,
    meshDescriptorUi: asStringArray(row.meshDescriptorUi),
    // Honorific flag — indexed so prestige-ordered / recommender reads can filter
    // (`must_not term isHonorific:true`).
    //
    // 🔴 UNCLASSIFIED (null) INDEXES AS HONORIFIC. Null does not mean "not an honorific", it means
    // the GRANT# extractor never labelled the row — and empirically an unlabelled row IS one.
    // Measured on staging 2026-07-28: null is exactly 29 rows corpus-wide (of 1,151), every one
    // `wcm_curated`, and 28 of the 29 are prizes — National Medal of Science, Vannevar Bush Award,
    // Vilcek Prizes, AAAS science-journalism awards, mentoring medals. Folding them to `false` put
    // them in "grants for you" as applyable funding.
    //
    // This also makes the two consumers agree. `/api/opportunities` excludes null (Prisma's
    // three-valued `not: true`), so the browse never showed these; the index said the opposite.
    // Same rows, opposite postures, decided by which storage layer each surface happened to read.
    isHonorific: row.isHonorific !== false,
    awardCeiling: row.awardCeiling != null ? Number(row.awardCeiling) : undefined,
    numberOfAwards: row.numberOfAwards ?? undefined,
    // Non-indexed re-rank payload.
    topicVector,
    appealByStage: row.appealByStage && typeof row.appealByStage === "object" ? row.appealByStage : {},
    prestige: row.prestige && typeof row.prestige === "object" ? row.prestige : undefined,
  };
  return { id: row.opportunityId, doc };
}
