/**
 * Issue #1026 — surface soft-deleted active doctoral-student co-authors as
 * NON-LINKED author chips on publication chip surfaces. Flag-gated, default-off.
 *
 * Covers:
 *   1. isPubliclyDisplayed — the #1026 prefix-hardening (CHANGE 2): suffixed
 *      doctoral_student_* roles and the bare value are hidden; displayed roles
 *      and null/unknown are unaffected.
 *   2. fetchWcmAuthorsForPmids scholar-filter shape (CHANGE 3): flag OFF →
 *      { deletedAt:null, status:"active" }; flag ON → status:"active" with
 *      OR[deletedAt:null, roleCategory startsWith doctoral_student].
 *   3. The relaxed renderable predicate (CHANGE 4): a slug-less hidden-class
 *      student chip counts as displayable; an active author with slug is
 *      unchanged; flag-off path is identical to before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isPubliclyDisplayed } from "@/lib/eligibility";

// ---------------------------------------------------------------------------
// 1. isPubliclyDisplayed prefix-hardening (#1026 CHANGE 2)
// ---------------------------------------------------------------------------
describe("isPubliclyDisplayed — #1026 doctoral_student prefix hardening", () => {
  it("hides every doctoral_student role (bare + ED-suffixed live values)", () => {
    expect(isPubliclyDisplayed("doctoral_student")).toBe(false);
    expect(isPubliclyDisplayed("doctoral_student_md")).toBe(false);
    expect(isPubliclyDisplayed("doctoral_student_phd")).toBe(false);
    expect(isPubliclyDisplayed("doctoral_student_mdphd")).toBe(false);
  });

  it("keeps affiliate_alumni hidden (exact match, not prefixed)", () => {
    expect(isPubliclyDisplayed("affiliate_alumni")).toBe(false);
  });

  it("still displays every non-hidden role (no collision with the prefix)", () => {
    for (const role of [
      "full_time_faculty",
      "affiliated_faculty",
      "postdoc",
      "fellow",
      "non_faculty_academic",
      "non_academic",
      "instructor",
      "lecturer",
      "emeritus",
    ]) {
      expect(isPubliclyDisplayed(role)).toBe(true);
    }
  });

  it("preserves fail-open for null / undefined / unknown roles", () => {
    expect(isPubliclyDisplayed(null)).toBe(true);
    expect(isPubliclyDisplayed(undefined)).toBe(true);
    expect(isPubliclyDisplayed("some_future_role")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. fetchWcmAuthorsForPmids scholar-filter shape (#1026 CHANGE 3)
// ---------------------------------------------------------------------------
const { mockPublicationAuthorFindMany, mockSuppressionFindMany } = vi.hoisted(() => ({
  mockPublicationAuthorFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    publicationAuthor: { findMany: mockPublicationAuthorFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

// Imported after the mock so it binds the mocked prisma.
import { fetchWcmAuthorsForPmids } from "@/lib/api/topics";

const FLAG = "COAUTHOR_HIDDEN_STUDENT_CHIPS";

function authorRow(
  pmid: string,
  cwid: string,
  name: string,
  opts: { isFirst?: boolean; isLast?: boolean; slug?: string | null; roleCategory?: string | null } = {},
) {
  return {
    pmid,
    isFirst: opts.isFirst ?? false,
    isLast: opts.isLast ?? false,
    scholar: {
      cwid,
      slug: opts.slug === undefined ? `${cwid}-slug` : opts.slug,
      preferredName: name,
      roleCategory: opts.roleCategory ?? null,
    },
  };
}

/** The `scholar` sub-where captured from the most recent findMany call. */
function capturedScholarWhere(): Record<string, unknown> {
  const call = mockPublicationAuthorFindMany.mock.calls.at(-1);
  const arg = call?.[0] as { where?: { scholar?: Record<string, unknown> } } | undefined;
  return arg?.where?.scholar ?? {};
}

describe("fetchWcmAuthorsForPmids — #1026 hidden-student chip filter shape", () => {
  const saved = process.env[FLAG];

  beforeEach(() => {
    mockPublicationAuthorFindMany.mockReset();
    mockSuppressionFindMany.mockReset();
    mockPublicationAuthorFindMany.mockResolvedValue([]);
    mockSuppressionFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  });

  it("flag OFF → { deletedAt:null, status:'active' } (byte-identical to today)", async () => {
    delete process.env[FLAG];
    await fetchWcmAuthorsForPmids(["100"]);
    expect(capturedScholarWhere()).toEqual({ deletedAt: null, status: "active" });
  });

  it("flag ON → status:'active' with OR[deletedAt:null, roleCategory startsWith doctoral_student]", async () => {
    process.env[FLAG] = "on";
    await fetchWcmAuthorsForPmids(["100"]);
    expect(capturedScholarWhere()).toEqual({
      status: "active",
      OR: [
        { deletedAt: null },
        { roleCategory: { startsWith: "doctoral_student" } },
      ],
    });
  });

  it("flag ON keeps the per-author suppression check (suppressed author still dropped)", async () => {
    process.env[FLAG] = "on";
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First", { isFirst: true }),
      authorRow("100", "stu2222", "Stu Dent", {
        isLast: true,
        slug: null,
        roleCategory: "doctoral_student_md",
      }),
    ]);
    mockSuppressionFindMany.mockResolvedValue([
      { entityId: "100", contributorCwid: "stu2222" }, // student hidden per-author
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111"]);
  });

  it("flag ON carries a slug-less student through as a chip with null slug", async () => {
    process.env[FLAG] = "on";
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "stu2222", "Stu Dent", {
        slug: null,
        roleCategory: "doctoral_student_md",
      }),
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    const chip = (byPmid.get("100") ?? [])[0];
    expect(chip.cwid).toBe("stu2222");
    expect(chip.slug).toBeNull();
    expect(chip.roleCategory).toBe("doctoral_student_md");
  });
});

// ---------------------------------------------------------------------------
// 3. The relaxed renderable predicate (#1026 CHANGE 4)
// ---------------------------------------------------------------------------
//
// Mirrors the predicate used at the consumer sites in lib/api/search.ts:
//   a.cwid && a.identityImageEndpoint && (a.slug || !isPubliclyDisplayed(a.roleCategory))
type Chip = {
  cwid: string | null;
  slug: string | null;
  identityImageEndpoint: string | null;
  roleCategory: string | null;
};

function isRenderable(a: Chip): boolean {
  return Boolean(
    a.cwid && a.identityImageEndpoint && (a.slug || !isPubliclyDisplayed(a.roleCategory)),
  );
}

describe("relaxed renderable predicate — #1026 CHANGE 4", () => {
  it("renders a slug-less hidden-class student chip (cwid + img, hidden role)", () => {
    expect(
      isRenderable({
        cwid: "stu2222",
        slug: null,
        identityImageEndpoint: "/img/stu2222",
        roleCategory: "doctoral_student_md",
      }),
    ).toBe(true);
  });

  it("renders an active author with a slug exactly as today", () => {
    expect(
      isRenderable({
        cwid: "aaa1111",
        slug: "aaa1111-slug",
        identityImageEndpoint: "/img/aaa1111",
        roleCategory: "full_time_faculty",
      }),
    ).toBe(true);
  });

  it("flag-off behavior is unchanged: a slug-less DISPLAYED-role author is NOT renderable", () => {
    // When the flag is off, no hidden-class student is hydrated, so the only
    // slug-less authors that could appear carry a displayed role — and those
    // are dropped exactly as the prior `cwid && slug && img` predicate did.
    expect(
      isRenderable({
        cwid: "ccc3333",
        slug: null,
        identityImageEndpoint: "/img/ccc3333",
        roleCategory: "full_time_faculty",
      }),
    ).toBe(false);
  });

  it("drops a chip with no cwid or no image regardless of role", () => {
    expect(
      isRenderable({ cwid: null, slug: "x", identityImageEndpoint: "/img", roleCategory: null }),
    ).toBe(false);
    expect(
      isRenderable({
        cwid: "stu2222",
        slug: null,
        identityImageEndpoint: null,
        roleCategory: "doctoral_student_md",
      }),
    ).toBe(false);
  });
});
