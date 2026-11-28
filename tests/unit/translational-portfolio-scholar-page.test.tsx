/**
 * @vitest-environment jsdom
 *
 * `/edit/scholar/[cwid]/translational-portfolio`: the gate's verdicts (login
 * redirect carrying the URL, one 404 for a refusal), the header (the scholar's
 * name as the h1, the CWID in monospace, the link back to the report under its
 * filters), and the body: a count per stage, each a link to the list it
 * counts, squares per paper or stacked bars past the threshold with the
 * counts in a table, the list's stage filter and paging, the area card, and no
 * percentage anywhere. The gate and loader are mocked (their rules are
 * `translational-portfolio-scholar.test.ts`); fixtures are invented.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  access: vi.fn(),
  data: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: h.redirect }));
vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/components/edit/console-shell", () => ({
  ConsoleShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell">{children}</div>
  ),
}));
vi.mock("@/lib/edit/report-meta", () => ({
  reportMetaFor: async () => ({
    key: "26",
    slug: "translational-portfolio",
    name: "Translational portfolio",
    summary: "",
    descriptionHtml: null,
  }),
}));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  loadPortfolioChoices: async () => ({
    facets: {},
    labels: new Map([["dept:N1", "Department of Examples"]]),
    areas: [],
  }),
}));
vi.mock("@/lib/edit/translational-portfolio-scholar", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-scholar")>()),
  resolveScholarPortfolioAccess: h.access,
  loadScholarPortfolio: h.data,
}));

import Page from "@/app/edit/scholar/[cwid]/translational-portfolio/page";
import { scholarPortfolioXlsxHref } from "@/components/edit/reports/translational-portfolio-scholar-body";
import {
  parseScholarPortfolioParams,
  type ScholarPaper,
  type ScholarPortfolio,
} from "@/lib/edit/translational-portfolio-scholar";
import { resolveSuspense } from "@/tests/util/resolve-suspense";

const SCHOLAR = {
  cwid: "abc1234",
  name: "Example Person, MD, PhD",
  preferredName: "Example Person",
  title: "Professor of Examples",
  department: "Examples",
  slug: "example-person",
};
const BASE = "/edit/scholar/abc1234/translational-portfolio";

const paper = (
  i: number,
  year: number,
  stage: ScholarPaper["stage"],
  role: ScholarPaper["role"] = "First",
): ScholarPaper => ({
  pmid: String(90000 + i),
  title: `Example paper ${i}`,
  journal: "Journal of Examples",
  year,
  role,
  stage,
  areas: [],
});
// 2021: 2 T0, 1 none; 2022: 1 T2 (senior), 1 T3-4 (middle).
const PAPERS = [
  paper(5, 2022, "T2", "Senior"),
  paper(4, 2022, "T3-4", "Middle"),
  paper(3, 2021, "T0"),
  paper(2, 2021, "T0"),
  paper(1, 2021, null),
];
const DATA: ScholarPortfolio = {
  papers: PAPERS,
  areaChoices: [{ id: "area_a", label: "Example area", n: 3 }],
  areas: [
    {
      id: "area_a",
      label: "Example area",
      description: "What the example area studies.",
      n: 3,
      counts: { T0: 2, T1: 0, T2: 1, "T3-4": 0, none: 0 },
    },
  ],
  grants: [
    {
      key: "R01CA000001",
      title: "An example award",
      funder: "NCI",
      awardNumber: "5 R01 CA000001-03",
      start: "2021-04-01",
      end: "2026-03-31",
      years: [2021, 2022],
      people: [{ cwid: "abc1234", role: "PI" }],
      deptCodes: [],
      areas: [],
      stage: "T1",
    },
  ],
  trials: [
    {
      key: "NCT00000001",
      protocolNumber: "P-1",
      nct: "NCT00000001",
      title: "An example trial",
      trialPhase: "Phase 2",
      stage: "T2",
      status: "OPEN TO ACCRUAL",
      startYear: 2022,
      endYear: null,
      years: [2022],
      people: [{ cwid: "abc1234", role: "Principal Investigator" }],
      deptCodes: [],
      areas: [],
    },
  ],
};

async function open(query: Record<string, string | string[]> = { from: "2021", to: "2022" }) {
  const tree = await Page({
    params: Promise.resolve({ cwid: "abc1234" }),
    searchParams: Promise.resolve(query),
  });
  return render((await resolveSuspense(tree)) as React.ReactElement).container;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({
    kind: "ok",
    session: { cwid: "view001", isSuperuser: false },
    scholar: SCHOLAR,
  });
  h.data.mockResolvedValue(DATA);
});
afterEach(cleanup);

/** The link back (`r`) rides on every page link; these tests check the page's own scope. */
const R_PARAM = /&r=[^#]*/;
const noR = (href: string | null) => (href ?? "").replace(R_PARAM, "");

describe("the gate", () => {
  it("sends a visitor with no session to the login, returning to this exact URL", async () => {
    h.access.mockResolvedValue({ kind: "login" });
    await expect(open({ from: "2021", area: "area_a" })).rejects.toThrow(
      `__REDIRECT__:/api/auth/saml/login?return=${encodeURIComponent(`${BASE}?from=2021&area=area_a`)}`,
    );
    expect(h.data).not.toHaveBeenCalled();
  });

  it("404s a refused viewer or an unknown scholar, before loading anything", async () => {
    h.access.mockResolvedValue({ kind: "denied" });
    await expect(open()).rejects.toThrow("__NOT_FOUND__");
    expect(h.access).toHaveBeenCalledWith("abc1234", expect.any(String));
    expect(h.data).not.toHaveBeenCalled();
  });
});

describe("the header", () => {
  it("is the scholar's published name as the one h1, then title · department, the CWID in monospace and the profile", async () => {
    const c = await open();
    const h1s = c.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("Example Person, MD, PhD");
    expect(c.textContent).toContain("Professor of Examples · Examples");
    const id = within(c).getByTestId("portfolio-cwid");
    expect(id.textContent).toBe("abc1234");
    expect(id.className).toContain("font-mono");
    expect(within(c).getByRole("link", { name: "Open profile" }).getAttribute("href")).toBe(
      "/example-person",
    );
  });

  it("links back to the report under the filters it came with, named for the unit", async () => {
    const c = await open({
      unit: "dept:N1",
      from: "2021",
      to: "2022",
      area: "area_a",
      inst: "INST1",
      authorship: "all",
      stage: "T0",
    });
    const back = within(c).getByTestId("portfolio-back");
    expect(back.textContent).toContain("Back to Department of Examples");
    expect(back.getAttribute("href")).toBe(
      "/edit/reports/translational-portfolio?unit=dept%3AN1&from=2021&to=2022&area=area_a&inst=INST1",
    );
    cleanup();
    expect(within(await open()).getByTestId("portfolio-back").textContent).toContain(
      "Back to Translational portfolio",
    );
  });

  it("offers the spreadsheet for this scholar under the page's filters", async () => {
    const c = await open({ from: "2021", to: "2022", authorship: "all" });
    expect(within(c).getByTestId("portfolio-download")).toBeTruthy();
    const p = parseScholarPortfolioParams(
      new URLSearchParams("from=2021&to=2022&authorship=all&stage=T0&page=3"),
    );
    expect(scholarPortfolioXlsxHref("abc1234", p)).toBe(
      "/api/edit/reports/translational-portfolio-scholar?cwid=abc1234&from=2021&to=2022&authorship=all&stage=T0",
    );
  });
});

describe("the body", () => {
  it("counts each stage, and each count opens the list filtered to it", async () => {
    const c = await open();
    const tiles = within(c).getByTestId("scholar-portfolio-summary");
    const link = (name: RegExp) => noR(within(tiles).getByRole("link", { name }).getAttribute("href"));
    expect(link(/^5 publications/)).toBe(`${BASE}?from=2021&to=2022#p-pubs`);
    expect(link(/^2 T0 publications/)).toBe(`${BASE}?from=2021&to=2022&stage=T0#p-pubs`);
    expect(link(/^1 T2 publications/)).toBe(`${BASE}?from=2021&to=2022&stage=T2#p-pubs`);
    expect(link(/^1 T3–4 publications/)).toBe(`${BASE}?from=2021&to=2022&stage=T3-4#p-pubs`);
    expect(link(/^1 publications without a stage/)).toBe(
      `${BASE}?from=2021&to=2022&stage=none#p-pubs`,
    );
    // T1 has none: a zero, not a link to an empty list.
    expect(within(tiles).queryByRole("link", { name: /T1 publications/ })).toBeNull();
    expect(c.textContent).not.toMatch(/\d%/);
  });

  it("filters the list to a stage, or to the papers without one", async () => {
    const t0 = await open({ from: "2021", to: "2022", stage: "T0" });
    expect(
      within(t0)
        .getAllByTestId("scholar-portfolio-paper")
        .map((li) => li.textContent?.match(/Example paper \d/)?.[0]),
    ).toEqual(["Example paper 3", "Example paper 2"]);
    cleanup();
    const none = await open({ from: "2021", to: "2022", stage: "none" });
    const rows = within(none).getAllByTestId("scholar-portfolio-paper");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("No stage");
    expect(within(none).queryByTestId("scholar-portfolio-unstaged")).toBeNull();
  });

  it("shows each paper's journal, year, role, PMID with a copy button and stage tag", async () => {
    const c = await open();
    const [first, second] = within(c).getAllByTestId("scholar-portfolio-paper");
    expect(first.textContent).toContain("Journal of Examples");
    expect(first.textContent).toContain("Senior author");
    expect(second.textContent).toContain("Middle author");
    expect(within(first).getByRole("link", { name: "90005" }).getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/90005/",
    );
    expect(within(first).getByRole("button", { name: "Copy PMID" })).toBeTruthy();
    expect(first.textContent).toContain("Clinical trials and efficacy");
    expect(within(c).getByTestId("scholar-portfolio-unstaged").textContent).toBe(
      "Show only papers without a stage (1)",
    );
  });

  it("pages the list 25 at a time", async () => {
    h.data.mockResolvedValue({
      ...DATA,
      papers: Array.from({ length: 30 }, (_, i) => paper(i, 2022, "T1")),
    });
    const p1 = await open();
    expect(within(p1).getAllByTestId("scholar-portfolio-paper")).toHaveLength(25);
    expect(within(p1).getByTestId("scholar-portfolio-range").textContent).toContain(
      "1 to 25 of 30",
    );
    expect(noR(within(p1).getByRole("link", { name: "Next" }).getAttribute("href"))).toBe(
      `${BASE}?from=2021&to=2022&page=2#p-pubs`,
    );
    cleanup();
    const p2 = await open({ from: "2021", to: "2022", page: "2" });
    expect(within(p2).getAllByTestId("scholar-portfolio-paper")).toHaveLength(5);
  });

  it("draws one square per paper, with the per-year counts in a table, and each year a link to it", async () => {
    const c = await open();
    const chart = within(c).getByTestId("scholar-portfolio-years");
    expect(chart.dataset.chart).toBe("squares");
    const cols = within(chart).getAllByTestId("year-squares");
    expect(cols.map((col) => col.children.length)).toEqual([3, 2]);
    const table = within(c).getByTestId("scholar-portfolio-years-table");
    expect(
      [...table.querySelectorAll("tbody tr")].map((tr) =>
        [...tr.children].map((x) => x.textContent),
      ),
    ).toEqual([
      ["2021", "2", "0", "0", "0", "1", "3"],
      ["2022", "0", "0", "1", "1", "0", "2"],
    ]);
    const year = within(chart).getAllByTestId("year-column")[0];
    expect(noR(year.getAttribute("href"))).toBe(`${BASE}?from=2021&to=2021`);
    expect(year.getAttribute("aria-label")).toBe(
      "2021: 3 publications (T0 2, T1 0, T2 0, T3–4 0, No stage 1). Show only 2021.",
    );
  });

  it("switches to stacked bars when the busiest year has more than 60 papers", async () => {
    h.data.mockResolvedValue({
      ...DATA,
      papers: Array.from({ length: 61 }, (_, i) => paper(i, 2022, i % 2 ? "T0" : null)),
    });
    const c = await open();
    const chart = within(c).getByTestId("scholar-portfolio-years");
    expect(chart.dataset.chart).toBe("bars");
    expect(within(chart).queryAllByTestId("year-squares")).toHaveLength(0);
    expect(within(chart).getAllByTestId("year-bar")).toHaveLength(2);
    cleanup();
    h.data.mockResolvedValue({
      ...DATA,
      papers: Array.from({ length: 60 }, (_, i) => paper(i, 2022, "T0")),
    });
    expect(within(await open()).getByTestId("scholar-portfolio-years").dataset.chart).toBe(
      "squares",
    );
  });

  it("lists the areas with a definition card trigger, a count that narrows the page, and a stage strip", async () => {
    const c = await open();
    const row = within(c).getByTestId("scholar-portfolio-area");
    expect(within(row).getByTestId("area-term").textContent).toBe("Example area");
    expect(
      within(row)
        .getByRole("link", { name: "3 papers in Example area. Show only this area." })
        .getAttribute("href")?.replace(R_PARAM, ""),
    ).toBe(`${BASE}?from=2021&to=2022&area=area_a#p-pubs`);
    expect(within(row).getByRole("img").getAttribute("aria-label")).toBe(
      "T0 2, T1 0, T2 1, T3–4 0, No stage 0",
    );
    expect(row.textContent).toContain("Runs T0 to T2");
  });

  it("opens the list each year or area count counts: the list's stage filter does not carry", async () => {
    const c = await open({ from: "2021", to: "2022", stage: "T0", authorship: "all" });
    const year = within(within(c).getByTestId("scholar-portfolio-years")).getAllByTestId(
      "year-column",
    )[0];
    expect(noR(year.getAttribute("href"))).toBe(`${BASE}?from=2021&to=2021&authorship=all`);
    const row = within(c).getByTestId("scholar-portfolio-area");
    expect(
      within(row)
        .getByRole("link", { name: "3 papers in Example area. Show only this area." })
        .getAttribute("href")?.replace(R_PARAM, ""),
    ).toBe(`${BASE}?from=2021&to=2022&area=area_a&authorship=all#p-pubs`);
  });

  it("keeps the rail's authorship toggle, areas and the report's filters in its form", async () => {
    const c = await open({
      unit: "dept:N1",
      inst: "INST1",
      from: "2021",
      to: "2022",
      authorship: "all",
    });
    const form = within(c).getAllByTestId("scholar-portfolio-filters")[0];
    expect((within(form).getByTestId("scholar-portfolio-middle") as HTMLInputElement).checked).toBe(
      true,
    );
    const hidden = [...form.querySelectorAll('input[type="hidden"]')].map(
      (i) => `${i.getAttribute("name")}=${i.getAttribute("value")}`,
    );
    // The report's filters ride in one `r`, apart from the page's own.
    expect(hidden).toEqual(["r=unit=dept%3AN1&from=2021&to=2022&inst=INST1"]);
    expect(form.textContent).toContain("Include middle-author papers");
  });
});

describe("the research area card", () => {
  it("opens on a tap or click with the area's description, count and page, and a bare name renders", async () => {
    const { AreaTerm } =
      await import("@/components/edit/reports/translational-portfolio-scholar-client");
    const { fireEvent } = await import("@testing-library/react");
    const c = render(
      <AreaTerm
        label="Example area"
        description="What the example area studies."
        count={3}
        countNote="of these papers score 0.3 or higher in this area."
        href="/topics/area_a"
      />,
    ).baseElement;
    const trigger = within(c).getByTestId("area-term");
    expect(trigger.textContent).toBe("Example area");
    expect(within(c).queryByTestId("area-card")).toBeNull();
    fireEvent.click(trigger);
    const card = within(c).getByTestId("area-card");
    expect(card.textContent).toContain("What the example area studies.");
    expect(card.textContent).toContain("3 of these papers score 0.3 or higher in this area.");
    expect(
      within(card).getByRole("link", { name: "Open the Example area page" }).getAttribute("href"),
    ).toBe("/topics/area_a");
  });
});

describe("funding and clinical trials", () => {
  it("lists this scholar's awards and trials with role, years, identifiers and stage", async () => {
    const c = await open();
    const grants = within(c).getByTestId("scholar-portfolio-grants");
    expect(grants.querySelector("h2")!.textContent).toBe("Funding");
    expect(grants.textContent).toContain("1 award");
    const g = within(grants).getByTestId("scholar-portfolio-grant");
    expect(g.textContent).toContain("PI·2021–2026");
    expect(g.textContent).toContain("Award 5 R01 CA000001-03");
    expect(g.textContent).toContain("T1Early translation");
    expect(c.textContent).not.toMatch(/not yet assigned|no translational stage yet|no stage yet/i);
    expect(c.textContent).toContain("A grant's stage comes from ReciterAI's reading of its abstract; grants with only a title have no stage.");

    const trials = within(c).getByTestId("scholar-portfolio-trials");
    const t = within(trials).getByTestId("scholar-portfolio-trial");
    expect(t.textContent).toContain("Phase 2·Principal investigator·2022–·Open to accrual");
    expect(within(t).getByRole("link", { name: "NCT00000001" }).getAttribute("href")).toBe("https://clinicaltrials.gov/study/NCT00000001");
    // The scholar rows' counts on the report land here.
    expect(grants.id).toBe("funding");
    expect(trials.id).toBe("trials");
  });

  it("says when there are none", async () => {
    h.data.mockResolvedValue({ ...DATA, grants: [], trials: [] });
    const c = await open();
    expect(within(c).getByTestId("scholar-portfolio-grants").textContent).toContain("No awards in these years.");
    expect(within(c).getByTestId("scholar-portfolio-trials").textContent).toContain("No clinical trials in these years.");
  });
});

describe("trial stages on the scholar page", () => {
  it("tags a trial with the stage from its trial phase, and an unphased one with No stage", async () => {
    const t = within(await open()).getByTestId("scholar-portfolio-trial");
    expect(t.textContent).toContain("T2");
    expect(t.textContent).not.toContain("Stage not yet assigned");
    cleanup();
    h.data.mockResolvedValue({ ...DATA, trials: [{ ...DATA.trials[0], stage: null, trialPhase: "Not applicable" }] });
    expect(within(await open()).getByTestId("scholar-portfolio-trial").textContent).toContain("No stage");
  });
});

describe("grant stages on the scholar page", () => {
  it("tags a grant with its ReciterAI stage, and one without a stage with No stage", async () => {
    const g = within(await open()).getByTestId("scholar-portfolio-grant");
    expect(g.textContent).toContain("T1");
    cleanup();
    h.data.mockResolvedValue({ ...DATA, grants: [{ ...DATA.grants[0], stage: null }] });
    const bare = within(await open()).getByTestId("scholar-portfolio-grant");
    expect(bare.textContent).toContain("No stage");
    expect(bare.textContent).not.toContain("T1");
  });
});
