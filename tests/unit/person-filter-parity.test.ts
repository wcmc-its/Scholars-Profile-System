/**
 * Parity: the raw-SQL builder (report 8) and the Prisma builder (Profiles /
 * COI) in `lib/edit/person-filter.ts` must pick the same scholars for a
 * selection — same columns, same bound codes, same center date rule. Each
 * side's output is normalized back through `UNIT_KINDS` into
 * `{ types, units: { kind: codes } }`; an unmapped column on either side
 * throws, and one case per `UNIT_KINDS` entry is generated, so a kind wired
 * into one builder but not the other fails here.
 */
import { describe, expect, it } from "vitest";

import {
  PERSON_TYPE_COLUMN,
  UNIT_KINDS,
  currentCenterMembershipSql,
  isCurrentCenterMembership,
  parsePersonFilter,
  personFilterSql,
  personFilterWhere,
  unitCodes,
  type UnitKind,
} from "@/lib/edit/person-filter";

const TODAY = "2026-09-22";
const KINDS = Object.keys(UNIT_KINDS) as UnitKind[];
const CENTER_MEMBERS = ["abc1234"]; // fake resolved member cwid for the Prisma side

type Normalized = { types: string[]; units: Partial<Record<UnitKind, string[]>>; matchNothing: boolean };

function fromSql(qs: string): Normalized & { dateOps: string[] } {
  const sql = personFilterSql(parsePersonFilter(new URLSearchParams(qs)), { scholar: "s", centerMembership: "cm" }, TODAY);
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
    else if (alias === "cm" && column === "center_code") push((out.units.center ??= []));
    else {
      const kind = KINDS.find((k) => UNIT_KINDS[k].sql === column);
      if (alias !== "s" || !kind) throw new Error(`SQL filters on unmapped column ${alias}.${column}`);
      push((out.units[kind] ??= []));
    }
  }
  expect(v).toBe(sql.values.length);
  return out;
}

function fromPrisma(qs: string): Normalized {
  const f = parsePersonFilter(new URLSearchParams(qs));
  const w = personFilterWhere(f, CENTER_MEMBERS);
  const out: Normalized = { types: w.roleCategory?.in ?? [], units: {}, matchNothing: false };
  const ors = (w.unit?.OR ?? []) as Record<string, { in: string[] }>[];
  if (w.unit && !w.unit.OR) {
    expect(w.unit).toEqual({ cwid: { in: [] } });
    out.matchNothing = true;
  }
  for (const clause of ors) {
    const [[field, filter]] = Object.entries(clause);
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
  expect(isCurrentCenterMembership(null, null, TODAY)).toBe(true);
  const start = isCurrentCenterMembership(d(TODAY), null, TODAY) && !isCurrentCenterMembership(d(tomorrow), null, TODAY);
  const end = isCurrentCenterMembership(null, d(TODAY), TODAY) && !isCurrentCenterMembership(null, d(yesterday), TODAY);
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
];

describe("person filter — SQL and Prisma builders agree", () => {
  it.each(CASES)("$name", ({ qs, expected }) => {
    const sql = fromSql(qs);
    const prisma = fromPrisma(qs);
    expect({ types: sql.types, units: sql.units, matchNothing: sql.matchNothing }).toEqual(expected);
    expect(prisma).toEqual(expected);
    if (expected.units.center) expect(sql.dateOps).toEqual(prismaDateOps());
    else expect(sql.dateOps).toEqual([]);
  });

  it("every kind in UNIT_KINDS is reachable from a URL value on both sides", () => {
    for (const k of KINDS) {
      expect(fromSql(`unit=${prefix(k)}:Z`).units[k]).toEqual(["Z"]);
      expect(fromPrisma(`unit=${prefix(k)}:Z`).units[k]).toEqual(["Z"]);
    }
  });

  it("the center date rule: the SQL fragment and the in-app predicate are the same inequalities", () => {
    const text = currentCenterMembershipSql("cm", TODAY).sql.replace(/\s+/g, " ");
    expect(text).toBe("(cm.start_date IS NULL OR cm.start_date <= ?) AND (cm.end_date IS NULL OR cm.end_date >= ?)");
    expect(prismaDateOps()).toEqual(["start_date <=", "end_date >="]);
  });

  // Deliberate, per-caller divergence (not a parity break): report 8 keys on the
  // RAW `unit` values, Profiles on the DECODED ones — preserved as they were.
  it("units that don't decode: report 8 matches nothing, Profiles applies no unit filter", () => {
    const qs = "unit=bogus&unit=dept:";
    expect(fromSql(qs)).toMatchObject({ units: {}, matchNothing: true });
    expect(fromPrisma(qs)).toEqual({ types: [], units: {}, matchNothing: false });
  });

  it("decoded units that resolve to nothing (an empty center) match nothing on the Prisma side", () => {
    expect(personFilterWhere(parsePersonFilter(new URLSearchParams("unit=center:CC")), [])).toEqual({
      unit: { cwid: { in: [] } },
    });
  });
});
