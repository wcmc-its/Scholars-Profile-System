/**
 * `app/edit/units/page.tsx` — regression coverage for
 * docs/edit-console-ia-spec.md Gap 4: `usageTab`/`reportsTab` were never
 * passed to `ConsoleShell` despite the page already loading everything both
 * checks need. Shallow element inspection only (no render) — same pattern as
 * `administrators-page.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadManageableUnits,
  mockLoadAllUnitsDirectory,
  mockCanViewUsage,
  mockLoadReportableUnits,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadManageableUnits: vi.fn(),
  mockLoadAllUnitsDirectory: vi.fn().mockResolvedValue([]),
  mockCanViewUsage: vi.fn(),
  mockLoadReportableUnits: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({
  getEffectiveEditSession: mockGetEditSession,
}));
vi.mock("@/lib/edit/manageable-units", () => ({
  loadManageableUnits: mockLoadManageableUnits,
  loadAllUnitsDirectory: mockLoadAllUnitsDirectory,
}));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: mockCanViewUsage }));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportableUnitsForActor: mockLoadReportableUnits,
}));
vi.mock("@/lib/edit/data-quality", () => ({ isDataQualityDashboardEnabled: () => false }));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import EditUnitsPage from "@/app/edit/units/page";

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;

const EMPTY_UNITS = { departments: [], divisions: [], centers: [], cores: [], total: 0 };
const OWNER = { cwid: "own01", isSuperuser: false, isCommsSteward: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadManageableUnits.mockResolvedValue(EMPTY_UNITS);
  mockLoadAllUnitsDirectory.mockResolvedValue([]);
});

describe("/edit/units — usageTab / reportsTab (Gap 4)", () => {
  it("signed-out → SAML redirect", async () => {
    mockGetEditSession.mockResolvedValue(null);
    await expect(EditUnitsPage()).rejects.toThrow(
      "__REDIRECT__:/api/auth/saml/login?return=/edit/units",
    );
  });

  it("passes usageTab/reportsTab through from the already-loaded grant reads", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockCanViewUsage.mockResolvedValue(true);
    mockLoadReportableUnits.mockResolvedValue([{ code: "N1280", name: "A Center" }]);
    const result = asEl(await EditUnitsPage());
    expect(result.props.usageTab).toBe(true);
    expect(result.props.reportsTab).toBe(true);
    expect(mockCanViewUsage).toHaveBeenCalledWith(OWNER, {});
  });

  it("hides both when the viewer has no usage grant and no reportable unit", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockCanViewUsage.mockResolvedValue(false);
    mockLoadReportableUnits.mockResolvedValue([]);
    const result = asEl(await EditUnitsPage());
    expect(result.props.usageTab).toBe(false);
    expect(result.props.reportsTab).toBe(false);
  });
});
