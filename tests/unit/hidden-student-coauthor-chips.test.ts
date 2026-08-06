/**
 * Issue #1026 — surface soft-deleted active doctoral-student co-authors as
 * NON-LINKED author chips on publication chip surfaces. Flag-gated, default-off.
 *
 * Covers:
 *   1. isPubliclyDisplayed — the #1026 prefix-hardening (CHANGE 2): suffixed
 *      doctoral_student_* roles and the bare value are hidden; displayed roles
 *      and null/unknown are unaffected.
 *   2. fetchWcmAuthorsForPmids scholar-filter shape (CHANGE 3): flag OFF →
 *      { deletedAt:null, status:"active" }; flag ON → OR[{deletedAt:null,
 *      status:"active"}, {roleCategory startsWith doctoral_student}] — the
 *      student branch does NOT gate on `status` (it's an unreliable artifact;
 *      642 staging students carry status="suppressed" with no backing
 *      Suppression row). Genuine whole-scholar takedowns are enforced
 *      authoritatively from the Suppression table instead.
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

  it("preserves fail-open for null / undefined, but fails closed on unknown (#2202)", () => {
    expect(isPubliclyDisplayed(null)).toBe(true);
    expect(isPubliclyDisplayed(undefined)).toBe(true);
    // Was `true` until #2202: an unrecognized token (a display label) leaked.
    expect(isPubliclyDisplayed("some_future_role")).toBe(false);
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

  it("flag ON → OR[{deletedAt:null,status:active},{roleCategory startsWith doctoral_student}] (no status gate on students)", async () => {
    process.env[FLAG] = "on";
    await fetchWcmAuthorsForPmids(["100"]);
    expect(capturedScholarWhere()).toEqual({
      OR: [
        { deletedAt: null, status: "active" },
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
    // Dispatch by entityType: the publication query carries the per-author hide;
    // the scholar-takedown query returns none.
    mockSuppressionFindMany.mockImplementation(async (args) =>
      args?.where?.entityType === "scholar"
        ? []
        : [{ entityId: "100", contributorCwid: "stu2222" }],
    );
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111"]);
  });

  it("flag ON drops an author with an active whole-scholar takedown (authoritative — not the status column)", async () => {
    process.env[FLAG] = "on";
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First", { isFirst: true }),
      authorRow("100", "stu2222", "Stu Dent", {
        isLast: true,
        slug: null,
        roleCategory: "doctoral_student_md",
      }),
    ]);
    // A genuine ADR-005 whole-scholar takedown exists for the student.
    mockSuppressionFindMany.mockImplementation(async (args) =>
      args?.where?.entityType === "scholar" ? [{ entityId: "stu2222" }] : [],
    );
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

  // -------------------------------------------------------------------------
  // #2223 — flag OFF must mean ABSENT on the PROD data shape, not just staging's
  // -------------------------------------------------------------------------
  //
  // The where-clause above only RELAXES the soft-delete gate when the flag is
  // on. It never tightened it when off — so a student who is not soft-deleted
  // sailed straight through the flag-off filter. That is exactly prod: 690
  // doctoral students carry the bare `doctoral_student` with `deleted_at IS
  // NULL` and `status='active'`. On staging every student is suffixed AND
  // soft-deleted, so the query alone hides them and this defect is invisible —
  // these cases are written against the prod shape deliberately.
  it("flag OFF drops a NON-soft-deleted doctoral student the query still returns", async () => {
    delete process.env[FLAG];
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First", { isFirst: true }),
      authorRow("100", "stu3333", "Prod Student", {
        isLast: true,
        roleCategory: "doctoral_student",
      }),
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111"]);
  });

  it("flag OFF drops an alumni co-author too (the other hidden identity class)", async () => {
    delete process.env[FLAG];
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First"),
      authorRow("100", "alu4444", "Al Umni", { roleCategory: "affiliate_alumni" }),
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111"]);
  });

  it("flag OFF keeps NULL-role and ordinary-role co-authors (carve, not a cull)", async () => {
    delete process.env[FLAG];
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First", { roleCategory: "full_time_faculty" }),
      authorRow("100", "nul5555", "Not Backfilled", { roleCategory: null }),
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111", "nul5555"]);
  });

  it("flag ON keeps the student — ON is unchanged, so the live surfaces do not move", async () => {
    process.env[FLAG] = "on";
    mockSuppressionFindMany.mockResolvedValue([]);
    mockPublicationAuthorFindMany.mockResolvedValue([
      authorRow("100", "aaa1111", "Ada First"),
      authorRow("100", "stu3333", "Prod Student", { roleCategory: "doctoral_student" }),
    ]);
    const byPmid = await fetchWcmAuthorsForPmids(["100"]);
    expect((byPmid.get("100") ?? []).map((c) => c.cwid)).toEqual(["aaa1111", "stu3333"]);
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
