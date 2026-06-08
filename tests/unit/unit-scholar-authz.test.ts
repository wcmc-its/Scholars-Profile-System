/**
 * Amendment 4 P1 — org-unit administrators as scholar-profile editors.
 * `canEditScholarViaUnit` (`lib/edit/unit-scholar-authz.ts`).
 *
 * Each test maps to a resolved decision (D1/D2/D3) in
 * `docs/scholar-proxy-unit-admin-amendment.md` or to a #540 dept→division
 * cascade edge (`docs/unit-curation-spec.md`), so a failure names the risk.
 */
import { describe, expect, it, vi } from "vitest";

import {
  canEditScholarViaUnit,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

const ADMIN = "adm001"; // the org-unit administrator (real cwid)
const SCHOLAR = "sch001"; // the scholar whose profile is being edited
const OTHER_ADMIN = "adm999"; // a different admin — must never match ADMIN's request

const DEPT = "DEPT-MED";
const DEPT_OTHER = "DEPT-SURG";
const DIV = "DIV-CARD"; // a division of DEPT-MED
const DIV_ROSTER = "DIV-ONC"; // a division S is on the roster of (not LDAP-primary)
const DIV_OTHER = "DIV-NEURO"; // a division of DEPT-SURG

type UnitAdminRow = {
  entityType: "department" | "division" | "center";
  entityId: string;
  cwid: string;
  role: "owner" | "curator";
};
type ScholarRow = { deptCode: string | null; divCode: string | null; deletedAt?: Date | null };

/** A `UnitScholarLookup` mock whose reads honor their `where` clauses (so the
 *  predicate's query logic — not the mock — is what each test exercises). */
function lookup(opts: {
  scholars?: Record<string, ScholarRow>;
  /** cwid → division codes the scholar is on the roster of (`DivisionMembership`). */
  rosters?: Record<string, string[]>;
  /** divisionCode → parent department code (the `Division` row). Omit a code to
   *  simulate an orphan roster entry with no `Division` row. */
  divisions?: Record<string, string>;
  unitAdmins?: UnitAdminRow[];
}): UnitScholarLookup {
  const scholars = opts.scholars ?? {};
  const rosters = opts.rosters ?? {};
  const divisions = opts.divisions ?? {};
  const rows = opts.unitAdmins ?? [];
  return {
    scholar: {
      findUnique: vi.fn(async ({ where }) => {
        const s = scholars[where.cwid];
        return s
          ? { deptCode: s.deptCode, divCode: s.divCode, deletedAt: s.deletedAt ?? null }
          : null;
      }),
    },
    divisionMembership: {
      findMany: vi.fn(async ({ where }) =>
        (rosters[where.cwid] ?? []).map((divisionCode) => ({ divisionCode })),
      ),
    },
    division: {
      findMany: vi.fn(async ({ where }) =>
        where.code.in
          .filter((code: string) => code in divisions)
          .map((code: string) => ({ code, deptCode: divisions[code] })),
      ),
    },
    unitAdmin: {
      findMany: vi.fn(async ({ where }) =>
        rows
          .filter(
            (r) =>
              r.cwid === where.cwid &&
              where.OR.some(
                (c: { entityType: string; entityId: string }) =>
                  c.entityType === r.entityType && c.entityId === r.entityId,
              ),
          )
          .map((r) => ({ entityType: r.entityType, entityId: r.entityId, role: r.role })),
      ),
    },
  };
}

describe("canEditScholarViaUnit — department membership (D1 / D2)", () => {
  it("allows a department OWNER of the scholar's department", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("allows a department CURATOR too — D2 is owner OR curator", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "curator" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("denies an admin of a DIFFERENT department (relation gate)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT_OTHER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });
});

describe("canEditScholarViaUnit — division membership, LDAP and roster (D1)", () => {
  it("allows a curator of the scholar's LDAP-primary division (Scholar.divCode)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: DIV } },
      divisions: { [DIV]: DEPT },
      unitAdmins: [{ entityType: "division", entityId: DIV, cwid: ADMIN, role: "curator" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("allows a curator of a division the scholar is only on the ROSTER of (D1 includes DivisionMembership)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      rosters: { [SCHOLAR]: [DIV_ROSTER] },
      divisions: { [DIV_ROSTER]: DEPT },
      unitAdmins: [{ entityType: "division", entityId: DIV_ROSTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("allows on an orphan roster division (no Division row) at the division level — no throw, no cascade", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      rosters: { [SCHOLAR]: [DIV_ROSTER] },
      // DIV_ROSTER intentionally absent from `divisions` → parent unknown.
      unitAdmins: [{ entityType: "division", entityId: DIV_ROSTER, cwid: ADMIN, role: "curator" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });
});

describe("canEditScholarViaUnit — dept→division cascade (#540 edges 8/9, reused)", () => {
  it("cascades a parent-department owner down to a ROSTER division (edge 8)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      rosters: { [SCHOLAR]: [DIV_ROSTER] },
      divisions: { [DIV_ROSTER]: DEPT }, // DIV_ROSTER belongs to DEPT-MED
      // ADMIN owns the PARENT department, holds no row on the division itself.
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("does NOT cascade a division grant up to cover a department-only scholar (edge 9)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } }, // member of DEPT only
      unitAdmins: [{ entityType: "division", entityId: DIV, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });

  it("does NOT cascade across departments — DEPT-SURG owner can't reach a DEPT-MED division (T2)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: DIV } },
      divisions: { [DIV]: DEPT }, // DIV's parent is DEPT-MED
      unitAdmins: [{ entityType: "department", entityId: DEPT_OTHER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });
});

describe("canEditScholarViaUnit — centers excluded (D1)", () => {
  it("never matches a CENTER admin row, even one keyed to the scholar's department code", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      // A center grant whose entityId collides with the dept code — must not match,
      // because the predicate only ever looks up entityType department/division.
      unitAdmins: [{ entityType: "center", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });

  it("issues no center lookups — every OR clause is department or division", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: DIV } },
      rosters: { [SCHOLAR]: [DIV_ROSTER] },
      divisions: { [DIV]: DEPT, [DIV_ROSTER]: DEPT },
    });
    await canEditScholarViaUnit(ADMIN, SCHOLAR, db);
    for (const call of (db.unitAdmin.findMany as ReturnType<typeof vi.fn>).mock.calls) {
      for (const clause of call[0].where.OR) {
        expect(clause.entityType === "department" || clause.entityType === "division").toBe(true);
      }
    }
  });
});

describe("canEditScholarViaUnit — real-CWID keying (mirrors proxy-authz IS-1)", () => {
  it("binds the lookup to the supplied admin cwid, not any admin of the unit", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      // The grant belongs to OTHER_ADMIN, not ADMIN.
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: OTHER_ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(await canEditScholarViaUnit(OTHER_ADMIN, SCHOLAR, db)).toBe(true);
  });
});

describe("canEditScholarViaUnit — fail-closed", () => {
  it("denies when the admin holds no unit-admin row at all", async () => {
    const db = lookup({ scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: DIV } }, divisions: { [DIV]: DEPT } });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });

  it("denies (no DB hit) on empty cwids", async () => {
    const db = lookup({ scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } } });
    expect(await canEditScholarViaUnit("", SCHOLAR, db)).toBe(false);
    expect(await canEditScholarViaUnit(ADMIN, "", db)).toBe(false);
    expect(db.scholar.findUnique).not.toHaveBeenCalled();
  });

  it("denies a missing scholar without querying unit_admin", async () => {
    const db = lookup({ unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }] });
    expect(await canEditScholarViaUnit(ADMIN, "ghost9", db)).toBe(false);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("denies a SOFT-DELETED scholar (tombstoned profile is not editable)", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null, deletedAt: new Date("2026-01-01") } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("denies (and never queries unit_admin) a scholar with no department and no divisions", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });
});
