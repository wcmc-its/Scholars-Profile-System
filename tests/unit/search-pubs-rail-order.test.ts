// The Publications-tab facet rail and its active-filter chips share one order.
// Both live inline in the /search page module, which can only export Next's
// page fields, so this reads the source (as search-links-no-prefetch does)
// rather than rendering it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("app/(public)/search/page.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function between(start: string, end: string, text = src): string {
  const i = text.indexOf(start);
  const j = text.indexOf(end, i + start.length);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return text.slice(i, j);
}

/** Markers in the order they first appear in `block`; every one must be there. */
function order(block: string, markers: Record<string, string>): string[] {
  return Object.entries(markers)
    .map(([name, marker]) => {
      const at = block.indexOf(marker);
      expect(at, `${name} not found`).toBeGreaterThan(-1);
      expect(block.indexOf(marker, at + marker.length), `${name} appears twice`).toBe(-1);
      return { name, at };
    })
    .sort((a, b) => a.at - b.at)
    .map((m) => m.name);
}

const RAIL = [
  "Match quality",
  "Publication type",
  "Year (since)",
  "Translational stage",
  "WCM author role",
  "Authors",
  "Department / division / center",
  "Institution",
  "Journal",
  "Mentoring activity",
];

describe("Publications rail order", () => {
  it("renders the facet groups in the agreed order", () => {
    const rail = between("function FacetSidebarPubs(", "\nfunction FacetGroup(");
    const markers: Record<string, string> = {};
    for (const label of RAIL) markers[label] = `<FacetGroup label="${label}"`;
    // These two render their own heading ("Authors" / "Journal").
    markers["Authors"] = "<AuthorFacet";
    markers["Journal"] = "<JournalFacet";
    expect(order(rail, markers)).toEqual(RAIL);
  });

  it("pushes the active-filter chips in rail order", () => {
    const pubs = between("async function PublicationsResults(", "\nasync function FundingResults(");
    const chips = between("const chips:", "const journalItems", pubs);
    expect(
      order(chips, {
        "Publication type": "if (publicationType) {",
        "Year (since)": "if (yearMin !== undefined || yearMax !== undefined) {",
        "Translational stage": "for (const v of translationalStage) {",
        "WCM author role": "for (const v of wcmAuthorRole) {",
        Authors: "for (const v of wcmAuthor) {",
        "Department / division / center": "for (const v of department) {",
        Institution: "for (const v of institution) {",
        Journal: "for (const v of journal) {",
        "Mentoring activity": "for (const v of mentoringProgram) {",
      }),
      // Match quality (MeSH-only) has no chip; its "Remove filter" is in the count line.
    ).toEqual(RAIL.filter((l) => l !== "Match quality"));
  });
});
