/**
 * `app/edit/reports/page.tsx` — the Reports Index redesign (2026-09-25): every
 * viewer gets ONE grouped list (`ReportsIndex`), whether they reach it with
 * `?center=`, one reportable unit or many; the page no longer picks a
 * table / bands / single-unit rendering. Pinned here: the unit set each path
 * hands the list, `hideUnderAll` (global viewers only, never for an explicit
 * `?center=`), the per-report liveness it serializes (report 2's cycle and
 * review count included), and the URL filters it passes through. Mirrors the
 * mocking scaffold of `edit-reports-index-page-gap5.test.tsx`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockGetEditSession,
  mockLoadReportableUnits,
  mockReportsIndex,
  mockLoadReportLiveness,
  mockLoadReportsContext,
  mockResolveCenter,
  mockForbidden,
} = vi.hoisted(() => ({
  mockGetEditSession: vi.fn(),
  mockLoadReportableUnits: vi.fn(),
  mockReportsIndex: vi.fn(() => null),
  mockLoadReportLiveness: vi.fn(),
  mockLoadReportsContext: vi.fn(),
  mockResolveCenter: vi.fn(),
  mockForbidden: vi.fn(() => null),
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
  loadReportLiveness: mockLoadReportLiveness,
  loadReportsContext: mockLoadReportsContext,
  resolveReportsCenterCode: mockResolveCenter,
  REPORT_NUMBERS_BY_KIND: {
    center: [1, 2, 3, 4, 5, 6],
    department: [3, 6],
    division: [3, 6],
    core: [3, 6],
  },
}));
vi.mock("@/components/edit/reports-index", () => ({ ReportsIndex: mockReportsIndex }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/edit/forbidden-edit-page", () => ({ ForbiddenEditPage: mockForbidden }));
vi.mock("@/lib/edit/honor-queue", () => ({
  isHonorsQueueTabVisible: () => false,
  countPendingHonors: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/slug-request", () => ({
  isSlugRequestEnabled: () => false,
  countPendingSlugRequests: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/edit/manageable-units", () => ({
  unitEditHref: (kind: string, code: string) => `/edit/${kind}/${code}`,
}));
vi.mock("@/lib/edit/report-access", () => ({
  getReportScopes: vi.fn().mockResolvedValue(new Set()),
  listReportAccess: vi.fn().mockResolvedValue([]),
  canManageReportAccess: () => false,
  MENTORED_PUBS_REPORT: "mentored-publications",
  MENTORED_PUBS_SCOPE_OPTIONS: [["*", "All programs"]],
  ARTICLE_COUNT_REPORT: "article-count",
  HIGH_IMPACT_PUBS_REPORT: "high-impact-publications",
  ARTICLE_COUNT_ACCESS_NOTE: "",
}));
vi.mock("@/lib/edit/article-count-report", () => ({
  canViewArticleCountReport: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: vi.fn().mockResolvedValue([]) } }, write: {} },
}));

import EditReportsIndexPage from "@/app/edit/reports/page";

const SUPERUSER = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
const STEWARD = { cwid: "cs001", isSuperuser: false, isCommsSteward: true };
const OWNER = { cwid: "own001", isSuperuser: false, isCommsSteward: false };
const TWO_UNITS = [
  { code: "a", name: "A", kind: "center" as const, centerType: "center" as const },
  { code: "surg", name: "Surgery", kind: "department" as const, centerType: null },
];

type El = { type: unknown; props: Record<string, unknown> };
function findByType(node: unknown, type: unknown): El | null {
  if (node === null || node === undefined || typeof node !== "object") return null;
  const el = node as El;
  if (el.type === type) return el;
  const children = el.props?.children;
  for (const c of Array.isArray(children) ? children : [children]) {
    const found = findByType(c, type);
    if (found) return found;
  }
  return null;
}
async function indexProps(searchParams: Record<string, string> = {}) {
  const result = await EditReportsIndexPage({ searchParams: Promise.resolve(searchParams) });
  const index = findByType(result, mockReportsIndex);
  expect(index).not.toBeNull();
  return index!.props as {
    units: Array<{
      code: string;
      kind: string;
      name: string;
      editHref: string;
      perReport: unknown[];
    }>;
    hideUnderAll: boolean;
    initialQuery: string;
    initialScope: string;
    initialReview: boolean;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadReportableUnits.mockResolvedValue(TWO_UNITS);
  mockLoadReportLiveness.mockResolvedValue(new Map());
});

describe("/edit/reports — one grouped list for every viewer", () => {
  it("superuser / comms steward with several units: the list, departments etc. off under All", async () => {
    for (const session of [SUPERUSER, STEWARD]) {
      mockGetEditSession.mockResolvedValue(session);
      const props = await indexProps();
      expect(props.units.map((u) => u.code)).toEqual(["a", "surg"]);
      expect(props.hideUnderAll).toBe(true);
    }
  });

  it("a scoped owner gets the same list, nothing hidden under All", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const props = await indexProps();
    expect(props.units.map((u) => [u.code, u.kind, u.editHref])).toEqual([
      ["a", "center", "/edit/center/a"],
      ["surg", "department", "/edit/department/surg"],
    ]);
    expect(props.hideUnderAll).toBe(false);
  });

  it("exactly one reportable unit → the same list with one group (no separate single-unit table)", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadReportableUnits.mockResolvedValue([TWO_UNITS[0]]);
    const props = await indexProps();
    expect(props.units.map((u) => u.code)).toEqual(["a"]);
  });

  it("?center= → one group named from the unit context; hideUnderAll off even for a superuser", async () => {
    mockGetEditSession.mockResolvedValue(SUPERUSER);
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Surgery" } });
    const props = await indexProps({ center: "surg", kind: "department" });
    expect(mockResolveCenter).not.toHaveBeenCalled();
    expect(mockLoadReportsContext).toHaveBeenCalledWith(
      "surg",
      SUPERUSER,
      expect.anything(),
      "department",
    );
    expect(props.units).toEqual([
      expect.objectContaining({
        code: "surg",
        kind: "department",
        name: "Surgery",
        editHref: "/edit/department/surg",
      }),
    ]);
    expect(props.hideUnderAll).toBe(false);
    expect(mockLoadReportableUnits).not.toHaveBeenCalled();
  });

  it("?center= a center resolves the code through the CenterProgram gate", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockResolveCenter.mockResolvedValue("meyer");
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer" } });
    const props = await indexProps({ center: "meyer-slug" });
    expect(props.units.map((u) => [u.code, u.kind])).toEqual([["meyer", "center"]]);
  });

  it("?center= the actor can't open → the forbidden page, no list", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockResolveCenter.mockResolvedValue("meyer");
    mockLoadReportsContext.mockResolvedValue(null);
    const result = await EditReportsIndexPage({
      searchParams: Promise.resolve({ center: "meyer" }),
    });
    expect(findByType(result, mockReportsIndex)).toBeNull();
    expect(findByType(result, mockForbidden)).not.toBeNull();
  });

  it("serializes per-report liveness, passing report 2's cycle and review count through", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadReportableUnits.mockResolvedValue([TWO_UNITS[0]]);
    const at = new Date("2026-07-14T00:00:00Z");
    mockLoadReportLiveness.mockResolvedValue(
      new Map([
        [
          "a",
          {
            perReport: [
              { n: 1, live: false, lastRefreshedAt: null },
              {
                n: 2,
                live: true,
                lastRefreshedAt: at,
                reportingCycle: "osra-2026-07-14",
                toReview: 58,
              },
            ],
            liveCount: 1,
            totalCount: 6,
            lastRefreshedAt: at,
          },
        ],
      ]),
    );
    const props = await indexProps();
    expect(props.units[0].perReport).toEqual([
      { n: 1, live: false, lastRefreshedAt: null },
      {
        n: 2,
        live: true,
        lastRefreshedAt: "2026-07-14T00:00:00.000Z",
        reportingCycle: "osra-2026-07-14",
        toReview: 58,
      },
    ]);
  });

  it("a unit with no liveness entry reads every report as not live", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const props = await indexProps();
    expect(props.units[1].perReport).toEqual([
      { n: 3, live: false, lastRefreshedAt: null },
      { n: 6, live: false, lastRefreshedAt: null },
    ]);
  });

  it("passes the URL filters through (q, scope, review=1); an unknown scope becomes All", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    const props = await indexProps({ q: "grants", scope: "department", review: "1" });
    expect([props.initialQuery, props.initialScope, props.initialReview]).toEqual([
      "grants",
      "department",
      true,
    ]);
    const bare = await indexProps({ scope: "nope" });
    expect([bare.initialQuery, bare.initialScope, bare.initialReview]).toEqual(["", "all", false]);
  });
});
