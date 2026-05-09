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
import { Client } from "@opensearch-project/opensearch";

let _client: Client | null = null;

export function searchClient(): Client {
  if (_client) return _client;
  const node = process.env.OPENSEARCH_NODE ?? "http://localhost:9200";
  _client = new Client({ node });
  return _client;
}

export const PEOPLE_INDEX = "scholars-people";
export const PUBLICATIONS_INDEX = "scholars-publications";
export const FUNDING_INDEX = "scholars-funding";

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
          filter: ["lowercase", "english_stop", "english_stemmer"],
        },
        // The completion suggester's default analyzer is `simple`, which
        // strips digits — so a CWID like "pja9004" indexes as the bare
        // prefix "pja" and any digits-only-different query (e.g.
        // "pja2002") spuriously matches it. Use a digits-preserving
        // analyzer (standard tokenizer keeps letter+digit runs intact)
        // so CWIDs survive while names still tokenize cleanly.
        scholar_suggest: {
          type: "custom" as const,
          tokenizer: "standard",
          filter: ["lowercase"],
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
      overview: { type: "text", analyzer: "scholar_text" },
      publicationTitles: { type: "text", analyzer: "scholar_text" },
      publicationMesh: { type: "text", analyzer: "scholar_text" },
      // Issue #21 — concatenated abstract text from each scholar's
      // confirmed publications. ONE copy per paper (no authorship-position
      // repetition); abstracts are 50-200x longer than titles, so the
      // weighting signal is captured by titles + mesh and we don't pay the
      // index-size cost of repeating the body text.
      publicationAbstracts: { type: "text", analyzer: "scholar_text" },
      // Filter facets.
      hasActiveGrants: { type: "boolean" },
      isComplete: { type: "boolean" }, // sparse-profile filter (spec line 196)
      personType: { type: "keyword" }, // person-type filter (spec line 195)
      // Counters used in result snippets.
      publicationCount: { type: "integer" },
      grantCount: { type: "integer" },
      // For "most recent publication" sort (spec line 194) and the
      // "Published in last 2 years" activity filter (issue #8 item 15).
      mostRecentPubDate: { type: "date" },
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
      pubmedUrl: { type: "keyword" },
      meshTerms: { type: "text" },
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
      // Pre-rendered author chips for the WCM-coauthor stack on results.
      wcmAuthors: {
        type: "nested",
        properties: {
          cwid: { type: "keyword" },
          slug: { type: "keyword" },
          preferredName: { type: "text" },
          position: { type: "integer" },
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
];

/**
 * Per-field boost weights (spec lines 156, 165). Used by the people-index
 * query builder to construct multi_match field weights.
 */
export const PEOPLE_FIELD_BOOSTS: ReadonlyArray<string> = [
  "preferredName^10",
  "fullName^10",
  "areasOfInterest^6",
  "primaryTitle^4",
  "primaryDepartment^3",
  "overview^2",
  "publicationTitles^1",
  "publicationMesh^0.5",
  // Issue #21 — abstract text contributes to thematic-query relevance
  // (e.g. "psychiatric comorbidities in serious illness") but at a low
  // boost so a single passing mention can't displace name/title/dept hits.
  // best_fields scoring (the multi_match default) keeps the strongest
  // single-field match dominant, so this is informative without being noisy.
  "publicationAbstracts^0.3",
];

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
