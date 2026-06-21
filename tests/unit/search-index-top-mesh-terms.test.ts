/**
 * CONTRACT A — `topMeshTerms` is the People-doc rollup behind the People-tab
 * "TOPICS" identity hint (gated query-side by SEARCH_PEOPLE_CONCEPT_HINT). It
 * is the scholar's TOP 8 MeSH descriptor labels by distinct-publication
 * frequency across their accepted/visible publications, sorted count DESC then
 * label ASC, and OMITTED entirely when the scholar has none.
 *
 * Two layers are exercised:
 *   - `topMeshTermsFromCounts` — the pure reducer (cap / ordering / empty),
 *     callable without a DB.
 *   - `buildPeopleDoc` — end-to-end wiring: the field is populated from the
 *     scholar's `authorships[].publication.meshTerms`, deduped within a pub,
 *     and omit-on-empty when no visible pub carries MeSH.
 */
import { describe, it, expect, vi } from "vitest";

import type { PublicationSuppressions } from "@/lib/api/manual-layer";
import {
  buildPeopleDoc,
  topMeshTermsFromCounts,
  TOP_MESH_TERMS_LIMIT,
  type ScholarForIndex,
} from "@/lib/search-index-docs";

const NO_SUP: PublicationSuppressions = {
  darkPmids: new Set(),
  hiddenAuthorsByPmid: new Map(),
};

// Minimal mock client — `buildPeopleDoc` issues sidecar queries for
// mostRecentPubDate / center / division / leadership rollups, none of which
// affect `topMeshTerms`. Empty results keep this test focused on the MeSH
// aggregation path.
function mockClient(pubDates: ReadonlyArray<Date | null> = []) {
  return {
    centerMembership: { findMany: vi.fn().mockResolvedValue([]) },
    divisionMembership: { findMany: vi.fn().mockResolvedValue([]) },
    publicationAuthor: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          pubDates.map((d) => ({ publication: { dateAddedToEntrez: d } })),
        ),
    },
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as Parameters<typeof buildPeopleDoc>[1];
}

// Build a scholar with one authorship per `pubs` entry; each entry is the list
// of MeSH labels on that publication. Authorship role is middle by default so
// no min-evidence side effects matter (topMeshTerms ignores that gate).
function scholarWithPubs(pubs: ReadonlyArray<ReadonlyArray<string>>): ScholarForIndex {
  const s: Partial<ScholarForIndex> = {
    cwid: "test1234",
    slug: "test",
    preferredName: "Test Scholar",
    fullName: "Test Scholar",
    postnominal: null,
    primaryTitle: "Professor",
    primaryDepartment: "Dept",
    overview: null,
    roleCategory: "faculty",
    deptCode: null,
    divCode: null,
    department: null,
    division: null,
    topicAssignments: [],
    grants: [],
    authorships: pubs.map((labels, i) => ({
      pmid: String(i + 1),
      cwid: "test1234",
      isConfirmed: true,
      isFirst: false,
      isLast: false,
      isPenultimate: false,
      position: 3,
      totalAuthors: 6,
      publication: {
        title: `p${i + 1}`,
        meshTerms: labels.map((label) => ({ ui: null, label })),
        abstract: null,
      },
    })) as unknown as ScholarForIndex["authorships"],
  };
  return s as ScholarForIndex;
}

describe("topMeshTermsFromCounts (CONTRACT A reducer)", () => {
  it("returns [] for an empty map (drives the omit-on-empty contract)", () => {
    expect(topMeshTermsFromCounts(new Map())).toEqual([]);
  });

  it("sorts by count DESC", () => {
    const counts = new Map([
      ["Alpha", 1],
      ["Bravo", 5],
      ["Charlie", 3],
    ]);
    expect(topMeshTermsFromCounts(counts)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  it("breaks count ties by label ASC (locale-aware)", () => {
    const counts = new Map([
      ["Zebra", 2],
      ["Apple", 2],
      ["mango", 2],
    ]);
    // Same count → alphabetical; localeCompare puts "Apple" before "mango"
    // before "Zebra".
    expect(topMeshTermsFromCounts(counts)).toEqual(["Apple", "mango", "Zebra"]);
  });

  it("applies count-desc THEN label-asc together", () => {
    const counts = new Map([
      ["Cancer", 4],
      ["Aging", 4],
      ["Heart", 9],
      ["Brain", 1],
    ]);
    expect(topMeshTermsFromCounts(counts)).toEqual([
      "Heart", // 9
      "Aging", // 4, A < C
      "Cancer", // 4
      "Brain", // 1
    ]);
  });

  it("caps the result at TOP_MESH_TERMS_LIMIT (8), keeping the highest-count head", () => {
    expect(TOP_MESH_TERMS_LIMIT).toBe(8);
    // 12 labels, descending counts 12..1 so the order is unambiguous; the top 8
    // by count survive and labels 4..1 (counts 4..1) are dropped.
    const counts = new Map<string, number>();
    const labels = [
      "L12",
      "L11",
      "L10",
      "L09",
      "L08",
      "L07",
      "L06",
      "L05",
      "L04",
      "L03",
      "L02",
      "L01",
    ];
    labels.forEach((label, i) => counts.set(label, labels.length - i));
    const out = topMeshTermsFromCounts(counts);
    expect(out).toHaveLength(8);
    expect(out).toEqual(["L12", "L11", "L10", "L09", "L08", "L07", "L06", "L05"]);
    expect(out).not.toContain("L04");
  });
});

describe("buildPeopleDoc — topMeshTerms wiring (CONTRACT A end-to-end)", () => {
  it("aggregates labels across visible pubs, count-desc then label-asc, top 8", async () => {
    // Heart on 3 pubs, Brain on 2, Aging on 2, Cancer on 1.
    // Expected order: Heart (3), then Aging & Brain tied at 2 (A<B), then Cancer (1).
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        ["Heart", "Cancer"],
        ["Heart", "Brain"],
        ["Heart", "Brain", "Aging"],
        ["Aging"],
      ]),
      mockClient([null, null, null, null]),
      NO_SUP,
    )) as { topMeshTerms?: string[] };

    expect(doc.topMeshTerms).toEqual(["Heart", "Aging", "Brain", "Cancer"]);
  });

  it("counts a label at most once per pub (dedupes within a publication)", async () => {
    // A double-entry of "Heart" on a single pub must NOT count twice.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([["Heart", "Heart", "Brain"]]),
      mockClient([null]),
      NO_SUP,
    )) as { topMeshTerms?: string[] };

    // Both at count 1 → label ASC (Brain before Heart).
    expect(doc.topMeshTerms).toEqual(["Brain", "Heart"]);
  });

  it("omits the field entirely when the scholar has no MeSH on any visible pub", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithPubs([[], []]),
      mockClient([null, null]),
      NO_SUP,
    )) as Record<string, unknown>;

    expect(doc).not.toHaveProperty("topMeshTerms");
  });

  it("excludes a suppressed (author-hidden) pub's labels from the rollup", async () => {
    // pmid "1" is hidden for this scholar → its "Hidden" label must not appear;
    // pmid "2" stays → only "Visible" survives.
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["test1234"])]]),
    };
    const doc = (await buildPeopleDoc(
      scholarWithPubs([["Hidden"], ["Visible"]]),
      mockClient([null, null]),
      sup,
    )) as { topMeshTerms?: string[] };

    expect(doc.topMeshTerms).toEqual(["Visible"]);
  });
});
