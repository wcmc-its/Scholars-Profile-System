/**
 * Sponsor-match searchPeople SPINE engine (`sponsor-match-spine-run.ts`):
 *  - term extraction over the taxonomy-label vocab → per-term MeSH resolution →
 *    cluster dedup → per-cluster `searchPeople` → weighted RRF → top-N map;
 *  - the fusion weight is centrality × dampedIdf(coverage) — the idf actually
 *    reorders (a rare concept up-weights its cluster);
 *  - redundant phrasing collapses into ONE `searchPeople` call;
 *  - empty/whitespace/control-char paste short-circuits with no vocab load or search;
 *  - a `searchPeople` failure propagates (no silent partial results).
 * Mocks db + searchPeople + matchQueryToTaxonomy; the pure spine/axes helpers and
 * `normalizeDescription` run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockTopicFindMany,
  mockSubtopicFindMany,
  mockMeshDescriptorFindMany,
  mockTechnologyGroupBy,
  mockSearchPeople,
  mockMatchQueryToTaxonomy,
} = vi.hoisted(() => ({
  mockTopicFindMany: vi.fn(),
  mockSubtopicFindMany: vi.fn(),
  mockMeshDescriptorFindMany: vi.fn(),
  mockTechnologyGroupBy: vi.fn(),
  mockSearchPeople: vi.fn(),
  mockMatchQueryToTaxonomy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      topic: { findMany: mockTopicFindMany },
      subtopic: { findMany: mockSubtopicFindMany },
      meshDescriptor: { findMany: mockMeshDescriptorFindMany },
      scholarTechnology: { groupBy: mockTechnologyGroupBy },
    },
  },
}));
vi.mock("@/lib/api/search", () => ({
  searchPeople: mockSearchPeople,
  relevanceScoresForQuery: vi.fn(), // imported by the bespoke engine module we load for real
}));
vi.mock("@/lib/api/search-taxonomy", () => ({
  matchQueryToTaxonomy: mockMatchQueryToTaxonomy,
}));
vi.mock("@/lib/search", () => ({ meshMatchTier: vi.fn(() => "exact") }));

import { rankResearchersForDescriptionSpine } from "@/lib/api/sponsor-match-spine-run";

/** A MeSH resolution stub — spine-run reads descriptorUi/descendantUis/confidence/
 *  curatedTopicAnchors/ambiguous/matchedForm/name. */
function meshRes(descriptorUi: string, descendantUis: string[]) {
  return {
    state: "none" as const,
    meshResolution: {
      descriptorUi,
      name: descriptorUi,
      matchedForm: descriptorUi,
      confidence: "exact" as const,
      scopeNote: null,
      entryTerms: [] as string[],
      curatedTopicAnchors: [] as string[],
      descendantUis,
      ambiguous: false,
    },
  };
}

/** A `searchPeople` hit — only the display fields spine-run reads. */
function hit(cwid: string) {
  return {
    cwid,
    slug: `s-${cwid}`,
    preferredName: `${cwid} Name`,
    primaryTitle: `T-${cwid}`,
    primaryDepartment: `Dept-${cwid}`,
  };
}

/** A `searchPeople` result page — hits < page size so the caller stops after page 0. */
function people(cwids: string[]) {
  return { hits: cwids.map(hit), total: cwids.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTopicFindMany.mockResolvedValue([]);
  mockSubtopicFindMany.mockResolvedValue([]);
  mockMeshDescriptorFindMany.mockResolvedValue([]);
  mockTechnologyGroupBy.mockResolvedValue([]);
  mockMatchQueryToTaxonomy.mockResolvedValue({ state: "none", meshResolution: null });
  mockSearchPeople.mockResolvedValue(people([]));
});

describe("rankResearchersForDescriptionSpine", () => {
  it("fuses per-cluster searchPeople rankings and applies the dampedIdf weight", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "munchausen syndrome" }]);
    // Disjoint descendant sets ⇒ two separate clusters.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_CANCER", ["D_CANCER"]) : meshRes("D_MUNCH", ["D_MUNCH"]),
    );
    // Cancer is common (coverage 0.5 ⇒ low idf); Munchausen is rare (0.001 ⇒ high idf).
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_CANCER", localPubCoverage: 0.5 },
      { descriptorUi: "D_MUNCH", localPubCoverage: 0.001 },
    ]);
    mockSearchPeople.mockImplementation(async ({ q }: { q: string }) =>
      q === "cancer" ? people(["x", "y"]) : people(["y", "z"]),
    );
    mockTechnologyGroupBy.mockResolvedValue([{ cwid: "y", _count: { _all: 2 } }]);

    const out = await rankResearchersForDescriptionSpine("cancer and munchausen syndrome work");

    // Weights: cancer -ln(0.5)=0.693, munchausen -ln(0.001)=6.908. Fused:
    //   y = .693/62 + 6.908/61 = .124 (both terms), z = 6.908/62 = .111, x = .693/61 = .011.
    // Order [y,z,x] — z outranks x ONLY because the idf up-weighted the rare cluster;
    // with uniform weights the order would be [y,x,z]. So this proves the weight applied.
    expect(out.map((r) => r.cwid)).toEqual(["y", "z", "x"]);
    expect(out[0].defaultScore).toBeGreaterThan(out[1].defaultScore);
    expect(out[1].defaultScore).toBeGreaterThan(out[2].defaultScore);

    // Display fields ride in from the searchPeople hits; RRF score orders the rows.
    const y = out[0];
    expect(y).toMatchObject({
      cwid: "y",
      slug: "s-y",
      preferredName: "y Name",
      title: "T-y",
      department: "Dept-y",
      careerStage: null,
      technologyCount: 2,
      topPapers: [],
      matchedTopics: [],
    });
    expect(y.axes.topicFit).toBe(y.defaultScore);
    expect(out.find((r) => r.cwid === "x")!.technologyCount).toBe(0);

    // Topical-only retrieval: employment priors OFF, topic shape, v3, concept boost.
    const cancerCall = mockSearchPeople.mock.calls.find((c) => c[0].q === "cancer")![0];
    expect(cancerCall).toMatchObject({
      q: "cancer",
      shape: "topic",
      relevanceMode: "v3",
      facultyProminence: false,
      grantProminence: false,
      meshDescendantUis: ["D_CANCER"],
    });
  });

  it("merges redundant phrasing into ONE searchPeople call (union descendant set)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockSubtopicFindMany.mockResolvedValue([{ label: "oncology" }]);
    // Identical descendant sets ⇒ subsumption/Jaccard=1 ⇒ one merged cluster.
    mockMatchQueryToTaxonomy.mockImplementation(async (q: string) =>
      q === "cancer" ? meshRes("D_A", ["D1", "D2"]) : meshRes("D_B", ["D1", "D2"]),
    );
    mockMeshDescriptorFindMany.mockResolvedValue([
      { descriptorUi: "D_A", localPubCoverage: 0.2 },
      { descriptorUi: "D_B", localPubCoverage: 0.2 },
    ]);
    mockSearchPeople.mockResolvedValue(people(["a"]));

    const out = await rankResearchersForDescriptionSpine("cancer oncology");

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople.mock.calls[0][0]).toMatchObject({
      q: "cancer oncology",
      meshDescendantUis: ["D1", "D2"],
    });
    expect(out.map((r) => r.cwid)).toEqual(["a"]);
  });

  it("returns [] for empty/whitespace/control-char input WITHOUT loading vocab or searching", async () => {
    expect(await rankResearchersForDescriptionSpine("")).toEqual([]);
    expect(await rankResearchersForDescriptionSpine("   \n\t  ")).toEqual([]);
    expect(await rankResearchersForDescriptionSpine(String.fromCharCode(0, 7, 27, 127))).toEqual([]);
    expect(mockTopicFindMany).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("returns [] when no vocab term occurs in the paste, without searching", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    const out = await rankResearchersForDescriptionSpine("totally unrelated prose about weather");
    expect(out).toEqual([]);
    expect(mockTopicFindMany).toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("propagates a searchPeople failure (route maps it to 502 — no partial results)", async () => {
    mockTopicFindMany.mockResolvedValue([{ label: "cancer" }]);
    mockMatchQueryToTaxonomy.mockResolvedValue(meshRes("D_CANCER", ["D_CANCER"]));
    mockSearchPeople.mockRejectedValue(new Error("opensearch down"));
    await expect(rankResearchersForDescriptionSpine("cancer research")).rejects.toThrow(
      "opensearch down",
    );
  });
});
