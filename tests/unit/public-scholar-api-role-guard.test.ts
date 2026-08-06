/**
 * #2221 — the #536 hidden-identity carve on the PUBLIC, UNAUTHENTICATED per-CWID
 * scholar endpoints:
 *
 *   - GET /api/scholars/[cwid]/popover-context  (fetchPopoverHeader)
 *   - GET /api/scholars/[cwid]                  (getScholarByCwid)
 *
 * Both used to gate on `deletedAt` (+ `status` on the latter) only. That is
 * inert against the PROD data shape and the whole reason the leak was live:
 *
 *   PROD:    690 scholars carry the BARE `doctoral_student` role with
 *            `deleted_at IS NULL` and `status = 'active'` ⇒ no existing gate
 *            fires; the role carve is the ONLY thing standing between an
 *            anonymous caller and the identity card.
 *   STAGING: the same students carry a SUFFIXED role AND a soft-delete ⇒
 *            `deletedAt` hides them and the role guard is never exercised.
 *
 * Every case below is written against the PROD shape (bare role, deletedAt
 * null, status active) precisely because the staging shape cannot fail.
 *
 * Two independent halves are asserted, because either alone is insufficient:
 *   1. the QUERY-layer carve (`publicRoleWhere()` in the where-clause) — with an
 *      explicit NULL branch, since `notIn` on a nullable column also drops NULL
 *      rows and would 404 every un-backfilled scholar;
 *   2. the fail-closed POST-filter on the RAW `role_category` column — Prisma
 *      cannot express the `doctoral_student*` prefix, so an out-of-band suffix
 *      passes the where-clause and only `isPubliclyDisplayed` catches it.
 *
 * The route-level case asserts the anti-oracle property: a hidden scholar and a
 * nonexistent CWID must be byte-identical (status, body, headers).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { findFirst, topicFindUnique, queryRaw } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  topicFindUnique: vi.fn(async () => null),
  queryRaw: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst },
    topic: { findUnique: topicFindUnique },
    $queryRaw: queryRaw,
  },
  db: { read: { scholar: { findFirst }, topic: { findUnique: topicFindUnique } } },
}));
vi.mock("@/lib/api/manual-layer", () => ({
  loadHiddenAuthorshipCounts: vi.fn(async () => new Map<string, number>()),
}));
vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection: vi.fn(async () => []) }));
vi.mock("@/lib/api/methods", () => ({ getScholarMethodFamilies: vi.fn(async () => []) }));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: () => false,
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { fetchPopoverHeader } from "@/lib/api/popover-context";
import { getScholarByCwid } from "@/lib/api/scholars";
import { GET as popoverGET } from "@/app/api/scholars/[cwid]/popover-context/route";

const CWID = "zzz9999";

/** A prod-shaped row: whatever role is passed, NOT soft-deleted, status active. */
function prodRow(roleCategory: string | null) {
  return {
    cwid: CWID,
    preferredName: "Test Person",
    fullName: "Test Q. Person",
    postnominal: "Doctor of Philosophy",
    primaryTitle: "Graduate Student",
    primaryDepartment: "Test Graduate School",
    slug: "test-person",
    status: "active",
    deletedAt: null,
    roleCategory,
    email: null,
    emailVisibility: null,
    overview: null,
    appointments: [],
    _count: { authorships: 3, grants: 0 },
    topicAssignments: [],
  };
}

/** The OR branch shapes `publicRoleWhere()` must contribute. */
function assertRoleCarve(where: Record<string, unknown>) {
  const or = where.OR as Array<Record<string, unknown>>;
  expect(Array.isArray(or)).toBe(true);
  // NULL admitted EXPLICITLY — a bare `notIn` drops NULL rows (three-valued
  // logic), which would hide every un-backfilled scholar.
  expect(or).toContainEqual({ roleCategory: null });
  const notInBranch = or.find((b) => b.roleCategory && "notIn" in (b.roleCategory as object));
  expect(notInBranch).toBeDefined();
  const notIn = (notInBranch!.roleCategory as { notIn: string[] }).notIn;
  for (const hidden of HIDDEN_ROLE_CATEGORIES) expect(notIn).toContain(hidden);
  // The prod-shaped value specifically.
  expect(notIn).toContain("doctoral_student");
}

beforeEach(() => {
  vi.clearAllMocks();
  topicFindUnique.mockResolvedValue(null);
  queryRaw.mockResolvedValue([]);
});

describe("#2221 fetchPopoverHeader — hidden-identity carve", () => {
  it("carves hidden roles at the QUERY layer, alongside (not instead of) deletedAt", async () => {
    findFirst.mockResolvedValue(null);

    await fetchPopoverHeader(CWID);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const where = findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.cwid).toBe(CWID);
    expect(where.deletedAt).toBeNull();
    assertRoleCarve(where);
  });

  it("PROD shape: bare doctoral_student, deleted_at NULL ⇒ null (not an identity card)", async () => {
    // The DB is stubbed to hand the row back regardless of the where-clause, so
    // this case fails unless the fail-closed post-filter also runs.
    findFirst.mockResolvedValue(prodRow("doctoral_student"));

    expect(await fetchPopoverHeader(CWID)).toBeNull();
  });

  it("catches an out-of-band suffix the where-clause enumeration cannot express", async () => {
    findFirst.mockResolvedValue(prodRow("doctoral_student_dds"));

    expect(await fetchPopoverHeader(CWID)).toBeNull();
  });

  it("catches affiliate_alumni that are NOT soft-deleted", async () => {
    findFirst.mockResolvedValue(prodRow("affiliate_alumni"));

    expect(await fetchPopoverHeader(CWID)).toBeNull();
  });

  it("still serves visible faculty", async () => {
    findFirst.mockResolvedValue(prodRow("full_time_faculty"));

    const header = await fetchPopoverHeader(CWID);
    expect(header).not.toBeNull();
    expect(header!.cwid).toBe(CWID);
  });

  it("still serves an un-backfilled scholar (role_category NULL) — the Prisma NULL trap", async () => {
    findFirst.mockResolvedValue(prodRow(null));

    const header = await fetchPopoverHeader(CWID);
    expect(header).not.toBeNull();
    expect(header!.preferredName).toBe("Test Person");
  });
});

describe("#2221 getScholarByCwid — same defect on the sibling public endpoint", () => {
  it("carves hidden roles at the QUERY layer, keeping deletedAt + status", async () => {
    findFirst.mockResolvedValue(null);

    await getScholarByCwid(CWID);

    const where = findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.cwid).toBe(CWID);
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    assertRoleCarve(where);
  });

  it("PROD shape: bare doctoral_student, deleted_at NULL, status active ⇒ null", async () => {
    findFirst.mockResolvedValue(prodRow("doctoral_student"));

    expect(await getScholarByCwid(CWID)).toBeNull();
  });

  it("still serves visible faculty and un-backfilled scholars", async () => {
    findFirst.mockResolvedValue(prodRow("full_time_faculty"));
    expect(await getScholarByCwid(CWID)).not.toBeNull();

    findFirst.mockResolvedValue(prodRow(null));
    expect(await getScholarByCwid(CWID)).not.toBeNull();
  });
});

describe("#2221 popover-context route — hidden is INDISTINGUISHABLE from nonexistent", () => {
  async function call() {
    const req = new NextRequest(
      `http://localhost/api/scholars/${CWID}/popover-context?surface=facet`,
      { method: "GET" },
    );
    const res = await popoverGET(req, { params: Promise.resolve({ cwid: CWID }) });
    return {
      status: res.status,
      body: await res.text(),
      cacheControl: res.headers.get("cache-control"),
    };
  }

  it("returns the same status + body for a hidden student as for a missing CWID", async () => {
    findFirst.mockResolvedValue(null);
    const missing = await call();

    findFirst.mockResolvedValue(prodRow("doctoral_student"));
    const hidden = await call();

    expect(missing.status).toBe(404);
    expect(hidden).toEqual(missing);
  });
});
