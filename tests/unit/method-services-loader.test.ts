/**
 * `lib/api/method-services.ts` and `lib/method-services/flags.ts`: the edit
 * pages' loader, the defensive row-to-view mapping, the family check, and the
 * flag. DB mocked; made-up values only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  serviceFindMany: vi.fn(),
  familyGroupBy: vi.fn(),
  suppressionFindMany: vi.fn(),
  sensitivityFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const read = {
    methodService: { findMany: m.serviceFindMany },
    scholarFamily: { groupBy: m.familyGroupBy },
    familySuppressionOverlay: { findMany: m.suppressionFindMany },
    familySensitivityOverlay: { findMany: m.sensitivityFindMany },
  };
  return { prisma: read, db: { read } };
});

import {
  findNonPublicFamilies,
  loadMethodServicesForUnit,
  toMethodServiceView,
} from "@/lib/api/method-services";
import { isMethodServicesEnabled } from "@/lib/method-services/flags";

const FAM = { supercategory: "evidence_synthesis", familyLabel: "Example review methods" };
const FAM_2 = { supercategory: "evidence_synthesis", familyLabel: "Example search methods" };
const ROW = {
  id: 5,
  entityType: "core",
  entityId: "77",
  name: "Example service",
  url: "https://example.org",
  families: [FAM],
  supportedPmids: ["111"],
  excludedPmids: [],
  countStaffPapers: true,
  affiliationPhrases: ["Example Imaging Core"],
  coauthoredPmids: ["111"],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.serviceFindMany.mockResolvedValue([ROW]);
  m.familyGroupBy.mockResolvedValue([FAM, FAM_2]);
  m.suppressionFindMany.mockResolvedValue([]);
  m.sensitivityFindMany.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("isMethodServicesEnabled", () => {
  it("needs METHOD_SERVICES and both method-page flags, each exactly 'on'", () => {
    const all = { METHOD_SERVICES: "on", METHODS_LENS_PAGES: "on", METHODS_LENS_ENABLED: "on" };
    const set = (env: Record<string, string>) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    };
    set(all);
    expect(isMethodServicesEnabled()).toBe(true);
    for (const key of Object.keys(all)) {
      for (const off of ["off", "", "true", "ON"]) {
        set({ ...all, [key]: off });
        expect(isMethodServicesEnabled(), `${key}=${off}`).toBe(false);
      }
    }
  });
});

describe("loadMethodServicesForUnit", () => {
  it("reads one unit's rows by name and maps them to views", async () => {
    expect(await loadMethodServicesForUnit("core", "77")).toEqual([ROW]);
    expect(m.serviceFindMany).toHaveBeenCalledWith({
      where: { entityType: "core", entityId: "77" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: expect.any(Object),
    });
  });
});

describe("toMethodServiceView", () => {
  it("reads malformed JSON columns as empty rather than throwing", () => {
    expect(
      toMethodServiceView({
        ...ROW,
        families: [FAM, { supercategory: "x" }, "junk", null],
        supportedPmids: "111",
        excludedPmids: ["222", 333, null],
        affiliationPhrases: null,
        coauthoredPmids: ["222", 7],
      }),
    ).toMatchObject({
      families: [FAM],
      supportedPmids: [],
      excludedPmids: ["222"],
      affiliationPhrases: [],
      coauthoredPmids: ["222"],
    });
  });

  it("is null for a row owned by a unit kind that holds no services", () => {
    expect(toMethodServiceView({ ...ROW, entityType: "division" })).toBeNull();
  });
});

describe("findNonPublicFamilies", () => {
  it("returns nothing, and queries nothing, for an empty list", async () => {
    expect(await findNonPublicFamilies([])).toEqual([]);
    expect(m.familyGroupBy).not.toHaveBeenCalled();
  });

  it("asks for exactly the families named", async () => {
    expect(await findNonPublicFamilies([FAM, FAM_2])).toEqual([]);
    expect(m.familyGroupBy).toHaveBeenCalledWith({
      by: ["supercategory", "familyLabel"],
      where: { OR: [FAM, FAM_2] },
    });
  });

  it("returns a family with no scholar_family row, and one under the wrong supercategory", async () => {
    m.familyGroupBy.mockResolvedValue([FAM]);
    const moved = { supercategory: "other", familyLabel: FAM.familyLabel };
    expect(await findNonPublicFamilies([FAM, FAM_2, moved])).toEqual([FAM_2, moved]);
  });

  it("returns a suppressed family always, a sensitive one only with the gate on", async () => {
    m.suppressionFindMany.mockResolvedValue([FAM]);
    m.sensitivityFindMany.mockResolvedValue([FAM_2]);
    vi.stubEnv("METHODS_LENS_SENSITIVE_GATE", "off");
    expect(await findNonPublicFamilies([FAM, FAM_2])).toEqual([FAM]);
    vi.stubEnv("METHODS_LENS_SENSITIVE_GATE", "on");
    expect(await findNonPublicFamilies([FAM, FAM_2])).toEqual([FAM, FAM_2]);
  });
});
