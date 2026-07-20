import { describe, expect, it } from "vitest";

import {
  EMPTY_BROWSE_FILTERS,
  deadlineLabel,
  matchesBrowseFilters,
  stripSponsorPrefix,
} from "@/components/edit/find-researchers";

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

/**
 * Sponsor now has its own column, so a title that restates it prints the
 * sponsor twice in one row. The helper strips that prefix — but only on an
 * unambiguous match, because a mangled title is worse than a repeated one.
 */
describe("stripSponsorPrefix", () => {
  it("strips the sponsor when it prefixes the title with a separator", () => {
    expect(
      stripSponsorPrefix(
        "National Institutes of Health (NIH) - NIH Outstanding New Environmental Scientist (ONES) Award (R01)",
        "National Institutes of Health (NIH)",
      ),
    ).toBe("NIH Outstanding New Environmental Scientist (ONES) Award (R01)");
  });

  it("also matches the sponsor minus its parenthetical, or the parenthetical alone", () => {
    const sponsor = "National Institutes of Health (NIH)";
    expect(stripSponsorPrefix("National Institutes of Health — Pioneer Award", sponsor)).toBe(
      "Pioneer Award",
    );
    expect(stripSponsorPrefix("NIH: Pioneer Award", sponsor)).toBe("Pioneer Award");
  });

  it("is case-insensitive and tolerates spacing around the separator", () => {
    expect(stripSponsorPrefix("aHrQ  |  Patient Safety Grants", "AHRQ")).toBe(
      "Patient Safety Grants",
    );
  });

  it("leaves the title alone when the sponsor name is part of the award's name", () => {
    // No separator: "Skin Cancer Foundation" is genuinely part of the title.
    const t = "Skin Cancer Foundation Research Grants";
    expect(stripSponsorPrefix(t, "Skin Cancer Foundation")).toBe(t);
    // A hyphen with no whitespace on either side is a compound word, not a join.
    expect(stripSponsorPrefix("NIH-funded Career Award", "NIH")).toBe("NIH-funded Career Award");
  });

  it("never strips down to nothing, and never touches a non-matching title", () => {
    expect(stripSponsorPrefix("NIH - X", "NIH")).toBe("NIH - X"); // remainder too short
    expect(stripSponsorPrefix("NIH", "NIH")).toBe("NIH"); // title IS the sponsor
    expect(stripSponsorPrefix("Pioneer Award", "NIH")).toBe("Pioneer Award");
  });

  it("passes through null/empty inputs untouched", () => {
    expect(stripSponsorPrefix(null, "NIH")).toBeNull();
    expect(stripSponsorPrefix("NIH - Pioneer Award", null)).toBe("NIH - Pioneer Award");
    expect(stripSponsorPrefix("NIH - Pioneer Award", "  ")).toBe("NIH - Pioneer Award");
  });
});

/**
 * The Deadline column. `dueDate` is nullable and the model has no rolling flag,
 * so only `status = "continuous"` licenses the word "Rolling"; a dateless
 * forecast is a date not yet announced (#1608), and anything else dateless is
 * genuinely unknown.
 */
describe("deadlineLabel", () => {
  it("formats a dated deadline, flagging one that has passed", () => {
    expect(deadlineLabel("2026-07-19T00:00:00.000Z", "open", now)).toBe("Jul 19, 2026");
    expect(deadlineLabel("2026-06-01T00:00:00.000Z", "open", now)).toBe("Jun 1, 2026 (passed)");
  });

  it("only says Rolling for a continuous status", () => {
    expect(deadlineLabel(null, "continuous", now)).toBe("Rolling");
    expect(deadlineLabel(null, "CONTINUOUS", now)).toBe("Rolling");
  });

  it("a dateless forecast is a date TBD, not a rolling deadline (#1608)", () => {
    expect(deadlineLabel(null, "forecasted", now)).toBe("Date TBD");
  });

  it("falls back to an em dash when nothing in the model says it rolls", () => {
    expect(deadlineLabel(null, "open", now)).toBe("—");
    expect(deadlineLabel(null, null, now)).toBe("—");
    expect(deadlineLabel("not-a-date", "open", now)).toBe("—");
  });
});
