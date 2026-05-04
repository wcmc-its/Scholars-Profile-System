/**
 * Unit tests for lib/seo/jsonld.ts — Schema.org Person JSON-LD builder.
 *
 * Contract (D-26):
 *  - Includes @context, @type, name, affiliation, url
 *  - Omits jobTitle when primaryTitle is null
 *  - Includes jobTitle when primaryTitle is non-null
 *  - Never emits sameAs (would duplicate url; ORCID deferred to v2)
 */
import { describe, expect, it } from "vitest";
import { buildPersonJsonLd, type PersonJsonLdInput } from "@/lib/seo/jsonld";

describe("buildPersonJsonLd", () => {
  const baseInput: PersonJsonLdInput = {
    slug: "jane-smith",
    preferredName: "Jane Smith",
    primaryTitle: "Professor of Medicine",
  };

  it("returns Schema.org @context and @type Person", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Person");
  });

  it("includes name from preferredName", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.name).toBe("Jane Smith");
  });

  it("includes affiliation as Organization with Weill Cornell Medicine", () => {
    const ld = buildPersonJsonLd(baseInput);
    const aff = ld.affiliation as Record<string, unknown>;
    expect(aff["@type"]).toBe("Organization");
    expect(aff.name).toBe("Weill Cornell Medicine");
    expect(aff.url).toBe("https://weill.cornell.edu");
  });

  it("includes url with slug", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(typeof ld.url).toBe("string");
    expect((ld.url as string).endsWith("/scholars/jane-smith")).toBe(true);
  });

  it("includes jobTitle when primaryTitle is provided", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.jobTitle).toBe("Professor of Medicine");
  });

  it("omits jobTitle when primaryTitle is null (D-26)", () => {
    const ld = buildPersonJsonLd({ ...baseInput, primaryTitle: null });
    expect(ld).not.toHaveProperty("jobTitle");
  });

  it("never emits sameAs (D-26 — only candidate duplicates url; ORCID deferred)", () => {
    const withTitle = buildPersonJsonLd(baseInput);
    const withoutTitle = buildPersonJsonLd({ ...baseInput, primaryTitle: null });
    expect(withTitle).not.toHaveProperty("sameAs");
    expect(withoutTitle).not.toHaveProperty("sameAs");
  });
});
