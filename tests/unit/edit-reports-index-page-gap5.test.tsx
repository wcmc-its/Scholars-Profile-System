/**
 * `app/edit/reports/page.tsx` — Gap 5 (2026-08-14 handoff): a superuser isn't
 * scoped to any particular unit's grants, so zero reportable units for them
 * is an empty roster, not a nonexistent route. Everyone else with zero
 * reportable units still 404s. Scoped narrowly to this one behavior, not a
 * full page test suite — the page's other paths (?center=, 1 unit, 2+ units)
 * are unchanged by this fix.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockNotFound, mockRedirect, mockLoadReportableUnits, mockReportsIndex } =
  vi.hoisted(() => ({
    mockGetEditSession: vi.fn(),
    mockNotFound: vi.fn(() => {
      throw new Error("__NOT_FOUND__");
    }),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`__REDIRECT__:${url}`);
    }),
    mockLoadReportableUnits: vi.fn(),
    mockReportsIndex: vi.fn(() => null),
  }));

vi.mock("next/navigation", () => ({ notFound: mockNotFound, redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportableUnitsForActor: mockLoadReportableUnits,
  loadReportLiveness: vi.fn().mockResolvedValue(new Map()),
  loadReportsContext: vi.fn(),
  resolveReportsCenterCode: vi.fn(),
}));
vi.mock("@/components/edit/reports-index", () => ({
  ReportsIndex: mockReportsIndex,
  SingleUnitReportsTable: () => null,
}));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: () => null }));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/manageable-units", () => ({ unitEditHref: () => "/edit/center/x" }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import EditReportsIndexPage from "@/app/edit/reports/page";

const SUPERUSER = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const CURATOR = { cwid: "cur001", isSuperuser: false, isCommsSteward: false };
const sp = () => Promise.resolve({});

type El = { type: unknown; props: Record<string, unknown> };
const asEl = (v: unknown) => v as El;

/** Not calling render() — like the sibling page tests, this walks the plain
 *  returned element tree looking for a descendant of the given mock type. */
function findByType(node: unknown, type: unknown): El | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  const el = asEl(node);
  if (el.type === type) return el;
  const children = el.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    const found = findByType(c, type);
    if (found) return found;
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadReportableUnits.mockResolvedValue([]);
});

describe("/edit/reports — Gap 5: zero reportable units", () => {
  it("superuser → renders the (empty) index, does not 404", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockNotFound).not.toHaveBeenCalled();
    const index = findByType(result, mockReportsIndex);
    expect(index).not.toBeNull();
    expect(index!.props.units).toEqual([]);
  });

  it("scoped Owner/Curator with zero grants → still 404s", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    await expect(EditReportsIndexPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockReportsIndex).not.toHaveBeenCalled();
  });
});
