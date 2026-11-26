/**
 * Report 24's page (`policy-citations-body.tsx` and its client half): the
 * header sentence and export note, a tile per level that toggles the level,
 * the three tabs in order with counts, a By publication row (chips, the
 * expander, editions grouped, a level outside the filter closed), the By
 * citing document rows, By person's muted zeros, and the pager. The loaders
 * are mocked; their SQL and scoping are `policy-citations-report.test.ts`.
 * Fixture people, units and documents are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ citations: vi.fn(), documents: vi.fn(), docs: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));
vi.mock("@/lib/edit/policy-citations-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/policy-citations-report")>()),
  resolvePolicyCitationParams: async (p: object) => ({ ...p, scope: null }),
  loadPolicyCitations: h.citations,
  loadPolicyDocuments: h.documents,
  loadCitingDocuments: h.docs,
}));

import { renderPolicyCitationsReport } from "@/components/edit/reports/policy-citations-body";
import type {
  CitingDoc,
  DocRow,
  PersonRow,
  PolicyCitationData,
  PolicyDocuments,
  PubRow,
} from "@/lib/edit/policy-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";

afterEach(cleanup);

const BASE = "/edit/reports/policy-citations";
const PUB: PubRow = {
  pmid: "10000001",
  title: "An example trial of sample care",
  journal: "Journal of Examples",
  doi: null,
  year: 2021,
  latest: 2025,
  authority: 3,
  guideline: 2,
  consensus: 0,
  review: 3,
  authors: [{ cwid: "abc1001", name: "Example Person", position: "first" }],
  bodies: [{ body: "AHRQ", count: 3 }],
};
const doc = (id: number, over: Partial<CitingDoc>): CitingDoc => ({
  id,
  dedupKey: `k${id}`,
  level: "guideline",
  title: `Sample guideline ${id}`,
  year: 2024,
  url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
  issuingBody: null,
  authors: "Sample AB, Example CD, Invented EF, Fixture GH",
  journal: "J Ex",
  cite: "2024;1(2):3-4",
  doi: null,
  publisher: null,
  pmid: String(id),
  bookshelfId: null,
  locations: [],
  ...over,
});
const edition = (id: number, title: string, year: number, label: string) =>
  doc(id, {
    level: "authority",
    title,
    year,
    issuingBody: "AHRQ",
    authors: null,
    journal: null,
    pmid: null,
    bookshelfId: `NBK00000${id}`,
    url: `https://www.ncbi.nlm.nih.gov/books/NBK00000${id}/`,
    locations: [{ url: `https://www.ncbi.nlm.nih.gov/books/NBK00000${id}/#loc`, label }],
  });
const DOCS = [
  edition(1, "Living Review of Sample Care: 2025 Update", 2025, "Excluded Studies List"),
  edition(2, "Living Review of Sample Care: 2023 Update", 2023, "Excluded Studies"),
  edition(3, "Living Review of Sample Care", 2021, "Results"),
  doc(4, {}),
  doc(5, {}),
  doc(6, { level: "review", title: "Sample review 6" }),
];
const PERSON: PersonRow = {
  cwid: "abc1001",
  name: "Example Person",
  orgUnit: "Department of Examples",
  personType: "Full-time faculty",
  institution: "Weill Cornell Medicine",
  authority: 1,
  guideline: 0,
  consensus: 0,
  review: 4,
};
const DOC_ROW: DocRow = {
  key: "k1",
  level: "authority",
  body: "AHRQ",
  docs: [
    { id: 1, year: 2025 },
    { id: 3, year: 2021 },
  ],
  yearMin: 2021,
  yearMax: 2025,
  pmids: ["10000001"],
  title: "Living Review of Sample Care: 2025 Update",
  url: "https://www.ncbi.nlm.nih.gov/books/NBK000001/",
  journal: null,
  bookshelf: true,
  papers: [{ pmid: "10000001", title: "An example trial of sample care", journal: "Journal of Examples", year: 2021 }],
};

const data = (over: Partial<PolicyCitationData> = {}): PolicyCitationData => ({
  cited: 16525,
  tiles: { authority: 768, guideline: 2661, consensus: 1900, review: 14733 },
  pubTotal: 5080,
  pubMatched: 5080,
  pubs: [PUB],
  people: [PERSON],
  facetPeople: [PERSON],
  ...over,
});
const documents = (over: Partial<PolicyDocuments> = {}): PolicyDocuments => ({
  summary: {
    bodies: [{ body: "AHRQ", documents: 122, papers: 350 }],
    years: { authority: [{ year: 2024, count: 7 }], guideline: [{ year: 2025, count: 594 }], consensus: [] },
  },
  docTotal: 321,
  docs: [],
  ...over,
});

async function page(query: Record<string, string | string[]> = {}) {
  const props = { n: "24", session: { cwid: "sup0001", isSuperuser: true }, searchParams: query, basePath: BASE };
  const out = await renderPolicyCitationsReport(props as unknown as AdminReportProps);
  return render(
    <>
      <div data-testid="subtitle">{out.subtitle}</div>
      <div data-testid="aside">{out.aside}</div>
      {out.main}
    </>,
  );
}

beforeEach(() => {
  h.citations.mockReset().mockResolvedValue(data());
  h.documents.mockReset().mockResolvedValue(documents());
  h.docs.mockReset().mockResolvedValue(new Map([[PUB.pmid, DOCS]]));
});

describe("report 24 page", () => {
  it("header: the sentence reflects the filters; the export sits beside it with the cap note only past the cap", async () => {
    const v = await page();
    expect(v.getByTestId("subtitle").textContent).toBe(
      "5,080 papers cited by a health authority, clinical guideline or consensus statement · published 2020 or later · all units · 16,525 at any level, including systematic reviews",
    );
    expect(v.getByTestId("policy-citations-download-note").textContent).toBe(
      "Publications, People, Citations and Criteria sheets · Publications lists the first 5,000 of 5,080",
    );
    const download = v.getByTestId("policy-citations-download").getAttribute("href")!;
    expect(download).toMatch(/^\/api\/edit\/reports\/policy-citations\?/);
    expect(download).toContain("from=2020");
    cleanup();

    h.citations.mockResolvedValue(data({ pubTotal: 12, pubMatched: 1, cited: 12 }));
    const all = await page({ basis: "cy", q: "sample" });
    expect(all.getByTestId("subtitle").textContent).toBe(
      "12 papers cited by a health authority, clinical guideline, consensus statement or systematic review · published in any year · all units",
    );
    expect(all.getByTestId("policy-citations-download-note").textContent).toBe(
      "Publications, People, Citations and Criteria sheets",
    );
    // The search stays on the page: the download is the filters, not the search box.
    expect(all.getByTestId("policy-citations-download").getAttribute("href")).not.toContain("q=");
    // The pages run over what the search kept.
    expect(all.getByTestId("policy-citations-pager").textContent).toContain("1–1 of 1");
  });

  it("tiles: one per level, each a link that toggles its level; a level outside the filter says so", async () => {
    const v = await page();
    const tiles = within(v.getByTestId("policy-citations-tiles")).getAllByRole("link");
    expect(tiles.map((t) => t.textContent)).toEqual([
      "Health authority768papers",
      "Clinical guideline2,661papers",
      "Consensus statement1,900papers",
      "Systematic review · not in filter14,733papers · click to include",
    ]);
    const levels = (el: HTMLElement) => new URLSearchParams(el.getAttribute("href")!.split("?")[1]).getAll("level");
    expect(levels(tiles[0])).toEqual(["guideline", "consensus"]);
    expect(levels(tiles[3])).toEqual(["authority", "guideline", "consensus", "review"]);
    expect(v.container.textContent).not.toContain("papers with either");
  });

  it("tabs: By publication, By citing document, By person, with counts; the rail's two groups", async () => {
    const v = await page();
    const tabs = within(v.getByRole("navigation", { name: "Report views" })).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "By publication (5,080)",
      "By citing document (321)",
      "By person (1)",
    ]);
    expect(tabs[0].getAttribute("aria-current")).toBe("page");
    const rail = v.getAllByTestId("policy-citations-rail")[0];
    expect(rail.textContent).toContain("Which citations are counted, in every number.");
    expect(rail.textContent).toContain("Which authorships, and so which papers, are in scope.");
    expect(within(rail).getByLabelText("Hide excluded-study citations")).toHaveProperty("checked", false);
    expect(within(rail).getByTestId("policy-citations-years").textContent).toContain("2020 or later · Calendar");
    expect(v.getByTestId("policy-citations-bodies").textContent).toContain(
      "AHRQAgency for Healthcare Research and Quality (US)122350",
    );
    // The chart opens on guidelines and switches level without a page load.
    const chart = v.getByTestId("policy-citations-years-chart");
    expect(within(chart).getByRole("radio", { name: "Guidelines" }).getAttribute("aria-checked")).toBe("true");
    expect(within(chart).getByRole("img").getAttribute("aria-label")).toContain("594 in 2025");
    fireEvent.click(within(chart).getByRole("radio", { name: "Consensus" }));
    expect(chart.textContent).toContain("No citing consensus statements match.");
  });

  it("By publication: chips count grouped documents; the expander opens editions, how it cites, and a closed group for an unticked level", async () => {
    const v = await page();
    // Details are loaded for this page's rows only.
    expect(h.docs.mock.calls[0][1]).toEqual([PUB.pmid]);
    const row = v.getByTestId("policy-citations-pub-row");
    // Three editions are one AHRQ document: 1 authority + 2 guidelines; reviews are not in the filter.
    const chips = within(row).getAllByRole("button").map((b) => b.textContent);
    expect(chips).toEqual(["Copy PMID", "3 citing documents", "AHRQ · 1", "2 guidelines"].map((t) => (t === "Copy PMID" ? "" : t)));
    expect(within(row).getByText("Example Person")).toBeTruthy();
    const toggle = within(row).getByRole("button", { name: "3 citing documents" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(row).queryByTestId("policy-citations-docs")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "AHRQ · 1" }));
    expect(within(row).getByRole("button", { name: "Hide citing documents" }).getAttribute("aria-expanded")).toBe("true");
    const detail = within(row).getByTestId("policy-citations-docs");
    expect(detail.textContent).toContain("Health authority · AHRQ");
    expect(detail.textContent).toContain("Agency for Healthcare Research and Quality (US) · 3 editions, 2021–2025 · NCBI Bookshelf");
    expect(detail.textContent).toContain(
      "How it cites this paper: listed as an excluded study in 2 editions, and cited in Results.",
    );
    expect(detail.textContent).toContain("Sample AB, Example CD, Invented EF, et al. J Ex. 2024;1(2):3-4.");
    const editions = within(detail).getByRole("button", { name: "Show the 3 editions and where each cites the paper" });
    expect(detail.textContent).not.toContain("NBK000002");
    fireEvent.click(editions);
    expect(editions.getAttribute("aria-expanded")).toBe("true");
    expect(detail.textContent).toContain("2023 · NBK000002");
    // Reviews: counted, closed, and labelled as outside the filter.
    expect(detail.textContent).toContain("Systematic reviews · 3Not in the current level filter");
    expect(detail.textContent).not.toContain("Sample review 6");
    fireEvent.click(within(detail).getByRole("button", { name: "Show" }));
    expect(detail.textContent).toContain("Sample review 6");
    expect(detail.textContent).toContain("The newest 1 of 3 systematic reviews.");

    // Paging: 50 a page, Previous off on the first.
    const pager = v.getByTestId("policy-citations-pager");
    expect(pager.textContent).toContain("1–50 of 5,080");
    expect(within(pager).getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);
    expect(within(pager).getByRole("link", { name: "Next" }).getAttribute("href")).toContain("page=2");
    // Search and sort ride one GET form that keeps the filters.
    const form = v.getByTestId("policy-citations-toolbar");
    expect(within(form).getByLabelText("Search title, PMID or author")).toBeTruthy();
    expect(within(form).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Highest level, most distinct documents",
      "Most guidelines",
      "Most recently cited",
      "Publication year",
    ]);
    expect(form.querySelector('input[type="hidden"][name="from"]')?.getAttribute("value")).toBe("2020");
  });

  it("By citing document: one row per document, editions as a range, the papers behind an expander", async () => {
    h.citations.mockResolvedValue(data({ pubs: [] }));
    h.documents.mockResolvedValue(documents({ docs: [DOC_ROW] }));
    h.docs.mockResolvedValue(new Map());
    const v = await page({ basis: "cy", view: "documents", level: ["authority"], page: "2" });
    // No publication rows are loaded off the By publication tab.
    expect(h.citations.mock.calls[0][1]).toBe(0);
    const row = v.getByTestId("policy-citations-doc-row");
    expect(row.textContent).toContain("Health authority · 2 editions · NCBI Bookshelf");
    expect(row.textContent).toContain("2021–2025");
    const papers = within(row).getByRole("button", { name: "Show WCM papers cited (1)" });
    expect(papers.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(papers);
    expect(row.textContent).toContain("An example trial of sample care");
    expect(within(v.getByTestId("policy-citations-toolbar")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Most recent first",
      "Most WCM papers cited",
      "Issuing body",
    ]);
    const pager = v.getByTestId("policy-citations-pager");
    expect(pager.textContent).toContain("51–100 of 321");
    expect(within(pager).getByRole("link", { name: "Previous" }).getAttribute("href")).not.toContain("page=");
  });

  it("By person: names through the hover card, CWIDs in mono, zeros as a muted dash", async () => {
    const v = await page({ basis: "cy", view: "people" });
    const row = v.getByTestId("policy-citations-person-row");
    expect(within(row).getByText("abc1001").className).toContain("font-mono");
    const cells = within(row).getAllByRole("cell").slice(4);
    expect(cells.map((c) => c.textContent)).toEqual(["1", "–0", "–0", "4"]);
    expect(cells[1].querySelector(".sr-only")?.textContent).toBe("0");
    expect(within(row).getByRole("link", { name: "4" }).getAttribute("href")).toContain("person=abc1001");
    expect(within(v.getByTestId("policy-citations-toolbar")).getByLabelText("Search name or CWID")).toBeTruthy();
  });
});
