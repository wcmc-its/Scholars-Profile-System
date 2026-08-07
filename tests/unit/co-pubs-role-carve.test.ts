/**
 * #2268 — the four `/scholars/<slug>/co-pubs*` child routes resolve their MENTOR
 * by slug on an anonymous surface and publish that name (`<title>`, the meta
 * description, the `<h1>`, every exported citation row). They carried no #536
 * carve, so once the profile route 404s a hidden identity class its own child
 * routes still answered 200 with the name.
 *
 * Each route now runs the same two layers as `lib/url-resolver.ts`:
 * `publicRoleWhere()` in the where-clause, then a fail-closed
 * `isPubliclyDisplayed` on the RAW `role_category`. The stub hands the row back
 * regardless of the where-clause, so the hidden-mentor cases below can only pass
 * if the post-filter runs — Prisma cannot express the `doctoral_student*` prefix
 * that predicate matches, so the enumeration alone lets a suffix through.
 *
 * Synthetic CWIDs/slugs only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

const { scholarFindFirst, scholarFindMany } = vi.hoisted(() => ({
  scholarFindFirst: vi.fn(),
  scholarFindMany: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/lib/db", () => ({
  prisma: { scholar: { findFirst: scholarFindFirst, findMany: scholarFindMany } },
}));

// The mentoring layer answers as if every lookup succeeds, so the mentor carve
// is the ONLY thing that can produce the 404 — a `null` pair here would 404 the
// per-mentee routes for the wrong reason and mask a missing carve.
vi.mock("@/lib/api/mentoring", () => ({
  menteeProgramLabel: () => "Other mentee",
  copubId: () => "copub-1",
  getAllMentorCoPublications: vi.fn(async () => ({
    groups: [],
    publicationCount: 0,
    menteeCount: 0,
  })),
  getCoPublications: vi.fn(async () => []),
  getMentorMenteePair: vi.fn(async () => ({
    mentorName: "Test Person",
    menteeName: "Test Mentee",
    manualOnly: false,
  })),
}));

import RollupPage, {
  generateMetadata as rollupMetadata,
} from "@/app/(public)/scholars/[slug]/co-pubs/page";
import MenteePage, {
  generateMetadata as menteeMetadata,
} from "@/app/(public)/scholars/[slug]/co-pubs/[menteeCwid]/page";
import { GET as rollupExport } from "@/app/(public)/scholars/[slug]/co-pubs/export/route";
import { GET as menteeExport } from "@/app/(public)/scholars/[slug]/co-pubs/[menteeCwid]/export/route";

const SLUG = "test-person";
const rollupParams = { params: Promise.resolve({ slug: SLUG }) };
const menteeParams = { params: Promise.resolve({ slug: SLUG, menteeCwid: "zzz9999" }) };
const exportRequest = (path: string) =>
  new Request(
    `http://localhost/scholars/${SLUG}/co-pubs/${path}?format=csv`,
  ) as unknown as NextRequest;

/** A mentor row carrying an out-of-band suffix the `notIn` enumeration misses. */
const HIDDEN_MENTOR = {
  cwid: "zzz9999",
  slug: SLUG,
  preferredName: "Test Person",
  postnominal: null,
  roleCategory: "doctoral_student_dds",
};

beforeEach(() => {
  mockNotFound.mockClear();
  scholarFindFirst.mockReset();
  scholarFindMany.mockClear();
});

describe("co-pubs child routes — a hidden mentor is a 404, not a name", () => {
  it("404s the rollup page and its metadata", async () => {
    scholarFindFirst.mockResolvedValue(HIDDEN_MENTOR);
    await expect(RollupPage(rollupParams)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await rollupMetadata(rollupParams)).toEqual({ title: "Not found" });
  });

  it("404s the per-mentee page and its metadata", async () => {
    scholarFindFirst.mockResolvedValue(HIDDEN_MENTOR);
    await expect(MenteePage(menteeParams)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await menteeMetadata(menteeParams)).toEqual({ title: "Not found" });
  });

  it("404s both export routes", async () => {
    scholarFindFirst.mockResolvedValue(HIDDEN_MENTOR);
    expect((await rollupExport(exportRequest("export"), rollupParams)).status).toBe(404);
    expect((await menteeExport(exportRequest("zzz9999/export"), menteeParams)).status).toBe(404);
  });

  it("still serves a visible mentor", async () => {
    scholarFindFirst.mockResolvedValue({ ...HIDDEN_MENTOR, roleCategory: "full_time_faculty" });
    expect(await rollupMetadata(rollupParams)).toMatchObject({
      title: expect.stringContaining("Test Person"),
    });
    expect((await rollupExport(exportRequest("export"), rollupParams)).status).toBe(200);
    expect((await menteeExport(exportRequest("zzz9999/export"), menteeParams)).status).toBe(200);
  });
});

describe("co-pubs child routes — the carve is in the query too", () => {
  /** `assertRoleCarve` from `tests/unit/url-resolver.test.ts`, same shape. */
  function assertRoleCarve(where: Record<string, unknown>) {
    expect(where.slug).toBe(SLUG);
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    const or = where.OR as Array<Record<string, { notIn?: string[] }>> | undefined;
    expect(or).toContainEqual({ roleCategory: null });
    const notIn = or?.find((b) => b.roleCategory?.notIn)?.roleCategory.notIn;
    for (const hidden of HIDDEN_ROLE_CATEGORIES) expect(notIn).toContain(hidden);
  }

  /** Drop `roleCategory` from the select and the post-filter reads `undefined`,
   *  which `isPubliclyDisplayed` passes: the second layer fails OPEN. */
  function assertSelectsRole(select: Record<string, unknown>) {
    expect(select.roleCategory).toBe(true);
  }

  // Each route resolves its mentor with its OWN findFirst; one route's carve
  // vouches for nothing about the other three, so each gets its own assertion.
  const routes: Array<[string, () => Promise<void>]> = [
    [
      "rollup page",
      async () => {
        await expect(RollupPage(rollupParams)).rejects.toThrow("NEXT_NOT_FOUND");
      },
    ],
    [
      "per-mentee page",
      async () => {
        await expect(MenteePage(menteeParams)).rejects.toThrow("NEXT_NOT_FOUND");
      },
    ],
    [
      "rollup export",
      async () => {
        expect((await rollupExport(exportRequest("export"), rollupParams)).status).toBe(404);
      },
    ],
    [
      "per-mentee export",
      async () => {
        expect((await menteeExport(exportRequest("zzz9999/export"), menteeParams)).status).toBe(
          404,
        );
      },
    ],
  ];

  it.each(routes)(
    "%s carves at the QUERY layer and selects the column the post-filter reads",
    async (_label, drive) => {
      scholarFindFirst.mockResolvedValue(null);
      await drive();

      const { where, select } = scholarFindFirst.mock.calls[0][0];
      assertRoleCarve(where);
      assertSelectsRole(select);
    },
  );
});
