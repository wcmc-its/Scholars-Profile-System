import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { EXPECTED_HEADSHOT_URL, FIXTURE_CWID } from "../fixtures/scholar";

// Mock Prisma BEFORE importing the module under test.
// The actual lib/api/profile.ts queries scholar with several relations and a
// secondary publicationAuthor.findMany. Both surfaces are stubbed.
vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: vi.fn(async () => ({
        cwid: FIXTURE_CWID,
        slug: "jane-doe",
        preferredName: "Jane Doe",
        fullName: "Jane Q. Doe",
        primaryTitle: "Associate Professor",
        primaryDepartment: "Medicine",
        email: null,
        overview: null,
        headshotUrl: null,
        hasClinicalProfile: false,
        deletedAt: null,
        status: "active",
        appointments: [],
        profileAppointments: [],
        // #1760 — the loader `include`s honors, so the emitted row always carries
        // the relation. Gated to published + shown in the query, hence [] here.
        honors: [],
        educations: [],
        grants: [],
        topicAssignments: [],
        coiActivities: [],
        publicationScores: [],
      })),
      findUnique: vi.fn(async () => ({
        cwid: FIXTURE_CWID,
        slug: "jane-doe",
        preferredName: "Jane Doe",
        fullName: "Jane Q. Doe",
        primaryTitle: "Associate Professor",
        primaryDepartment: "Medicine",
        email: null,
        overview: null,
        headshotUrl: null,
        deletedAt: null,
        status: "active",
        appointments: [],
        profileAppointments: [],
        educations: [],
        grants: [],
        topicAssignments: [],
        coiActivities: [],
      })),
    },
    fieldOverride: {
      // #356 — getScholarFullProfileBySlug now merges an overview override.
      findUnique: vi.fn(async () => null),
      // section-visibility — no section-hide overrides for this fixture.
      findMany: vi.fn(async () => []),
    },
    publicationAuthor: {
      findMany: vi.fn(async () => []),
    },
    personNihProfile: {
      findFirst: vi.fn(async () => null),
    },
    // #1266 — leadership reader lookups; default empty (no leadership roles).
    department: { findMany: vi.fn(async () => []) },
    division: { findMany: vi.fn(async () => []) },
    center: { findMany: vi.fn(async () => []) },
    // #2542 — center/department/division leadership titles all read
    // `orgUnitRoleAssignment` (with the legacy column as the pre-backfill /
    // pre-sync dual-read fallback, #2542 Phase D for department/division).
    orgUnitRoleAssignment: { findMany: vi.fn(async () => []) },
    // #2542 Phase D — department Chair/Director + division Chief labels
    // resolve from the vocabulary; `null`/`[]` defaults exercise the
    // "vocabulary row missing" fallback path.
    orgUnitRole: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    centerProgramLeader: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

/** The mock surface `loadLeadershipMocks` resets before each leadership test,
 *  so one test's `mockImplementation`/`mockResolvedValue` never bleeds into
 *  the next (they're module-level `vi.fn()`s shared across this whole file). */
type LeadershipMockClient = {
  department: { findMany: Mock };
  division: { findMany: Mock };
  center: { findMany: Mock };
  orgUnitRoleAssignment: { findMany: Mock };
  orgUnitRole: { findMany: Mock; findUnique: Mock };
};

async function loadLeadershipMocks(): Promise<LeadershipMockClient> {
  const { prisma } = (await import("@/lib/db")) as unknown as { prisma: LeadershipMockClient };
  prisma.department.findMany.mockReset().mockResolvedValue([]);
  prisma.division.findMany.mockReset().mockResolvedValue([]);
  prisma.center.findMany.mockReset().mockResolvedValue([]);
  prisma.orgUnitRoleAssignment.findMany.mockReset().mockResolvedValue([]);
  prisma.orgUnitRole.findMany.mockReset().mockResolvedValue([]);
  prisma.orgUnitRole.findUnique.mockReset().mockResolvedValue(null);
  return prisma;
}

describe("profile serializer", () => {
  it("includes identityImageEndpoint computed from CWID", async () => {
    const mod: Record<string, unknown> = await import("@/lib/api/profile");
    // Wave 1 must export a function whose return shape is ProfilePayload.
    // The current public function is `getScholarFullProfileBySlug` — both
    // by-slug and by-cwid forms are checked here so the test fails on the
    // identityImageEndpoint assertion, not on a missing function name.
    const fn =
      (mod as { getProfileByCwid?: (id: string) => Promise<unknown> }).getProfileByCwid ??
      (mod as { getProfileBySlug?: (id: string) => Promise<unknown> }).getProfileBySlug ??
      (mod as { getScholarFullProfileBySlug?: (id: string) => Promise<unknown> })
        .getScholarFullProfileBySlug;
    expect(fn, "profile module must export a profile-payload getter").toBeTruthy();
    const payload = (await fn!("jane-doe")) as { identityImageEndpoint?: string } | null;
    expect(payload).not.toBeNull();
    expect(payload!.identityImageEndpoint).toBe(EXPECTED_HEADSHOT_URL);
  });

  // #1103 — the payload always carries a `centers` field. With the
  // PROFILE_CENTER_AFFILIATION flag off (default), the reverse query is never
  // issued (centerMembership isn't even mocked here) and the field is `[]`.
  it("carries an empty `centers` array when the affiliation flag is off", async () => {
    const mod: Record<string, unknown> = await import("@/lib/api/profile");
    const fn = (mod as {
      getScholarFullProfileBySlug?: (id: string) => Promise<unknown>;
    }).getScholarFullProfileBySlug;
    const payload = (await fn!("jane-doe")) as { centers?: unknown } | null;
    expect(payload).not.toBeNull();
    expect(payload!.centers).toEqual([]);
  });

  // #1760 — THE GATE. Only `status = published` AND `showOnProfile = true` honors
  // may reach the payload, and the filter must live in the QUERY: the Phase 3
  // roster sweep writes `pending` rows for a human to confirm, so a render-side
  // filter would put an unconfirmed honor one forgotten guard away from the
  // public page. This asserts the where-clause the loader actually sends —
  // mocking the row shape could never prove a row was excluded, because the mock
  // returns whatever it's told regardless of the filter.
  it("gates honors to published + shown in the loader query", async () => {
    const { prisma } = (await import("@/lib/db")) as unknown as {
      prisma: { scholar: { findFirst: Mock } };
    };
    const mod: Record<string, unknown> = await import("@/lib/api/profile");
    const fn = (mod as {
      getScholarFullProfileBySlug?: (id: string) => Promise<unknown>;
    }).getScholarFullProfileBySlug;

    prisma.scholar.findFirst.mockClear();
    await fn!("honors-gate-fixture");

    const args = prisma.scholar.findFirst.mock.calls.at(-1)?.[0] as {
      include: { honors: { where: unknown } };
    };
    expect(args.include.honors.where).toEqual({ status: "published", showOnProfile: true });
  });
});

// #58 / #2542 Phase D — `profile.ts`'s own leadership-title lines
// (`payload.leadershipTitles`) must not repeat the "Chair, {dept}" /
// "Chief, {div}" mislabel: an administrative department's leader is a
// Director, and the display label comes from the vocabulary (falling back to
// the seed default only when the vocabulary row is missing), matching the
// established center dual-read shape.
describe("profile serializer — department/division leadership titles (#58 / #2542 Phase D)", () => {
  beforeEach(loadLeadershipMocks);

  async function leadershipTitles(): Promise<string[]> {
    const mod: Record<string, unknown> = await import("@/lib/api/profile");
    const fn = (mod as {
      getScholarFullProfileBySlug?: (id: string) => Promise<{ leadershipTitles?: string[] } | null>;
    }).getScholarFullProfileBySlug;
    const payload = await fn!("jane-doe");
    return payload?.leadershipTitles ?? [];
  }

  it("labels a clinical/mixed/basic department's leader 'Chair' via the legacy chairCwid fallback", async () => {
    const prisma = await loadLeadershipMocks();
    prisma.department.findMany.mockResolvedValue([
      { code: "MED", name: "Medicine", officialName: null, category: "clinical" },
    ]);
    expect(await leadershipTitles()).toEqual(["Chair, Medicine"]);
  });

  it("labels an administrative department's leader 'Director', not 'Chair'", async () => {
    const prisma = await loadLeadershipMocks();
    prisma.department.findMany.mockResolvedValue([
      { code: "LIB", name: "Library", officialName: null, category: "administrative" },
    ]);
    expect(await leadershipTitles()).toEqual(["Director, Library"]);
  });

  it("labels a division's leader 'Chief' via the legacy chiefCwid fallback", async () => {
    const prisma = await loadLeadershipMocks();
    prisma.division.findMany.mockResolvedValue([{ code: "HEME", name: "Hematology" }]);
    expect(await leadershipTitles()).toEqual(["Chief, Hematology"]);
  });

  it("does not render a role whose vocabulary row has profileTitle: false", async () => {
    const prisma = await loadLeadershipMocks();
    prisma.department.findMany.mockResolvedValue([
      { code: "MED", name: "Medicine", officialName: null, category: "clinical" },
    ]);
    prisma.orgUnitRole.findMany.mockResolvedValue([
      { key: "chair", label: "Chair", profileTitle: false },
    ]);
    expect(await leadershipTitles()).toEqual([]);
  });

  it("an OrgUnitRoleAssignment-covered department wins over the legacy column, with the vocabulary label + interim", async () => {
    const prisma = await loadLeadershipMocks();
    // Legacy column still has a row for the SAME department code — the
    // assignment must suppress it, not double-render.
    prisma.department.findMany.mockImplementation(
      async (args: { where?: { chairCwid?: string; code?: { in?: string[] } } }) => {
        if (args.where?.chairCwid) {
          return [{ code: "MED", name: "Medicine", officialName: null, category: "clinical" }];
        }
        if (args.where?.code?.in) {
          return [{ code: "MED", name: "Medicine", officialName: "Department of Medicine" }];
        }
        return [];
      },
    );
    prisma.orgUnitRoleAssignment.findMany.mockImplementation(
      async (args: { where: { entityType: string } }) => {
        if (args.where.entityType !== "department") return [];
        return [
          {
            entityId: "MED",
            interim: true,
            sortOrder: 10,
            // Deliberately NOT the literal "Chair"/"Director" — proves the
            // rendered text is the vocabulary's label, not a hardcoded noun.
            role: { label: "Chair Emeritus" },
          },
        ];
      },
    );
    expect(await leadershipTitles()).toEqual(["Interim Chair Emeritus, Department of Medicine"]);
  });
});
