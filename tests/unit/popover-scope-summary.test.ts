/**
 * `summarizeScope` (taxonomy-card popover, PUBLIC endpoint): counts what the
 * page's feed shows by default — research articles only, taken-down / dark
 * papers dropped (#356) — and fetches only the two most recent rows.
 * Fake pmids / cwids only.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPubFindMany, mockAuthorFindMany, mockDark } = vi.hoisted(() => ({
  mockPubFindMany: vi.fn(),
  mockAuthorFindMany: vi.fn(),
  mockDark: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publication: { findMany: mockPubFindMany },
    publicationAuthor: { findMany: mockAuthorFindMany },
  },
}));
vi.mock("@/lib/api/manual-layer", () => ({
  loadHiddenAuthorshipCounts: vi.fn(),
  loadPublicationSuppressions: vi.fn(async () => ({})),
  resolveDarkPmids: (...a: unknown[]) => mockDark(...a),
}));

import { summarizeScope } from "@/lib/api/popover-context";
import { FEED_EXCLUDED_TYPES } from "@/lib/publication-types";

beforeEach(() => {
  vi.clearAllMocks();
  mockDark.mockResolvedValue(new Set(["3"]));
  mockAuthorFindMany.mockResolvedValue([{ pmid: "1" }]);
  mockPubFindMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.title
      ? [{ pmid: "5", title: "T5", journal: "J", year: 2025 }]
      : [{ pmid: "5" }, { pmid: "1" }, { pmid: "2" }],
  );
});

describe("summarizeScope", () => {
  it("drops dark pmids, filters to research types, fetches two recent rows", async () => {
    const out = await summarizeScope("aaa1111", ["1", "2", "3", "5"]);

    const countCall = mockPubFindMany.mock.calls.find((c) => !c[0].select.title)![0];
    expect(countCall.where.pmid.in).toEqual(["1", "2", "5"]);
    expect(countCall.where.publicationType).toEqual({ notIn: [...FEED_EXCLUDED_TYPES] });

    const recentCall = mockPubFindMany.mock.calls.find((c) => c[0].select.title)![0];
    expect(recentCall.where.pmid.in).toEqual(["5", "1"]);

    expect(mockAuthorFindMany.mock.calls[0][0].where.pmid.in).toEqual(["5", "1", "2"]);
    expect(out).toEqual({
      pubCount: 3,
      leadCount: 1,
      recent: [{ pmid: "5", title: "T5", journal: "J", year: 2025 }],
    });
  });

  it("nothing left after filtering ⇒ null", async () => {
    mockPubFindMany.mockResolvedValue([]);
    expect(await summarizeScope("aaa1111", ["3"])).toBeNull();
  });
});
