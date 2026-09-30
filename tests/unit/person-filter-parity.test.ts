/**
 * Parity: the raw-SQL builder (report 8) and the Prisma builder (Profiles /
 * COI) in `lib/edit/person-filter.ts` must pick the same scholars for a
 * selection — same columns, same bound codes, same center date rule. Each
 * side's output is normalized back through `UNIT_KINDS` into
 * `{ types, units: { kind: codes } }`; an unmapped column on either side
 * throws, and one case per `UNIT_KINDS` entry is generated, so a kind wired
 * into one builder but not the other fails here. A `roster` kind (division)
 * must ALSO reach its hand-added members on both sides (`rosterOf`), and a
 * resolved CWID list must bind the same CWIDs on both sides (`list`).
 */
import { describe, expect, it } from "vitest";

import { Prisma } from "@/lib/generated/prisma/client";

import {
  PERSON_TYPE_COLUMN,
  UNIT_KINDS,
  currentCenterMembershipSql,
  isCurrentCenterMembership,
  parsePersonFilter,
  personFilterCriteria,
  personFilterSql,
  personFilterWhere,
  unitCodes,
  type UnitKind,
} from "@/lib/edit/person-filter";

const TODAY = "2026-09-22";
const KINDS = Object.keys(UNIT_KINDS) as UnitKind[];
const CENTER_MEMBERS = ["abc1234"]; // fake resolved member cwid for the Prisma side
const DIVISION_ROSTER = ["def5678"]; // fake resolved manual-roster cwid for the Prisma side

type Normalized = {
  types: string[];
  units: Partial<Record<UnitKind, string[]>>;
  matchNothing: boolean;
  /** Codes of the kinds whose hand-added roster is matched too. */
  rosterOf?: string[];
  /** The CWID list's CWIDs. */
  list?: string[];
};

/** A roster kind's cases expect its roster matched for the same codes. */
function withRoster(n: Normalized): Normalized {
  const rosterKinds = KINDS.filter((k) => UNIT_KINDS[k].roster);
  const codes = rosterKinds.flatMap((k) => n.units[k] ?? []);
  return codes.length > 0 ? { ...n, rosterOf: codes } : n;
}

function fromSql(qs: string, listCwids?: string[]): Normalized & { dateOps: string[] } {
  const sql = personFilterSql(
    { ...parsePersonFilter(new URLSearchParams(qs)), listCwids },
    { scholar: "s", centerMembership: "cm" },
    TODAY,
  );
  const text = sql.sql.replace(/\s+/g, " ");
  const out: Normalized & { dateOps: string[] } = { types: [], units: {}, matchNothing: text.includes("1 = 0"), dateOps: [] };
  const pieces = text.split("?");
  let v = 0;
  for (let i = 0; i < pieces.length - 1; i++) {
    const value = sql.values[v++];
    const before = pieces.slice(0, i + 1).join("?");
    const m = /(\w+)\.(\w+) (IN \([?,]*|<= |>= )$/.exec(before);
    if (!m) throw new Error(`unrecognised placeholder context: ${before.slice(-60)}`);
    const [, alias, column, op] = m;
    if (op.startsWith("<=") || op.startsWith(">=")) {
      expect(value).toBe(TODAY);
      expect(alias).toBe("cm");
      out.dateOps.push(`${column} ${op.trim()}`);
      continue;
    }
    const push = (xs: string[]) => xs.push(String(value));
    if (alias === "s" && column === PERSON_TYPE_COLUMN.sql) push(out.types);
    else if (alias === "s" && column === "cwid") push((out.list ??= []));
    else if (alias === "cm" && column === "center_code") push((out.units.center ??= []));
    else if (alias === "pf_dm" && column === "division_code") push((out.rosterOf ??= []));
    else {
      const kind = KINDS.find((k) => UNIT_KINDS[k].sql === column);
      if (alias !== "s" || !kind) throw new Error(`SQL filters on unmapped column ${alias}.${column}`);
      push((out.units[kind] ??= []));
    }
  }
  expect(v).toBe(sql.values.length);
  return out;
}

function fromPrisma(qs: string, listCwids?: string[]): Normalized {
  const f = parsePersonFilter(new URLSearchParams(qs));
  const w = personFilterWhere({ ...f, listCwids }, CENTER_MEMBERS, DIVISION_ROSTER);
  const out: Normalized = { types: w.roleCategory?.in ?? [], units: {}, matchNothing: false };
  if (w.list) {
    const inList = (w.list.cwid as { in: string[] }).in;
    if (inList.length === 0) out.matchNothing = true;
    else out.list = inList;
  }
  const ors = (w.unit?.OR ?? []) as Record<string, { in: string[] }>[];
  if (w.unit && !w.unit.OR) {
    expect(w.unit).toEqual({ cwid: { in: [] } });
    out.matchNothing = true;
  }
  for (const clause of ors) {
    const [[field, filter]] = Object.entries(clause);
    if (field === "cwid" && filter.in.join() === DIVISION_ROSTER.join()) {
      // The caller resolved the selected divisions' manual rosters
      // (`loadSelectedDivisionRosterCwids`).
      out.rosterOf = KINDS.filter((k) => UNIT_KINDS[k].roster).flatMap((k) => unitCodes(f.units, k));
      continue;
    }
    if (field === "cwid") {
      expect(filter.in).toEqual(CENTER_MEMBERS);
      // The Prisma side resolves these codes to members (data-quality's findMany).
      out.units.center = unitCodes(f.units, "center");
      continue;
    }
    const kind = KINDS.find((k) => UNIT_KINDS[k].prisma === field);
    if (!kind) throw new Error(`Prisma filters on unmapped field ${field}`);
    out.units[kind] = filter.in;
  }
  return out;
}

/** The Prisma path's date rule, read off the predicate's behavior at the boundaries. */
function prismaDateOps(): string[] {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const [yesterday, tomorrow] = ["2026-09-21", "2026-09-23"];
  expect(isCurrentCenterMembership({ startDate: null, endDate: null, membershipRoleKey: null }, TODAY)).toBe(true);
  const start = isCurrentCenterMembership({ startDate: d(TODAY), endDate: null, membershipRoleKey: null }, TODAY) && !isCurrentCenterMembership({ startDate: d(tomorrow), endDate: null, membershipRoleKey: null }, TODAY);
  const end = isCurrentCenterMembership({ startDate: null, endDate: d(TODAY), membershipRoleKey: null }, TODAY) && !isCurrentCenterMembership({ startDate: null, endDate: d(yesterday), membershipRoleKey: null }, TODAY);
  return [start ? "start_date <=" : "start_date ?", end ? "end_date >=" : "end_date ?"];
}

const prefix = (k: UnitKind) => UNIT_KINDS[k].prefix;

const CASES: { name: string; qs: string; expected: Normalized }[] = [
  { name: "empty", qs: "", expected: { types: [], units: {}, matchNothing: false } },
  // One case per kind, generated from the table itself.
  ...KINDS.map((k) => ({
    name: `${k} alone`,
    qs: `unit=${prefix(k)}:X1`,
    expected: { types: [], units: { [k]: ["X1"] }, matchNothing: false },
  })),
  ...KINDS.map((k) => ({
    name: `several ${k}`,
    qs: `unit=${prefix(k)}:X1&unit=${prefix(k)}:X2`,
    expected: { types: [], units: { [k]: ["X1", "X2"] }, matchNothing: false },
  })),
  {
    name: "every kind mixed",
    qs: KINDS.map((k, i) => `unit=${prefix(k)}:C${i}`).join("&"),
    expected: { types: [], units: Object.fromEntries(KINDS.map((k, i) => [k, [`C${i}`]])), matchNothing: false },
  },
  {
    name: "types + units",
    qs: "type=postdoc&type=full_time_faculty&unit=dept:MED&unit=center:CC",
    expected: { types: ["postdoc", "full_time_faculty"], units: { department: ["MED"], center: ["CC"] }, matchNothing: false },
  },
  {
    name: "undecodable mixed with decodable: only the decodable filter",
    qs: "unit=bogus&unit=div:&unit=div:CARD",
    expected: { types: [], units: { division: ["CARD"] }, matchNothing: false },
  },
  {
    name: "units given but none decode: match nothing",
    qs: "type=postdoc&unit=bogus&unit=dept:",
    expected: { types: ["postdoc"], units: {}, matchNothing: true },
  },
];

describe("person filter — SQL and Prisma builders agree", () => {
  it.each(CASES)("$name", ({ qs, expected: base }) => {
    const expected = withRoster(base);
    const sql = fromSql(qs);
    const prisma = fromPrisma(qs);
    const { dateOps: _dateOps, ...sqlNormalized } = sql;
    void _dateOps;
    expect(sqlNormalized).toEqual(expected);
    expect(prisma).toEqual(expected);
    if (expected.units.center) expect(sql.dateOps).toEqual(prismaDateOps());
    else expect(sql.dateOps).toEqual([]);
  });

  it("a CWID list ANDs with the rest on both sides; an empty list matches nothing", () => {
    const qs = "type=postdoc&unit=dept:MED";
    const expected = { types: ["postdoc"], units: { department: ["MED"] }, matchNothing: false, list: ["aaa1111", "bbb2222"] };
    const { dateOps: _d, ...sql } = fromSql(qs, ["aaa1111", "bbb2222"]);
    void _d;
    expect(sql).toEqual(expected);
    expect(fromPrisma(qs, ["aaa1111", "bbb2222"])).toEqual(expected);
    expect(personFilterSql({ types: [], unitValues: [], listCwids: [] }, { scholar: "s" }, TODAY).sql.trim()).toBe(
      "AND 1 = 0",
    );
    expect(personFilterWhere({ types: [], unitValues: [], listCwids: [] }, [])).toEqual({ list: { cwid: { in: [] } } });
    // No list (undefined / null) adds nothing.
    expect(personFilterSql({ types: [], unitValues: [], listCwids: null }, { scholar: "s" }, TODAY)).toBe(Prisma.empty);
    expect(personFilterWhere({ types: [], unitValues: [], listCwids: null }, [])).toEqual({});
  });

  it("a division also matches its manual roster: the SQL subquery gates on division.source; the Prisma side takes the resolved roster", () => {
    const text = personFilterSql(parsePersonFilter(new URLSearchParams("unit=div:CARD")), { scholar: "s" }, TODAY).sql.replace(
      /\s+/g,
      " ",
    );
    expect(text).toBe(
      "AND ((s.div_code IN (?) OR s.cwid IN (SELECT pf_dm.cwid FROM division_membership pf_dm JOIN division pf_d ON pf_d.code = pf_dm.division_code WHERE pf_dm.division_code IN (?) AND pf_d.source = 'manual')))",
    );
    // No roster resolved (no manual division selected): the column alone.
    expect(personFilterWhere(parsePersonFilter(new URLSearchParams("unit=div:CARD")), [], [])).toEqual({
      unit: { OR: [{ divCode: { in: ["CARD"] } }] },
    });
  });

  it("every kind in UNIT_KINDS is reachable from a URL value on both sides", () => {
    for (const k of KINDS) {
      expect(fromSql(`unit=${prefix(k)}:Z`).units[k]).toEqual(["Z"]);
      expect(fromPrisma(`unit=${prefix(k)}:Z`).units[k]).toEqual(["Z"]);
    }
  });

  it("the center date rule: the SQL fragment and the in-app predicate are the same inequalities", () => {
    const text = currentCenterMembershipSql("cm", TODAY).sql.replace(/\s+/g, " ");
    expect(text).toBe(
      "(cm.start_date IS NULL OR cm.start_date <= ?) AND (cm.end_date IS NULL OR cm.end_date >= ?) AND (cm.membership_role_key IS NULL OR cm.membership_role_key <> 'invited')",
    );
    expect(prismaDateOps()).toEqual(["start_date <=", "end_date >="]);
    // …and both exclude an invited row, whatever its dates.
    expect(isCurrentCenterMembership({ startDate: null, endDate: null, membershipRoleKey: "invited" }, TODAY)).toBe(false);
  });

  // ONE rule, every consumer: `unit` given but none decode → match NOTHING
  // (never "no unit filter" → everyone).
  it("units that don't decode: both builders match nothing", () => {
    const qs = "unit=bogus&unit=dept:&unit=nope:X";
    const f = parsePersonFilter(new URLSearchParams(qs));
    expect(f.units).toEqual([]);
    expect(personFilterSql(f, { scholar: "s" }, TODAY).sql.trim()).toBe("AND 1 = 0");
    expect(personFilterWhere(f, CENTER_MEMBERS)).toEqual({ unit: { cwid: { in: [] } } });
  });

  // The center clause must EMBED the shared date fragment verbatim — both
  // "IS NULL OR" branches — so an inlined date rule that drops open-ended
  // (null start / null end) memberships fails here, not in prod.
  it("personFilterSql's center clause contains currentCenterMembershipSql exactly", () => {
    const norm = (t: string) => t.replace(/\s+/g, " ");
    const fragment = currentCenterMembershipSql("cm", TODAY);
    const sql = personFilterSql(
      parsePersonFilter(new URLSearchParams("unit=center:CC")),
      { scholar: "s", centerMembership: "cm" },
      TODAY,
    );
    const text = norm(sql.sql);
    expect(text).toContain(norm(fragment.sql));
    expect(text).toContain("cm.start_date IS NULL OR cm.start_date <= ?");
    expect(text).toContain("cm.end_date IS NULL OR cm.end_date >= ?");
    expect(sql.values.slice(-fragment.values.length)).toEqual(fragment.values);
  });

  it("decoded units that resolve to nothing (an empty center) match nothing on the Prisma side", () => {
    expect(personFilterWhere(parsePersonFilter(new URLSearchParams("unit=center:CC")), [])).toEqual({
      unit: { cwid: { in: [] } },
    });
  });
});

describe("personFilterCriteria — the shared criteria rows", () => {
  const labels = new Map([["dept:MED", "Medicine"]]);
  const role = (t: string) => t.toUpperCase();
  it("All when unset", () => {
    expect(personFilterCriteria({ types: [], unitValues: [] }, labels, role)).toEqual([
      ["Person type", "All"],
      ["Department / division / center / institution", "All"],
    ]);
  });
  it("labels types and units; several units read 'Any of'; an unknown unit prints raw", () => {
    expect(personFilterCriteria({ types: ["a", "b"], unitValues: ["dept:MED"] }, labels, role)).toEqual([
      ["Person type", "A; B"],
      ["Department / division / center / institution", "Medicine"],
    ]);
    expect(personFilterCriteria({ types: [], unitValues: ["dept:MED", "bogus"] }, labels, role)[1]).toEqual([
      "Department / division / center / institution",
      "Any of: Medicine; bogus",
    ]);
  });
});
