/**
 * @vitest-environment jsdom
 *
 * Report 26's page (`translational-portfolio-body.tsx`) and its door into
 * report 27: the tile "T0 and T1 publications later cited by clinical studies"
 * is drawn only when its loader returns one, its two numbers are links to the
 * lists they count, and the page is what it was without it. The loaders are
 * mocked; that the numbers equal the lists is `downstream-reach-report.test.ts`.
 * Fixture units, areas and counts are invented.
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
    ["Publications with a stage", "100", "Of 125 publications"],
    ["T2 and T3–4", "24%", "Share in 2021; 24% in 2020"],
    ["Areas spanning T0 to T3–4", "3 of 4", "See the 1 with a gap"],
    ["No stage", "20%", "Low confidence, or outside the spectrum"],
  ];

  it("is not drawn when its loader returns none, and the tiles are the four the page had", async () => {
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

  it("draws N of M after the four tiles, each number a link to the list it counts", async () => {
    h.tile.mockResolvedValue(TILE);
    const { container } = await page();
    const all = tiles(container);
    expect(all.slice(0, 4)).toEqual(FOUR);
    expect(all[4]).toEqual([
      "T0 and T1 publications later cited by clinical studies",
      "1,234 of 5,678",
      "Of the T0 and T1 publications in these filters. Clinical studies by a publication's own authors are not counted.",
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
    expect(el[4].className).toBe(el[3].className);
    expect([...el[4].children].map((x) => x.className)).toEqual([...el[3].children].map((x) => x.className));
  });

  it("leaves the rest of the page as it was", async () => {
    const strip = (html: string) => html.replace(/ id="[^"]*"| aria-labelledby="[^"]*"| for="[^"]*"/g, "");
    const before = strip((await page()).container.innerHTML);
    cleanup();
    h.tile.mockResolvedValue(TILE);
    const { container } = await page();
    within(container).getByTestId("portfolio-tiles").children[4].remove();
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
