/**
 * #967 §7 — loadMethodExemplar gating guards (the two HIGH findings from review):
 *   - SCHOLAR gate: the scholar_family query filters active, non-deleted scholars
 *     so a soft-deleted/suppressed scholar (rows survive soft-delete) can't leak;
 *   - PUBLICATION gate: ADR-005 dark / author-hidden pmids are dropped before the
 *     exemplar is picked (parity with the per-profile methods lens);
 *   - ownership reads CONFIRMED authorship only and feeds the rank.
 * Prisma + manual-layer are mocked so this stays a fast unit test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const scholarFamilyFindMany = vi.fn();
const publicationFindMany = vi.fn();
const publicationAuthorFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: (...a: unknown[]) => scholarFamilyFindMany(...a) },
    publication: { findMany: (...a: unknown[]) => publicationFindMany(...a) },
    publicationAuthor: { findMany: (...a: unknown[]) => publicationAuthorFindMany(...a) },
  },
}));

const loadFamilyOverlayGate = vi.fn();
vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: (...a: unknown[]) => loadFamilyOverlayGate(...a),
  isFamilyPubliclyVisible: () => true,
}));

const loadPublicationSuppressions = vi.fn();
const resolveDarkPmids = vi.fn();
const isAuthorHidden = vi.fn();
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: (...a: unknown[]) => loadPublicationSuppressions(...a),
  resolveDarkPmids: (...a: unknown[]) => resolveDarkPmids(...a),
  isAuthorHidden: (...a: unknown[]) => isAuthorHidden(...a),
}));

import { loadMethodExemplar } from "@/lib/api/method-exemplar";

const pub = (over: Record<string, unknown>) => ({
  title: "Paper",
  year: 2020,
  publicationType: "Academic Article",
  impactScore: 10,
  citationCount: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  loadFamilyOverlayGate.mockResolvedValue({ suppressed: new Set(), sensitive: new Set() });
  loadPublicationSuppressions.mockResolvedValue({ darkPmids: new Set() });
  resolveDarkPmids.mockResolvedValue(new Set());
  isAuthorHidden.mockReturnValue(false);
  publicationAuthorFindMany.mockResolvedValue([]);
});

describe("loadMethodExemplar — gating", () => {
  it("filters the scholar_family query to active, non-deleted scholars (hidden-scholar leak guard)", async () => {
    scholarFamilyFindMany.mockResolvedValue([]); // hidden scholar ⇒ no rows
    const r = await loadMethodExemplar("ghost", "Confocal microscopy");
    expect(r).toBeNull();
    const where = scholarFamilyFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      cwid: "ghost",
      familyLabel: "Confocal microscopy",
      scholar: { deletedAt: null, status: "active" },
    });
    expect(publicationFindMany).not.toHaveBeenCalled();
  });

  it("drops dark and author-hidden pmids before ranking (ADR-005 manual-layer gate)", async () => {
    scholarFamilyFindMany.mockResolvedValue([
      { supercategory: "x", familyLabel: "F", pmids: ["1", "2", "3"] },
    ]);
    resolveDarkPmids.mockResolvedValue(new Set(["2"])); // sitewide / derived dark
    isAuthorHidden.mockImplementation((_s: unknown, pmid: string) => pmid === "3"); // self-hidden
    publicationFindMany.mockResolvedValue([pub({ pmid: "1", title: "Safe paper" })]);

    const r = await loadMethodExemplar("abc", "F");
    expect(r?.pmid).toBe("1");
    // Only the surviving pmid reaches the metadata query.
    expect(publicationFindMany.mock.calls[0][0].where.pmid.in).toEqual(["1"]);
  });

  it("returns null when every candidate pmid is suppressed", async () => {
    scholarFamilyFindMany.mockResolvedValue([
      { supercategory: "x", familyLabel: "F", pmids: ["1", "2"] },
    ]);
    resolveDarkPmids.mockResolvedValue(new Set(["1", "2"]));
    const r = await loadMethodExemplar("abc", "F");
    expect(r).toBeNull();
    expect(publicationFindMany).not.toHaveBeenCalled();
  });

  it("reads ownership from CONFIRMED authorship only, and ownership outranks higher impact", async () => {
    scholarFamilyFindMany.mockResolvedValue([
      { supercategory: "x", familyLabel: "F", pmids: ["1", "2"] },
    ]);
    publicationFindMany.mockResolvedValue([
      pub({ pmid: "1", title: "Owned, modest impact", impactScore: 10 }),
      pub({ pmid: "2", title: "Unowned, high impact", impactScore: 99 }),
    ]);
    publicationAuthorFindMany.mockResolvedValue([
      { pmid: "1", isFirst: true, isLast: false, totalAuthors: 5 },
    ]);

    const r = await loadMethodExemplar("abc", "F");
    // first/senior is a higher tier than impact, so the owned paper wins.
    expect(r?.pmid).toBe("1");
    expect(publicationAuthorFindMany.mock.calls[0][0].where).toMatchObject({
      cwid: "abc",
      isConfirmed: true,
    });
  });

  it("returns null for a blank family or cwid without touching the DB", async () => {
    expect(await loadMethodExemplar("abc", "   ")).toBeNull();
    expect(await loadMethodExemplar("", "F")).toBeNull();
    expect(scholarFamilyFindMany).not.toHaveBeenCalled();
  });
});
