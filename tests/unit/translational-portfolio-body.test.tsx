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

const h = vi.hoisted(() => ({ portfolio: vi.fn(), tile: vi.fn(), access: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  loadPortfolio: h.portfolio,
  loadPortfolioChoices: async () => ({
    facets: {
      roleCategories: [{ value: "full_time_faculty", label: "Full-time faculty", count: 30 }],
      departments: [{ value: "dept:N1", label: "Department of Examples", count: 40, divisions: [] }],
      centers: [],
      institutions: [],
    },
    labels: new Map([["dept:N1", "Department of Examples"]]),
    areas: [{ id: "area_a", label: "Example area" }],
  }),
}));
vi.mock("@/lib/edit/downstream-reach-entry", () => ({ loadPortfolioReachTile: h.tile }));
vi.mock("@/lib/edit/bibliometrics-access", () => ({ loadBibliometricsAccess: h.access }));

import { renderTranslationalPortfolioReport } from "@/components/edit/reports/translational-portfolio-body";
import type { PortfolioReachTile } from "@/lib/edit/downstream-reach-entry";
import type { AdminReportProps } from "@/lib/edit/report-registry";
import { parsePortfolioParams, type PortfolioData } from "@/lib/edit/translational-portfolio-report";

const SESSION = { cwid: "sup0001", isSuperuser: true, isCommsSteward: false } as AdminReportProps["session"];
const BASE = "/edit/reports/translational-portfolio";
const counts = { T0: 40, T1: 30, T2: 20, "T3-4": 10, none: 25 };
const DATA: PortfolioData = {
  all: counts,
  grants: 12,
  trials: 3,
  byYear: [
    {
      year: 2020,
      counts,
      grants: 6,
      trials: 1,
      trialCounts: { T0: 0, T1: 1, T2: 0, "T3-4": 0, none: 0 },
      grantCounts: { T0: 1, T1: 1, T2: 1, "T3-4": 0, none: 3 },
    },
    {
      year: 2021,
      counts,
      grants: 8,
      trials: 2,
      trialCounts: { T0: 0, T1: 1, T2: 1, "T3-4": 0, none: 0 },
      grantCounts: { T0: 1, T1: 2, T2: 2, "T3-4": 1, none: 2 },
    },
  ],
  trialStages: { all: { T0: 0, T1: 1, T2: 1, "T3-4": 0, none: 1 }, baseline: { T0: 0, T1: 10, T2: 30, "T3-4": 5, none: 15 } },
  grantStages: { all: { T0: 1, T1: 2, T2: 2, "T3-4": 1, none: 6 }, baseline: { T0: 10, T1: 10, T2: 20, "T3-4": 10, none: 50 } },
  baseline: counts,
  baselineActivities: null,
  table: [],
  areaCoverage: { sized: 4, spanning: 3 },
  areaOrder: [],
  scholars: { total: 0, rows: [] },
  person: null,
  activities: { total: 0, pmids: [] },
  grantList: { total: 0, rows: [] },
  trialList: { total: 0, rows: [] },
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
  h.access.mockReset().mockResolvedValue(new Set());
});
afterEach(cleanup);

describe("report 26's Downstream reach tile", () => {
  const GRANTS = ["Grants, 2020 to 2021", "12", "Active in these years, as PI, Co-PI or subaward PI. 50% have a stage."];
  const TRIALS = ["Clinical trials, 2020 to 2021", "3", "67% have a stage, from their trial phase"];
  const FOUR = [
    ["Publications, 2020 to 2021", "125", "80% have a stage"],
    GRANTS,
    TRIALS,
    ["Areas spanning T0 to T3–4", "3 of 4", "See the 1 with a gap"],
  ];

  it("is not drawn when its loader returns none, and the tiles are the four the page has", async () => {
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
    expect(all.slice(0, 4)).toEqual(FOUR);
    expect(all[4]).toEqual([
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
    expect(el[4].className).toBe(el[3].className);
    expect([...el[4].children].map((x) => x.className)).toEqual([...el[3].children].map((x) => x.className));
  });

  it("leaves the rest of the page as it was", async () => {
    const strip = (html: string) => html.replace(/ id="[^"]*"| aria-labelledby="[^"]*"| aria-controls="[^"]*"| for="[^"]*"/g, "");
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

type Row = PortfolioData["table"][number];
const row = (key: string, over: Partial<Row> = {}): Row => ({
  key,
  label: `Area ${key}`,
  href: `area=${key}`,
  note: "12 scholars",
  noteHref: `area=${key}`,
  gaps: [],
  counts: { T0: 50, T1: 30, T2: 15, "T3-4": 5, none: 100 },
  grants: 0,
  trials: 0,
  trialCounts: { T0: 0, T1: 0, T2: 0, "T3-4": 0, none: 0 },
  grantCounts: { T0: 0, T1: 0, T2: 0, "T3-4": 0, none: 0 },
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
  grants: 0,
  trials: 0,
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
    const [, , , , , , , , last] = [...table.querySelectorAll("tbody tr")[0].children];
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

  it("draws a scholar's stages as columns, a dash for none, and a link to their portfolio page under the filters", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 1, rows: [scholar(1)] } });
    h.access.mockResolvedValue(new Set(["abc1001"]));
    const { container } = await page({ ...SP, area: "area_a", inst: "INST1", by: "area" });
    const li = within(container).getByTestId("portfolio-scholar");
    expect(li.textContent).toContain("6 staged papers");
    expect(li.textContent).toMatch(/T0–T1–T21T3–45/);
    const link = within(li).getByRole("link", { name: "Translational portfolio for Example Person 1" });
    // Seeded from the report's years and area; the report's whole state rides in `r` for the way back.
    expect(link.getAttribute("href")).toBe(
      `/edit/scholar/abc1001/translational-portfolio?from=2020&to=2021&area=area_a&r=${encodeURIComponent("unit=dept%3AN1&from=2020&to=2021&area=area_a&inst=INST1&by=area")}`,
    );
    expect(within(li).getByRole("link", { name: "Example Person 1" }).getAttribute("href")).toBe(link.getAttribute("href"));
    expect(within(li).getByRole("link", { name: "91" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/91/");
  });

  it("asks once for the whole page who may be opened, and offers no portfolio for a scholar outside it", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 2, rows: [scholar(1), scholar(2)] } });
    h.access.mockResolvedValue(new Set(["abc1002"]));
    const { container } = await page();
    expect(h.access).toHaveBeenCalledTimes(1);
    expect(h.access).toHaveBeenCalledWith(["abc1001", "abc1002"]);
    const [one, two] = within(container).getAllByTestId("portfolio-scholar");
    expect(within(one).queryByRole("link", { name: /Translational portfolio/ })).toBeNull();
    expect(within(one).queryByRole("link", { name: "Example Person 1" })).toBeNull();
    expect(one.textContent).toContain("Example Person 1");
    expect(one.innerHTML).not.toContain("translational-portfolio");
    expect(within(two).getByRole("link", { name: "Translational portfolio for Example Person 2" })).toBeTruthy();
  });

  it("looks scholars up in the rail as you type, not in a card on the page", async () => {
    const { container } = await page({ ...SP, q: "Example" });
    const rail = within(container).getAllByTestId("portfolio-rail-scholar")[0];
    const input = within(rail).getByTestId("portfolio-lookup-input");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("name")).toBeNull(); // not a filter: the form never sends it
    expect(within(container).queryByTestId("portfolio-lookup")).toBeNull();
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

  it("compares a unit with all of WCM, and every year together without a unit", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, baseline: WCM });
    const unit = (await page()).container;
    expect(bottomRow(unit)).toContain("All of WCM");
    expect(bottomRow(unit)).toContain("97%");
    cleanup();
    const all = (await page({ from: "2020", to: "2021" })).container;
    expect(bottomRow(all)).toContain("All years");
    expect(all.textContent).not.toContain("All of WCM");
  });

  it("never scopes the report to one scholar: that is the scholar's own page now", async () => {
    const { container } = await page({ ...SP, cwid: "abc1234" });
    expect(h.portfolio.mock.calls[0][0].cwid).toBeNull();
    expect(h.tile.mock.calls[0][0].cwid).toBeNull();
    expect(container.innerHTML).not.toContain("abc1234");
    expect(within(container).queryByTestId("portfolio-person")).toBeNull();
  });

  it("drops the areas tile when no area is big enough to check, and the reach tile when it counts nothing", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, areaCoverage: { sized: 0, spanning: 0 } });
    h.tile.mockResolvedValue({ ...TILE, cited: 0, total: 0 });
    const { container } = await page();
    expect(tiles(container)).toEqual([
      ["Publications, 2020 to 2021", "125", "80% have a stage"],
      ["Grants, 2020 to 2021", "12", "Active in these years, as PI, Co-PI or subaward PI. 50% have a stage."],
      ["Clinical trials, 2020 to 2021", "3", "67% have a stage, from their trial phase"],
    ]);
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

describe("report 26's person type filter", () => {
  it("offers the types in the rail, shows each picked one as a removable chip, and passes it to the reach tile loader", async () => {
    h.tile.mockResolvedValue(TILE);
    const { container } = await page({ ...SP, type: "full_time_faculty" });
    const rail = within(container).getByTestId("portfolio-rail-type");
    const box = rail.querySelector<HTMLInputElement>('input[name="type"][value="full_time_faculty"]');
    expect(box?.checked).toBe(true);
    const chips = within(container).getByTestId("portfolio-chips");
    expect(chips.textContent).toContain("Full-time faculty");
    const remove = [...chips.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((x) => x.includes("unit=dept"));
    expect(remove.some((x) => !x.includes("type="))).toBe(true);
    expect(h.tile.mock.calls[0][0].types).toEqual(["full_time_faculty"]);
  });
  it("is everyone, and unticked, without a type", async () => {
    const { container } = await page();
    const rail = within(container).getByTestId("portfolio-rail-type");
    expect(rail.textContent).toContain("Everyone");
    expect(rail.querySelector<HTMLInputElement>('input[name="type"]')?.checked).toBe(false);
    expect(within(container).getByTestId("portfolio-chips").textContent).not.toContain("Person type");
  });
});

describe("report 26's grants and clinical trials", () => {
  const names = new Map([["abc1001", "Example Person 1"], ["abc1002", "Example Person 2"]]);
  const GRANT = {
    key: "R01CA000001",
    title: "An example award",
    funder: "NCI",
    awardNumber: "5 R01 CA000001-03",
    start: "2019-04-01",
    end: "2024-03-31",
    years: [2020, 2021],
    people: [{ cwid: "abc1001", role: "PI" }, { cwid: "abc1002", role: "Co-PI" }],
    deptCodes: ["N1"],
    areas: [],
    stage: "T1" as const,
    names,
  };
  const TRIAL = {
    key: "NCT00000001",
    protocolNumber: "P-1",
    nct: "NCT00000001",
    title: "An example trial",
    trialPhase: "Phase 2",
    stage: "T2" as const,
    status: "OPEN TO ACCRUAL",
    startYear: 2021,
    endYear: null,
    years: [2021],
    people: [{ cwid: "abc1001", role: "Principal Investigator" }],
    deptCodes: ["N1"],
    areas: [],
    names,
  };

  it("lists the grants, each award once with its investigators and its stage, under the stage chips", async () => {
    const bare = { ...GRANT, key: "INFOED-2", title: "A title-only award", stage: null };
    h.portfolio.mockResolvedValue({ ...DATA, grantList: { total: 2, rows: [GRANT, bare] } });
    const { container } = await page({ ...SP, view: "grants" });
    const [item, other] = within(container).getAllByTestId("portfolio-grant");
    expect(item.textContent).toContain("An example award");
    expect(item.textContent).toContain("NCI· 5 R01 CA000001-03· 2019–2024");
    expect(item.textContent).toContain("Example Person 1 (PI), Example Person 2 (Co-PI)");
    expect(item.textContent).toContain("T1Early translation");
    expect(other.textContent).toContain("No stage");
    expect(within(container).getByTestId("portfolio-list-stages")).toBeTruthy();
    expect(container.textContent).toContain("1 to 2 of 2");
  });

  it("names the stage pick in the grants list's heading and its empty line", async () => {
    const { container } = await page({ ...SP, view: "grants", stage: "T2" });
    expect(container.textContent).toContain("Grants in T2, Department of Examples");
    expect(within(container).getByTestId("portfolio-grants").textContent).toBe("No grants in T2 were active in this scope, 2020 to 2021.");
  });

  it("lists the trials with their NCT link and the trial's own phase", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, trialList: { total: 1, rows: [TRIAL] } });
    const { container } = await page({ ...SP, view: "trials" });
    const item = within(container).getByTestId("portfolio-trial");
    expect(within(item).getByRole("link", { name: "NCT00000001" }).getAttribute("href")).toBe("https://clinicaltrials.gov/study/NCT00000001");
    expect(item.textContent).toContain("Phase 2");
    expect(item.textContent).toContain("Open to accrual");
    expect(item.textContent).toContain("Principal investigator: Example Person 1");
  });

  it("opens every grant from the tile and the activity row, whatever stage is picked", async () => {
    const { container } = await page({ ...SP, stage: "T2" });
    expect(within(container).getByTestId("portfolio-grants-total").getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&view=grants#items`);
    const row = within(container).getByTestId("portfolio-activity-grants");
    expect(within(row).getByRole("link", { name: "12 grants. Show them." }).getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&view=grants#items`);
  });

  it("links each tile and table count to its list", async () => {
    h.portfolio.mockResolvedValue({ ...DATA, table: [row("N9", { grants: 4, trials: 0 })] });
    const { container } = await page();
    expect(within(container).getByTestId("portfolio-grants-total").getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&view=grants#items`);
    expect(within(container).getByTestId("portfolio-trials-total").getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&view=trials#items`);
    const table = within(container).getByTestId("portfolio-table");
    expect(within(table).getByRole("link", { name: "4 grants, Area N9" }).getAttribute("href")).toBe(`${BASE}?area=N9&view=grants#items`);
    expect(within(table).queryByRole("link", { name: /clinical trials, Area N9/ })).toBeNull();
  });

  it("counts a scholar's grants and trials only where the count opens their page", async () => {
    const one = { ...scholar(1), grants: 2, trials: 1 };
    const two = { ...scholar(2), grants: 3, trials: 0 };
    h.portfolio.mockResolvedValue({ ...DATA, scholars: { total: 2, rows: [one, two] } });
    h.access.mockResolvedValue(new Set(["abc1001"]));
    const { container } = await page();
    const [a, b] = within(container).getAllByTestId("portfolio-scholar");
    expect(within(a).getByTestId("portfolio-scholar-grants").textContent).toBe("2 grants");
    expect(within(a).getByTestId("portfolio-scholar-grants").getAttribute("href")).toMatch(/^\/edit\/scholar\/abc1001\/translational-portfolio\?.*#funding$/);
    expect(within(a).getByTestId("portfolio-scholar-trials").textContent).toBe("1 trial");
    expect(within(b).queryByTestId("portfolio-scholar-grants")).toBeNull();
    expect(b.textContent).not.toContain("3 grants");
  });
});

describe("report 26's trial stages", () => {
  it("sets each activity's stages side by side, each count a link to its list", async () => {
    const { container } = await page();
    const panel = within(container).getByTestId("portfolio-by-activity");
    const pubs = within(panel).getByTestId("portfolio-activity-pubs");
    const trials = within(panel).getByTestId("portfolio-activity-trials");
    const grants = within(panel).getByTestId("portfolio-activity-grants");
    expect(within(pubs).getByRole("link", { name: "125 publications. Show them." }).getAttribute("href")).toContain("view=activities");
    expect(within(trials).getByRole("link", { name: "3 clinical trials. Show them." }).getAttribute("href")).toContain("view=trials");
    expect(within(trials).getByRole("link", { name: "Clinical trials" }).getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&act=trials#stages`);
    expect(trials.querySelector('[role="cell"]')!.getAttribute("aria-label")).toBe("T0 0%, T1 50%, T2 50%, T3–4 0%; stage assigned 67%");
    // Grants: 6 of the 12 staged (1/2/2/1).
    expect(within(grants).getByRole("link", { name: "Grants" }).getAttribute("href")).toBe(`${BASE}?unit=dept%3AN1&from=2020&to=2021&act=grants#stages`);
    expect(grants.querySelector('[role="cell"]')!.getAttribute("aria-label")).toBe("T0 17%, T1 33%, T2 33%, T3–4 17%; stage assigned 50%");
    expect(grants.textContent).toContain("50%");
  });

  it("never says grants have no stage yet, and states the grant stage rule", async () => {
    const { container } = await page();
    expect(container.textContent).not.toMatch(/no stage yet|stage not yet|not yet assigned/i);
    expect(container.textContent).toContain(
      "A grant's stage comes from ReciterAI's reading of its abstract; grants with only a title have no stage.",
    );
    expect(container.textContent).not.toContain("—");
  });

  it("under act=trials, draws the trials' stages over time and in the table, and the stage cells open the trials", async () => {
    h.portfolio.mockResolvedValue({
      ...DATA,
      table: [row("N9", { gaps: ["T3-4"], trials: 2, trialCounts: { T0: 0, T1: 0, T2: 2, "T3-4": 0, none: 0 } })],
    });
    const { container } = await page({ ...SP, act: "trials", by: "area" });
    const rows = within(container).getByTestId("portfolio-stage-rows");
    const cells = [...rows.querySelectorAll('[role="cell"][aria-label]')].map((x) => x.getAttribute("aria-label"));
    expect(cells[0]).toBe("T0 0%, T1 100%, T2 0%, T3–4 0%; stage assigned 100%");
    // The All of WCM row is the trials' baseline.
    expect(cells.at(-1)).toBe("T0 0%, T1 22%, T2 67%, T3–4 11%; stage assigned 75%");
    const table = within(container).getByTestId("portfolio-table");
    const t2 = within(table).getByRole("link", { name: "100% in T2, Area N9. Show trials." });
    expect(t2.getAttribute("href")).toBe(`${BASE}?area=N9&stage=T2&view=trials#items`);
    // Gaps are a publication rule: none in trial mode.
    expect(table.textContent).not.toContain("Gap");
    expect(within(container).getAllByRole("link", { name: "Clinical trials" }).some((a) => a.getAttribute("aria-current") === "true")).toBe(true);
  });

  it("keeps act=trials through a rail change", async () => {
    const { container } = await page({ ...SP, act: "trials" });
    const form = within(container).getAllByTestId("portfolio-filters")[0];
    expect(form.querySelector('input[type="hidden"][name="act"]')?.getAttribute("value")).toBe("trials");
  });

  it("tags each listed trial with its stage, or No stage, and lets the stage chips filter the list", async () => {
    const mk = (key: string, stage: "T2" | null) => ({
      key, protocolNumber: key, nct: null, title: `Trial ${key}`, trialPhase: stage ? "Phase 2" : "Not applicable", stage, status: null,
      startYear: 2021, endYear: 2022, years: [2021], people: [], deptCodes: [], areas: [], names: new Map<string, string>(),
    });
    h.portfolio.mockResolvedValue({ ...DATA, trialList: { total: 2, rows: [mk("P-1", "T2"), mk("P-2", null)] } });
    const { container } = await page({ ...SP, view: "trials" });
    const [a, b] = within(container).getAllByTestId("portfolio-trial");
    expect(a.textContent).toContain("T2Clinical trials and efficacy");
    expect(b.textContent).toContain("No stage");
    expect(within(container).getByTestId("portfolio-list-stages")).toBeTruthy();
  });
});

describe("report 26's grant stages", () => {
  it("under act=grants, draws the grants' stages over time, the tiles and the table, and the stage cells open the grants", async () => {
    h.portfolio.mockResolvedValue({
      ...DATA,
      table: [row("N9", { gaps: ["T3-4"], grants: 4, grantCounts: { T0: 1, T1: 0, T2: 3, "T3-4": 0, none: 0 } })],
    });
    const { container } = await page({ ...SP, act: "grants", by: "area" });
    const rows = within(container).getByTestId("portfolio-stage-rows");
    const cells = [...rows.querySelectorAll('[role="cell"][aria-label]')].map((x) => x.getAttribute("aria-label"));
    // 2020: 1/1/1/0 of 3 staged, 3 of 6 with a stage.
    expect(cells[0]).toBe("T0 34%, T1 33%, T2 33%, T3–4 0%; stage assigned 50%");
    // The All of WCM row is the grants' baseline.
    expect(cells.at(-1)).toBe("T0 20%, T1 20%, T2 40%, T3–4 20%; stage assigned 50%");
    expect(container.textContent).toContain("Grants with a stage");
    // 2020: T2 and T3–4 are 1 of 3 staged; 2021: 3 of 6.
    expect(container.textContent).toContain("33% in 2020 → 50% in 2021");
    expect(container.textContent).toContain("Shares leave out grants with no stage.");
    const table = within(container).getByTestId("portfolio-table");
    const t2 = within(table).getByRole("link", { name: "75% in T2, Area N9. Show grants." });
    expect(t2.getAttribute("href")).toBe(`${BASE}?area=N9&stage=T2&view=grants#items`);
    // Gaps are a publication rule: none in grant mode.
    expect(table.textContent).not.toContain("Gap");
    for (const label of ["Show stages of", "Stage shares for"]) {
      const nav = within(container).getByRole("navigation", { name: label });
      const on = within(nav).getByRole("link", { name: "Grants" });
      expect(on.getAttribute("aria-current")).toBe("page");
    }
  });

  it("offers Grants in both stage switches and keeps act=grants through a rail change", async () => {
    const { container } = await page({ ...SP, act: "grants" });
    const form = within(container).getAllByTestId("portfolio-filters")[0];
    expect(form.querySelector('input[type="hidden"][name="act"]')?.getAttribute("value")).toBe("grants");
    const nav = within(container).getByRole("navigation", { name: "Show stages of" });
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Publications", "Clinical trials", "Grants"]);
  });

  it("says only grants with a research area count under an area filter, beside their stage share", async () => {
    const { container } = await page({ ...SP, area: "area_a" });
    expect(tiles(container)[1]).toEqual(["Grants, 2020 to 2021", "12", "Only grants with a research area. 50% have a stage."]);
  });
});
