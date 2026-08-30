/**
 * #2542 — the org-unit role vocabulary, its derivation, and the backfill that
 * moves the two deprecated center columns onto assignment rows.
 *
 * Why this file exists: `CenterMembership.membershipType` becomes DERIVED, and a
 * derivation that silently no-ops is invisible. NULL is a legal, common value on
 * that column, so a missed write surfaces as a quietly shorter NCI CCSG REMOVE
 * list — never as an error. Nothing else in the suite pins it: every existing
 * `membershipType` assertion uses `toMatchObject` on an opaque
 * `"research" | "clinical" | null`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ORG_UNIT_ROLES,
  DIRECTOR_ROLE_KEY,
  MEMBER_ROLE_KEY,
  orgUnitRoleSeedRows,
  deriveMembershipType,
  formatLeadershipTitle,
} from "@/lib/org-unit-roles";
import {
  runBackfill,
  type CenterRoleBackfillDb,
} from "../../scripts/backfills/2026-08-29-center-role-vocabulary";

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

  it("seeds unit-scope entries only; `program` scope arrives with the CenterProgramLeader fold-in", () => {
    expect(centerRoles.every((r) => r.scope === "unit")).toBe(true);
  });

  it("seeds only the `center` kind — a role no code reads would be dead data", () => {
    // The other kinds are declared so adding one is DATA rather than a refactor.
    // They stay empty until the phase that repoints the hardcoded leader nouns.
    for (const kind of ["department", "division", "core", "center_program"] as const) {
      expect(DEFAULT_ORG_UNIT_ROLES[kind]).toEqual([]);
    }
  });

  it("orgUnitRoleSeedRows maps group -> roleGroup, stamps source, and carries its own entityType", () => {
    const rows = orgUnitRoleSeedRows("center");
    expect(rows).toHaveLength(centerRoles.length);
    expect(rows.every((r) => r.source === "seed")).toBe(true);
    expect(rows.every((r) => r.entityType === "center")).toBe(true);
    expect(rows.find((r) => r.key === DIRECTOR_ROLE_KEY)?.roleGroup).toBe("leadership");
  });

  it("orgUnitRoleSeedRows returns [] for a kind with no vocabulary yet", () => {
    expect(orgUnitRoleSeedRows("department")).toEqual([]);
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

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

type Membership = {
  centerCode: string;
  cwid: string;
  membershipRoleKey: string | null;
  membershipType: string | null;
};

type Leader = { entityType: string; entityId: string; cwid: string; roleKey: string; interim?: boolean };

/** An in-memory stand-in for the four delegates `runBackfill` touches. */
function makeDb(opts: {
  centers: { code: string; directorCwid: string | null; leaderInterim: boolean }[];
  memberships: Membership[];
  leaders?: Leader[];
  seededRoleKeys?: { entityType: string; key: string }[];
}) {
  const memberships = opts.memberships.map((m) => ({ ...m }));
  const leaders: Leader[] = (opts.leaders ?? []).map((l) => ({ ...l }));
  const roles: { entityType: string; key: string }[] = [];

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "NOT") return !matches(row, v as Record<string, unknown>);
      if (v !== null && typeof v === "object" && "in" in (v as object)) {
        return ((v as { in: string[] }).in ?? []).includes(row[k] as string);
      }
      return row[k] === v;
    });

  const db: CenterRoleBackfillDb = {
    center: { findMany: vi.fn(async () => opts.centers) },
    orgUnitRole: {
      createMany: vi.fn(async (args: unknown) => {
        const rows = (args as { data: { entityType: string; key: string }[] }).data;
        let count = 0;
        for (const r of rows) {
          if (!roles.some((x) => x.entityType === r.entityType && x.key === r.key)) {
            roles.push({ entityType: r.entityType, key: r.key });
            count += 1;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: Record<string, unknown> }).where;
        const seeded = opts.seededRoleKeys ?? roles;
        return seeded.filter((r) => matches(r as unknown as Record<string, unknown>, w));
      }),
    },
    orgUnitRoleAssignment: {
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: Record<string, unknown> }).where;
        return leaders.filter((l) =>
          matches(l as unknown as Record<string, unknown>, w),
        ) as Leader[];
      }),
      create: vi.fn(async (args: unknown) => {
        const d = (args as { data: Leader }).data;
        leaders.push({ ...d });
        return d;
      }),
    },
    centerMembership: {
      updateMany: vi.fn(async (args: unknown) => {
        const { where, data } = args as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        let count = 0;
        for (const m of memberships) {
          if (matches(m as unknown as Record<string, unknown>, where)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where?: Record<string, unknown> }).where;
        return w
          ? memberships.filter((m) => matches(m as unknown as Record<string, unknown>, w))
          : memberships;
      }),
    },
  };
  return { db, memberships, leaders, roles };
}

const CENTERS = [
  // A director who is already on the roster — the ordinary case.
  { code: "meyer", directorCwid: "dir001", leaderInterim: false },
  // A director who was NEVER added to the roster, on a center with no members
  // at all. This is the real `global_health` shape in prod.
  { code: "global_health", directorCwid: "dir002", leaderInterim: true },
  // No director at all.
  { code: "friedman", directorCwid: null, leaderInterim: false },
];

const MEMBERSHIPS: Membership[] = [
  { centerCode: "meyer", cwid: "dir001", membershipRoleKey: null, membershipType: "research" },
  { centerCode: "meyer", cwid: "m002", membershipRoleKey: null, membershipType: "clinical" },
  // The unclassified legacy shape: eight of eleven prod centers look like this.
  { centerCode: "meyer", cwid: "m003", membershipRoleKey: null, membershipType: null },
  { centerCode: "friedman", cwid: "m004", membershipRoleKey: null, membershipType: null },
];

describe("runBackfill", () => {
  it("seeds ONE shared vocabulary, not one copy per center", async () => {
    const { db, roles } = makeDb({ centers: CENTERS, memberships: MEMBERSHIPS });
    const r = await runBackfill(db, { dryRun: false });
    // The count is the size of the kind's list — NOT centers x list. If this
    // ever multiplies by center count again, the per-unit copy is back and with
    // it the ability for two centers to disagree about what a role is called.
    expect(r.rolesSeeded).toBe(DEFAULT_ORG_UNIT_ROLES.center.length);
    expect(roles.filter((x) => x.key === DIRECTOR_ROLE_KEY)).toHaveLength(1);
  });

  it("carries research/clinical across under the same literals and files the rest as `member`", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: MEMBERSHIPS });
    await runBackfill(db, { dryRun: false });
    const key = (c: string, w: string) =>
      memberships.find((m) => m.centerCode === c && m.cwid === w)?.membershipRoleKey;
    expect(key("meyer", "dir001")).toBe("research");
    expect(key("meyer", "m002")).toBe("clinical");
    expect(key("meyer", "m003")).toBe(MEMBER_ROLE_KEY);
    expect(key("friedman", "m004")).toBe(MEMBER_ROLE_KEY);
  });

  it("never rewrites membershipType — the NCI predicate reads exactly what it read before", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: MEMBERSHIPS });
    await runBackfill(db, { dryRun: false });
    const before = new Map(MEMBERSHIPS.map((m) => [`${m.centerCode} ${m.cwid}`, m.membershipType]));
    for (const m of memberships) {
      expect(m.membershipType).toBe(before.get(`${m.centerCode} ${m.cwid}`));
    }
  });

  it("creates an assignment row per director and adds NOBODY to a roster", async () => {
    const { db, memberships, leaders } = makeDb({ centers: CENTERS, memberships: MEMBERSHIPS });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.leadersCreated).toBe(2);
    expect(leaders).toEqual(
      expect.arrayContaining([
        {
          entityType: "center",
          entityId: "meyer",
          cwid: "dir001",
          roleKey: DIRECTOR_ROLE_KEY,
          interim: false,
        },
        // The prod `global_health` case: a director who is not a member. The
        // whole point of the separate table is that this adds no membership row,
        // so the center's roster and every count that reads it stay at zero.
        {
          entityType: "center",
          entityId: "global_health",
          cwid: "dir002",
          roleKey: DIRECTOR_ROLE_KEY,
          interim: true,
        },
      ]),
    );
    expect(memberships).toHaveLength(MEMBERSHIPS.length);
    expect(memberships.some((m) => m.centerCode === "global_health")).toBe(false);
  });

  it("is idempotent — a second run seeds nothing, reclassifies nothing, and creates no duplicate leader", async () => {
    const { db, roles, leaders } = makeDb({ centers: CENTERS, memberships: MEMBERSHIPS });
    await runBackfill(db, { dryRun: false });
    const rolesAfterFirst = roles.length;
    const leadersAfterFirst = leaders.length;

    const second = await runBackfill(db, { dryRun: false });
    expect(second.rolesSeeded).toBe(0);
    expect(second.membersClassified).toBe(0);
    expect(second.leadersCreated).toBe(0);
    expect(roles).toHaveLength(rolesAfterFirst);
    expect(leaders).toHaveLength(leadersAfterFirst);
  });

  it("does NOT resurrect a director a curator has since replaced", async () => {
    // Post-backfill, a curator names someone else. The dual-write keeps the
    // deprecated column in sync, but even if it lagged, step 3 skips a center
    // that already holds the role — so a re-run can never leave two holders of
    // a `singleHolder` role.
    const { db, leaders } = makeDb({
      centers: [{ code: "meyer", directorCwid: "OLD001", leaderInterim: false }],
      memberships: [],
      leaders: [
        {
          entityType: "center",
          entityId: "meyer",
          cwid: "new999",
          roleKey: DIRECTOR_ROLE_KEY,
          interim: false,
        },
      ],
    });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.leadersCreated).toBe(0);
    expect(r.leadersAlreadyPresent).toBe(1);
    expect(leaders).toHaveLength(1);
    expect(leaders[0].cwid).toBe("new999");
  });

  it("writes nothing on --dry-run, but still REPORTS the real counts", async () => {
    const { db, memberships, leaders, roles } = makeDb({
      centers: CENTERS,
      memberships: MEMBERSHIPS,
    });
    const r = await runBackfill(db, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(roles).toHaveLength(0);
    expect(leaders).toHaveLength(0);
    expect(memberships.every((m) => m.membershipRoleKey === null)).toBe(true);
    // The pre-flight has to show the operator the largest mutation in the run.
    expect(r.rolesSeeded).toBe(DEFAULT_ORG_UNIT_ROLES.center.length);
    expect(r.membersClassified).toBe(MEMBERSHIPS.length);
    expect(r.leadersCreated).toBe(2);
  });

  it("THROWS rather than writing a dangling leadership key when the kind's vocabulary is missing", async () => {
    // Verify-all-before-write. With ONE shared list the check collapses from
    // per-center to per-kind: either every center can be assigned a director or
    // none can, so an empty vocabulary must stop the run rather than write
    // assignments whose FK cannot resolve.
    const { db } = makeDb({
      centers: CENTERS,
      memberships: MEMBERSHIPS,
      seededRoleKeys: [],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(
      /Missing 'director' vocabulary row/,
    );
  });

  it("REPAIRS a row whose key and enum disagree — the rolling-deploy race", async () => {
    // During the ECS roll both images serve. A new task creates a row keyed
    // `member`; an old task then `set`s membershipType='research' on it, writing
    // only the enum. The row is now inconsistent, renders fine (every public
    // reader uses the enum), and a classify that only matched a NULL key could
    // never fix it — step 4 would then throw on every future run.
    const { db, memberships } = makeDb({
      centers: [{ code: "meyer", directorCwid: null, leaderInterim: false }],
      memberships: [
        {
          centerCode: "meyer",
          cwid: "m010",
          membershipRoleKey: MEMBER_ROLE_KEY,
          membershipType: "research",
        },
      ],
    });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.membersClassified).toBe(1);
    expect(memberships[0].membershipRoleKey).toBe("research");
    // ...and the enum itself is still untouched, so the NCI predicate is stable.
    expect(memberships[0].membershipType).toBe("research");
  });

  it("THROWS when a row's membershipType disagrees with its role key — the only guard on a missed derivation", async () => {
    const { db } = makeDb({
      centers: CENTERS,
      memberships: [
        // Drift the classify step cannot reach. Nothing else in the system would
        // ever notice; this check is the only guard.
        // `research` derives to the enum literal `research`, but the column
        // says NULL — and no classify step matches it, so nothing can repair it.
        { centerCode: "meyer", cwid: "m009", membershipRoleKey: "research", membershipType: null },
      ],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(
      /disagrees with membershipRoleKey/,
    );
  });
});
