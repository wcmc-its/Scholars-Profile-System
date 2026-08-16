/**
 * `app/edit/reports/page.tsx` — the table/filter-rail (`2a`) vs. banded
 * (`1a`) mode choice for 2+ reportable units. Previously gated behind
 * `units.length > 3` for superuser/comms_steward, an uncited bare literal
 * that made the filter rail unreachable at real unit counts (staging has 1
 * reportable unit). Removed: superuser/comms_steward always gets `2a`;
 * everyone else with 2+ units still gets `1a`. Mirrors the mocking scaffold
 * of `edit-reports-index-page-gap5.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetEditSession, mockLoadReportableUnits, mockReportsIndex } = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadReportableUnits: vi.fn(),
  mockReportsIndex: vi.fn(() => null),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn(),
}));
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

const TWO_UNITS = [
  { code: "a", name: "A", centerType: "center" as const },
  { code: "b", name: "B", centerType: "center" as const },
];
const sp = () => Promise.resolve({});

type El = { type: unknown; props: Record<string, unknown> };
function findModeProp(node: unknown): unknown {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  const el = node as El;
  if (el.type === mockReportsIndex) return el.props.mode;
  const children = el.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    const found = findModeProp(c);
    if (found !== undefined) return found;
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadReportableUnits.mockResolvedValue(TWO_UNITS);
});

describe("/edit/reports — 2a/1a mode selection at 2+ units", () => {
  it("superuser with only 2 units → table (2a), no size minimum", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "adm001", isSuperuser: true, isCommsSteward: false });
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(findModeProp(result)).toBe("table");
  });

  it("comms_steward with only 2 units → table (2a), no size minimum", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "cs001", isSuperuser: false, isCommsSteward: true });
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(findModeProp(result)).toBe("table");
  });

  it("scoped unit Owner with 2 units → still bands (1a), unchanged", async () => {
    mockGetEditSession.mockResolvedValue({ cwid: "own001", isSuperuser: false, isCommsSteward: false });
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(findModeProp(result)).toBe("bands");
  });
});
