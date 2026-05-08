import { describe, expect, it } from "vitest";
import {
  expandSponsor,
  getSponsor,
  listSponsors,
} from "@/lib/sponsor-lookup";

describe("getSponsor", () => {
  it("resolves NIH IC short names", () => {
    expect(getSponsor("NCI")?.full).toBe("National Cancer Institute");
    expect(getSponsor("NINDS")?.full).toBe(
      "National Institute of Neurological Disorders and Stroke",
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(getSponsor("nci")?.short).toBe("NCI");
    expect(getSponsor("  NCI  ")?.short).toBe("NCI");
  });

  it("resolves aliases to the canonical record", () => {
    expect(getSponsor("Bristol-Myers Squibb")?.short).toBe("BMS");
    expect(getSponsor("Bristol Myers Squibb")?.short).toBe("BMS");
    expect(getSponsor("Bill & Melinda Gates Foundation")?.short).toBe(
      "Gates Foundation",
    );
  });

  it("returns null for unknown sponsors", () => {
    expect(getSponsor("Some Unknown Foundation")).toBeNull();
    expect(getSponsor("")).toBeNull();
    expect(getSponsor(null)).toBeNull();
    expect(getSponsor(undefined)).toBeNull();
  });

  it("populates the category for each canonical record", () => {
    expect(getSponsor("NCI")?.category).toBe("NIH IC");
    expect(getSponsor("NSF")?.category).toBe("Federal");
    expect(getSponsor("OCRA")?.category).toBe("Foundation");
    expect(getSponsor("AstraZeneca")?.category).toBe("Industry");
  });
});

describe("expandSponsor", () => {
  it("returns the full name when the short is known", () => {
    expect(expandSponsor("NCI")).toBe("National Cancer Institute");
    expect(expandSponsor("OCRA")).toBe("Ovarian Cancer Research Alliance");
  });

  it("returns null when the short is unknown", () => {
    expect(expandSponsor("XYZ")).toBeNull();
  });
});

describe("listSponsors", () => {
  it("includes the 27 NIH ICs and at least one of each other category", () => {
    const all = listSponsors();
    const counts = all.reduce<Record<string, number>>((acc, s) => {
      acc[s.category] = (acc[s.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["NIH IC"]).toBeGreaterThanOrEqual(25);
    expect(counts["Federal"]).toBeGreaterThan(0);
    expect(counts["Foundation"]).toBeGreaterThan(0);
    expect(counts["Industry"]).toBeGreaterThan(0);
  });

  it("has unique short names across the canonical set", () => {
    const shorts = listSponsors().map((s) => s.short.toLowerCase());
    const dupes = shorts.filter((s, i) => shorts.indexOf(s) !== i);
    expect(dupes).toEqual([]);
  });
});
