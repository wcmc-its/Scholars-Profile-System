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

/**
 * Mapping for the people index. Note that authorship-weighted contributions
 * are pre-multiplied at index time (publication titles and MeSH terms appear
 * in the document N times based on authorship position), so the search-time
 * boost for those fields is the spec value (×1, ×0.5) without further math.
 */
export const peopleIndexMapping = {
  settings: {
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
      fullName: { type: "text", analyzer: "scholar_text" },
      // Autocomplete suggester (spec line 184: fires on 2 chars).
      // Suggests "name + primary title" (Stanford-style; FunReq Figure C).
      nameSuggest: {
        type: "completion",
      },
      primaryTitle: { type: "text", analyzer: "scholar_text" },
      primaryDepartment: {
        type: "text",
        analyzer: "scholar_text",
        fields: { keyword: { type: "keyword" } },
      },
      areasOfInterest: { type: "text", analyzer: "scholar_text" },
      overview: { type: "text", analyzer: "scholar_text" },
      publicationTitles: { type: "text", analyzer: "scholar_text" },
      publicationMesh: { type: "text", analyzer: "scholar_text" },
      // Filter facets.
      hasActiveGrants: { type: "boolean" },
      isComplete: { type: "boolean" }, // sparse-profile filter (spec line 196)
      personType: { type: "keyword" }, // person-type filter (spec line 195)
      // Counters used in result snippets.
      publicationCount: { type: "integer" },
      grantCount: { type: "integer" },
      // For "most recent publication" sort (spec line 194).
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
      authorNames: { type: "text", analyzer: "pub_text" },
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
];

/**
 * Boost weights used by the publications-index query builder.
 * (Not specified in spec for publications; reasonable defaults.)
 */
export const PUBLICATION_FIELD_BOOSTS: ReadonlyArray<string> = [
  "title^4",
  "meshTerms^2",
  "journal^1",
  "authorNames^2",
];
