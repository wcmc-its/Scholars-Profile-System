/**
 * Report 27's page (`downstream-reach-body.tsx`): the flag and no-unit
 * backstops; the tiles, tabs and every table cell as links to the list they
 * count (THE RULE: no number without a link); a Publications cell opening the
 * publication modal at its section only when the modal lists exactly what the
 * cell counts, and the Citing documents view otherwise; the rail's filters
 * with no counts beside them; names through the scholar hover card with the
 * CWID in monospace; and the export link. The loaders are mocked; their SQL,
 * scoping and the count-equals-list checks are `downstream-reach-report.test.ts`.
 * Fixture people, papers and documents are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  reach: vi.fn(),
  pubs: vi.fn(),
  docs: vi.fn(),
  modal: vi.fn(),
  hidden: vi.fn(),
  open: vi.fn(),
  scope: { value: null as string[] | null },
  access: vi.fn(),
  baseline: vi.fn(),
  footers: new Map<string, ScholarCardFooter | undefined>(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/api/data-quality", () => ({
  loadDataQualityFacets: vi.fn(async () => ({
    roleCategories: [{ value: "full_time_faculty", label: "Full-time faculty", count: 1900 }],
    departments: [{ value: "dept:N1", label: "Department of Examples", count: 40, divisions: [] }],
    centers: [],
    institutions: [],
  })),
}));
vi.mock("@/lib/edit/downstream-reach-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/downstream-reach-report")>()),
  resolveReachParams: async (p: { docs: number[] }) => ({
    ...p,
    scope: h.scope.value,
    docRefs: p.docs.map((id) => ({ id, level: "guideline", type: "policy", dedupKey: `k${id}`, title: `Example guideline ${id}` })),
  }),
  loadReach: h.reach,
  withReachPublicationDetails: h.pubs,
  withReachDocDetails: h.docs,
  loadModalCounts: h.modal,
  loadModalHidden: h.hidden,
  loadReachBaseline: h.baseline,
  loadReachAreas: async () => [{ id: "area_a", label: "Example area" }],
}));
vi.mock("@/lib/edit/policy-citations-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/policy-citations-report")>()),
  loadPersonNames: async (p: { people: string[] }, known: { cwid: string; name: string }[]) =>
    new Map([...known.map((r) => [r.cwid, r.name] as const), ...p.people.filter((c) => c === "abc1001").map((c) => [c, "Example Person"] as const)]),
}));
vi.mock("@/lib/edit/bibliometrics-access", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/bibliometrics-access")>()),
  loadBibliometricsAccess: h.access,
}));
// The card opens on hover only; the mock keeps each person's footer for the tests to render.
vi.mock("@/components/edit/scholar-hover-card", () => ({
  ScholarHoverCard: (p: { cwid: string; children: ReactNode; footer?: ScholarCardFooter }) => {
    h.footers.set(p.cwid, p.footer);
    return <span data-testid="hover-card" data-cwid={p.cwid}>{p.children}</span>;
  },
}));
// The public modal: only its trigger is under test here.
vi.mock("@/components/publication/publication-modal", () => ({
  PublicationModalProvider: (p: { children: ReactNode }) => <div data-testid="modal-provider">{p.children}</div>,
  usePublicationModal: () => ({ open: h.open, close: vi.fn(), state: null }),
}));

import type { ReactNode } from "react";

import { renderDownstreamReachReport } from "@/components/edit/reports/downstream-reach-body";
import type { ScholarCardFooter } from "@/components/edit/scholar-hover-card";
import {
  parseReachParams,
  REACH_DEFINITION,
  reachLinks,
  type ModalCounts,
  type ReachData,
  type ReachDocRow,
  type ReachPersonRow,
  type ReachPubRow,
} from "@/lib/edit/downstream-reach-report";
import type { AdminReportProps } from "@/lib/edit/report-registry";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const BASE = "/edit/reports/downstream-reach";
const pub = (pmid: string, over: Partial<ReachPubRow> = {}): ReachPubRow => ({
  pmid,
  notable: null,
  year: 2021,
  stage: "T0",
  clinical: 0,
  trial: 0,
  policy: 0,
  review: 0,
  patent: 0,
  title: `An example study ${pmid}`,
  journal: "Journal of Examples",
  doi: null,
  authors: [{ cwid: "abc1001", name: "Example Person", position: "first" }],
  ...over,
});
/** 10000001: everything the modal can list. 10000002: what it cannot. */
const PUBS: ReachPubRow[] = [
  pub("10000001", { clinical: 12, trial: 2, policy: 3, review: 2, patent: 1 }),
  pub("10000002", { stage: "none", clinical: 7, trial: 60, policy: 140, review: 120, patent: 0 }),
];
const MODAL = new Map<string, ModalCounts>([
  ["10000001", { clinical: 12, trial: 2, policy: 3, review: 2, ranked: 5, patent: 1 }],
  // One more clinical article than counted (the authors' own), trials past the cap, one guideline
  // document at two policy levels (the modal lists it once), and reviews past their cap.
  ["10000002", { clinical: 8, trial: 60, policy: 139, review: 120, ranked: 259, patent: 0 }],
]);
const DOC: ReachDocRow = {
  docId: 4,
  level: "guideline",
  type: "policy",
  year: 2024,
  application: false,
  papers: 17,
  title: "Example guideline",
  url: "https://pubmed.ncbi.nlm.nih.gov/90000004/",
  kind: "Clinical guideline",
  source: "Journal of Examples",
};
const PERSON: ReachPersonRow = {
  cwid: "abc1001",
  name: "Example Person",
  orgUnit: "Department of Examples",
  personType: "Full-time faculty",
  institution: "Example Institution",
  papers: 9,
  clinical: 6,
  trial: 0,
  policy: 4,
  review: 3,
  patent: 2,
};
const data = (over: Partial<ReachData> = {}): ReachData => ({
  scopeTotal: 4210,
  typePapers: { clinical: 1300, trial: 210, policy: 640, review: 2222, patent: 95 },
  pubTotal: 1875,
  pubMatched: 1875,
  pubs: PUBS,
  docTotal: null,
  docs: [],
  docsWithheld: null,
  people: null,
  peopleTotal: null,
  ...over,
});

async function page(query: Record<string, string | string[]> = {}) {
  const props = { n: "27", session: { cwid: "sup0001", isSuperuser: true }, searchParams: query, basePath: BASE };
  const out = await renderDownstreamReachReport(props as unknown as AdminReportProps);
  return render(
    <>
      <div data-testid="subtitle">{out.subtitle}</div>
      <div data-testid="aside">{out.aside}</div>
      {out.main}
    </>,
  );
}
/** The params the page parsed, for building the links it should have drawn. */
const paramsOf = (qs: string, scope: string[] | null = null) => ({ ...parseReachParams(new URLSearchParams(qs)), scope });
const queryOf = (href: string | null) => new URLSearchParams(href!.split("?")[1] ?? "");
const ON = ["POLICY_CITATION_BADGES", "TRIAL_CITATIONS_MODAL", "PATENT_CITATIONS_MODAL", "CLINICAL_CITATIONS_MODAL"];

/** Every text node holding a digit under `root` sits inside a link or a button. */
function expectEveryNumberLinked(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/\d/.test(node.textContent ?? "")) continue;
    seen += 1;
    const parent = node.parentElement!;
    // A zero's screen-reader text stands for the dash, which counts nothing.
    if (parent.classList.contains("sr-only") && node.textContent === "0") continue;
    // A share of two linked counts ("(45%)") counts nothing itself.
    if (/^\(?\d+%\)?$/.test(node.textContent ?? "")) continue;
    expect(parent.closest("a, button"), `"${node.textContent}" is not a link`).not.toBeNull();
  }
  return seen;
}

beforeEach(() => {
  h.footers.clear();
  h.open.mockReset();
  h.access.mockReset().mockResolvedValue(new Set());
  h.scope.value = null;
  h.reach.mockReset().mockResolvedValue(data());
  h.pubs.mockReset().mockResolvedValue(PUBS);
  h.docs.mockReset().mockResolvedValue([]);
  h.modal.mockReset().mockResolvedValue(MODAL);
  h.hidden.mockReset().mockResolvedValue(new Set());
  h.baseline.mockReset().mockResolvedValue(null);
  vi.stubEnv("DOWNSTREAM_REACH_REPORT", "on");
  for (const flag of ON) vi.stubEnv(flag, "on");
});

describe("report 27 page", () => {
  it("flag off: the body is not found, and loads nothing", async () => {
    vi.stubEnv("DOWNSTREAM_REACH_REPORT", "off");
    await expect(page()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(h.reach).not.toHaveBeenCalled();
    expect(h.modal).not.toHaveBeenCalled();
  });

  it("a viewer with no unit is not found", async () => {
    h.scope.value = [];
    await expect(page()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    expect(h.reach).not.toHaveBeenCalled();
  });

  it("the page loads its own tab only, one page of it", async () => {
    await page({ view: "people", page: "3" });
    expect(h.reach).toHaveBeenCalledTimes(1);
    expect(h.reach.mock.calls[0][1]).toEqual({ views: ["people"], limit: 50, offset: 100 });
  });

  it("the header is a fixed definition: no filter values, which the chips carry", async () => {
    const view = await page({ unit: "dept:N1", area: "area_a", type: "full_time_faculty", own: "in", stage: "T2" });
    const subtitle = view.getByTestId("downstream-reach-subtitle").textContent!;
    expect(subtitle).toBe(REACH_DEFINITION);
    expect(subtitle).not.toMatch(/\d|units|Department|Example area|own work/);
  });

  it("a research area or unit: the baseline without them, its N and M linked to their lists", async () => {
    h.baseline.mockResolvedValue({ cited: 3100, scope: 10000 });
    const view = await page({ area: "area_a", unit: "dept:N1", basis: "cy" });
    const base = view.getByTestId("downstream-reach-baseline");
    expect(base.textContent).toBe("WCM overall: 31% (3,100 of 10,000)");
    const links = reachLinks({ ...paramsOf("area=area_a&unit=dept:N1&basis=cy"), area: null, units: [] });
    const [n, m] = within(base).getAllByRole("link");
    expect([n.getAttribute("href"), m.getAttribute("href")]).toEqual([`${BASE}?${links.cited()}`, `${BASE}?${links.scope()}`]);
    expect(queryOf(n.getAttribute("href")).get("area")).toBeNull();
    expect(queryOf(n.getAttribute("href")).getAll("unit")).toEqual([]);
    expectEveryNumberLinked(base);
    cleanup();
    h.scope.value = ["dept:N1"];
    expect((await page({ area: "area_a", basis: "cy" })).getByTestId("downstream-reach-baseline").textContent).toContain("All your units: 31%");
  });

  it("the tiles: N of M cited downstream and one per citing type, each a link to the list it counts", async () => {
    const view = await page();
    const tiles = view.getByTestId("downstream-reach-tiles");
    const links = reachLinks(paramsOf(""));
    const tile = (id: string) => view.getByTestId(`downstream-reach-tile-${id}`);
    expect(tile("cited").textContent).toBe("1,875");
    expect(tile("cited").getAttribute("href")).toBe(`${BASE}?${links.cited()}`);
    expect(tile("scope").textContent).toBe("4,210");
    expect(tile("scope").getAttribute("href")).toBe(`${BASE}?${links.scope()}`);
    expect(queryOf(tile("scope").getAttribute("href")).get("show")).toBe("all");
    for (const [t, n] of [["clinical", "1,300"], ["trial", "210"], ["policy", "640"], ["review", "2,222"], ["patent", "95"]] as const) {
      expect(tile(t).textContent).toBe(n);
      expect(tile(t).getAttribute("href")).toBe(`${BASE}?${links.type(t)}`);
      expect(queryOf(tile(t).getAttribute("href")).getAll("ctype")).toEqual([t]);
    }
    expect(tiles.textContent).toContain("publications in scope were cited downstream");
    // 1,875 of 4,210, rounded; the caption says why the types add up to more.
    expect(view.getByTestId("downstream-reach-tile-share").textContent).toBe("(45%)");
    expect(tiles.textContent).toContain("A paper can count under more than one type.");
    expect(tiles.textContent).toContain("papers cited by clinical studies");
    // No area or unit: no baseline.
    expect(view.queryByTestId("downstream-reach-baseline")).toBeNull();
    expect(h.baseline).toHaveBeenCalledTimes(1);
    expect(tiles.textContent).toContain("cited by clinical studies");
    expect(tiles.textContent).toContain("cited in patents");
    expect(tiles.textContent).toContain("cited in systematic reviews");
    // Seven counts and the share.
    expect(expectEveryNumberLinked(tiles)).toBe(8);
    // Each tile's link is named for the list it opens, so two numbers side by side can be told apart.
    expect(["cited", "scope", "clinical", "trial", "policy", "review", "patent"].map((id) => tile(id).getAttribute("aria-label"))).toEqual([
      "1,875 publications cited downstream",
      "4,210 publications in scope, cited or not",
      "1,300 publications cited by clinical studies",
      "210 publications cited by registered trials",
      "640 publications cited in guidelines or policy",
      "2,222 publications cited in systematic reviews",
      "95 publications cited in patents",
    ]);
  });

  it("the first tile names the types when only some are ticked", async () => {
    const view = await page({ ctype: ["clinical", "patent"], basis: "cy" });
    expect(view.getByTestId("downstream-reach-tiles").textContent).toContain(
      "publications in scope were cited by clinical studies or patents",
    );
  });

  it("the tabs: a count only on a view that was loaded, and each a link to that view", async () => {
    const view = await page();
    const tab = (v: string) => view.getByTestId(`downstream-reach-view-${v}`);
    expect(tab("publications").textContent).toBe("Publications (1,875)");
    expect(tab("publications").getAttribute("aria-current")).toBe("page");
    // Not loaded on this view: no number without its list.
    expect(tab("documents").textContent).toBe("Citing documents");
    expect(tab("people").textContent).toBe("People");
    expect(queryOf(tab("documents").getAttribute("href")).get("view")).toBe("documents");
  });

  it("a Publications row: the title opens the modal, the stage sits in the metadata line, a Total then one column per ticked type", async () => {
    const view = await page();
    expect(view.getByTestId("modal-provider")).toBeTruthy();
    const rows = view.getAllByTestId("downstream-reach-pub-row");
    expect(rows).toHaveLength(2);
    const table = view.getByTestId("downstream-reach-publications");
    expect([...table.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Publication",
      "Total▼",
      "Clinical studies▼",
      "Registered trials▼",
      "Guidelines and policy▼",
      "Systematic reviews▼",
      "Patents▼",
    ]);
    const first = within(rows[0]);
    fireEvent.click(first.getByTestId("downstream-reach-title"));
    expect(h.open).toHaveBeenLastCalledWith("10000001");
    expect(first.getByTestId("pub-row-stage").textContent).toBe("T0Basic research");
    // No stage is words, not a badge.
    expect(within(rows[1]).queryByTestId("pub-row-stage")).toBeNull();
    expect(rows[1].textContent).toContain("No stage");
    // The author is named through the hover card.
    expect(first.getByTestId("hover-card").getAttribute("data-cwid")).toBe("abc1001");
    expect(first.getByTestId("hover-card").textContent).toContain("Example Person");
  });

  it("a cell opens the modal at its section when the modal lists exactly what it counts", async () => {
    const view = await page();
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[0]);
    const cell = (t: string) => within(row.getByTestId(`downstream-reach-cell-${t}`));
    for (const [t, n, section, label] of [
      ["clinical", "12", "trials", "12 clinical studies citing this paper"],
      ["trial", "2", "trials", "2 registered trials citing this paper"],
      ["policy", "3", "policy", "3 guideline and policy documents citing this paper"],
      ["review", "2", "policy", "2 systematic reviews citing this paper"],
      ["patent", "1", "trials", "1 invention citing this paper"],
    ] as const) {
      const button = cell(t).getByRole("button", { name: label });
      expect(button.textContent).toBe(n);
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      fireEvent.click(button);
      expect(h.open).toHaveBeenLastCalledWith("10000001", { section });
    }
  });

  it("a cell the modal cannot list exactly links to that paper's citing documents instead", async () => {
    const view = await page();
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[1]);
    const links = reachLinks(paramsOf(""));
    for (const [t, n] of [["clinical", "7"], ["trial", "60"], ["policy", "140"], ["review", "120"]] as const) {
      const cell = within(row.getByTestId(`downstream-reach-cell-${t}`));
      expect(cell.queryByRole("button")).toBeNull();
      const link = cell.getByRole("link");
      expect(link.textContent).toBe(n);
      expect(link.getAttribute("href")).toBe(`${BASE}?${links.paperDocs("10000002", t)}`);
      const q = queryOf(link.getAttribute("href"));
      expect([q.get("view"), q.get("pmid"), q.getAll("ctype")]).toEqual(["documents", "10000002", [t]]);
    }
    // A zero is a dash and links nowhere.
    const zero = row.getByTestId("downstream-reach-cell-patent");
    expect(within(zero).queryByRole("link")).toBeNull();
    expect(zero.textContent).toBe("–0");
  });

  it("a paper the public modal will not open: a plain title, and its counts link to the citing documents", async () => {
    h.hidden.mockResolvedValue(new Set(["10000001"]));
    const view = await page();
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[0]);
    expect(row.queryByTestId("downstream-reach-title")).toBeNull();
    expect(row.getByText("An example study 10000001")).toBeTruthy();
    expect(row.queryAllByTestId("downstream-reach-modal-count")).toHaveLength(0);
    const link = within(row.getByTestId("downstream-reach-cell-clinical")).getByRole("link");
    expect(link.textContent).toBe("12");
    expect(queryOf(link.getAttribute("href")).get("pmid")).toBe("10000001");
  });

  it("with the modal's groups off, every cell links to the citing documents", async () => {
    for (const flag of ON) vi.stubEnv(flag, "off");
    const view = await page();
    expect(view.queryAllByTestId("downstream-reach-modal-count")).toHaveLength(0);
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[0]);
    expect(queryOf(within(row.getByTestId("downstream-reach-cell-clinical")).getByRole("link").getAttribute("href")).get("view")).toBe("documents");
  });

  it("the most notable citing document: one line under the metadata, its title linked, then +N more", async () => {
    const trial = { type: "trial" as const, kind: "Registered trial", id: "NCT01234567", facts: "Phase 2 · Completed", year: 2023, title: "A long <i>trial</i> title", url: "https://clinicaltrials.gov/study/NCT01234567" };
    h.pubs.mockResolvedValue([
      pub("10000001", { clinical: 2, trial: 1, notable: trial }),
      pub("10000002", { patent: 1, notable: { type: "patent", kind: "Patent", id: "US 9,000,001 B2", facts: null, year: 2020, title: "A method", url: "https://patents.google.com/patent/US9000001B2" } }),
    ]);
    const view = await page({ basis: "cy" });
    const [one, two] = view.getAllByTestId("downstream-reach-notable");
    expect(one.textContent).toBe("Registered trialNCT01234567 ·Phase 2 · Completed ·A long trial title+2 more");
    const title = within(one).getByRole("link", { name: "A long trial title" });
    expect([title.getAttribute("href"), title.getAttribute("title"), title.getAttribute("target")]).toEqual([trial.url, "A long trial title", "_blank"]);
    const more = within(one).getByRole("link", { name: "2 more citing documents of this paper" });
    expect(more.getAttribute("href")).toBe(`${BASE}?${reachLinks(paramsOf("basis=cy")).paperDocs("10000001", null)}`);
    // A patent shows its year; with nothing else counted there is no "+0 more".
    expect(two.textContent).toBe("PatentUS 9,000,001 B2 ·2020 ·A method");
  });

  it("the Total opens the paper's citing documents of every ticked type; each header sorts, then reverses", async () => {
    const view = await page({ ctype: ["clinical", "trial"], basis: "cy" });
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[0]);
    const total = within(row.getByTestId("downstream-reach-cell-total")).getByRole("link");
    expect(total.textContent).toBe("14");
    expect(total.getAttribute("href")).toBe(`${BASE}?${reachLinks(paramsOf("ctype=clinical&ctype=trial&basis=cy")).paperDocs("10000001", null)}`);
    expect(queryOf(total.getAttribute("href")).getAll("ctype")).toEqual(["clinical", "trial"]);
    const th = (sort: string) => view.getByTestId(`downstream-reach-sort-${sort}`).closest("th")!;
    expect(th("cited").getAttribute("aria-sort")).toBe("descending");
    expect(th("clinical").getAttribute("aria-sort")).toBe("none");
    // The current column's link reverses it; another column's sorts by it, highest first.
    expect(queryOf(view.getByTestId("downstream-reach-sort-cited").getAttribute("href")).get("order")).toBe("asc");
    const byClinical = queryOf(view.getByTestId("downstream-reach-sort-clinical").getAttribute("href"));
    expect([byClinical.get("sort"), byClinical.get("order")]).toEqual(["clinical", null]);
    // Sort by offers the ticked types only.
    const options = [...view.container.querySelectorAll<HTMLOptionElement>('select[name="sort"] option')].map((o) => o.value);
    expect(options).toEqual(["cited", "clinical", "trial", "year", "oldest"]);
    cleanup();
    const asc = await page({ ctype: ["clinical", "trial"], basis: "cy", sort: "clinical", order: "asc" });
    const clinical = asc.getByTestId("downstream-reach-sort-clinical");
    expect(clinical.closest("th")!.getAttribute("aria-sort")).toBe("ascending");
    // The rail keeps the order across a filter change.
    const form = asc.getAllByTestId("downstream-reach-filters")[0];
    expect(form.querySelector<HTMLInputElement>('input[type="hidden"][name="order"]')?.value).toBe("asc");
    expect(queryOf(clinical.getAttribute("href")).get("order")).toBeNull();
  });

  it("author chips: three, picked by the person-type filter, then first and senior author; the rest behind +N more", async () => {
    const a = (cwid: string, position: "first" | "middle" | "last", roleCategory: string) => ({ cwid, name: `Person ${cwid}`, position, roleCategory });
    h.pubs.mockResolvedValue([
      pub("10000001", {
        clinical: 1,
        authors: [a("m1", "first", "postdoc"), a("m2", "middle", "postdoc"), a("m3", "middle", "full_time_faculty"), a("m4", "middle", "postdoc"), a("m5", "last", "postdoc")],
      }),
    ]);
    const view = await page({ type: "full_time_faculty", basis: "cy" });
    const row = within(view.getAllByTestId("downstream-reach-pub-row")[0]);
    const shown = () => row.getAllByTestId("hover-card").map((c) => c.getAttribute("data-cwid"));
    expect(shown()).toEqual(["m3", "m1", "m5"]);
    const more = row.getByTestId("author-pills-more");
    expect([more.textContent, more.getAttribute("aria-expanded")]).toEqual(["+2 more", "false"]);
    fireEvent.click(more);
    expect(shown()).toEqual(["m3", "m1", "m5", "m2", "m4"]);
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });

  it("only the ticked types have columns", async () => {
    const view = await page({ ctype: ["patent"], basis: "cy" });
    const heads = [...view.getByTestId("downstream-reach-publications").querySelectorAll("th")].map((th) => th.textContent);
    expect(heads).toEqual(["Publication", "Total▼", "Patents▼"]);
    cleanup();
    const reviews = await page({ ctype: ["review"], basis: "cy" });
    expect([...reviews.getByTestId("downstream-reach-publications").querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Publication",
      "Total▼",
      "Systematic reviews▼",
    ]);
    // The headline keeps a figure for every type, on one wrapping row.
    expect(reviews.getByTestId("downstream-reach-tile-review").textContent).toBe("2,222");
  });

  it("every number in the Publications table is a link or a button", async () => {
    const view = await page();
    for (const cell of view.getByTestId("downstream-reach-publications").querySelectorAll("td.text-right")) {
      expectEveryNumberLinked(cell as HTMLElement);
    }
    expect(view.getByTestId("downstream-reach-publications").querySelectorAll("td.text-right")).toHaveLength(12);
  });

  it("the every-publication listing says what it is and how to leave it", async () => {
    h.reach.mockResolvedValue(data({ pubMatched: 4210 }));
    const view = await page({ show: "all", stage: ["T0", "T1"], basis: "cy", from: "2020" });
    const note = view.getByTestId("downstream-reach-show-all");
    expect(note.textContent).toContain("Every publication in scope, cited or not, newest first.");
    expect(queryOf(within(note).getByRole("link").getAttribute("href")).get("show")).toBeNull();
    expect(view.getByTestId("downstream-reach-pager").textContent).toContain("1–50 of 4,210");
    expect(view.getByTestId("downstream-reach-chips").textContent).toContain("Listing:Every publication in scope");
  });

  it("the Citing documents view: the title links out, with type and year, and the count opens the papers it cites", async () => {
    h.reach.mockResolvedValue(data({ pubs: [], docTotal: 312, docs: [DOC] }));
    h.pubs.mockResolvedValue([]);
    h.docs.mockResolvedValue([DOC]);
    const view = await page({ view: "documents" });
    expect(view.getByTestId("downstream-reach-view-documents").textContent).toBe("Citing documents (312)");
    const row = within(view.getByTestId("downstream-reach-doc-row"));
    const title = row.getByRole("link", { name: "Example guideline" });
    expect(title.getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/90000004/");
    expect(title.getAttribute("target")).toBe("_blank");
    expect(row.getByText("Clinical guideline")).toBeTruthy();
    expect(row.getByText("2024")).toBeTruthy();
    const count = row.getByRole("link", { name: "17 papers cited by this document" });
    expect(count.textContent).toBe("17");
    expect(count.getAttribute("href")).toBe(`${BASE}?${reachLinks(paramsOf("view=documents")).docPapers(4)}`);
    const q = queryOf(count.getAttribute("href"));
    expect([q.get("view"), q.getAll("doc")]).toEqual([null, ["4"]]);
    expect(view.getByTestId("downstream-reach-pager").textContent).toContain("1–50 of 312");
  });

  it("a Citing documents count is withheld when the URL can carry no more document filters", async () => {
    h.reach.mockResolvedValue(data({ pubs: [], docTotal: 1, docs: [DOC] }));
    h.docs.mockResolvedValue([DOC]);
    const view = await page({ view: "documents", doc: ["11", "12", "13", "14", "15"], basis: "cy" });
    const row = view.getByTestId("downstream-reach-doc-row");
    expect(row.textContent).not.toContain("17");
    expect(row.textContent).toContain("Remove a “Cited by” filter to open");
    // Each filter is a chip that can be removed.
    expect(view.getByTestId("downstream-reach-chips").textContent).toContain("Cited by:Example guideline 11");
  });

  it("the People view: resolved names in the hover card, the CWID in monospace, and every count a link to that person's papers", async () => {
    h.reach.mockResolvedValue(data({ pubs: [], people: [PERSON], peopleTotal: 1 }));
    h.pubs.mockResolvedValue([]);
    const view = await page({ view: "people" });
    expect(view.getByTestId("downstream-reach-view-people").textContent).toBe("People (1)");
    const row = view.getByTestId("downstream-reach-person-row");
    const card = within(row).getByTestId("hover-card");
    expect(card.getAttribute("data-cwid")).toBe("abc1001");
    expect(card.textContent).toBe("Example Person");
    const cwid = within(row).getByText("abc1001");
    expect(cwid.className).toContain("font-mono");
    expect([...view.getByTestId("downstream-reach-people").querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Person",
      "Org unit",
      "Person type",
      "Papers cited downstream",
      "Papers cited by clinical studies",
      "Papers cited by registered trials",
      "Papers cited in guidelines or policy",
      "Papers cited in systematic reviews",
      "Papers cited in patents",
    ]);
    // Counts only: no percentages anywhere in the table.
    expect(view.getByTestId("downstream-reach-people").textContent).not.toContain("%");
    const links = reachLinks(paramsOf("view=people"));
    const hrefs = within(row).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(hrefs).toEqual([
      ["9", `${BASE}?${links.person("abc1001", null)}`],
      ["6", `${BASE}?${links.person("abc1001", "clinical")}`],
      ["4", `${BASE}?${links.person("abc1001", "policy")}`],
      ["3", `${BASE}?${links.person("abc1001", "review")}`],
      ["2", `${BASE}?${links.person("abc1001", "patent")}`],
    ]);
    // The link is the person as first or senior author, which is what was counted.
    const q = queryOf(hrefs[1][1]);
    expect([q.getAll("person"), q.getAll("pos"), q.getAll("ctype")]).toEqual([["abc1001"], ["first", "last"], ["clinical"]]);
    for (const cell of row.querySelectorAll("td.text-right")) expectEveryNumberLinked(cell as HTMLElement);
    // Each link says whose papers and which citing type it opens, not just a number.
    expect(within(row).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual([
      "9 papers by Example Person cited downstream",
      "6 papers by Example Person cited by clinical studies",
      "4 papers by Example Person cited in guidelines or policy",
      "3 papers by Example Person cited in systematic reviews",
      "2 papers by Example Person cited in patents",
    ]);
  });

  it("the People tab counts everyone listed, not the search's matches, since the tab's link drops the search", async () => {
    h.reach.mockResolvedValue(data({ pubs: [], people: [PERSON], peopleTotal: 34 }));
    const view = await page({ view: "people", q: "example" });
    const tab = view.getByTestId("downstream-reach-view-people");
    expect(tab.textContent).toBe("People (34)");
    expect(queryOf(tab.getAttribute("href")).get("q")).toBeNull();
    // The pager runs over the matches.
    expect(view.getAllByTestId("downstream-reach-person-row")).toHaveLength(1);
    cleanup();
    // Not loaded: no count.
    h.reach.mockResolvedValue(data());
    expect((await page()).getByTestId("downstream-reach-view-people").textContent).toBe("People");
  });

  it("the People view pages in fifties and says when nobody qualifies", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...PERSON, cwid: `zzz${1000 + i}`, name: `Person ${i}` }));
    h.reach.mockResolvedValue(data({ pubs: [], people: many }));
    const view = await page({ view: "people", page: "2" });
    expect(view.getAllByTestId("downstream-reach-person-row")).toHaveLength(50);
    expect(view.getByTestId("downstream-reach-pager").textContent).toContain("51–100 of 120");
    cleanup();
    h.reach.mockResolvedValue(data({ pubs: [], people: [] }));
    const empty = await page({ view: "people" });
    expect(empty.container.textContent).toContain(
      "No scholar has 3 or more first- or senior-author papers cited downstream for this combination.",
    );
  });

  it("the Person facet with nobody ticked is its note alone, not an empty list under a search box", async () => {
    const view = await page();
    const person = within(view.getAllByTestId("downstream-reach-rail")[0]).getByTestId("downstream-reach-person");
    expect(person.querySelector("input")).toBeNull();
    expect(person.textContent).not.toContain("No matches.");
    expect(person.textContent).toContain("Pick a person from the People tab");
  });

  it("the rail: citing type, own work, stage and research area, and no counts beside any option", async () => {
    const view = await page({ person: ["abc1001"], basis: "cy" });
    const rail = within(view.getAllByTestId("downstream-reach-rail")[0]);
    const boxes = (testId: string) =>
      [...rail.getByTestId(testId).querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((i) => [i.name, i.value, i.checked]);
    // Every option the filter includes is ticked: no "none = all" state (spec E2).
    expect(boxes("downstream-reach-ctype")).toEqual([
      ["", "on", true],
      ["ctype", "clinical", true],
      ["ctype", "trial", true],
      ["ctype", "policy", true],
      ["ctype", "review", true],
      ["ctype", "patent", true],
      ["own", "out", true],
    ]);
    expect(boxes("downstream-reach-stage")).toEqual([
      ["", "on", false],
      ["stage", "T0", true],
      ["stage", "T1", true],
      ["stage", "T2", false],
      ["stage", "T3-4", false],
      ["stage", "none", false],
    ]);
    const form = rail.getByTestId("downstream-reach-filters");
    const hidden = (name: string) =>
      [...form.querySelectorAll<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)].map((i) => i.value);
    // The submitted form says so: no stage ticked is every stage, and own work is in unless the box is ticked.
    expect(hidden("stage")).toEqual(["any"]);
    expect(hidden("own")).toEqual(["in"]);
    expect(form.querySelector<HTMLSelectElement>('select[name="area"]')!.textContent).toContain("Example area");
    // A ticked person is named, never shown as a bare CWID.
    expect(rail.getByTestId("downstream-reach-person").textContent).toContain("Example Person");
    // The facet lists only ticked people, so it offers no search box that could find nobody.
    expect(within(rail.getByTestId("downstream-reach-person")).queryByRole("searchbox")).toBeNull();
    expect(rail.getByTestId("downstream-reach-person").textContent).not.toContain("No matches.");
    // No number beside any option: units and person types carry counts on reports 24 and 25.
    expect(rail.getByTestId("downstream-reach-org-unit").textContent).toContain("Department of Examples");
    expect(rail.getByTestId("downstream-reach-org-unit").textContent).not.toMatch(/\d/);
    expect(rail.getByTestId("downstream-reach-person-type").textContent).not.toMatch(/\d/);
    expect(rail.getByTestId("downstream-reach-ctype").textContent).not.toMatch(/\d/);
  });

  it("own work included: the box is unticked and a chip says so", async () => {
    const view = await page({ own: "in", stage: "any", basis: "cy" });
    const rail = within(view.getAllByTestId("downstream-reach-rail")[0]);
    expect(rail.getByTestId<HTMLInputElement>("downstream-reach-own").checked).toBe(false);
    expect(view.getByTestId("downstream-reach-chips").textContent).toContain("Authors' own work:Included");
    // Every stage: the stage group is all ticked, and no Stage chip.
    const stage = rail.getByTestId("downstream-reach-stage");
    expect([...stage.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((i) => i.checked)).toBe(true);
    expect(view.getByTestId("downstream-reach-chips").textContent).not.toContain("Stage:");
  });

  it("a unit administrator's units are named, and offered alone", async () => {
    h.scope.value = ["dept:N1"];
    const view = await page();
    expect(view.getAllByTestId("downstream-reach-scope")[0].textContent).toContain("Department of Examples");
    expect(view.getByTestId("downstream-reach-chips").textContent).toContain("Unit:Department of Examples");
  });

  it("the export: the same filters, without the search or the every-publication listing", async () => {
    const view = await page({ q: "kinase", show: "all", ctype: "patent", basis: "cy", own: "in" });
    const href = view.getByTestId("downstream-reach-download").getAttribute("href")!;
    expect(href.startsWith("/api/edit/reports/downstream-reach?")).toBe(true);
    const q = queryOf(href);
    expect([q.getAll("ctype"), q.get("own"), q.get("q"), q.get("show")]).toEqual([["patent"], "in", null, null]);
    expect(view.getByTestId("downstream-reach-download-note").textContent).toBe(
      "Publications, Citing documents, People and Criteria sheets",
    );
  });

  it("the note states the counting rule, the people rule, the stage caveat and the sources", async () => {
    const view = await page();
    const note = view.getByRole("note").textContent!;
    for (const said of [
      "Only ReCiter-confirmed authorships of active scholars count",
      "Every number opens the list of what it counts",
      "first or senior author",
      "a later stage is not a better one",
      "NIH iCite",
      "ClinicalTrials.gov",
      "Reliance on Science",
      "Guidelines and policy counts health-authority documents, clinical guidelines and consensus statements.",
      "Systematic reviews are counted on their own",
    ]) {
      expect(note).toContain(said);
    }
  });
});

describe("the rail's checkbox groups (spec E2)", () => {
  it('"All" ticks every option; the last option, or "All" with everything ticked, cannot be cleared', async () => {
    const { AtLeastOneChecklist } = await import("@/components/edit/reports/downstream-reach-client");
    const submits = vi.fn();
    const view = render(
      <form onChange={submits}>
        <AtLeastOneChecklist
          name="g"
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
          selected={["a"]}
        />
      </form>,
    );
    const [all, a, b] = view.getAllByRole("checkbox") as HTMLInputElement[];
    expect([all.checked, a.checked, b.checked]).toEqual([false, true, false]);
    // The last ticked option: the click is cancelled, nothing submits, and the note says why.
    fireEvent.click(a);
    expect(a.checked).toBe(true);
    expect(submits).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toBe("Choose at least one.");
    // "All" ticks the rest before the form hears the change.
    fireEvent.click(all);
    expect([all.checked, a.checked, b.checked]).toEqual([true, true, true]);
    expect(submits).toHaveBeenCalledTimes(1);
    // "All" again would clear everything: refused.
    fireEvent.click(all);
    expect([all.checked, a.checked, b.checked]).toEqual([true, true, true]);
    expect(submits).toHaveBeenCalledTimes(1);
  });
});
