import { describe, expect, it } from "vitest";
import { deriveSlug, looksLikeSlug, nextAvailableSlug } from "@/lib/slug";

describe("deriveSlug", () => {
  it("handles plain ASCII names", () => {
    expect(deriveSlug("Jane Smith")).toBe("jane-smith");
    expect(deriveSlug("John Doe")).toBe("john-doe");
  });

  it("strips diacritics via NFKD", () => {
    expect(deriveSlug("María José García-López")).toBe("maria-jose-garcia-lopez");
    expect(deriveSlug("François Müller")).toBe("francois-muller");
    expect(deriveSlug("Søren Kierkegaard")).toBe("soren-kierkegaard");
  });

  it("drops apostrophes and other punctuation", () => {
    expect(deriveSlug("Mary-Anne O'Brien")).toBe("mary-anne-obrien");
    expect(deriveSlug("Q. Smith Jr.")).toBe("q-smith-jr");
    expect(deriveSlug("Dr. Jane Smith, MD")).toBe("dr-jane-smith-md");
  });

  it("collapses whitespace and trims hyphens", () => {
    expect(deriveSlug("  Jane   Smith  ")).toBe("jane-smith");
    expect(deriveSlug("---Jane---Smith---")).toBe("jane-smith");
    expect(deriveSlug("Jane\tSmith")).toBe("jane-smith");
  });

  it("returns empty string for empty input", () => {
    expect(deriveSlug("")).toBe("");
  });

  it("returns empty string for non-Latin scripts (rely on ED romanization)", () => {
    expect(deriveSlug("李明")).toBe("");
    expect(deriveSlug("田中太郎")).toBe("");
  });

  it("preserves mid-name digits if any", () => {
    expect(deriveSlug("Jane Smith 3rd")).toBe("jane-smith-3rd");
  });
});

describe("nextAvailableSlug", () => {
  it("returns the base when uncontested", () => {
    expect(nextAvailableSlug("jane-smith", new Set())).toBe("jane-smith");
  });

  it("appends -2 on first collision", () => {
    expect(nextAvailableSlug("jane-smith", new Set(["jane-smith"]))).toBe("jane-smith-2");
  });

  it("counts up through suffixed collisions", () => {
    expect(
      nextAvailableSlug("jane-smith", new Set(["jane-smith", "jane-smith-2"])),
    ).toBe("jane-smith-3");
    expect(
      nextAvailableSlug(
        "jane-smith",
        new Set(["jane-smith", "jane-smith-2", "jane-smith-3", "jane-smith-4"]),
      ),
    ).toBe("jane-smith-5");
  });

  it("does not rename established profiles when a new arrival collides", () => {
    const taken = new Set(["jane-smith"]);
    const newSlug = nextAvailableSlug("jane-smith", taken);
    expect(newSlug).toBe("jane-smith-2");
    expect(taken.has("jane-smith")).toBe(true); // unchanged
  });
});

describe("looksLikeSlug", () => {
  it("recognizes hyphenated slugs", () => {
    expect(looksLikeSlug("jane-smith")).toBe(true);
    expect(looksLikeSlug("maria-jose-garcia-lopez")).toBe(true);
  });

  it("recognizes single-word lowercase slugs", () => {
    expect(looksLikeSlug("madonna")).toBe(true);
  });

  it("rejects typical CWID shapes", () => {
    expect(looksLikeSlug("abc1234")).toBe(false);
    expect(looksLikeSlug("jds9001")).toBe(false);
  });
});
