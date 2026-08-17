import { describe, expect, it } from "vitest";

import { parseDataSharingParams } from "@/lib/edit/data-sharing-dashboard";

describe("parseDataSharingParams", () => {
  it("defaults to no filters, desc sort direction, and page 1 on an empty query", () => {
    expect(parseDataSharingParams({})).toEqual({
      filters: { yearFrom: undefined, yearTo: undefined, tiers: undefined, nihFunded: undefined },
      deptSort: undefined,
      deptDir: "desc",
      facSort: undefined,
      facDir: "desc",
      facPage: 1,
    });
  });

  it("parses yearFrom/yearTo as numbers, ignoring non-numeric junk", () => {
    expect(parseDataSharingParams({ yearFrom: "2020", yearTo: "not-a-year" }).filters).toEqual({
      yearFrom: 2020,
      yearTo: undefined,
      tiers: undefined,
      nihFunded: undefined,
    });
  });

  it("parses nihFunded as a tri-state boolean, ignoring anything else", () => {
    expect(parseDataSharingParams({ nihFunded: "true" }).filters.nihFunded).toBe(true);
    expect(parseDataSharingParams({ nihFunded: "false" }).filters.nihFunded).toBe(false);
    expect(parseDataSharingParams({ nihFunded: "" }).filters.nihFunded).toBeUndefined();
    expect(parseDataSharingParams({ nihFunded: "garbage" }).filters.nihFunded).toBeUndefined();
    expect(parseDataSharingParams({}).filters.nihFunded).toBeUndefined();
  });

  it("nihFunded takes the first entry when passed as an array, same convention as sort direction", () => {
    expect(parseDataSharingParams({ nihFunded: ["true", "false"] }).filters.nihFunded).toBe(true);
  });

  it("collects a single tier= into a one-element array, multiple into all of them", () => {
    expect(parseDataSharingParams({ tier: "US_OPEN" }).filters.tiers).toEqual(["US_OPEN"]);
    expect(parseDataSharingParams({ tier: ["US_OPEN", "CONCERN"] }).filters.tiers).toEqual([
      "US_OPEN",
      "CONCERN",
    ]);
  });

  it("rejects an unknown sort key rather than passing it through", () => {
    const parsed = parseDataSharingParams({ deptSort: "not-a-real-key", facSort: "concerning" });
    expect(parsed.deptSort).toBeUndefined();
    expect(parsed.facSort).toBe("concerning");
  });

  it("parses sort direction, defaulting anything but 'asc' to 'desc'", () => {
    expect(parseDataSharingParams({ deptDir: "asc" }).deptDir).toBe("asc");
    expect(parseDataSharingParams({ deptDir: "garbage" }).deptDir).toBe("desc");
  });

  it("clamps facPage to >= 1, floors a fractional value, ignores non-numeric input", () => {
    expect(parseDataSharingParams({ facPage: "0" }).facPage).toBe(1);
    expect(parseDataSharingParams({ facPage: "-3" }).facPage).toBe(1);
    expect(parseDataSharingParams({ facPage: "2.9" }).facPage).toBe(2);
    expect(parseDataSharingParams({ facPage: "nope" }).facPage).toBe(1);
  });
});
