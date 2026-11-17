/**
 * Unit-scoped Usage (decision 2026-11-17): a department / division / center
 * admin sees the profile sections for their own people. Covers who is scoped,
 * the member slugs (current + `slug_history`), the aggregated Athena reads
 * over the unit's slugs (allowlist, chunking, cache key, no read for an empty
 * unit), the traffic list + export routes, and the scoped edits read. All
 * ids, slugs and names are synthetic.
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
  // Never a real slug shape: must be dropped before any SQL is built.
  { oldSlug: "x' OR '1'='1", currentCwid: "aaa0002" },
];
const HOSTILE = "x' or '1'='1";

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
import { buildLandingExportQuery, buildPageListQuery } from "@/lib/analytics/traffic-queries";
import {
  SAFE_SLUG,
  SAFE_SLUG_MAX_LENGTH,
  SLUG_LIST_MAX_BYTES,
  buildScopedProfileQueries,
  buildUsageQueries,
  chunkSlugs,
  safeSlugs,
  slugListKey,
  slugSqlList,
} from "@/lib/analytics/usage-queries";
import { loadEditsByHourUncached } from "@/lib/api/usage-edits";
import {
  type ScopedProfileViews,
  loadScopedProfileViews,
  scopeUsageSummary,
  shapeUsageRows,
} from "@/lib/api/usage-summary";
import { SLUG_MAX_LENGTH, SLUG_PATTERN } from "@/lib/edit/validators";
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
const UNIT_SLUGS = ["member-one", "member-one-old", "member-two"];
const UNIT_KEY = slugListKey(UNIT_SLUGS);
const UNIT_PATHS = "lower(page) IN ('/member-one', '/member-one-old', '/member-two')";
/** Every SQL string sent to Athena so far. */
const sqls = () => h.runQuery.mock.calls.map((c) => c[0] as string);

/** The unit's profile pages as Athena returns them for the slug filter. */
const PAGE_ROWS = [
  { page: "/member-one", visits: "40", total: "3" },
  { page: "/Member-One-Old", visits: "7", total: "3" },
  { page: "/member-two", visits: "5", total: "3" },
];
/** What a site-wide viewer's unfiltered read returns. */
const SITE_PAGE_ROWS = [{ page: "/outsider-one", visits: "90", total: "4" }, ...PAGE_ROWS];

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
      [HOSTILE, "member-two"],
      ["member-one", "member-one"],
      ["member-two", "member-two"],
    ]);
  });

  it("no members, no slugs (and no read)", async () => {
    expect((await loadScopeSlugs([])).size).toBe(0);
  });
});

describe("slugs inlined into Athena SQL", () => {
  it("the allowlist is the slug validator's own shape", () => {
    expect(SAFE_SLUG.source).toBe(SLUG_PATTERN.source);
    expect(SAFE_SLUG_MAX_LENGTH).toBe(SLUG_MAX_LENGTH);
  });

  it("safeSlugs drops anything else, de-duplicates and sorts", () => {
    expect(
      safeSlugs([
        "member-two",
        "member-one",
        "member-one",
        HOSTILE,
        "a'b",
        'a"b',
        "a;b",
        "a b",
        "a\\b",
        "a/b",
        "a%b",
        "a_b",
        "a--",
        "-a",
        "Member",
        "",
        "a".repeat(65),
      ]),
    ).toEqual(["member-one", "member-two"]);
  });

  it("the SQL builders refuse a slug the allowlist would drop", () => {
    for (const bad of [HOSTILE, "a'b", "a)b", "Member"]) {
      expect(() => slugSqlList([bad])).toThrow("invalid_slug");
      expect(() => buildScopedProfileQueries("2026-10-01", "2026-10-31", ["ok", bad])).toThrow(
        "invalid_slug",
      );
      expect(() =>
        buildPageListQuery({
          ...WINDOW,
          kind: "profile",
          categories: [],
          aiClasses: [],
          slugs: [bad],
          offset: 0,
          limit: null,
        }),
      ).toThrow("invalid_slug");
      expect(() => buildLandingExportQuery("2026-10-01", "2026-10-31", [bad])).toThrow("invalid_slug");
    }
  });

  it("chunks a long list so no query nears Athena's 262,144-byte limit", () => {
    const many = Array.from({ length: 20_000 }, (_, i) => `scholar-${String(i).padStart(6, "0")}-x`);
    const chunks = chunkSlugs(many);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(many);
    for (const chunk of chunks) {
      expect(slugSqlList(chunk, "/").length).toBeLessThanOrEqual(SLUG_LIST_MAX_BYTES);
      const q = buildScopedProfileQueries("2026-10-01", "2026-10-31", chunk);
      const landing = buildLandingExportQuery("2026-10-01", "2026-10-31", chunk);
      for (const sql of [q.byDay, q.byProfile, landing]) expect(sql.length).toBeLessThan(200_000);
    }
    expect(chunkSlugs([])).toEqual([]);
    expect(chunkSlugs(["a"])).toEqual([["a"]]);
  });

  it("the key is a hash of the sorted list: same unit, same key, whatever the order", () => {
    expect(slugListKey(["b", "a"])).toBe(slugListKey(["a", "b"]));
    expect(slugListKey(["a", "b"])).not.toBe(slugListKey(["a", "c"]));
    expect(slugListKey(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the unit's profile views", () => {
  it("the queries aggregate in Athena: one row per day, one per slug", () => {
    const q = buildScopedProfileQueries("2026-10-01", "2026-10-31", ["member-one", "member-two"]);
    const where =
      "WHERE metric = 'profile' AND dt >= '2026-10-01' AND dt <= '2026-10-31' AND lower(dimension) IN ('member-one', 'member-two')";
    expect(q.byDay).toBe(
      ["SELECT dt, SUM(cnt) AS views", "FROM daily_usage", where, "GROUP BY dt"].join("\n"),
    );
    expect(q.byProfile).toBe(
      [
        "SELECT lower(dimension) AS slug, SUM(cnt) AS views",
        "FROM daily_usage",
        where,
        "GROUP BY lower(dimension)",
      ].join("\n"),
    );
  });

  it("the site-wide query set no longer carries a per-slug read", () => {
    expect(Object.keys(buildUsageQueries("2026-10-01", "2026-10-31"))).not.toContain(
      "profileViewsByDay",
    );
  });

  it("reads both aggregates for the unit's slugs and never inlines a hostile one", async () => {
    h.runQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT dt")
        ? [{ dt: "2026-10-02", views: "11" }]
        : [{ slug: "member-one", views: "11" }],
    );
    const slugs = await loadScopeSlugs(["aaa0001", "aaa0002"]);
    expect(slugs.has(HOSTILE)).toBe(true);
    const views = await loadScopedProfileViews(WINDOW, slugs.keys());
    expect(views).toEqual({
      byDay: [{ day: "2026-10-02", views: 11 }],
      bySlug: [{ slug: "member-one", views: 11 }],
    });
    expect(sqls()).toHaveLength(2);
    for (const sql of sqls()) {
      expect(sql).toContain("lower(dimension) IN ('member-one', 'member-one-old', 'member-two')");
      expect(sql).not.toContain("1'='1");
      expect(sql).not.toContain(" or ");
      // Every quote in the query delimits a literal we wrote: an even count.
      expect((sql.match(/'/g) ?? []).length % 2).toBe(0);
    }
  });

  it("is cached per range + slug set, under a key that names no viewer or slug", async () => {
    await loadScopedProfileViews(WINDOW, ["member-two", "member-one", "member-one-old"]);
    await loadScopedProfileViews(WINDOW, UNIT_SLUGS);
    expect(h.cacheKeys).toEqual([
      ["usage-scoped-profile-views", "v1", "2026-10-01", "2026-10-31", UNIT_KEY],
      ["usage-scoped-profile-views", "v1", "2026-10-01", "2026-10-31", UNIT_KEY],
    ]);
    expect(JSON.stringify(h.cacheKeys)).not.toContain("member");
    expect(JSON.stringify(h.cacheKeys)).not.toContain("usage-summary");
  });

  it("no slugs (or none that pass): zeros, no Athena call, nothing cached", async () => {
    expect(await loadScopedProfileViews(WINDOW, [])).toEqual({ byDay: [], bySlug: [] });
    expect(await loadScopedProfileViews(WINDOW, [HOSTILE])).toEqual({ byDay: [], bySlug: [] });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.cacheKeys).toEqual([]);
  });

  it("an Athena error propagates, so a failed read is never cached as empty", async () => {
    h.runQuery.mockRejectedValue(new Error("athena down"));
    await expect(loadScopedProfileViews(WINDOW, UNIT_SLUGS)).rejects.toThrow("athena down");
  });

  it("sums the chunks of a list too long for one query", async () => {
    const many = Array.from({ length: 12_000 }, (_, i) => `scholar-${String(i).padStart(6, "0")}-x`);
    const chunks = chunkSlugs(many).length;
    expect(chunks).toBeGreaterThan(1);
    h.runQuery.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT dt")
        ? [{ dt: "2026-10-02", views: "5" }]
        : [{ slug: sql.includes("'scholar-000000-x'") ? "scholar-000000-x" : "scholar-011999-x", views: "5" }],
    );
    const views = await loadScopedProfileViews(WINDOW, many);
    expect(h.runQuery).toHaveBeenCalledTimes(2 * chunks);
    expect(views.byDay).toEqual([{ day: "2026-10-02", views: 5 * chunks }]);
    expect(views.bySlug.reduce((sum, r) => sum + r.views, 0)).toBe(5 * chunks);
    for (const sql of sqls()) expect(sql.length).toBeLessThan(200_000);
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
  const views: ScopedProfileViews = {
    byDay: [
      { day: "2026-10-02", views: 11 },
      { day: "2026-10-01", views: 10 },
    ],
    bySlug: [
      { slug: "member-two", views: 4 },
      { slug: "member-one", views: 11 },
      { slug: "member-one-old", views: 6 },
    ],
  };
  const slugs = new Map([
    ["member-one", "member-one"],
    ["member-one-old", "member-one"],
    ["member-two", "member-two"],
  ]);

  it("replaces the profile numbers with the unit's, former slugs under the current one", () => {
    const unit = scopeUsageSummary(site, views, slugs);
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
    const unit = scopeUsageSummary(site, views, slugs);
    expect(unit.searchTerms).toBe(site.searchTerms);
    expect(unit.searchVolume).toBe(site.searchVolume);
    expect(unit.geo).toBe(site.geo);
    expect(unit.device).toBe(site.device);
    expect(unit.hourly).toBe(site.hourly);
  });

  it("lists every profile of the unit, not the site-wide top 25", () => {
    const many = new Map(Array.from({ length: 40 }, (_, i) => [`m-${i}`, `m-${i}`] as const));
    const bySlug = [...many.keys()].map((slug, i) => ({ slug, views: i + 1 }));
    expect(scopeUsageSummary(site, { byDay: [], bySlug }, many).topProfiles).toHaveLength(40);
  });

  it("a unit with no views has none, never the site-wide ones", () => {
    const none = scopeUsageSummary(site, { byDay: [], bySlug: [] }, new Map());
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

  it("the unit filter runs in Athena, over allowlisted slugs from our DB only", async () => {
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    await list("list=pages&kind=all&cats=WCM");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const sql = sqls()[0];
    expect(sql).toContain("metric = 'landing'");
    expect(sql).toContain("regexp_like(page, '^/[^/]+$')");
    expect(sql).toContain(UNIT_PATHS);
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("1'='1");
    expect(h.cacheKeys).toEqual([
      ["usage-traffic-scoped-pages", "v1", "2026-10-01", "2026-10-31", '[["WCM"],[]]', UNIT_KEY],
    ]);
    for (const s of ["member", "aaa0001", "adm0001", "N1000"]) {
      expect(JSON.stringify(h.cacheKeys)).not.toContain(s);
    }
  });

  it("pages in the app, over the unit's rows", async () => {
    h.runQuery.mockResolvedValueOnce(PAGE_ROWS);
    const body = (await (await list("list=pages&offset=2")).json()) as { rows: unknown[]; total: number };
    expect(body).toEqual({ rows: [{ label: "/member-two", visits: 5 }], total: 3 });
  });

  it("request parameters cannot widen the scope or reach the SQL", async () => {
    h.runQuery.mockResolvedValue(PAGE_ROWS);
    await list("list=pages&kind=all&scope=all&all=true&unit=N2000&cwid=bbb0001&slugs=outsider-one&slug=outsider-one");
    expect(sqls()).toHaveLength(1);
    expect(sqls()[0]).toContain(UNIT_PATHS);
    expect(sqls()[0]).not.toContain("outsider");
  });

  it("a page type with no unit pages is empty, and reads nothing", async () => {
    for (const kind of ["home", "topics", "methods"]) {
      expect(await (await list(`list=pages&kind=${kind}`)).json()).toEqual({ rows: [], total: 0 });
    }
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("a unit with no people is empty, and reads nothing", async () => {
    h.grants = [grant("department", "N9999")];
    expect(await (await list("list=pages&kind=all")).json()).toEqual({ rows: [], total: 0 });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.cacheKeys).toEqual([]);
  });

  it("referrer lists stay site-wide for a unit admin", async () => {
    h.runQuery.mockResolvedValueOnce([{ ref: "www.example.org", category: "Other", visits: "3", total: "1" }]);
    const res = await list("list=referrers");
    expect(await res.json()).toEqual({
      rows: [{ label: "www.example.org", category: "Other", visits: 3 }],
      total: 1,
    });
    expect(sqls()[0]).toContain("OFFSET 0 LIMIT 25");
    expect(sqls()[0]).not.toContain("member");
  });

  it("a site-wide viewer's pages list is the paged Athena read, as before", async () => {
    h.session.mockResolvedValue({ ...viewer, isSuperuser: true });
    h.runQuery.mockResolvedValueOnce(SITE_PAGE_ROWS);
    const body = (await (await list("list=pages&kind=all")).json()) as { rows: unknown[]; total: number };
    expect(body.rows).toHaveLength(4);
    expect(body.total).toBe(4);
    expect(sqls()[0]).toBe(
      buildPageListQuery({
        ...WINDOW,
        kind: "all",
        categories: [],
        aiClasses: [],
        q: undefined,
        offset: 0,
        limit: 25,
      }),
    );
    expect(sqls()[0]).not.toContain(" IN (");
  });
});

describe("GET /api/edit/usage/traffic/export", () => {
  const workbook = async () => {
    h.runQuery.mockImplementation(async (sql: string) => {
      const scoped = sql.includes("'/member-one'");
      if (sql.includes("SELECT source, referrer_host")) {
        const mine = { source: "WCM", referrer_host: "www.example.org", page: "/member-two", visits: "2" };
        return scoped
          ? [mine]
          : [
              { source: "WCM", referrer_host: "www.example.org", page: "/outsider-one", visits: "9" },
              { source: "crawler", referrer_host: "", page: "/topics/alpha", visits: "8" },
              mine,
            ];
      }
      if (sql.startsWith("SELECT page, visits")) {
        return scoped ? PAGE_ROWS : [...SITE_PAGE_ROWS, { page: "/topics/alpha", visits: "60" }];
      }
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

  it("a unit admin's page sheets are read for their people's profile pages only, and the Summary says so", async () => {
    const { column } = await workbook();
    expect(column("Top pages", 1)).toEqual(["/member-one", "/Member-One-Old", "/member-two"]);
    expect(column("Landing pages", 3)).toEqual(["/member-two"]);
    expect(column("Summary", 1)).toContain("Top pages and Landing pages sheets");
    expect(column("Summary", 2)).toContain(
      "Profile pages of Department of Testing only. Every other sheet is site-wide.",
    );
    const pageSqls = sqls().filter((q) => q.startsWith("SELECT page, visits"));
    const landingSqls = sqls().filter((q) => q.includes("SELECT source, referrer_host"));
    expect(pageSqls).toHaveLength(1);
    expect(pageSqls[0]).toContain(UNIT_PATHS);
    expect(landingSqls).toHaveLength(1);
    // Both arms (referred landings, AI landings) carry the unit filter.
    expect(landingSqls[0].split("'/member-one', '/member-one-old', '/member-two'")).toHaveLength(3);
    for (const sql of sqls()) expect(sql).not.toContain("1'='1");
  });

  it("a unit with no people gets empty page sheets and no page read", async () => {
    h.grants = [grant("department", "N9999")];
    const { column } = await workbook();
    expect(column("Top pages", 1)).toEqual([]);
    expect(column("Landing pages", 3)).toEqual([]);
    expect(sqls().some((q) => q.startsWith("SELECT page, visits"))).toBe(false);
    expect(sqls().some((q) => q.includes("SELECT source, referrer_host"))).toBe(false);
  });

  it("a site-wide viewer's workbook is unchanged", async () => {
    h.session.mockResolvedValue({ ...viewer, isSuperuser: true });
    const { column } = await workbook();
    expect(column("Top pages", 1)).toHaveLength(5);
    expect(column("Landing pages", 3)).toHaveLength(3);
    expect(column("Summary", 1)).not.toContain("Top pages and Landing pages sheets");
    expect(sqls()).toContain(buildLandingExportQuery("2026-10-01", "2026-10-31"));
    for (const sql of sqls()) expect(sql).not.toContain("lower(");
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
