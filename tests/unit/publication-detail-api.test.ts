/**
 * Tests for lib/api/publication-detail.ts (#288 PR-B).
 *
 * Coverage:
 *   - validates pmid format; returns null on garbage input
 *   - returns null when publication not found
 *   - collapses multi-author publication_topic rows by MAX(score)
 *   - resolves subtopics to display names
 *   - sorts topics by score desc; subtopics by primary → confidence
 *   - chooses MAX(synopsis) across rows for the #329-fallback path
 *   - returns citingPubs from reciterdb ordered by date desc
 *   - soft-fails citingPubs to null when reciterdb throws
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  publicationFindUnique: vi.fn(),
  subtopicFindMany: vi.fn().mockResolvedValue([]),
  withReciterConnection: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { findUnique: mocks.publicationFindUnique },
    subtopic: { findMany: mocks.subtopicFindMany },
  },
}));

vi.mock("@/lib/sources/reciterdb", () => ({
  withReciterConnection: mocks.withReciterConnection,
}));

import { getPublicationDetail } from "@/lib/api/publication-detail";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subtopicFindMany.mockResolvedValue([]);
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
      pmcid: null,
      doi: null,
      pubmedUrl: null,
      meshTerms: [],
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
            synopsis: null,
            topic: { id: "oncology", label: "Oncology" },
          },
          {
            parentTopicId: "oncology",
            score: 0.9,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            synopsis: null,
            topic: { id: "oncology", label: "Oncology" },
          },
          {
            parentTopicId: "immunology",
            score: 0.5,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            synopsis: null,
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

  it("collapses synopsis via MAX-style dedupe across rows (pre-#329)", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(
      basePub({
        publicationTopics: [
          {
            parentTopicId: "t1",
            score: 0.5,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            synopsis: "synopsis A",
            topic: { id: "t1", label: "T1" },
          },
          {
            parentTopicId: "t2",
            score: 0.4,
            primarySubtopicId: null,
            subtopicIds: [],
            subtopicConfidences: null,
            synopsis: "synopsis B",
            topic: { id: "t2", label: "T2" },
          },
        ],
      }),
    );
    const r = await getPublicationDetail("12345");
    // MAX(string) → "synopsis B"
    expect(r?.pub.synopsis).toBe("synopsis B");
  });

  it("returns null synopsis when no rows have one", async () => {
    mocks.publicationFindUnique.mockResolvedValueOnce(basePub());
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
            synopsis: null,
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
      .mockResolvedValueOnce([{ n: 3 }]) // COUNT(*)
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
