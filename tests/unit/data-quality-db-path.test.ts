/**
 * #2596 — the roster's DB path: sort + page by the stored
 * `Scholar.rosterLeadershipTier` / `rosterProminence`, with COUNT-based totals,
 * against the in-app path it replaces.
 *
 * The fake below is a small in-memory Prisma: it evaluates the `where` shapes
 * the loader emits and applies `orderBy` / `skip` / `take` like MySQL (NULLs
 * first ascending). Its STRING order is deliberately not `localeCompare` (it
 * sorts names in reverse code-unit order), standing in for the column
 * collation: the DB path must still return exactly the in-app order.
 */
import { describe, expect, it, vi } from "vitest";

import {
  JS_TRIM_WHITESPACE,
  loadDataQualityExport,
  loadDataQualityRoster,
  type DataQualityGapFilter,
  type DataQualityOptions,
  type OverviewAgeFilter,
} from "@/lib/api/data-quality";
import {
  ROSTER_ORDER_BY,
  compareRosterOrder,
  hasUnscoredRoster,
  type RosterSortKey,
} from "@/lib/api/prominence";

type LoaderClient = Parameters<typeof loadDataQualityRoster>[1];
type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (y: number) => new Date(Date.now() - y * MS_PER_YEAR);

// ---------------------------------------------------------------------------
// In-memory Prisma
// ---------------------------------------------------------------------------

function isOps(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v);
}
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function matchField(actual: unknown, cond: unknown): boolean {
  if (!isOps(cond)) return val(actual) === val(cond);
  return Object.entries(cond).every(([op, arg]) => {
    const a = val(actual) as number | string | null;
    const b = val(arg) as number | string;
    switch (op) {
      case "equals":
        return a === b;
      case "in":
        return (arg as unknown[]).includes(actual);
      case "notIn":
        return !(arg as unknown[]).includes(actual);
      case "not":
        return isOps(arg) ? !matchField(actual, arg) : a !== b;
      case "lt":
        return a !== null && a < b;
      case "lte":
        return a !== null && a <= b;
      case "gt":
        return a !== null && a > b;
      case "gte":
        return a !== null && a >= b;
      case "startsWith":
        return typeof a === "string" && a.startsWith(b as string);
      case "endsWith":
        return typeof a === "string" && a.endsWith(b as string);
      case "contains":
        return typeof a === "string" && a.includes(b as string);
      default:
        throw new Error(`fake: unsupported op ${op}`);
    }
  });
}

type Db = {
  scholars: Row[];
  coi: Row[];
  provenance: Row[];
  overrides: Row[];
  roles: Row[];
  grants: Row[];
};

function matches(db: Db | null, row: Row, where: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") {
      const list = Array.isArray(cond) ? cond : [cond];
      return list.every((w) => matches(db, row, w as Where));
    }
    if (key === "OR") return (cond as Where[]).some((w) => matches(db, row, w));
    if (key === "NOT") {
      const list = Array.isArray(cond) ? cond : [cond];
      return !list.some((w) => matches(db, row, w as Where));
    }
    if (db && key === "coiGapCandidates") {
      const some = (cond as { some: Where }).some;
      return db.coi.some((c) => c.cwid === row.cwid && matches(null, c, some));
    }
    if (db && key === "overviewProvenance") {
      const is = (cond as { is: Where | null }).is;
      const p = db.provenance.find((r) => r.cwid === row.cwid);
      return is === null ? p === undefined : p !== undefined && matches(null, p, is);
    }
    return matchField(row[key], cond);
  });
}

/** MySQL-ish order: NULLs first ascending; strings in a NON-localeCompare order. */
function dbCompare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "string" && typeof b === "string") return a < b ? 1 : a > b ? -1 : 0;
  return (a as number) - (b as number);
}

function orderRows(rows: Row[], orderBy: ReadonlyArray<Record<string, "asc" | "desc">>): Row[] {
  return [...rows].sort((x, y) => {
    for (const o of orderBy) {
      const [k, dir] = Object.entries(o)[0];
      const c = dbCompare(x[k], y[k]);
      if (c !== 0) return dir === "asc" ? c : -c;
    }
    return 0;
  });
}

function groupBy(rows: Row[], by: string[]) {
  const m = new Map<string, { row: Row; n: number }>();
  for (const r of rows) {
    const k = by.map((b) => String(r[b])).join("\u0000");
    const g = m.get(k) ?? { row: Object.fromEntries(by.map((b) => [b, r[b]])), n: 0 };
    g.n += 1;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g.row, _count: { _all: g.n } }));
}

function fakeClient(db: Db) {
  const shaped = (s: Row) => ({
    ...s,
    department: s.deptName ? { name: s.deptName } : null,
    division: null,
  });
  type FindArgs = {
    where?: Where;
    orderBy?: Array<Record<string, "asc" | "desc">>;
    skip?: number;
    take?: number;
    select?: Record<string, unknown>;
  };
  const scholarFind = (args: FindArgs = {}) => {
    let rows = db.scholars.filter((s) => matches(db, s, args.where));
    if (args.orderBy) rows = orderRows(rows, args.orderBy);
    const skip = args.skip ?? 0;
    rows = rows.slice(skip, args.take === undefined ? undefined : skip + args.take);
    return rows.map(shaped);
  };
  const client = {
    scholar: {
      findMany: vi.fn(async (args?: FindArgs) => scholarFind(args)),
      findFirst: vi.fn(async (args?: FindArgs) => scholarFind(args)[0] ?? null),
      count: vi.fn(async (args?: { where?: Where }) =>
        db.scholars.filter((s) => matches(db, s, args?.where)).length,
      ),
    },
    grant: {
      groupBy: vi.fn(async (args: { by: string[]; where?: Where }) =>
        groupBy(db.grants.filter((g) => matches(null, g, args.where)), args.by),
      ),
    },
    coiGapCandidate: {
      groupBy: vi.fn(async (args: { by: string[]; where?: Where }) =>
        groupBy(db.coi.filter((c) => matches(null, c, args.where)), args.by),
      ),
    },
    orgUnitRoleAssignment: {
      findMany: vi.fn(async (args: { where?: Where }) =>
        db.roles.filter((r) => matches(null, r, args.where)),
      ),
    },
    fieldOverride: {
      findMany: vi.fn(async (args: { where?: Where }) =>
        db.overrides.filter((r) => matches(null, r, args.where)),
      ),
    },
    overviewProvenance: {
      findMany: vi.fn(async (args?: { where?: Where }) =>
        db.provenance.filter((r) => matches(null, r, args?.where)),
      ),
    },
    centerMembership: { findMany: vi.fn(async () => []) },
    divisionMembership: { findMany: vi.fn(async () => []) },
  };
  return client;
}
const asClient = (c: ReturnType<typeof fakeClient>) => c as unknown as LoaderClient;

// ---------------------------------------------------------------------------
// Fixture: leadership tiers, prominence ties, names that only differ in case /
// accent, blank-overview variants, overrides, provenance ages, COI states.
// ---------------------------------------------------------------------------

function scholar(over: Row): Row {
  return {
    slug: String(over.cwid),
    fullName: String(over.preferredName),
    primaryTitle: null,
    roleCategory: "doctoral_student",
    status: "active",
    overview: null,
    hIndex: null,
    scoredPubCount: null,
    hasHeadshot: null,
    headshotCheckedAt: null,
    deletedAt: null,
    deptName: null,
    rosterProminence: null,
    rosterLeadershipTier: null,
    ...over,
  };
}

function fixture(): Db {
  const fac = { roleCategory: "full_time_faculty", scoredPubCount: 20, hIndex: 8 };
  return {
    scholars: [
      scholar({ cwid: "dean", preferredName: "Dana Dean", primaryTitle: "Dean", ...fac }),
      scholar({ cwid: "ch1", preferredName: "Cara Chair", ...fac, deptName: "Medicine" }),
      scholar({ cwid: "ch2", preferredName: "cara chair", ...fac, deptName: "Medicine" }),
      scholar({ cwid: "chf", preferredName: "Chet Chief", ...fac, hasHeadshot: true }),
      // Three full-time faculty with identical inputs → one tie group.
      scholar({ cwid: "f1", preferredName: "Émile Faculty", ...fac, overview: "<p>Bio</p>" }),
      scholar({ cwid: "f2", preferredName: "emile faculty", ...fac, hasHeadshot: false }),
      scholar({ cwid: "f3", preferredName: "Emile Faculty", ...fac, overview: "  " }),
      scholar({ cwid: "f4", preferredName: "Zoe Busy", ...fac, scoredPubCount: 200, hIndex: 50 }),
      // Zero-score students → the big tail tie group.
      scholar({ cwid: "s1", preferredName: "abe", overview: "\n\t" }),
      scholar({ cwid: "s2", preferredName: "Abe" }),
      scholar({ cwid: "s3", preferredName: "Álvaro", overview: " <p>x</p> " }),
      scholar({ cwid: "s4", preferredName: "alvaro", overview: "" }),
      scholar({ cwid: "s5", preferredName: "Zed", hasHeadshot: false, overview: "<p>z</p>" }),
      scholar({ cwid: "s6", preferredName: "zed", status: "suppressed", overview: "<p>y</p>" }),
      scholar({ cwid: "s7", preferredName: "Abe" }), // identical name: cwid breaks the tie
      scholar({ cwid: "gone", preferredName: "Aaron Gone", deletedAt: new Date() }),
    ],
    coi: [
      { cwid: "ch1", tier: "High", status: "new" },
      { cwid: "ch1", tier: "High", status: "new" },
      { cwid: "f2", tier: "Medium", status: "new" },
      { cwid: "s2", tier: "High", status: "dismissed" },
      { cwid: "s5", tier: "High", status: "new" },
    ],
    provenance: [
      { cwid: "f1", updatedAt: yearsAgo(0.5) },
      { cwid: "s3", updatedAt: yearsAgo(1.5) },
      { cwid: "s5", updatedAt: yearsAgo(3) },
      { cwid: "s4", updatedAt: yearsAgo(0.2) }, // via the override below
    ],
    overrides: [
      { entityType: "scholar", fieldName: "overview", entityId: "s4", value: "Override bio" },
      { entityType: "scholar", fieldName: "overview", entityId: "s2", value: " \n" }, // blank
    ],
    roles: [
      { entityType: "department", roleKey: "chair", cwid: "ch1" },
      { entityType: "department", roleKey: "chair", cwid: "ch2" },
      { entityType: "division", roleKey: "chief", cwid: "chf" },
    ],
    grants: [
      { cwid: "f4", role: "PI", source: "InfoEd", nihIc: "NCI" },
      { cwid: "chf", role: "PI", source: "InfoEd", nihIc: null },
    ],
  };
}

/** The in-app reference (stored columns NULL → fallback), then the same data
 *  with the stored columns written from that reference, as the nightly would. */
async function scoredFixture() {
  const db = fixture();
  const all = await loadDataQualityRoster({ scope: { all: true }, limit: 200 }, asClient(fakeClient(db)));
  const byCwid = new Map(all.entries.map((e) => [e.cwid, e]));
  const scored: Db = {
    ...db,
    scholars: db.scholars.map((s) => {
      const e = byCwid.get(String(s.cwid));
      return e ? { ...s, rosterProminence: e.prominence, rosterLeadershipTier: e.leadershipTier } : s;
    }),
  };
  return { unscored: db, scored };
}

const GAPS: DataQualityGapFilter[] = ["all", "no-headshot", "no-overview", "has-coi"];
const AGES: OverviewAgeFilter[] = ["all", "never", "imported", "lt1yr", "1to2yr", "gt2yr"];

// ---------------------------------------------------------------------------

describe("roster order spec — one definition for the DB and the app", () => {
  it("ROSTER_ORDER_BY is compareRosterOrder key for key (numeric keys + a collation-free cwid tail)", () => {
    expect(ROSTER_ORDER_BY).toEqual([
      { rosterLeadershipTier: "asc" },
      { rosterProminence: "desc" },
      { preferredName: "asc" },
      { cwid: "asc" },
    ]);
    // Applying ROSTER_ORDER_BY with the APP's string order reproduces the comparator.
    const keys: RosterSortKey[] = [];
    const names = ["abe", "Abe", "Álvaro", "alvaro", "Zed", "zed", "émile", "Emile"];
    for (let i = 0; i < 60; i++) {
      keys.push({
        cwid: `c${(i * 37) % 60}`,
        name: names[i % names.length],
        leadershipTier: [0, 4, 8.5, 13][i % 4],
        prominence: [0, 1.5, 3][(i >> 2) % 3],
      });
    }
    const field: Record<string, keyof RosterSortKey> = {
      rosterLeadershipTier: "leadershipTier",
      rosterProminence: "prominence",
      preferredName: "name",
      cwid: "cwid",
    };
    const bySpec = [...keys].sort((a, b) => {
      for (const o of ROSTER_ORDER_BY) {
        const [k, dir] = Object.entries(o)[0];
        const x = a[field[k]];
        const y = b[field[k]];
        let c: number;
        if (k === "preferredName") c = (x as string).localeCompare(y as string);
        else if (typeof x === "string") c = x < y ? -1 : x > y ? 1 : 0;
        else c = (x as number) - (y as number);
        if (c !== 0) return dir === "asc" ? c : -c;
      }
      return 0;
    });
    expect(bySpec).toEqual([...keys].sort(compareRosterOrder));
  });

  it("hasUnscoredRoster looks for a NULL score inside the caller's where, LIMIT 1", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const where = { deletedAt: null, deptCode: { in: ["MED"] } };
    await expect(hasUnscoredRoster({ scholar: { findFirst } } as never, where)).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: { AND: [where, { OR: [{ rosterProminence: null }, { rosterLeadershipTier: null }] }] },
      select: { cwid: true },
    });
  });

  it("JS_TRIM_WHITESPACE is exactly the set String.prototype.trim strips", () => {
    const stripped: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      const c = String.fromCharCode(cp);
      if (c.trim() === "") stripped.push(c);
    }
    expect([...JS_TRIM_WHITESPACE].sort()).toEqual(stripped.sort());
  });
});

describe("loadDataQualityRoster — DB path (#2596)", () => {
  it("issues ORDER BY the spec with skip/take, and never loads the whole roster", async () => {
    const { scored } = await scoredFixture();
    const client = fakeClient(scored);
    await loadDataQualityRoster({ scope: { all: true }, limit: 3, offset: 4 }, asClient(client));

    const paged = client.scholar.findMany.mock.calls.filter(([a]) => a?.orderBy);
    expect(paged).toHaveLength(1);
    expect(paged[0][0]).toMatchObject({ orderBy: [...ROSTER_ORDER_BY], skip: 4, take: 3 });
    // No whole-roster scoring reads: no grant aggregates, no unscoped role/COI reads.
    expect(client.grant.groupBy).not.toHaveBeenCalled();
    for (const [a] of client.coiGapCandidate.groupBy.mock.calls) {
      expect(a.where).toHaveProperty("cwid");
    }
    for (const [a] of client.orgUnitRoleAssignment.findMany.mock.calls) {
      expect(a.where).toHaveProperty("cwid");
    }
    // Every full-row read is the page's cwids (or the thin sort-key / blank reads).
    for (const [a] of client.scholar.findMany.mock.calls) {
      const sel = a?.select ?? {};
      if (sel.slug) expect(a?.where).toEqual({ cwid: { in: expect.any(Array) } });
    }
  });

  it.each(GAPS.flatMap((gap) => AGES.map((overviewAge) => ({ gap, overviewAge }))))(
    "every page equals the in-app slice, with identical total + counts (gap=$gap, overviewAge=$overviewAge)",
    async ({ gap, overviewAge }) => {
      const { unscored, scored } = await scoredFixture();
      const base: DataQualityOptions = { scope: { all: true }, gap, overviewAge };
      const ref = await loadDataQualityRoster({ ...base, limit: 200 }, asClient(fakeClient(unscored)));

      for (const limit of [1, 2, 3, 5, 200]) {
        for (let offset = 0; offset <= ref.total; offset++) {
          const client = fakeClient(scored);
          const got = await loadDataQualityRoster({ ...base, limit, offset }, asClient(client));
          expect(client.grant.groupBy).not.toHaveBeenCalled(); // really the DB path
          expect(got.total).toBe(ref.total);
          expect(got.counts).toEqual(ref.counts);
          expect(got.entries).toEqual(ref.entries.slice(offset, offset + limit));
        }
      }
    },
  );

  it("the reference really exercises the ties, blanks and overrides it claims to", async () => {
    const { unscored } = await scoredFixture();
    const ref = await loadDataQualityRoster(
      { scope: { all: true }, limit: 200 },
      asClient(fakeClient(unscored)),
    );
    const order = ref.entries.map((e) => e.cwid);
    expect(order[0]).toBe("dean");
    expect(order).not.toContain("gone");
    // Same tier + prominence, broken by localeCompare then cwid.
    expect(order.slice(-7)).toEqual(["s1", "s2", "s7", "s4", "s3", "s6", "s5"]);
    const by = Object.fromEntries(ref.entries.map((e) => [e.cwid, e]));
    expect(by.f3.hasOverview).toBe(false); // "  "
    expect(by.s1.hasOverview).toBe(false); // "\n\t"
    expect(by.s3.hasOverview).toBe(true); // nbsp-wrapped text
    expect(by.s4.overviewState).toBe("lt1yr"); // "" overview, override wins
    expect(by.s2.hasOverview).toBe(false); // blank override does not count
    expect(ref.counts).toEqual({ inScope: 15, missingHeadshot: 2, missingOverview: 10, withCoi: 2 });
  });

  it("the CSV export pages the DB path from offset 0 and agrees with the in-app export", async () => {
    const { unscored, scored } = await scoredFixture();
    const ref = await loadDataQualityExport({ scope: { all: true } }, asClient(fakeClient(unscored)));
    const client = fakeClient(scored);
    const got = await loadDataQualityExport({ scope: { all: true } }, asClient(client));
    expect(client.grant.groupBy).not.toHaveBeenCalled();
    expect(got).toEqual(ref);
  });
});

describe("loadDataQualityRoster — fallback to the in-app path", () => {
  it("one unscored in-scope scholar (nightly not run, or a new scholar) → the old whole-roster path", async () => {
    const { scored } = await scoredFixture();
    const partly: Db = {
      ...scored,
      scholars: scored.scholars.map((s) =>
        s.cwid === "s5" ? { ...s, rosterProminence: null, rosterLeadershipTier: null } : s,
      ),
    };
    const client = fakeClient(partly);
    const got = await loadDataQualityRoster({ scope: { all: true }, limit: 4, offset: 2 }, asClient(client));
    expect(client.scholar.findMany.mock.calls.some(([a]) => a?.orderBy)).toBe(false);
    expect(client.scholar.count).not.toHaveBeenCalled();
    expect(client.grant.groupBy).toHaveBeenCalled();

    const { unscored } = await scoredFixture();
    const ref = await loadDataQualityRoster(
      { scope: { all: true }, limit: 4, offset: 2 },
      asClient(fakeClient(unscored)),
    );
    expect(got).toEqual(ref);
  });

  it("an unscored row OUTSIDE the scope does not force the fallback", async () => {
    const { scored } = await scoredFixture();
    const db: Db = {
      ...scored,
      scholars: scored.scholars.map((s) =>
        s.cwid === "gone" ? { ...s, rosterProminence: null, rosterLeadershipTier: null } : s,
      ),
    };
    const client = fakeClient(db);
    await loadDataQualityRoster({ scope: { all: true } }, asClient(client));
    expect(client.grant.groupBy).not.toHaveBeenCalled();
  });

  it("an empty page short-circuits after the counts", async () => {
    const { scored } = await scoredFixture();
    const client = fakeClient(scored);
    const got = await loadDataQualityRoster({ scope: { all: true }, offset: 500 }, asClient(client));
    expect(got.entries).toEqual([]);
    expect(got.total).toBe(15);
  });
});
