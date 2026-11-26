/**
 * Report 24's page (`policy-citations-body.tsx` and its client half): the
 * header sentence and export note, the table straight under the header (no
 * tiles, no summary cards), the rail's Type and Issuing body checklists with
 * their paper counts, the wording (type, never level), the link to report 25,
 * the three tabs in order with counts, a By publication row (chips that open
 * to their own documents, the expander, editions grouped, a type outside the
 * filter as a closed group under its heading), the By citing document rows,
 * By person's muted zeros, and the pager. The loaders
 * are mocked; their SQL and scoping are `policy-citations-report.test.ts`.
 * Fixture people, units and documents are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  citations: vi.fn(),
  documents: vi.fn(),
  docs: vi.fn(),
  access: vi.fn(),
  footers: new Map<string, ScholarCardFooter | undefined>(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({ roleCategories: [], departments: [], centers: [], institutions: [] })),
}));
vi.mock("@/lib/edit/report-meta", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/report-meta")>()),
  reportMetaFor: async (key: string) => ({ key, slug: "patents-renamed", name: "Patent citations (renamed)" }),
}));
vi.mock("@/lib/edit/policy-citations-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/policy-citations-report")>()),
  resolvePolicyCitationParams: async (p: object) => ({ ...p, scope: null }),
  loadPolicyCitations: h.citations,
  loadPolicyDocuments: h.documents,
  loadCitingDocuments: h.docs,
  // The facet's names and no more: anyone ticked beyond it stays unnamed.
  loadPersonNames: async (_p: object, known: { cwid: string; name: string }[]) =>
    new Map(known.map((r) => [r.cwid, r.name])),
}));
vi.mock("@/lib/edit/bibliometrics-access", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/bibliometrics-access")>()),
  loadBibliometricsAccess: h.access,
}));
// The card opens on hover only; the mock keeps each person's footer for the tests to render.
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: (p: { cwid: string; children: ReactNode; footer?: ScholarCardFooter }) => {
    h.footers.set(p.cwid, p.footer);
    return p.children;
  },
}));

import type { ReactNode } from "react";

import { renderPolicyCitationsReport } from "@/components/edit/reports/policy-citations-body";
import type { ScholarCardFooter } from "@/components/edit/scholar-hover-card";
import type {
  CitingDoc,
  DocRow,
  PersonRow,
  PolicyCitationData,
  PolicyDocuments,
  PubRow,
} from "@/lib/edit/policy-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

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
  levelPapers: { authority: 768, guideline: 2661, consensus: 1900, review: 14733 },
  pubTotal: 5080,
  pubMatched: 5080,
  withReviews: 16525,
  pubs: [PUB],
  people: [PERSON],
  facetPeople: [PERSON],
  ...over,
});
const documents = (over: Partial<PolicyDocuments> = {}): PolicyDocuments => ({
  bodyPapers: [
    { body: "National Academies", papers: 355 },
    { body: "AHRQ", papers: 350 },
    { body: "WHO", papers: 57 },
    { body: "CDC", papers: 13 },
  ],
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
      <div data-testid="related">{out.related}</div>
      {out.main}
    </>,
  );
}


/** A person's hover-card footer, as the page built it, rendered on its own. */
function footerOf(cwid: string) {
  const footer = h.footers.get(cwid);
  expect(footer, `no card footer for ${cwid}`).toBeTruthy();
  // Scoped to its own container: a test may render two people's footers.
  return within(
    render(
      <div>
        <div data-testid="action">{footer!.action}</div>
        <div data-testid="link">{footer!.link}</div>
      </div>,
    ).container,
  );
}
const queryOf = (href: string | null) => new URLSearchParams(href!.split("?")[1] ?? "");

beforeEach(() => {
  h.footers.clear();
  h.access.mockReset().mockResolvedValue(new Set());
  h.citations.mockReset().mockResolvedValue(data());
  h.documents.mockReset().mockResolvedValue(documents());
  h.docs.mockReset().mockResolvedValue(new Map([[PUB.pmid, DOCS]]));
});

describe("report 24 page", () => {
  it("header: the sentence reflects the filters; the export sits beside it with the cap note only past the cap", async () => {
    const v = await page();
    expect(v.getByTestId("subtitle").textContent).toBe(
      "5,080 papers cited by a health authority, clinical guideline or consensus statement · published 2020 or later · all units · 16,525 when systematic reviews are included",
    );
    expect(v.getByTestId("policy-citations-download-note").textContent).toBe(
      "Publications, People, Citations and Criteria sheets · Publications lists the first 5,000 of 5,080",
    );
    const download = v.getByTestId("policy-citations-download").getAttribute("href")!;
    expect(download).toMatch(/^\/api\/edit\/reports\/policy-citations\?/);
    expect(download).toContain("from=2020");
    cleanup();

    h.citations.mockResolvedValue(data({ pubTotal: 12, pubMatched: 1, withReviews: 12 }));
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

  it("header: reviews unticked with other types says what ticking them adds; ticked, it says nothing more", async () => {
    h.citations.mockResolvedValue(data({ pubTotal: 2661, withReviews: 15900 }));
    const one = await page({ basis: "cy", level: "guideline" });
    expect(one.getByTestId("subtitle").textContent).toBe(
      "2,661 papers cited by a clinical guideline · published in any year · all units · 15,900 when systematic reviews are included",
    );
    cleanup();
    const reviews = await page({ basis: "cy", level: ["guideline", "review"] });
    expect(reviews.getByTestId("subtitle").textContent).toBe(
      "2,661 papers cited by a clinical guideline or systematic review · published in any year · all units",
    );
  });

  it("no summary block: no tiles, no issuing-body card, no chart; the results card follows the chips", async () => {
    const v = await page();
    for (const id of ["policy-citations-tiles", "policy-citations-bodies", "policy-citations-years-chart"]) {
      expect(v.queryByTestId(id), id).toBeNull();
    }
    expect(v.queryByRole("radiogroup")).toBeNull();
    expect(v.container.textContent).not.toContain("By issuing body");
    expect(v.container.textContent).not.toContain("Citing documents by year published");
    const chips = v.getByTestId("policy-citations-chips");
    expect(chips.nextElementSibling?.contains(v.getByRole("navigation", { name: "Report views" }))).toBe(true);
  });

  it("the rail: Type and Issuing body are open checklists with paper counts; bodies most first, full names on the short ones", async () => {
    const v = await page({ basis: "cy", level: "guideline", body: "CDC" });
    const rail = v.getAllByTestId("policy-citations-rail")[0];
    const type = within(rail).getByTestId("policy-citations-level");
    expect(type.querySelector("legend")?.textContent).toBe("Type · papers cited");
    const rows = (el: HTMLElement) => [...el.querySelectorAll("li")].map((li) => li.textContent);
    // Every type keeps its count, whichever is ticked.
    expect(rows(type)).toEqual([
      "Health authority768",
      "Clinical guideline2,661",
      "Consensus statement1,900",
      "Systematic review14,733",
    ]);
    expect(within(type).getByLabelText(/Clinical guideline/)).toHaveProperty("checked", true);
    expect(within(type).getByLabelText(/Systematic review/)).toHaveProperty("checked", false);
    expect(type.textContent).toContain("Lists the papers, documents and people cited by these types of document. None checked = all.");
    // No type icons in the rail.
    expect(type.querySelector("svg")).toBeNull();

    const body = within(rail).getByTestId("policy-citations-body");
    // A fieldset, always open: not a collapsed section.
    expect(body.tagName).toBe("FIELDSET");
    expect(body.closest("details")).toBeNull();
    expect(body.querySelector("legend")?.textContent).toBe("Issuing body · papers cited");
    // Ordered by papers; a body with none still lists, last, so it can be unticked.
    expect(rows(body)).toEqual(["National Academies355", "AHRQ350", "WHO57", "CDC13", "NICE0"]);
    expect(body.querySelector("svg")).toBeNull();
    expect(body.textContent).not.toContain("Documents");
    const names = [...body.querySelectorAll("abbr")].map((a) => [a.textContent, a.getAttribute("title")]);
    expect(names).toEqual([
      ["National Academies", "National Academies of Sciences, Engineering, and Medicine (US)"],
      ["AHRQ", "Agency for Healthcare Research and Quality (US)"],
      ["WHO", "World Health Organization, including its cancer agency IARC"],
      ["CDC", "Centers for Disease Control and Prevention (US)"],
      ["NICE", "National Institute for Health and Care Excellence (UK)"],
    ]);
    expect(body.querySelector("abbr")?.className).toContain("border-dotted");
    // The full name shows on focus, not only on hover.
    fireEvent.focus(body.querySelector("abbr")!);
    expect(within(body).getByRole("tooltip").textContent).toBe(
      "National Academies of Sciences, Engineering, and Medicine (US)",
    );
    expect((body.querySelector('input[value="CDC"]') as HTMLInputElement).checked).toBe(true);
    expect((body.querySelector('input[value="WHO"]') as HTMLInputElement).checked).toBe(false);

    // The citing-document year section is "Year published", with a 20px chevron like every rail section.
    const year = within(rail).getByTestId("policy-citations-citing-year");
    expect(year.querySelector("summary")?.textContent).toBe("Year publishedAny");
    expect(year.querySelector('summary [data-slot="caret"]')?.getAttribute("class")).toContain("size-5");
    expect(rail.textContent).not.toContain("Citing document year");
  });

  it("wording: nothing on the page says level", async () => {
    const queries: Record<string, string>[] = [
      {},
      { basis: "cy", level: "guideline" },
      { basis: "cy", view: "people" },
      { basis: "cy", view: "documents" },
    ];
    for (const query of queries) {
      h.citations.mockResolvedValue(data({ pubs: [], people: [] }));
      const v = await page(query);
      expect(v.container.textContent, JSON.stringify(query)).not.toMatch(/level/i);
      for (const el of v.container.querySelectorAll("[title], [aria-label]")) {
        expect(`${el.getAttribute("title")} ${el.getAttribute("aria-label")}`).not.toMatch(/level/i);
      }
      cleanup();
    }
    h.citations.mockResolvedValue(data());
    const chips = (await page({ basis: "cy", level: "guideline" })).getByTestId("policy-citations-chips");
    expect(chips.textContent).toContain("Citing document type:Clinical guidelines");
  });

  it("related: Patent citations beside All reports, by its current name and address, carrying the who-filters only; absent while the flag is off", async () => {
    const off = await page({ basis: "cy", unit: "dept:N1" });
    expect(off.getByTestId("related").textContent).toBe("");
    cleanup();

    vi.stubEnv("PATENT_CITATIONS_REPORT", "on");
    const v = await page({
      basis: "fy",
      from: "2021",
      level: "guideline",
      body: "WHO",
      excl: "1",
      cfrom: "2022",
      unit: ["dept:N1", "center:C7"],
      type: "full_time_faculty",
      person: ["abc1001", "abc1002"],
      pos: "first",
      q: "sample",
      sort: "recent",
    });
    const related = v.getByTestId("policy-citations-related");
    expect(related.textContent).toBe("· Related: Patent citations (renamed)");
    const [path, query] = within(related).getByRole("link").getAttribute("href")!.split("?");
    expect(path).toBe("/edit/reports/patents-renamed");
    // Person type, unit, person and author position ride along; report 24's own filters and view state do not.
    expect(query).toBe("type=full_time_faculty&unit=dept%3AN1&unit=center%3AC7&person=abc1001&person=abc1002&pos=first&basis=cy");
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
  });

  it("By publication: chips count grouped documents; the expander opens editions, how it cites, and a closed group for an unticked type", async () => {
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

    fireEvent.click(toggle);
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
    // Reviews: a heading that starts its own group, counted, closed, and it says why.
    const off = within(detail).getByTestId("policy-citations-off-review");
    const heading = within(off).getByRole("heading", { name: "Systematic reviews · 3" });
    expect(heading.querySelector("svg")).toBeTruthy();
    expect(off.className).toContain("mt-5");
    expect(off.textContent).toBe("Systematic reviews · 3This type is switched off in the filtersShow");
    // Heading, note and Show / Hide share one line; there is no other link to the reviews.
    const show = within(off).getByRole("button", { name: "Show" });
    expect(show.parentElement).toBe(heading.parentElement);
    expect(within(off).getAllByRole("button")).toHaveLength(1);
    expect(within(off).queryByRole("link")).toBeNull();
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(detail.textContent).toContain("Sample review 6");
    expect(detail.textContent).toContain("The newest 1 of 3 systematic reviews.");
    fireEvent.click(within(off).getByRole("button", { name: "Hide" }));
    expect(detail.textContent).not.toContain("Sample review 6");

    // Paging: 50 a page, Previous off on the first.
    const pager = v.getByTestId("policy-citations-pager");
    expect(pager.textContent).toContain("1–50 of 5,080");
    expect(within(pager).getByRole("button", { name: "Previous" })).toHaveProperty("disabled", true);
    expect(within(pager).getByRole("link", { name: "Next" }).getAttribute("href")).toContain("page=2");
    // Search and sort ride one GET form that keeps the filters.
    const form = v.getByTestId("policy-citations-toolbar");
    expect(within(form).getByLabelText("Search title, PMID or author")).toBeTruthy();
    expect(within(form).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Health authorities first, then most documents",
      "Most guidelines",
      "Most recently cited",
      "Publication year",
    ]);
    expect(form.querySelector('input[type="hidden"][name="from"]')?.getAttribute("value")).toBe("2020");
  });

  it("By publication: a Cited by chip opens the row to its own documents; the count toggle still shows all", async () => {
    const who = doc(7, {
      level: "authority",
      title: "Sample Handbook",
      year: 2022,
      issuingBody: "WHO",
      authors: null,
      journal: null,
      pmid: null,
      bookshelfId: "NBK000007",
      url: "https://www.ncbi.nlm.nih.gov/books/NBK000007/",
    });
    h.docs.mockResolvedValue(new Map([[PUB.pmid, [...DOCS.slice(0, 3), who, ...DOCS.slice(3)]]]));
    // Reviews ticked too, so they have a chip of their own.
    const v = await page({ basis: "cy" });
    const row = v.getByTestId("policy-citations-pub-row");
    const shown = () => within(row).getByTestId("policy-citations-docs").textContent ?? "";
    const chip = (name: string) => within(row).getByRole("button", { name });
    const toggle = () => within(row).getByRole("button", { name: /citing documents$/ });

    // One body's chip: that body's document, and nothing else.
    fireEvent.click(chip("WHO · 1"));
    expect(chip("WHO · 1").getAttribute("aria-pressed")).toBe("true");
    expect(shown()).toContain("Sample Handbook");
    expect(shown()).not.toContain("Living Review of Sample Care");
    expect(shown()).not.toContain("Sample guideline");
    expect(shown()).not.toContain("Sample review 6");
    // The count toggle is still an opener: it has not turned into "Hide".
    expect(toggle().textContent).toBe("7 citing documents");

    // Another body's: it replaces the first.
    fireEvent.click(chip("AHRQ · 1"));
    expect(chip("WHO · 1").getAttribute("aria-pressed")).toBe("false");
    expect(shown()).toContain("Living Review of Sample Care: 2025 Update");
    expect(shown()).not.toContain("Sample Handbook");
    expect(shown()).not.toContain("Sample guideline");

    // A type's chip: that type's documents only.
    fireEvent.click(chip("2 guidelines"));
    expect(shown()).toContain("Sample guideline 4");
    expect(shown()).toContain("Sample guideline 5");
    expect(shown()).not.toContain("Health authority");
    expect(shown()).not.toContain("Sample review 6");
    fireEvent.click(chip("3 systematic reviews"));
    expect(shown()).toContain("Sample review 6");
    expect(shown()).toContain("The newest 1 of 3 systematic reviews.");
    expect(shown()).not.toContain("Sample guideline");

    // The count toggle shows everything, whatever chip was open.
    fireEvent.click(toggle());
    for (const t of ["Sample Handbook", "Living Review of Sample Care: 2025 Update", "Sample guideline 4", "Sample review 6"]) {
      expect(shown()).toContain(t);
    }
    expect(chip("3 systematic reviews").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(row).getByRole("button", { name: "Hide citing documents" }));
    expect(within(row).queryByTestId("policy-citations-docs")).toBeNull();

    // Pressing an open chip again closes the row.
    fireEvent.click(chip("WHO · 1"));
    fireEvent.click(chip("WHO · 1"));
    expect(within(row).queryByTestId("policy-citations-docs")).toBeNull();
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

  it("person card: the name only opens the card; its button adds the person to those ticked and lands on By publication", async () => {
    const v = await page({ basis: "cy", level: "guideline", sort: "recent", person: "abc1002", q: "sample" });
    // The pill is not a link and filters nothing by itself.
    const pill = within(v.getByTestId("policy-citations-publications")).getByText("Example Person");
    expect(pill.closest("a")).toBeNull();
    expect(pill.closest("button")).toBeNull();
    const f = footerOf("abc1001");
    const button = within(f.getByTestId("action")).getByRole("link", { name: "Show only this person\u2019s papers" });
    const [path, query] = button.getAttribute("href")!.split("?");
    expect(path).toBe(BASE);
    // Added to whoever was ticked (papers by either); every other filter, the sort and the search stay.
    expect(query).toBe("person=abc1002&person=abc1001&level=guideline&basis=cy&sort=recent&q=sample");
    // The bibliometrics link is gated off here: only the button is added.
    expect(f.getByTestId("link").textContent).toBe("");
  });

  it("person card on By person: the same button, back on By publication, the people search dropped", async () => {
    await page({ basis: "cy", view: "people", q: "exam", page: "1" });
    const q = queryOf(within(footerOf("abc1001").getByTestId("action")).getByRole("link").getAttribute("href"));
    expect(q.getAll("person")).toEqual(["abc1001"]);
    expect(q.has("view")).toBe(false);
    expect(q.has("q")).toBe(false);
    // Already ticked: pressing it again adds nobody twice.
    cleanup();
    await page({ basis: "cy", view: "people", person: "abc1001" });
    const again = queryOf(within(footerOf("abc1001").getByTestId("action")).getByRole("link").getAttribute("href"));
    expect(again.getAll("person")).toEqual(["abc1001"]);
  });

  it("bibliometrics link, gate closed: asked once for the page's people, and offered for no one", async () => {
    const second = { ...PUB, pmid: "10000002", authors: [...PUB.authors, { cwid: "abc1002", name: "Sample Author", position: "last" as const }] };
    h.citations.mockResolvedValue(data({ pubs: [PUB, second] }));
    h.docs.mockResolvedValue(new Map());
    const v = await page({ basis: "cy" });
    // One batched decision: each person once, however many pills name them.
    expect(h.access).toHaveBeenCalledTimes(1);
    expect(h.access.mock.calls[0][0]).toEqual(["abc1001", "abc1002"]);
    expect(v.queryByText("Full bibliometrics report")).toBeNull();
    expect(footerOf("abc1001").queryByText("Full bibliometrics report")).toBeNull();
    cleanup();

    const people = await page({ basis: "cy", view: "people" });
    expect(h.access).toHaveBeenCalledTimes(2);
    expect(h.access.mock.calls[1][0]).toEqual(["abc1001"]);
    expect(people.queryByText("Full bibliometrics report")).toBeNull();
    cleanup();

    // By citing document names no one: nobody to ask about.
    await page({ basis: "cy", view: "documents" });
    expect(h.access.mock.calls[2][0]).toEqual([]);
  });

  it("bibliometrics link, gate open for one person: on their card and their By person row, not the other's", async () => {
    h.access.mockResolvedValue(new Set(["abc1001"]));
    const other = { ...PERSON, cwid: "abc1002", name: "Sample Author" };
    h.citations.mockResolvedValue(data({ people: [PERSON, other], facetPeople: [PERSON, other] }));
    const v = await page({ basis: "cy", view: "people" });
    expect(h.access).toHaveBeenCalledTimes(1);
    expect(h.access.mock.calls[0][0]).toEqual(["abc1001", "abc1002"]);
    const [mine, theirs] = v.getAllByTestId("policy-citations-person-row");
    const link = within(mine).getByRole("link", { name: "Full bibliometrics report" });
    expect(link.getAttribute("href")).toBe("/edit/scholar/abc1001?attr=bibliometrics");
    expect(within(theirs).queryByRole("link", { name: "Full bibliometrics report" })).toBeNull();
    // The card: the link beside where Public profile goes, for the same person only.
    const f = footerOf("abc1001");
    expect(within(f.getByTestId("link")).getByRole("link", { name: "Full bibliometrics report" }).getAttribute("href")).toBe(
      "/edit/scholar/abc1001?attr=bibliometrics",
    );
    expect(footerOf("abc1002").getByTestId("link").textContent).toBe("");
    expect(within(footerOf("abc1002").getByTestId("action")).getByRole("link")).toBeTruthy();
  });

  it("chips: one removable chip per ticked person, by name; an unnamed CWID is marked and in mono", async () => {
    const others = ["abc1002", "abc1003", "abc1004"].map((cwid, i) => ({ ...PERSON, cwid, name: `Sample Author ${i + 2}` }));
    h.citations.mockResolvedValue(data({ facetPeople: [PERSON, ...others] }));
    const v = await page({ basis: "cy", person: ["abc1001", "abc1002", "abc1003", "abc1004", "zzz9999"] });
    const chips = within(v.getByTestId("policy-citations-chips"))
      .getAllByRole("listitem")
      .filter((li) => li.textContent!.startsWith("Person:"));
    expect(chips.map((li) => li.textContent)).toEqual([
      "Person:Example Person",
      "Person:Sample Author 2",
      "Person:Sample Author 3",
      "Person:Sample Author 4",
      "Person:Unknown personzzz9999",
    ]);
    const remove = queryOf(within(chips[1]).getByRole("link", { name: "Remove Person: Sample Author 2" }).getAttribute("href"));
    expect(remove.getAll("person")).toEqual(["abc1001", "abc1003", "abc1004", "zzz9999"]);
    expect(within(chips[4]).getByText("zzz9999").className).toContain("font-mono");
    expect(within(chips[4]).getByRole("link", { name: "Remove Person: Unknown person zzz9999" })).toBeTruthy();
    // The rail's Person checklist names no one by CWID either.
    const rail = v.getAllByTestId("policy-citations-person")[0];
    expect(rail.textContent).toContain("Unknown person");
    expect(rail.textContent).not.toContain("zzz9999");
  });
});
