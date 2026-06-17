/**
 * #967 §7 — loadMethodExemplar / loadTopicExemplar gating guards (the two HIGH
 * findings from review):
 *   - SCHOLAR gate: the scholar_family query filters active, non-deleted scholars
 *     so a soft-deleted/suppressed scholar (rows survive soft-delete) can't leak;
 *   - PUBLICATION gate: ADR-005 dark / author-hidden pmids are dropped before the
 *     exemplar is picked (parity with the per-profile methods lens);
 *   - ownership reads CONFIRMED authorship only and feeds the rank.
 * Rep-papers disclosure — the loaders now return `{ pubs, total }` (up to 3
 * representative papers + the renderable-candidate total for "+N more"); the
 * null-equivalent empty result is `{ pubs: [], total: 0 }`.
 * Prisma + manual-layer are mocked so this stays a fast unit test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const scholarFamilyFindMany = vi.fn();
const publicationFindMany = vi.fn();
const publicationAuthorFindMany = vi.fn();
const publicationTopicFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: (...a: unknown[]) => scholarFamilyFindMany(...a) },
    publication: { findMany: (...a: unknown[]) => publicationFindMany(...a) },
    publicationAuthor: { findMany: (...a: unknown[]) => publicationAuthorFindMany(...a) },
    publicationTopic: { findMany: (...a: unknown[]) => publicationTopicFindMany(...a) },
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

import { loadMethodExemplar, loadTopicExemplar } from "@/lib/api/method-exemplar";

const EMPTY = { pubs: [], total: 0 };

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
  publicationTopicFindMany.mockResolvedValue([]);
});

describe("loadMethodExemplar — gating", () => {
  it("filters the scholar_family query to active, non-deleted scholars (hidden-scholar leak guard)", async () => {
    scholarFamilyFindMany.mockResolvedValue([]); // hidden scholar ⇒ no rows
    const r = await loadMethodExemplar("ghost", "Confocal microscopy");
    expect(r).toEqual(EMPTY);
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
    expect(r.pubs[0]?.pmid).toBe("1");
    expect(r.total).toBe(1);
    // Only the surviving pmid reaches the metadata query.
    expect(publicationFindMany.mock.calls[0][0].where.pmid.in).toEqual(["1"]);
  });

  it("returns up to 3 representative papers + the candidate total ('+N more' math)", async () => {
    scholarFamilyFindMany.mockResolvedValue([
      { supercategory: "x", familyLabel: "F", pmids: ["1", "2", "3", "4"] },
    ]);
    publicationFindMany.mockResolvedValue([
      pub({ pmid: "1", title: "P1", year: 2024 }),
      pub({ pmid: "2", title: "P2", year: 2023 }),
      pub({ pmid: "3", title: "P3", year: 2022 }),
      pub({ pmid: "4", title: "P4", year: 2021 }),
    ]);
    const r = await loadMethodExemplar("abc", "F");
    // top-3 by the rank (recency here), total = all 4 renderable candidates.
    expect(r.pubs.map((p) => p.pmid)).toEqual(["1", "2", "3"]);
    expect(r.total).toBe(4);
  });

  it("returns {pubs:[],total:0} when every candidate pmid is suppressed", async () => {
    scholarFamilyFindMany.mockResolvedValue([
      { supercategory: "x", familyLabel: "F", pmids: ["1", "2"] },
    ]);
    resolveDarkPmids.mockResolvedValue(new Set(["1", "2"]));
    const r = await loadMethodExemplar("abc", "F");
    expect(r).toEqual(EMPTY);
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
    expect(r.pubs[0]?.pmid).toBe("1");
    expect(publicationAuthorFindMany.mock.calls[0][0].where).toMatchObject({
      cwid: "abc",
      isConfirmed: true,
    });
  });

  it("returns {pubs:[],total:0} for a blank family or cwid without touching the DB", async () => {
    expect(await loadMethodExemplar("abc", "   ")).toEqual(EMPTY);
    expect(await loadMethodExemplar("", "F")).toEqual(EMPTY);
    expect(scholarFamilyFindMany).not.toHaveBeenCalled();
  });
});

describe("loadTopicExemplar — gating", () => {
  it("queries the scholar's pubs in the parent topic, active+non-deleted only", async () => {
    publicationTopicFindMany.mockResolvedValue([{ pmid: "1" }, { pmid: "2" }]);
    publicationFindMany.mockResolvedValue([pub({ pmid: "1", title: "Best topic paper", impactScore: 80 })]);

    const r = await loadTopicExemplar("abc", "single_cell_spatial_biology");
    expect(r.pubs[0]?.pmid).toBe("1");
    const where = publicationTopicFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      cwid: "abc",
      parentTopicId: "single_cell_spatial_biology",
      scholar: { deletedAt: null, status: "active" },
    });
  });

  it("applies the same publication-suppression gate before ranking", async () => {
    publicationTopicFindMany.mockResolvedValue([{ pmid: "1" }, { pmid: "2" }, { pmid: "3" }]);
    resolveDarkPmids.mockResolvedValue(new Set(["2"]));
    isAuthorHidden.mockImplementation((_s: unknown, pmid: string) => pmid === "3");
    publicationFindMany.mockResolvedValue([pub({ pmid: "1", title: "Safe" })]);

    const r = await loadTopicExemplar("abc", "t1");
    expect(r.pubs[0]?.pmid).toBe("1");
    expect(publicationFindMany.mock.calls[0][0].where.pmid.in).toEqual(["1"]);
  });

  it("returns {pubs:[],total:0} when the scholar has no pubs in the topic", async () => {
    publicationTopicFindMany.mockResolvedValue([]); // hidden scholar or no membership
    expect(await loadTopicExemplar("abc", "t1")).toEqual(EMPTY);
    expect(publicationFindMany).not.toHaveBeenCalled();
  });

  it("returns {pubs:[],total:0} for a blank topic or cwid without touching the DB", async () => {
    expect(await loadTopicExemplar("abc", "  ")).toEqual(EMPTY);
    expect(await loadTopicExemplar("", "t1")).toEqual(EMPTY);
    expect(publicationTopicFindMany).not.toHaveBeenCalled();
  });
});
