/**
 * Report 25's page (`patent-citations-body.tsx`): the header sentence and
 * export note, the lag notice, the rail's two groups, the three tiles, the
 * assignee card and the year chart, the three tabs with counts, a By
 * publication row and its expander (related patents, the no-assignee
 * fallback, a published application), the By invention and By person rows,
 * the pager, the sources line, and the flag backstop. The loaders are mocked;
 * their SQL and scoping are `patent-citations-report.test.ts`. Fixture
 * people, papers, patents and assignees are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  citations: vi.fn(),
  pubs: vi.fn(),
  inventions: vi.fn(),
  personInventions: vi.fn(),
  scope: { value: null as string[] | null },
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({
    roleCategories: [],
    departments: [{ value: "dept:N1", label: "Department of Examples", count: 40, divisions: [] }],
    centers: [],
    institutions: [],
  })),
}));
vi.mock("@/lib/edit/patent-citations-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/patent-citations-report")>()),
  resolvePatentCitationParams: async (p: object) => ({ ...p, scope: h.scope.value }),
  loadPatentCitations: h.citations,
  withPublicationDetails: h.pubs,
  withInventionDetails: h.inventions,
  loadPersonInventions: h.personInventions,
}));

import { renderPatentCitationsReport } from "@/components/edit/reports/patent-citations-body";
import type {
  CitingInvention,
  InventionRow,
  PatentCitationData,
  PatentPersonRow,
  PatentPubRow,
} from "@/lib/edit/patent-citations-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const BASE = "/edit/reports/patent-citations";
const citing = (id: number, over: Partial<CitingInvention> = {}): CitingInvention => ({
  id,
  key: `1500000${id}`,
  title: `Example composition ${id}`,
  url: `https://patents.google.com/patent/US9000000${id}B2/en`,
  number: `US9000000${id}B2`,
  assignees: ["Example Biotech, Inc."],
  firstInventor: "Ada Sample",
  inventors: 3,
  year: 2019,
  application: false,
  docs: 1,
  where: "body",
  ...over,
});
const PUB: PatentPubRow = {
  pmid: "10000001",
  title: "An example study of sample binding",
  journal: "Journal of Examples",
  doi: null,
  year: 2004,
  inventions: 31,
  latest: 2024,
  authors: [{ cwid: "abc1001", name: "Example Person", position: "last" }],
  shown: [
    citing(1),
    citing(2, { docs: 4, where: "front", year: 2021 }),
    citing(3, {
      assignees: [],
      application: true,
      year: 2023,
      number: "US20230000003A1",
      url: "https://patents.google.com/patent/US20230000003A1/en",
      where: "both",
    }),
  ],
};
const INVENTION: InventionRow = {
  key: "15000001",
  docId: 1,
  year: 2019,
  application: false,
  docs: 6,
  papers: 40,
  title: "Example composition 1",
  url: "https://patents.google.com/patent/US90000001B2/en",
  number: "US90000001B2",
  assignees: ["Example Biotech, Inc."],
  firstInventor: "Ada Sample",
  inventors: 3,
  shown: [{ pmid: "10000001", title: "An example study of sample binding", journal: "Journal of Examples", year: 2004 }],
};
const PERSON: PatentPersonRow = {
  cwid: "abc1001",
  name: "Example Person",
  orgUnit: "Department of Examples",
  personType: "Full-time faculty",
  institution: "Weill Cornell Medicine",
  papers: 12,
  inventions: null,
};
const counts = (n: number) => Array.from({ length: n }, (_, i) => ({ pmid: String(10000001 + i), year: 2004, inventions: 1, latest: null }));
const data = (over: Partial<PatentCitationData> = {}): PatentCitationData => ({
  scope: { papers: 180000, people: 5400 },
  pubTotal: 24366,
  pubs: counts(120),
  inventionTotal: 68000,
  inventions: Array.from({ length: 70 }, (_, i) => ({ key: `k${i}`, docId: i + 1, year: 2019, application: false, docs: 1, papers: 1 })),
  years: Array.from({ length: 10 }, (_, i) => ({ year: 2016 + i, count: 100 * (i + 1) })),
  assignees: [
    { name: "Example Biotech, Inc.", inventions: 630, papers: 514 },
    { name: "Sample University", inventions: 120, papers: 200 },
  ],
  assigneeOptions: [
    { name: "Example Biotech, Inc.", inventions: 630, papers: 514 },
    { name: "Sample University", inventions: 120, papers: 200 },
  ],
  peopleTotal: 2500,
  people: [PERSON],
  facetPeople: [PERSON],
  ...over,
});

async function page(query: Record<string, string | string[]> = {}) {
  const props = { n: "25", session: { cwid: "sup0001", isSuperuser: true }, searchParams: query, basePath: BASE };
  const out = await renderPatentCitationsReport(props as unknown as AdminReportProps);
  return render(
    <>
      <div data-testid="subtitle">{out.subtitle}</div>
      <div data-testid="aside">{out.aside}</div>
      {out.main}
    </>,
  );
}

beforeEach(() => {
  vi.stubEnv("PATENT_CITATIONS_REPORT", "on");
  h.scope.value = null;
  h.citations.mockReset().mockResolvedValue(data());
  h.pubs.mockReset().mockResolvedValue([PUB]);
  h.inventions.mockReset().mockResolvedValue([INVENTION]);
  h.personInventions.mockReset().mockResolvedValue(new Map([["abc1001", 57]]));
});

describe("report 25 page", () => {
  it("flag off: the body is not found, and loads nothing", async () => {
    vi.stubEnv("PATENT_CITATIONS_REPORT", "off");
    await expect(page()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(h.citations).not.toHaveBeenCalled();
  });

  it("a viewer with no unit is not found", async () => {
    h.scope.value = [];
    await expect(page()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(h.citations).not.toHaveBeenCalled();
  });

  it("header: the count and the active filters; the export beside it, with the sheets and what is cut", async () => {
    const v = await page();
    expect(v.getByTestId("subtitle").textContent).toBe(
      "24,366 papers cited in a US patent · any publication year · all units",
    );
    expect(v.getByTestId("patent-citations-download-note").textContent).toBe(
      "Publications, Inventions, People and Criteria sheets · Publications lists the first 5,000 of 24,366 · Inventions lists the first 20,000 of 68,000",
    );
    expect(v.getByTestId("patent-citations-download").getAttribute("href")).toBe(
      "/api/edit/reports/patent-citations?basis=cy",
    );
    expect(v.getByRole("link", { name: "Export spreadsheet" })).toBeTruthy();
    cleanup();

    h.scope.value = ["dept:N1"];
    h.citations.mockResolvedValue(data({ pubTotal: 12, inventionTotal: 30 }));
    const narrowed = await page({
      basis: "cy",
      from: "2001",
      cfrom: "2015",
      assignee: "Example Biotech, Inc.",
      where: "front",
      q: "sample",
    });
    expect(narrowed.getByTestId("subtitle").textContent).toBe(
      "12 papers cited in a US patent · published 2001 or later · Department of Examples · patents granted or published 2015 or later · assignee Example Biotech, Inc. · cited on the front page",
    );
    expect(narrowed.getByTestId("patent-citations-download-note").textContent).toBe(
      "Publications, Inventions, People and Criteria sheets",
    );
    // The search stays on the page: the download is the filters, not the search box.
    expect(narrowed.getByTestId("patent-citations-download").getAttribute("href")).not.toContain("q=");
    // The viewer's unit shows in the rail and as a chip with no remove button.
    expect(narrowed.getAllByTestId("patent-citations-scope")[0].textContent).toBe("UnitDepartment of Examples");
    const chips = within(narrowed.getByTestId("patent-citations-chips")).getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual([
      "Unit:Department of Examples",
      "Published:2001 or later",
      "Patent year:2015 or later",
      "Assignee:Example Biotech, Inc.",
      "Where cited:Front page",
    ]);
    expect(within(chips[0]).queryByRole("link")).toBeNull();
    expect(within(chips[3]).getByRole("link").getAttribute("aria-label")).toBe("Remove Assignee: Example Biotech, Inc.");
  });

  it("the lag notice and the sources line are on the page", async () => {
    const v = await page();
    expect(v.getByTestId("patent-citations-lag-notice").textContent).toBe(
      "Patents usually cite a paper years after it is published: half of first citations come seven or more years later. Recent papers show few or none, so this report says little about the last five years of work.",
    );
    expect(v.getByTestId("patent-citations-sources").textContent).toContain(
      "Sources: Reliance on Science (Marx and Fuegi), CC BY-NC 4.0, with patent details from USPTO PatentsView. US patents only. A patent citing a paper does not mean the paper's authors hold the patent.",
    );
  });

  it("the rail: Citing patents, then Papers, publication year defaulting to Any; every control is labelled", async () => {
    const v = await page();
    const rail = v.getAllByTestId("patent-citations-rail")[0];
    expect([...rail.querySelectorAll("summary")].map((s) => s.textContent)).toEqual([
      "Year granted or publishedAny",
      "AssigneeAny",
      "Where citedFront page or text",
      "Publication yearAny · Calendar",
      "Org unitAll org units",
      "Person typeAny",
      "PersonAny",
      "Author positionAny",
    ]);
    expect(rail.textContent).toContain("Citing patentsWhich patents are counted, in every number.");
    expect(rail.textContent).toContain("PapersWhich authorships, and so which papers, are in scope.");
    expect(within(rail).getByLabelText("From patent year")).toBeTruthy();
    expect(within(rail).getByLabelText("To publication year")).toBeTruthy();
    expect((within(rail).getByLabelText("Front page or text") as HTMLInputElement).checked).toBe(true);
    expect(within(rail).getByLabelText(/Example Biotech, Inc\./)).toBeTruthy();
    // Nothing set: the reset link is disabled.
    expect(within(rail).queryByRole("link", { name: "Reset to defaults" })).toBeNull();
    for (const input of rail.querySelectorAll("input:not([type=hidden]), select")) {
      const labelled = input.closest("label") !== null || input.hasAttribute("aria-label") || input.id !== "";
      expect(labelled, input.outerHTML).toBe(true);
    }
  });

  it("tiles: papers with their share of the scope, inventions, people out of the people in scope", async () => {
    const v = await page();
    expect([...v.getByTestId("patent-citations-tiles").children].map((t) => t.textContent)).toEqual([
      "Papers cited in a patent24,36613.5% of 180,000 papers in scope",
      "Citing inventions68,000related patents counted once",
      "People with a cited paper2,500of 5,400 in scope",
    ]);
  });

  it("the assignee card links each name to its filter; the chart reads its ten years aloud", async () => {
    const v = await page();
    const card = v.getByTestId("patent-citations-assignees");
    const rows = within(card).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["Example Biotech, Inc.630514", "Sample University120200"]);
    expect(within(card).getByRole("link", { name: "Example Biotech, Inc." }).getAttribute("href")).toBe(
      `${BASE}?assignee=Example+Biotech%2C+Inc.&basis=cy`,
    );
    expect(card.textContent).toContain("Top ten. Assignee names are as USPTO records them");
    const chart = v.getByTestId("patent-citations-years-chart");
    expect(within(chart).getByRole("heading").textContent).toBe("Citing inventions by year granted");
    const label = within(chart).getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("100 in 2016");
    expect(label).toContain("1,000 in 2025");
    expect(chart.textContent).toContain("The patent data ends at 31 December 2025.");
  });

  it("tabs: three, with counts, the current one marked; fifty rows a page", async () => {
    const v = await page({ basis: "cy", page: "2" });
    const tabs = within(v.getByRole("navigation", { name: "Report views" })).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "By publication (24,366)",
      "By invention (68,000)",
      "By person (2,500)",
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(tabs[1].getAttribute("href")).toBe(`${BASE}?basis=cy&view=inventions`);
    // Page 2 of the 120 listed: rows 51 to 100 get their details.
    const asked = h.pubs.mock.calls[0][1] as { pmid: string }[];
    expect(asked).toHaveLength(50);
    expect(asked[0].pmid).toBe("10000051");
    expect(h.pubs.mock.calls[0][2]).toEqual({ inventions: true });
    expect(h.inventions).not.toHaveBeenCalled();
    const pager = v.getByTestId("patent-citations-pager");
    expect(pager.textContent).toContain("51–100 of 120");
    expect(within(pager).getByRole("link", { name: "Next" }).getAttribute("href")).toBe(`${BASE}?basis=cy&page=3`);
    const toolbar = v.getByTestId("patent-citations-toolbar");
    expect(within(toolbar).getByLabelText("Search title, PMID or author")).toBeTruthy();
    expect([...(within(toolbar).getByLabelText("Sort by") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "Most citing inventions",
      "Most recently cited",
      "Publication year",
    ]);
  });

  it("a publication row: counts, the author with a hover card, and an expander over its citing inventions", async () => {
    const v = await page();
    const row = v.getByTestId("patent-citations-pub-row");
    expect(row.textContent).toContain("An example study of sample binding");
    expect(row.textContent).toContain("Journal of Examples · 2004 · PMID 10000001");
    expect(row.textContent).toContain("Example Person");
    expect(within(row).getByText("31")).toBeTruthy();
    expect(within(row).getByText("2024")).toBeTruthy();
    const expander = within(row).getByRole("button", { name: "31 citing inventions" });
    expect(expander.getAttribute("aria-expanded")).toBe("false");
    expect(within(row).queryByTestId("patent-citations-inventions")).toBeNull();

    fireEvent.click(expander);
    expect(within(row).getByRole("button", { name: "Hide citing inventions" }).getAttribute("aria-expanded")).toBe("true");
    const entries = within(row).getAllByTestId("patent-citations-invention");
    expect(entries.map((e) => e.textContent)).toEqual([
      "Example composition 1Example Biotech, Inc. · granted 2019 · US90000001B2 · cited in the patent's text",
      "Example composition 2Example Biotech, Inc. · granted 2021 · US90000002B2 · and 3 related patents · cited on the front page",
      "Example composition 3Ada Sample et al. · application published 2023 · US20230000003A1 · cited in the text and on the front page",
    ]);
    const link = within(entries[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://patents.google.com/patent/US90000001B2/en");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(row).getByTestId("patent-citations-inventions").textContent).toContain(
      "The newest 3 of 31 citing inventions.",
    );
  });

  it("By invention: one row per invention with its assignee, year and the papers it cites behind an expander", async () => {
    const v = await page({ basis: "cy", view: "inventions" });
    expect(h.pubs).not.toHaveBeenCalled();
    expect(h.inventions.mock.calls[0][2]).toEqual({ papers: true });
    const row = v.getByTestId("patent-citations-invention-row");
    expect(row.textContent).toContain("Example composition 1US90000001B2 · and 5 related patents");
    expect(row.textContent).toContain("Example Biotech, Inc.");
    expect(row.textContent).toContain("2019");
    const expander = within(row).getByRole("button", { name: "Show WCM papers cited (40)" });
    expect(expander.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expander);
    expect(within(row).getAllByRole("listitem")[0].textContent).toContain(
      "An example study of sample bindingJournal of Examples · 2004 · PMID 10000001",
    );
    expect(row.textContent).toContain("The newest 1 of 40.");
    const toolbar = v.getByTestId("patent-citations-toolbar");
    expect(within(toolbar).getByLabelText("Search patent title, number or assignee")).toBeTruthy();
    expect(v.getByTestId("patent-citations-pager").textContent).toContain("1–50 of 70");
  });

  it("By person: papers cited and citing inventions per person, the CWID in mono, the papers linked to that person", async () => {
    const v = await page({ basis: "cy", view: "people" });
    expect(h.personInventions.mock.calls[0][1]).toEqual(["abc1001"]);
    const row = v.getByTestId("patent-citations-person-row");
    expect([...row.children].map((c) => c.textContent)).toEqual([
      "Example Personabc1001",
      "Department of Examples",
      "Full-time faculty",
      "Weill Cornell Medicine",
      "12",
      "57",
    ]);
    expect(within(row).getByText("abc1001").className).toContain("font-mono");
    expect(within(row).getByRole("link", { name: "12" }).getAttribute("href")).toBe(`${BASE}?person=abc1001&basis=cy`);
    expect(within(v.getByTestId("patent-citations-toolbar")).getByLabelText("Search name or CWID")).toBeTruthy();
  });

  it("nothing matches: says so, by search or by filter", async () => {
    h.citations.mockResolvedValue(data({ pubs: [] }));
    h.pubs.mockResolvedValue([]);
    const v = await page({ basis: "cy", q: "nothing" });
    expect(v.getByText("No publications match the search.")).toBeTruthy();
    expect(v.getByTestId("patent-citations-pager").textContent).toContain("0 of 0");
  });
});
