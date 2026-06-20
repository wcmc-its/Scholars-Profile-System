/**
 * Tests for lib/api/publication-detail.ts (#288 PR-B).
 *
 * Coverage:
 *   - validates pmid format; returns null on garbage input
 *   - returns null when publication not found
 *   - collapses multi-author publication_topic rows by MAX(score)
 *   - resolves subtopics to display names
 *   - sorts topics by score desc; subtopics by primary → confidence
 *   - reads synopsis directly off Publication.synopsis (#329)
 *   - returns citingPubs from reciterdb ordered by date desc
 *   - soft-fails citingPubs to null when reciterdb throws
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  publicationFindUnique: vi.fn(),
  subtopicFindMany: vi.fn().mockResolvedValue([]),
  suppressionFindMany: vi.fn().mockResolvedValue([]),
  publicationAuthorFindMany: vi.fn().mockResolvedValue([]),
  scholarFamilyFindMany: vi.fn().mockResolvedValue([]),
  publicationCitingFindUnique: vi.fn().mockResolvedValue(null),
  publicationCitingFindFirst: vi.fn().mockResolvedValue(null),
  familySuppressionOverlayFindMany: vi.fn().mockResolvedValue([]),
  familySensitivityOverlayFindMany: vi.fn().mockResolvedValue([]),
  withReciterConnection: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { findUnique: mocks.publicationFindUnique },
    subtopic: { findMany: mocks.subtopicFindMany },
    suppression: { findMany: mocks.suppressionFindMany },
    publicationAuthor: { findMany: mocks.publicationAuthorFindMany },
    scholarFamily: { findMany: mocks.scholarFamilyFindMany },
    publicationCiting: {
      findUnique: mocks.publicationCitingFindUnique,
      findFirst: mocks.publicationCitingFindFirst,
    },
    familySuppressionOverlay: { findMany: mocks.familySuppressionOverlayFindMany },
    familySensitivityOverlay: { findMany: mocks.familySensitivityOverlayFindMany },
  },
}));

vi.mock("@/lib/sources/reciterdb", () => ({
  withReciterConnection: mocks.withReciterConnection,
}));

import {
  encodeCsvField,
  getCitingPublicationsForCsv,
  getPublicationDetail,
  serializeCitingPubsCsv,
} from "@/lib/api/publication-detail";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subtopicFindMany.mockResolvedValue([]);
  mocks.suppressionFindMany.mockResolvedValue([]);
  mocks.publicationAuthorFindMany.mockResolvedValue([]);
  mocks.scholarFamilyFindMany.mockResolvedValue([]);
  mocks.publicationCitingFindUnique.mockResolvedValue(null);
  mocks.publicationCitingFindFirst.mockResolvedValue(null);
  mocks.familySuppressionOverlayFindMany.mockResolvedValue([]);
  mocks.familySensitivityOverlayFindMany.mockResolvedValue([]);
  delete process.env.METHODS_LENS_ENABLED;
  delete process.env.METHODS_LENS_PUB_MODAL;
  delete process.env.METHODS_LENS_TOOL_CONTEXT;
  delete process.env.METHODS_LENS_PAGES;
  delete process.env.METHODS_LENS_SENSITIVE_GATE;
  delete process.env.PUBLICATION_CITING_BRIDGE;
  mocks.withReciterConnection.mockImplementation(
    async (fn: (conn: unknown) => Promise<unknown>) => {
      const conn = {
        query: vi.fn().mockResolvedValue([]),
      };
      return fn(conn);
    },
  );
});

describe("getPublicationDetail — pmid validation", () => {
  it("returns null for non-numeric pmid", async () => {
    const r = await getPublicationDetail("abc123");
    expect(r).toBeNull();
    expect(mocks.publicationFindUnique).not.toHaveBeenCalled();
  });

  it("returns null for empty pmid", async () => {
    const r = await getPublicationDetail("");
    expect(r).toBeNull();
  });

  it("returns null for zero pmid", async () => {
    const r = await getPublicationDetail("0");
    expect(r).toBeNull();
  });

  it("returns null when publication not found", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(null);
    const r = await getPublicationDetail("12345");
    expect(r).toBeNull();
  });
});

describe("getPublicationDetail — publication suppression (#356)", () => {
  it("returns null for a whole-publication takedown", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce({
      pmid: "12345",
      publicationTopics: [],
    });
    mocks.suppressionFindMany.mockResolvedValueOnce([
      { entityId: "12345", contributorCwid: null },
    ]);
    expect(await getPublicationDetail("12345")).toBeNull();
  });
});

describe("getPublicationDetail — topic collapse", () => {
  function basePub(overrides?: Partial<Record<string, unknown>>) {
    return {
      pmid: "12345",
      title: "Test paper",
      journal: "J. Test",
      year: 2024,
      volume: "1",
      issue: "2",
      pages: "10-20",
      fullAuthorsString: "Smith A, Jones B",
      abstract: "An abstract.",
      impactScore: 75,
      impactJustification: "Novel.",
      citationCount: 42,
      pmcid: null,
      doi: null,
      pubmedUrl: null,
      meshTerms: [],
      synopsis: null, // #329 — now read directly off Publication.
      publicationTopics: [],
      ...overrides,
    };
  }

  it("collapses (cwid, parent_topic) rows to one per topic by MAX(score)", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({
        publicationTopics: [
          {
            parentTopicId: "oncology",
            score: 0.6,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            topic: { id: "oncology", label: "Oncology" },
          },
          {
            parentTopicId: "oncology",
            score: 0.9,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            topic: { id: "oncology", label: "Oncology" },
          },
          {
            parentTopicId: "immunology",
            score: 0.5,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            topic: { id: "immunology", label: "Immunology" },
          },
        ],
      }),
    );
    const r = await getPublicationDetail("12345");
    expect(r?.topics.length).toBe(2);
    const oncology = r?.topics.find((t) => t.topicSlug === "oncology");
    expect(oncology?.score).toBeCloseTo(0.9, 5);
    // Sorted by score desc.
    expect(r?.topics[0].topicSlug).toBe("oncology");
    expect(r?.topics[1].topicSlug).toBe("immunology");
  });

  it("reads synopsis directly off Publication.synopsis (#329)", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({ synopsis: "Per-pmid plain-language summary." }),
    );
    const r = await getPublicationDetail("12345");
    expect(r?.pub.synopsis).toBe("Per-pmid plain-language summary.");
  });

  it("returns null synopsis when Publication.synopsis is null", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(basePub());
    const r = await getPublicationDetail("12345");
    expect(r?.pub.synopsis).toBeNull();
  });

  it("treats empty-string synopsis as null", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(basePub({ synopsis: "" }));
    const r = await getPublicationDetail("12345");
    expect(r?.pub.synopsis).toBeNull();
  });

  it("resolves subtopics to display names and sorts primary → confidence", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({
        publicationTopics: [
          {
            parentTopicId: "onc",
            score: 0.9,
            primarySubtopicId: "onc_breast",
            subtopicIds: ["onc_breast", "onc_lung", "onc_skin"],
            subtopicConfidences: { onc_lung: 0.8, onc_breast: 0.4, onc_skin: 0.6 },
            topic: { id: "onc", label: "Oncology" },
          },
        ],
      }),
    );
    mocks.subtopicFindMany.mockResolvedValueOnce([
      { id: "onc_breast", label: "Breast", displayName: "Breast Cancer" },
      { id: "onc_lung", label: "Lung", displayName: null },
      { id: "onc_skin", label: "Skin", displayName: "Skin Cancer" },
    ]);
    const r = await getPublicationDetail("12345");
    const subs = r?.topics[0].subtopics ?? [];
    expect(subs.map((s) => s.slug)).toEqual([
      "onc_breast", // primary first
      "onc_lung", // confidence 0.8
      "onc_skin", // confidence 0.6
    ]);
    expect(subs[1].name).toBe("Lung"); // falls back to label when displayName null
    expect(subs[0].name).toBe("Breast Cancer");
  });

  it("normalizes empty abstract / impactJustification to null", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({ abstract: "", impactJustification: "" }),
    );
    const r = await getPublicationDetail("12345");
    expect(r?.pub.abstract).toBeNull();
    expect(r?.pub.impactJustification).toBeNull();
  });

  it("surfaces Publication.citationCount as the canonical cited-by total", async () => {
    // pub.citationCount carries the Scopus-broad count from
    // analysis_summary_article.citationCountScopus and is the headline number
    // for "Cited by N". It is distinct from citingPubsTotal (the iCite
    // subset reciterdb tracks for citing-link display) — for many papers
    // citationCount >> citingPubsTotal.
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({ citationCount: 197 }),
    );
    const r = await getPublicationDetail("12345");
    expect(r?.pub.citationCount).toBe(197);
  });
});

describe("getPublicationDetail — citing publications", () => {
  function emptyPub() {
    return {
      pmid: "12345",
      title: "Test paper",
      journal: null,
      year: 2024,
      volume: null,
      issue: null,
      pages: null,
      fullAuthorsString: null,
      abstract: null,
      impactScore: null,
      impactJustification: null,
      citationCount: 0,
      pmcid: null,
      doi: null,
      pubmedUrl: null,
      meshTerms: [],
      publicationTopics: [],
    };
  }

  it("returns citing pubs ordered as reciterdb returned them", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(emptyPub());
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce([{ n: 3 }]) // COUNT(DISTINCT citing_pmid)
      .mockResolvedValueOnce([
        { pmid: 100, title: "Newest", journal: "J1", year: 2024 },
        { pmid: 200, title: "Older", journal: "J2", year: 2022 },
        { pmid: 300, title: "Oldest", journal: null, year: null },
      ]);
    mocks.withReciterConnection.mockImplementationOnce(
      async (fn: (conn: unknown) => Promise<unknown>) => {
        return fn({ query: queryMock });
      },
    );
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs?.length).toBe(3);
    expect(r?.citingPubs?.[0].pmid).toBe("100");
    expect(r?.citingPubs?.[2].pmid).toBe("300");
    expect(r?.citingPubsTotal).toBe(3);
    // Confirms COUNT then SELECT, and that the SELECT was issued with the
    // expected ORDER BY clause (substring check; full SQL is stable).
    const selectCall = queryMock.mock.calls[1];
    expect(selectCall[0]).toMatch(
      /ORDER BY a\.publicationDateStandardized DESC, a\.pmid DESC/,
    );
    expect(selectCall[1]).toEqual([12345, 500]);
  });

  it("collapses duplicate (cited, citing) pairs via the DISTINCT-citing subquery (#1041)", async () => {
    // analysis_nih_cites holds dup (cited_pmid, citing_pmid) pairs; the count
    // query is COUNT(DISTINCT citing_pmid) and the list query pre-dedupes the
    // citing pmid in a subquery before the join, so each citer appears once.
    mocks.publicationFindUnique.mockResolvedValueOnce(emptyPub());
    const queryMock = vi
      .fn()
      .mockResolvedValueOnce([{ n: 2 }]) // distinct count, not the inflated COUNT(*)
      .mockResolvedValueOnce([
        { pmid: 100, title: "First", journal: "J1", year: 2024 },
        { pmid: 200, title: "Second", journal: "J2", year: 2022 },
      ]);
    mocks.withReciterConnection.mockImplementationOnce(
      async (fn: (conn: unknown) => Promise<unknown>) => fn({ query: queryMock }),
    );
    const r = await getPublicationDetail("12345");
    const pmids = r?.citingPubs?.map((p) => p.pmid) ?? [];
    expect(new Set(pmids).size).toBe(pmids.length); // all unique
    expect(r?.citingPubsTotal).toBe(2);
    // Count query dedupes citing_pmid; list query collapses dups pre-join.
    expect(queryMock.mock.calls[0][0]).toMatch(/COUNT\(DISTINCT citing_pmid\)/);
    expect(queryMock.mock.calls[1][0]).toMatch(
      /SELECT DISTINCT citing_pmid FROM analysis_nih_cites WHERE cited_pmid = \?/,
    );
  });

  it("returns empty array + total 0 when reciterdb has no rows", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(emptyPub());
    mocks.withReciterConnection.mockImplementationOnce(
      async (fn: (conn: unknown) => Promise<unknown>) => {
        return fn({
          query: vi
            .fn()
            .mockResolvedValueOnce([{ n: 0 }])
            .mockResolvedValueOnce([]),
        });
      },
    );
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs).toEqual([]);
    expect(r?.citingPubsTotal).toBe(0);
  });

  it("returns citingPubs=null when reciterdb throws", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(emptyPub());
    mocks.withReciterConnection.mockImplementationOnce(async () => {
      throw new Error("reciterdb unreachable");
    });
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs).toBeNull();
    expect(r?.citingPubsTotal).toBeNull();
    // Pub still returned despite the reciterdb failure.
    expect(r?.pub.pmid).toBe("12345");
  });

  it("converts bigint pmids from MariaDB to strings", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(emptyPub());
    mocks.withReciterConnection.mockImplementationOnce(
      async (fn: (conn: unknown) => Promise<unknown>) => {
        return fn({
          query: vi
            .fn()
            .mockResolvedValueOnce([{ n: BigInt(1) }])
            .mockResolvedValueOnce([
              { pmid: BigInt(999), title: "X", journal: null, year: 2024 },
            ]),
        });
      },
    );
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs?.[0].pmid).toBe("999");
    expect(r?.citingPubsTotal).toBe(1);
  });
});

function pubForMethods() {
  return {
    pmid: "12345",
    title: "Test paper",
    journal: null,
    year: 2024,
    volume: null,
    issue: null,
    pages: null,
    fullAuthorsString: null,
    abstract: null,
    impactScore: null,
    impactJustification: null,
    citationCount: 0,
    pmcid: null,
    doi: null,
    pubmedUrl: null,
    meshTerms: [],
    synopsis: null,
    publicationTopics: [],
  };
}

describe("getPublicationDetail — method families (#917)", () => {
  it("returns [] when the Methods lens master flag is off (no DB scan)", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies).toEqual([]);
    expect(mocks.scholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("de-dupes a family by (supercategory, familyLabel) across multiple WCM authors", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    process.env.METHODS_LENS_PAGES = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([
      { cwid: "aaa1001" },
      { cwid: "bbb2002" },
    ]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      // Same family, two different authors + familyIds — must collapse to one.
      {
        supercategory: "animal_cell_models",
        familyLabel: "CRISPR knockout",
        familyId: "fam_0042",
        pmids: ["12345", "999"],
      },
      {
        supercategory: "animal_cell_models",
        familyLabel: "CRISPR knockout",
        familyId: "fam_9999",
        pmids: ["12345"],
      },
      // A second distinct family attributed to this pmid.
      {
        supercategory: "imaging",
        familyLabel: "Two-photon microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
      },
      // A family that does NOT include this pmid — excluded.
      {
        supercategory: "sequencing",
        familyLabel: "Bulk RNA-seq",
        familyId: "fam_0200",
        pmids: ["55555"],
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies.map((f) => f.familyLabel)).toEqual([
      "CRISPR knockout", // animal_cell_models sorts before imaging
      "Two-photon microscopy",
    ]);
    // href built off the FIRST familyId seen for the (sc,label) key.
    expect(r?.methodFamilies[0].href).toBe(
      "/methods/animal-cell-models/crispr-knockout-fam_0042",
    );
  });

  it("excludes a #800-suppressed family even when the pmid matches", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    process.env.METHODS_LENS_PAGES = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "animal_cell_models",
        familyLabel: "Gain-of-function virology",
        familyId: "fam_0042",
        pmids: ["12345"],
      },
    ]);
    mocks.familySuppressionOverlayFindMany.mockResolvedValueOnce([
      { supercategory: "animal_cell_models", familyLabel: "Gain-of-function virology" },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies).toEqual([]);
  });

  it("nulls the href when the Method pages surface is off", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    // METHODS_LENS_PAGES intentionally unset.
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Two-photon microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies).toEqual([
      {
        supercategory: "imaging",
        familyLabel: "Two-photon microscopy",
        href: null,
        tools: [],
      },
    ]);
  });

  it("returns [] when the paper has no confirmed WCM authors", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies).toEqual([]);
    expect(mocks.scholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("returns [] when METHODS_LENS_PUB_MODAL is off even with the master lens on (#917 independent gate)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    // METHODS_LENS_PUB_MODAL intentionally unset → the modal section is dark
    // independently of the rest of the lens; no DB scan.
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies).toEqual([]);
    expect(mocks.scholarFamilyFindMany).not.toHaveBeenCalled();
  });

  it("surfaces a family's exemplar tools with #1119 snippets when the tool-context flag is on (#917 Phase 2)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    process.env.METHODS_LENS_TOOL_CONTEXT = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Confocal microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
        // Salience-ordered array; the contexts OBJECT key order is unreliable, so
        // the snippet must be looked up by name off the array order.
        exemplarTools: ["STORK-A", "CheXpert"],
        exemplarContexts: {
          CheXpert: "a labeler for chest radiograph findings",
          "STORK-A": "a non-invasive automated method of embryo evaluation",
        },
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies[0].tools).toEqual([
      {
        name: "STORK-A",
        context: "a non-invasive automated method of embryo evaluation",
        sourcePmid: null, // fixture carries no exemplarContextPmids (pre-#1158 row)
      },
      {
        name: "CheXpert",
        context: "a labeler for chest radiograph findings",
        sourcePmid: null,
      },
    ]);
  });

  it("carries each snippet's source pmid from exemplarContextPmids, gated with the snippet (#1158)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    process.env.METHODS_LENS_TOOL_CONTEXT = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Confocal microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
        exemplarTools: ["STORK-A", "CheXpert"],
        exemplarContexts: {
          "STORK-A": "a non-invasive automated method of embryo evaluation",
          CheXpert: "a labeler for chest radiograph findings",
        },
        // 1:1 with exemplarContexts by display name; one matches the viewed pmid.
        exemplarContextPmids: { "STORK-A": "12345", CheXpert: "33144353" },
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies[0].tools).toEqual([
      {
        name: "STORK-A",
        context: "a non-invasive automated method of embryo evaluation",
        sourcePmid: "12345",
      },
      {
        name: "CheXpert",
        context: "a labeler for chest radiograph findings",
        sourcePmid: "33144353",
      },
    ]);
  });

  it("drops the source pmid when the tool-context flag is off (no orphan link without a snippet) (#1158)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    // METHODS_LENS_TOOL_CONTEXT intentionally unset → snippet AND source pmid dark.
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Confocal microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
        exemplarTools: ["STORK-A"],
        exemplarContexts: { "STORK-A": "a non-invasive automated method" },
        exemplarContextPmids: { "STORK-A": "12345" },
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies[0].tools).toEqual([
      { name: "STORK-A", context: null, sourcePmid: null },
    ]);
  });

  it("emits tool names with null context when the tool-context flag is off (names are part of the #917 surface)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    // METHODS_LENS_TOOL_CONTEXT intentionally unset → names render, snippets dark.
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Confocal microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
        exemplarTools: ["STORK-A"],
        exemplarContexts: { "STORK-A": "a non-invasive automated method" },
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies[0].tools).toEqual([
      { name: "STORK-A", context: null, sourcePmid: null },
    ]);
  });

  it("yields no tools for a family with no exemplar tools (chip-only, as in Phase 1)", async () => {
    process.env.METHODS_LENS_ENABLED = "on";
    process.env.METHODS_LENS_PUB_MODAL = "on";
    process.env.METHODS_LENS_TOOL_CONTEXT = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(pubForMethods());
    mocks.publicationAuthorFindMany.mockResolvedValue([{ cwid: "aaa1001" }]);
    mocks.scholarFamilyFindMany.mockResolvedValueOnce([
      {
        supercategory: "imaging",
        familyLabel: "Two-photon microscopy",
        familyId: "fam_0100",
        pmids: ["12345"],
        exemplarTools: [],
        exemplarContexts: {},
      },
    ]);
    const r = await getPublicationDetail("12345");
    expect(r?.methodFamilies[0].tools).toEqual([]);
  });
});

describe("getPublicationDetail — citing bridge (#928)", () => {
  function bridgePub() {
    return { ...pubForMethods(), citationCount: 100 };
  }

  it("serves the bridge row (total + ≤500 list) and does NOT hit reciterdb", async () => {
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(bridgePub());
    mocks.publicationCitingFindUnique.mockResolvedValueOnce({
      total: 7,
      citingPubs: [
        { pmid: 999, title: "Newest", journal: "J1", year: 2025 },
        { pmid: 888, title: "Older", journal: null, year: 2024 },
      ],
    });
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubsTotal).toBe(7);
    expect(r?.citingPubs).toEqual([
      { pmid: "999", title: "Newest", journal: "J1", year: 2025 },
      { pmid: "888", title: "Older", journal: null, year: 2024 },
    ]);
    expect(mocks.withReciterConnection).not.toHaveBeenCalled();
  });

  it("dedupes duplicate citing pmids in the stored bridge JSON (#1041)", async () => {
    // A bridge row written before the export dedupe fix can carry the same
    // citing pmid twice; parseBridgedCitingPubs collapses it (first wins).
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(bridgePub());
    mocks.publicationCitingFindUnique.mockResolvedValueOnce({
      total: 2,
      citingPubs: [
        { pmid: 999, title: "Newest", journal: "J1", year: 2025 },
        { pmid: 999, title: "Dup", journal: "J1", year: 2025 },
        { pmid: 888, title: "Older", journal: null, year: 2024 },
      ],
    });
    const r = await getPublicationDetail("12345");
    const pmids = r?.citingPubs?.map((p) => p.pmid) ?? [];
    expect(new Set(pmids).size).toBe(pmids.length); // all unique
    expect(pmids).toEqual(["999", "888"]); // first occurrence wins, order kept
  });

  it("degrades to null/null when the bridge table is empty (un-imported)", async () => {
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(bridgePub());
    mocks.publicationCitingFindUnique.mockResolvedValueOnce(null);
    mocks.publicationCitingFindFirst.mockResolvedValueOnce(null); // table empty
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs).toBeNull();
    expect(r?.citingPubsTotal).toBeNull();
  });

  it("returns a genuine zero when the pmid is absent but the table is populated", async () => {
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationFindUnique.mockResolvedValueOnce(bridgePub());
    mocks.publicationCitingFindUnique.mockResolvedValueOnce(null);
    mocks.publicationCitingFindFirst.mockResolvedValueOnce({ pmid: 1 }); // has rows
    const r = await getPublicationDetail("12345");
    expect(r?.citingPubs).toEqual([]);
    expect(r?.citingPubsTotal).toBe(0);
  });

  it("CSV: serves the bridged list (publicationDate dropped) when the flag is on", async () => {
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationCitingFindUnique.mockResolvedValueOnce({
      citingPubs: [{ pmid: 999, title: "X", journal: "J", year: 2024 }],
    });
    const r = await getCitingPublicationsForCsv("12345");
    expect(r).toEqual([
      { pmid: "999", title: "X", journal: "J", year: 2024, publicationDate: null },
    ]);
    expect(mocks.withReciterConnection).not.toHaveBeenCalled();
  });

  it("CSV: returns [] (not a throw) when the bridge has no row for the pmid", async () => {
    process.env.PUBLICATION_CITING_BRIDGE = "on";
    mocks.publicationCitingFindUnique.mockResolvedValueOnce(null);
    const r = await getCitingPublicationsForCsv("12345");
    expect(r).toEqual([]);
  });
});

describe("encodeCsvField", () => {
  it("returns plain values unchanged", () => {
    expect(encodeCsvField("hello")).toBe("hello");
    expect(encodeCsvField(42)).toBe("42");
  });

  it("quotes fields containing commas, quotes, or newlines (RFC 4180)", () => {
    expect(encodeCsvField("a,b")).toBe('"a,b"');
    expect(encodeCsvField('with "quotes"')).toBe('"with ""quotes"""');
    expect(encodeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(encodeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("returns empty string for null/undefined", () => {
    expect(encodeCsvField(null)).toBe("");
    expect(encodeCsvField(undefined)).toBe("");
  });
});

describe("serializeCitingPubsCsv", () => {
  it("emits a header row and CRLF-terminated lines", () => {
    const csv = serializeCitingPubsCsv([
      {
        pmid: "100",
        title: "Title One",
        journal: "J1",
        year: 2024,
        publicationDate: "2024-01-15",
      },
      {
        pmid: "200",
        title: "Title, with comma",
        journal: null,
        year: null,
        publicationDate: null,
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("PMID,Title,Journal,Year,Publication date");
    expect(lines[1]).toBe("100,Title One,J1,2024,2024-01-15");
    expect(lines[2]).toBe('200,"Title, with comma",,,');
    // Trailing CRLF after the last row.
    expect(lines[3]).toBe("");
  });

  it("handles an empty row list (header-only export)", () => {
    const csv = serializeCitingPubsCsv([]);
    expect(csv).toBe("PMID,Title,Journal,Year,Publication date\r\n");
  });
});

describe("getCitingPublicationsForCsv", () => {
  it("returns null for invalid pmid", async () => {
    const r = await getCitingPublicationsForCsv("garbage");
    expect(r).toBeNull();
    expect(mocks.withReciterConnection).not.toHaveBeenCalled();
  });

  it("queries with a higher cap than the inline endpoint and includes publicationDate", async () => {
    const queryMock = vi.fn().mockResolvedValueOnce([
      {
        pmid: 1,
        title: "T",
        journal: "J",
        year: 2024,
        publicationDate: "2024-01-01",
      },
    ]);
    mocks.withReciterConnection.mockImplementationOnce(
      async (fn: (conn: unknown) => Promise<unknown>) => fn({ query: queryMock }),
    );
    const r = await getCitingPublicationsForCsv("12345");
    expect(r).toEqual([
      {
        pmid: "1",
        title: "T",
        journal: "J",
        year: 2024,
        publicationDate: "2024-01-01",
      },
    ]);
    // CSV cap must be much larger than the inline 500.
    const params = queryMock.mock.calls[0][1] as [number, number];
    expect(params[0]).toBe(12345);
    expect(params[1]).toBeGreaterThanOrEqual(10_000);
  });

  it("throws (does not soft-fail) when reciterdb is unavailable so the route can return 502", async () => {
    mocks.withReciterConnection.mockImplementationOnce(async () => {
      throw new Error("reciterdb down");
    });
    await expect(getCitingPublicationsForCsv("12345")).rejects.toThrow();
  });
});
