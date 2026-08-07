/**
 * #2270 — the #536 hidden-identity carve on `getMethodScholars`, the loader
 * behind the public `/methods/{sc}/{family}/scholars` page.
 *
 * The #2202 loader hardening landed `publicRoleWhere()` in eight sibling loaders
 * and skipped this one; its docblock said "NO eligibility carve" and the surface
 * offered a `doctoral_students` facet, which `lib/eligibility.ts` forbids. The
 * page is public and unauthenticated (METHODS_LENS_PAGES is on in prod for all
 * 741 families) and each row carries name, postnominal, title and the headshot
 * endpoint, so the row must never be LOADED — de-linking it is not enough.
 *
 * Fixtures are prod-shaped (bare `doctoral_student`, not soft-deleted, active),
 * because that is the shape against which `deletedAt`/`status` do nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { scholarFamily: { findMany } } }));
vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: vi.fn(async () => ({})),
  isFamilyPubliclyVisible: vi.fn(() => true),
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { getMethodScholars } from "@/lib/api/methods";

const SC = "animal_cell_models";
const FAMILY = "CRISPR screens";

function row(cwid: string, name: string, roleCategory: string | null) {
  return {
    pmidCount: 5,
    scholar: {
      cwid,
      slug: `slug-${cwid}`,
      preferredName: name,
      postnominal: null,
      primaryTitle: "Test Title",
      roleCategory,
    },
  };
}

beforeEach(() => {
  findMany.mockReset();
  process.env.METHODS_LENS_ENABLED = "on";
});

describe("getMethodScholars — #536 role carve", () => {
  it("carves hidden roles in the WHERE clause, admitting NULL role_category explicitly", async () => {
    findMany.mockResolvedValue([]);
    await getMethodScholars(SC, FAMILY, {});

    const scholarFilter = (findMany.mock.calls[0][0].where as Record<string, unknown>)
      .scholar as Record<string, unknown>;
    expect(scholarFilter.deletedAt).toBeNull();
    expect(scholarFilter.status).toBe("active");
    const or = scholarFilter.OR as Array<Record<string, unknown>>;
    // NULL admitted EXPLICITLY — a bare `notIn` on a nullable column drops NULL
    // rows (SQL three-valued logic) and would hide un-backfilled scholars.
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("drops an out-of-band suffixed student row from hits AND from every count", async () => {
    // `doctoral_student_dvm` is NOT in HIDDEN_ROLE_CATEGORIES, so it passes the
    // where-clause; only the prefix-matching predicate catches it.
    findMany.mockResolvedValue([
      row("aaa1001", "Ada Faculty", "full_time_faculty"),
      row("bbb2002", "Bo Student", "doctoral_student_dvm"),
    ]);

    const result = await getMethodScholars(SC, FAMILY, {});
    expect(result!.hits.map((h) => h.cwid)).toEqual(["aaa1001"]);
    expect(result!.total).toBe(1);
    expect(result!.roleCounts.all).toBe(1);
  });

  it("offers no doctoral-students facet — the role chips are all/faculty/postdocs", async () => {
    findMany.mockResolvedValue([row("aaa1001", "Ada Faculty", "full_time_faculty")]);
    const result = await getMethodScholars(SC, FAMILY, {});
    expect(Object.keys(result!.roleCounts).sort()).toEqual(["all", "faculty", "postdocs"]);
  });
});
