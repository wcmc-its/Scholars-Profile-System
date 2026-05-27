import { describe, expect, it, vi } from "vitest";
import {
  deriveSlug,
  looksLikeSlug,
  nextAvailableSlug,
  reconcileScholarSlug,
  RESERVED_SLUGS,
} from "@/lib/slug";

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

  it("takes the numeric floor when a derived slug lands on a reserved word (#497 §6.1)", () => {
    // No collision in `taken`, but the bare slug would shadow a route word.
    expect(nextAvailableSlug("about", new Set())).toBe("about-2");
    expect(nextAvailableSlug("search", new Set())).toBe("search-2");
    // ...and still counts past an already-taken floor.
    expect(nextAvailableSlug("about", new Set(["about-2"]))).toBe("about-3");
  });

  it("leaves a non-reserved base unchanged", () => {
    expect(nextAvailableSlug("jane-about-smith", new Set())).toBe("jane-about-smith");
  });
});

describe("RESERVED_SLUGS (#497 §6.1)", () => {
  it("contains the route words and the legacy by-cwid segment", () => {
    for (const w of ["about", "search", "api", "edit", "scholars", "by-cwid", "_next"]) {
      expect(RESERVED_SLUGS.has(w)).toBe(true);
    }
  });

  it("does not contain a normal name slug", () => {
    expect(RESERVED_SLUGS.has("jane-smith")).toBe(false);
  });
});

describe("reconcileScholarSlug (#497 §5.1 — Option B shared helper)", () => {
  function tx(opts: { current: string | null }) {
    return {
      scholar: {
        findUnique: vi.fn().mockResolvedValue(opts.current === null ? null : { slug: opts.current }),
        update: vi.fn().mockResolvedValue({}),
      },
      slugHistory: { upsert: vi.fn().mockResolvedValue({}) },
    };
  }

  it("upserts slug_history and sets Scholar.slug when the slug changes", async () => {
    const t = tx({ current: "brandon-swed-2" });
    const changed = await reconcileScholarSlug(t as never, "cwid1", "brandon-swed");
    expect(changed).toBe(true);
    expect(t.slugHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { oldSlug: "brandon-swed-2" },
        create: { oldSlug: "brandon-swed-2", currentCwid: "cwid1" },
      }),
    );
    expect(t.scholar.update).toHaveBeenCalledWith({
      where: { cwid: "cwid1" },
      data: { slug: "brandon-swed" },
    });
  });

  it("is a no-op when the slug is unchanged (no history, no update)", async () => {
    const t = tx({ current: "brandon-swed" });
    const changed = await reconcileScholarSlug(t as never, "cwid1", "brandon-swed");
    expect(changed).toBe(false);
    expect(t.slugHistory.upsert).not.toHaveBeenCalled();
    expect(t.scholar.update).not.toHaveBeenCalled();
  });

  it("is a no-op when no scholar row exists (override pinned ahead of the ED record)", async () => {
    const t = tx({ current: null });
    const changed = await reconcileScholarSlug(t as never, "ghost", "some-slug");
    expect(changed).toBe(false);
    expect(t.slugHistory.upsert).not.toHaveBeenCalled();
    expect(t.scholar.update).not.toHaveBeenCalled();
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
