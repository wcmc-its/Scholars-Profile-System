/**
 * `lib/edit/data-quality.ts` — flag gate, sub-nav visibility, and access-scope
 * resolver for the Data Quality dashboard (docs/data-quality-dashboard-spec.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isDataQualityDashboardEnabled,
  isDataQualityTabVisible,
  isEmptyScope,
  loadDataQualityScope,
} from "@/lib/edit/data-quality";

type AnyMock = ReturnType<typeof vi.fn>;
type FakeClient = {
  unitAdmin: { findMany: AnyMock };
  division: { findMany: AnyMock };
};
type ScopeClient = Parameters<typeof loadDataQualityScope>[1];

function fakeClient(grants: unknown[] = [], divisions: unknown[] = []): FakeClient {
  return {
    unitAdmin: { findMany: vi.fn().mockResolvedValue(grants) },
    division: { findMany: vi.fn().mockResolvedValue(divisions) },
  };
}
const asClient = (c: FakeClient) => c as unknown as ScopeClient;
const session = (over: Partial<{ cwid: string; isSuperuser: boolean; isCommsSteward: boolean }> = {}) => ({
  cwid: "edt1001",
  isSuperuser: false,
  isCommsSteward: false,
  ...over,
});

const ORIGINAL = process.env.EDIT_DATA_QUALITY_DASHBOARD;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EDIT_DATA_QUALITY_DASHBOARD;
  else process.env.EDIT_DATA_QUALITY_DASHBOARD = ORIGINAL;
});

describe("isDataQualityDashboardEnabled", () => {
  it("true only when the flag is exactly 'on'", () => {
    process.env.EDIT_DATA_QUALITY_DASHBOARD = "on";
    expect(isDataQualityDashboardEnabled()).toBe(true);
    process.env.EDIT_DATA_QUALITY_DASHBOARD = "off";
    expect(isDataQualityDashboardEnabled()).toBe(false);
    delete process.env.EDIT_DATA_QUALITY_DASHBOARD;
    expect(isDataQualityDashboardEnabled()).toBe(false);
  });
});

describe("isDataQualityTabVisible", () => {
  it("hidden when the flag is off, even for a superuser", () => {
    process.env.EDIT_DATA_QUALITY_DASHBOARD = "off";
    expect(isDataQualityTabVisible({ isSuperuser: true, isCommsSteward: false })).toBe(false);
  });
  it("shown to a superuser or comms_steward when on; hidden for neither", () => {
    process.env.EDIT_DATA_QUALITY_DASHBOARD = "on";
    expect(isDataQualityTabVisible({ isSuperuser: true, isCommsSteward: false })).toBe(true);
    expect(isDataQualityTabVisible({ isSuperuser: false, isCommsSteward: true })).toBe(true);
    expect(isDataQualityTabVisible({ isSuperuser: false, isCommsSteward: false })).toBe(false);
  });
});

describe("loadDataQualityScope", () => {
  it("a superuser is a global editor — { all: true }, no grant query", async () => {
    const c = fakeClient();
    const scope = await loadDataQualityScope(session({ isSuperuser: true }), asClient(c));
    expect(scope).toEqual({ all: true });
    expect(c.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("a comms_steward is a global editor — { all: true }", async () => {
    const scope = await loadDataQualityScope(session({ isCommsSteward: true }), asClient(fakeClient()));
    expect(scope).toEqual({ all: true });
  });

  it("a dept Owner gets the dept + its divisions (cascade); a curator counts too", async () => {
    const c = fakeClient(
      [
        { entityType: "department", entityId: "MED" },
        { entityType: "division", entityId: "CARD", role: "curator" },
      ],
      [{ code: "ENDO" }, { code: "CARD" }],
    );
    const scope = await loadDataQualityScope(session(), asClient(c));
    expect(scope.all).toBe(false);
    if (scope.all === false) {
      expect(scope.unitCodes.sort()).toEqual(["CARD", "ENDO", "MED"]);
      expect(scope.centerCodes).toEqual([]);
    }
    expect(c.division.findMany).toHaveBeenCalledWith({
      where: { deptCode: { in: ["MED"] } },
      select: { code: true },
    });
  });

  it("a center grant lands in centerCodes (membership-scoped, not a column)", async () => {
    const c = fakeClient([{ entityType: "center", entityId: "CTR1" }]);
    const scope = await loadDataQualityScope(session(), asClient(c));
    expect(scope.all).toBe(false);
    if (scope.all === false) {
      expect(scope.unitCodes).toEqual([]);
      expect(scope.centerCodes).toEqual(["CTR1"]);
    }
    // No departments → no division-cascade lookup.
    expect(c.division.findMany).not.toHaveBeenCalled();
  });

  it("no grants and no global role → empty scope (the route forbids it)", async () => {
    const scope = await loadDataQualityScope(session(), asClient(fakeClient()));
    expect(scope.all).toBe(false);
    expect(isEmptyScope(scope)).toBe(true);
  });
});

describe("isEmptyScope", () => {
  it("global scope is never empty", () => {
    expect(isEmptyScope({ all: true })).toBe(false);
  });
  it("non-global with any unit/center is not empty", () => {
    expect(isEmptyScope({ all: false, unitCodes: ["MED"], centerCodes: [] })).toBe(false);
    expect(isEmptyScope({ all: false, unitCodes: [], centerCodes: ["CTR1"] })).toBe(false);
    expect(isEmptyScope({ all: false, unitCodes: [], centerCodes: [] })).toBe(true);
  });
});
