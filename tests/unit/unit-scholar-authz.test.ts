/**
 * Amendment 4 P1 — org-unit administrators as scholar-profile editors.
 * `canEditScholarViaUnit` (`lib/edit/unit-scholar-authz.ts`).
 *
 * Each test maps to a resolved decision (D1/D2/D3) in
 * `docs/scholar-proxy-unit-admin-amendment.md` or to a #540 dept→division
 * cascade edge (`docs/unit-curation-spec.md`), so a failure names the risk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canEditScholarViaUnit,
  listUnitAdminEditorsForScholar,
  resolveEditableUnitViaUnitAdmin,
  type UnitAdminEditorsLookup,
  type UnitScholarLookup,
} from "@/lib/edit/unit-scholar-authz";

/** #1104 — the center leg is behind `UNIT_ADMIN_CENTER_PROXY` (default off). The
 *  flag reads `process.env`, so toggle it here; every test cleans up after. */
function withCenterProxyFlag(on: boolean): void {
  if (on) process.env.UNIT_ADMIN_CENTER_PROXY = "on";
  else delete process.env.UNIT_ADMIN_CENTER_PROXY;
}
afterEach(() => {
  delete process.env.UNIT_ADMIN_CENTER_PROXY;
});

const ADMIN = "adm001"; // the org-unit administrator (real cwid)
const SCHOLAR = "sch001"; // the scholar whose profile is being edited
const OTHER_ADMIN = "adm999"; // a different admin — must never match ADMIN's request

const DEPT = "DEPT-MED";
const DEPT_OTHER = "DEPT-SURG";
const DIV = "DIV-CARD"; // a division of DEPT-MED
const DIV_ROSTER = "DIV-ONC"; // a division S is on the roster of (not LDAP-primary)
const DIV_OTHER = "DIV-NEURO"; // a division of DEPT-SURG
const CENTER = "CTR-CANCER"; // a center S is a current member of (#1104)
const CENTER_OTHER = "CTR-CARDIO"; // a center S is NOT a member of

type UnitAdminRow = {
  entityType: "department" | "division" | "center";
  entityId: string;
  cwid: string;
  role: "owner" | "curator";
};
type ScholarRow = { deptCode: string | null; divCode: string | null; deletedAt?: Date | null };
/** A center membership the scholar holds, with its dated window. */
type CenterMemRow = { centerCode: string; startDate: Date | null; endDate: Date | null };

/** A `UnitScholarLookup` mock whose reads honor their `where` clauses (so the
 *  predicate's query logic — not the mock — is what each test exercises). */
function lookup(opts: {
  scholars?: Record<string, ScholarRow>;
  /** cwid → division codes the scholar is on the roster of (`DivisionMembership`). */
  rosters?: Record<string, string[]>;
  /** divisionCode → parent department code (the `Division` row). Omit a code to
   *  simulate an orphan roster entry with no `Division` row. */
  divisions?: Record<string, string>;
  /** cwid → center memberships the scholar holds (`CenterMembership`), each with
   *  its dated window so the active filter can be exercised (#1104). */
  centerMemberships?: Record<string, CenterMemRow[]>;
  unitAdmins?: UnitAdminRow[];
}): UnitScholarLookup {
  const scholars = opts.scholars ?? {};
  const rosters = opts.rosters ?? {};
  const divisions = opts.divisions ?? {};
  const centerMemberships = opts.centerMemberships ?? {};
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
    centerMembership: {
      findMany: vi.fn(async ({ where }) => centerMemberships[where.cwid] ?? []),
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

describe("canEditScholarViaUnit — centers excluded when flag OFF (D1 default)", () => {
  it("never matches a CENTER admin row, even one keyed to the scholar's department code", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      // A center grant whose entityId collides with the dept code — must not match,
      // because the predicate only ever looks up entityType department/division.
      unitAdmins: [{ entityType: "center", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });

  it("issues no center lookups — every OR clause is department or division, and CenterMembership is never read", async () => {
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
    // Flag off ⇒ the CenterMembership read is never issued (dept/division unchanged).
    expect(db.centerMembership.findMany).not.toHaveBeenCalled();
  });

  it("a center owner of the scholar's CURRENT center confers nothing while the flag is off", async () => {
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [{ centerCode: CENTER, startDate: null, endDate: null }] },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(db.centerMembership.findMany).not.toHaveBeenCalled();
  });
});

describe("canEditScholarViaUnit — center membership when flag ON (#1104)", () => {
  // A wide-open window: started in the past, no end. Active for any `today`.
  const OPEN: CenterMemRow = {
    centerCode: CENTER,
    startDate: new Date("2020-01-01"),
    endDate: null,
  };

  it("allows a center OWNER of a center the scholar is a CURRENT member of", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("allows a center CURATOR too — D2 is owner OR curator", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "curator" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("denies a center admin when the scholar is NOT a member of that center", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] }, // member of CENTER, not CENTER_OTHER
      unitAdmins: [{ entityType: "center", entityId: CENTER_OTHER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
  });

  it("excludes a LAPSED membership (endDate in the past) — confers nothing", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: {
        [SCHOLAR]: [
          { centerCode: CENTER, startDate: new Date("2020-01-01"), endDate: new Date("2021-01-01") },
        ],
      },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    // No active center membership → no dept/div either → no unit_admin query.
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("excludes a PENDING membership (startDate in the future) — confers nothing", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: {
        [SCHOLAR]: [{ centerCode: CENTER, startDate: new Date("2999-01-01"), endDate: null }],
      },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("binds the center lookup to the supplied admin cwid (IS-1 real-CWID keying)", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      // The grant belongs to OTHER_ADMIN, not ADMIN.
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: OTHER_ADMIN, role: "owner" }],
    });
    expect(await canEditScholarViaUnit(ADMIN, SCHOLAR, db)).toBe(false);
    expect(await canEditScholarViaUnit(OTHER_ADMIN, SCHOLAR, db)).toBe(true);
  });

  it("returns the center as the conferring EditableUnit (resolver, not the boolean façade)", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await resolveEditableUnitViaUnitAdmin(ADMIN, SCHOLAR, db)).toEqual({
      kind: "center",
      code: CENTER,
    });
  });

  it("dept/division access is unchanged with the flag on (center leg is purely additive)", async () => {
    withCenterProxyFlag(true);
    const db = lookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await resolveEditableUnitViaUnitAdmin(ADMIN, SCHOLAR, db)).toEqual({
      kind: "department",
      code: DEPT,
    });
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

// ───────────────────────────────────────────────────────────────────────────
// listUnitAdminEditorsForScholar — the INVERSE listing (Amendment 4 P3).
// "Given a scholar, who administers a unit they belong to?" Mirrors the forward
// resolver's membership model + cascade attribution. A display listing only —
// authorization stays the forward predicate's job, so coverage here is about the
// listing being faithful, not about gating.
// ───────────────────────────────────────────────────────────────────────────

/** A `UnitAdminEditorsLookup` mock that honors the inverse query shape: the
 *  `unit_admin` scan filters on `where.OR` by unit code (NO single `cwid`), and
 *  the division/department reads resolve display NAMES. */
function inverseLookup(opts: {
  scholars?: Record<string, ScholarRow>;
  rosters?: Record<string, string[]>;
  /** divisionCode → { deptCode (parent), name }. Omit a code to simulate an
   *  orphan roster entry with no `Division` row. */
  divisions?: Record<string, { deptCode: string; name: string }>;
  /** deptCode → name. Omit a code to simulate a pruned `Department` row. */
  departments?: Record<string, string>;
  /** cwid → center memberships the scholar holds, each dated (#1104). */
  centerMemberships?: Record<string, CenterMemRow[]>;
  /** centerCode → name. Omit a code to simulate a pruned `Center` row. */
  centers?: Record<string, string>;
  unitAdmins?: UnitAdminRow[];
}): UnitAdminEditorsLookup {
  const scholars = opts.scholars ?? {};
  const rosters = opts.rosters ?? {};
  const divisions = opts.divisions ?? {};
  const departments = opts.departments ?? {};
  const centerMemberships = opts.centerMemberships ?? {};
  const centers = opts.centers ?? {};
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
          .map((code: string) => ({
            code,
            deptCode: divisions[code].deptCode,
            name: divisions[code].name,
          })),
      ),
    },
    department: {
      findMany: vi.fn(async ({ where }) =>
        where.code.in
          .filter((code: string) => code in departments)
          .map((code: string) => ({ code, name: departments[code] })),
      ),
    },
    centerMembership: {
      findMany: vi.fn(async ({ where }) => centerMemberships[where.cwid] ?? []),
    },
    center: {
      findMany: vi.fn(async ({ where }) =>
        where.code.in
          .filter((code: string) => code in centers)
          .map((code: string) => ({ code, name: centers[code] })),
      ),
    },
    unitAdmin: {
      findMany: vi.fn(async ({ where }) =>
        rows
          .filter((r) =>
            where.OR.some(
              (c: { entityType: string; entityId: { in: string[] } }) =>
                c.entityType === r.entityType && c.entityId.in.includes(r.entityId),
            ),
          )
          .map((r) => ({
            cwid: r.cwid,
            entityType: r.entityType,
            entityId: r.entityId,
            role: r.role,
          })),
      ),
    },
  };
}

describe("listUnitAdminEditorsForScholar — fail-closed", () => {
  it("returns [] with no DB hit on an empty scholar cwid", async () => {
    const db = inverseLookup({ scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } } });
    expect(await listUnitAdminEditorsForScholar("", db)).toEqual([]);
    expect(db.scholar.findUnique).not.toHaveBeenCalled();
  });

  it("returns [] for a missing scholar", async () => {
    const db = inverseLookup({
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar("ghost9", db)).toEqual([]);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("returns [] for a SOFT-DELETED scholar without querying unit_admin", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null, deletedAt: new Date("2026-01-01") } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([]);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("returns [] (and never queries unit_admin) for a scholar with no department and no divisions", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([]);
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });
});

describe("listUnitAdminEditorsForScholar — attribution + cascade (mirrors the forward resolver)", () => {
  it("lists a department admin attributed to the DEPARTMENT, name resolved", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      departments: { [DEPT]: "Department of Medicine" },
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "curator" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "department",
        conferringUnitCode: DEPT,
        conferringUnitName: "Department of Medicine",
        role: "curator",
      },
    ]);
  });

  it("lists a division admin attributed to the DIVISION, name resolved", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: DIV } },
      divisions: { [DIV]: { deptCode: DEPT, name: "Division of Cardiology" } },
      unitAdmins: [{ entityType: "division", entityId: DIV, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "division",
        conferringUnitCode: DIV,
        conferringUnitName: "Division of Cardiology",
        role: "owner",
      },
    ]);
  });

  it("attributes a PARENT-department admin to the CHILD division (cascade — not the parent dept)", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: DIV } },
      divisions: { [DIV]: { deptCode: DEPT, name: "Division of Cardiology" } },
      departments: { [DEPT]: "Department of Medicine" },
      // ADMIN owns the PARENT department, holds no row on the division itself.
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "division",
        conferringUnitCode: DIV,
        conferringUnitName: "Division of Cardiology",
        role: "owner",
      },
    ]);
  });

  it("never lists a CENTER admin, even one keyed to the scholar's department code", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      departments: { [DEPT]: "Department of Medicine" },
      unitAdmins: [{ entityType: "center", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([]);
  });

  it("dedupes an admin granted both owner and curator on the same unit, keeping owner", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      departments: { [DEPT]: "Department of Medicine" },
      unitAdmins: [
        { entityType: "department", entityId: DEPT, cwid: ADMIN, role: "curator" },
        { entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" },
      ],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "department",
        conferringUnitCode: DEPT,
        conferringUnitName: "Department of Medicine",
        role: "owner",
      },
    ]);
  });

  it("lists multiple distinct admins in a stable order, source-agnostically (ED-sourced rows included)", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: DIV } },
      divisions: { [DIV]: { deptCode: DEPT, name: "Division of Cardiology" } },
      departments: { [DEPT]: "Department of Medicine" },
      unitAdmins: [
        // OTHER_ADMIN's division grant could be ED-sourced — the resolver never
        // reads `source`, so it is listed exactly like a native grant.
        { entityType: "division", entityId: DIV, cwid: OTHER_ADMIN, role: "curator" },
        { entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" },
      ],
    });
    const list = await listUnitAdminEditorsForScholar(SCHOLAR, db);
    expect(list.map((e) => e.adminCwid)).toEqual([ADMIN, OTHER_ADMIN]); // adm001 < adm999
    expect(list[0]).toEqual({
      adminCwid: ADMIN,
      conferringUnitKind: "department",
      conferringUnitCode: DEPT,
      conferringUnitName: "Department of Medicine",
      role: "owner",
    });
    expect(list[1]).toEqual({
      adminCwid: OTHER_ADMIN,
      conferringUnitKind: "division",
      conferringUnitCode: DIV,
      conferringUnitName: "Division of Cardiology",
      role: "curator",
    });
  });

  it("falls back to the unit code when the name row is gone (pruned unit)", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      // DEPT intentionally absent from `departments` → no name row.
      unitAdmins: [{ entityType: "department", entityId: DEPT, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "department",
        conferringUnitCode: DEPT,
        conferringUnitName: DEPT,
        role: "owner",
      },
    ]);
  });
});

describe("listUnitAdminEditorsForScholar — center extension (#1104)", () => {
  const OPEN: CenterMemRow = {
    centerCode: CENTER,
    startDate: new Date("2020-01-01"),
    endDate: null,
  };

  it("never lists a center admin while the flag is OFF, and never reads CenterMembership", async () => {
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      centers: { [CENTER]: "Cancer Center" },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([]);
    expect(db.centerMembership.findMany).not.toHaveBeenCalled();
  });

  it("lists a center admin attributed to the CENTER (name resolved) when the flag is ON", async () => {
    withCenterProxyFlag(true);
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      centers: { [CENTER]: "Cancer Center" },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "curator" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "center",
        conferringUnitCode: CENTER,
        conferringUnitName: "Cancer Center",
        role: "curator",
      },
    ]);
  });

  it("excludes a center admin for a LAPSED membership when the flag is ON", async () => {
    withCenterProxyFlag(true);
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: {
        [SCHOLAR]: [
          { centerCode: CENTER, startDate: new Date("2020-01-01"), endDate: new Date("2021-01-01") },
        ],
      },
      centers: { [CENTER]: "Cancer Center" },
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([]);
    // No active center, no dept/div → no unit_admin scan.
    expect(db.unitAdmin.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the center code when the Center name row is pruned (flag ON)", async () => {
    withCenterProxyFlag(true);
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: null, divCode: null } },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      // CENTER intentionally absent from `centers` → no name row.
      unitAdmins: [{ entityType: "center", entityId: CENTER, cwid: ADMIN, role: "owner" }],
    });
    expect(await listUnitAdminEditorsForScholar(SCHOLAR, db)).toEqual([
      {
        adminCwid: ADMIN,
        conferringUnitKind: "center",
        conferringUnitCode: CENTER,
        conferringUnitName: CENTER,
        role: "owner",
      },
    ]);
  });

  it("lists dept and center admins together, stably ordered (flag ON)", async () => {
    withCenterProxyFlag(true);
    const db = inverseLookup({
      scholars: { [SCHOLAR]: { deptCode: DEPT, divCode: null } },
      departments: { [DEPT]: "Department of Medicine" },
      centerMemberships: { [SCHOLAR]: [OPEN] },
      centers: { [CENTER]: "Cancer Center" },
      unitAdmins: [
        { entityType: "center", entityId: CENTER, cwid: OTHER_ADMIN, role: "owner" },
        { entityType: "department", entityId: DEPT, cwid: ADMIN, role: "curator" },
      ],
    });
    const list = await listUnitAdminEditorsForScholar(SCHOLAR, db);
    expect(list).toEqual([
      {
        adminCwid: ADMIN, // adm001 < adm999
        conferringUnitKind: "department",
        conferringUnitCode: DEPT,
        conferringUnitName: "Department of Medicine",
        role: "curator",
      },
      {
        adminCwid: OTHER_ADMIN,
        conferringUnitKind: "center",
        conferringUnitCode: CENTER,
        conferringUnitName: "Cancer Center",
        role: "owner",
      },
    ]);
  });
});
