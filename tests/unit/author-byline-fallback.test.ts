import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPublicationAuthorFindMany,
  mockSuppressionFindMany,
  mockPublicationFindMany,
} = vi.hoisted(() => ({
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockPublicationFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    publication: { findMany: mockPublicationFindMany },
  },
}));

import { fetchAuthorBylineForPmids } from "@/lib/api/topics";

/** A confirmed WCM author row in the shape fetchAuthorBylineForPmids selects
 *  (no deletedAt/status filter — we classify on status here). */
function authorRow(pmid: string, status: "active" | "suppressed") {
  return { pmid, scholar: { status } };
}

beforeEach(() => {
  mockPublicationAuthorFindMany.mockReset();
  mockSuppressionFindMany.mockReset();
  mockPublicationFindMany.mockReset();
});

describe("fetchAuthorBylineForPmids — #718 suppression-safe byline", () => {
  it("returns nothing and hits no DB for an empty pmid list", async () => {
    const out = await fetchAuthorBylineForPmids([]);
    expect(out.size).toBe(0);
    expect(mockPublicationAuthorFindMany).not.toHaveBeenCalled();
    expect(mockSuppressionFindMany).not.toHaveBeenCalled();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("surfaces a byline for a departed (soft-deleted, status='active') sole author and strips (( )) markers", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([authorRow("100", "active")]);
    mockSuppressionFindMany.mockResolvedValue([]);
    mockPublicationFindMany.mockResolvedValue([
      { pmid: "100", authorsString: "((Mejia J)), Smith A, Doe B" },
    ]);
    const out = await fetchAuthorBylineForPmids(["100"]);
    expect(out.get("100")).toBe("Mejia J, Smith A, Doe B");
  });

  it("withholds the byline when a confirmed author is status='suppressed' (never reveal a suppressed scholar)", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([authorRow("200", "suppressed")]);
    mockSuppressionFindMany.mockResolvedValue([]);
    const out = await fetchAuthorBylineForPmids(["200"]);
    expect(out.get("200")).toBeUndefined();
    // Eligibility fails before the byline query — no leak path is even queried.
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("withholds the byline for an ADR-005 whole-publication takedown", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([authorRow("300", "active")]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "300", contributorCwid: null }, // whole-pub dark
    ]);
    const out = await fetchAuthorBylineForPmids(["300"]);
    expect(out.get("300")).toBeUndefined();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("withholds the byline when there is no confirmed WCM author (pure-external pub)", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([]); // none confirmed for 400
    mockSuppressionFindMany.mockResolvedValue([]);
    const out = await fetchAuthorBylineForPmids(["400"]);
    expect(out.get("400")).toBeUndefined();
    expect(mockPublicationFindMany).not.toHaveBeenCalled();
  });

  it("withholds the byline when authorsString is null (no fabricated line)", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([authorRow("500", "active")]);
    mockSuppressionFindMany.mockResolvedValue([]);
    mockPublicationFindMany.mockResolvedValue([{ pmid: "500", authorsString: null }]);
    const out = await fetchAuthorBylineForPmids(["500"]);
    expect(out.get("500")).toBeUndefined();
  });

  it("classifies a mixed page: byline only for the eligible pmid, none for the suppressed one", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("600", "active"), // eligible
      authorRow("700", "suppressed"), // withheld
    ]);
    mockSuppressionFindMany.mockResolvedValue([]);
    mockPublicationFindMany.mockResolvedValue([
      { pmid: "600", authorsString: "Lin Q, Wang Y" },
    ]);
    const out = await fetchAuthorBylineForPmids(["600", "700"]);
    expect(out.get("600")).toBe("Lin Q, Wang Y");
    expect(out.get("700")).toBeUndefined();
    // Only the eligible pmid is queried for its byline.
    expect(mockPublicationFindMany).toHaveBeenCalledWith({
      where: { pmid: { in: ["600"] } },
      select: { pmid: true, authorsString: true },
    });
  });
});
