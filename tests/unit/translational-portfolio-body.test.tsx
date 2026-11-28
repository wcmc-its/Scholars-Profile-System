/**
 * @vitest-environment jsdom
 *
 * Report 26's page (`translational-portfolio-body.tsx`): its door into report
 * 27 (the "T0 and T1 later cited by clinical studies" tile is drawn only when
 * its loader returns one, its two numbers are links to the lists they count,
 * and the page is what it was without it), and the redesign's rules — shares
 * among staged publications, Stage assigned beside them, gaps marked in their
 * cells, the table's first rows until "View all", "–" for a stage with no
 * papers, and no scholar list in a printout over the export cap. The loaders
 * are mocked; that the numbers equal the lists is
 * `downstream-reach-report.test.ts`. Fixture units, areas, people and counts
 * are invented.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ portfolio: vi.fn(), tile: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  loadPortfolio: h.portfolio,
  loadPortfolioChoices: async () => ({
    facets: {
      roleCategories: [],
      departments: [{ value: "dept:N1", label: "Department of Examples", count: 40, divisions: [] }],
      centers: [],
      institutions: [],
    },
    labels: new Map([["dept:N1", "Department of Examples"]]),
    areas: [{ id: "area_a", label: "Example area" }],
  }),
}));
vi.mock("@/lib/edit/downstream-reach-entry", () => ({ loadPortfolioReachTile: h.tile }));

import { renderTranslationalPortfolioReport } from "@/components/edit/reports/translational-portfolio-body";
import type { PortfolioReachTile } from "@/lib/edit/downstream-reach-entry";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { parsePortfolioParams, type PortfolioData } from "@/lib/edit/translational-portfolio-report";

const SESSION = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false } as AdminReportProps["session"];
const BASE = "/edit/reports/translational-portfolio";
const counts = { T0: 40, T1: 30, T2: 20, "T3-4": 10, none: 25 };
const DATA: PortfolioData = {
  all: counts,
  byYear: [
    { year: 2020, counts },
    { year: 2021, counts },
  ],
  baseline: counts,
  table: [],
  areaCoverage: { sized: 4, spanning: 3 },
  areaOrder: [],
  scholars: { total: 0, rows: [] },
  person: null,
  lookup: [],
  activities: { total: 0, pmids: [] },
};
const TILE: PortfolioReachTile = {
  cited: 1234,
  total: 5678,
  citedHref: "/edit/reports/27?unit=dept%3AN1&stage=T0&stage=T1&ctype=clinical&basis=cy&from=2020&to=2021",
  totalHref: "/edit/reports/27?unit=dept%3AN1&stage=T0&stage=T1&ctype=clinical&basis=cy&from=2020&to=2021&show=all",
};
const SP = { unit: "dept:N1", from: "2020", to: "2021" };

async function page(searchParams: AdminReportProps["searchParams"] = SP) {
  const out = await renderTranslationalPortfolioReport({ n: "26", session: SESSION, searchParams, basePath: BASE });
  return render(<>{out.main}</>);
}
/** Each tile as [label, value, sub]. */
const tiles = (root: HTMLElement) =>
  [...within(root).getByTestId("portfolio-tiles").children].map((t) => [...t.children].map((x) => x.textContent));

beforeEach(() => {
  h.portfolio.mockReset().mockResolvedValue(DATA);
  h.tile.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe("report 26's Downstream reach tile", () => {
  const FOUR = [
    ["Publications, 2020 to 2021", "125", "80% have a stage"],
    ["Areas spanning T0 to T3–4", "3 of 4", "See the 1 with a gap"],
  ];

  it("is not drawn when its loader returns none, and the tiles are the two the page has", async () => {
    const { container } = await page();
    expect(tiles(container)).toEqual(FOUR);
    expect(within(container).queryByTestId("portfolio-reach-cited")).toBeNull();
    expect(container.textContent).not.toContain("cited by clinical studies");
    expect(container.innerHTML).not.toContain("/edit/reports/27");
  });

  it("asks for the tile under the page's own filters and the viewer's session", async () => {
    await page({ ...SP, area: "area_a", stage: "T2" });
    expect(h.tile).toHaveBeenCalledTimes(1);
    expect(h.tile).toHaveBeenCalledWith(
      parsePortfolioParams(new URLSearchParams("unit=dept:N1&from=2020&to=2021&area=area_a&stage=T2")),
      SESSION,
    );
  });

  it("draws N of M after the other tiles, each number a link to the list it counts", async () => {
    h.tile.mockResolvedValue(TILE);
    const { container } = await page();
    const all = tiles(container);
    expect(all.slice(0, 2)).toEqual(FOUR);
    expect(all[2]).toEqual([
      "T0 and T1 later cited by clinical studies",
      "1,234 of 5,678",
      "Clinical studies by a publication's own authors are not counted.",
    ]);
    const cited = within(container).getByTestId("portfolio-reach-cited");
    const total = within(container).getByTestId("portfolio-reach-total");
    expect(cited.getAttribute("href")).toBe(TILE.citedHref);
    expect(cited.textContent).toBe("1,234");
    expect(total.getAttribute("href")).toBe(TILE.totalHref);
    expect(total.textContent).toBe("5,678");
    expect(cited.getAttribute("aria-label")).toBe(
      "1,234 T0 and T1 publications cited by clinical studies, in the Downstream reach report",
    );
    // The same markup as the tiles beside it.
    const el = within(container).getByTestId("portfolio-tiles").children;
    expect(el[2].className).toBe(el[1].className);
    expect([...el[2].children].map((x) => x.className)).toEqual([...el[1].children].map((x) => x.className));
  });

  it("leaves the rest of the page as it was", async () => {
    const strip = (html: string) => html.replace(/ id="[^"]*"| aria-labelledby="[^"]*"| for="[^"]*"/g, "");
    const before = strip((await page()).container.innerHTML);
    cleanup();
    h.tile.mockResolvedValue(TILE);
    const { container } = await page();
    within(container).getByTestId("portfolio-tiles").children[2].remove();
    expect(strip(container.innerHTML)).toBe(before);
  });

  it("still draws the page when the tile fails to load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.tile.mockRejectedValue(new Error("boom"));
    const { container } = await page();
    expect(tiles(container)).toEqual(FOUR);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

type Row = PortfolioData["table"][number];
const row = (key: string, over: Partial<Row> = {}): Row => ({
  key,
  label: `Area ${key}`,
  href: `area=${key}`,
  note: "12 scholars",
  noteHref: `area=${key}`,
  gaps: [],
  counts: { T0: 50, T1: 30, T2: 15, "T3-4": 5, none: 100 },
  ...over,
});
const scholar = (i: number): PortfolioData["scholars"]["rows"][number] => ({
  cwid: `abc${1000 + i}`,
  name: `Example Person ${i}`,
  title: "Professor",
  department: "Examples",
  slug: null,
  n: 6,
  counts: { T0: 0, T1: 0, T2: 1, "T3-4": 5, none: 2 },
  works: [{ pmid: `9${i}`, title: "An example paper.", year: 2021, stage: "T3-4" }],
});

describe("report 26's redesigned page", () => {
  it("shares each year among staged publications, with Stage assigned beside them", async () => {
    const { container } = await page();
    const rows = within(container).getByTestId("portfolio-stage-rows");
    // 40/30/20/10 of the 100 staged; 25 more have no stage, so 80% are staged.
    const cells = [...rows.querySelectorAll('[role="cell"][aria-label]')].map((c) => c.getAttribute("aria-label"));
    expect(cells[0]).toBe("T0 40%, T1 30%, T2 20%, T3–4 10%; stage assigned 80%");
    expect(rows.textContent).toContain("80%");
  });

  it("marks a gap in its stage cell, not in the area's name, and links the scholar count", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, table: [row("a", { gaps: ["T3-4"], counts: { T0: 80, T1: 15, T2: 4, "T3-4": 1, none: 0 } })] });
    const { container } = await page({ ...SP, by: "area" });
    const table = within(container).getByTestId("portfolio-table");
    const [, , , , , , last] = [...table.querySelectorAll("tbody tr")[0].children];
    expect(last.textContent).toContain("Gap");
    expect(table.querySelector("tbody th")!.textContent).not.toContain("Gap");
    const people = within(table).getByRole("link", { name: "View 12 scholars in Area a" });
    expect(people.getAttribute("href")).toBe(`${BASE}?area=a#items`);
  });

  it("shows the first rows until View all, then every row", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => row(String(i)));
    h.portfolio.mockResolvedValue({ ...DATA, table: ten });
    const short = await page();
    expect(within(short.container).getByTestId("portfolio-table").querySelectorAll("tbody tr")).toHaveLength(9);
    expect(within(short.container).getByTestId("portfolio-table-all").textContent).toBe("View all 10 departments");
    cleanup();
    const full = await page({ ...SP, rows: "all" });
    expect(within(full.container).getByTestId("portfolio-table").querySelectorAll("tbody tr")).toHaveLength(10);
  });

  it("draws a scholar's stages as columns, a dash for none, and a link to their portfolio", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 1, rows: [scholar(1)] } });
    const { container } = await page();
    const li = within(container).getByTestId("portfolio-scholar");
    expect(li.textContent).toContain("6 staged papers");
    expect(li.textContent).toMatch(/T0–T1–T21T3–45/);
    const link = within(li).getByRole("link", { name: "Translational portfolio for Example Person 1" });
    expect(link.getAttribute("href")).toContain("cwid=abc1001");
    expect(within(li).getByRole("link", { name: "91" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/91/");
  });

  it("keeps every unit of an old several-unit link through a rail change, and says so", async () => {
    const { container } = await page({ ...SP, unit: ["dept:N1", "dept:N2"] });
    const form = within(container).getAllByTestId("portfolio-filters")[0];
    expect([...form.querySelectorAll('input[type="hidden"][name="unit"]')].map((i) => i.getAttribute("value"))).toEqual(["dept:N2"]);
    expect(within(container).getAllByTestId("portfolio-rail-units-note")[0].textContent).toContain("This link selects 2 units");
  });

  it("leaves the scholar list out of a printout over the export cap, and only then", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 50, rows: [scholar(1)] } });
    const at = await page();
    expect(within(at.container).getByTestId("portfolio-scholars").querySelector("ul")!.className).not.toContain("print:hidden");
    cleanup();
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 51, rows: [scholar(1)] } });
    const over = await page();
    const list = within(over.container).getByTestId("portfolio-scholars");
    expect(list.querySelector("ul")!.className).toContain("print:hidden");
    expect(list.textContent).toContain("left out of printouts over 50 scholars");
  });
});

describe("report 26 with nothing to compare", () => {
  const WCM = { T0: 1, T1: 1, T2: 1, "T3-4": 97, none: 0 };
  const bottomRow = (root: HTMLElement) => {
    const rows = within(root).getByTestId("portfolio-stage-rows").children;
    return rows[rows.length - 1].textContent;
  };

  it("compares a unit with all of WCM, but a scholar in a unit with their own years, since the baseline keeps the scholar", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, baseline: WCM });
    const unit = (await page()).container;
    expect(bottomRow(unit)).toContain("All of WCM");
    expect(bottomRow(unit)).toContain("97%");
    cleanup();
    const scholar = (await page({ ...SP, cwid: "abc1234" })).container;
    expect(bottomRow(scholar)).toContain("All years");
    expect(bottomRow(scholar)).not.toContain("97%");
    expect(scholar.textContent).not.toContain("All of WCM");
  });

  it("drops the areas tile when no area is big enough to check, and the reach tile when it counts nothing", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, areaCoverage: { sized: 0, spanning: 0 } });
    h.tile.mockResolvedValue({ ...TILE, cited: 0, total: 0 });
    const { container } = await page();
    expect(tiles(container)).toEqual([["Publications, 2020 to 2021", "125", "80% have a stage"]]);
    expect(container.textContent).not.toContain("0 of 0");
  });
});

describe("report 26's primary institution filter", () => {
  it("shows each institution as a chip and passes it to the reach tile loader", async () => {
    h.tile.mockResolvedValue(TILE);
    const { container } = await page({ ...SP, inst: ["HSS", "WCMC"] });
    const chips = within(container).getByTestId("portfolio-chips");
    expect(chips.textContent).toContain("Hospital for Special Surgery");
    expect(chips.textContent).toContain("Weill Cornell Medicine");
    expect(h.tile.mock.calls[0][0].insts).toEqual(["HSS", "WCMC"]);
  });
});
