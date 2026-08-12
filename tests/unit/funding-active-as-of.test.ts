import { describe, expect, it } from "vitest";
import { isFundingActiveAsOf } from "@/lib/funding-active";

const day = (iso: string) => new Date(iso);

describe("isFundingActiveAsOf", () => {
  it("returns false before the start date, even with a far-future end date", () => {
    const grant = { startDate: day("2027-01-01"), endDate: day("2030-01-01") };
    expect(isFundingActiveAsOf(grant, day("2026-06-01"))).toBe(false);
  });

  it("returns true exactly on the start date (boundary)", () => {
    const grant = { startDate: day("2026-06-01"), endDate: day("2027-01-01") };
    expect(isFundingActiveAsOf(grant, day("2026-06-01"))).toBe(true);
  });

  it("returns true within the grant's active range", () => {
    const grant = { startDate: day("2025-01-01"), endDate: day("2027-01-01") };
    expect(isFundingActiveAsOf(grant, day("2026-06-01"))).toBe(true);
  });

  it("returns true exactly on the end date (boundary — start of the NCE grace window)", () => {
    const grant = { startDate: day("2025-01-01"), endDate: day("2026-06-01") };
    expect(isFundingActiveAsOf(grant, day("2026-06-01"))).toBe(true);
  });

  it("returns true within the NCE grace window past the end date", () => {
    const grant = { startDate: day("2020-01-01"), endDate: day("2025-07-01") };
    expect(isFundingActiveAsOf(grant, day("2026-05-08"))).toBe(true); // ~10 months past end
  });

  it("returns false past the NCE grace window", () => {
    const grant = { startDate: day("2020-01-01"), endDate: day("2025-04-01") };
    expect(isFundingActiveAsOf(grant, day("2026-05-08"))).toBe(false); // >12 months past end
  });
});
