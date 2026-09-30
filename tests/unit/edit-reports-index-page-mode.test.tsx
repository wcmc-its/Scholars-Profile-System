/**
 * `app/edit/reports/page.tsx` — the Reports Index redesign (2026-09-25): every
 * viewer gets ONE grouped list (`ReportsIndex`), whether they reach it with
 * `?center=`, one reportable unit or many; the page no longer picks a
 * table / bands / single-unit rendering. Pinned here: the unit set each path
 * hands the list, `hideUnderAll` (global viewers only), the per-report
 * liveness it serializes (report 2's cycle and review count included), the
 * per-kind groups with their pickers (#2857 cores, #2856 the rest), and the
 * URL filters it passes through. Mirrors the
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

  it("?center= a unit off the actor's roster → the per-unit gate decides, and it joins the full list", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Pediatric Surgery" } });
    const props = await indexProps({ center: "peds", kind: "division" });
    expect(mockResolveCenter).not.toHaveBeenCalled();
    expect(mockLoadReportsContext).toHaveBeenCalledWith(
      "peds",
      OWNER,
      expect.anything(),
      "division",
    );
    expect(props.units.map((u) => [u.code, u.kind, u.name, u.editHref])).toEqual([
      ["a", "center", "A", "/edit/center/a"],
      ["surg", "department", "Surgery", "/edit/department/surg"],
      ["peds", "division", "Pediatric Surgery", "/edit/division/peds"],
    ]);
    expect(props.initialScope).toBe("division");
  });

  it("?center= a center off the roster resolves the code through the CenterProgram gate", async () => {
    mockGetEditSession.mockResolvedValue(OWNER);
    mockResolveCenter.mockResolvedValue("meyer");
    mockLoadReportsContext.mockResolvedValue({ unit: { name: "Meyer" } });
    const props = await indexProps({ center: "meyer-slug" });
    expect(mockLoadReportsContext).toHaveBeenCalledWith(
      "meyer",
      OWNER,
      expect.anything(),
      "center",
    );
    // Two centers now: one "Centers" group, on the one the link named.
    expect(props.units.map((u) => [u.code, u.kind, u.name])).toEqual([
      ["meyer", "center", "Centers"],
      ["surg", "department", "Surgery"],
    ]);
    expect(props.initialScope).toBe("center");
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

  describe("cores collapse into one group with a picker", () => {
    const CORES = [
      { code: "c-zeta", name: "Zeta Imaging Core", kind: "core" as const, centerType: null },
      { code: "c-alpha", name: "Alpha Flow Core", kind: "core" as const, centerType: null },
      { code: "c-mid", name: "Mid Sequencing Core", kind: "core" as const, centerType: null },
    ];
    type CoresProps = { unitOptions?: Array<{ code: string; name: string; editHref: string }> };

    it("N cores → ONE group where the first core sat, options A–Z, on the first alphabetically", async () => {
      mockGetEditSession.mockResolvedValue(SUPERUSER);
      mockLoadReportableUnits.mockResolvedValue([TWO_UNITS[0], ...CORES, TWO_UNITS[1]]);
      const props = await indexProps();
      expect(props.units.map((u) => [u.code, u.name])).toEqual([
        ["a", "A"],
        ["c-alpha", "Cores"],
        ["surg", "Surgery"],
      ]);
      const group = props.units[1] as (typeof props.units)[number] & CoresProps;
      expect(group.editHref).toBe("/edit/core/c-alpha");
      // A superuser's list opens with "All cores (N)" — never the default.
      expect(group.unitOptions!.map((o) => [o.code, o.name, o.editHref])).toEqual([
        ["all", "All cores (3)", ""],
        ["c-alpha", "Alpha Flow Core", "/edit/core/c-alpha"],
        ["c-mid", "Mid Sequencing Core", "/edit/core/c-mid"],
        ["c-zeta", "Zeta Imaging Core", "/edit/core/c-zeta"],
      ]);
      expect(mockLoadReportLiveness).toHaveBeenCalledWith(
        expect.arrayContaining(CORES.map((c) => ({ code: c.code, kind: "core" }))),
        expect.anything(),
      );
      expect(props.initialScope).toBe("all");
    });

    it("?center=<coreId>&kind=core → the full list on that core, opening on Cores", async () => {
      mockGetEditSession.mockResolvedValue(SUPERUSER);
      mockLoadReportableUnits.mockResolvedValue([TWO_UNITS[0], ...CORES]);
      const props = await indexProps({ center: "c-mid", kind: "core" });
      expect(mockLoadReportsContext).not.toHaveBeenCalled();
      expect(props.units.map((u) => [u.code, u.name])).toEqual([
        ["a", "A"],
        ["c-mid", "Cores"],
      ]);
      expect(props.units[1].editHref).toBe("/edit/core/c-mid");
      expect(props.initialScope).toBe("core");
      // The full index, so a global viewer's cores stay off under All.
      expect(props.hideUnderAll).toBe(true);
      // An explicit scope wins.
      const explicit = await indexProps({ center: "c-mid", kind: "core", scope: "all" });
      expect(explicit.initialScope).toBe("all");
    });

    it("?center= a core the actor can't report on → the forbidden page, no list", async () => {
      mockGetEditSession.mockResolvedValue(OWNER);
      mockLoadReportableUnits.mockResolvedValue([CORES[0]]);
      const result = await EditReportsIndexPage({
        searchParams: Promise.resolve({ center: "c-other", kind: "core" }),
      });
      expect(findByType(result, mockReportsIndex)).toBeNull();
      expect(findByType(result, mockForbidden)).not.toBeNull();
    });

    it("superuser, ?center=all&kind=core → the Cores group on All cores: 11–13 only, live if any core is", async () => {
      mockGetEditSession.mockResolvedValue(SUPERUSER);
      mockLoadReportableUnits.mockResolvedValue([TWO_UNITS[0], ...CORES]);
      mockLoadReportLiveness.mockResolvedValue(
        new Map([["c-mid", { perReport: [{ n: 11, live: true, lastRefreshedAt: null }] }]]),
      );
      const props = await indexProps({ center: "all", kind: "core" });
      expect(mockForbidden).not.toHaveBeenCalled();
      const group = props.units[1] as (typeof props.units)[number] &
        CoresProps & { onlyReports?: number[] };
      expect([group.code, group.name, group.editHref]).toEqual(["all", "Cores", ""]);
      expect(group.onlyReports).toEqual([11, 12, 13]);
      expect(group.perReport).toEqual([
        { n: 11, live: true, lastRefreshedAt: null },
        { n: 12, live: false, lastRefreshedAt: null },
        { n: 13, live: false, lastRefreshedAt: null },
      ]);
      expect(props.initialScope).toBe("core");
    });

    it.each([
      ["a comms steward", STEWARD],
      ["an owner of several cores", OWNER],
    ])("%s: no All cores option, and ?center=all is refused", async (_who, session) => {
      mockGetEditSession.mockResolvedValue(session);
      mockLoadReportableUnits.mockResolvedValue(CORES);
      const props = await indexProps();
      const group = props.units[0] as (typeof props.units)[number] & CoresProps;
      expect(group.unitOptions!.map((o) => o.code)).toEqual(["c-alpha", "c-mid", "c-zeta"]);
      const result = await EditReportsIndexPage({
        searchParams: Promise.resolve({ center: "all", kind: "core" }),
      });
      expect(findByType(result, mockReportsIndex)).toBeNull();
      expect(findByType(result, mockForbidden)).not.toBeNull();
    });

    it("an owner of one core: the group keeps the core's name, one option", async () => {
      mockGetEditSession.mockResolvedValue(OWNER);
      mockLoadReportableUnits.mockResolvedValue([CORES[0]]);
      const props = await indexProps();
      const group = props.units[0] as (typeof props.units)[number] & CoresProps;
      expect([group.code, group.name]).toEqual(["c-zeta", "Zeta Imaging Core"]);
      expect(group.unitOptions).toHaveLength(1);
    });
  });

  describe.each([
    ["department", "Departments"],
    ["division", "Divisions"],
    ["center", "Centers"],
  ] as const)("%s units collapse into one group with a picker (#2856)", (kind, heading) => {
    const OF_KIND = [
      { code: `${kind}-z`, name: "Zeta Unit", kind, centerType: null },
      { code: `${kind}-a`, name: "Alpha Unit", kind, centerType: null },
      { code: `${kind}-m`, name: "Mid Unit", kind, centerType: null },
    ];
    const INST = { code: "inst", name: "Institute", kind: "center" as const, centerType: null };
    const DEPT = { code: "dept", name: "Dept", kind: "department" as const, centerType: null };
    // Something of another kind in front, so "where the first sat" is visible.
    const other = kind === "center" ? DEPT : INST;
    type Group = { unitOptions?: Array<{ code: string; name: string; editHref: string }> };

    it(`N units → ONE "${heading}" group where the first sat, options A–Z, on the first alphabetically; no All option`, async () => {
      mockGetEditSession.mockResolvedValue(SUPERUSER);
      mockLoadReportableUnits.mockResolvedValue([other, ...OF_KIND]);
      const props = await indexProps();
      expect(props.units.map((u) => [u.code, u.name])).toEqual([
        [other.code, other.name],
        [`${kind}-a`, heading],
      ]);
      const group = props.units[1] as (typeof props.units)[number] & Group;
      expect(group.editHref).toBe(`/edit/${kind}/${kind}-a`);
      expect(group.unitOptions!.map((o) => [o.code, o.name, o.editHref])).toEqual([
        [`${kind}-a`, "Alpha Unit", `/edit/${kind}/${kind}-a`],
        [`${kind}-m`, "Mid Unit", `/edit/${kind}/${kind}-m`],
        [`${kind}-z`, "Zeta Unit", `/edit/${kind}/${kind}-z`],
      ]);
      expect(props.initialScope).toBe("all");
    });

    it(`?center=<code>&kind=${kind} → the full list on that unit, opening on its segment`, async () => {
      mockGetEditSession.mockResolvedValue(SUPERUSER);
      mockLoadReportableUnits.mockResolvedValue([other, ...OF_KIND]);
      const props = await indexProps({ center: `${kind}-m`, kind });
      expect(mockLoadReportsContext).not.toHaveBeenCalled();
      expect(mockResolveCenter).not.toHaveBeenCalled();
      expect(props.units.map((u) => [u.code, u.name])).toEqual([
        [other.code, other.name],
        [`${kind}-m`, heading],
      ]);
      expect(props.units[1].editHref).toBe(`/edit/${kind}/${kind}-m`);
      expect(props.initialScope).toBe(kind);
      expect(props.hideUnderAll).toBe(true);
    });

    it(`?center= a ${kind} the actor can't report on → the forbidden page, no list`, async () => {
      mockGetEditSession.mockResolvedValue(OWNER);
      mockLoadReportableUnits.mockResolvedValue([OF_KIND[0]]);
      mockResolveCenter.mockResolvedValue(`${kind}-other`);
      mockLoadReportsContext.mockResolvedValue(null);
      const result = await EditReportsIndexPage({
        searchParams: Promise.resolve({ center: `${kind}-other`, kind }),
      });
      expect(findByType(result, mockReportsIndex)).toBeNull();
      expect(findByType(result, mockForbidden)).not.toBeNull();
    });

    it(`an owner of one ${kind}: the group keeps the unit's name, one option`, async () => {
      mockGetEditSession.mockResolvedValue(OWNER);
      mockLoadReportableUnits.mockResolvedValue([OF_KIND[0]]);
      const props = await indexProps();
      const group = props.units[0] as (typeof props.units)[number] & Group;
      expect([group.code, group.name]).toEqual([`${kind}-z`, "Zeta Unit"]);
      expect(group.unitOptions).toHaveLength(1);
    });
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
