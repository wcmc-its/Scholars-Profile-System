import { describe, expect, it } from "vitest";
import { authorityBadgeLabel, toPolicyRollup } from "@/lib/citations/policy-rollup";

describe("policy rollup", () => {
  it("is null when nothing cites the paper", () => {
    expect(toPolicyRollup({ authorityBodies: null, guidelineCount: 0, reviewCount: 0 })).toBeNull();
  });

  it("keeps well-formed authority bodies and drops anything else", () => {
    expect(
      toPolicyRollup({
        authorityBodies: [{ body: "WHO", count: 4 }, { body: "NICE" }, "junk", null],
        guidelineCount: 9,
        reviewCount: 6,
      }),
    ).toEqual({ authority: [{ body: "WHO", count: 4 }], guidelines: 9, reviews: 6 });
  });

  it("labels badges by body and count", () => {
    expect(authorityBadgeLabel("WHO", 4)).toBe("Cited in 4 WHO guidelines");
    expect(authorityBadgeLabel("National Academies", 1)).toBe("National Academies report");
  });
});
