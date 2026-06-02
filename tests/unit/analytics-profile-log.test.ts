/**
 * Unit tests for ANALYTICS-01: profile page-view structured log.
 *
 * The log lives in the shared <ProfileView> render body
 * (components/profile/profile-view.tsx, #671) — exercised directly here since
 * the route files only create the element, not invoke it.
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
    hasClinicalProfile: false,
    identityImageEndpoint:
      "https://directory.weill.cornell.edu/api/v1/person/profile/abc1234.png?returnGenericOn404=false",
    appointments: [],
    educations: [],
    keywords: { totalAcceptedPubs: 0, keywords: [] },
    highlights: [],
    publications: [],
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

// Mock @/lib/api/mentoring — pulled in by MentoringSection on the profile
// page. Without this the underlying ReCiterDB pool init throws because
// SCHOLARS_RECITERDB_* env vars are absent in CI.
vi.mock("@/lib/api/mentoring", () => ({
  getMenteesForMentor: vi.fn(async () => []),
}));

// Mock next/headers (used by not-found.tsx — not by profile page, but avoids
// module resolution errors if transitively imported).
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: vi.fn(() => null),
  })),
}));

// Mock @/lib/auth/session-server — the profile page (#356 Phase 5 C7) consults
// the session to render the "Edit my profile" affordance for the signed-in
// owner. The session module imports "server-only", which Vite cannot resolve
// under the jsdom environment; the analytics test does not exercise the
// session branch (no signed-in owner in this fixture), so a null-returning
// mock is sufficient.
vi.mock("@/lib/auth/session-server", () => ({
  getSession: vi.fn(async () => null),
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
    const { ProfileView } = await import("@/components/profile/profile-view");

    // Render the server component (it returns JSX — we just need the side-effects).
    await ProfileView({ slug: "jane-doe" });

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
    const { ProfileView } = await import("@/components/profile/profile-view");

    await ProfileView({ slug: "jane-doe" });

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
    const { ProfileView } = await import("@/components/profile/profile-view");

    await ProfileView({ slug: "jane-doe" });

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
