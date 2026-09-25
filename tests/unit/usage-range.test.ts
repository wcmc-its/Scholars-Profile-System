import { describe, expect, it } from "vitest";

import {
  USAGE_LAUNCH_DATE,
  addDays,
  isRealIsoDate,
  resolveUsageRange,
  usageRangeHref,
} from "@/lib/api/usage-range";

const TODAY = "2026-09-25";

describe("resolveUsageRange", () => {
  it("defaults to the 30 complete days before today", () => {
    const r = resolveUsageRange({}, TODAY);
    expect(r).toEqual({
      key: "30",
      since: "2026-08-26",
      until: "2026-09-24",
      days: 30,
      label: "Last 30 days",
    });
  });

  it("resolves the fixed ranges, each ending yesterday", () => {
    expect(resolveUsageRange({ range: "7" }, TODAY)).toMatchObject({
      key: "7",
      since: "2026-09-18",
      until: "2026-09-24",
      days: 7,
    });
    expect(resolveUsageRange({ range: "90" }, TODAY)).toMatchObject({
      key: "90",
      since: "2026-06-27",
      days: 90,
    });
    expect(resolveUsageRange({ range: "launch" }, TODAY)).toMatchObject({
      key: "launch",
      since: USAGE_LAUNCH_DATE,
      until: "2026-09-24",
      label: "Since launch",
    });
  });

  it("falls back to the default for an unknown range", () => {
    expect(resolveUsageRange({ range: "365" }, TODAY).key).toBe("30");
    expect(resolveUsageRange({ range: ["7", "90"] }, TODAY).key).toBe("7");
  });

  it("accepts a custom range, swapping a backwards one and clamping to yesterday", () => {
    expect(
      resolveUsageRange({ range: "custom", from: "2026-08-01", to: "2026-08-15" }, TODAY),
    ).toEqual({
      key: "custom",
      since: "2026-08-01",
      until: "2026-08-15",
      days: 15,
      label: "Custom range",
    });
    expect(
      resolveUsageRange({ range: "custom", from: "2026-08-15", to: "2026-08-01" }, TODAY),
    ).toMatchObject({ since: "2026-08-01", until: "2026-08-15" });
    expect(
      resolveUsageRange({ range: "custom", from: "2026-09-01", to: "2026-12-31" }, TODAY),
    ).toMatchObject({ since: "2026-09-01", until: "2026-09-24" });
    // Entirely in the future collapses to the single last complete day.
    expect(
      resolveUsageRange({ range: "custom", from: "2026-10-01", to: "2026-10-05" }, TODAY),
    ).toMatchObject({ since: "2026-09-24", until: "2026-09-24", days: 1 });
  });

  it("rejects a malformed or impossible custom date (SQL-injection shape included)", () => {
    for (const from of ["2026-02-30", "2026-8-1", "2026-08-01'; DROP", ""]) {
      expect(resolveUsageRange({ range: "custom", from, to: "2026-08-15" }, TODAY).key).toBe("30");
    }
    expect(resolveUsageRange({ range: "custom", from: "2026-08-01" }, TODAY).key).toBe("30");
  });

  it("degrades 'since launch' when the clock is before launch", () => {
    expect(resolveUsageRange({ range: "launch" }, "2026-06-10")).toMatchObject({
      since: "2026-06-09",
      until: "2026-06-09",
    });
  });
});

describe("usage-range helpers", () => {
  it("validates real ISO dates and shifts days across month ends", () => {
    expect(isRealIsoDate("2026-02-28")).toBe(true);
    expect(isRealIsoDate("2026-02-29")).toBe(false);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("builds hrefs, with the default range on the bare path", () => {
    expect(usageRangeHref("30")).toBe("/edit/usage");
    expect(usageRangeHref("7")).toBe("/edit/usage?range=7");
    expect(usageRangeHref("launch")).toBe("/edit/usage?range=launch");
    expect(usageRangeHref("custom", "2026-08-01", "2026-08-15")).toBe(
      "/edit/usage?range=custom&from=2026-08-01&to=2026-08-15",
    );
  });
});
