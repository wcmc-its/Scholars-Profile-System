import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// The filter/sort/pager links soft-navigate through the app router
// (`data-sharing-nav.tsx`); outside Next there is no mounted router to supply.
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
beforeEach(() => mockPush.mockReset());

import { DataSharingDashboard } from "@/components/edit/data-sharing-dashboard";
import {
  buildDataSharingReport,
  computeDepositYearBounds,
  type DataSharingReport,
  type DatasetLinkRow,
  type ShareRateCorpusRow,
} from "@/lib/api/data-sharing-report";
import type { DataSharingUiParams } from "@/lib/edit/data-sharing-dashboard";

/** `buildDataSharingReport` only builds the parts a pure function can build.
 *  `dataAsOf`/`depositYearBounds` are `loadDataSharingReport`'s own
 *  additions (see that function's doc comment), so every fixture needs the
 *  same two-field patch to satisfy the full `DataSharingReport` type this
 *  component takes. `dataAsOf: null` matches every fixture here (none of
 *  these render tests exercise the "Data as of" date). */
function testReport(rows: DatasetLinkRow[], corpus: ShareRateCorpusRow[] = []): DataSharingReport {
  return {
    ...buildDataSharingReport(rows, corpus),
    dataAsOf: null,
    depositYearBounds: computeDepositYearBounds(rows),
  };
}

/** No filters, default sort/page — sort/filter/pagination parsing is
 *  `data-sharing-dashboard.ts`'s own `parseDataSharingParams` unit tests' job. */
const DEFAULT_UI: DataSharingUiParams = {
  filters: {},
  deptDir: "desc",
  facDir: "desc",
  facPage: 1,
};

/** 30 faculty, one open GEO dataset + one citing pub each — enough rows to
 *  trip the 25-row faculty page, and real pmids so `pubsByTier` is non-zero.
 *  Deliberately NO `sensitiveSubtypes` so the Sub-types section stays hidden
 *  (its own hide-when-empty branch is asserted below). */
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
 *  confirmed first/last-authored pub IN PMC, so the share-rate and "In PMC"
 *  tiles both read 30 of 30 (100%). */
const CORPUS: ShareRateCorpusRow[] = Array.from({ length: 30 }, (_, i) => ({
  pmid: `p${i}`,
  cwid: `cwid${i}`,
  department: "Medicine",
  inPmc: true,
}));

const report = testReport(ROWS, CORPUS);

const qs = (href: string | null | undefined) =>
  new URLSearchParams((href ?? "").replace(/^[^?]*\?/, ""));

describe("DataSharingDashboard — layout (2026-09 page revision)", () => {
  it("renders the On-this-page rail with a numbered row + stat per visible section and a Methods link", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const rail = container.querySelector('[data-testid="ds-rail"]') as HTMLElement;
    for (const id of [
      "rollup",
      "funding",
      "repos",
      "departments",
      "faculty",
      "recent",
      "compliance",
    ]) {
      expect(rail.querySelector(`a[href="#${id}"]`)).toBeTruthy();
      expect(container.querySelector(`#${id}`)).toBeTruthy();
    }
    // Sub-types is empty on this fixture: the section AND its rail row hide.
    expect(rail.querySelector('a[href="#subtypes"]')).toBeNull();
    expect(container.querySelector("#subtypes")).toBeNull();
    expect(rail.querySelector('a[href="#methods"]')?.textContent).toBe("Methods & definitions");
    // Rollup row carries the distinct-dataset headline number.
    expect(rail.querySelector('a[href="#rollup"]')?.textContent).toContain("30");
  });

  it("audience chips dim the sections that audience doesn't need", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const rail = within(container.querySelector('[data-testid="ds-rail"]') as HTMLElement);
    fireEvent.click(rail.getByRole("button", { name: "Compliance" }));
    const dimmed = (id: string) =>
      container
        .querySelector(`[data-testid="ds-rail"] a[href="#${id}"]`)
        ?.getAttribute("data-dimmed");
    expect(dimmed("compliance")).toBeNull();
    expect(dimmed("rollup")).toBe("true");
    fireEvent.click(rail.getByRole("button", { name: "Everyone" }));
    expect(dimmed("rollup")).toBeNull();
  });

  it("shows the Data-as-of pill and the permanent FTE-denominator note, filtered or not", () => {
    const NOTE =
      "Aug 2026: share-rate denominator narrowed to full-time faculty; rates roughly doubled vs. earlier published figures";
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByText("Data as of —")).toBeTruthy();
    expect(screen.getByTestId("ds-fte-note").textContent).toBe(NOTE);
    document.body.innerHTML = "";
    render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, filters: { yearFrom: 2021 } }} />,
    );
    expect(screen.getByTestId("ds-fte-note").textContent).toBe(NOTE);
  });
});

describe("DataSharingDashboard — rollup", () => {
  it("shows the share rate as a percentage WITH its n of N, and ONE PMC tile flagged as a data-quality gap", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByTestId("ds-share-rate").textContent).toBe("100%");
    expect(
      screen.getByText(/30 of 30 confirmed first\/last-author, full-time-faculty pubs since/),
    ).toBeTruthy();
    expect(screen.getByText("In PMC")).toBeTruthy();
    expect(screen.getByTestId("ds-pmc").textContent).toBe("100%");
    expect(screen.queryByText("PMC-covered share rate")).toBeNull();
    expect(screen.getByText(/Known data-quality gap/)).toBeTruthy();
  });

  it("renders the tier bars with counts and zero-count tiers as a statement", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const bars = container.querySelector('[data-testid="ds-tier-bars"]') as HTMLElement;
    expect(bars.children).toHaveLength(6);
    expect(bars.textContent).toContain("US-hosted, open");
    expect(bars.textContent).toContain("Country of concern");
    expect(within(bars).getByText("30")).toBeTruthy();
  });

  it("renders the datasets-by-deposit-year chart, marking the current year YTD and greying years outside the filter", () => {
    const rows: DatasetLinkRow[] = [
      { ...ROWS[0], datasetId: "y1", depositYear: 2024 },
      { ...ROWS[1], datasetId: "y2", depositYear: 2026 },
    ];
    render(
      <DataSharingDashboard
        report={testReport(rows, CORPUS)}
        ui={{ ...DEFAULT_UI, filters: { yearFrom: 2025 } }}
        currentYear={2026}
      />,
    );
    expect(screen.getByText("Datasets by deposit year")).toBeTruthy();
    expect(screen.getByText("2026 YTD")).toBeTruthy();
    expect(screen.getByText(/2026 is year to date/)).toBeTruthy();
    expect(screen.getByTitle("2024: 1 datasets").className).toContain("bg-apollo-surface-2");
    expect(screen.getByTitle("2026 YTD: 1 datasets").className).toContain("bg-apollo-slate");
  });

  it("wraps key terms in dotted-underline DefinedTerm hovers", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(
      within(container.querySelector("#rollup") as HTMLElement).getByText("Strict floor").className,
    ).toContain("cursor-help");
    expect(screen.getByText("Concerning", { selector: "span" }).className).toContain(
      "decoration-dotted",
    );
  });
});

describe("DataSharingDashboard — funding & access", () => {
  it("renders ONE access × NIH table with totals (the four old funding cards' numbers are its margins)", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const table = container.querySelector('[data-testid="ds-funding-table"]') as HTMLElement;
    const head = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(head).toEqual(["Access model", "NIH-funded", "Not NIH-funded", "Total"]);
    const rowLabels = [...table.querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(rowLabels).toEqual(["Open access", "Controlled access", "Publications"]);
    const openRow = table.querySelectorAll("tbody tr")[0];
    expect(openRow.lastElementChild?.textContent).toBe(String(report.overall.openPubs));
  });

  it("tints the active NIH column", () => {
    const { container } = render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, filters: { nihFunded: true } }} />,
    );
    const ths = container.querySelectorAll('[data-testid="ds-funding-table"] thead th');
    expect(ths[1].className).toContain("bg-apollo-slate-tint");
    expect(ths[2].className).not.toContain("bg-apollo-slate-tint");
  });
});

describe("DataSharingDashboard — repositories", () => {
  it("lists each tier's repositories as linked pills with counts, 'None detected' for the empty tiers", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const tiers = container.querySelector('[data-testid="ds-repo-tiers"]') as HTMLElement;
    const pill = tiers.querySelector('a[href="https://www.ncbi.nlm.nih.gov/geo/"]');
    expect(pill?.textContent).toBe("GEO30");
    expect(within(tiers).getAllByText("None detected")).toHaveLength(5);
  });

  it("keeps the per-repository table (access model + items CSV) behind a disclosure", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const table = container.querySelector('[data-testid="ds-repo-table"]') as HTMLElement;
    expect(table.closest("details")).toBeTruthy();
    expect(
      table.querySelector(
        'a[href^="/edit/data-sharing/export?section=repositories&grain=items&repository="]',
      ),
    ).toBeTruthy();
  });
});

describe("DataSharingDashboard — departments", () => {
  it("folds Open/Controlled/Registry into an access-mix bar with its counts in text", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const table = container.querySelector('[data-testid="ds-dept-table"]') as HTMLElement;
    expect(table.textContent).toContain("30 open · 0 controlled · 0 registry");
    expect(within(table).getByText("30/30")).toBeTruthy();
  });

  it("shows the top 12 departments with a Show all toggle", () => {
    const rows: DatasetLinkRow[] = Array.from({ length: 15 }, (_, i) => ({
      ...ROWS[i],
      department: `Dept ${String(i).padStart(2, "0")}`,
    }));
    const { container } = render(
      <DataSharingDashboard report={testReport(rows)} ui={DEFAULT_UI} />,
    );
    const table = container.querySelector('[data-testid="ds-dept-table"]') as HTMLElement;
    const bodyRows = () => table.querySelectorAll("tbody tr").length;
    expect(bodyRows()).toBe(13); // 12 rows + the toggle row
    fireEvent.click(within(table).getByRole("button", { name: "Show all 15" }));
    expect(bodyRows()).toBe(16);
    expect(within(table).getByRole("button", { name: "Show top 12" })).toBeTruthy();
  });

  it("sort links preserve filters, toggle direction, and sort by name A–Z first", () => {
    const ui: DataSharingUiParams = {
      filters: { yearFrom: 2022 },
      deptDir: "desc",
      facDir: "desc",
      facPage: 1,
    };
    const { container } = render(<DataSharingDashboard report={report} ui={ui} />);
    const link = (label: string) =>
      [...container.querySelectorAll("#departments th a")].find((a) =>
        a.textContent?.startsWith(label),
      );
    const share = qs(link("Share rate")?.getAttribute("href"));
    expect(share.get("yearFrom")).toBe("2022");
    expect(share.get("deptSort")).toBe("shareRate");
    expect(share.get("deptDir")).toBe("desc");
    const name = qs(link("Department")?.getAttribute("href"));
    expect(name.get("deptSort")).toBe("name");
    expect(name.get("deptDir")).toBe("asc");
  });

  it("REGRESSION 2026-08-16: tier filter and faculty sort/page survive a department-table sort click (singular tier=)", () => {
    const ui: DataSharingUiParams = {
      filters: { tiers: ["US_OPEN", "CONCERN"] },
      deptDir: "desc",
      facSort: "concerning",
      facDir: "asc",
      facPage: 2,
    };
    const { container } = render(<DataSharingDashboard report={report} ui={ui} />);
    const datasetsLink = [...container.querySelectorAll("#departments th a")].find((a) =>
      a.textContent?.startsWith("Datasets"),
    );
    const params = qs(datasetsLink?.getAttribute("href"));
    expect(params.getAll("tier")).toEqual(["US_OPEN", "CONCERN"]);
    expect(params.has("tiers")).toBe(false);
    expect(params.get("facSort")).toBe("concerning");
    expect(params.get("facDir")).toBe("asc");
  });

  it("keeps the attribution-scope explanation (zero-dataset/nonzero-share-rate and vice versa)", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByText("Why these don’t add up")).toBeTruthy();
    expect(
      screen.getByText(/can show a nonzero share rate with zero datasets of its own/),
    ).toBeTruthy();
  });

  it("REGRESSION 2026-08-16: an all-caps department name preserves a known institutional acronym", () => {
    const qatarRows: DatasetLinkRow[] = [
      { ...ROWS[0], department: "WCMC QATAR", cwid: "qatar1", datasetId: "dqatar" },
    ];
    render(<DataSharingDashboard report={testReport(qatarRows, CORPUS)} ui={DEFAULT_UI} />);
    expect(screen.getAllByText("WCMC Qatar").length).toBeGreaterThan(0);
    expect(screen.queryByText("Wcmc Qatar")).toBeNull();
  });
});

describe("DataSharingDashboard — faculty", () => {
  it("paginates at 25 rows/page with a Page N of M footer", () => {
    const page1 = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(page1.container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(25);
    expect(page1.getByText("Page 1 of 2")).toBeTruthy();
    expect(page1.getByText(/30 depositing faculty/)).toBeTruthy();
    expect(page1.getByText("Next →")).toBeTruthy();
    page1.unmount();

    const page2 = render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, facPage: 2 }} />,
    );
    expect(page2.container.querySelectorAll('#faculty a[href^="/scholar/"]')).toHaveLength(5);
    expect(page2.getByText("← Previous")).toBeTruthy();
  });

  it("REGRESSION 2026-08-16: Prev/Next links preserve the active facSort/facDir", () => {
    const ui: DataSharingUiParams = {
      filters: {},
      deptDir: "desc",
      facSort: "concerning",
      facDir: "asc",
      facPage: 1,
    };
    const { getByText } = render(<DataSharingDashboard report={report} ui={ui} />);
    const params = qs(getByText("Next →").getAttribute("href"));
    expect(params.get("facSort")).toBe("concerning");
    expect(params.get("facDir")).toBe("asc");
    expect(params.get("facPage")).toBe("2");
  });

  it("REGRESSION 2026-08-16: an out-of-range facPage clamps to the last real page", () => {
    render(<DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, facPage: 999 }} />);
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  });

  it("keeps the tier-only caveat on the Concerning column", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByText(/tier-based only; no sensitive\s+data-type detection/)).toBeTruthy();
  });

  it("collapses Concerning/Foreign-hosted to one column with no country-of-concern deposit, restores both with one", () => {
    const noConcern = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(noConcern.container.querySelector("#faculty thead")?.textContent).not.toContain(
      "Foreign-hosted",
    );
    noConcern.unmount();

    const concernRows: DatasetLinkRow[] = [
      { ...ROWS[0], repository: "GSA", cwid: "concern1", datasetId: "dconcern" },
      ...ROWS,
    ];
    const withConcern = render(
      <DataSharingDashboard report={testReport(concernRows, CORPUS)} ui={DEFAULT_UI} />,
    );
    expect(withConcern.container.querySelector("#faculty thead")?.textContent).toContain(
      "Foreign-hosted",
    );
  });
});

describe("DataSharingDashboard — sub-types", () => {
  it("groups sub-types into per-category cards with a floor-not-census callout and per-sub-type items links", () => {
    const rows: DatasetLinkRow[] = [
      { ...ROWS[0], sensitiveSubtypes: "genomic:WGS/WES" },
      { ...ROWS[1], sensitiveSubtypes: "genomic:WGS/WES" },
      { ...ROWS[2], sensitiveSubtypes: "biometric:facial" },
    ];
    const { container } = render(
      <DataSharingDashboard report={testReport(rows, CORPUS)} ui={DEFAULT_UI} />,
    );
    const section = container.querySelector("#subtypes") as HTMLElement;
    expect(section).toBeTruthy();
    expect(within(section).getByText("Floor, not a census")).toBeTruthy();
    expect(section.textContent).toContain("Only 3 of 3 deposit instances");
    const headings = [...section.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Genomic", "Biometric"]); // biggest category first
    const link = within(section).getByText("WGS/WES");
    expect(link.getAttribute("href")).toContain("section=subtypes&grain=items&category=genomic");
  });
});

describe("DataSharingDashboard — recent deposits", () => {
  it("deep-links accessions and PMIDs, with Dataset / Title · type / Publication / Tier / Year columns", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(
      container.querySelector(
        '#recent a[href="https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE100"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector('#recent a[href="https://pubmed.ncbi.nlm.nih.gov/p0/"]'),
    ).toBeTruthy();
    const head = [...container.querySelectorAll('[data-testid="ds-recent-table"] thead th')].map(
      (th) => th.textContent,
    );
    expect(head).toEqual(["Dataset", "Title · type", "Publication", "Tier", "Year"]);
    expect(screen.getByText("Fake dataset 0")).toBeTruthy();
    // The row's person is still named (under the publication).
    expect(container.querySelector('#recent a[href="/scholar/faculty-0"]')).toBeTruthy();
    expect(screen.getByText(/Deposit year is the only per-item recency signal/)).toBeTruthy();
  });

  it("an untitled deposit says so instead of a bare dash", () => {
    const rows: DatasetLinkRow[] = [{ ...ROWS[0], title: null }];
    render(<DataSharingDashboard report={testReport(rows, CORPUS)} ui={DEFAULT_UI} />);
    expect(screen.getByText("Untitled in repository metadata")).toBeTruthy();
  });

  it("REGRESSION 2026-08-16: dbGaP accessions are NOT uppercased", () => {
    const dbgapRows: DatasetLinkRow[] = [
      {
        ...ROWS[0],
        repository: "dbGaP",
        accessionOrDoi: "phs000001.v1.p1",
        cwid: "dbgap1",
        datasetId: "ddbgap",
      },
    ];
    render(<DataSharingDashboard report={testReport(dbgapRows, CORPUS)} ui={DEFAULT_UI} />);
    expect(screen.getByText("phs000001.v1.p1")).toBeTruthy();
    expect(screen.queryByText("PHS000001.V1.P1")).toBeNull();
  });
});

describe("DataSharingDashboard — compliance + methods", () => {
  it("renders one real number, three dashed pending cards, and the framing caveat", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByRole("heading", { name: "Compliance" })).toBeTruthy();
    expect(screen.getByText("Concerning deposit instances")).toBeTruthy();
    const pending = container.querySelectorAll('#compliance [aria-disabled="true"]');
    expect(pending).toHaveLength(3);
    for (const card of pending) expect(card.className).toContain("border-dashed");
    expect(screen.getAllByText("Needs the country-of-concern coauthor pull")).toHaveLength(3);
    expect(screen.getByText(/not a\s+violation determination/)).toBeTruthy();
    expect(screen.queryByText(/institution-wide/)).toBeNull();
  });

  it("renders the MethodsDoc inline (sections, glossary, reporting paragraph, Download methods)", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const methods = within(container.querySelector("#methods") as HTMLElement);
    expect(methods.getByText("Corpus and denominator")).toBeTruthy();
    expect(methods.getByText("Glossary", { selector: "h3" })).toBeTruthy();
    expect(methods.getByText("One paragraph for reporting")).toBeTruthy();
    expect(
      container.querySelector('a[href="/edit/data-sharing/export?section=methods"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Methods" })).toBeNull();
  });
});

describe("DataSharingDashboard — downloads", () => {
  it("offers per-table aggregate and items CSVs (no tiers items grain), PMID links, no access pills", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const s of ["tiers", "repositories", "departments", "faculty"]) {
      expect(hrefs).toContain(`/edit/data-sharing/export?section=${s}`);
    }
    for (const s of ["repositories", "departments", "faculty"]) {
      expect(hrefs).toContain(`/edit/data-sharing/export?section=${s}&grain=items`);
    }
    expect(hrefs.some((h) => h?.includes("section=subtypes"))).toBe(false);
    expect(hrefs.some((h) => h?.includes("section=tiers&grain=items"))).toBe(false);
    expect(container.querySelector("td [data-slot='badge']")).toBeNull();
    expect(screen.getAllByText("Items CSV").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Items").length).toBeGreaterThan(0);
    expect(screen.queryByText(/ignores filters/)).toBeNull();
  });

  it("no filter leaves the rollup export href plain; an active filter rides on every export link", () => {
    const plain = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(plain.getByTestId("ds-export-link").getAttribute("href")).toBe(
      "/edit/data-sharing/export",
    );
    plain.unmount();

    const { container, getByTestId } = render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, filters: { yearFrom: 2021 } }} />,
    );
    expect(getByTestId("ds-export-link").getAttribute("href")).toBe(
      "/edit/data-sharing/export?yearFrom=2021",
    );
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/edit/data-sharing/export?section=departments&yearFrom=2021");
    expect(
      hrefs.some(
        (h) =>
          h?.startsWith("/edit/data-sharing/export?section=repositories&grain=items&repository=") &&
          h.includes("yearFrom=2021"),
      ),
    ).toBe(true);
  });

  it("carries a nihFunded filter onto download links too", () => {
    render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, filters: { nihFunded: true } }} />,
    );
    expect(screen.getByTestId("ds-export-link").getAttribute("href")).toBe(
      "/edit/data-sharing/export?nihFunded=true",
    );
  });
});

describe("DataSharingDashboard — Synapse access-aware effective tier (issue #2471)", () => {
  it("an all-controlled Synapse deposit set renders US-hosted, controlled and no mismatch footnote", () => {
    const rows: DatasetLinkRow[] = [
      {
        ...ROWS[0],
        repository: "Synapse",
        accessModel: "controlled",
        cwid: "synctrl1",
        datasetId: "dsynctrl1",
        pmids: ["psynctrl1"],
      },
    ];
    const { container } = render(
      <DataSharingDashboard report={testReport(rows, CORPUS)} ui={DEFAULT_UI} />,
    );
    const repoTable = container.querySelector('[data-testid="ds-repo-table"]') as HTMLElement;
    expect(repoTable.textContent).toContain("US-hosted, controlled");
    expect(repoTable.textContent).not.toContain("US-hosted, open");
    expect(
      within(container.querySelector("#repos") as HTMLElement).queryByText(
        /can disagree with what its/,
      ),
    ).toBeNull();
  });

  it("an open-access Synapse deposit still renders US-hosted, open", () => {
    const rows: DatasetLinkRow[] = [
      {
        ...ROWS[0],
        repository: "Synapse",
        accessModel: "open",
        cwid: "synopen1",
        datasetId: "dsynopen1",
        pmids: ["psynopen1"],
      },
    ];
    const { container } = render(
      <DataSharingDashboard report={testReport(rows, CORPUS)} ui={DEFAULT_UI} />,
    );
    expect(container.querySelector('[data-testid="ds-repo-table"]')?.textContent).toContain(
      "US-hosted, open",
    );
  });
});

describe("DataSharingDashboard — filter bar", () => {
  const boundedRows: DatasetLinkRow[] = [
    { ...ROWS[0], datasetId: "dy1", depositYear: 2020 },
    { ...ROWS[1], datasetId: "dy2", depositYear: 2026 },
    { ...ROWS[2], datasetId: "dy3", depositYear: 2023 },
  ];
  const boundsReport = testReport(boundedRows, CORPUS);
  const bar = (container: HTMLElement) =>
    container.querySelector('[data-testid="ds-filter-bar"]') as HTMLElement;

  it("offers deposit-year presets from the corpus bounds, each a link that keeps the other filters and sorts", () => {
    const ui: DataSharingUiParams = {
      filters: { tiers: ["US_OPEN"], nihFunded: false },
      deptSort: "faculty",
      deptDir: "asc",
      facDir: "desc",
      facPage: 3,
    };
    const { container } = render(<DataSharingDashboard report={boundsReport} ui={ui} />);
    const years = within(within(bar(container)).getByRole("group", { name: "Deposit years" }));
    expect(years.getByText("2020–26").getAttribute("aria-current")).toBe("true");
    const five = qs(years.getByText("2022–26").getAttribute("href"));
    expect(five.get("yearFrom")).toBe("2022");
    expect(five.getAll("tier")).toEqual(["US_OPEN"]);
    expect(five.get("nihFunded")).toBe("false");
    expect(five.get("deptSort")).toBe("faculty");
    expect(five.has("facPage")).toBe(false); // a filter change resets the faculty page
    expect(years.getByText("2024–26")).toBeTruthy();
  });

  it("keeps the typed year range as a plain GET form behind Custom, clamped to the corpus bounds", () => {
    const { container } = render(
      <DataSharingDashboard
        report={boundsReport}
        ui={{ ...DEFAULT_UI, filters: { yearFrom: 2023 } }}
      />,
    );
    const form = bar(container).querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    const yearFrom = form.querySelector('input[name="yearFrom"]') as HTMLInputElement;
    const yearTo = form.querySelector('input[name="yearTo"]') as HTMLInputElement;
    // Bounds stay the report's own, regardless of the active filter.
    expect(yearFrom.placeholder).toBe("2020");
    expect(yearFrom.min).toBe("2020");
    expect(yearFrom.max).toBe("2026");
    expect(yearTo.placeholder).toBe("2026");
    // 2023 isn't a preset, so the Custom segment carries the active range.
    expect(bar(container).querySelector("summary")?.textContent).toBe("2023–26");
  });

  it("renders no year presets, placeholder or clamp when the corpus has no depositYear", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const yearFrom = bar(container).querySelector('input[name="yearFrom"]') as HTMLInputElement;
    expect(yearFrom.placeholder).toBe("");
    expect(yearFrom.hasAttribute("min")).toBe(false);
    expect(
      within(bar(container)).getByRole("group", { name: "Deposit years" }).querySelectorAll("a"),
    ).toHaveLength(0);
  });

  it("NIH segments are links carrying nihFunded; the active one is marked", () => {
    const { container } = render(
      <DataSharingDashboard
        report={report}
        ui={{ ...DEFAULT_UI, filters: { nihFunded: false } }}
      />,
    );
    const nih = (v: string) => bar(container).querySelector(`a[data-nih="${v}"]`);
    expect(qs(nih("true")?.getAttribute("href")).get("nihFunded")).toBe("true");
    expect(qs(nih("any")?.getAttribute("href")).has("nihFunded")).toBe(false);
    expect(nih("false")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Clear filters")).toBeTruthy();
  });

  it("tier chips toggle their tier in and out of the tier= list", () => {
    const { container } = render(
      <DataSharingDashboard
        report={report}
        ui={{ ...DEFAULT_UI, filters: { tiers: ["US_OPEN"] } }}
      />,
    );
    const chip = (t: string) => bar(container).querySelector(`a[data-tier="${t}"]`);
    expect(chip("US_OPEN")?.getAttribute("aria-current")).toBe("true");
    expect(qs(chip("US_OPEN")?.getAttribute("href")).getAll("tier")).toEqual([]);
    expect(qs(chip("CONCERN")?.getAttribute("href")).getAll("tier")).toEqual([
      "US_OPEN",
      "CONCERN",
    ]);
  });
});

describe("DataSharingDashboard — soft navigation", () => {
  /** Asserts exactly one scroll-preserving push, and returns its query. */
  const pushed = () => {
    expect(mockPush).toHaveBeenCalledTimes(1);
    const [href, opts] = mockPush.mock.calls[0];
    expect(opts).toEqual({ scroll: false });
    return new URLSearchParams(new URL(href, "http://x").search);
  };

  it("a tier chip click pushes its own href without a reload or scroll jump", () => {
    const { container } = render(
      <DataSharingDashboard
        report={report}
        ui={{ ...DEFAULT_UI, filters: { tiers: ["US_OPEN"] } }}
      />,
    );
    const chip = container.querySelector('a[data-tier="CONCERN"]') as HTMLAnchorElement;
    // fireEvent returns false when the default (a full navigation) was prevented.
    expect(fireEvent.click(chip)).toBe(false);
    expect(pushed().getAll("tier")).toEqual(["US_OPEN", "CONCERN"]);
  });

  it("NIH segments, sort headers and the faculty pager soft-navigate too", () => {
    const { container, getByText } = render(
      <DataSharingDashboard report={report} ui={DEFAULT_UI} />,
    );
    fireEvent.click(container.querySelector('a[data-nih="true"]') as HTMLElement);
    expect(pushed().get("nihFunded")).toBe("true");

    mockPush.mockReset();
    const facultyTable = container.querySelector("#faculty table") as HTMLElement;
    fireEvent.click(within(facultyTable).getByRole("link", { name: /Share rate/ }));
    expect(pushed().get("facSort")).toBe("shareRate");

    mockPush.mockReset();
    fireEvent.click(getByText("Next →"));
    expect(pushed().get("facPage")).toBe("2");
  });

  it("leaves modified clicks (open in new tab/window) to the browser", () => {
    const { container } = render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    const chip = container.querySelector('a[data-tier="CONCERN"]') as HTMLAnchorElement;
    expect(fireEvent.click(chip, { metaKey: true })).toBe(true);
    expect(fireEvent.click(chip, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(chip, { shiftKey: true })).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Clear filters soft-navigates back to the bare page", () => {
    render(
      <DataSharingDashboard report={report} ui={{ ...DEFAULT_UI, filters: { nihFunded: true } }} />,
    );
    fireEvent.click(screen.getByText("Clear filters"));
    expect(mockPush).toHaveBeenCalledWith("/edit/data-sharing", { scroll: false });
  });

  it("the Custom year form submits as a soft navigation, carrying filters and sorts, dropping empty fields", () => {
    const { container } = render(
      <DataSharingDashboard
        report={report}
        ui={{
          ...DEFAULT_UI,
          filters: { tiers: ["US_OPEN"], nihFunded: false },
          deptSort: "faculty",
          deptDir: "asc",
        }}
      />,
    );
    const form = container.querySelector('[data-testid="ds-filter-bar"] form') as HTMLFormElement;
    const details = form.closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent.change(form.querySelector('input[name="yearFrom"]') as HTMLInputElement, {
      target: { value: "2021" },
    });
    expect(fireEvent.submit(form)).toBe(false);
    const q = pushed();
    expect(q.get("yearFrom")).toBe("2021");
    expect(q.has("yearTo")).toBe(false); // left blank → omitted, not `yearTo=`
    expect(q.getAll("tier")).toEqual(["US_OPEN"]);
    expect(q.get("nihFunded")).toBe("false");
    expect(q.get("deptSort")).toBe("faculty");
    expect(q.get("deptDir")).toBe("asc");
    expect(details.open).toBe(false); // the popover closes on Apply
  });

  it("export CSV links stay plain downloads, never intercepted", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(fireEvent.click(screen.getByTestId("ds-export-link"))).toBe(true);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("marks the report region idle and the status empty when nothing is loading", () => {
    render(<DataSharingDashboard report={report} ui={DEFAULT_UI} />);
    expect(screen.getByTestId("ds-pending-region").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByTestId("ds-pending-status").textContent).toBe("");
  });
});
