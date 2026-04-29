/**
 * Unit tests for the URL resolver. Uses a hand-rolled Prisma stub so these run
 * without a live database. Integration coverage against the seeded DB is
 * exercised by the Playwright E2E suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst: vi.fn() },
    slugHistory: { findUnique: vi.fn() },
    cwidAlias: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { resolveByCwidOrAlias, resolveBySlugOrHistory } from "@/lib/url-resolver";

const mockedPrisma = prisma as unknown as {
  scholar: { findFirst: ReturnType<typeof vi.fn> };
  slugHistory: { findUnique: ReturnType<typeof vi.fn> };
  cwidAlias: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  mockedPrisma.scholar.findFirst.mockReset();
  mockedPrisma.slugHistory.findUnique.mockReset();
  mockedPrisma.cwidAlias.findUnique.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveBySlugOrHistory", () => {
  it("returns 'found' for a current canonical slug on an active scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({ cwid: "jas2001", slug: "jane-smith" });
    const result = await resolveBySlugOrHistory("jane-smith");
    expect(result).toEqual({ type: "found", cwid: "jas2001", slug: "jane-smith" });
  });

  it("returns 'redirect' when the slug is in slug_history for an active scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "sarah-johnson", deletedAt: null, status: "active" },
    });
    const result = await resolveBySlugOrHistory("sarah-davies");
    expect(result).toEqual({ type: "redirect", targetSlug: "sarah-johnson" });
  });

  it("returns 'not-found' when slug_history points to a soft-deleted scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "robert-wilson", deletedAt: new Date(), status: "active" },
    });
    const result = await resolveBySlugOrHistory("rob-wilson");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' when slug_history points to a suppressed scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "x-y", deletedAt: null, status: "suppressed" },
    });
    const result = await resolveBySlugOrHistory("old-slug");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an unknown slug", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce(null);
    const result = await resolveBySlugOrHistory("nobody-here");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an empty slug without hitting the DB", async () => {
    const result = await resolveBySlugOrHistory("");
    expect(result).toEqual({ type: "not-found" });
    expect(mockedPrisma.scholar.findFirst).not.toHaveBeenCalled();
  });
});

describe("resolveByCwidOrAlias", () => {
  it("returns 'redirect' when an active scholar exists for the CWID", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({ cwid: "jas2001", slug: "jane-smith" });
    const result = await resolveByCwidOrAlias("jas2001");
    expect(result).toEqual({ type: "redirect", targetSlug: "jane-smith" });
  });

  it("returns 'redirect' when the CWID is in cwid_aliases", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce({
      current: { slug: "diana-patel", deletedAt: null, status: "active" },
    });
    const result = await resolveByCwidOrAlias("dpa1010");
    expect(result).toEqual({ type: "redirect", targetSlug: "diana-patel" });
  });

  it("returns 'not-found' when cwid_aliases points to a soft-deleted scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce({
      current: { slug: "x", deletedAt: new Date(), status: "active" },
    });
    const result = await resolveByCwidOrAlias("old1234");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an unknown CWID", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);
    const result = await resolveByCwidOrAlias("zzz9999");
    expect(result).toEqual({ type: "not-found" });
  });
});
