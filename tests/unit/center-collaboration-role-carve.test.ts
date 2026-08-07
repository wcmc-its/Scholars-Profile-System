/**
 * #2271 — the #536 hidden-identity carve on `buildCenterCollaboration`, the
 * loader behind the PUBLIC, unauthenticated GET /api/centers/[slug]/collaboration.
 *
 * The module docblock, the route header and `docs/cancer-center-collaboration-
 * network-spec.md` §3.3 all asserted this carve; the query applied only
 * `deletedAt` + `status`. Parity was true once and was lost when #2256 added
 * `publicRoleWhere()` to `lib/api/centers.ts` without touching this file.
 *
 * A dropped scholar must vanish from BOTH nodes and papers — membership indices
 * (`m`) are positional into `nodes`, so a half-applied carve would misalign the
 * whole graph rather than just leak a name.
 *
 * Fixtures are prod-shaped (bare role, not soft-deleted, active).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { centerFindUnique, membershipFindMany, scholarFindMany, programFindMany, authorFindMany } =
  vi.hoisted(() => ({
    centerFindUnique: vi.fn(),
    membershipFindMany: vi.fn(),
    scholarFindMany: vi.fn(),
    programFindMany: vi.fn(),
    authorFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    center: { findUnique: centerFindUnique },
    centerMembership: { findMany: membershipFindMany },
    scholar: { findMany: scholarFindMany },
    centerProgram: { findMany: programFindMany },
    publicationAuthor: { findMany: authorFindMany },
    grant: { findMany: vi.fn(async () => []) },
  },
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { buildCenterCollaboration } from "@/lib/api/center-collaboration";

const CODE = "TEST_CENTER";

function member(cwid: string, name: string, roleCategory: string | null) {
  return { cwid, preferredName: name, slug: `slug-${cwid}`, roleCategory };
}

beforeEach(() => {
  centerFindUnique.mockReset();
  membershipFindMany.mockReset();
  scholarFindMany.mockReset();
  programFindMany.mockReset();
  authorFindMany.mockReset();

  centerFindUnique.mockResolvedValue({ code: CODE, name: "Test Center" });
  membershipFindMany.mockResolvedValue([
    { cwid: "aaa1001", programCode: null, startDate: null, endDate: null },
    { cwid: "bbb2002", programCode: null, startDate: null, endDate: null },
  ]);
  programFindMany.mockResolvedValue([]);
  authorFindMany.mockResolvedValue([]);
});

describe("buildCenterCollaboration — #536 role carve", () => {
  it("carves hidden roles in the WHERE clause, admitting NULL role_category explicitly", async () => {
    scholarFindMany.mockResolvedValue([]);
    await buildCenterCollaboration(CODE);

    const where = scholarFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    const or = where.OR as Array<Record<string, unknown>>;
    // NULL admitted EXPLICITLY — a bare `notIn` on a nullable column drops NULL
    // rows (SQL three-valued logic) and would empty the graph of un-backfilled
    // scholars.
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("drops an out-of-band hidden member from nodes AND from every paper group", async () => {
    // `doctoral_student_dvm` is NOT in HIDDEN_ROLE_CATEGORIES, so it passes the
    // where-clause; only the prefix-matching predicate catches it.
    scholarFindMany.mockResolvedValue([
      member("aaa1001", "Ada Faculty", "full_time_faculty"),
      member("bbb2002", "Bo Student", "doctoral_student_dvm"),
    ]);
    authorFindMany.mockResolvedValue([
      { pmid: "1", cwid: "aaa1001", publication: { year: 2024 } },
      { pmid: "1", cwid: "bbb2002", publication: { year: 2024 } },
    ]);

    const payload = await buildCenterCollaboration(CODE);
    expect(payload!.nodes.map((n) => n.cwid)).toEqual(["aaa1001"]);
    // The co-authored paper loses its second member and so is no longer an edge.
    expect(payload!.papers).toEqual([]);
  });
});
