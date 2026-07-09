/**
 * Tests for parseSeed (etl/technologies/seed.ts) — the validator standing
 * between CTL's scraped portfolio and an `href` on a public profile.
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
      },
    ]);
  });

  it("accepts a legacy letter-only cwid and a null reference", () => {
    const [parsed] = parseSeed(seed([row({ cwid: "cnathan", reference: null })]));
    expect(parsed.cwid).toBe("cnathan");
    expect(parsed.reference).toBeNull();
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

  it.each([
    ["a bad cwid", { cwid: "not a cwid!" }, /invalid cwid/],
    ["an empty title", { title: "   " }, /title is required/],
    ["a non-string reference", { reference: 11166 }, /reference must be/],
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
  });
});
