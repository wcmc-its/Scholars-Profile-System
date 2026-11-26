/**
 * METHOD_SERVICES on the public method page's data path:
 *   - `getFamilyPublications`: flag off, the payload is exactly what it was
 *     (no `services`, no `serviceIds`, no extra query); flag on, each visible
 *     service gets its count and each hit its service ids, and `serviceId`
 *     narrows the feed to that unit's collaborations;
 *   - `getFamilyServices`: the block's entries;
 *   - the feed route's `service` param.
 * DB mocked; made-up units, people and PMIDs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  scholarFamilyFindMany: vi.fn(),
  suppressionFindMany: vi.fn(),
  overlaySuppression: vi.fn(),
  overlaySensitivity: vi.fn(),
  publicationFindMany: vi.fn(),
  publicationCount: vi.fn(),
  authorFindMany: vi.fn(),
  serviceFindMany: vi.fn(),
  departmentFindMany: vi.fn(),
  coreFindMany: vi.fn(),
  scholarFindMany: vi.fn(),
  coreStaffFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const read = {
    // `getFamily` resolves no family here: the route test only needs to see
    // whether the param was rejected before that point.
    scholarFamily: { findMany: m.scholarFamilyFindMany, groupBy: async () => [] },
    suppression: { findMany: m.suppressionFindMany },
    familySuppressionOverlay: { findMany: m.overlaySuppression },
    familySensitivityOverlay: { findMany: m.overlaySensitivity },
    publication: { findMany: m.publicationFindMany, count: m.publicationCount },
    publicationAuthor: { findMany: m.authorFindMany },
    methodService: { findMany: m.serviceFindMany },
    department: { findMany: m.departmentFindMany },
    core: { findMany: m.coreFindMany },
    scholar: { findMany: m.scholarFindMany },
    coreStaff: { findMany: m.coreStaffFindMany },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { prisma: read, db: { read } };
});

import { getFamilyPublications, getFamilyServices } from "@/lib/api/methods";
import { GET } from "@/app/api/methods/[supercategory]/[family]/publications/route";

const SC = "evidence_synthesis";
const LABEL = "Example review methods";
const FAM = { supercategory: SC, familyLabel: LABEL };
const TYPES: Record<string, string> = {
  "101": "Academic Article",
  "102": "Academic Article",
  "103": "Letter",
  "104": "Academic Article",
};

function service(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    entityType: "department",
    entityId: "DEPTA",
    name: "Example review service",
    url: "https://example.org/reviews",
    families: [FAM],
    supportedPmids: ["101", "103", "999"],
    excludedPmids: [],
    countStaffPapers: false,
    ...over,
  };
}

type PubArgs = {
  where: { pmid: { in: string[] }; publicationType?: { notIn: string[] } };
  take?: number;
  select: Record<string, unknown>;
};
const matching = (args: PubArgs) =>
  args.where.pmid.in.filter(
    (p) =>
      TYPES[p] !== undefined &&
      (!args.where.publicationType || !args.where.publicationType.notIn.includes(TYPES[p])),
  );

/** The pmids the paged feed query asked for. */
const feedPmids = () => {
  const call = m.publicationFindMany.mock.calls.find((c) => c[0].take !== undefined);
  return [...(call![0] as PubArgs).where.pmid.in].sort();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("METHODS_LENS_ENABLED", "on");
  vi.stubEnv("METHODS_LENS_PAGES", "on");
  m.scholarFamilyFindMany.mockResolvedValue([{ pmids: ["101", "102"] }, { pmids: ["103", "104"] }]);
  m.suppressionFindMany.mockResolvedValue([]);
  m.overlaySuppression.mockResolvedValue([]);
  m.overlaySensitivity.mockResolvedValue([]);
  m.authorFindMany.mockResolvedValue([]);
  m.publicationFindMany.mockImplementation(async (args: PubArgs) =>
    matching(args).map((pmid) => ({
      pmid,
      title: `Example paper ${pmid}`,
      journal: "Example Journal",
      year: 2024,
      publicationType: TYPES[pmid],
      citationCount: 0,
      pubmedUrl: null,
      doi: null,
      pmcid: null,
      impactScore: null,
      dateAddedToEntrez: null,
    })),
  );
  m.publicationCount.mockImplementation(async (args: PubArgs) => matching(args).length);
  m.serviceFindMany.mockResolvedValue([service()]);
  m.departmentFindMany.mockResolvedValue([
    { code: "DEPTA", name: "Library", officialName: "Example Library", slug: "example-library" },
  ]);
  m.coreFindMany.mockResolvedValue([]);
  m.scholarFindMany.mockResolvedValue([]);
  m.coreStaffFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("getFamilyPublications: METHOD_SERVICES off", () => {
  it("adds nothing to the payload and never reads method_service", async () => {
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", serviceId: 7 });
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(
      ["hits", "page", "pageSize", "total", "totalAllTypes", "totalResearchOnly"].sort(),
    );
    expect(r!.hits.every((h) => !("serviceIds" in h))).toBe(true);
    // The ignored `serviceId` did not narrow the feed.
    expect(feedPmids()).toEqual(["101", "102", "103", "104"]);
    expect(m.serviceFindMany).not.toHaveBeenCalled();
    expect(m.departmentFindMany).not.toHaveBeenCalled();
  });
});

describe("getFamilyPublications: METHOD_SERVICES on", () => {
  beforeEach(() => vi.stubEnv("METHOD_SERVICES", "on"));

  it("reports each visible service with its default-view count and badges the matching hits", async () => {
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest" });
    // 101 is a research article; 103 is a Letter (not in the default view);
    // 999 is not on the page at all.
    expect(r!.services).toEqual([{ id: 7, label: "Example Library", count: 1 }]);
    const ids = Object.fromEntries(r!.hits.map((h) => [h.pmid, h.serviceIds]));
    expect(ids).toEqual({ "101": [7], "102": undefined, "104": undefined });
    expect(r!.total).toBe(3);
  });

  it("counts under all publication types when that filter is on", async () => {
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", filter: "all" });
    expect(r!.services).toEqual([{ id: 7, label: "Example Library", count: 2 }]);
    expect(r!.hits.find((h) => h.pmid === "103")!.serviceIds).toEqual([7]);
  });

  it("serviceId narrows the feed to that unit's collaborations; the family totals stay whole", async () => {
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", serviceId: 7 });
    expect(feedPmids()).toEqual(["101", "103"]);
    expect(r!.total).toBe(1);
    expect(r!.totalResearchOnly).toBe(3);
    expect(r!.totalAllTypes).toBe(4);
  });

  it("an excluded pmid loses its badge and leaves the filter", async () => {
    m.serviceFindMany.mockResolvedValue([service({ excludedPmids: ["101"] })]);
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", serviceId: 7 });
    expect(feedPmids()).toEqual(["103"]);
    expect(r!.services).toEqual([{ id: 7, label: "Example Library", count: 0 }]);
  });

  it("an id that is not a visible service of this family yields an empty feed", async () => {
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", serviceId: 12345 });
    expect(feedPmids()).toEqual([]);
    expect(r!.total).toBe(0);
  });

  it("a hidden unit's service is no filter, no badge and no entry", async () => {
    m.departmentFindMany.mockResolvedValue([]);
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest", serviceId: 7 });
    expect(r!.services).toBeUndefined();
    expect(r!.hits).toEqual([]);
  });

  it("no service attached: the payload is exactly the flag-off payload", async () => {
    m.serviceFindMany.mockResolvedValue([]);
    const r = await getFamilyPublications(SC, LABEL, { sort: "newest" });
    expect("services" in r!).toBe(false);
    expect(r!.hits.every((h) => !("serviceIds" in h))).toBe(true);
  });
});

describe("getFamilyServices", () => {
  it("is [] with no query while the flag is off", async () => {
    expect(await getFamilyServices(SC, LABEL)).toEqual([]);
    expect(m.scholarFamilyFindMany).not.toHaveBeenCalled();
    expect(m.serviceFindMany).not.toHaveBeenCalled();
  });

  it("gives the block its entries: resolved unit name, link and default-view count", async () => {
    vi.stubEnv("METHOD_SERVICES", "on");
    expect(await getFamilyServices(SC, LABEL)).toEqual([
      {
        id: 7,
        name: "Example review service",
        url: "https://example.org/reviews",
        unitName: "Example Library",
        unitHref: "/departments/example-library",
        label: "Example Library",
        count: 1,
      },
    ]);
  });

  it("is [] for a suppressed family", async () => {
    vi.stubEnv("METHOD_SERVICES", "on");
    m.overlaySuppression.mockResolvedValue([FAM]);
    expect(await getFamilyServices(SC, LABEL)).toEqual([]);
    expect(m.serviceFindMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/methods/[supercategory]/[family]/publications: ?service=", () => {
  const get = (qs: string) =>
    GET(
      new NextRequest(
        new URL(`http://localhost/api/methods/evidence-synthesis/example-review-methods/publications?${qs}`),
      ),
      {
        params: Promise.resolve({
          supercategory: "evidence-synthesis",
          family: "example-review-methods",
        }),
      },
    );

  it.each(["abc", "0", "-3", "7 OR 1", "1234567890", ""])(
    "flag on: rejects service=%j with a static 400",
    async (bad) => {
      vi.stubEnv("METHOD_SERVICES", "on");
      const res = await get(`sort=newest&service=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid service");
      expect(m.scholarFamilyFindMany).not.toHaveBeenCalled();
    },
  );

  it("flag off: the param is ignored, even when malformed", async () => {
    const res = await get("sort=newest&service=abc");
    expect(res.status).toBe(404);
    expect(m.serviceFindMany).not.toHaveBeenCalled();
  });
});
