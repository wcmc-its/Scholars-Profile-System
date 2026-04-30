import { describe, expect, it, vi } from "vitest";
import { EXPECTED_HEADSHOT_URL, FIXTURE_CWID } from "../fixtures/scholar";

// Mock Prisma BEFORE importing the module under test.
// The actual lib/api/scholars.ts uses findFirst (with status + deletedAt
// filters); both findFirst and findUnique are stubbed to be safe.
vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: vi.fn(async () => ({
        cwid: FIXTURE_CWID,
        slug: "jane-doe",
        preferredName: "Jane Doe",
        fullName: "Jane Q. Doe",
        primaryTitle: "Associate Professor",
        primaryDepartment: "Medicine",
        email: null,
        overview: null,
        appointments: [],
        deletedAt: null,
        status: "active",
      })),
      findUnique: vi.fn(async () => ({
        cwid: FIXTURE_CWID,
        slug: "jane-doe",
        preferredName: "Jane Doe",
        fullName: "Jane Q. Doe",
        primaryTitle: "Associate Professor",
        primaryDepartment: "Medicine",
        email: null,
        overview: null,
        appointments: [],
        deletedAt: null,
        status: "active",
      })),
    },
  },
}));

describe("getScholarByCwid serializer", () => {
  it("includes identityImageEndpoint in the payload", async () => {
    const { getScholarByCwid } = await import("@/lib/api/scholars");
    const payload = await getScholarByCwid(FIXTURE_CWID);
    expect(payload).not.toBeNull();
    expect((payload as { identityImageEndpoint?: string }).identityImageEndpoint).toBe(
      EXPECTED_HEADSHOT_URL,
    );
  });

  it("identityImageEndpoint is a string (never null)", async () => {
    const { getScholarByCwid } = await import("@/lib/api/scholars");
    const payload = await getScholarByCwid(FIXTURE_CWID);
    expect(typeof (payload as { identityImageEndpoint?: string }).identityImageEndpoint).toBe(
      "string",
    );
  });
});
