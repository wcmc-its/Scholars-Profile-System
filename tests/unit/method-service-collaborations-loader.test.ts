/**
 * `lib/api/method-service-collaborations.ts`: the public method page's
 * services. Who a unit's people are (a department's active scholars, a core's
 * staff list), which services are shown (a hidden core's and a retired
 * department's are not), and each service's own marks and counts. DB mocked;
 * made-up units, people and PMIDs only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  serviceFindMany: vi.fn(),
  departmentFindMany: vi.fn(),
  suppressionFindMany: vi.fn(),
  coreFindMany: vi.fn(),
  scholarFindMany: vi.fn(),
  coreStaffFindMany: vi.fn(),
  authorFindMany: vi.fn(),
  publicationFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const read = {
    methodService: { findMany: m.serviceFindMany },
    department: { findMany: m.departmentFindMany },
    suppression: { findMany: m.suppressionFindMany },
    core: { findMany: m.coreFindMany },
    scholar: { findMany: m.scholarFindMany },
    coreStaff: { findMany: m.coreStaffFindMany },
    publicationAuthor: { findMany: m.authorFindMany },
    publication: { findMany: m.publicationFindMany },
  };
  return { prisma: read, db: { read } };
});

import { loadFamilyServiceCollaborations } from "@/lib/api/method-service-collaborations";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };
const OTHER_FAM = { supercategory: "evidence_synthesis", familyLabel: "Example search methods" };
const PAGE = ["101", "102", "103", "104", "105"];

function service(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    entityType: "department",
    entityId: "DEPTA",
    name: "Example review service",
    url: "https://example.org/reviews",
    families: [FAM],
    supportedPmids: [],
    excludedPmids: [],
    countStaffPapers: false,
    ...over,
  };
}

/** Department DEPTA's people wrote 102; core 77's staff wrote 102 and 103. */
function seedPeople() {
  m.scholarFindMany.mockResolvedValue([{ cwid: "lib0001", deptCode: "DEPTA" }]);
  m.coreStaffFindMany.mockResolvedValue([{ cwid: "cor0001", coreId: "77" }]);
  m.authorFindMany.mockImplementation(async (args: { where: { cwid: { in: string[] } } }) =>
    [
      { pmid: "102", cwid: "lib0001" },
      { pmid: "102", cwid: "COR0001" },
      { pmid: "103", cwid: "cor0001" },
    ].filter((a) => args.where.cwid.in.includes(a.cwid.toLowerCase())),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("METHOD_SERVICES", "on");
  vi.stubEnv("METHODS_LENS_PAGES", "on");
  vi.stubEnv("METHODS_LENS_ENABLED", "on");
  vi.stubEnv("CORE_PAGES", "on");
  m.serviceFindMany.mockResolvedValue([service()]);
  m.departmentFindMany.mockResolvedValue([
    { code: "DEPTA", name: "Library", officialName: "Example Library", slug: "example-library" },
  ]);
  m.coreFindMany.mockResolvedValue([{ id: "77", name: "Example Imaging Core", visible: true }]);
  // The suppression table answers both the department lookup and the
  // per-author publication hides.
  m.suppressionFindMany.mockResolvedValue([]);
  m.scholarFindMany.mockResolvedValue([]);
  m.coreStaffFindMany.mockResolvedValue([]);
  m.authorFindMany.mockResolvedValue([]);
  m.publicationFindMany.mockResolvedValue(
    PAGE.map((pmid) => ({ pmid, publicationType: "Academic Article" })),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("loadFamilyServiceCollaborations: gates", () => {
  it.each(["METHOD_SERVICES", "METHODS_LENS_PAGES", "METHODS_LENS_ENABLED"])(
    "returns [] with no query while %s is off",
    async (flag) => {
      vi.stubEnv(flag, "off");
      expect(await loadFamilyServiceCollaborations(FAM, PAGE)).toEqual([]);
      expect(m.serviceFindMany).not.toHaveBeenCalled();
    },
  );

  it("returns only the services attached to this family", async () => {
    m.serviceFindMany.mockResolvedValue([service(), service({ id: 2, families: [OTHER_FAM] })]);
    const out = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(out.map((s) => s.id)).toEqual([1]);
  });

  it("stops before any unit lookup when nothing is attached", async () => {
    m.serviceFindMany.mockResolvedValue([service({ families: [OTHER_FAM] })]);
    expect(await loadFamilyServiceCollaborations(FAM, PAGE)).toEqual([]);
    expect(m.departmentFindMany).not.toHaveBeenCalled();
    expect(m.publicationFindMany).not.toHaveBeenCalled();
  });
});

describe("loadFamilyServiceCollaborations: visibility", () => {
  const coreService = service({ id: 2, entityType: "core", entityId: "77", name: "Imaging help" });

  it("resolves a department to its official name and public page", async () => {
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(s).toMatchObject({
      unitName: "Example Library",
      unitHref: "/departments/example-library",
      label: "Example Library",
    });
  });

  it("resolves a visible core to its name and public page", async () => {
    m.serviceFindMany.mockResolvedValue([coreService]);
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(s).toMatchObject({ unitName: "Example Imaging Core", unitHref: "/cores/77" });
  });

  it("does not show a hidden core's service at all", async () => {
    m.serviceFindMany.mockResolvedValue([service(), coreService]);
    m.coreFindMany.mockResolvedValue([{ id: "77", name: "Example Imaging Core", visible: false }]);
    const out = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(out.map((s) => s.id)).toEqual([1]);
  });

  it("does not show any core's service while core pages are off", async () => {
    vi.stubEnv("CORE_PAGES", "off");
    m.serviceFindMany.mockResolvedValue([coreService]);
    expect(await loadFamilyServiceCollaborations(FAM, PAGE)).toEqual([]);
  });

  it("does not show a suppressed department's service", async () => {
    m.suppressionFindMany.mockImplementation(async (args: { where: { entityType: string } }) =>
      args.where.entityType === "department" ? [{ entityId: "DEPTA" }] : [],
    );
    expect(await loadFamilyServiceCollaborations(FAM, PAGE)).toEqual([]);
  });

  it("does not show a service whose unit row is gone", async () => {
    m.departmentFindMany.mockResolvedValue([]);
    expect(await loadFamilyServiceCollaborations(FAM, PAGE)).toEqual([]);
  });

  it("never looks up the people of a unit that is not shown", async () => {
    m.serviceFindMany.mockResolvedValue([{ ...coreService, countStaffPapers: true }]);
    m.coreFindMany.mockResolvedValue([{ id: "77", name: "Example Imaging Core", visible: false }]);
    await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(m.coreStaffFindMany).not.toHaveBeenCalled();
  });
});

describe("loadFamilyServiceCollaborations: who the unit's people are", () => {
  it("a department: its active scholars, by department code", async () => {
    seedPeople();
    m.serviceFindMany.mockResolvedValue([service({ countStaffPapers: true })]);
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(m.scholarFindMany.mock.calls[0][0].where).toEqual({
      deptCode: { in: ["DEPTA"] },
      deletedAt: null,
      status: "active",
    });
    expect(Object.fromEntries(s.marked)).toEqual({ "102": "staff" });
  });

  it("a core: its curated staff list, matched case-insensitively, confirmed authorships only", async () => {
    seedPeople();
    m.serviceFindMany.mockResolvedValue([
      service({ id: 2, entityType: "core", entityId: "77", countStaffPapers: true }),
    ]);
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(m.coreStaffFindMany.mock.calls[0][0].where).toEqual({ coreId: { in: ["77"] } });
    expect(m.authorFindMany.mock.calls[0][0].where).toMatchObject({
      pmid: { in: PAGE },
      isConfirmed: true,
    });
    expect([...s.marked.keys()].sort()).toEqual(["102", "103"]);
  });

  it("does not look anyone up while automatic counting is off", async () => {
    seedPeople();
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(m.scholarFindMany).not.toHaveBeenCalled();
    expect(m.authorFindMany).not.toHaveBeenCalled();
    expect(s.marked.size).toBe(0);
  });

  it("an authorship its author has hidden does not mark the paper", async () => {
    seedPeople();
    m.serviceFindMany.mockResolvedValue([service({ countStaffPapers: true })]);
    m.suppressionFindMany.mockImplementation(async (args: { where: { entityType: string } }) =>
      args.where.entityType === "publication"
        ? [{ entityId: "102", contributorCwid: "lib0001" }]
        : [],
    );
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(s.marked.size).toBe(0);
  });
});

describe("loadFamilyServiceCollaborations: counts", () => {
  it("two units on one method each get their own marks and count, most first", async () => {
    seedPeople();
    m.serviceFindMany.mockResolvedValue([
      service({ supportedPmids: ["101", "103", "999"], excludedPmids: ["103"], countStaffPapers: true }),
      service({ id: 2, entityType: "core", entityId: "77", name: "Imaging help", countStaffPapers: true }),
    ]);
    m.authorFindMany.mockResolvedValue([
      { pmid: "102", cwid: "lib0001" },
      { pmid: "102", cwid: "cor0001" },
      { pmid: "103", cwid: "cor0001" },
      { pmid: "104", cwid: "cor0001" },
    ]);
    const out = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect(out.map((s) => [s.id, s.researchCount])).toEqual([
      [2, 3],
      [1, 2],
    ]);
    const library = out.find((s) => s.id === 1)!;
    const core = out.find((s) => s.id === 2)!;
    expect(Object.fromEntries(library.marked)).toEqual({ "101": "supported", "102": "staff" });
    expect([...core.marked.keys()].sort()).toEqual(["102", "103", "104"]);
    expect(out.map((s) => s.label)).toEqual(["Example Imaging Core", "Example Library"]);
  });

  it("splits the default view from all publication types, and ignores a pmid with no record", async () => {
    m.serviceFindMany.mockResolvedValue([service({ supportedPmids: ["101", "102", "103", "104"] })]);
    m.publicationFindMany.mockResolvedValue([
      { pmid: "101", publicationType: "Academic Article" },
      { pmid: "102", publicationType: "Letter" },
      { pmid: "103", publicationType: null },
      // 104 has no publication row: the feed cannot list it.
    ]);
    const [s] = await loadFamilyServiceCollaborations(FAM, PAGE);
    expect([...s.marked.keys()].sort()).toEqual(["101", "102", "103"]);
    expect(s.allCount).toBe(3);
    expect(s.researchCount).toBe(1);
  });
});
