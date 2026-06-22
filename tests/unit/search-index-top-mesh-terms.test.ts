/**
 * CONTRACT A — `topMeshTerms` is the People-doc rollup behind the People-tab
 * "concepts" identity hint (gated query-side by SEARCH_PEOPLE_CONCEPT_HINT). It
 * is the scholar's TOP 8 MeSH descriptors — each as a { ui, label } object so
 * the card chip can deep-link to the scholar's pubs filtered by `?mesh=<ui>` —
 * by distinct-publication frequency across their accepted/visible publications,
 * sorted count DESC then label ASC, and OMITTED entirely when the scholar has
 * none. The `ui` is the first non-null descriptor UI seen for that label.
 *
 * Two layers are exercised:
 *   - `topMeshTermsFromCounts` — the pure reducer (cap / ordering / ui / empty),
 *     callable without a DB.
 *   - `buildPeopleDoc` — end-to-end wiring: the field is populated from the
 *     scholar's `authorships[].publication.meshTerms`, deduped within a pub,
 *     ui preserved, and omit-on-empty when no visible pub carries MeSH.
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

type MeshTerm = { ui: string | null; label: string };

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

// Build a scholar with one authorship per `pubs` entry. Each entry is that
// publication's MeSH list — a bare string (ui null) or a { ui, label } pair.
// Authorship role is middle by default so no min-evidence side effects matter.
function scholarWithPubs(
  pubs: ReadonlyArray<ReadonlyArray<string | MeshTerm>>,
): ScholarForIndex {
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
    authorships: pubs.map((terms, i) => ({
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
        meshTerms: terms.map((t) => (typeof t === "string" ? { ui: null, label: t } : t)),
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

  it("sorts by count DESC and carries the ui through", () => {
    const counts = new Map([
      ["Alpha", { count: 1, ui: "D1" }],
      ["Bravo", { count: 5, ui: "D2" }],
      ["Charlie", { count: 3, ui: null }],
    ]);
    expect(topMeshTermsFromCounts(counts)).toEqual([
      { ui: "D2", label: "Bravo" },
      { ui: null, label: "Charlie" },
      { ui: "D1", label: "Alpha" },
    ]);
  });

  it("breaks count ties by label ASC (locale-aware)", () => {
    const counts = new Map([
      ["Zebra", { count: 2, ui: null }],
      ["Apple", { count: 2, ui: null }],
      ["mango", { count: 2, ui: null }],
    ]);
    expect(topMeshTermsFromCounts(counts).map((t) => t.label)).toEqual(["Apple", "mango", "Zebra"]);
  });

  it("applies count-desc THEN label-asc together", () => {
    const counts = new Map([
      ["Cancer", { count: 4, ui: null }],
      ["Aging", { count: 4, ui: null }],
      ["Heart", { count: 9, ui: null }],
      ["Brain", { count: 1, ui: null }],
    ]);
    expect(topMeshTermsFromCounts(counts).map((t) => t.label)).toEqual([
      "Heart", // 9
      "Aging", // 4, A < C
      "Cancer", // 4
      "Brain", // 1
    ]);
  });

  it("caps the result at TOP_MESH_TERMS_LIMIT (8), keeping the highest-count head", () => {
    expect(TOP_MESH_TERMS_LIMIT).toBe(8);
    const counts = new Map<string, { count: number; ui: string | null }>();
    const labels = ["L12","L11","L10","L09","L08","L07","L06","L05","L04","L03","L02","L01"];
    labels.forEach((label, i) => counts.set(label, { count: labels.length - i, ui: null }));
    const out = topMeshTermsFromCounts(counts);
    expect(out).toHaveLength(8);
    expect(out.map((t) => t.label)).toEqual(["L12","L11","L10","L09","L08","L07","L06","L05"]);
    expect(out.map((t) => t.label)).not.toContain("L04");
  });
});

describe("buildPeopleDoc — topMeshTerms wiring (CONTRACT A end-to-end)", () => {
  it("aggregates across visible pubs, count-desc then label-asc, top 8, as {ui,label}", async () => {
    // Heart on 3 pubs, Brain on 2, Aging on 2, Cancer on 1.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        ["Heart", "Cancer"],
        ["Heart", "Brain"],
        ["Heart", "Brain", "Aging"],
        ["Aging"],
      ]),
      mockClient([null, null, null, null]),
      NO_SUP,
    )) as { topMeshTerms?: MeshTerm[] };

    expect(doc.topMeshTerms).toEqual([
      { ui: null, label: "Heart" },
      { ui: null, label: "Aging" },
      { ui: null, label: "Brain" },
      { ui: null, label: "Cancer" },
    ]);
  });

  it("preserves the first non-null descriptor ui for a label across pubs", async () => {
    // "COVID-19" appears ui-less on pub 1, then with a ui on pub 2 → the ui wins.
    const doc = (await buildPeopleDoc(
      scholarWithPubs([
        ["COVID-19"],
        [{ ui: "D000086382", label: "COVID-19" }],
      ]),
      mockClient([null, null]),
      NO_SUP,
    )) as { topMeshTerms?: MeshTerm[] };

    expect(doc.topMeshTerms).toEqual([{ ui: "D000086382", label: "COVID-19" }]);
  });

  it("counts a label at most once per pub (dedupes within a publication)", async () => {
    const doc = (await buildPeopleDoc(
      scholarWithPubs([["Heart", "Heart", "Brain"]]),
      mockClient([null]),
      NO_SUP,
    )) as { topMeshTerms?: MeshTerm[] };

    // Both at count 1 → label ASC (Brain before Heart).
    expect(doc.topMeshTerms).toEqual([
      { ui: null, label: "Brain" },
      { ui: null, label: "Heart" },
    ]);
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
    const sup: PublicationSuppressions = {
      darkPmids: new Set(),
      hiddenAuthorsByPmid: new Map([["1", new Set(["test1234"])]]),
    };
    const doc = (await buildPeopleDoc(
      scholarWithPubs([["Hidden"], ["Visible"]]),
      mockClient([null, null]),
      sup,
    )) as { topMeshTerms?: MeshTerm[] };

    expect(doc.topMeshTerms).toEqual([{ ui: null, label: "Visible" }]);
  });
});
