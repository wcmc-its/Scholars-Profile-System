/**
 * `lib/api/edit-roster.ts` — the Profiles roster query for `/edit/scholars`
 * (#160 UI follow-up, `self-edit-launch-spec.md` § The Profiles roster).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { loadEditRoster, loadRosterFacets } from "@/lib/api/edit-roster";

type AnyMock = ReturnType<typeof vi.fn>;
type FakeClient = { scholar: { findMany: AnyMock; count: AnyMock } };
type RosterClient = Parameters<typeof loadEditRoster>[1];

function fakeClient(rows: unknown[] = [], total = 0): FakeClient {
  return {
    scholar: {
      findMany: vi.fn().mockResolvedValue(rows),
      count: vi.fn().mockResolvedValue(total),
    },
  };
}
const asClient = (c: FakeClient) => c as unknown as RosterClient;

function row(over: Record<string, unknown> = {}) {
  return {
    cwid: "abc1001",
    slug: "abc-scholar",
    preferredName: "Pat Scholar",
    primaryTitle: "Professor of Medicine",
    status: "active",
    roleCategory: "full_time_faculty",
    department: { name: "Medicine" },
    division: { name: "Cardiology" },
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("loadEditRoster — mapping", () => {
  it("maps a row to a roster entry", async () => {
    const c = fakeClient([row()], 1);
    const { entries, total } = await loadEditRoster({}, asClient(c));
    expect(total).toBe(1);
    expect(entries[0]).toEqual({
      cwid: "abc1001",
      slug: "abc-scholar",
      name: "Pat Scholar",
      title: "Professor of Medicine",
      unit: "Medicine",
      roleCategory: "full_time_faculty",
      isVisible: true,
    });
  });

  it("falls back unit: department → division → null", async () => {
    const c = fakeClient([
      row({ cwid: "a", department: null, division: { name: "Cardiology" } }),
      row({ cwid: "b", department: null, division: null }),
    ]);
    const { entries } = await loadEditRoster({}, asClient(c));
    expect(entries[0].unit).toBe("Cardiology");
    expect(entries[1].unit).toBeNull();
  });

  it("isVisible reflects status (suppressed = not visible); null title", async () => {
    const c = fakeClient([row({ status: "suppressed", primaryTitle: null })]);
    const { entries } = await loadEditRoster({}, asClient(c));
    expect(entries[0].isVisible).toBe(false);
    expect(entries[0].title).toBeNull();
  });
});

describe("loadEditRoster — filters", () => {
  it("always excludes soft-deleted scholars", async () => {
    const c = fakeClient();
    await loadEditRoster({}, asClient(c));
    const where = c.scholar.findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBeUndefined(); // status:"all" → no status filter
  });

  it("status='visible' filters status:'active'", async () => {
    const c = fakeClient();
    await loadEditRoster({ status: "visible" }, asClient(c));
    expect(c.scholar.findMany.mock.calls[0][0].where.status).toBe("active");
  });

  it("status='hidden' filters status:{ not:'active' }", async () => {
    const c = fakeClient();
    await loadEditRoster({ status: "hidden" }, asClient(c));
    expect(c.scholar.findMany.mock.calls[0][0].where.status).toEqual({ not: "active" });
  });

  it("query builds a name/CWID search as an AND clause (trimmed, single token)", async () => {
    const c = fakeClient();
    await loadEditRoster({ query: "  smith  " }, asClient(c));
    const where = c.scholar.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([
      {
        OR: [
          { preferredName: { contains: "smith" } },
          { fullName: { contains: "smith" } },
          { cwid: { contains: "smith" } },
        ],
      },
    ]);
  });

  it("a multi-word query is tokenized into AND-ed clauses (First Last)", async () => {
    const c = fakeClient();
    await loadEditRoster({ query: "jane smith" }, asClient(c));
    const where = c.scholar.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      {
        OR: [
          { preferredName: { contains: "jane" } },
          { fullName: { contains: "jane" } },
          { cwid: { contains: "jane" } },
        ],
      },
      {
        OR: [
          { preferredName: { contains: "smith" } },
          { fullName: { contains: "smith" } },
          { cwid: { contains: "smith" } },
        ],
      },
    ]);
  });

  it("an empty/whitespace query adds no name filter", async () => {
    const c = fakeClient();
    await loadEditRoster({ query: "   " }, asClient(c));
    const where = c.scholar.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.AND).toBeUndefined();
  });

  it("unitCodeScope (B3) restricts to dept/div codes; omitting it (superuser) does not", async () => {
    const scoped = fakeClient();
    await loadEditRoster({ unitCodeScope: ["DEPT_MED", "DIV_CARD"] }, asClient(scoped));
    expect(scoped.scholar.findMany.mock.calls[0][0].where.AND).toEqual([
      { OR: [{ deptCode: { in: ["DEPT_MED", "DIV_CARD"] } }, { divCode: { in: ["DEPT_MED", "DIV_CARD"] } }] },
    ]);

    const superuser = fakeClient();
    await loadEditRoster({}, asClient(superuser));
    expect(superuser.scholar.findMany.mock.calls[0][0].where.AND).toBeUndefined();
  });

  it("an empty unitCodeScope returns nothing (in: []) — an admin managing no units", async () => {
    const c = fakeClient();
    await loadEditRoster({ unitCodeScope: [] }, asClient(c));
    const and = c.scholar.findMany.mock.calls[0][0].where.AND;
    expect(and[0].OR[0].deptCode.in).toEqual([]);
  });

  it("roleCategory (person type) filters where.roleCategory", async () => {
    const c = fakeClient();
    await loadEditRoster({ roleCategory: "full_time_faculty" }, asClient(c));
    expect(c.scholar.findMany.mock.calls[0][0].where.roleCategory).toBe("full_time_faculty");
  });

  it("a department/division unit filter sets the matching code column", async () => {
    const dept = fakeClient();
    await loadEditRoster({ unit: { kind: "department", code: "N1280" } }, asClient(dept));
    expect(dept.scholar.findMany.mock.calls[0][0].where.deptCode).toBe("N1280");

    const div = fakeClient();
    await loadEditRoster({ unit: { kind: "division", code: "D42" } }, asClient(div));
    expect(div.scholar.findMany.mock.calls[0][0].where.divCode).toBe("D42");
  });

  it("a center unit filter restricts where.cwid to active-by-date members", async () => {
    const c = {
      scholar: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
      centerMembership: {
        findMany: vi.fn().mockResolvedValue([
          { cwid: "current", startDate: null, endDate: null },
          { cwid: "expired", startDate: null, endDate: new Date("2000-01-01") },
        ]),
      },
    };
    await loadEditRoster({ unit: { kind: "center", code: "meyer" } }, c as unknown as RosterClient);
    expect(c.scholar.findMany.mock.calls[0][0].where.cwid).toEqual({ in: ["current"] });
  });
});

describe("loadRosterFacets", () => {
  it("returns the unit lists + role categories present on non-deleted scholars", async () => {
    const c = {
      department: { findMany: vi.fn().mockResolvedValue([{ code: "N1280", name: "Medicine" }]) },
      division: { findMany: vi.fn().mockResolvedValue([{ code: "D1", name: "Cardiology" }]) },
      center: { findMany: vi.fn().mockResolvedValue([{ code: "meyer", name: "Meyer Cancer Center" }]) },
      scholar: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ roleCategory: "full_time_faculty" }, { roleCategory: "postdoc" }]),
      },
    };
    const facets = await loadRosterFacets(c as unknown as Parameters<typeof loadRosterFacets>[0]);
    expect(facets.departments).toEqual([{ code: "N1280", name: "Medicine" }]);
    expect(facets.centers[0].name).toBe("Meyer Cancer Center");
    expect(facets.roleCategories.map((r) => r.value).sort()).toEqual(["full_time_faculty", "postdoc"]);
    // Labels come from formatRoleCategory (non-empty display strings).
    expect(facets.roleCategories.every((r) => r.label.length > 0)).toBe(true);
  });
});

describe("loadEditRoster — pagination", () => {
  it("defaults take=50 skip=0", async () => {
    const c = fakeClient();
    await loadEditRoster({}, asClient(c));
    const args = c.scholar.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
    expect(args.skip).toBe(0);
  });

  it("caps take at 200 and floors offset at 0", async () => {
    const c = fakeClient();
    await loadEditRoster({ limit: 9999, offset: -5 }, asClient(c));
    const args = c.scholar.findMany.mock.calls[0][0];
    expect(args.take).toBe(200);
    expect(args.skip).toBe(0);
  });

  it("passes through a valid limit/offset and uses the same where for count", async () => {
    const c = fakeClient([], 137);
    const { total } = await loadEditRoster({ limit: 25, offset: 50, status: "visible" }, asClient(c));
    const findArgs = c.scholar.findMany.mock.calls[0][0];
    expect(findArgs.take).toBe(25);
    expect(findArgs.skip).toBe(50);
    expect(total).toBe(137);
    // count uses the identical where as findMany.
    expect(c.scholar.count.mock.calls[0][0].where).toEqual(findArgs.where);
  });
});
