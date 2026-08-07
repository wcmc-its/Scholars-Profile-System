/**
 * Count-vs-list parity for the two "+ N more scholars →" affordances.
 *
 * #2270 carved `getMethodScholars` and its sibling commit carved
 * `getTopicScholars`, but the COUNTS that label the links to those pages were
 * left uncarved — so the link advertised more scholars than the page it opens
 * could list (and the same number went into each page's <meta description>).
 *
 * Both counts must apply the same TWO layers as the list they link to: the
 * `publicRoleWhere()` denylist (NULL admitted explicitly) and the fail-closed
 * `isPubliclyDisplayed` pass on the RAW `role_category`, which is the only half
 * that catches an out-of-band `doctoral_student*` suffix.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { scholarFamilyFindMany, queryRaw } = vi.hoisted(() => ({
  scholarFamilyFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholarFamily: { findMany: scholarFamilyFindMany },
    $queryRaw: queryRaw,
  },
}));
vi.mock("@/lib/api/methods-overlay", () => ({
  loadFamilyOverlayGate: vi.fn(async () => ({})),
  isFamilyPubliclyVisible: vi.fn(() => true),
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { getDistinctScholarCountForFamily } from "@/lib/api/methods";
import { getDistinctScholarCountForTopic } from "@/lib/api/topics";

const SC = "animal_cell_models";
const FAMILY = "CRISPR screens";
const TOPIC = "cardiovascular-disease";

function familyRow(cwid: string, roleCategory: string | null) {
  return { cwid, scholar: { roleCategory } };
}

beforeEach(() => {
  scholarFamilyFindMany.mockReset();
  queryRaw.mockReset();
  scholarFamilyFindMany.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
  process.env.METHODS_LENS_ENABLED = "on";
});

describe("getDistinctScholarCountForFamily — matches the list it links to", () => {
  it("carves hidden roles in the WHERE clause, admitting NULL role_category explicitly", async () => {
    await getDistinctScholarCountForFamily(SC, FAMILY);

    const scholarFilter = (scholarFamilyFindMany.mock.calls[0][0].where as Record<string, unknown>)
      .scholar as Record<string, unknown>;
    expect(scholarFilter.deletedAt).toBeNull();
    expect(scholarFilter.status).toBe("active");
    const or = scholarFilter.OR as Array<Record<string, unknown>>;
    // NULL admitted EXPLICITLY — a bare `notIn` on a nullable column drops NULL
    // rows (SQL three-valued logic) and would hide un-backfilled scholars.
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("does not count an out-of-band suffixed student the list drops, and keeps NULL", async () => {
    // `doctoral_student_dvm` is NOT in HIDDEN_ROLE_CATEGORIES, so it passes the
    // where-clause; only the prefix-matching predicate catches it.
    scholarFamilyFindMany.mockResolvedValue([
      familyRow("aaa1001", "full_time_faculty"),
      familyRow("bbb2002", "doctoral_student_dvm"),
      familyRow("ccc3003", null),
    ]);

    expect(await getDistinctScholarCountForFamily(SC, FAMILY)).toBe(2);
  });
});

describe("getDistinctScholarCountForTopic — matches the list it links to", () => {
  it("carves hidden roles in the SQL, admitting NULL role_category explicitly", async () => {
    await getDistinctScholarCountForTopic(TOPIC);

    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain("s.role_category IS NULL");
    expect(sql).toContain("s.role_category NOT IN");
    // `Prisma.join(HIDDEN_ROLE_CATEGORIES)` arrives as a nested Sql fragment.
    const bound = values.flatMap((v) =>
      v && typeof v === "object" && "values" in v ? (v as { values: unknown[] }).values : [v],
    );
    for (const hidden of HIDDEN_ROLE_CATEGORIES) expect(bound).toContain(hidden);
  });

  it("does not count an out-of-band suffixed student the list drops, and keeps NULL", async () => {
    queryRaw.mockResolvedValue([
      { role: "full_time_faculty", c: 3n },
      { role: "doctoral_student_dvm", c: 2n },
      { role: null, c: 1n },
    ]);

    expect(await getDistinctScholarCountForTopic(TOPIC)).toBe(4);
  });
});
