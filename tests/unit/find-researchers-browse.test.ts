import { describe, expect, it } from "vitest";

import { EMPTY_BROWSE_FILTERS, matchesBrowseFilters } from "@/components/edit/find-researchers";

const now = Date.parse("2026-07-06T12:00:00Z");

function opp(over: Record<string, unknown> = {}) {
  return {
    opportunityId: "X-1",
    title: "Cancer Research Grants",
    sponsor: "Skin Cancer Foundation",
    mechanism: "R01",
    dueDate: "2026-07-19T00:00:00.000Z",
    source: "wcm_curated",
    status: "open",
    ...over,
  };
}

describe("matchesBrowseFilters", () => {
  it("matches everything with empty filters", () => {
    expect(matchesBrowseFilters(opp(), EMPTY_BROWSE_FILTERS, now)).toBe(true);
    expect(
      matchesBrowseFilters(opp({ dueDate: null, sponsor: null }), EMPTY_BROWSE_FILTERS, now),
    ).toBe(true);
  });

  it("matches the query against title or sponsor, case-insensitively", () => {
    const f = { ...EMPTY_BROWSE_FILTERS, q: "skin cancer" };
    expect(matchesBrowseFilters(opp(), f, now)).toBe(true); // sponsor hit
    expect(matchesBrowseFilters(opp({ sponsor: null }), f, now)).toBe(false);
    expect(matchesBrowseFilters(opp(), { ...EMPTY_BROWSE_FILTERS, q: "RESEARCH" }, now)).toBe(true);
  });

  it("openOnly drops passed deadlines but keeps undated and future ones", () => {
    const f = { ...EMPTY_BROWSE_FILTERS, openOnly: true };
    expect(matchesBrowseFilters(opp({ dueDate: "2026-06-01T00:00:00Z" }), f, now)).toBe(false);
    expect(matchesBrowseFilters(opp({ dueDate: null }), f, now)).toBe(true);
    expect(matchesBrowseFilters(opp(), f, now)).toBe(true);
  });

  it("applies the due-date range with inclusive bounds; a set range only matches dated rows", () => {
    const f = { ...EMPTY_BROWSE_FILTERS, dueFrom: "2026-07-19", dueTo: "2026-07-19" };
    expect(matchesBrowseFilters(opp(), f, now)).toBe(true);
    expect(matchesBrowseFilters(opp({ dueDate: null }), f, now)).toBe(false);
    expect(
      matchesBrowseFilters(opp(), { ...EMPTY_BROWSE_FILTERS, dueFrom: "2026-07-20" }, now),
    ).toBe(false);
    expect(matchesBrowseFilters(opp(), { ...EMPTY_BROWSE_FILTERS, dueTo: "2026-07-18" }, now)).toBe(
      false,
    );
  });

  it("ORs within a checkbox group and ANDs across groups", () => {
    const sponsors = new Set(["Skin Cancer Foundation", "NIH NLM"]);
    expect(matchesBrowseFilters(opp(), { ...EMPTY_BROWSE_FILTERS, sponsors }, now)).toBe(true);
    expect(
      matchesBrowseFilters(opp(), { ...EMPTY_BROWSE_FILTERS, sponsors: new Set(["AHRQ"]) }, now),
    ).toBe(false);
    expect(
      matchesBrowseFilters(
        opp(),
        { ...EMPTY_BROWSE_FILTERS, sponsors, mechanisms: new Set(["U01"]) },
        now,
      ),
    ).toBe(false);
  });

  it("skip omits one group's own selections (facet counts)", () => {
    const f = { ...EMPTY_BROWSE_FILTERS, sponsors: new Set(["AHRQ"]) };
    expect(matchesBrowseFilters(opp(), f, now, "sponsors")).toBe(true);
    expect(matchesBrowseFilters(opp(), f, now, "mechanisms")).toBe(false);
  });
});
