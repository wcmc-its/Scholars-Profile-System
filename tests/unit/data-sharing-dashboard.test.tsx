import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DataSharingDashboard } from "@/components/edit/data-sharing-dashboard";
import {
  buildDataSharingReport,
  type DatasetLinkRow,
  type ShareRateCorpusRow,
} from "@/lib/api/data-sharing-report";
import type { DataSharingUiParams } from "@/lib/edit/data-sharing-dashboard";

/** No filters, default sort/page — every test below exercises the default
 *  render, sort/filter/pagination interaction is `data-sharing-dashboard.ts`'s
 *  own `parseDataSharingParams` unit tests' job, not this component test's. */
const DEFAULT_UI: DataSharingUiParams = {
  filters: {},
  deptDir: "desc",
  facDir: "desc",
  facPage: 1,
};

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
  it("paginates Named faculty at 25 rows/page (2026-08-16: real pagination, not a static '+N more' cut)", () => {
    const page1 = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    // 30 faculty in the report; only page 1 (25 rows) renders in §4.
    expect(page1.container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(25);
    expect(page1.getByText(/page 1 of 2 \(30 total\)/)).toBeTruthy();
    expect(page1.getByText("Next →")).toBeTruthy();
    page1.unmount();

    const page2 = render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, facPage: 2 }} />,
    );
    // Page 2 has the remaining 5 faculty rows.
    expect(page2.container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(5);
    expect(page2.getByText("← Previous")).toBeTruthy();
  });

  it("renders the tier spectrum legend with counts and per-repo chips", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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
  it("renders ONE collapsed PMC coverage card, flagged as a known data-quality gap (2026-08-16: was two redundant cards)", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByText("In PMC")).toBeTruthy();
    // The second, redundant "PMC-covered share rate" card is gone.
    expect(screen.queryByText("PMC-covered share rate")).toBeNull();
    expect(screen.getByText(/known data-quality gap/)).toBeTruthy();
    // Fixture is fully PMC-covered and fully deposited, so the share-rate
    // card and the one remaining PMC card both read the same n/N.
    const rollupValues = [...container.querySelectorAll("#rollup .text-2xl")].filter(
      (el) => el.textContent === "30/30 (100%)",
    );
    expect(rollupValues).toHaveLength(2);
  });

  it("renders zero-count tier rows as a statement, not an absence", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    // All data is GEO → US_OPEN; the other five real tiers still get a row
    // each (report-side zero padding), with a muted "none detected"
    // Repositories cell instead of vanishing.
    expect(screen.getAllByText("none detected")).toHaveLength(5);
    // The Country of concern row at 0 is the deliberate statement — its
    // label renders in the tier table (chip) and the spectrum legend.
    expect(screen.getAllByText("Country of concern").length).toBeGreaterThan(0);
  });

  it("adds a Download items CSV drill-down link per aggregate table", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    // §1 datasets card: "strict floor" carries the glossary hover affordance.
    expect(screen.getByText("strict floor").className).toContain("cursor-help");
    // §4 headers: DefinedTerm triggers replaced the bare title= attrs.
    expect(screen.getByText("Concerning", { selector: "span" }).className).toContain(
      "decoration-dotted",
    );
  });

  it("sticky nav lists every section anchor plus the single Methods trigger", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const nav = container.querySelector("nav");
    expect(nav).toBeTruthy();
    for (const id of ["rollup", "funding", "repos", "faculty", "subtypes", "recent", "compliance"]) {
      // §5 subtypes is hidden on this fixture, but its nav anchor still renders —
      // the nav is a fixed list, not conditional on section visibility.
      expect(nav?.querySelector(`a[href="#${id}"]`)).toBeTruthy();
    }
    // Exactly one Methods trigger on the whole page (moved out of §1's corner).
    expect(screen.getAllByRole("button", { name: "Methods" })).toHaveLength(1);
  });

  it("filter bar offers year-range inputs and tier checkboxes as a plain GET form", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.querySelector('input[name="yearFrom"]')).toBeTruthy();
    expect(form?.querySelector('input[name="yearTo"]')).toBeTruthy();
    expect(form?.querySelector('input[name="tier"][value="CONCERN"]')).toBeTruthy();
  });

  it("department table sort links preserve filters and toggle direction", () => {
    const ui: DataSharingUiParams = { filters: { yearFrom: 2022 }, deptDir: "desc", facDir: "desc", facPage: 1 };
    const { container } = render(<DataSharingDashboard report={report} ui={ui} />);
    const shareRateLink = [...container.querySelectorAll("#repos th a")].find(
      (a) => a.textContent === "Share rate",
    );
    // Preserves the active year filter AND the (untouched) faculty sort/page
    // state, on top of the new dept sort — otherParams merges every other
    // active param so switching one table's sort never resets another's.
    const href = shareRateLink?.getAttribute("href") ?? "";
    const params = new URLSearchParams(href.replace(/^\?/, ""));
    expect(params.get("yearFrom")).toBe("2022");
    expect(params.get("deptSort")).toBe("shareRate");
    expect(params.get("deptDir")).toBe("desc");
  });

  it("REGRESSION 2026-08-16: tier filter and faculty sort/page survive a department-table sort click (querystring uses singular tier=, matching parseDataSharingParams)", () => {
    const ui: DataSharingUiParams = {
      filters: { tiers: ["US_OPEN", "CONCERN"] },
      deptDir: "desc",
      facSort: "concerning",
      facDir: "asc",
      facPage: 2,
    };
    const { container } = render(<DataSharingDashboard report={report} ui={ui} />);
    const datasetsLink = [...container.querySelectorAll("#repos th a")].find(
      (a) => a.textContent?.startsWith("Datasets"),
    );
    const params = new URLSearchParams((datasetsLink?.getAttribute("href") ?? "").replace(/^\?/, ""));
    // The bug: `...ui.filters` spread the FIELD name `tiers` (plural) into
    // the querystring, which parseDataSharingParams never reads (it reads
    // `tier`, singular) — silently dropping the filter on any sort click.
    expect(params.getAll("tier")).toEqual(["US_OPEN", "CONCERN"]);
    expect(params.has("tiers")).toBe(false);
    // The bug: facSort/facDir were omitted from RepositoriesSection's
    // otherParams entirely, resetting the faculty table's sort to default.
    expect(params.get("facSort")).toBe("concerning");
    expect(params.get("facDir")).toBe("asc");
  });

  it("REGRESSION 2026-08-16: faculty Prev/Next pagination links preserve the active facSort/facDir", () => {
    const ui: DataSharingUiParams = { filters: {}, deptDir: "desc", facSort: "concerning", facDir: "asc", facPage: 1 };
    const { getByText } = render(<DataSharingDashboard report={report} ui={ui} />);
    const params = new URLSearchParams((getByText("Next →").getAttribute("href") ?? "").replace(/^\?/, ""));
    expect(params.get("facSort")).toBe("concerning");
    expect(params.get("facDir")).toBe("asc");
    expect(params.get("facPage")).toBe("2");
  });

  it("REGRESSION 2026-08-16: an out-of-range facPage clamps to the last real page instead of rendering empty", () => {
    render(<DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, facPage: 999 }} />);
    // 30 faculty / 25 per page = 2 pages — clamps to page 2, not a blank
    // "page 999 of 2".
    expect(screen.getByText(/page 2 of 2 \(30 total\)/)).toBeTruthy();
  });

  it("REGRESSION 2026-08-16: dbGaP accessions are NOT uppercased (its real convention is lowercase 'phs', unlike GEO's GSE)", () => {
    const dbgapRows: DatasetLinkRow[] = [
      { ...ROWS[0], repository: "dbGaP", accessionOrDoi: "phs000001.v1.p1", cwid: "dbgap1", datasetId: "ddbgap" },
    ];
    const dbgapReport = { ...buildDataSharingReport(dbgapRows, CORPUS), dataAsOf: null };
    render(<DataSharingDashboard report={dbgapReport} ui={DEFAULT_UI} />);
    expect(screen.getByText("phs000001.v1.p1")).toBeTruthy();
    expect(screen.queryByText("PHS000001.V1.P1")).toBeNull();
  });

  it("REGRESSION 2026-08-16: an all-caps department name preserves a known institutional acronym instead of mangling it", () => {
    const qatarRows: DatasetLinkRow[] = [
      { ...ROWS[0], department: "WCMC QATAR", cwid: "qatar1", datasetId: "dqatar" },
    ];
    const qatarReport = { ...buildDataSharingReport(qatarRows, CORPUS), dataAsOf: null };
    render(<DataSharingDashboard report={qatarReport} ui={DEFAULT_UI} />);
    // Renders in the department table, the faculty table, and recent
    // activity — all three should read "WCMC Qatar", none "Wcmc Qatar".
    expect(screen.getAllByText("WCMC Qatar").length).toBeGreaterThan(0);
    expect(screen.queryByText("Wcmc Qatar")).toBeNull();
  });

  it("collapses Concerning/Foreign-hosted to one column when no country-of-concern deposit exists, and restores both when one does", () => {
    const noConcern = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(noConcern.container.querySelector("#faculty th")?.parentElement?.textContent).not.toContain(
      "Foreign-hosted",
    );
    noConcern.unmount();

    const concernRows: DatasetLinkRow[] = [
      { ...ROWS[0], repository: "GSA", cwid: "concern1", datasetId: "dconcern" },
      ...ROWS,
    ];
    const concernReport = { ...buildDataSharingReport(concernRows, CORPUS), dataAsOf: null };
    const withConcern = render(<DataSharingDashboard report={concernReport} ui={DEFAULT_UI} />);
    expect(withConcern.container.querySelector("#faculty thead")?.textContent).toContain("Foreign-hosted");
  });

  it("By-department table states the attribution-scope mechanism (zero-dataset/nonzero-share-rate and vice versa)", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(
      screen.getByText(/can show a nonzero share rate with zero datasets of its own/),
    ).toBeTruthy();
  });

  it("§7 placeholder cards are visibly ghosted, not just captioned", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const pending = container.querySelectorAll('#compliance [aria-disabled="true"]');
    expect(pending).toHaveLength(3);
    for (const card of pending) expect(card.className).toContain("opacity-50");
  });

  it("§1 renders the deposits-by-year trend chart when byYear has data", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByText("Deposits by year")).toBeTruthy();
  });

  it("methods dialog renders the built MethodsDoc sections and a Download methods link", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
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

describe("DataSharingDashboard, Synapse access-aware effective tier (issue #2471, 2026-08-16)", () => {
  it("an all-controlled Synapse deposit set (today's real data shape) renders the US-hosted, controlled tier chip and no longer trips the tier/access mismatch footnote", () => {
    const synapseControlledRows: DatasetLinkRow[] = [
      { ...ROWS[0], repository: "Synapse", accessModel: "controlled", cwid: "synctrl1", datasetId: "dsynctrl1", pmids: ["psynctrl1"] },
    ];
    const synapseReport = { ...buildDataSharingReport(synapseControlledRows, CORPUS), dataAsOf: null };
    const { container } = render(<DataSharingDashboard report={synapseReport} ui={DEFAULT_UI} />);
    // §3 "By repository" table (the second table in #repos, after the tier
    // table) renders the access-aware tier, not the static US_OPEN default.
    // Before the #2471 fix this would have read "US-hosted, open".
    const repoTable = container.querySelectorAll("#repos table")[1];
    expect(repoTable.textContent).toContain("US-hosted, controlled");
    expect(repoTable.textContent).not.toContain("US-hosted, open");
    // The mismatch footnote must NOT render: Synapse's tier now genuinely
    // agrees with its observed Access column, so there is nothing left to
    // footnote (confirmed by rendering, not assumed).
    expect(screen.queryByText(/can disagree with what its/)).toBeNull();
  });

  it("an open-access Synapse deposit still renders US-hosted, open (regression guard, unchanged from today)", () => {
    const synapseOpenRows: DatasetLinkRow[] = [
      { ...ROWS[0], repository: "Synapse", accessModel: "open", cwid: "synopen1", datasetId: "dsynopen1", pmids: ["psynopen1"] },
    ];
    const synapseReport = { ...buildDataSharingReport(synapseOpenRows, CORPUS), dataAsOf: null };
    const { container } = render(<DataSharingDashboard report={synapseReport} ui={DEFAULT_UI} />);
    const repoTable = container.querySelectorAll("#repos table")[1];
    expect(repoTable.textContent).toContain("US-hosted, open");
  });
});
