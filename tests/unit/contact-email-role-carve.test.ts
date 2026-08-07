/**
 * #2269 — the #536 hidden-identity carve on `loadScholarContactEmail`, the loader
 * behind GET /api/profile/[cwid]/contact-email.
 *
 * That route is deliberately outside the SSO middleware (an anonymous on-network
 * viewer must reach it), so this loader IS the access control. It used to gate on
 * `deletedAt` alone, which is inert against the PROD data shape — the ED ETL
 * soft-deletes `affiliate_alumni` but never doctoral students, so 690 prod rows
 * carry a bare `doctoral_student` with `deleted_at IS NULL`. Every fixture below
 * is therefore prod-shaped (bare role, not soft-deleted).
 *
 * Lives in its own file because `tests/unit/contact-email-route.test.ts` mocks
 * `@/lib/api/profile` wholesale to test the route's viewer gate — the loader it
 * replaces is exactly what is under test here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { scholar: { findFirst } } }));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { loadScholarContactEmail } from "@/lib/api/profile";

const CWID = "zzz9999";
const EMAIL = "test.person@example.invalid";

/** A prod-shaped row: whatever role is passed, NOT soft-deleted. */
function prodRow(roleCategory: string | null) {
  return { email: EMAIL, emailVisibility: "institution", deletedAt: null, roleCategory };
}

beforeEach(() => {
  findFirst.mockReset();
});

describe("loadScholarContactEmail — #536 role carve", () => {
  it("carves hidden roles in the WHERE clause, admitting NULL role_category explicitly", async () => {
    findFirst.mockResolvedValue(null);
    await loadScholarContactEmail(CWID);

    const where = findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.cwid).toBe(CWID);
    expect(where.deletedAt).toBeNull();
    // Same gate as the profile-page loader this backs: without it a scholar
    // whose profile 404s on status still had their email revealed here.
    expect(where.status).toBe("active");
    const or = where.OR as Array<Record<string, unknown>>;
    // NULL admitted EXPLICITLY — a bare `notIn` on a nullable column drops NULL
    // rows (SQL three-valued logic) and would blank every un-backfilled scholar.
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("fails closed on an out-of-band suffixed student role the denylist misses", async () => {
    // `doctoral_student_dvm` is NOT in HIDDEN_ROLE_CATEGORIES, so it passes the
    // where-clause; only the prefix-matching predicate catches it.
    findFirst.mockResolvedValue(prodRow("doctoral_student_dvm"));
    expect(await loadScholarContactEmail(CWID)).toBeNull();
  });

  it("still returns the email for a publicly-displayed scholar", async () => {
    findFirst.mockResolvedValue(prodRow("full_time_faculty"));
    expect(await loadScholarContactEmail(CWID)).toEqual({
      email: EMAIL,
      emailVisibility: "institution",
    });
  });
});
