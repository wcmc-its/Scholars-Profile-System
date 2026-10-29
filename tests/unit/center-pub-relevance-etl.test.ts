/**
 * Step 5 of `etl/center-pub-relevance`: the affiliation lookup reads from the
 * primary (step 4 just wrote the rows) and takes the newest decisions first,
 * so rows PubMed never gives affiliations for cannot fill the take forever.
 */
import { describe, expect, it, vi } from "vitest";

const { findMany, updateMany, fetchFlags } = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  fetchFlags: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    write: { centerPublicationRelevance: { findMany, updateMany } },
    read: { centerPublicationRelevance: { findMany: vi.fn(() => []) } },
  },
  disconnect: vi.fn(),
}));
vi.mock("@/lib/edit/pubmed-affiliations", () => ({ fetchExternalAuthorFlags: fetchFlags }));

import { markExternalAuthors } from "@/etl/center-pub-relevance";

describe("markExternalAuthors", () => {
  it("reads candidates from the primary, newest decisions first, and writes the flags", async () => {
    findMany.mockResolvedValue([{ pmid: "1" }, { pmid: "2" }]);
    fetchFlags.mockResolvedValue(
      new Map([
        ["1", true],
        ["2", null],
      ]),
    );
    await markExternalAuthors();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { relevant: true, externalAuthor: null },
        orderBy: [{ inferredAt: "desc" }, { pmid: "asc" }],
      }),
    );
    expect(fetchFlags).toHaveBeenCalledWith(["1", "2"]);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { pmid: "1" },
      data: { externalAuthor: true },
    });
  });
});
