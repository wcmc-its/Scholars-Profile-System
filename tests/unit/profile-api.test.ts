import { describe, expect, it, vi } from "vitest";
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
    centerProgramLeader: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

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
});
