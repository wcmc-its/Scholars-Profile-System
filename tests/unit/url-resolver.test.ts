/**
 * Unit tests for the URL resolver. Uses a hand-rolled Prisma stub so these run
 * without a live database. Integration coverage against the seeded DB is
 * exercised by the Playwright E2E suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findFirst: vi.fn() },
    slugHistory: { findUnique: vi.fn() },
    cwidAlias: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import { resolveByCwidOrAlias, resolveBySlugOrHistory } from "@/lib/url-resolver";

const mockedPrisma = prisma as unknown as {
  scholar: { findFirst: ReturnType<typeof vi.fn> };
  slugHistory: { findUnique: ReturnType<typeof vi.fn> };
  cwidAlias: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  mockedPrisma.scholar.findFirst.mockReset();
  mockedPrisma.slugHistory.findUnique.mockReset();
  mockedPrisma.cwidAlias.findUnique.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveBySlugOrHistory", () => {
  it("returns 'found' for a current canonical slug on an active scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({ cwid: "jas2001", slug: "jane-smith" });
    const result = await resolveBySlugOrHistory("jane-smith");
    expect(result).toEqual({ type: "found", cwid: "jas2001", slug: "jane-smith" });
  });

  it("returns 'redirect' when the slug is in slug_history for an active scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "sarah-johnson", deletedAt: null, status: "active" },
    });
    const result = await resolveBySlugOrHistory("sarah-davies");
    expect(result).toEqual({ type: "redirect", targetSlug: "sarah-johnson" });
  });

  it("returns 'not-found' when slug_history points to a soft-deleted scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "robert-wilson", deletedAt: new Date(), status: "active" },
    });
    const result = await resolveBySlugOrHistory("rob-wilson");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' when slug_history points to a suppressed scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: { slug: "x-y", deletedAt: null, status: "suppressed" },
    });
    const result = await resolveBySlugOrHistory("old-slug");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an unknown slug", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce(null);
    const result = await resolveBySlugOrHistory("nobody-here");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an empty slug without hitting the DB", async () => {
    const result = await resolveBySlugOrHistory("");
    expect(result).toEqual({ type: "not-found" });
    expect(mockedPrisma.scholar.findFirst).not.toHaveBeenCalled();
  });
});

describe("resolveByCwidOrAlias", () => {
  it("returns 'redirect' when an active scholar exists for the CWID", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({ cwid: "jas2001", slug: "jane-smith" });
    const result = await resolveByCwidOrAlias("jas2001");
    expect(result).toEqual({ type: "redirect", targetSlug: "jane-smith" });
  });

  it("returns 'redirect' when the CWID is in cwid_aliases", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce({
      current: { slug: "diana-patel", deletedAt: null, status: "active" },
    });
    const result = await resolveByCwidOrAlias("dpa1010");
    expect(result).toEqual({ type: "redirect", targetSlug: "diana-patel" });
  });

  it("returns 'not-found' when cwid_aliases points to a soft-deleted scholar", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce({
      current: { slug: "x", deletedAt: new Date(), status: "active" },
    });
    const result = await resolveByCwidOrAlias("old1234");
    expect(result).toEqual({ type: "not-found" });
  });

  it("returns 'not-found' for an unknown CWID", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);
    const result = await resolveByCwidOrAlias("zzz9999");
    expect(result).toEqual({ type: "not-found" });
  });
});

/**
 * #2268 — both resolvers feed anonymous public routes that `permanentRedirect()`,
 * and the slug is name-derived, so a resolved hidden scholar leaves as a NAME in the
 * `Location` header before the destination page's render-time carve can run.
 *
 * Both halves are pinned independently, because neither alone is sufficient:
 *   1. the QUERY-layer carve (`publicRoleWhere()`), asserted on the where-clause —
 *      with the explicit NULL branch, since `notIn` on a nullable column also drops
 *      NULL rows and would 404 every un-backfilled scholar;
 *   2. the fail-closed POST-filter on the RAW `role_category`. The stub hands the row
 *      back regardless of the where-clause, so the suffixed cases below can only pass
 *      if `isPubliclyDisplayed` also runs — Prisma cannot express the
 *      `doctoral_student*` prefix, so the enumeration alone lets an out-of-band
 *      suffix through.
 */
describe("#2268 url-resolver — hidden identity classes do not resolve", () => {
  /** The OR branch shapes `publicRoleWhere()` must contribute. */
  function assertRoleCarve(where: Record<string, unknown>) {
    const or = where.OR as Array<Record<string, unknown>>;
    expect(Array.isArray(or)).toBe(true);
    expect(or).toContainEqual({ roleCategory: null });
    const notInBranch = or.find((b) => b.roleCategory && "notIn" in (b.roleCategory as object));
    expect(notInBranch).toBeDefined();
    const notIn = (notInBranch!.roleCategory as { notIn: string[] }).notIn;
    for (const hidden of HIDDEN_ROLE_CATEGORIES) expect(notIn).toContain(hidden);
    expect(notIn).toContain("doctoral_student");
  }

  /**
   * The post-filter reads the RAW column, so the select must carry it: drop
   * `roleCategory` from the select and `isPubliclyDisplayed(undefined)` is TRUE —
   * the second layer fails OPEN and every out-of-band suffix resolves again.
   */
  function assertSelectsRole(select: Record<string, unknown>) {
    expect(select.roleCategory).toBe(true);
  }

  it("carves the direct-slug and slug_history arms at the QUERY layer", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce(null);

    await resolveBySlugOrHistory("test-person");

    const directCall = mockedPrisma.scholar.findFirst.mock.calls[0][0];
    const direct = directCall.where as Record<string, unknown>;
    expect(direct.slug).toBe("test-person");
    expect(direct.deletedAt).toBeNull();
    expect(direct.status).toBe("active");
    assertRoleCarve(direct);
    assertSelectsRole(directCall.select as Record<string, unknown>);

    const relCall = mockedPrisma.slugHistory.findUnique.mock.calls[0][0];
    const rel = relCall.where as Record<string, unknown>;
    expect(rel.oldSlug).toBe("test-person");
    assertRoleCarve(rel.current as Record<string, unknown>);
    assertSelectsRole(
      (relCall.select as { current: { select: Record<string, unknown> } }).current.select,
    );
  });

  it("carves the direct-cwid and cwid_alias arms at the QUERY layer", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);

    await resolveByCwidOrAlias("zzz9999");

    const directCall = mockedPrisma.scholar.findFirst.mock.calls[0][0];
    const direct = directCall.where as Record<string, unknown>;
    expect(direct.cwid).toBe("zzz9999");
    expect(direct.deletedAt).toBeNull();
    expect(direct.status).toBe("active");
    assertRoleCarve(direct);
    assertSelectsRole(directCall.select as Record<string, unknown>);

    const relCall = mockedPrisma.cwidAlias.findUnique.mock.calls[0][0];
    const rel = relCall.where as Record<string, unknown>;
    expect(rel.oldCwid).toBe("zzz9999");
    assertRoleCarve(rel.current as Record<string, unknown>);
    assertSelectsRole(
      (relCall.select as { current: { select: Record<string, unknown> } }).current.select,
    );
  });

  it("post-filter rejects an out-of-band suffix the enumeration cannot express (cwid arms)", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({
      cwid: "zzz9999",
      slug: "test-person",
      roleCategory: "doctoral_student_dds",
    });
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);
    expect(await resolveByCwidOrAlias("zzz9999")).toEqual({ type: "not-found" });

    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce({
      current: {
        slug: "test-person",
        deletedAt: null,
        status: "active",
        roleCategory: "doctoral_student_dds",
      },
    });
    expect(await resolveByCwidOrAlias("zzz9998")).toEqual({ type: "not-found" });
  });

  it("post-filter rejects an out-of-band suffix the enumeration cannot express (slug arms)", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({
      cwid: "zzz9999",
      slug: "test-person",
      roleCategory: "doctoral_student_dds",
    });
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce(null);
    expect(await resolveBySlugOrHistory("test-person")).toEqual({ type: "not-found" });

    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.slugHistory.findUnique.mockResolvedValueOnce({
      current: {
        slug: "test-person",
        deletedAt: null,
        status: "active",
        roleCategory: "doctoral_student_dds",
      },
    });
    expect(await resolveBySlugOrHistory("old-test-person")).toEqual({ type: "not-found" });
  });

  it("a hidden CWID is indistinguishable from one that never existed", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);
    const missing = await resolveByCwidOrAlias("zzz9999");

    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({
      cwid: "zzz9998",
      slug: "test-person",
      roleCategory: "doctoral_student",
    });
    mockedPrisma.cwidAlias.findUnique.mockResolvedValueOnce(null);
    const hidden = await resolveByCwidOrAlias("zzz9998");

    expect(missing).toEqual({ type: "not-found" });
    expect(hidden).toEqual(missing);
  });

  it("still resolves visible faculty and un-backfilled (role_category NULL) scholars", async () => {
    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({
      cwid: "zzz9999",
      slug: "test-person",
      roleCategory: "full_time_faculty",
    });
    expect(await resolveByCwidOrAlias("zzz9999")).toEqual({
      type: "redirect",
      targetSlug: "test-person",
    });

    mockedPrisma.scholar.findFirst.mockResolvedValueOnce({
      cwid: "zzz9999",
      slug: "test-person",
      roleCategory: null,
    });
    expect(await resolveBySlugOrHistory("test-person")).toEqual({
      type: "found",
      cwid: "zzz9999",
      slug: "test-person",
    });
  });
});
