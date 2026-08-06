/**
 * #2202 — the LOADER-level half of the #536 FERPA carve: a hidden identity class
 * (doctoral students, `affiliate_alumni`) must never be LOADED onto a public unit
 * roster, not merely de-linked at render time. #2230 fixed the render guard; this
 * pins the WHERE clauses, so a future refactor of `person-row.tsx` cannot re-open
 * a 684-name enumeration.
 *
 * THE FIXTURE IS THE PROD SHAPE, DELIBERATELY.
 *
 * Prod and staging are mirror images for this carve. On staging every doctoral
 * student carries a SUFFIXED role (`doctoral_student_md`) AND a soft-delete, so
 * `deletedAt` does the work and the role guard is inert — a fixture built from
 * staging proves nothing. On prod, ~690 students carry the BARE `doctoral_student`
 * with `deleted_at IS NULL` and `status = 'active'`, so the role carve is the ONLY
 * gate. Every scholar in `SCHOLARS` below is therefore non-deleted and active; only
 * `roleCategory` separates them.
 *
 * The fake Prisma below EVALUATES the where-clause rather than ignoring it, so
 * these assert filtered OUTPUT, not just call args — reverting any carve turns the
 * students back up in `hits` / `total`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { HIDDEN_ROLE_CATEGORIES, publicRoleWhere } from "@/lib/eligibility";

type ScholarRow = {
  cwid: string;
  preferredName: string;
  slug: string;
  primaryTitle: string | null;
  primaryDepartment: string | null;
  roleCategory: string | null;
  overview: string | null;
  professorialRank: string | null;
  deptCode: string | null;
  divCode: string | null;
  deletedAt: Date | null;
  status: string;
  department: { name: string } | null;
  division: { name: string } | null;
};

function scholar(cwid: string, roleCategory: string | null): ScholarRow {
  return {
    cwid,
    preferredName: `Name ${cwid}`,
    slug: `slug-${cwid}`,
    primaryTitle: "Title",
    primaryDepartment: "Medicine",
    roleCategory,
    overview: null,
    professorialRank: null,
    deptCode: "MED",
    divCode: "CARDIO",
    // The prod shape: NOT soft-deleted, status active. `deletedAt` cannot help.
    deletedAt: null,
    status: "active",
    department: { name: "Medicine" },
    division: { name: "Cardiology" },
  };
}

/** 2 displayable (one un-backfilled NULL) + 3 hidden. Carved total is always 2. */
const SCHOLARS: ScholarRow[] = [
  scholar("fac00001", "full_time_faculty"),
  scholar("nul00002", null), // un-backfilled — MUST survive the carve
  scholar("stu00003", "doctoral_student"), // the bare prod value
  scholar("stu00004", "doctoral_student_mdphd"), // an out-of-band suffixed value
  scholar("alu00005", "affiliate_alumni"),
];
const VISIBLE = ["fac00001", "nul00002"];

/** Evaluate the subset of Prisma where-syntax these loaders actually emit. */
function matches(row: ScholarRow, where: Record<string, unknown> = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matches(row, cond as Record<string, unknown>)) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond !== null && typeof cond === "object") {
      const c = cond as { in?: unknown[]; notIn?: unknown[] };
      if (c.in && !c.in.includes(value)) return false;
      // The trap this test exists for: `notIn` on a NULLable column is
      // three-valued in SQL — `NULL NOT IN (…)` is NULL, not TRUE — so a NULL
      // row does NOT satisfy it. Modelled faithfully; the loaders must supply
      // the `{ roleCategory: null }` OR-arm to keep un-backfilled scholars.
      if (c.notIn && (value === null || c.notIn.includes(value))) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

const {
  scholarFindMany,
  scholarFindFirst,
  scholarFindUnique,
  scholarCount,
  scholarGroupBy,
  scholarFamilyFindMany,
  divisionFindFirst,
  divisionFindMany,
  divisionMembershipFindMany,
  centerFindUnique,
  centerMembershipFindMany,
  centerProgramFindMany,
  departmentFindUnique,
  publicationTopicGroupBy,
  publicationTopicCount,
  publicationCount,
  grantGroupBy,
  grantFindMany,
  publicationAuthorGroupBy,
  topicFindMany,
  queryRawUnsafe,
  facetEnabled,
} = vi.hoisted(() => ({
  scholarFindMany: vi.fn(),
  scholarFindFirst: vi.fn(),
  scholarFindUnique: vi.fn(),
  scholarCount: vi.fn(),
  scholarGroupBy: vi.fn(),
  scholarFamilyFindMany: vi.fn(),
  divisionFindFirst: vi.fn(),
  divisionFindMany: vi.fn(),
  divisionMembershipFindMany: vi.fn(),
  centerFindUnique: vi.fn(),
  centerMembershipFindMany: vi.fn(),
  centerProgramFindMany: vi.fn(),
  departmentFindUnique: vi.fn(),
  publicationTopicGroupBy: vi.fn(),
  publicationTopicCount: vi.fn(),
  publicationCount: vi.fn(),
  grantGroupBy: vi.fn(),
  grantFindMany: vi.fn(),
  publicationAuthorGroupBy: vi.fn(),
  topicFindMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
  facetEnabled: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findMany: scholarFindMany,
      findFirst: scholarFindFirst,
      findUnique: scholarFindUnique,
      count: scholarCount,
      groupBy: scholarGroupBy,
    },
    scholarFamily: { findMany: scholarFamilyFindMany },
    division: { findFirst: divisionFindFirst, findMany: divisionFindMany },
    divisionMembership: { findMany: divisionMembershipFindMany },
    center: { findUnique: centerFindUnique },
    centerMembership: { findMany: centerMembershipFindMany },
    centerProgram: { findMany: centerProgramFindMany },
    department: { findUnique: departmentFindUnique },
    publicationTopic: { groupBy: publicationTopicGroupBy, count: publicationTopicCount },
    publication: { count: publicationCount },
    grant: { groupBy: grantGroupBy, findMany: grantFindMany },
    publicationAuthor: { groupBy: publicationAuthorGroupBy },
    topic: { findMany: topicFindMany },
    $queryRawUnsafe: queryRawUnsafe,
  },
}));

vi.mock("@/lib/api/manual-layer", () => ({
  isUnitSuppressed: async () => false,
  loadUnitFieldOverrides: async () => [],
  mergeUnitFields: (base: Record<string, unknown>) => ({ ...base, leaderInterim: false }),
  loadAllPublicationSuppressions: async () => [],
  resolveUnitDarkPmids: async () => [],
  resolveActiveGrantSuppression: async () => ({ suppressed: new Set<string>() }),
  loadHiddenAuthorshipCounts: async () => new Map(),
  isAuthorHidden: () => false,
}));

vi.mock("@/lib/api/unit-grant-projects", () => ({
  loadUnitGrantProjects: async () => [],
  buildUnitGrantCards: async () => [],
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isOrgUnitMethodsChipsEnabled: () => false,
  isOrgUnitMethodsFacetEnabled: () => facetEnabled(),
  isCenterMethodsFacetEnabled: () => false,
  isMethodsLensEnabled: () => false,
  isMethodsLensSensitiveGateOn: () => false,
}));

vi.mock("@/lib/api/methods-roster", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/methods-roster")>("@/lib/api/methods-roster");
  return {
    ...actual,
    loadPublicFamiliesForMembers: async () => new Map(),
    aggregatePublicFamiliesForUnit: vi.fn(async (cwids: string[]) => [
      { value: "sc::Fam", label: "Fam", count: cwids.length },
    ]),
  };
});

vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: async () => ({ suppressed: new Set(), sensitive: new Set() }),
  isFamilyPubliclyVisible: () => true,
}));

vi.mock("@/lib/api/swr-cache", () => ({
  cachedRead: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";
import { getDivision, getDivisionFaculty } from "@/lib/api/divisions";
import { getCenter, getCenterMembers } from "@/lib/api/centers";
import { getUnitMembersByMethods } from "@/lib/api/unit-members";
import { countActiveCenterMembersByCode } from "@/lib/api/center-member-count";

beforeEach(() => {
  vi.clearAllMocks();
  facetEnabled.mockReturnValue(false);

  scholarFindMany.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
    SCHOLARS.filter((s) => matches(s, args?.where)),
  );
  scholarFindFirst.mockImplementation(
    async (args: { where?: Record<string, unknown> }) =>
      SCHOLARS.find((s) => matches(s, args?.where)) ?? null,
  );
  scholarFindUnique.mockResolvedValue(null);
  scholarCount.mockImplementation(
    async (args: { where?: Record<string, unknown> }) =>
      SCHOLARS.filter((s) => matches(s, args?.where)).length,
  );
  scholarGroupBy.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const out = new Map<string | null, number>();
    for (const s of SCHOLARS.filter((r) => matches(r, args?.where))) {
      out.set(s.roleCategory, (out.get(s.roleCategory) ?? 0) + 1);
    }
    return [...out].map(([roleCategory, n]) => ({ roleCategory, _count: { _all: n } }));
  });
  // Every scholar carries the one selected family, so the facet route's `total`
  // is decided purely by the `scholar:` relation filter.
  scholarFamilyFindMany.mockImplementation(
    async (args: { where?: { cwid?: { in?: string[] }; scholar?: Record<string, unknown> } }) =>
      SCHOLARS.filter(
        (s) =>
          (args.where?.cwid?.in ?? []).includes(s.cwid) &&
          matches(s, args.where?.scholar ?? {}),
      ).map((s) => ({ cwid: s.cwid })),
  );

  divisionFindFirst.mockResolvedValue({ code: "CARDIO", slug: "cardiology", name: "Cardiology", deptCode: "MED", description: null, url: null, chiefCwid: null, source: "ED", scholarCount: 5 });
  divisionFindMany.mockResolvedValue([]);
  divisionMembershipFindMany.mockResolvedValue([]);
  departmentFindUnique.mockResolvedValue({ code: "MED", name: "Medicine", officialName: null, compactName: null, slug: "medicine", description: null, url: null, chairCwid: null, category: "clinical" });
  centerFindUnique.mockResolvedValue({ code: "MEYER", name: "Meyer", slug: "meyer", description: null, url: null, directorCwid: null, leaderInterim: false });
  centerMembershipFindMany.mockImplementation(async () =>
    SCHOLARS.map((s) => ({
      cwid: s.cwid,
      membershipType: "research",
      programCode: null,
      startDate: null,
      endDate: null,
    })),
  );
  centerProgramFindMany.mockResolvedValue([]);
  publicationTopicGroupBy.mockResolvedValue([]);
  publicationTopicCount.mockResolvedValue(0);
  publicationCount.mockResolvedValue(0);
  grantGroupBy.mockResolvedValue([]);
  grantFindMany.mockResolvedValue([]);
  publicationAuthorGroupBy.mockResolvedValue([]);
  topicFindMany.mockResolvedValue([]);
  queryRawUnsafe.mockResolvedValue([]);
});

describe("publicRoleWhere() — the NULL-admitting shape", () => {
  it("admits NULL explicitly instead of relying on notIn", () => {
    // A bare `notIn` would be the bug: `NULL NOT IN (…)` is NULL in SQL, so
    // every un-backfilled scholar would silently vanish from every roster.
    expect(publicRoleWhere()).toEqual({
      OR: [
        { roleCategory: null },
        { roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } },
      ],
    });
  });

  it("returns a FRESH object each call (it carries an OR that must not be shared)", () => {
    const a = publicRoleWhere();
    const b = publicRoleWhere();
    expect(a).not.toBe(b);
    expect(a.OR).not.toBe(b.OR);
  });

  it("enumerates the bare prod value, not just the suffixed staging ones", () => {
    // Staging's students are suffixed AND soft-deleted; prod's carry the bare
    // value with deleted_at NULL, so this entry is the one doing the work there.
    expect(HIDDEN_ROLE_CATEGORIES).toContain("doctoral_student");
  });
});

describe("department roster (#2202)", () => {
  it("never loads a hidden identity class, and keeps the un-backfilled NULL", async () => {
    const result = await getDepartmentFaculty("MED", {});

    expect(result.hits.map((h) => h.cwid)).toEqual(VISIBLE);
    expect(result.total).toBe(2);
    // `total` is what paints "Showing 1–20 of N" and drives pagination: if it
    // still said 5 the page would offer trailing pages that render nothing.
    expect(result.total).toBe(result.hits.length);
  });

  it("drops the 'Doctoral student' chip because its whole-scope count is now 0", async () => {
    const result = await getDepartmentFaculty("MED", {});

    expect(Object.keys(result.roleCategoryCounts)).not.toContain("Doctoral student");
    expect(result.roleCategoryCounts).toEqual({ "Full-time faculty": 1 });
  });

  it("feeds the methods facet the carved member set, not the raw one", async () => {
    facetEnabled.mockReturnValue(true);
    const result = await getDepartmentFaculty("MED", {});
    expect(result.methodFacet).toEqual([{ value: "sc::Fam", label: "Fam", count: 2 }]);
  });

  it("hero 'N scholars' matches the roster total on the same page", async () => {
    const detail = await getDepartment("medicine");
    const faculty = await getDepartmentFaculty("MED", {});
    // A hero reading 5 above a 2-row roster would be a NEW bug, not a fix.
    expect(detail?.stats.scholars).toBe(faculty.total);
    expect(detail?.stats.scholars).toBe(2);
  });
});

describe("division roster (#2202)", () => {
  it("carves total, rows and facet from ONE set — no phantom trailing pages", async () => {
    facetEnabled.mockReturnValue(true);
    const result = await getDivisionFaculty("CARDIO", {});

    expect(result.hits.map((h) => h.cwid)).toEqual(VISIBLE);
    // `total` comes from the member cwid list, NOT from the row query, so a
    // carve applied only to `where` would leave this at 5 and paginate to a
    // page that renders zero rows.
    expect(result.total).toBe(2);
    expect(result.methodFacet).toEqual([{ value: "sc::Fam", label: "Fam", count: 2 }]);
  });

  it("does NOT carve inside the cached loadDivisionMemberCwids", async () => {
    await getDivisionFaculty("CARDIO", {});
    // The divCode read that backs pubs/grants/topics must stay uncarved — #718
    // retains a hidden scholar's publications, so carving there would delete
    // real research output from the division totals.
    const divCodeCall = scholarFindMany.mock.calls.find(
      (c) => (c[0] as { where?: { divCode?: string } })?.where?.divCode === "CARDIO",
    );
    expect(divCodeCall).toBeDefined();
    expect((divCodeCall![0] as { where: Record<string, unknown> }).where).not.toHaveProperty("OR");
  });

  it("hero 'N scholars' matches the roster total on the same page", async () => {
    const detail = await getDivision("medicine", "cardiology");
    const faculty = await getDivisionFaculty("CARDIO", {});
    expect(detail?.stats.scholars).toBe(faculty.total);
    expect(detail?.stats.scholars).toBe(2);
  });
});

describe("center roster (#2202)", () => {
  it("never loads a hidden identity class into the roster", async () => {
    const result = await getCenterMembers("MEYER");
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.hits.map((h) => h.cwid).sort()).toEqual([...VISIBLE].sort());
    expect(result.total).toBe(2);
  });

  it("hero 'N scholars' matches the roster total on the same page", async () => {
    const detail = await getCenter("meyer");
    const members = await getCenterMembers("MEYER");
    expect(detail?.scholarCount).toBe(members.total);
    expect(detail?.scholarCount).toBe(2);
  });

  it("browse's 'N members' matches the center page it links to (publicOnly)", async () => {
    const client = {
      centerMembership: {
        findMany: async () => SCHOLARS.map((s) => ({ centerCode: "MEYER", cwid: s.cwid, startDate: null, endDate: null })),
      },
      scholar: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          SCHOLARS.filter((s) => matches(s, where)).map((s) => ({ cwid: s.cwid })),
      },
    } as unknown as Parameters<typeof countActiveCenterMembersByCode>[0];

    const publik = await countActiveCenterMembersByCode(client, ["MEYER"], { publicOnly: true });
    expect(publik.get("MEYER")).toBe(2);

    // /edit/units keeps the full roster on purpose — a curator has to see and
    // manage the members they administer.
    const curator = await countActiveCenterMembersByCode(client, ["MEYER"]);
    expect(curator.get("MEYER")).toBe(5);
  });
});

describe("unit-members paging API (#2202 — all three edits)", () => {
  it("department branch: total and rows both carved, and they agree", async () => {
    const result = await getUnitMembersByMethods("department", "MED", ["sc::Fam"], 0);

    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.cwid)).toEqual(VISIBLE);
    // `total` is produced by the scholarFamily query, `hits` by the page-rows
    // query. Carving only one desyncs the header from the list.
    expect(result.total).toBe(result.hits.length);
  });

  it("division branch: carved by the scholar: relation filter, not the cached cwid loader", async () => {
    const result = await getUnitMembersByMethods("division", "CARDIO", ["sc::Fam"], 0);

    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.cwid)).toEqual(VISIBLE);
  });

  it("keeps the method facet's own OR intact — the carve nests under scholar:", async () => {
    await getUnitMembersByMethods("department", "MED", ["sc::Fam"], 0);

    const where = scholarFamilyFindMany.mock.calls[0][0].where;
    // Spreading publicRoleWhere() at the TOP level here would have clobbered
    // `OR: publicPairs` and matched every family in the database.
    expect(where.OR).toEqual([{ supercategory: "sc", familyLabel: "Fam" }]);
    expect(where.scholar).toMatchObject(publicRoleWhere());
  });
});
