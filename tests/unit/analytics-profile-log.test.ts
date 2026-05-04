/**
 * Unit tests for ANALYTICS-01: profile page-view structured log.
 *
 * RED phase — all assertions target console.log output that does not yet exist
 * in app/(public)/scholars/[slug]/page.tsx. Tests MUST FAIL until Task 2 inserts
 * the structured log call.
 *
 * Log shape: { event: "profile_view", cwid, slug, ts: ISO8601 }
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock next/navigation before importing the page module.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// Mock next/cache (used transitively by the profile module).
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock the URL resolver that runs before the profile fetch.
vi.mock("@/lib/url-resolver", () => ({
  resolveBySlugOrHistory: vi.fn(async (slug: string) => ({
    type: "found",
    slug,
  })),
}));

// Mock @/lib/api/profile — the profile fetch module.
vi.mock("@/lib/api/profile", () => ({
  getScholarFullProfileBySlug: vi.fn(async () => ({
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    fullName: "Jane Q. Doe",
    primaryTitle: "Associate Professor",
    primaryDepartment: "Medicine",
    email: null,
    overview: null,
    identityImageEndpoint:
      "https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false",
    appointments: [],
    educations: [],
    areasOfInterest: [],
    highlights: [],
    recent: [],
    grants: [],
    disclosures: [],
  })),
  getActiveScholarSlugs: vi.fn(async () => []),
  isSparseProfile: vi.fn(() => false),
}));

// Mock @/lib/seo/jsonld to avoid JSON-LD side-effects.
vi.mock("@/lib/seo/jsonld", () => ({
  buildPersonJsonLd: vi.fn(() => ({})),
}));

// Mock next/headers (used by not-found.tsx — not by profile page, but avoids
// module resolution errors if transitively imported).
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: vi.fn(() => null),
  })),
}));

describe("ANALYTICS-01 — profile_view structured log", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits a profile_view log line when a profile page renders", async () => {
    // Import the page module dynamically so mocks are in place.
    const { default: ScholarProfilePage } = await import(
      "@/app/(public)/scholars/[slug]/page"
    );

    // Render the server component (it returns JSX — we just need the side-effects).
    await ScholarProfilePage({ params: Promise.resolve({ slug: "jane-doe" }) });

    // At least one console.log call should have been made.
    expect(consoleSpy).toHaveBeenCalled();

    // Find the call that contains the profile_view event.
    const profileViewCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.event === "profile_view";
      } catch {
        return false;
      }
    });

    expect(
      profileViewCall,
      "Expected a console.log call with JSON containing event: profile_view",
    ).toBeDefined();

    const parsed = JSON.parse(profileViewCall![0] as string);
    expect(parsed.event).toBe("profile_view");
    expect(parsed.cwid).toBe("abc1234");
    expect(parsed.slug).toBe("jane-doe");
    expect(parsed.ts).toBeDefined();
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes the exact CWID from the fetched profile", async () => {
    const { default: ScholarProfilePage } = await import(
      "@/app/(public)/scholars/[slug]/page"
    );

    await ScholarProfilePage({ params: Promise.resolve({ slug: "jane-doe" }) });

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "profile_view";
      } catch {
        return false;
      }
    });

    const parsed = JSON.parse(call![0] as string);
    expect(parsed.cwid).toBe("abc1234");
  });

  it("log line is valid JSON (parseable by log drain)", async () => {
    const { default: ScholarProfilePage } = await import(
      "@/app/(public)/scholars/[slug]/page"
    );

    await ScholarProfilePage({ params: Promise.resolve({ slug: "jane-doe" }) });

    const call = consoleSpy.mock.calls.find((c) => {
      try {
        return JSON.parse(c[0] as string).event === "profile_view";
      } catch {
        return false;
      }
    });

    expect(() => JSON.parse(call![0] as string)).not.toThrow();
  });
});
