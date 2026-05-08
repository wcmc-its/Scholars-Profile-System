import { describe, expect, it } from "vitest";
import { isFundingActive } from "@/lib/api/profile";

const day = (iso: string) => new Date(iso);
const NOW = day("2026-05-08T00:00:00.000Z");

describe("isFundingActive", () => {
  it("returns true when end date is in the future", () => {
    expect(isFundingActive(day("2027-01-01"), NOW)).toBe(true);
  });

  it("returns true exactly at end date (start of NCE window)", () => {
    expect(isFundingActive(day("2026-05-08T00:00:00.000Z"), NOW)).toBe(true);
  });

  it("returns true 11 months past end date (within NCE grace)", () => {
    expect(isFundingActive(day("2025-07-01"), NOW)).toBe(true);
  });

  it("returns false 13 months past end date (outside NCE grace)", () => {
    expect(isFundingActive(day("2025-04-01"), NOW)).toBe(false);
  });

  it("returns false for grants ended years ago", () => {
    expect(isFundingActive(day("2020-01-01"), NOW)).toBe(false);
  });
});
