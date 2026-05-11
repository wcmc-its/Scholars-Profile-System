/**
 * Unit tests for lib/seo/jsonld.ts — Schema.org Person JSON-LD builder.
 *
 * Contract (issue #171):
 *  - @context = "https://schema.org", @type = "Person"
 *  - name from preferredName (postnominal applied upstream)
 *  - url canonicalized to scholars.weill.cornell.edu/scholars/<slug>
 *  - image always populated from identityImageEndpoint
 *  - affiliation + worksFor both carry WCM ROR identifier
 *  - worksFor.department nested when primaryDepartment is non-null
 *  - jobTitle conditional on primaryTitle
 *  - description derived from overview (HTML-stripped, entity-decoded, capped)
 *  - sameAs includes clinicalProfileUrl when present; omitted otherwise
 *  - knowsAbout drawn from MeSH keywords, capped, omitted when empty
 *  - ORCID not yet emitted — schema field doesn't exist; tracked in #171
 */
import { describe, expect, it } from "vitest";
import {
  buildDefinedTermJsonLd,
  buildOrganizationJsonLd,
  buildPersonJsonLd,
  overviewToDescription,
  type PersonJsonLdInput,
} from "@/lib/seo/jsonld";

const WCM_ROR = "https://ror.org/05bnh6r87";

const baseInput: PersonJsonLdInput = {
  slug: "jane-smith",
  preferredName: "Jane Smith, MD",
  primaryTitle: "Professor of Medicine",
  primaryDepartment: "Medicine",
  overview: "Dr. Smith studies cardiovascular disease.",
  identityImageEndpoint: "https://example.test/img/123.png",
  clinicalProfileUrl: "https://weillcornell.org/janesmith",
  keywords: [
    { displayLabel: "Cardiology" },
    { displayLabel: "Hypertension" },
  ],
};

describe("buildPersonJsonLd", () => {
  it("returns Schema.org @context and @type Person", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Person");
  });

  it("uses preferredName as name", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.name).toBe("Jane Smith, MD");
  });

  it("emits canonical url with slug", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect((ld.url as string).endsWith("/scholars/jane-smith")).toBe(true);
  });

  it("emits image from identityImageEndpoint", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.image).toBe("https://example.test/img/123.png");
  });

  it("affiliation carries WCM ROR identifier", () => {
    const ld = buildPersonJsonLd(baseInput);
    const aff = ld.affiliation as Record<string, unknown>;
    expect(aff["@type"]).toBe("Organization");
    expect(aff.name).toBe("Weill Cornell Medicine");
    expect(aff.url).toBe("https://weill.cornell.edu");
    expect(aff.identifier).toBe(WCM_ROR);
  });

  it("worksFor mirrors WCM with ROR and nests department when present", () => {
    const ld = buildPersonJsonLd(baseInput);
    const wf = ld.worksFor as Record<string, unknown>;
    expect(wf["@type"]).toBe("Organization");
    expect(wf.name).toBe("Weill Cornell Medicine");
    expect(wf.identifier).toBe(WCM_ROR);
    const dept = wf.department as Record<string, unknown>;
    expect(dept["@type"]).toBe("Organization");
    expect(dept.name).toBe("Medicine");
  });

  it("omits worksFor.department when primaryDepartment is null", () => {
    const ld = buildPersonJsonLd({ ...baseInput, primaryDepartment: null });
    const wf = ld.worksFor as Record<string, unknown>;
    expect(wf).not.toHaveProperty("department");
  });

  it("includes jobTitle when primaryTitle is provided", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.jobTitle).toBe("Professor of Medicine");
  });

  it("omits jobTitle when primaryTitle is null", () => {
    const ld = buildPersonJsonLd({ ...baseInput, primaryTitle: null });
    expect(ld).not.toHaveProperty("jobTitle");
  });

  it("derives description from overview", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.description).toBe("Dr. Smith studies cardiovascular disease.");
  });

  it("omits description when overview is null", () => {
    const ld = buildPersonJsonLd({ ...baseInput, overview: null });
    expect(ld).not.toHaveProperty("description");
  });

  it("emits sameAs with clinicalProfileUrl when present", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.sameAs).toEqual(["https://weillcornell.org/janesmith"]);
  });

  it("emits ORCID URL in sameAs when orcid is set", () => {
    const ld = buildPersonJsonLd({ ...baseInput, orcid: "0000-0002-1825-0097" });
    expect(ld.sameAs).toEqual([
      "https://orcid.org/0000-0002-1825-0097",
      "https://weillcornell.org/janesmith",
    ]);
  });

  it("orders sameAs with ORCID first, clinical URL second", () => {
    const ld = buildPersonJsonLd({
      ...baseInput,
      orcid: "0000-0001-2345-678X",
    });
    const same = ld.sameAs as string[];
    expect(same[0].startsWith("https://orcid.org/")).toBe(true);
    expect(same[1].startsWith("https://weillcornell.org/")).toBe(true);
  });

  it("emits ORCID alone when clinicalProfileUrl is null", () => {
    const ld = buildPersonJsonLd({
      ...baseInput,
      clinicalProfileUrl: null,
      orcid: "0000-0002-1825-0097",
    });
    expect(ld.sameAs).toEqual(["https://orcid.org/0000-0002-1825-0097"]);
  });

  it("omits sameAs when clinicalProfileUrl is null and orcid is null/absent", () => {
    const ld = buildPersonJsonLd({ ...baseInput, clinicalProfileUrl: null });
    expect(ld).not.toHaveProperty("sameAs");
    const withNullOrcid = buildPersonJsonLd({
      ...baseInput,
      clinicalProfileUrl: null,
      orcid: null,
    });
    expect(withNullOrcid).not.toHaveProperty("sameAs");
  });

  it("emits knowsAbout from MeSH keywords", () => {
    const ld = buildPersonJsonLd(baseInput);
    expect(ld.knowsAbout).toEqual(["Cardiology", "Hypertension"]);
  });

  it("caps knowsAbout at 20 entries", () => {
    const keywords = Array.from({ length: 30 }, (_, i) => ({
      displayLabel: `Term ${i}`,
    }));
    const ld = buildPersonJsonLd({ ...baseInput, keywords });
    expect((ld.knowsAbout as string[]).length).toBe(20);
  });

  it("omits knowsAbout when keywords is empty or absent", () => {
    const empty = buildPersonJsonLd({ ...baseInput, keywords: [] });
    expect(empty).not.toHaveProperty("knowsAbout");
    const absent = buildPersonJsonLd({ ...baseInput, keywords: undefined });
    expect(absent).not.toHaveProperty("knowsAbout");
  });
});

describe("buildOrganizationJsonLd", () => {
  it("emits Organization rolled up to WCM via parentOrganization", () => {
    const ld = buildOrganizationJsonLd({
      slug: "medicine",
      route: "departments",
      name: "Department of Medicine",
      description: "Largest clinical department.",
    });
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Organization");
    expect(ld.name).toBe("Department of Medicine");
    expect((ld.url as string).endsWith("/departments/medicine")).toBe(true);
    const parent = ld.parentOrganization as Record<string, unknown>;
    expect(parent["@type"]).toBe("Organization");
    expect(parent.name).toBe("Weill Cornell Medicine");
    expect(parent.identifier).toBe(WCM_ROR);
  });

  it("includes description when provided, omits when null", () => {
    const withDesc = buildOrganizationJsonLd({
      slug: "x",
      route: "centers",
      name: "X",
      description: "<p>A blurb.</p>",
    });
    expect(withDesc.description).toBe("A blurb.");
    const without = buildOrganizationJsonLd({
      slug: "x",
      route: "centers",
      name: "X",
      description: null,
    });
    expect(without).not.toHaveProperty("description");
  });

  it("routes to /centers/<slug> when route is centers", () => {
    const ld = buildOrganizationJsonLd({
      slug: "meyer-cancer-center",
      route: "centers",
      name: "Meyer Cancer Center",
      description: null,
    });
    expect((ld.url as string).endsWith("/centers/meyer-cancer-center")).toBe(true);
  });
});

describe("buildDefinedTermJsonLd", () => {
  it("emits DefinedTerm with url and inDefinedTermSet", () => {
    const ld = buildDefinedTermJsonLd({
      id: "aging_geroscience",
      label: "Aging & Geroscience",
      description: null,
    });
    expect(ld["@type"]).toBe("DefinedTerm");
    expect(ld.name).toBe("Aging & Geroscience");
    expect((ld.url as string).endsWith("/topics/aging_geroscience")).toBe(true);
    expect((ld.inDefinedTermSet as string).endsWith("/browse")).toBe(true);
  });

  it("includes description when provided", () => {
    const ld = buildDefinedTermJsonLd({
      id: "x",
      label: "X",
      description: "Hallmarks of aging.",
    });
    expect(ld.description).toBe("Hallmarks of aging.");
  });
});

describe("overviewToDescription", () => {
  it("returns null for null/empty overviews", () => {
    expect(overviewToDescription(null)).toBeNull();
    expect(overviewToDescription("")).toBeNull();
    expect(overviewToDescription("   ")).toBeNull();
  });

  it("strips HTML tags", () => {
    expect(overviewToDescription("<p>Dr. Smith <strong>studies</strong> hearts.</p>"))
      .toBe("Dr. Smith studies hearts.");
  });

  it("decodes WCM editor's entities", () => {
    expect(overviewToDescription("A&nbsp;B&amp;C &ndash; D&rsquo;s &ldquo;test&rdquo;"))
      .toBe("A B&C – D’s “test”");
  });

  it("collapses whitespace runs", () => {
    expect(overviewToDescription("a\n\n  b   c"))
      .toBe("a b c");
  });

  it("caps long output at a word boundary with ellipsis", () => {
    const long = "word ".repeat(200);
    const out = overviewToDescription(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(301); // cap + ellipsis
    expect(out!.endsWith("…")).toBe(true);
    // No mid-word truncation.
    expect(out!.replace(/…$/, "").endsWith(" word") || out!.replace(/…$/, "").endsWith("word"))
      .toBe(true);
  });

  it("leaves short text uncapped", () => {
    expect(overviewToDescription("Short blurb.")).toBe("Short blurb.");
  });
});
