import { describe, expect, it, vi } from "vitest";
import { FIXTURE_CWID, fixtureScholar } from "../fixtures/scholar";

// Mock Prisma BEFORE importing the module under test. The row deliberately
// carries profile content so the exact-shape assertion fails if any leaks.
vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: vi.fn(async () => ({
        ...fixtureScholar,
        email: "person@example.org",
        overview: "Raw imported overview",
        appointments: [{ title: "Hidden appointment" }],
        roleCategory: "full_time_faculty",
      })),
    },
  },
}));

describe("getScholarByCwid serializer", () => {
  it("returns exactly cwid, slug and preferredName, never profile content", async () => {
    const { getScholarByCwid } = await import("@/lib/api/scholars");
    expect(await getScholarByCwid(FIXTURE_CWID)).toEqual({
      cwid: FIXTURE_CWID,
      slug: "jane-doe",
      preferredName: "Jane Doe",
    });
  });

  it("does not read profile content from the database", async () => {
    const { prisma } = await import("@/lib/db");
    const { getScholarByCwid } = await import("@/lib/api/scholars");
    await getScholarByCwid(FIXTURE_CWID);
    const args = vi.mocked(prisma.scholar.findFirst).mock.lastCall![0]!;
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select!).sort()).toEqual([
      "cwid",
      "preferredName",
      "roleCategory",
      "slug",
    ]);
  });
});
