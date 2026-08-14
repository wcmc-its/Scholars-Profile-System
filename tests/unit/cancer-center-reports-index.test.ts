/**
 * `lib/edit/cancer-center-reports.ts` — `loadReportableUnitsForActor`,
 * `loadReportLiveness`, and `resolveNumberedReportCenterCode`, the queries
 * behind the Reports IA redesign's cross-unit index (2026-08-14).
 * `resolveReportsCenterCode` has its own suite (`cancer-center-reports.test.ts`)
 * — this one is scoped to the multi-unit additions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadAllUnitsDirectory, mockLoadManageableUnits, mockRedirect } = vi.hoisted(() => ({
  mockLoadAllUnitsDirectory: vi.fn(),
  mockLoadManageableUnits: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));
vi.mock("@/lib/edit/manageable-units", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edit/manageable-units")>();
  return { ...actual, loadAllUnitsDirectory: mockLoadAllUnitsDirectory, loadManageableUnits: mockLoadManageableUnits };
});
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, redirect: mockRedirect };
});

import {
  loadReportLiveness,
  loadReportableUnitsForActor,
  resolveNumberedReportCenterCode,
  REPORT_CATALOG_SIZE,
} from "@/lib/edit/cancer-center-reports";

beforeEach(() => {
  mockLoadAllUnitsDirectory.mockReset();
  mockLoadManageableUnits.mockReset();
  mockRedirect.mockClear();
});

function fakeDirectoryDb(opts: {
  programCodes?: string[];
  centerTypeRows?: Array<{ code: string; centerType: string }>;
  retiredCodes?: string[];
  /** Only needed by resolveNumberedReportCenterCode's `requested` branch,
   *  which falls through to the real (unmocked) loadAllUnitsForFinder. */
  allCenters?: Array<{ code: string; name: string }>;
} = {}) {
  return {
    department: { findMany: vi.fn().mockResolvedValue([]) },
    division: { findMany: vi.fn().mockResolvedValue([]) },
    center: { findMany: vi.fn().mockResolvedValue(opts.allCenters ?? opts.centerTypeRows ?? []) },
    centerProgram: {
      findMany: vi.fn().mockResolvedValue((opts.programCodes ?? []).map((centerCode) => ({ centerCode }))),
    },
    suppression: {
      findMany: vi.fn().mockResolvedValue((opts.retiredCodes ?? []).map((entityId) => ({ entityId }))),
    },
  };
}

describe("loadReportableUnitsForActor", () => {
  it("superuser: pulls every center org-wide (loadAllUnitsDirectory), filtered to a CenterProgram taxonomy", async () => {
    mockLoadAllUnitsDirectory.mockResolvedValue([
      { kind: "center", code: "meyer", name: "Meyer Cancer Center", centerType: "center" },
      { kind: "center", code: "epic", name: "Englander Institute", centerType: "institute" },
      { kind: "department", code: "d1", name: "Some Department", centerType: null },
    ]);
    const db = fakeDirectoryDb({ programCodes: ["meyer"] });
    const units = await loadReportableUnitsForActor(
      { cwid: "x", isSuperuser: true, isCommsSteward: false },
      db as never,
    );
    expect(units).toEqual([{ code: "meyer", name: "Meyer Cancer Center", centerType: "center" }]);
    expect(mockLoadManageableUnits).not.toHaveBeenCalled();
    // Regression: a superuser bypasses loadUnitEditContext's retired-unit
    // gate, so retired centers must not be filtered out at the source.
    expect(mockLoadAllUnitsDirectory).toHaveBeenCalledWith(expect.anything(), { includeRetired: true });
  });

  it("comms_steward takes the same global path as a superuser, but retired units stay excluded (they do NOT bypass the retired gate)", async () => {
    mockLoadAllUnitsDirectory.mockResolvedValue([
      { kind: "center", code: "meyer", name: "Meyer Cancer Center", centerType: "institute" },
    ]);
    const db = fakeDirectoryDb({ programCodes: ["meyer"] });
    const units = await loadReportableUnitsForActor(
      { cwid: "x", isSuperuser: false, isCommsSteward: true },
      db as never,
    );
    expect(units).toEqual([{ code: "meyer", name: "Meyer Cancer Center", centerType: "institute" }]);
    // loadUnitEditContext's retired gate excludes everyone but a superuser —
    // comms_steward must NOT get includeRetired even on the "global" path.
    expect(mockLoadAllUnitsDirectory).toHaveBeenCalledWith(expect.anything(), { includeRetired: false });
  });

  it("non-superuser: scoped to the actor's own grants, centerType enriched via a second query", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [
        { kind: "center", code: "meyer", name: "Meyer Cancer Center", role: "curator", href: "/edit/center/meyer" },
      ],
      total: 1,
    });
    const db = fakeDirectoryDb({
      programCodes: ["meyer"],
      centerTypeRows: [{ code: "meyer", centerType: "institute" }],
    });
    const units = await loadReportableUnitsForActor(
      { cwid: "curator1", isSuperuser: false, isCommsSteward: false },
      db as never,
    );
    expect(units).toEqual([{ code: "meyer", name: "Meyer Cancer Center", centerType: "institute" }]);
    expect(mockLoadAllUnitsDirectory).not.toHaveBeenCalled();
  });

  it("drops candidates without a CenterProgram taxonomy — the same data-driven gate resolveReportsCenterCode applies to one unit", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [{ kind: "center", code: "no_program", name: "No Program Center", role: "owner", href: "/x" }],
      total: 1,
    });
    const db = fakeDirectoryDb({ programCodes: [], centerTypeRows: [{ code: "no_program", centerType: "center" }] });
    const units = await loadReportableUnitsForActor(
      { cwid: "x", isSuperuser: false, isCommsSteward: false },
      db as never,
    );
    expect(units).toEqual([]);
  });

  it("excludes a retired unit for a non-superuser, non-comms_steward actor — loadManageableUnits carries no retirement filter of its own", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [
        { kind: "center", code: "meyer", name: "Meyer Cancer Center", role: "curator", href: "/edit/center/meyer" },
        { kind: "center", code: "retired_ctr", name: "Retired Center", role: "curator", href: "/edit/center/retired_ctr" },
      ],
      total: 2,
    });
    const db = fakeDirectoryDb({
      programCodes: ["meyer", "retired_ctr"],
      centerTypeRows: [
        { code: "meyer", centerType: "center" },
        { code: "retired_ctr", centerType: "center" },
      ],
      retiredCodes: ["retired_ctr"],
    });
    const units = await loadReportableUnitsForActor(
      { cwid: "curator1", isSuperuser: false, isCommsSteward: false },
      db as never,
    );
    expect(units).toEqual([{ code: "meyer", name: "Meyer Cancer Center", centerType: "center" }]);
  });

  it("returns [] with no further queries when the actor manages no centers at all", async () => {
    mockLoadManageableUnits.mockResolvedValue({ departments: [], divisions: [], centers: [], total: 0 });
    const db = fakeDirectoryDb();
    const units = await loadReportableUnitsForActor(
      { cwid: "x", isSuperuser: false, isCommsSteward: false },
      db as never,
    );
    expect(units).toEqual([]);
    expect(db.centerProgram.findMany).not.toHaveBeenCalled();
  });
});

function fakeLivenessDb(
  opts: {
    collab?: Array<{ centerCode: string; _count: { _all: number }; _max: { lastRefreshedAt: Date | null } }>;
    funding?: Array<{ centerCode: string; _count: { _all: number }; _max: { lastRefreshedAt: Date | null } }>;
    /** Centers to give exactly one active, visible member — backs
     *  `countActiveCenterMembersByCode`'s real query shape rather than
     *  re-deriving its own groupBy (loadReportLiveness reuses that helper). */
    activeMemberCenterCodes?: string[];
  } = {},
) {
  const codes = opts.activeMemberCenterCodes ?? [];
  return {
    centerCollabCandidate: { groupBy: vi.fn().mockResolvedValue(opts.collab ?? []) },
    cancerCenterFundingAward: { groupBy: vi.fn().mockResolvedValue(opts.funding ?? []) },
    centerMembership: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          codes.map((centerCode, i) => ({ centerCode, cwid: `member${i}`, startDate: null, endDate: null })),
        ),
    },
    scholar: { findMany: vi.fn().mockResolvedValue(codes.map((_, i) => ({ cwid: `member${i}` }))) },
  };
}

describe("loadReportLiveness", () => {
  it("returns an empty map with no queries for an empty code list", async () => {
    const db = fakeLivenessDb();
    const result = await loadReportLiveness([], db as never);
    expect(result.size).toBe(0);
    expect(db.centerCollabCandidate.groupBy).not.toHaveBeenCalled();
  });

  it("reports 1 & 2 live from real row counts; reports 3-5 proxied by active-membership existence", async () => {
    const d1 = new Date("2026-08-11T00:00:00Z");
    const db = fakeLivenessDb({
      collab: [{ centerCode: "meyer", _count: { _all: 3 }, _max: { lastRefreshedAt: d1 } }],
      funding: [{ centerCode: "meyer", _count: { _all: 0 }, _max: { lastRefreshedAt: null } }],
      activeMemberCenterCodes: ["meyer"],
    });
    const result = await loadReportLiveness(["meyer"], db as never);
    const meyer = result.get("meyer");
    expect(meyer?.liveCount).toBe(4); // 1, 3, 4, 5 — not 2 (zero funding rows)
    expect(meyer?.totalCount).toBe(REPORT_CATALOG_SIZE);
    expect(meyer?.lastRefreshedAt).toEqual(d1);
    expect(meyer?.perReport).toEqual([
      { n: 1, live: true, lastRefreshedAt: d1 },
      { n: 2, live: false, lastRefreshedAt: null },
      { n: 3, live: true, lastRefreshedAt: null },
      { n: 4, live: true, lastRefreshedAt: null },
      { n: 5, live: true, lastRefreshedAt: null },
    ]);
  });

  it("a unit with zero rows anywhere still gets a full all-false entry, not a missing map key", async () => {
    const db = fakeLivenessDb();
    const result = await loadReportLiveness(["empty_center"], db as never);
    expect(result.get("empty_center")).toEqual({
      perReport: [
        { n: 1, live: false, lastRefreshedAt: null },
        { n: 2, live: false, lastRefreshedAt: null },
        { n: 3, live: false, lastRefreshedAt: null },
        { n: 4, live: false, lastRefreshedAt: null },
        { n: 5, live: false, lastRefreshedAt: null },
      ],
      liveCount: 0,
      totalCount: REPORT_CATALOG_SIZE,
      lastRefreshedAt: null,
    });
  });

  it("the aggregate lastRefreshedAt is the max across reports 1 and 2, not just report 1's", async () => {
    const older = new Date("2026-08-01T00:00:00Z");
    const newer = new Date("2026-08-12T00:00:00Z");
    const db = fakeLivenessDb({
      collab: [{ centerCode: "c1", _count: { _all: 1 }, _max: { lastRefreshedAt: older } }],
      funding: [{ centerCode: "c1", _count: { _all: 1 }, _max: { lastRefreshedAt: newer } }],
    });
    const result = await loadReportLiveness(["c1"], db as never);
    expect(result.get("c1")?.lastRefreshedAt).toEqual(newer);
  });
});

describe("resolveNumberedReportCenterCode", () => {
  it("an explicit ?center= resolves the same way resolveReportsCenterCode always has (org-wide, not actor-scoped)", async () => {
    const db = fakeDirectoryDb({
      allCenters: [{ code: "meyer", name: "Meyer Cancer Center" }],
      programCodes: ["meyer"],
    });
    const code = await resolveNumberedReportCenterCode(
      { cwid: "x", isSuperuser: false, isCommsSteward: false },
      db as never,
      "meyer",
    );
    expect(code).toBe("meyer");
    expect(mockLoadManageableUnits).not.toHaveBeenCalled();
  });

  it("no ?center=, exactly one reportable unit: resolves straight to it — today's existing behavior, unchanged", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [{ kind: "center", code: "meyer", name: "Meyer Cancer Center", role: "curator", href: "/x" }],
      total: 1,
    });
    const db = fakeDirectoryDb({ programCodes: ["meyer"], centerTypeRows: [{ code: "meyer", centerType: "center" }] });
    const code = await resolveNumberedReportCenterCode(
      { cwid: "curator1", isSuperuser: false, isCommsSteward: false },
      db as never,
      undefined,
    );
    expect(code).toBe("meyer");
  });

  it("no ?center=, zero reportable units: redirects to the index instead of resolveReportsCenterCode's org-wide default-pick", async () => {
    mockLoadManageableUnits.mockResolvedValue({ departments: [], divisions: [], centers: [], total: 0 });
    const db = fakeDirectoryDb();
    await expect(
      resolveNumberedReportCenterCode(
        { cwid: "x", isSuperuser: false, isCommsSteward: false },
        db as never,
        undefined,
      ),
    ).rejects.toThrow("__REDIRECT__:/edit/reports");
  });

  it("no ?center=, more than one reportable unit: redirects to the index — no picker of its own to fall back on", async () => {
    mockLoadManageableUnits.mockResolvedValue({
      departments: [],
      divisions: [],
      centers: [
        { kind: "center", code: "meyer", name: "Meyer Cancer Center", role: "curator", href: "/x" },
        { kind: "center", code: "epic", name: "Englander Institute", role: "curator", href: "/y" },
      ],
      total: 2,
    });
    const db = fakeDirectoryDb({
      programCodes: ["meyer", "epic"],
      centerTypeRows: [
        { code: "meyer", centerType: "center" },
        { code: "epic", centerType: "institute" },
      ],
    });
    await expect(
      resolveNumberedReportCenterCode(
        { cwid: "curator1", isSuperuser: false, isCommsSteward: false },
        db as never,
        undefined,
      ),
    ).rejects.toThrow("__REDIRECT__:/edit/reports");
  });
});
