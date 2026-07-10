/**
 * Tests for parseSeed (etl/technologies/seed.ts) — the validator standing
 * between CTL's scraped portfolio and a public profile.
 *
 * Pure module, no Prisma: the importer's `main()` lives in index.ts.
 */
import { describe, expect, it } from "vitest";

import { parseSeed } from "@/etl/technologies/seed";

const row = (over: Record<string, unknown> = {}) => ({
  cwid: "zhz9010",
  reference: "11166",
  title: "AI-Powered, Point-of-Care Testing for Preeclampsia Prediction",
  url: "https://innovation.weill.cornell.edu/industry-investors-partners/technology-portfolio/ai-powered-point-care-testing-preeclampsia",
  patentStatus: "PCT filed",
  pmids: ["34290243"],
  ...over,
});

const seed = (rows: unknown[]) => JSON.stringify(rows);

describe("parseSeed", () => {
  it("parses a well-formed row", () => {
    expect(parseSeed(seed([row()]))).toEqual([
      {
        cwid: "zhz9010",
        reference: "11166",
        title: "AI-Powered, Point-of-Care Testing for Preeclampsia Prediction",
        url: row().url,
        patentStatus: "PCT filed",
        pmids: ["34290243"],
        overview: null,
        hasPocData: false,
      },
    ]);
  });

  it("accepts a legacy letter-only cwid and null reference/patentStatus", () => {
    const [parsed] = parseSeed(
      seed([row({ cwid: "cnathan", reference: null, patentStatus: null })]),
    );
    expect(parsed.cwid).toBe("cnathan");
    expect(parsed.reference).toBeNull();
    expect(parsed.patentStatus).toBeNull();
  });

  it("defaults a missing pmids array to empty", () => {
    const r = { ...row() } as Record<string, unknown>;
    delete r.pmids;
    expect(parseSeed(seed([r]))[0].pmids).toEqual([]);
  });

  it("trims the title", () => {
    expect(parseSeed(seed([row({ title: "  Grn(flox)Mouse  " })]))[0].title).toBe("Grn(flox)Mouse");
  });

  // The url becomes an href on a public profile — these are the cases that
  // would turn a corrupted seed into an injected link.
  it.each([
    ["off-site host", "https://evil.example.com/tech/1"],
    ["origin as a prefix of another host", "https://innovation.weill.cornell.edu.evil.com/x"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["protocol-relative", "//innovation.weill.cornell.edu/x"],
    ["plain http", "http://innovation.weill.cornell.edu/x"],
  ])("rejects a url with %s", (_label, url) => {
    expect(() => parseSeed(seed([row({ url })]))).toThrow(/url must start with/);
  });

  // Regression: `<span>9220</span>` reached staging and rendered as escaped tags.
  it.each([["<span>9220</span>"], ["<p><span>11171 </span></p>"], ["<span>7932<br></span>"]])(
    "rejects a reference still containing markup: %s",
    (reference) => {
      expect(() => parseSeed(seed([row({ reference })]))).toThrow(/reference must be plain text/);
    },
  );

  it("accepts a reference that is legitimately prose (two dockets)", () => {
    expect(parseSeed(seed([row({ reference: "3901 and 4055" })]))[0].reference).toBe(
      "3901 and 4055",
    );
  });

  // patentStatus is a chip label from a closed vocabulary. Raw CTL prose must
  // never reach the page.
  it.each(["Provisional filed", "PCT filed", "Application filed", "Issued"])(
    "accepts patentStatus %s",
    (patentStatus) => {
      expect(parseSeed(seed([row({ patentStatus })]))[0].patentStatus).toBe(patentStatus);
    },
  );

  it.each([
    ['US Patent 9,943,506 . "BCL6 inhibitors as anticancer agents." Issued'],
    ["PCT Application Filed"],
    ["issued"],
  ])("rejects un-normalized patentStatus %s", (patentStatus) => {
    expect(() => parseSeed(seed([row({ patentStatus })]))).toThrow(/patentStatus must be one of/);
  });

  // A pmid becomes a pubmed.ncbi.nlm.nih.gov path segment.
  it.each([
    ["a path escape", "12345678/../../etc"],
    ["a non-digit", "abc12345"],
    ["too short", "123"],
    ["a non-string", 34290243],
  ])("rejects a pmid with %s", (_label, pmid) => {
    expect(() => parseSeed(seed([row({ pmids: [pmid] })]))).toThrow(/invalid pmid/);
  });

  it("rejects a non-array pmids", () => {
    expect(() => parseSeed(seed([row({ pmids: "34290243" })]))).toThrow(/pmids must be an array/);
  });

  it("defaults a missing overview to null and hasPocData to false", () => {
    const [parsed] = parseSeed(seed([row()]));
    expect(parsed.overview).toBeNull();
    expect(parsed.hasPocData).toBe(false);
  });

  it("keeps a multi-line overview and the PoC flag", () => {
    const overview = "The Technology: A method\nPoC Data: shown in mouse models";
    const [parsed] = parseSeed(seed([row({ overview, hasPocData: true })]));
    expect(parsed.overview).toBe(overview);
    expect(parsed.hasPocData).toBe(true);
  });

  // Angle brackets are legitimate in overview prose ("LC50 < 50nM") — it renders
  // as React-escaped text, not markup, so it must NOT be rejected like reference.
  it("accepts angle brackets in the overview", () => {
    expect(parseSeed(seed([row({ overview: "Inhibitor with LC50 < 50nM" })]))[0].overview).toBe(
      "Inhibitor with LC50 < 50nM",
    );
  });

  it("rejects a non-string overview", () => {
    expect(() => parseSeed(seed([row({ overview: 42 })]))).toThrow(/overview must be a string/);
  });

  // A NUL byte once made git treat a source file as binary (#1602); it must not
  // reach the DB or a profile either.
  it("rejects control characters in the overview", () => {
    // Build the NUL at runtime — never a literal control byte in source (#1602).
    const overview = "bad" + String.fromCharCode(0) + "byte";
    expect(() => parseSeed(seed([row({ overview })]))).toThrow(
      /overview carries control characters/,
    );
  });

  it("rejects an over-length overview rather than silently storing it", () => {
    expect(() => parseSeed(seed([row({ overview: "x".repeat(8001) })]))).toThrow(
      /overview exceeds 8000 chars/,
    );
  });

  it("rejects a non-boolean hasPocData", () => {
    expect(() => parseSeed(seed([row({ hasPocData: "yes" })]))).toThrow(
      /hasPocData must be a boolean/,
    );
  });

  it.each([
    ["a bad cwid", { cwid: "not a cwid!" }, /invalid cwid/],
    ["an empty title", { title: "   " }, /title is required/],
  ])("rejects %s", (_label, over, re) => {
    expect(() => parseSeed(seed([row(over)]))).toThrow(re);
  });

  it("rejects a duplicate (cwid, url) — it is the table's unique key", () => {
    expect(() => parseSeed(seed([row(), row()]))).toThrow(/duplicate \(cwid, url\)/);
  });

  it("allows the same technology under two PIs, and one PI with two technologies", () => {
    const other =
      "https://innovation.weill.cornell.edu/industry-investors-partners/technology-portfolio/other";
    expect(parseSeed(seed([row(), row({ cwid: "jas2037" }), row({ url: other })]))).toHaveLength(3);
  });

  it("rejects a non-array seed rather than treating it as empty", () => {
    expect(() => parseSeed(seed({} as never))).toThrow(/must be a JSON array/);
  });

  it("parses the checked-in seed", async () => {
    const { readFileSync } = await import("node:fs");
    const rows = parseSeed(readFileSync("etl/technologies/technologies.json", "utf-8"));
    expect(rows.length).toBeGreaterThan(200);
    expect(new Set(rows.map((r) => r.cwid)).size).toBeGreaterThan(100);
    // The regression that shipped to staging: no reference may carry markup.
    expect(rows.filter((r) => r.reference?.includes("<"))).toHaveLength(0);
    expect(rows.some((r) => r.pmids.length > 0)).toBe(true);
    expect(rows.some((r) => r.patentStatus !== null)).toBe(true);
    // The regenerated fixture carries the new overview + PoC data.
    expect(rows.some((r) => r.overview !== null)).toBe(true);
    expect(rows.some((r) => r.hasPocData)).toBe(true);
  });
});
