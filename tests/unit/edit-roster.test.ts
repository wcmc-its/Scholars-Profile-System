/**
 * `lib/api/edit-roster.ts` — the Profiles roster query for `/edit/scholars`
 * (#160 UI follow-up, `self-edit-launch-spec.md` § The Profiles roster).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { loadEditRoster } from "@/lib/api/edit-roster";

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

  it("query builds a name/CWID OR search (trimmed)", async () => {
    const c = fakeClient();
    await loadEditRoster({ query: "  smith  " }, asClient(c));
    expect(c.scholar.findMany.mock.calls[0][0].where.OR).toEqual([
      { preferredName: { contains: "smith" } },
      { fullName: { contains: "smith" } },
      { cwid: { contains: "smith" } },
    ]);
  });

  it("an empty/whitespace query adds no OR filter", async () => {
    const c = fakeClient();
    await loadEditRoster({ query: "   " }, asClient(c));
    expect(c.scholar.findMany.mock.calls[0][0].where.OR).toBeUndefined();
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
