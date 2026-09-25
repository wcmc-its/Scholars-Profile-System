/**
 * `app/edit/reports/page.tsx` — Gap 5 (2026-08-14 handoff): a superuser isn't
 * scoped to any particular unit's grants, so zero reportable units for them
 * is an empty roster, not a nonexistent route. Everyone else with zero
 * reportable units still 404s. Scoped narrowly to this one behavior, not a
 * full page test suite — the page's other paths (?center=, 1 unit, 2+ units,
 * the URL filters) live in `edit-reports-index-page-mode.test.tsx`. Also home to each
 * row's access text (`accessText`, computed on the server from the grant rows
 * via `listReportAccess`, read only when the row is shown; the rows
 * themselves never reach the client; unit rows get the unit rule), since this
 * is the scaffold that already drives the program row.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockNotFound,
  mockRedirect,
  mockLoadReportableUnits,
  mockReportsIndex,
  mockGetReportScopes,
  mockGetHighImpactScopes,
  mockListReportAccess,
  mockReportMetaFindMany,
  mockCanViewArticleCount,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockCanViewArticleCount: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
  mockLoadReportableUnits: vi.fn(),
  mockReportsIndex: vi.fn(() => null),
  mockGetReportScopes: vi.fn(),
  mockGetHighImpactScopes: vi.fn(),
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
vi.mock("@/lib/edit/report-access", () => {
  const whole = [["*", "Whole report"]];
  return {
    // Report 9's grant rides its own mock so the report 7 cases stay pinned.
    getReportScopes: (s: unknown, key: string) =>
      key === "high-impact-publications" ? mockGetHighImpactScopes(s, key) : mockGetReportScopes(s, key),
    listReportAccess: mockListReportAccess,
    canManageReportAccess: (s: { isSuperuser: boolean; isCommsSteward: boolean }) =>
      s.isSuperuser || s.isCommsSteward,
    MENTORED_PUBS_REPORT: "mentored-publications",
    ARTICLE_COUNT_REPORT: "article-count",
    HIGH_IMPACT_PUBS_REPORT: "high-impact-publications",
    ARTICLE_COUNT_ACCESS_NOTE: "admins note",
    WHOLE_REPORT_SCOPE_OPTIONS: whole,
    REPORT_ACCESS_SCOPE_OPTIONS: {
      "mentored-publications": [
        ["*", "All programs"],
        ["md", "AOC"],
      ],
      "article-count": whole,
      "high-impact-publications": whole,
    },
  };
});
// Report 8 (Article counts) rides the administrator gate — default: denied,
// so the pinned unit lists below stay exactly the program-row cases.
vi.mock("@/lib/edit/article-count-report", () => ({ canViewArticleCountReport: mockCanViewArticleCount }));
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
  mockGetHighImpactScopes.mockResolvedValue(new Set());
  mockListReportAccess.mockResolvedValue([]);
  mockReportMetaFindMany.mockResolvedValue([]);
  mockCanViewArticleCount.mockResolvedValue(false);
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

  it("an administrator (canViewArticleCountReport) with zero unit grants → the institution row (report 8) alone, no 404; its href never carries a unit", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockCanViewArticleCount.mockResolvedValue(true);
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockNotFound).not.toHaveBeenCalled();
    const index = findByType(result, mockReportsIndex);
    const units = index!.props.units as Array<{ kind: string; code: string; reports: Array<{ n: number; slug: string; accessText: string }> }>;
    expect(units.map((u) => u.kind)).toEqual(["institution"]);
    expect(units[0].reports.map((r) => r.n)).toEqual([8]);
    expect(units[0].reports[0].slug).toBe("article-count");
    // The report header's audience for report 8, not the person-mode default.
    expect(units[0].reports[0].accessText).toBe("All unit administrators");
  });

  it("a report 9 grant holder with zero unit grants → the institution row with report 9 alone", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockGetHighImpactScopes.mockResolvedValue(new Set(["*"]));
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockNotFound).not.toHaveBeenCalled();
    const units = findByType(result, mockReportsIndex)!.props.units as Array<{
      kind: string;
      editHref: string;
      reports: Array<{ n: number; accessText: string }>;
    }>;
    expect(units.map((u) => u.kind)).toEqual(["institution"]);
    expect(units[0].reports.map((r) => r.n)).toEqual([9]);
    expect(units[0].editHref).toBe("/edit/reports/high-impact-publications");
    expect(units[0].reports[0].accessText).toBe("Superusers and comms stewards");
  });

  it("scoped Owner/Curator with zero grants → still 404s", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    await expect(EditReportsIndexPage({ searchParams: sp() })).rejects.toThrow("__NOT_FOUND__");
    expect(mockReportsIndex).not.toHaveBeenCalled();
  });

  it("a report_access holder with zero unit grants → the index with the program row alone, no 404", async () => {
    mockGetEditSession.mockResolvedValue(CURATOR);
    mockGetReportScopes.mockResolvedValue(new Set(["md"]));
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(mockNotFound).not.toHaveBeenCalled();
    const index = findByType(result, mockReportsIndex);
    expect(index?.props.units).toEqual([
      expect.objectContaining({ kind: "program", reports: [expect.objectContaining({ n: 7 })] }),
    ]);
  });

  it("superuser (scopes '*') → the index carries the program row alongside the (empty) unit list", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const result = await EditReportsIndexPage({ searchParams: sp() });
    const index = findByType(result, mockReportsIndex);
    expect((index?.props.units as Array<{ kind: string }>).map((u) => u.kind)).toEqual(["program"]);
  });

  it("the program card's label, blurb and slug come from report_meta: defaults with no row, the row when present", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    const byDefault = await EditReportsIndexPage({ searchParams: sp() });
    expect(
      (findByType(byDefault, mockReportsIndex)?.props.units as Array<{ reports: unknown[] }>)[0]
        .reports,
    ).toEqual([
      {
        n: 7,
        slug: "mentored-publications",
        name: "Mentored publications",
        description: expect.stringContaining("Access is granted per person."),
        accessText: "Superusers and comms stewards",
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
        // The row's slug too, so the index links straight to the renamed address.
        slug: "mentee-co-publications",
        name: "Mentee co-publications",
        description: "Edited blurb.",
        accessText: "Superusers and comms stewards",
      },
    ]);
  });

  it("each row's access reaches the client as TEXT only — '+ N others' for the grant rows, never the rows themselves; unit rows get the unit rule; no read when the row is hidden", async () => {
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
      reports: Array<Record<string, unknown>>;
    }>;
    expect(holderUnits[0].reports[0].accessText).toBe("Superusers and comms stewards + 1 other");
    expect(holderUnits[0].reports[0]).not.toHaveProperty("access");
    // Nothing of the grantee — cwid, name, grantor — is in the client props.
    const payload = JSON.stringify(holderUnits);
    for (const leaked of ["usr0001", "Holder Person", "adm0001"]) expect(payload).not.toContain(leaked);

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
      reports: Array<{ n: number; accessText: string }>;
    }>;
    // Pseudo-units lead the list (Institution-wide, then Mentoring programs).
    expect(units.map((u) => u.kind)).toEqual(["program", "center", "center"]);
    expect(units[1].reports.map((r) => r.accessText)).toEqual(Array(6).fill("Unit owners and curators"));
    expect(units[0].reports[0].accessText).toBe("Superusers and comms stewards + 1 other");
  });

  it("group order: Institution-wide, then Mentoring programs, then units", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockGetReportScopes.mockResolvedValue(new Set(["*"]));
    mockCanViewArticleCount.mockResolvedValue(true);
    mockLoadReportableUnits.mockResolvedValue([{ code: "a", name: "A", kind: "center", centerType: "center" }]);
    const result = await EditReportsIndexPage({ searchParams: sp() });
    const units = findByType(result, mockReportsIndex)!.props.units as Array<{ kind: string }>;
    expect(units.map((u) => u.kind)).toEqual(["institution", "program", "center"]);
  });

  it("superuser with no report grant sees no program row when scopes are empty", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    const result = await EditReportsIndexPage({ searchParams: sp() });
    expect(findByType(result, mockReportsIndex)?.props.units).toEqual([]);
  });
});
