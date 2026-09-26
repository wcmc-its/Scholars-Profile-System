/**
 * Phase 4 — the category-wide "All families" set (`getSupercategoryAllWork`)
 * and its paged feed (`getSupercategoryPublications`).
 *
 * Gating the route inherits from the loader:
 *   - #800 suppressed family ⇒ none of its pmids;
 *   - #536 hidden roles ⇒ excluded by the query denylist AND by the fail-closed
 *     check on the raw column (an out-of-band `doctoral_student_*` suffix the
 *     denylist cannot name);
 *   - inactive / deleted scholars ⇒ excluded in the query;
 *   - #356 dark pubs ⇒ removed;
 *   - master lens off ⇒ nothing, no DB read.
 * Plus the in-process sort / type filter / paging and the per-row family label.
 *
 * Fake cwids and labels only (public repo).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sfFindMany: vi.fn(),
  pubFindMany: vi.fn(),
  suppressionOverlay: vi.fn(),
  lensOn: vi.fn(),
  dark: new Set<string>(),
  authors: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: h.sfFindMany, groupBy: vi.fn() },
    publication: { findMany: h.pubFindMany, count: vi.fn() },
    familySuppressionOverlay: { findMany: h.suppressionOverlay },
    familySensitivityOverlay: { findMany: async () => [] },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodsLensEnabled: () => h.lensOn(),
  isMethodsLensSensitiveGateOn: () => false,
  isMethodPagesEnabled: () => true,
  isMethodsLensEntityLayerOn: () => false,
  isMethodsLensToolContextOn: () => false,
  isMethodsFamilyRosterFallbackOn: () => false,
}));
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: async () => ({}),
  resolveDarkPmids: async (pmids: string[]) => new Set(pmids.filter((p) => h.dark.has(p))),
  loadHiddenAuthorshipCounts: async () => new Map(),
}));
vi.mock("@/lib/api/topics", () => ({
  fetchWcmAuthorsForPmids: (...a: unknown[]) => h.authors(...a),
}));

import {
  getSupercategoryAllWork,
  getSupercategoryPublications,
  pageAllWork,
  type AllWorkEntry,
} from "@/lib/api/methods";

const SC = "reagents";
type Pub = {
  pmid: string;
  year: number;
  dateAddedToEntrez: Date | null;
  citationCount: number | null;
  impactScore: number | null;
  publicationType: string | null;
};
let pubs: Pub[] = [];

const row = (familyLabel: string, pmids: string[], roleCategory: string | null = "full_time_faculty") => ({
  familyLabel,
  pmids,
  scholar: { roleCategory },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.lensOn.mockReturnValue(true);
  h.dark = new Set();
  h.suppressionOverlay.mockResolvedValue([]);
  h.authors.mockResolvedValue(new Map());
  pubs = [];
  h.pubFindMany.mockImplementation(async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
    if (Array.isArray(args.where.NOT)) return [];
    const inList = (args.where.pmid as { in: string[] }).in;
    const found = pubs.filter((p) => inList.includes(p.pmid));
    if (args.select.title) {
      return found.map((p) => ({
        ...p,
        title: `Paper ${p.pmid}`,
        journal: null,
        pubmedUrl: null,
        doi: null,
        pmcid: null,
      }));
    }
    return found;
  });
});

const pub = (pmid: string, over: Partial<Pub> = {}): Pub => ({
  pmid,
  year: 2020,
  dateAddedToEntrez: null,
  citationCount: null,
  impactScore: null,
  publicationType: "Academic Article",
  ...over,
});

describe("getSupercategoryAllWork gating", () => {
  it("queries active, public-role scholars only", async () => {
    h.sfFindMany.mockResolvedValue([]);
    await getSupercategoryAllWork(SC);
    const where = h.sfFindMany.mock.calls[0][0].where;
    expect(where.supercategory).toBe(SC);
    expect(where.scholar).toMatchObject({ deletedAt: null, status: "active" });
    expect(where.scholar.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ roleCategory: null })]),
    );
    expect(h.sfFindMany.mock.calls[0][0].select.scholar).toEqual({ select: { roleCategory: true } });
  });

  it("drops suppressed families, hidden roles (fail-closed on a suffix), and dark pubs", async () => {
    h.suppressionOverlay.mockResolvedValue([{ supercategory: SC, familyLabel: "Secret" }]);
    h.sfFindMany.mockResolvedValue([
      row("CRISPR", ["1", "2"]),
      row("Secret", ["3"]),
      // Admitted by the denylist (an unlisted suffix), rejected by isPubliclyDisplayed.
      row("CRISPR", ["4"], "doctoral_student_dvm"),
      row("Antibodies", ["2", "5"], null),
    ]);
    h.dark = new Set(["5"]);
    pubs = ["1", "2", "3", "4", "5"].map((p) => pub(p));
    const out = await getSupercategoryAllWork(SC);
    expect(out.entries.map((e) => e.pmid).sort()).toEqual(["1", "2"]);
    expect(out.researchCount).toBe(2);
    // Only the surviving pmids ever reach the publication query.
    const asked = h.pubFindMany.mock.calls[0][0].where.pmid.in as string[];
    expect(asked.sort()).toEqual(["1", "2"]);
  });

  it("counts research articles and every type separately (a NULL type is not research)", async () => {
    h.sfFindMany.mockResolvedValue([row("CRISPR", ["1", "2", "3"])]);
    pubs = [pub("1"), pub("2", { publicationType: "Letter" }), pub("3", { publicationType: null })];
    const out = await getSupercategoryAllWork(SC);
    expect(out.researchCount).toBe(1);
    expect(out.allTypesCount).toBe(3);
  });

  it("labels a multi-family pub with its biggest family (research count), ties A→Z", async () => {
    h.sfFindMany.mockResolvedValue([
      row("Flow", ["1", "9"]),
      row("CRISPR", ["1", "2", "3"]),
      row("Antibodies", ["9", "4", "5"]),
    ]);
    pubs = ["1", "2", "3", "4", "5", "9"].map((p) => pub(p));
    const out = await getSupercategoryAllWork(SC);
    const label = Object.fromEntries(out.entries.map((e) => [e.pmid, e.familyLabel]));
    expect(label["1"]).toBe("CRISPR"); // CRISPR 3 > Flow 2
    expect(label["9"]).toBe("Antibodies"); // Antibodies 3 > Flow 2
    expect(label["2"]).toBe("CRISPR");
  });

  it("returns nothing and reads nothing with the lens off", async () => {
    h.lensOn.mockReturnValue(false);
    const out = await getSupercategoryAllWork(SC);
    expect(out).toEqual({ entries: [], researchCount: 0, allTypesCount: 0 });
    expect(h.sfFindMany).not.toHaveBeenCalled();
    expect(await getSupercategoryPublications(SC, { sort: "newest" })).toBeNull();
  });
});

describe("pageAllWork", () => {
  const e = (pmid: string, over: Partial<AllWorkEntry> = {}): AllWorkEntry => ({
    pmid,
    year: 2020,
    added: null,
    citationCount: null,
    impactScore: null,
    research: true,
    familyLabel: "F",
    ...over,
  });
  const entries = [
    e("10", { year: 2024, added: 5, citationCount: 3, impactScore: 50 }),
    e("11", { year: 2024, added: 9, citationCount: null, impactScore: 90 }),
    e("12", { year: 2022, citationCount: 40, impactScore: null }),
    e("13", { year: 2025, research: false, citationCount: 7, impactScore: 70 }),
    e("9", { year: 2022, citationCount: 40 }),
  ];
  const order = (sort: "newest" | "most_cited" | "by_impact", filter: "research_articles_only" | "all" = "all") =>
    pageAllWork(entries, { sort, filter, page: 0, pageSize: 20 }).slice.map((x) => x.pmid);

  it("newest: year desc, then date added desc (nulls last), then pmid desc", () => {
    expect(order("newest")).toEqual(["13", "11", "10", "12", "9"]);
  });
  it("most cited: nulls last, pmid tiebreak (numeric)", () => {
    expect(order("most_cited")).toEqual(["12", "9", "13", "10", "11"]);
  });
  it("by impact: impact desc nulls last, then year", () => {
    expect(order("by_impact")).toEqual(["11", "13", "10", "12", "9"]);
  });
  it("research filter drops non-research rows and sets the total", () => {
    const r = pageAllWork(entries, { sort: "newest", filter: "research_articles_only", page: 0, pageSize: 2 });
    expect(r.total).toBe(4);
    expect(r.slice.map((x) => x.pmid)).toEqual(["11", "10"]);
    const p2 = pageAllWork(entries, { sort: "newest", filter: "research_articles_only", page: 1, pageSize: 2 });
    expect(p2.slice.map((x) => x.pmid)).toEqual(["12", "9"]);
  });
  it("does not mutate the cached entry array", () => {
    const before = entries.map((x) => x.pmid);
    order("most_cited");
    expect(entries.map((x) => x.pmid)).toEqual(before);
  });
});

describe("getSupercategoryPublications", () => {
  it("resolves only the page's rows, in sorted order, each with its family label", async () => {
    h.sfFindMany.mockResolvedValue([row("CRISPR", ["1", "2", "3"]), row("Flow", ["3"])]);
    pubs = [pub("1", { year: 2021 }), pub("2", { year: 2023 }), pub("3", { year: 2022, publicationType: "Letter" })];
    const r = (await getSupercategoryPublications(SC, { sort: "newest", page: 0, pageSize: 20 }))!;
    expect(r.hits.map((x) => [x.pmid, x.familyLabel])).toEqual([
      ["2", "CRISPR"],
      ["1", "CRISPR"],
    ]);
    expect(r.total).toBe(2);
    expect(r.totalResearchOnly).toBe(2);
    expect(r.totalAllTypes).toBe(3);
    const all = (await getSupercategoryPublications(SC, { sort: "newest", filter: "all" }))!;
    expect(all.total).toBe(3);
    expect(all.hits.map((x) => x.pmid)).toEqual(["2", "3", "1"]);
  });
});
