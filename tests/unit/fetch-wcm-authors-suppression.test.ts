import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPublicationAuthorFindMany, mockSuppressionFindMany } = vi.hoisted(() => ({
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

import { fetchWcmAuthorsForPmids } from "@/lib/api/topics";

/** A confirmed publication_author row in the shape fetchWcmAuthorsForPmids selects. */
function authorRow(
  pmid: string,
  cwid: string,
  name: string,
  opts: { isFirst?: boolean; isLast?: boolean } = {},
) {
  return {
    pmid,
    isFirst: opts.isFirst ?? false,
    isLast: opts.isLast ?? false,
    scholar: { cwid, slug: `${cwid}-slug`, preferredName: name },
  };
}

beforeEach(() => {
  mockPublicationAuthorFindMany.mockReset();
  mockSuppressionFindMany.mockReset();
});

describe("fetchWcmAuthorsForPmids — publication suppression", () => {
  it("omits a per-author-hidden scholar from the chip list, keeping co-authors", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First", { isFirst: true }),
      authorRow("100", "bbb2222", "Ben Last", { isLast: true }),
    ]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "100", contributorCwid: "aaa1111" }, // Ada hid pmid 100
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["bbb2222"]);
  });

  it("returns all confirmed authors when there is no suppression", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("200", "aaa1111", "Ada First", { isFirst: true }),
      authorRow("200", "bbb2222", "Ben Last", { isLast: true }),
    ]);
    mockSuppressionFindMany.mockResolvedValue([]);
    const byPmid = await fetchWcmAuthorsForPmids(["200"]);
    expect((byPmid.get("200") ?? []).map((c) => c.cwid)).toEqual(["aaa1111", "bbb2222"]);
  });

  it("leaves no map entry for a publication whose every author is hidden", async () => {
    mockPublicationAuthorFindMany.mockResolvedValue([authorRow("300", "aaa1111", "Ada First")]);
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "300", contributorCwid: "aaa1111" }]);
    const byPmid = await fetchWcmAuthorsForPmids(["300"]);
    expect(byPmid.get("300")).toBeUndefined();
  });
});
