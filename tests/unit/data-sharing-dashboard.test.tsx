import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DataSharingDashboard } from "@/components/edit/data-sharing-dashboard";
import { buildDataSharingReport, type DatasetLinkRow } from "@/lib/api/data-sharing-report";

/** 30 faculty, one open GEO dataset + one citing pub each — enough rows to
 *  trip the 25-row Named-faculty cap, and real pmids so `pubsByTier` (and
 *  the spectrum bar built from it) is non-zero. */
const ROWS: DatasetLinkRow[] = Array.from({ length: 30 }, (_, i) => ({
  cwid: `cwid${i}`,
  scholarName: `Faculty ${i}`,
  scholarSlug: `faculty-${i}`,
  department: "Medicine",
  datasetId: `d${i}`,
  repository: "GEO",
  accessModel: "open",
  pmids: [`p${i}`],
}));

const report = { ...buildDataSharingReport(ROWS), dataAsOf: null };

describe("DataSharingDashboard — 08-16 mockup design pass", () => {
  it("caps Named faculty at 25 rows with a '+N more' CSV-export pointer", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    // 30 faculty in the report; only the top 25 render in §4.
    expect(container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(25);
    expect(screen.getByText(/\+ 5 more — full list in the/)).toBeTruthy();
  });

  it("renders the tier spectrum legend with counts and per-repo chips", () => {
    render(<DataSharingDashboard report={report} />);
    // Legend entry: swatch + label + count (30 distinct citing pubs, all GEO
    // → US_OPEN). The label also appears in the tier/repo tables, so scope
    // the assertion to the count sitting next to a legend label.
    expect(screen.getAllByText("US-hosted, open").length).toBeGreaterThan(0);
    expect(screen.getByText("30", { selector: "span.font-semibold" })).toBeTruthy();
    // Tier-table repo chips carry per-repo counts, not bare names.
    expect(screen.getByText(/GEO 30/)).toBeTruthy();
  });

  it("08-16 follow-ups: per-table downloads, Methods trigger, PMID links, no access pills", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    // One per-section CSV link per aggregate table.
    const sectionLinks = [...container.querySelectorAll('a[href*="section="]')].map((a) =>
      a.getAttribute("href"),
    );
    // No "subtypes" here: §5 hides itself when bySubtype is empty (this
    // fixture has no sensitive subtypes), taking its download link with it.
    for (const s of ["tiers", "repositories", "departments", "faculty"]) {
      expect(sectionLinks.some((h) => h?.endsWith(`section=${s}`))).toBe(true);
    }
    // Methods dialog trigger present.
    expect(screen.getByRole("button", { name: "Methods" })).toBeTruthy();
    // Recent activity links each citing PMID out to PubMed.
    expect(
      container.querySelector('a[href="https://pubmed.ncbi.nlm.nih.gov/p0/"]'),
    ).toBeTruthy();
    // Access model renders as plain text, not a filled Badge pill.
    expect(container.querySelector("td [data-slot='badge']")).toBeNull();
  });
});
