/**
 * Unit-scoped Activity (decision 2026-11-17): a department / division / center
 * admin (owner or curator) passes the Activity gate and sees only edits to
 * their own people and units. Covers the gate, the scope → member-cwids
 * helper, the scope resolver, the SQL predicate, the three loaders, and both
 * API routes end to end against a fake `db.read` whose `$queryRaw` honours the
 * bound scope lists. All ids and names are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Grant = { cwid: string; entityType: string; entityId: string; role: string };
type AuditRow = { id: number; target_entity_type: string; target_entity_id: string };

const h = vi.hoisted(() => ({
  grants: [] as Grant[],
  audit: [] as AuditRow[],
  sqls: [] as string[],
  filters: [] as Array<{ sql: string; values: unknown[] } | number>,
  session: vi.fn(),
}));

/** The scope predicate among a tagged `$queryRaw` call's values: the nested
 *  `Prisma.Sql`, or the bound `1` of the site-wide view. */
function scopeValue(values: unknown[]): { sql: string; values: unknown[] } | number {
  const nested = values.find(
    (v): v is { sql: string; values: unknown[] } =>
      typeof v === "object" && v !== null && !(v instanceof Date) && "strings" in v,
  );
  return nested ?? 1;
}

const SCHOLARS = [
  { cwid: "aaa0001", deptCode: "N1000", divCode: null, preferredName: "Member One" },
  { cwid: "aaa0002", deptCode: "N1000", divCode: "N1100", preferredName: "Member Two" },
  { cwid: "aaa0003", deptCode: "N3000", divCode: null, preferredName: "Roster Member" },
  { cwid: "ccc0001", deptCode: "N3000", divCode: null, preferredName: "Center Member" },
  { cwid: "bbb0001", deptCode: "N2000", divCode: null, preferredName: "Outsider One" },
];

type ScholarWhere = {
  cwid?: { in: string[] };
  AND?: Array<{
    OR?: Array<{ deptCode?: { in: string[] }; divCode?: { in: string[] }; cwid?: { in: string[] } }>;
    cwid?: { in: string[] };
  }>;
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
      division: {
        findMany: async ({ where }: { where: { deptCode?: { in: string[] } } }) =>
          where.deptCode
            ? where.deptCode.in.includes("N1000")
              ? [{ code: "N1100" }]
              : []
            : [{ code: "N1100", name: "Division of Fixtures" }],
      },
      center: { findMany: async () => [{ code: "ctr_alpha", name: "Alpha Center" }] },
      core: { findMany: async () => [] },
      divisionMembership: {
        findMany: async ({ where }: { where: { divisionCode: { in: string[] } } }) =>
          where.divisionCode.in.includes("N1100") ? [{ cwid: "aaa0003" }] : [],
      },
      centerMembership: {
        findMany: async ({ where }: { where: { centerCode: { in: string[] } } }) =>
          where.centerCode.in.includes("ctr_alpha")
            ? [
                { cwid: "ccc0001", centerCode: "ctr_alpha", startDate: null, endDate: null, membershipRoleKey: null },
              ]
            : [],
      },
      scholar: {
        findMany: async ({ where }: { where: ScholarWhere }) => {
          if (where.cwid) return SCHOLARS.filter((s) => where.cwid!.in.includes(s.cwid));
          const scope = where.AND?.[0];
          if (!scope) return SCHOLARS;
          if (scope.cwid) return SCHOLARS.filter((s) => scope.cwid!.in.includes(s.cwid));
          return SCHOLARS.filter((s) =>
            (scope.OR ?? []).some(
              (o) =>
                o.deptCode?.in.includes(s.deptCode) ||
                (s.divCode !== null && o.divCode?.in.includes(s.divCode)) ||
                o.cwid?.in.includes(s.cwid),
            ),
          );
        },
      },
      publication: { findMany: async () => [] },
      // The fake audit table: applies the bound scope lists the way MySQL would.
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.sqls.push(strings.join("?").replace(/\s+/g, " "));
        const f = scopeValue(values);
        h.filters.push(f);
        const rows = typeof f === "number" ? h.audit : h.audit.filter((r) => f.values.includes(r.target_entity_id));
        return rows.map((r) => ({
          ...r,
          ts: new Date("2026-11-10T12:00:00Z"),
          actor_cwid: "stf0001",
          impersonated_cwid: null,
          action: "field_override",
          request_id: null,
          fields_changed: '["overview"]',
          before_values: null,
          after_values: null,
        }));
      },
    },
    write: {},
  },
}));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/authz", () => ({ logEditDenial: vi.fn() }));
vi.mock("@/lib/edit/directory-names", () => ({ resolveDirectoryPeople: async () => new Map() }));

import { GET as exportGET } from "@/app/api/edit/activity/export/route";
import { GET as recentGET } from "@/app/api/edit/activity/recent/route";
import { loadScopeMemberCwids } from "@/lib/api/data-quality";
import {
  decodeCursor,
  loadEditActivityCsv,
  loadEditActivitySummary,
  loadOlderEdits,
} from "@/lib/api/edit-activity";
import { db } from "@/lib/db";
import {
  activityScopeSql,
  canViewDashboard,
  dashboardVisible,
  loadDashboardScope,
} from "@/lib/edit/dashboard-access";

const viewer = { cwid: "adm0001", isSuperuser: false, isCommsSteward: false } as never;
const grant = (entityType: string, entityId: string, role = "owner"): Grant => ({
  cwid: "adm0001",
  entityType,
  entityId,
  role,
});

const TARGET_FILTER =
  "(target_entity_type = 'scholar' AND target_entity_id IN (?,?,?)) OR " +
  "(target_entity_type IN ('department', 'division') AND target_entity_id IN (?,?)) OR " +
  "(target_entity_type = 'center' AND target_entity_id IN (?))";

beforeEach(() => {
  vi.unstubAllEnvs();
  h.grants = [];
  h.sqls.length = 0;
  h.filters.length = 0;
  h.audit = [
    { id: 9, target_entity_type: "scholar", target_entity_id: "aaa0001" },
    { id: 8, target_entity_type: "scholar", target_entity_id: "bbb0001" },
    { id: 7, target_entity_type: "department", target_entity_id: "N1000" },
    { id: 6, target_entity_type: "department", target_entity_id: "N2000" },
    { id: 5, target_entity_type: "division", target_entity_id: "N1100" },
    { id: 4, target_entity_type: "publication", target_entity_id: "31234567" },
    { id: 3, target_entity_type: "scholar", target_entity_id: "aaa0003" },
  ];
  h.session.mockResolvedValue(viewer);
});

describe("Activity gate", () => {
  it.each([
    ["department owner", grant("department", "N1000")],
    ["department curator", grant("department", "N1000", "curator")],
    ["division owner", grant("division", "N1100")],
    ["division curator", grant("division", "N1100", "curator")],
    ["center owner", grant("center", "ctr_alpha")],
    ["center curator", grant("center", "ctr_alpha", "curator")],
  ])("a %s passes", async (_name, g) => {
    h.grants = [g];
    expect(await canViewDashboard(viewer, "activity")).toBe(true);
  });

  it.each([
    ["core-only admin", [grant("core", "7")]],
    ["institution-only admin", [grant("institution", "inst_x")]],
    ["person with no grant", []],
  ])("a %s does not", async (_name, gs) => {
    h.grants = gs;
    expect(await canViewDashboard(viewer, "activity")).toBe(false);
  });

  it("the grant opens Activity only: ETL status stays superuser-only", async () => {
    h.grants = [grant("department", "N1000")];
    expect(await canViewDashboard(viewer, "etl-status")).toBe(false);
  });

  it("the tab follows the same verdict", () => {
    const g = { viewerCanViewUsage: false, dashboards: new Set<never>() };
    expect(dashboardVisible(viewer, "activity", { ...g, viewerAdminsScopedUnit: true })).toBe(true);
    expect(dashboardVisible(viewer, "activity", { ...g, viewerAdminsScopedUnit: false })).toBe(false);
    expect(dashboardVisible(viewer, "etl-status", { ...g, viewerAdminsScopedUnit: true })).toBe(false);
  });
});

describe("loadScopeMemberCwids", () => {
  it("lists department and division members, hand-added division-roster members, and current center members", async () => {
    const cwids = await loadScopeMemberCwids(
      { all: false, unitCodes: ["N1000", "N1100"], centerCodes: ["ctr_alpha"] },
      db.read as never,
    );
    expect([...(cwids ?? [])].sort()).toEqual(["aaa0001", "aaa0002", "aaa0003", "ccc0001"]);
  });

  it("an empty scope has no members; an `all` scope has no member list", async () => {
    expect(
      await loadScopeMemberCwids({ all: false, unitCodes: [], centerCodes: [] }, db.read as never),
    ).toEqual([]);
    expect(await loadScopeMemberCwids({ all: true }, db.read as never)).toBeNull();
  });
});

describe("loadDashboardScope", () => {
  it("a superuser sees everything", async () => {
    expect(await loadDashboardScope({ ...(viewer as object), isSuperuser: true } as never, "activity")).toEqual({
      all: true,
    });
  });

  it("a department admin gets the department, its divisions, and their people, by name", async () => {
    h.grants = [grant("department", "N1000", "curator")];
    const scope = await loadDashboardScope(viewer, "activity");
    expect(scope).toEqual({
      all: false,
      unitNames: ["Department of Testing"],
      unitCodes: ["N1000", "N1100"],
      centerCodes: [],
      memberCwids: ["aaa0001", "aaa0002", "aaa0003"],
    });
  });

  it("a comms steward's site-wide Profiles scope does not widen Activity", async () => {
    h.grants = [grant("center", "ctr_alpha")];
    const scope = await loadDashboardScope(
      { ...(viewer as object), isCommsSteward: true } as never,
      "activity",
    );
    expect(scope).toMatchObject({ all: false, centerCodes: ["ctr_alpha"], memberCwids: ["ccc0001"] });
  });

  it("institution and core grants add nothing to the scope", async () => {
    h.grants = [grant("institution", "inst_x"), grant("core", "7")];
    expect(await loadDashboardScope(viewer, "activity")).toEqual({
      all: false,
      unitNames: [],
      unitCodes: [],
      centerCodes: [],
      memberCwids: [],
    });
  });
});

describe("activityScopeSql", () => {
  const scoped = {
    all: false as const,
    unitNames: [],
    unitCodes: ["N1000", "N1100"],
    centerCodes: ["ctr_alpha"],
    memberCwids: ["aaa0001", "aaa0002", "aaa0003"],
  };

  it("is the target filter, every value bound", () => {
    const sql = activityScopeSql(scoped)!;
    expect(sql.sql).toBe(TARGET_FILTER);
    expect(sql.values).toEqual(["aaa0001", "aaa0002", "aaa0003", "N1000", "N1100", "ctr_alpha"]);
  });

  it("no filter for `all`", () => {
    expect(activityScopeSql({ all: true })).toBeUndefined();
  });

  it("an empty member list drops only its own clause, never to an empty IN", () => {
    const sql = activityScopeSql({ ...scoped, memberCwids: [] })!;
    expect(sql.sql).not.toContain("'scholar'");
    expect(sql.sql).not.toContain("IN ()");
    expect(sql.values).toEqual(["N1000", "N1100", "ctr_alpha"]);
  });

  it("a scope with nothing in it matches no row", () => {
    const sql = activityScopeSql({ ...scoped, memberCwids: [], unitCodes: [], centerCodes: [] })!;
    expect(sql.sql).toBe("1 = 0");
    expect(sql.values).toEqual([]);
  });
});

describe("the loaders", () => {
  const now = new Date("2026-11-17T15:00:00Z");
  const cursor = decodeCursor("2026-11-17T12:00:00.000Z_500")!;
  const filter = activityScopeSql({
    all: false,
    unitNames: [],
    unitCodes: ["N1000"],
    centerCodes: [],
    memberCwids: ["aaa0001"],
  });

  it("every summary read, the older page and the CSV carry the scope predicate", async () => {
    await loadEditActivitySummary(db.read as never, now, undefined, "30d", filter);
    await loadOlderEdits(db.read as never, cursor, now, undefined, "30d", filter);
    await loadEditActivityCsv(db.read as never, "30d", now, undefined, filter);
    expect(h.sqls).toHaveLength(8);
    for (const sql of h.sqls) expect(sql).toMatch(/WHERE ts >= \? (AND ts <= \? )?AND \(\?\)/);
    for (const f of h.filters) expect(f).toBe(filter);
  });

  it("an empty scope returns nothing, not everything", async () => {
    const none = activityScopeSql({ all: false, unitNames: [], unitCodes: [], centerCodes: [], memberCwids: [] });
    const summary = await loadEditActivitySummary(db.read as never, now, undefined, "30d", none);
    expect(summary.recent).toEqual([]);
    expect((await loadOlderEdits(db.read as never, cursor, now, undefined, "30d", none)).recent).toEqual([]);
    expect((await loadEditActivityCsv(db.read as never, "30d", now, undefined, none)).split("\r\n")).toHaveLength(1);
  });

  it("no scope filter = every row (the site-wide view binds an always-true 1)", async () => {
    const page = await loadOlderEdits(db.read as never, cursor, now);
    expect(page.recent).toHaveLength(h.audit.length);
    expect(h.filters).toEqual([1]);
  });
});

describe("the API routes", () => {
  const AS_OF = "2026-11-17T12:00:00.000Z";
  // Parameters a caller might try to widen the scope with: all ignored.
  const WIDEN = "&scope=all&all=true&unit=N2000&unitCodes=N2000&cwid=bbb0001&memberCwids=bbb0001";
  const recent = (extra = "") =>
    recentGET(
      new NextRequest(
        `https://app.example/api/edit/activity/recent?cursor=${encodeURIComponent(`${AS_OF}_500`)}&asOf=${encodeURIComponent(AS_OF)}${extra}`,
      ),
    );
  const csv = (extra = "") =>
    exportGET(
      new NextRequest(`https://app.example/api/edit/activity/export?asOf=${encodeURIComponent(AS_OF)}${extra}`),
    );
  const IN_SCOPE = ["aaa0001", "N1000", "N1100", "aaa0003"];

  beforeEach(() => {
    h.grants = [grant("department", "N1000")];
  });

  it("recent: a unit admin gets only in-scope rows", async () => {
    const res = await recent();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent: Array<{ entityId: string }> };
    expect(body.recent.map((r) => r.entityId)).toEqual(IN_SCOPE);
  });

  it("recent: request parameters cannot widen the scope", async () => {
    const body = (await (await recent(WIDEN)).json()) as { recent: Array<{ entityId: string }> };
    expect(body.recent.map((r) => r.entityId)).toEqual(IN_SCOPE);
    expect(h.filters).toHaveLength(1);
    expect((h.filters[0] as { values: unknown[] }).values).toEqual([
      "aaa0001",
      "aaa0002",
      "aaa0003",
      "N1000",
      "N1100",
    ]);
  });

  it("export: a unit admin's CSV holds only in-scope rows, whatever the parameters say", async () => {
    for (const extra of ["", WIDEN]) {
      const res = await csv(extra);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.split("\r\n")).toHaveLength(1 + IN_SCOPE.length);
      for (const out of ["bbb0001", "N2000", "31234567"]) expect(text).not.toContain(out);
    }
  });

  it("a core-only admin is refused by both routes and nothing is read", async () => {
    h.grants = [grant("core", "7")];
    expect((await recent()).status).toBe(403);
    expect((await csv()).status).toBe(403);
    expect(h.sqls).toEqual([]);
  });

  it("a superuser still gets every row", async () => {
    h.session.mockResolvedValue({ ...(viewer as object), isSuperuser: true });
    const body = (await (await recent()).json()) as { recent: unknown[] };
    expect(body.recent).toHaveLength(h.audit.length);
    expect((await (await csv()).text()).split("\r\n")).toHaveLength(1 + h.audit.length);
    expect(h.filters).toEqual([1, 1]);
  });
});
