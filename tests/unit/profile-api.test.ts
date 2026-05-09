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
    publicationAuthor: {
      findMany: vi.fn(async () => []),
    },
    personNihProfile: {
      findFirst: vi.fn(async () => null),
    },
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
});
