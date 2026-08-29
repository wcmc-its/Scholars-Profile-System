/**
 * #2271 — the fail-closed half of the #536 carve on the two `lib/api/centers.ts`
 * people surfaces: the hero "N scholars" count (`getCenter`) and the public
 * roster (`getCenterMembers`).
 *
 * #2256 gave both `publicRoleWhere()` and stopped there. That fragment is a
 * DENYLIST and cannot express the `doctoral_student*` prefix, so a suffixed
 * member passed it — counting in the hero and appearing in the roster while
 * being absent from the collaboration graph next to it, which #2271 carved with
 * both layers. Node count would then sit below the advertised count.
 *
 * Fixtures are prod-shaped (not soft-deleted, active), because that is the shape
 * against which `deletedAt`/`status` do nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  centerFindUnique,
  scholarFindMany,
  membershipFindMany,
  suppressionFindFirst,
  suppressionFindMany,
} = vi.hoisted(() => ({
  centerFindUnique: vi.fn(),
  scholarFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
  suppressionFindFirst: vi.fn(),
  suppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: centerFindUnique },
    scholar: { findMany: scholarFindMany, findUnique: vi.fn(async () => null) },
    centerMembership: { findMany: membershipFindMany },
    centerProgram: { findMany: vi.fn(async () => []) },
    publicationTopic: { groupBy: vi.fn(async () => []) },
    grant: { findMany: vi.fn(async () => []) },
    suppression: { findFirst: suppressionFindFirst, findMany: suppressionFindMany },
  },
}));

import { getCenter, getCenterMembers } from "@/lib/api/centers";

/** One publicly-displayed member + one out-of-band suffixed student. The suffix
 *  is NOT in HIDDEN_ROLE_CATEGORIES, so it clears the where-clause denylist. */
const MEMBERS = [
  { cwid: "aaa1001", roleCategory: "full_time_faculty" },
  { cwid: "bbb2002", roleCategory: "doctoral_student_dvm" },
];

beforeEach(() => {
  vi.clearAllMocks();
  suppressionFindFirst.mockResolvedValue(null);
  suppressionFindMany.mockResolvedValue([]);
  membershipFindMany.mockResolvedValue(
    MEMBERS.map((m) => ({ cwid: m.cwid, programCode: null, startDate: null, endDate: null })),
  );
  // One mock backs three different selects; branch on the requested shape.
  scholarFindMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
    const keys = Object.keys(args.select ?? {});
    if (keys.length === 1 && keys[0] === "cwid") {
      return Promise.resolve(MEMBERS.map((m) => ({ cwid: m.cwid })));
    }
    if (keys.length === 1 && keys[0] === "roleCategory") {
      return Promise.resolve(MEMBERS.map((m) => ({ roleCategory: m.roleCategory })));
    }
    return Promise.resolve(
      MEMBERS.map((m) => ({
        cwid: m.cwid,
        preferredName: `Person ${m.cwid}`,
        slug: `slug-${m.cwid}`,
        primaryTitle: null,
        primaryDepartment: null,
        roleCategory: m.roleCategory,
        overview: null,
        professorialRank: null,
        department: null,
        division: null,
      })),
    );
  });
});

describe("centers — fail-closed pass on the raw role column (#2271)", () => {
  it("the hero scholarCount excludes an out-of-band suffixed student", async () => {
    centerFindUnique.mockResolvedValue({
      code: "TEST_CENTER_HERO",
      name: "Test Center",
      slug: "test-center-hero",
      description: null,
      url: null,
      // #2542 — no director assignment.
      members: [],
    });

    const center = await getCenter("test-center-hero");
    expect(center!.scholarCount).toBe(1);
  });

  it("the public roster excludes the same member, so the count cannot outrun the rows", async () => {
    const result = await getCenterMembers("TEST_CENTER_ROSTER", {});
    expect(result.mode).toBe("flat");
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(1);
    expect(result.hits.map((h) => h.cwid)).toEqual(["aaa1001"]);
  });
});
