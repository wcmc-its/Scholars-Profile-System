import { describe, expect, it } from "vitest";
import { trainingYearRange } from "@/lib/training-years";

describe("trainingYearRange", () => {
  it("formats spans, single years and blanks", () => {
    expect(trainingYearRange(2018, 2021)).toBe("2018–2021");
    expect(trainingYearRange(2018, 2018)).toBe("2018");
    expect(trainingYearRange(null, 2021)).toBe("2021");
    expect(trainingYearRange(2018, null)).toBe("2018");
    expect(trainingYearRange(null, null)).toBe("");
  });
});
