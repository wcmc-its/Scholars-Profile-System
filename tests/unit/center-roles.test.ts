/**
 * #2542 Phase 1 — the per-center role vocabulary, its derivation, and the
 * backfill that moves the two deprecated center columns onto membership rows.
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
  DEFAULT_CENTER_ROLES,
  DIRECTOR_ROLE_KEY,
  MEMBER_ROLE_KEY,
  centerRoleSeedRows,
  deriveMembershipType,
  formatLeadershipTitle,
} from "@/lib/center-roles";
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

describe("DEFAULT_CENTER_ROLES", () => {
  it("keys are unique within the vocabulary", () => {
    const keys = DEFAULT_CENTER_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("seeds the migration targets: `director` for Center.directorCwid, and the two membershipType literals", () => {
    const byKey = new Map(DEFAULT_CENTER_ROLES.map((r) => [r.key, r]));
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
    for (const r of DEFAULT_CENTER_ROLES.filter((x) => x.group === "membership")) {
      expect(r.profileTitle).toBe(false);
    }
  });

  it("Phase 1 seeds center-scope entries only; `program` scope is Phase 2's fold-in", () => {
    expect(DEFAULT_CENTER_ROLES.every((r) => r.scope === "center")).toBe(true);
  });

  it("centerRoleSeedRows stamps the center and maps group -> roleGroup", () => {
    const rows = centerRoleSeedRows("meyer_cancer_center");
    expect(rows).toHaveLength(DEFAULT_CENTER_ROLES.length);
    expect(rows.every((r) => r.centerCode === "meyer_cancer_center")).toBe(true);
    expect(rows.every((r) => r.source === "seed")).toBe(true);
    expect(rows.find((r) => r.key === DIRECTOR_ROLE_KEY)?.roleGroup).toBe("leadership");
  });
});

describe("formatLeadershipTitle", () => {
  it("renders the bare label", () => {
    expect(formatLeadershipTitle("Director", false)).toBe("Director");
  });

  it("prefixes Interim — a modifier, not a role of its own", () => {
    expect(formatLeadershipTitle("Director", true)).toBe("Interim Director");
  });

  it("appends the portfolio qualifier CHPC publishes", () => {
    expect(
      formatLeadershipTitle("Associate Center Director", false, "Health policy communication"),
    ).toBe("Associate Center Director, Health policy communication");
  });

  it("ignores a blank or whitespace-only qualifier", () => {
    expect(formatLeadershipTitle("Research Director", false, "   ")).toBe("Research Director");
    expect(formatLeadershipTitle("Research Director", false, null)).toBe("Research Director");
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
  leadershipRoleKey?: string | null;
};

/** An in-memory stand-in for the three delegates `runBackfill` touches. */
function makeDb(opts: {
  centers: { code: string; directorCwid: string | null; leaderInterim: boolean }[];
  memberships: Membership[];
  seededRoleKeys?: { centerCode: string; key: string }[];
}) {
  const memberships: Required<Membership>[] = opts.memberships.map((m) => ({
    leadershipRoleKey: null,
    ...m,
  }));
  const roles: { centerCode: string; key: string }[] = [];
  const upserts: unknown[] = [];

  const matches = (m: Membership, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "centerCode" && typeof v === "object" && v !== null) {
        return ((v as { in: string[] }).in ?? []).includes(m.centerCode);
      }
      return (m as Record<string, unknown>)[k] === v;
    });

  const db: CenterRoleBackfillDb = {
    center: { findMany: vi.fn(async () => opts.centers) },
    centerRole: {
      createMany: vi.fn(async (args: unknown) => {
        const rows = (args as { data: { centerCode: string; key: string }[] }).data;
        let count = 0;
        for (const r of rows) {
          if (!roles.some((x) => x.centerCode === r.centerCode && x.key === r.key)) {
            roles.push({ centerCode: r.centerCode, key: r.key });
            count += 1;
          }
        }
        return { count };
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: { key: string; centerCode: { in: string[] } } }).where;
        const seeded = opts.seededRoleKeys ?? roles;
        return seeded.filter((r) => r.key === w.key && w.centerCode.in.includes(r.centerCode));
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
          if (matches(m, where)) {
            Object.assign(m, data);
            count += 1;
          }
        }
        return { count };
      }),
      upsert: vi.fn(async (args: unknown) => {
        const a = args as {
          where: { centerCode_cwid: { centerCode: string; cwid: string } };
          create: Required<Membership>;
          update: Partial<Membership>;
        };
        upserts.push(a);
        const { centerCode, cwid } = a.where.centerCode_cwid;
        const found = memberships.find((m) => m.centerCode === centerCode && m.cwid === cwid);
        if (found) Object.assign(found, a.update);
        else memberships.push({ ...a.create });
        return {};
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where?: Record<string, unknown> }).where;
        return w ? memberships.filter((m) => matches(m, w)) : memberships;
      }),
    },
  };
  return { db, memberships, roles, upserts };
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
  it("seeds the default vocabulary for every center", async () => {
    const { db, roles } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.rolesSeeded).toBe(CENTERS.length * DEFAULT_CENTER_ROLES.length);
    expect(roles.filter((x) => x.key === DIRECTOR_ROLE_KEY)).toHaveLength(CENTERS.length);
  });

  it("carries research/clinical across under the same literals and files the rest as `member`", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    await runBackfill(db, { dryRun: false });
    const key = (c: string, w: string) =>
      memberships.find((m) => m.centerCode === c && m.cwid === w)?.membershipRoleKey;
    expect(key("meyer", "dir001")).toBe("research");
    expect(key("meyer", "m002")).toBe("clinical");
    expect(key("meyer", "m003")).toBe(MEMBER_ROLE_KEY);
    expect(key("friedman", "m004")).toBe(MEMBER_ROLE_KEY);
  });

  it("never rewrites membershipType — the NCI predicate reads exactly what it read before", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    await runBackfill(db, { dryRun: false });
    const before = new Map(MEMBERSHIPS.map((m) => [`${m.centerCode} ${m.cwid}`, m.membershipType]));
    for (const m of memberships) {
      if (before.has(`${m.centerCode} ${m.cwid}`)) {
        expect(m.membershipType).toBe(before.get(`${m.centerCode} ${m.cwid}`));
      }
    }
  });

  it("moves the director onto the existing membership row without adding anyone to a roster", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    const r = await runBackfill(db, { dryRun: false });
    const dir = memberships.find((m) => m.centerCode === "meyer" && m.cwid === "dir001");
    expect(dir?.leadershipRoleKey).toBe(DIRECTOR_ROLE_KEY);
    // Still a research member — the leadership write must not clear it.
    expect(dir?.membershipRoleKey).toBe("research");
    expect(r.directorsMigrated).toBe(2);
  });

  it("mints a LEADERSHIP-ONLY row for a director who was never on the roster, so the public roster stays empty", async () => {
    const { db, memberships } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    const r = await runBackfill(db, { dryRun: false });
    expect(r.directorRowsMinted).toBe(1);
    const minted = memberships.find((m) => m.centerCode === "global_health");
    expect(minted).toMatchObject({
      cwid: "dir002",
      leadershipRoleKey: DIRECTOR_ROLE_KEY,
      // NULL membership role = "not a roster member". Every member count and the
      // public roster filter on `membershipRoleKey IS NOT NULL`, so this center's
      // roster stays at zero rather than gaining a member it never had.
      membershipRoleKey: null,
      leadershipInterim: true,
    });
  });

  it("is idempotent — a second run seeds nothing, reclassifies nothing, and does not demote the minted director", async () => {
    const { db, memberships, roles } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    await runBackfill(db, { dryRun: false });
    const rolesAfterFirst = roles.length;

    const second = await runBackfill(db, { dryRun: false });
    expect(second.rolesSeeded).toBe(0);
    expect(second.membersClassified).toBe(0);
    expect(roles).toHaveLength(rolesAfterFirst);
    // The re-run's `member` sweep must not catch the leadership-only row.
    expect(memberships.find((m) => m.centerCode === "global_health")?.membershipRoleKey).toBeNull();
  });

  it("writes nothing on --dry-run", async () => {
    const { db, memberships, roles } = makeDb({ centers: CENTERS, memberships: [...MEMBERSHIPS] });
    const r = await runBackfill(db, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(roles).toHaveLength(0);
    expect(memberships.every((m) => m.membershipRoleKey === null)).toBe(true);
    expect(memberships).toHaveLength(MEMBERSHIPS.length);
  });

  it("THROWS rather than writing a dangling leadership key when a center's vocabulary is missing", async () => {
    const { db } = makeDb({
      centers: CENTERS,
      memberships: [...MEMBERSHIPS],
      // `meyer` seeded, `global_health` not — the verify-all-before-write case.
      seededRoleKeys: [{ centerCode: "meyer", key: DIRECTOR_ROLE_KEY }],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(/global_health/);
  });

  it("THROWS when a row's membershipType disagrees with its role key — the only guard on a missed derivation", async () => {
    const { db } = makeDb({
      centers: CENTERS,
      memberships: [
        // Pre-classified by some other path, and wrong: role says clinical,
        // the enum still says research. Silent today; this is what catches it.
        {
          centerCode: "meyer",
          cwid: "m009",
          membershipRoleKey: "clinical",
          membershipType: "research",
        },
      ],
    });
    await expect(runBackfill(db, { dryRun: false })).rejects.toThrow(
      /disagrees with membershipRoleKey/,
    );
  });
});
