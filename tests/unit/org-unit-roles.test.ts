/**
 * #2542 — the org-unit role vocabulary and its derivation.
 *
 * Why this file exists: `CenterMembership.membershipType` becomes DERIVED, and a
 * derivation that silently no-ops is invisible. NULL is a legal, common value on
 * that column, so a missed write surfaces as a quietly shorter NCI CCSG REMOVE
 * list — never as an error. Nothing else in the suite pins it: every existing
 * `membershipType` assertion uses `toMatchObject` on an opaque
 * `"research" | "clinical" | null`.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_UNIT_ROLES,
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIRECTOR_ROLE_KEY,
  MEMBER_ROLE_KEY,
  orgUnitRoleSeedRows,
  departmentLeaderRoleKey,
  deriveMembershipType,
  formatLeadershipTitle,
} from "@/lib/org-unit-roles";

describe("deriveMembershipType", () => {
  // CLAUDE.md records `membershipType === "research"` as an NCI REPORTING
  // PREDICATE, not a badge: `CenterCollabCandidate.isCurrentMember` matches the
  // literal. These two literals must survive the vocabulary verbatim.
  it("passes the two enum literals through unchanged", () => {
    expect(deriveMembershipType("research")).toBe("research");
    expect(deriveMembershipType("clinical")).toBe("clinical");
  });

  it("derives NULL for the seeded `member` role, so an unclassified member still renders with no badge and no facet", () => {
    expect(deriveMembershipType(MEMBER_ROLE_KEY)).toBeNull();
  });

  it("derives NULL for a leadership-only row and for an absent key", () => {
    expect(deriveMembershipType(null)).toBeNull();
    expect(deriveMembershipType(undefined)).toBeNull();
  });

  it("derives NULL — never the key itself — for a role a curator mints in Phase 3", () => {
    // `membership_type` is a real MySQL ENUM('research','clinical'). Emitting
    // any other string makes MySQL reject the whole transaction with error 1265
    // and roll the audit row back with it, surfacing as a bare 500.
    expect(deriveMembershipType("core_faculty_fellow")).toBeNull();
    expect(deriveMembershipType("leadership")).toBeNull();
    expect(deriveMembershipType("")).toBeNull();
  });
});

describe("DEFAULT_ORG_UNIT_ROLES", () => {
  const centerRoles = DEFAULT_ORG_UNIT_ROLES.center;

  it("keys are unique within each kind's vocabulary", () => {
    for (const [kind, roles] of Object.entries(DEFAULT_ORG_UNIT_ROLES)) {
      const keys = roles.map((r) => r.key);
      expect(new Set(keys).size, `duplicate key in the ${kind} vocabulary`).toBe(keys.length);
    }
  });

  it("is keyed BY KIND, not by unit — this is what makes per-unit drift unrepresentable", () => {
    // A per-unit copy is a drift generator: the same concept can acquire a
    // different word at every unit, and the governance layer's job becomes
    // policing divergence. There is one list per kind and no unit code anywhere
    // in the seed, so two units CANNOT disagree about what a role is called.
    for (const rows of Object.values(DEFAULT_ORG_UNIT_ROLES)) {
      for (const r of rows) {
        expect(r).not.toHaveProperty("centerCode");
        expect(r).not.toHaveProperty("entityId");
      }
    }
  });

  it("seeds the migration targets: `director` for Center.directorCwid, and the two membershipType literals", () => {
    const byKey = new Map(centerRoles.map((r) => [r.key, r]));
    expect(byKey.get(DIRECTOR_ROLE_KEY)).toMatchObject({
      group: "leadership",
      singleHolder: true,
      profileTitle: true,
    });
    // Seeded under the SAME literals the enum uses — this is what makes the
    // migration behaviour-preserving for Cancer Center reporting.
    expect(byKey.get("research")).toMatchObject({ group: "membership" });
    expect(byKey.get("clinical")).toMatchObject({ group: "membership" });
    expect(byKey.get(MEMBER_ROLE_KEY)).toMatchObject({ group: "membership" });
  });

  it("membership roles are never profile titles — being a member is not a title", () => {
    for (const r of centerRoles.filter((x) => x.group === "membership")) {
      expect(r.profileTitle).toBe(false);
    }
  });

  it("seeds unit-scope entries only; `program` scope arrives with the center_program vocabulary (#2558)", () => {
    expect(centerRoles.every((r) => r.scope === "unit")).toBe(true);
  });

  it("seeds all five kinds — center, department, division, core, and (#2558) center_program", () => {
    for (const kind of [
      "center",
      "department",
      "division",
      "core",
      "center_program",
    ] as const) {
      expect(DEFAULT_ORG_UNIT_ROLES[kind].length, `${kind} should be seeded`).toBeGreaterThan(0);
    }
  });

  // #2558 — the center_program vocabulary.
  it("center_program seeds leader (profileTitle true) and coe_liaison (profileTitle false, with expansion)", () => {
    expect(DEFAULT_ORG_UNIT_ROLES.center_program).toEqual([
      {
        key: "leader",
        label: "Leader",
        group: "leadership",
        scope: "program",
        singleHolder: false,
        sortOrder: 10,
        profileTitle: true,
      },
      {
        key: "coe_liaison",
        label: "COE Liaison",
        group: "leadership",
        scope: "program",
        singleHolder: false,
        sortOrder: 20,
        profileTitle: false,
        expansion: "Community Outreach & Engagement",
      },
    ]);
  });

  it("department seeds BOTH chair and director, matching the exact shape the ticket specifies", () => {
    const byKey = new Map(DEFAULT_ORG_UNIT_ROLES.department.map((r) => [r.key, r]));
    expect(byKey.get("chair")).toMatchObject({
      label: "Chair",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 10,
      profileTitle: true,
    });
    expect(byKey.get("director")).toMatchObject({
      label: "Director",
      group: "leadership",
      scope: "unit",
      singleHolder: true,
      sortOrder: 20,
      profileTitle: true,
    });
    expect(DEFAULT_ORG_UNIT_ROLES.department).toHaveLength(2);
  });

  it("division seeds only chief, singleHolder true", () => {
    expect(DEFAULT_ORG_UNIT_ROLES.division).toEqual([
      {
        key: "chief",
        label: "Chief",
        group: "leadership",
        scope: "unit",
        singleHolder: true,
        sortOrder: 10,
        profileTitle: true,
      },
    ]);
  });

  it("core seeds director with singleHolder FALSE — a core may be co-led (CoreLeader's own docblock)", () => {
    expect(DEFAULT_ORG_UNIT_ROLES.core).toEqual([
      {
        key: "director",
        label: "Director",
        group: "leadership",
        scope: "unit",
        singleHolder: false,
        sortOrder: 10,
        profileTitle: true,
      },
    ]);
  });

  it("orgUnitRoleSeedRows maps group -> roleGroup, stamps source, and carries its own entityType", () => {
    const rows = orgUnitRoleSeedRows("center");
    expect(rows).toHaveLength(centerRoles.length);
    expect(rows.every((r) => r.source === "seed")).toBe(true);
    expect(rows.every((r) => r.entityType === "center")).toBe(true);
    expect(rows.find((r) => r.key === DIRECTOR_ROLE_KEY)?.roleGroup).toBe("leadership");
  });

  // #2558 Phase 1 — center_program is no longer empty; `expansion` rides
  // along as `null` for the role with none, and as the vocabulary's own
  // string for coe_liaison — never `undefined`, since this shapes a Prisma
  // `createMany` row.
  it("orgUnitRoleSeedRows carries expansion (null for leader, the string for coe_liaison)", () => {
    const rows = orgUnitRoleSeedRows("center_program");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entityType === "center_program")).toBe(true);
    expect(rows.find((r) => r.key === "leader")?.expansion).toBeNull();
    const coeLiaison = rows.find((r) => r.key === "coe_liaison");
    expect(coeLiaison?.expansion).toBe("Community Outreach & Engagement");
    expect(coeLiaison?.profileTitle).toBe(false);
  });

  it("orgUnitRoleSeedRows carries expansion: null (not undefined) for a kind with no expansion at all", () => {
    const rows = orgUnitRoleSeedRows("center");
    expect(rows.every((r) => r.expansion === null)).toBe(true);
  });

  it("orgUnitRoleSeedRows carries department's own entityType, not center's", () => {
    const rows = orgUnitRoleSeedRows("department");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entityType === "department")).toBe(true);
    expect(rows.map((r) => r.key).sort()).toEqual(["chair", "director"]);
  });

  it("the EMITTED rows carry no unit identifier — the anti-drift invariant, at the boundary", () => {
    // Asserting this on DEFAULT_ORG_UNIT_ROLES alone is not enough: the rows
    // that reach `createMany` come out of this function, so a unit key added
    // here would restore per-unit copies while the constant still looked clean.
    // A mutation that put `centerCode` back survived until this test existed.
    for (const row of orgUnitRoleSeedRows("center")) {
      for (const field of ["centerCode", "center_code", "entityId", "entity_id", "unitCode"]) {
        expect(row, `seed row must not carry ${field} — that is a per-unit copy`).not.toHaveProperty(
          field,
        );
      }
      expect(Object.keys(row).filter((k) => /code$/i.test(k))).toEqual([]);
    }
  });
});

describe("formatLeadershipTitle", () => {
  it("renders the bare label", () => {
    expect(formatLeadershipTitle("Director", false)).toBe("Director");
  });

  it("prefixes Interim — a modifier, not a role of its own", () => {
    expect(formatLeadershipTitle("Director", true)).toBe("Interim Director");
  });

  it("takes NO qualifier — a portfolio is its own vocabulary entry, not free text", () => {
    // CHPC publishes "Associate Center Director, Health policy communication".
    // That is an ENTRY in the shared list, so its whole label renders verbatim
    // and no free-text field exists on the assignment to be concatenated here.
    expect(
      formatLeadershipTitle("Associate Center Director, Health policy communication", false),
    ).toBe("Associate Center Director, Health policy communication");
    expect(formatLeadershipTitle).toHaveLength(2);
  });
});

describe("departmentLeaderRoleKey", () => {
  // The regression this exists to prevent: four ternary/literal sites used to
  // each decide Chair-vs-Director independently. All four live `category`
  // values, confirmed against prod (31/31 departments have one of these):
  it("returns `director` ONLY for the administrative category", () => {
    expect(departmentLeaderRoleKey("administrative")).toBe(DEPARTMENT_DIRECTOR_ROLE_KEY);
  });

  it("returns `chair` for clinical, mixed, and basic", () => {
    expect(departmentLeaderRoleKey("clinical")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
    expect(departmentLeaderRoleKey("mixed")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
    expect(departmentLeaderRoleKey("basic")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
  });

  it("defaults an unrecognized category to `chair` — same fallback etl/ed/index.ts already uses", () => {
    expect(departmentLeaderRoleKey("some-future-category")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
    expect(departmentLeaderRoleKey("")).toBe(DEPARTMENT_CHAIR_ROLE_KEY);
  });

  it("the two returned literals match the seeded department vocabulary keys exactly", () => {
    const seededKeys = new Set(DEFAULT_ORG_UNIT_ROLES.department.map((r) => r.key));
    expect(seededKeys.has(departmentLeaderRoleKey("administrative"))).toBe(true);
    expect(seededKeys.has(departmentLeaderRoleKey("clinical"))).toBe(true);
  });
});
