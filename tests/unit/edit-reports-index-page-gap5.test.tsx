/**
 * `app/edit/reports/page.tsx` — Gap 5 (2026-08-14 handoff): a superuser isn't
 * scoped to any particular unit's grants, so zero reportable units for them
 * is an empty roster, not a nonexistent route. Everyone else with zero
 * reportable units still 404s. Scoped narrowly to this one behavior, not a
 * full page test suite — the page's other paths (?center=, 1 unit, 2+ units)
 * are unchanged by this fix. Also home to the program row's "Who can run
 * this report" props (the grant rows via `listReportAccess`, read only when
 * the row is shown; `canManage` per session; unit rows get the unit rule),
 * since this is the scaffold that already drives the program row.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockNotFound,
  mockRedirect,
  mockLoadReportableUnits,
  mockReportsIndex,
  mockGetReportScopes,
  mockListReportAccess,
  mockReportMetaFindMany,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockLoadReportableUnits: vi.fn(),
  mockReportsIndex: vi.fn(() => null),
  mockGetReportScopes: vi.fn(),
  mockListReportAccess: vi.fn(),
  mockReportMetaFindMany: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound, redirect: mockRedirect }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: mockGetEditSession }));
vi.mock("@/lib/edit/cancer-center-reports", () => ({
  loadReportableUnitsForActor: mockLoadReportableUnits,
  loadReportLiveness: vi.fn().mockResolvedValue(new Map()),
  loadReportsContext: vi.fn(),
  resolveReportsCenterCode: vi.fn(),
  REPORT_NUMBERS_BY_KIND: { center: [1, 2, 3, 4, 5, 6], department: [3, 6], division: [3, 6], core: [3, 6] },
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
// Program reports (report 7) ride a `report_access` row — default: none held.
// `listReportAccess` / `canManageReportAccess` / the scope options feed the
// program row's "Who can run this report" popover props.
vi.mock("@/lib/edit/report-access", () => ({
  getReportScopes: mockGetReportScopes,
  listReportAccess: mockListReportAccess,
  canManageReportAccess: (s: { isSuperuser: boolean; isCommsSteward: boolean }) =>
    s.isSuperuser || s.isCommsSteward,
  MENTORED_PUBS_REPORT: "mentored-publications",
  MENTORED_PUBS_SCOPE_OPTIONS: [
    ["*", "All programs"],
    ["md", "AOC"],
  ],
}));
// `report_meta` (names + blurbs, `loadReportMeta`) — an empty table, so the
// catalog renders from the hardcoded defaults.
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: mockReportMetaFindMany } }, write: {} },
}));

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
  mockGetReportScopes.mockResolvedValue(new Set());
  mockListReportAccess.mockResolvedValue([]);
  mockReportMetaFindMany.mockResolvedValue([]);
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

  it("a report_access holder with zero unit grants → the index with the program row alone (bands), no 404", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockGetReportScopes.mockResolvedValue(new Set(["md"]));
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockNotFound).not.toHaveBeenCalled();
    const index = findByType(result, mockReportsIndex);
    expect(index?.props.mode).toBe("bands");
    expect(index?.props.units).toEqual([
      expect.objectContaining({ kind: "program", reports: [expect.objectContaining({ n: 7 })] }),
    ]);
  });

  it("superuser (scopes '*') → the index carries the program row alongside the (empty) unit list", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const result = await EditReportsIndexPage({ searchParams: sp() });
    const index = findByType(result, mockReportsIndex);
    expect(index?.props.mode).toBe("table");
    expect((index?.props.units as Array<{ kind: string }>).map((u) => u.kind)).toEqual(["program"]);
  });

  it("the program card's label and blurb come from report_meta: defaults with no row, the row when present", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const byDefault = await EditReportsIndexPage({ searchParams: sp() });
    expect(
      (findByType(byDefault, mockReportsIndex)?.props.units as Array<{ reports: unknown[] }>)[0]
        .reports,
    ).toEqual([
      {
        n: 7,
        label: "7. Mentored publications",
        description: expect.stringContaining("Access is granted per person."),
        access: expect.objectContaining({ mode: "person" }),
      },
    ]);

    mockReportMetaFindMany.mockResolvedValue([
      {
        reportKey: "7",
        slug: "mentee-co-publications",
        name: "Mentee co-publications",
        summary: "Edited blurb.",
        descriptionHtml: null,
      },
    ]);
    const edited = await EditReportsIndexPage({ searchParams: sp() });
    expect(
      (findByType(edited, mockReportsIndex)?.props.units as Array<{ reports: unknown[] }>)[0]
        .reports,
    ).toEqual([
      {
        n: 7,
        label: "7. Mentee co-publications",
        description: "Edited blurb.",
        access: expect.objectContaining({ mode: "person" }),
      },
    ]);
  });

  it("the program row's popover props: the grant rows (ISO dates), the shared scope options, canManage per session; unit rows get the unit rule; no read when the row is hidden", async () => {
    // Hidden (no scopes) → `listReportAccess` is never read.
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    await EditReportsIndexPage({ searchParams: sp() });
    expect(mockListReportAccess).not.toHaveBeenCalled();

    const row = {
      reportKey: "mentored-publications",
      scopeKey: "md",
      cwid: "usr0001",
      granteeName: "Holder Person",
      name: "Holder Person",
      grantedBy: "adm0001",
      grantedAt: new Date("2026-09-18T12:00:00Z"),
    };
    mockListReportAccess.mockResolvedValue([row]);

    // A plain holder: the rows, canManage=false.
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockGetReportScopes.mockResolvedValue(new Set(["md"]));
    const holder = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockListReportAccess).toHaveBeenCalledTimes(1);
    expect(mockListReportAccess).toHaveBeenCalledWith("mentored-publications");
    const holderUnits = findByType(holder, mockReportsIndex)!.props.units as Array<{
      reports: Array<{ access: unknown }>;
    }>;
    expect(holderUnits[0].reports[0].access).toEqual({
      mode: "person",
      reportKey: "mentored-publications",
      initialRows: [{ ...row, grantedAt: "2026-09-18T12:00:00.000Z" }],
      scopeOptions: [
        ["*", "All programs"],
        ["md", "AOC"],
      ],
      canManage: false,
    });

    // A superuser with a unit too: canManage=true on the program row; the
    // unit's own reports carry the unit rule.
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    mockLoadReportableUnits.mockResolvedValue([
      { code: "a", name: "A", kind: "center", centerType: "center" },
      { code: "b", name: "B", kind: "center", centerType: "center" },
    ]);
    const superuser = await EditReportsIndexPage({ searchParams: sp() });
    const units = findByType(superuser, mockReportsIndex)!.props.units as Array<{
      kind: string;
      reports: Array<{ n: number; access: unknown }>;
    }>;
    expect(units.map((u) => u.kind)).toEqual(["center", "center", "program"]);
    expect(units[0].reports.map((r) => r.access)).toEqual(Array(6).fill({ mode: "unit" }));
    expect(units[2].reports[0].access).toEqual(
      expect.objectContaining({ mode: "person", canManage: true }),
    );
  });

  it("superuser with no report grant sees no program row when scopes are empty", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(findByType(result, mockReportsIndex)?.props.units).toEqual([]);
  });
});
