/**
 * Issue #702 — People match-explainability (`SEARCH_PEOPLE_MATCH_EXPLAIN`).
 *
 * Two contracts, asserted at the body-shape and the hit-emission level:
 *   - body: when on, the highlight request also names the pub-evidence fields
 *     (`publicationTitles` / `publicationMesh`) and the detection-only fields
 *     (`fullName` / `primaryTitle` / `primaryDepartment`); the #692 demote
 *     `highlight_query` widens to the same set. Off ⇒ byte-identical to pre-#702.
 *   - emission: the highlight response is partitioned into `highlight` (self),
 *     `pubHighlight` (pub evidence), and `matchedOnFields` (chip). Off ⇒ the
 *     pre-#702 flatten-everything behavior with no pub/chip fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID } from "../fixtures/scholar";

const { groupByMock, hitHolder } = vi.hoisted(() => ({
  groupByMock: vi.fn(),
  // Mutable highlight response the mocked OpenSearch client returns; each test
  // sets `hitHolder.highlight` before calling searchPeople.
  hitHolder: { highlight: undefined as Record<string, string[]> | undefined },
}));

vi.mock("@/lib/db", () => ({
  prisma: { publicationTopic: { groupBy: groupByMock } },
}));

const capturedBodies: Array<Record<string, unknown>> = [];

vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  PUBLICATIONS_INDEX: "scholars-publications",
  PEOPLE_FIELD_BOOSTS: ["preferredName^10", "publicationAbstracts^0.3"],
  PEOPLE_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^10",
    "fullName^10",
    "areasOfInterest^6",
    "primaryTitle^4",
    "primaryDepartment^3",
    "overview^2",
    "publicationTitles^1",
    "publicationMesh^0.5",
  ],
  PEOPLE_ABSTRACTS_BOOST: 0.3,
  PEOPLE_RESTRUCTURED_MSM: "2<-34%",
  PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS: [
    "preferredName^1",
    "fullName^1",
    "areasOfInterest^3",
    "primaryTitle^3",
    "primaryDepartment^1",
    "overview^2",
    "publicationTitles^6",
    "publicationMesh^4",
  ],
  PEOPLE_TOPIC_ABSTRACTS_BOOST: 0.5,
  PEOPLE_PROMINENCE_BASE_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_PUBCOUNT_FACTOR: 1,
  PEOPLE_PROMINENCE_FACULTY_WEIGHT: 1.0,
  PEOPLE_PROMINENCE_GRANT_WEIGHT: 0.5,
  PEOPLE_FULL_TIME_FACULTY_PERSON_TYPE: "full_time_faculty",
  PUBLICATION_FIELD_BOOSTS: ["title^1"],
  searchClient: () => ({
    async search(req: { body: Record<string, unknown> }) {
      capturedBodies.push(req.body);
      return {
        body: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _source: {
                  cwid: FIXTURE_CWID,
                  slug: "jane-doe",
                  preferredName: "Jane Doe",
                  primaryTitle: "Professor",
                  primaryDepartment: "Medicine",
                  deptName: "Medicine",
                  divisionName: null,
                  personType: "full_time_faculty",
                  publicationCount: 40,
                  grantCount: 2,
                  hasActiveGrants: true,
                },
                highlight: hitHolder.highlight,
              },
            ],
          },
          aggregations: {
            deptDivs: { keys: { buckets: [] } },
            personTypes: { keys: { buckets: [] } },
            activityHasGrants: { doc_count: 0 },
            activityRecentPub: { doc_count: 0 },
            attributionMatch: { doc_count: 0 },
          },
        },
      };
    },
    async mget() {
      return { body: { docs: [] } };
    },
  }),
}));

import { searchPeople } from "@/lib/api/search";

const highlightFieldsOf = (body: Record<string, unknown>) =>
  Object.keys((body as { highlight: { fields: Record<string, unknown> } }).highlight.fields);

const highlightQueryOf = (body: Record<string, unknown>) =>
  (
    body as {
      highlight: { highlight_query?: { multi_match: { query: string; fields: string[] } } };
    }
  ).highlight.highlight_query;

beforeEach(() => {
  capturedBodies.length = 0;
  hitHolder.highlight = undefined;
});
afterEach(() => {
  delete process.env.SEARCH_PEOPLE_MATCH_EXPLAIN;
});

describe("#702 highlight body", () => {
  it("off: highlights only the three self-reported fields (byte-identical to pre-#702)", async () => {
    await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
    });
    expect(highlightFieldsOf(capturedBodies[0])).toEqual([
      "preferredName",
      "areasOfInterest",
      "overview",
    ]);
    // No analyzer-offset cap on the flag-off body.
    expect(
      (capturedBodies[0] as { highlight: { max_analyzer_offset?: number } }).highlight
        .max_analyzer_offset,
    ).toBeUndefined();
  });

  it("on: also requests the pub-evidence and detection-only fields, capped at the analyzer offset", async () => {
    await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
      matchExplain: true,
    });
    expect(highlightFieldsOf(capturedBodies[0])).toEqual([
      "preferredName",
      "areasOfInterest",
      "overview",
      "publicationTitles",
      "publicationMesh",
      "fullName",
      "primaryTitle",
      "primaryDepartment",
    ]);
    // #702 — cap analysis of the concatenated publicationTitles blob so a
    // prolific author can't trip OpenSearch's max-offset guard and 500 the
    // whole search. NB the query param is `max_analyzer_offset` (not the
    // `max_analyzed_offset` index setting it bounds).
    expect(
      (capturedBodies[0] as { highlight: { max_analyzer_offset?: number } }).highlight
        .max_analyzer_offset,
    ).toBe(900000);
  });

  it("on + demote: the #692 highlight_query widens to the same field set", async () => {
    await searchPeople({
      q: "microbiome research",
      contentQuery: "microbiome",
      genericDemote: true,
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
      matchExplain: true,
    });
    const hq = highlightQueryOf(capturedBodies[0]);
    expect(hq?.multi_match.query).toBe("microbiome");
    expect(hq?.multi_match.fields).toEqual([
      "preferredName",
      "areasOfInterest",
      "overview",
      "publicationTitles",
      "publicationMesh",
      "fullName",
      "primaryTitle",
      "primaryDepartment",
    ]);
  });
});

describe("#702 hit emission", () => {
  it("off: flattens every highlight fragment into `highlight`, no pub/chip fields", async () => {
    hitHolder.highlight = {
      overview: ["<mark>microbiome</mark> work"],
      publicationTitles: ["a <mark>microbiome</mark> paper"],
    };
    const res = await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
    });
    const hit = res.hits[0];
    expect(hit.highlight).toEqual([
      "<mark>microbiome</mark> work",
      "a <mark>microbiome</mark> paper",
    ]);
    expect(hit.pubHighlight).toBeUndefined();
    expect(hit.matchedOnFields).toBeUndefined();
  });

  it("on, pub-only match: nothing in `highlight`, fragment in `pubHighlight`, chip fields set", async () => {
    hitHolder.highlight = {
      publicationTitles: ["a <mark>microbiome</mark> paper"],
      primaryDepartment: ["<mark>Medicine</mark>"],
    };
    const res = await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
      matchExplain: true,
    });
    const hit = res.hits[0];
    expect(hit.highlight).toBeUndefined();
    expect(hit.pubHighlight).toEqual(["a <mark>microbiome</mark> paper"]);
    expect(hit.matchedOnFields).toEqual(["department", "publications"]);
  });

  it("on, mixed match: self fragment in `highlight`, pub fragment also surfaced", async () => {
    hitHolder.highlight = {
      overview: ["<mark>microbiome</mark> work"],
      publicationMesh: ["<mark>Microbiota</mark>"],
    };
    const res = await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
      matchExplain: true,
    });
    const hit = res.hits[0];
    expect(hit.highlight).toEqual(["<mark>microbiome</mark> work"]);
    expect(hit.pubHighlight).toEqual(["<mark>Microbiota</mark>"]);
    expect(hit.matchedOnFields).toEqual(["overview", "publications"]);
  });

  it("on, no highlight at all: all three fields undefined", async () => {
    hitHolder.highlight = undefined;
    const res = await searchPeople({
      q: "microbiome",
      relevanceMode: "v3",
      shape: "topic",
      meshDescendantUis: ["D064307"],
      matchExplain: true,
    });
    const hit = res.hits[0];
    expect(hit.highlight).toBeUndefined();
    expect(hit.pubHighlight).toBeUndefined();
    expect(hit.matchedOnFields).toBeUndefined();
  });
});
