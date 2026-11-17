/**
 * Unit-scoped Usage (decision 2026-11-17): a department / division / center
 * admin sees the profile sections for their own people. Covers who is scoped,
 * the member slugs (current + `slug_history`), the per-viewer filter over rows
 * read once per range, the traffic list + export routes, the scoped edits
 * read, and that no slug list reaches Athena SQL or a cache key. All ids,
 * slugs and names are synthetic.
 */
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Grant = { cwid: string; entityType: string; entityId: string; role: string };

const h = vi.hoisted(() => ({
  grants: [] as Grant[],
  session: vi.fn(),
  runQuery: vi.fn(),
  cacheKeys: [] as string[][],
}));

const SCHOLARS = [
  { cwid: "aaa0001", deptCode: "N1000", slug: "member-one" },
  { cwid: "aaa0002", deptCode: "N1000", slug: "member-two" },
  { cwid: "bbb0001", deptCode: "N2000", slug: "outsider-one" },
];
const SLUG_HISTORY = [
  { oldSlug: "Member-One-Old", currentCwid: "aaa0001" },
  { oldSlug: "outsider-old", currentCwid: "bbb0001" },
];

type ScholarWhere = {
  cwid?: { in: string[] };
  AND?: Array<{ OR?: Array<{ deptCode?: { in: string[] } }>; cwid?: { in: string[] } }>;
};

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      unitAdmin: {
        findFirst: async ({ where }: { where: { cwid: string; entityType: { in: string[] } } }) =>
          h.grants.find((g) => g.cwid === where.cwid && where.entityType.in.includes(g.entityType)) ??
          null,
        findMany: async ({ where }: { where: { cwid: string } }) =>
          h.grants.filter((g) => g.cwid === where.cwid),
      },
      functionalRoleGrant: { findMany: async () => [] },
      department: { findMany: async () => [{ code: "N1000", name: "Department of Testing" }] },
      division: { findMany: async () => [] },
      center: { findMany: async () => [] },
      core: { findMany: async () => [{ id: "7", name: "Core Seven" }] },
      divisionMembership: { findMany: async () => [] },
      centerMembership: { findMany: async () => [] },
      scholar: {
        findMany: async ({ where }: { where: ScholarWhere }) => {
          if (where.cwid) return SCHOLARS.filter((s) => where.cwid!.in.includes(s.cwid));
          const scope = where.AND?.[0];
          if (!scope || scope.cwid) return [];
          return SCHOLARS.filter((s) => (scope.OR ?? []).some((o) => o.deptCode?.in.includes(s.deptCode)));
        },
      },
      slugHistory: {
        findMany: async ({ where }: { where: { currentCwid: { in: string[] } } }) =>
          SLUG_HISTORY.filter((r) => where.currentCwid.in.includes(r.currentCwid)),
      },
    },
    write: {},
  },
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/analytics/athena-client", () => ({ runUsageQuery: h.runQuery }));
// Pass-through cache that records each entry's key parts.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts: string[]) => () => {
    h.cacheKeys.push(keyParts);
    return fn();
  },
}));

import { GET as exportGET } from "@/app/api/edit/usage/traffic/export/route";
import { GET as listGET } from "@/app/api/edit/usage/traffic/route";
import { buildUsageQueries } from "@/lib/analytics/usage-queries";
import { loadEditsByHourUncached } from "@/lib/api/usage-edits";
import {
  type ProfileDayViews,
  loadProfileViewsByDay,
  scopeUsageSummary,
  shapeUsageRows,
} from "@/lib/api/usage-summary";
import {
  activityScopeSql,
  loadDashboardScope,
  loadScopeSlugs,
} from "@/lib/edit/dashboard-access";

const viewer = { cwid: "adm0001", isSuperuser: false, isCommsSteward: false };
const grant = (entityType: string, entityId: string, role = "owner"): Grant => ({
  cwid: "adm0001",
  entityType,
  entityId,
  role,
});
const WINDOW = { since: "2026-10-01", until: "2026-10-31", days: 31 };
const RANGE = "range=custom&from=2026-10-01&to=2026-10-31";
const MEMBER_STRINGS = ["member-one", "member-two", "aaa0001", "aaa0002", "adm0001", "N1000"];

/** The profile pages Athena holds for the range, site-wide, busiest first. */
const PAGE_ROWS = [
  { page: "/outsider-one", visits: "90", total: "4" },
  { page: "/member-one", visits: "40", total: "4" },
  { page: "/Member-One-Old", visits: "7", total: "4" },
  { page: "/member-two", visits: "5", total: "4" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.cacheKeys.length = 0;
  h.grants = [grant("department", "N1000")];
  h.session.mockResolvedValue(viewer);
  h.runQuery.mockResolvedValue([]);
});

describe("who is scoped on Usage", () => {
  it.each([
    ["department owner", [grant("department", "N1000")]],
    ["department curator", [grant("department", "N1000", "curator")]],
    ["department admin who also admins a core", [grant("department", "N1000"), grant("core", "7")]],
  ])("a %s sees their unit", async (_name, gs) => {
    h.grants = gs;
    expect(await loadDashboardScope(viewer as never, "usage")).toEqual({
      all: false,
      unitNames: ["Department of Testing"],
      unitCodes: ["N1000"],
      centerCodes: [],
      memberCwids: ["aaa0001", "aaa0002"],
    });
  });

  it.each([
    ["superuser", { isSuperuser: true }, [grant("department", "N1000")]],
    ["comms steward", { isCommsSteward: true }, [grant("department", "N1000")]],
    ["observer", { isObserver: true }, [grant("department", "N1000")]],
    ["content editor", { isContentEditor: true }, [grant("department", "N1000")]],
    ["core-only admin", {}, [grant("core", "7")]],
  ])("a %s keeps the site-wide view", async (_name, role, gs) => {
    h.grants = gs;
    expect(await loadDashboardScope({ ...viewer, ...role } as never, "usage")).toEqual({ all: true });
  });
});

describe("loadScopeSlugs", () => {
  it("maps current and former slugs (lower-cased) to the current slug", async () => {
    const slugs = await loadScopeSlugs(["aaa0001", "aaa0002"]);
    expect([...slugs]).toEqual([
      ["member-one-old", "member-one"],
      ["member-one", "member-one"],
      ["member-two", "member-two"],
    ]);
  });

  it("no members, no slugs (and no read)", async () => {
    expect((await loadScopeSlugs([])).size).toBe(0);
  });
});

describe("profile views by day and slug", () => {
  it("the query reads every slug once per range and names none", () => {
    const sql = buildUsageQueries("2026-10-01", "2026-10-31").profileViewsByDay;
    expect(sql).toBe(
      [
        "SELECT dt, dimension AS slug, SUM(cnt) AS views",
        "FROM daily_usage",
        "WHERE metric = 'profile' AND dt >= '2026-10-01' AND dt <= '2026-10-31'",
        "GROUP BY dt, dimension",
      ].join("\n"),
    );
    expect(sql).not.toContain(" IN ");
    expect(sql).not.toContain("LIMIT");
  });

  it("is cached per range, under a key that names no viewer", async () => {
    h.runQuery.mockResolvedValueOnce([{ dt: "2026-10-02", slug: "member-one", views: "3" }]);
    expect(await loadProfileViewsByDay(WINDOW)).toEqual([["2026-10-02", "member-one", 3]]);
    expect(h.cacheKeys).toEqual([["usage-profile-views-by-day", "v1", "2026-10-01", "2026-10-31"]]);
  });
});

describe("scopeUsageSummary", () => {
  const site = shapeUsageRows(
    {
      pageviewsByDay: [{ dt: "2026-10-01", views: "500" }],
      topProfiles: [{ slug: "outsider-one", views: "400" }],
      searchTerms: [{ term: "cancer", searches: "9" }],
      suggestedSearchTerms: [],
      searchTotals: [{ metric: "typed", searches: "9" }],
      geo: [{ region: "US", hits: "70" }],
      device: [{ device: "desktop", hits: "70" }],
      hourly: [],
    },
    WINDOW,
  );
  const rows: ProfileDayViews[] = [
    ["2026-10-02", "member-two", 4],
    ["2026-10-01", "member-one", 10],
    ["2026-10-01", "outsider-one", 300],
    ["2026-10-02", "Member-One-Old", 6],
    ["2026-10-02", "MEMBER-ONE", 1],
    ["2026-10-03", "outsider-one", 100],
  ];
  const slugs = new Map([
    ["member-one", "member-one"],
    ["member-one-old", "member-one"],
    ["member-two", "member-two"],
  ]);

  it("keeps only the viewer's people, by day and by profile, former slugs under the current one", () => {
    const unit = scopeUsageSummary(site, rows, slugs);
    expect(unit.totalPageviews).toBe(21);
    expect(unit.pageviewsByDay).toEqual([
      { day: "2026-10-01", views: 10 },
      { day: "2026-10-02", views: 11 },
    ]);
    expect(unit.topProfiles).toEqual([
      { slug: "member-one", views: 17 },
      { slug: "member-two", views: 4 },
    ]);
  });

  it("leaves the site-wide fields alone", () => {
    const unit = scopeUsageSummary(site, rows, slugs);
    expect(unit.searchTerms).toBe(site.searchTerms);
    expect(unit.searchVolume).toBe(site.searchVolume);
    expect(unit.geo).toBe(site.geo);
    expect(unit.device).toBe(site.device);
    expect(unit.hourly).toBe(site.hourly);
  });

  it("lists every profile of the unit, not the site-wide top 25", () => {
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`m-${i}`, `m-${i}`] as const));
    const manyRows = [...many.keys()].map((s, i): ProfileDayViews => ["2026-10-01", s, i + 1]);
    expect(scopeUsageSummary(site, manyRows, many).topProfiles).toHaveLength(40);
  });

  it("a unit with no people has no views, never the site-wide ones", () => {
    const none = scopeUsageSummary(site, rows, new Map());
    expect(none.totalPageviews).toBe(0);
    expect(none.pageviewsByDay).toEqual([]);
    expect(none.topProfiles).toEqual([]);
  });
});

describe("GET /api/edit/usage/traffic (pages list)", () => {
  const list = (qs: string) =>
    listGET(new NextRequest(`http://localhost/api/edit/usage/traffic?${RANGE}&${qs}`));

  it("a unit admin gets only their people's profile pages, former slugs included", async () => {
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    const res = await list("list=pages&kind=all");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        { label: "/member-one", visits: 40 },
        { label: "/Member-One-Old", visits: 7 },
        { label: "/member-two", visits: 5 },
      ],
      total: 3,
    });
  });

  it("the read is site-wide and unpaged: no slug in the SQL or the cache key", async () => {
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    await list("list=pages&kind=all&cats=WCM");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const sql = h.runQuery.mock.calls[0][0] as string;
    expect(sql).toContain("metric = 'landing'");
    expect(sql).toContain("regexp_like(page, '^/[^/]+$')");
    expect(sql).not.toContain("LIMIT");
    const cached = JSON.stringify(h.cacheKeys);
    for (const s of MEMBER_STRINGS) {
      expect(sql).not.toContain(s);
      expect(cached).not.toContain(s);
    }
    expect(h.cacheKeys).toEqual([
      ["usage-traffic-profile-pages", "v1", "2026-10-01", "2026-10-31", '[["WCM"],[]]'],
    ]);
  });

  it("pages in the app, after the unit filter", async () => {
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    const body = (await (await list("list=pages&offset=2")).json()) as { rows: unknown[]; total: number };
    expect(body).toEqual({ rows: [{ label: "/member-two", visits: 5 }], total: 3 });
  });

  it("request parameters cannot widen the scope", async () => {
    h.runQuery.mockResolvedValue(PAGE_ROWS);
    const res = await list("list=pages&kind=all&scope=all&all=true&unit=N2000&cwid=bbb0001&slugs=outsider-one");
    const body = (await res.json()) as { rows: Array<{ label: string }> };
    expect(body.rows.map((r) => r.label)).toEqual(["/member-one", "/Member-One-Old", "/member-two"]);
  });

  it("a page type with no unit pages is empty, and reads nothing", async () => {
    for (const kind of ["home", "topics", "methods"]) {
      expect(await (await list(`list=pages&kind=${kind}`)).json()).toEqual({ rows: [], total: 0 });
    }
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("referrer lists stay site-wide for a unit admin", async () => {
    h.runQuery.mockResolvedValueOnce([{ ref: "www.example.org", category: "Other", visits: "3", total: "1" }]);
    const res = await list("list=referrers");
    expect(await res.json()).toEqual({
      rows: [{ label: "www.example.org", category: "Other", visits: 3 }],
      total: 1,
    });
    expect(h.runQuery.mock.calls[0][0]).toContain("OFFSET 0 LIMIT 25");
  });

  it("a site-wide viewer's pages list is the paged Athena read, as before", async () => {
    h.session.mockResolvedValue({ ...viewer, isSuperuser: true });
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    const body = (await (await list("list=pages&kind=all")).json()) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(4);
    expect(body.total).toBe(4);
    const sql = h.runQuery.mock.calls[0][0] as string;
    expect(sql).toContain("WHERE TRUE");
    expect(sql).toContain("OFFSET 0 LIMIT 25");
  });
});

describe("GET /api/edit/usage/traffic/export", () => {
  const LANDING_ROWS = [
    { source: "WCM", referrer_host: "www.example.org", page: "/outsider-one", visits: "9" },
    { source: "WCM", referrer_host: "www.example.org", page: "/member-two", visits: "2" },
    { source: "crawler", referrer_host: "", page: "/topics/alpha", visits: "8" },
  ];
  const workbook = async () => {
    h.runQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT source, referrer_host")) return LANDING_ROWS;
      if (sql.startsWith("SELECT page, visits")) return [...PAGE_ROWS, { page: "/topics/alpha", visits: "60" }];
      return [];
    });
    const res = await exportGET(
      new NextRequest(`http://localhost/api/edit/usage/traffic/export?${RANGE}&scope=all&unit=N2000`),
    );
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const column = (sheet: string, col: number) =>
      (wb.getWorksheet(sheet)!.getColumn(col).values as unknown[]).slice(2);
    return { wb, column };
  };

  it("a unit admin's page sheets hold only their people's profile pages, and the Summary says so", async () => {
    const { column } = await workbook();
    expect(column("Top pages", 1)).toEqual(["/member-one", "/Member-One-Old", "/member-two"]);
    expect(column("Landing pages", 3)).toEqual(["/member-two"]);
    expect(column("Summary", 1)).toContain("Top pages and Landing pages sheets");
    expect(column("Summary", 2)).toContain(
      "Profile pages of Department of Testing only. Every other sheet is site-wide.",
    );
  });

  it("a site-wide viewer's workbook is unchanged", async () => {
    h.session.mockResolvedValue({ ...viewer, isSuperuser: true });
    const { column } = await workbook();
    expect(column("Top pages", 1)).toHaveLength(5);
    expect(column("Landing pages", 3)).toHaveLength(3);
    expect(column("Summary", 1)).not.toContain("Top pages and Landing pages sheets");
  });
});

describe("the edits line", () => {
  it("a scoped read binds the viewer's scope predicate", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const client = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ sql: strings.join("?").replace(/\s+/g, " "), values });
        return [];
      },
    } as never;
    const filter = activityScopeSql(await loadDashboardScope(viewer as never, "usage"));
    await loadEditsByHourUncached(client, "2026-10-01", "2026-10-31", filter);
    await loadEditsByHourUncached(client, "2026-10-01", "2026-10-31");
    expect(calls[0]!.sql).toContain("NOT LIKE 'bulk-%') AND (?) GROUP BY hour");
    expect(calls[0]!.values[2]).toBe(filter);
    expect(filter!.values).toEqual(["aaa0001", "aaa0002", "N1000"]);
    // No scope: a bound always-true 1, every person's edits as before.
    expect(calls[1]!.values[2]).toBe(1);
  });
});
