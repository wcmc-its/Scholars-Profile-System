import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DataSharingDashboard } from "@/components/edit/data-sharing-dashboard";
import {
  buildDataSharingReport,
  type DatasetLinkRow,
  type ShareRateCorpusRow,
} from "@/lib/api/data-sharing-report";

/** 30 faculty, one open GEO dataset + one citing pub each — enough rows to
 *  trip the 25-row Named-faculty cap, and real pmids so `pubsByTier` (and
 *  the spectrum bar built from it) is non-zero. `accessionOrDoi`/`title`
 *  added in the v3 pass for the §6 Accession/Title columns; deliberately NO
 *  `sensitiveSubtypes` so §5 stays hidden (its own hide-when-empty branch is
 *  asserted below). */
const ROWS: DatasetLinkRow[] = Array.from({ length: 30 }, (_, i) => ({
  cwid: `cwid${i}`,
  scholarName: `Faculty ${i}`,
  scholarSlug: `faculty-${i}`,
  department: "Medicine",
  datasetId: `d${i}`,
  repository: "GEO",
  accessModel: "open",
  accessionOrDoi: `GSE${100 + i}`,
  title: `Fake dataset ${i}`,
  pmids: [`p${i}`],
}));

/** Share-rate corpus matching the fixture 1:1 — every citing pub is a
 *  confirmed first/last-authored pub IN PMC, so the share-rate card, the "In
 *  PMC" card, and the "PMC-covered share rate" card all read 30/30 (100%). */
const CORPUS: ShareRateCorpusRow[] = Array.from({ length: 30 }, (_, i) => ({
  pmid: `p${i}`,
  cwid: `cwid${i}`,
  department: "Medicine",
  inPmc: true,
}));

const report = { ...buildDataSharingReport(ROWS, CORPUS), dataAsOf: null };

describe("DataSharingDashboard — 08-16 mockup design pass", () => {
  it("caps Named faculty at 25 rows with a '+N more' CSV-export pointer", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    // 30 faculty in the report; only the top 25 render in §4.
    expect(container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(25);
    expect(screen.getByText(/\+ 5 more — full list in the/)).toBeTruthy();
  });

  it("renders the tier spectrum legend with counts and per-repo chips", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    // Legend entry: swatch + label + count (30 distinct citing pubs, all GEO
    // → US_OPEN). The label also appears in the tier/repo tables, so scope
    // the assertion to the count sitting next to a legend label.
    expect(screen.getAllByText("US-hosted, open").length).toBeGreaterThan(0);
    expect(screen.getByText("30", { selector: "span.font-semibold" })).toBeTruthy();
    // Tier-table repo chips carry per-repo counts next to an outbound repo
    // link (v3 — the name links out via urlOf, the count stays outside).
    const tierTable = container.querySelectorAll("#repos table")[0];
    const chipLink = tierTable.querySelector('a[href="https://www.ncbi.nlm.nih.gov/geo/"]');
    expect(chipLink).toBeTruthy();
    expect(chipLink?.closest("span")?.parentElement?.textContent).toContain("30");
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

describe("DataSharingDashboard — v3 stakeholder pass", () => {
  it("renders the two PMC coverage stat cards", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    expect(screen.getByText("In PMC")).toBeTruthy();
    expect(screen.getByText("PMC-covered share rate")).toBeTruthy();
    // Fixture is fully PMC-covered and fully deposited, so within §1 the
    // original share-rate card AND both PMC cards read the same n/N — three
    // in total (the Medicine department row repeats it outside §1).
    const rollupValues = [...container.querySelectorAll("#rollup .text-2xl")].filter(
      (el) => el.textContent === "30/30 (100%)",
    );
    expect(rollupValues).toHaveLength(3);
  });

  it("renders zero-count tier rows as a statement, not an absence", () => {
    render(<DataSharingDashboard report={report} />);
    // All data is GEO → US_OPEN; the other five real tiers still get a row
    // each (report-side zero padding), with a muted "none detected"
    // Repositories cell instead of vanishing.
    expect(screen.getAllByText("none detected")).toHaveLength(5);
    // The Country of concern row at 0 is the deliberate statement — its
    // label renders in the tier table (chip) and the spectrum legend.
    expect(screen.getAllByText("Country of concern").length).toBeGreaterThan(0);
  });

  it("adds a Download items CSV drill-down link per aggregate table", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const s of ["repositories", "departments", "faculty"]) {
      expect(hrefs).toContain(`/edit/data-sharing/export?section=${s}&grain=items`);
    }
    // §5 is hidden on this fixture, so no subtypes links of either grain —
    // and tiers has no items grain at all (the route 400s it).
    expect(hrefs.some((h) => h?.includes("section=subtypes"))).toBe(false);
    expect(hrefs.some((h) => h?.includes("section=tiers&grain=items"))).toBe(false);
  });

  it("deep-links §6 accessions via resolveDatasetUrl, with Title/Type/Sub-types columns", () => {
    const { container } = render(<DataSharingDashboard report={report} />);
    // GSE100 (row i=0, within the 25-row recent slice) links to its GEO
    // record, not just the repository homepage.
    expect(
      container.querySelector(
        '#recent a[href="https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE100"]',
      ),
    ).toBeTruthy();
    for (const h of ["Accession", "Title", "Type", "Sub-types"]) {
      expect(screen.getByText(h, { selector: "th" })).toBeTruthy();
    }
    // Title renders on its own (no accession fallback — accession is now the
    // adjacent column).
    expect(screen.getByText("Fake dataset 0")).toBeTruthy();
  });

  it("renders §7 Compliance view: one real number, three placeholder cards, framing caveat", () => {
    render(<DataSharingDashboard report={report} />);
    expect(screen.getByText("7 · Compliance view")).toBeTruthy();
    expect(screen.getByText("Concerning deposit instances")).toBeTruthy();
    // The three COC-coauthor cards ship before their data exists, "—" with a
    // shared pending sublabel.
    expect(
      screen.getAllByText("requires the country-of-concern coauthor pull — not yet ingested"),
    ).toHaveLength(3);
    expect(screen.getByText(/NOT a violation determination/)).toBeTruthy();
    // The old §4 footnote moved here — it must not render twice.
    expect(screen.queryByText(/institution-wide/)).toBeNull();
  });

  it("wraps key terms in dotted-underline DefinedTerm hovers", () => {
    render(<DataSharingDashboard report={report} />);
    // §1 datasets card: "strict floor" carries the glossary hover affordance.
    expect(screen.getByText("strict floor").className).toContain("cursor-help");
    // §4 headers: DefinedTerm triggers replaced the bare title= attrs.
    expect(screen.getByText("Concerning", { selector: "span" }).className).toContain(
      "decoration-dotted",
    );
  });

  it("methods dialog renders the built MethodsDoc sections and a Download methods link", () => {
    render(<DataSharingDashboard report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "Methods" }));
    // Section headings come from buildMethodsDoc, not hardcoded prose.
    expect(screen.getByText("Corpus and denominator")).toBeTruthy();
    expect(screen.getByText("Glossary", { selector: "h3" })).toBeTruthy();
    expect(screen.getByText("One paragraph for reporting")).toBeTruthy();
    // Radix portals the dialog to document.body, outside `container`.
    expect(
      document.querySelector('a[href="/edit/data-sharing/export?section=methods"]'),
    ).toBeTruthy();
  });
});
