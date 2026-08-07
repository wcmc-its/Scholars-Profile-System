/**
 * The #536 hidden-identity carve on `getTopicScholars`, the loader behind the
 * public `/topics/{slug}/scholars` page. Sibling of #2270, which carved the
 * method-family twin; this one was left open in the same sweep.
 *
 * The page is public, unauthenticated and ISR-cached (`revalidate = 21600`), it
 * accepted `?role=doctoral_students`, and it rendered a "Doctoral students" chip
 * that enumerated the class BY NAME — while `app/(public)/about/page.tsx` tells
 * the public they are "not shown on any public surface". Each row emits name,
 * postnominal, title and the identity-image endpoint, so the row must never be
 * LOADED; de-linking it is not enough.
 *
 * Fixtures are prod-shaped (bare `doctoral_student`, not soft-deleted, active),
 * because that is the shape against which `deletedAt`/`status` do nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { topicFindUnique, scholarGroupBy, scholarFindMany, publicationTopicGroupBy } = vi.hoisted(
  () => ({
    topicFindUnique: vi.fn(),
    scholarGroupBy: vi.fn(),
    scholarFindMany: vi.fn(),
    publicationTopicGroupBy: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    topic: { findUnique: topicFindUnique },
    scholar: { groupBy: scholarGroupBy, findMany: scholarFindMany },
    publicationTopic: { groupBy: publicationTopicGroupBy },
  },
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { getTopicScholars } from "@/lib/api/topics";

const TOPIC = "cardiovascular-disease";

function scholarRow(cwid: string, name: string, roleCategory: string | null) {
  return {
    cwid,
    slug: `slug-${cwid}`,
    preferredName: name,
    postnominal: null,
    primaryTitle: "Test Title",
    roleCategory,
  };
}

beforeEach(() => {
  topicFindUnique.mockReset();
  scholarGroupBy.mockReset();
  scholarFindMany.mockReset();
  publicationTopicGroupBy.mockReset();

  topicFindUnique.mockResolvedValue({ id: TOPIC, label: "Cardiovascular Disease" });
  scholarGroupBy.mockResolvedValue([]);
  scholarFindMany.mockResolvedValue([]);
  publicationTopicGroupBy.mockResolvedValue([]);
});

describe("getTopicScholars — #536 role carve", () => {
  it("carves hidden roles in the WHERE clause, admitting NULL role_category explicitly", async () => {
    await getTopicScholars(TOPIC, {});

    const where = scholarFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    const or = where.OR as Array<Record<string, unknown>>;
    // NULL admitted EXPLICITLY — a bare `notIn` on a nullable column drops NULL
    // rows (SQL three-valued logic) and would hide un-backfilled scholars.
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("drops an out-of-band suffixed student row from hits AND from every count", async () => {
    // `doctoral_student_dvm` is NOT in HIDDEN_ROLE_CATEGORIES, so it passes the
    // where-clause; only the prefix-matching predicate catches it.
    scholarFindMany.mockResolvedValue([
      scholarRow("aaa1001", "Ada Faculty", "full_time_faculty"),
      scholarRow("bbb2002", "Bo Student", "doctoral_student_dvm"),
    ]);
    scholarGroupBy.mockResolvedValue([
      { roleCategory: "full_time_faculty", _count: { _all: 1 } },
      { roleCategory: "doctoral_student_dvm", _count: { _all: 1 } },
    ]);

    const result = await getTopicScholars(TOPIC, {});
    expect(result!.hits.map((h) => h.cwid)).toEqual(["aaa1001"]);
    expect(result!.total).toBe(1);
    expect(result!.roleCounts.all).toBe(1);
  });

  it("offers no doctoral-students facet — the role chips are all/faculty/postdocs", async () => {
    scholarFindMany.mockResolvedValue([scholarRow("aaa1001", "Ada Faculty", "full_time_faculty")]);
    scholarGroupBy.mockResolvedValue([
      { roleCategory: "full_time_faculty", _count: { _all: 1 } },
    ]);

    const result = await getTopicScholars(TOPIC, {});
    expect(Object.keys(result!.roleCounts).sort()).toEqual(["all", "faculty", "postdocs"]);
  });
});
