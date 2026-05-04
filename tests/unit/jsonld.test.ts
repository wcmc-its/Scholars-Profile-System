/**
 * RED unit tests for lib/seo/jsonld.ts (Phase 5 / SEO-03).
 *
 * These tests define the contract that Plan 03 must satisfy. They FAIL now
 * because lib/seo/jsonld.ts does not yet exist. That is the expected RED state.
 *
 * Contract (D-26):
 *   - buildPersonJsonLd(profile) returns an object with @context 'https://schema.org'
 *   - @type === 'Person'
 *   - name is set from profile.preferredName
 *   - jobTitle is set when primaryTitle is present; OMITTED when primaryTitle is null
 *   - affiliation = { @type: 'Organization', name: 'Weill Cornell Medicine', url: 'https://weill.cornell.edu' }
 *   - url is `${NEXT_PUBLIC_SITE_URL}/scholars/${slug}`
 *   - sameAs is OMITTED (D-26 — only candidate duplicates the scholars URL itself)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: vi.fn() },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";
});

const BASE_PROFILE = {
  slug: "jane-doe",
  preferredName: "Jane Doe",
  primaryTitle: "Associate Professor of Medicine",
  primaryDepartment: "Medicine",
};

const PROFILE_NO_TITLE = {
  slug: "bob-smith",
  preferredName: "Bob Smith",
  primaryTitle: null,
  primaryDepartment: null,
};

describe("buildPersonJsonLd — JSON-LD shape (D-26)", () => {
  it("is importable from @/lib/seo/jsonld (will fail until Plan 03 creates the file)", async () => {
    // Will fail with module-not-found until Plan 03 creates lib/seo/jsonld.ts
    const mod = await import("@/lib/seo/jsonld");
    expect(typeof mod.buildPersonJsonLd).toBe("function");
  });

  it("returns @context 'https://schema.org'", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld["@context"]).toBe("https://schema.org");
  });

  it("returns @type 'Person'", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld["@type"]).toBe("Person");
  });

  it("includes name from profile.preferredName", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld.name).toBe("Jane Doe");
  });

  it("includes jobTitle when primaryTitle is present", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld.jobTitle).toBe("Associate Professor of Medicine");
  });

  it("OMITS jobTitle when primaryTitle is null", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(PROFILE_NO_TITLE);
    expect("jobTitle" in ld).toBe(false);
  });

  it("includes affiliation with correct Organization shape", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld.affiliation).toEqual({
      "@type": "Organization",
      name: "Weill Cornell Medicine",
      url: "https://weill.cornell.edu",
    });
  });

  it("includes url as absolute Scholars URL for the scholar", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect(ld.url).toBe("https://scholars.weill.cornell.edu/scholars/jane-doe");
  });

  it("OMITS sameAs (D-26 — only candidate would duplicate the url field)", async () => {
    const { buildPersonJsonLd } = await import("@/lib/seo/jsonld");
    const ld = buildPersonJsonLd(BASE_PROFILE);
    expect("sameAs" in ld).toBe(false);
  });
});
