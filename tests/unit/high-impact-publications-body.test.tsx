/**
 * Report 9's redesigned page: `high-impact-publications-body.tsx` (rail
 * sections, headline numbers, download note, chips, phone sheet),
 * `high-impact-results.tsx` (Scholars table: sort, find, expand, show more;
 * Publications list: impact factor, DOI, date added, PMID, sort) and
 * `rail-checklist.tsx` (hidden options still submit; the search box never
 * submits). Assertions are scoped to the rendered container, never
 * `document.body`. Fixture people are invented.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ choices: vi.fn(), totals: vi.fn(), list: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/article-count-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/article-count-report")>()),
  loadArticleCountChoices: h.choices,
}));
vi.mock("@/lib/edit/high-impact-pubs-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/high-impact-pubs-report")>()),
  loadHighImpactTotals: h.totals,
  loadHighImpactList: h.list,
}));

import { renderHighImpactPublicationsReport } from "@/components/edit/reports/high-impact-publications-body";
import {
  HighImpactResults,
  type HighImpactPub,
} from "@/components/edit/reports/high-impact-results";
import { RailChecklist } from "@/components/edit/reports/rail-checklist";
import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  HIGH_IMPACT_LIST_CAP,
  summarizePeople,
  type HighImpactRow,
} from "@/lib/edit/high-impact-pubs-report";

afterEach(cleanup);

const FACETS = {
  roleCategories: [{ value: "full_time_faculty", label: "Full-time faculty", count: 70 }],
  departments: [{ value: "dept:MED", label: "Medicine", count: 34, divisions: [] }],
  centers: [{ value: "center:CC", label: "Test Center", count: 5 }],
  institutions: [{ value: "inst:I1", label: "Institution One", count: 70 }],
};
const BASE = "/edit/reports/high-impact-publications";

type Who = { cwid: string; name: string; position: "first" | "last" | "middle" };
function pub(pmid: string, over: Partial<HighImpactRow>, people: Who[]): HighImpactRow {
  return {
    pmid,
    title: `Title ${pmid}`,
    journal: "Nature Medicine",
    year: 2026,
    articleType: "Academic Article",
    jif: 50.123,
    dateAdded: "2026-03-04",
    citations: 3,
    doi: `10.1000/x${pmid}`,
    cite: "2026;12(3):100-110.",
    id: { label: "PMID", value: pmid, href: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` },
    byline: [{ text: "Alpha A" }, { text: "Beta B", wcm: true, cwid: "zzb9002" }],
    authors: people.map((p) => `${p.name} (${p.position} author)`),
    people: people.map((p) => ({ ...p, department: "Medicine", personType: "Full-time faculty" })),
    ...over,
  };
}
const ANN = { cwid: "zza9001", name: "Ann Testperson", position: "first" } as const;
const BOB = { cwid: "zzb9002", name: "Bob Exampleton", position: "last" } as const;
const LIST = [
  pub("111", { citations: 1, year: 2025, journal: "Blood" }, [ANN]),
  pub("222", { citations: 40, jif: null, doi: null }, [BOB]),
  pub("333", { citations: 5 }, [BOB, { ...ANN, position: "last" }]),
];

async function renderBody(searchParams: Record<string, string | string[]> = {}) {
  const { main } = await renderHighImpactPublicationsReport({
    searchParams,
    basePath: BASE,
  } as Parameters<typeof renderHighImpactPublicationsReport>[0]);
  const r = render(<div data-testid="body">{main}</div>);
  return within(r.getByTestId("body"));
}

beforeEach(() => {
  h.choices
    .mockReset()
    .mockResolvedValue({ facets: FACETS, atypes: ["Academic Article", "Review"] });
  h.totals.mockReset().mockResolvedValue({ articles: 3, scholars: 2 });
  h.list.mockReset().mockResolvedValue(LIST);
});

describe("report 9 body", () => {
  it("the rail: one section per filter, in the mockup's order, years open; reset disabled on the defaults", async () => {
    const q = await renderBody();
    const rail = q.getAllByTestId("high-impact-rail")[0];
    const labels = [...rail.querySelectorAll("details > summary")].map(
      (s) => s.querySelector("span > span")?.textContent,
    );
    expect(labels).toEqual([
      "Years",
      "Journals",
      "Person type",
      "Department / division",
      "Centers",
      "Institution",
      "Article type",
      "Author position",
    ]);
    const years = within(rail).getByTestId("high-impact-years");
    expect(years.hasAttribute("open")).toBe(true);
    expect(years.querySelector("summary")?.textContent).toContain(
      `${new Date().getFullYear()} · Calendar`,
    );
    expect(
      within(rail).getByTestId("high-impact-journals").querySelector("summary")?.textContent,
    ).toContain("All 10 top-tier journal families");
    expect(within(rail).queryByRole("link", { name: "Reset to defaults" })).toBeNull();
    // The desktop copy lives in the lg-only column; phones get the sheet trigger.
    expect(rail.parentElement?.className).toContain("hidden");
    expect(q.getByTestId("high-impact-filters-sheet-trigger").textContent).toBe("Filters (3)");
  });

  it("the defaults submit as the form says: basis radios, awards selections ticked, view carried", async () => {
    const q = await renderBody({ view: "publications" });
    const form = q.getAllByTestId("high-impact-filters")[0] as HTMLFormElement;
    const fd = new FormData(form);
    expect(fd.get("view")).toBe("publications");
    expect(fd.get("basis")).toBe("cy");
    expect(fd.getAll("type")).toEqual(["full_time_faculty"]);
    expect(fd.getAll("atype")).toEqual(["Academic Article"]);
    expect(fd.get("pos")).toBe("either");
    expect(fd.getAll("journal")).toHaveLength(10);
    expect(fd.getAll("unit")).toEqual([]);
  });

  it("headline numbers, download link with the same query, chips; a changed filter enables reset", async () => {
    const q = await renderBody({
      pos: "first",
      from: "2025",
      to: "2026",
      unit: "dept:MED",
      view: "summary",
    });
    const stats = q.getByTestId("report-stats");
    expect([...stats.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["2", "3"]);
    expect([...stats.querySelectorAll("dt")].map((d) => d.textContent)).toEqual([
      "scholars",
      "distinct publications",
    ]);
    const dl = q.getByTestId("high-impact-download").getAttribute("href")!;
    expect(dl).toMatch(/^\/api\/edit\/reports\/high-impact-publications\?/);
    expect(new URLSearchParams(dl.split("?")[1]).getAll("unit")).toEqual(["dept:MED"]);
    expect(q.getByTestId("high-impact-download-note").textContent).toBe(
      "Includes the Criteria, People and Publications sheets.",
    );
    const chips = q.getByTestId("high-impact-chips");
    expect(chips.textContent).toContain("Years:2025–2026");
    expect(chips.textContent).toContain("Department / division:Medicine");
    const remove = within(chips).getByRole("link", {
      name: "Remove Department / division: Medicine",
    });
    expect(new URLSearchParams(remove.getAttribute("href")!.split("?")[1]).getAll("unit")).toEqual(
      [],
    );
    expect(q.getAllByRole("link", { name: "Reset to defaults" })[0].getAttribute("href")).toBe(
      BASE,
    );
  });

  it("above the scholar export cap the note warns the People sheet is withheld", async () => {
    h.totals.mockResolvedValue({ articles: 86, scholars: SCHOLAR_EXPORT_CAP + 19 });
    const q = await renderBody();
    const note = q.getByTestId("high-impact-download-note");
    expect(note.textContent).toContain(`left out above ${SCHOLAR_EXPORT_CAP} people`);
    expect(note.className).toContain("text-apollo-amber");
  });

  it("above the list cap the list is not loaded and the tab says to narrow", async () => {
    h.totals.mockResolvedValue({ articles: HIGH_IMPACT_LIST_CAP + 1, scholars: 900 });
    const q = await renderBody();
    expect(h.list).not.toHaveBeenCalled();
    expect(q.getByTestId("high-impact-results").textContent).toContain(
      "Narrow the filters to list them.",
    );
    expect(q.getByTestId("high-impact-view-summary").textContent).toBe("Scholars (900)");
  });

  it("a unit in the URL that no rail option carries still lists, ticked, in its own group", async () => {
    const units = ["dept:GONE", "center:GONE", "inst:GONE"];
    const q = await renderBody({ unit: units });
    const form = q.getAllByTestId("high-impact-filters")[0] as HTMLFormElement;
    expect(new FormData(form).getAll("unit")).toEqual(units);
    const boxes = (section: string) =>
      [...within(form).getByTestId(section).querySelectorAll("input[type=checkbox]:checked")].map(
        (b) => (b as HTMLInputElement).value,
      );
    expect(boxes("high-impact-department")).toEqual(["dept:GONE"]);
    expect(boxes("high-impact-centers")).toEqual(["center:GONE"]);
    expect(boxes("high-impact-institution")).toEqual(["inst:GONE"]);
  });

  it("a unit repeated in the URL lists once, so one untick clears it", async () => {
    const q = await renderBody({ unit: ["dept:GONE", "dept:GONE"] });
    const form = q.getAllByTestId("high-impact-filters")[0] as HTMLFormElement;
    const boxes = within(form).getByTestId("high-impact-department").querySelectorAll('input[value="dept:GONE"]');
    expect(boxes).toHaveLength(1);
  });

  it("the partial-year footnote shows only when the window includes the year in progress", async () => {
    const y = new Date().getFullYear();
    const note = () => q.getAllByRole("note")[0].textContent;
    let q = await renderBody();
    expect(note()).toContain(`${y} counts publications through`);
    cleanup();
    q = await renderBody({ from: String(y + 1), to: String(y + 1) });
    expect(note()).not.toContain("counts publications through");
    cleanup();
    q = await renderBody({ from: String(y - 3), to: String(y - 1) });
    expect(note()).not.toContain("counts publications through");
  });

  it("the fiscal basis labels years FY and says so in the rail", async () => {
    const q = await renderBody({ basis: "fy", from: "2025", to: "2026", pos: "any" });
    const years = q.getAllByTestId("high-impact-years")[0];
    expect(years.querySelector("summary")?.textContent).toContain(
      "FY2025–FY2026 · Fiscal (July–June)",
    );
    expect(within(years).getByRole("combobox", { name: "From year" }).textContent).toContain(
      "FY2025",
    );
  });
});

function renderResults(view: "summary" | "publications", list: HighImpactRow[] = LIST) {
  const pubs: HighImpactPub[] = list;
  const r = render(
    <HighImpactResults
      view={view}
      tabHrefs={{ summary: `${BASE}?view=summary`, publications: `${BASE}?view=publications` }}
      counts={{ scholars: 2, articles: list.length }}
      people={summarizePeople(list)}
      pubs={pubs}
      showPersonType={false}
      overCapMessage="over"
    />,
  );
  return within(r.container);
}

const names = (q: ReturnType<typeof renderResults>) =>
  q.getAllByTestId("high-impact-scholar-row").map((tr) => tr.querySelector("button")?.textContent);

describe("report 9 Scholars tab", () => {
  it("most articles first; the headers sort; the find box filters by name or CWID", () => {
    const q = renderResults("summary");
    expect(names(q)).toEqual(["Ann Testperson", "Bob Exampleton"]);
    // Citations: Bob 45, Ann 6.
    fireEvent.click(
      within(q.getByTestId("high-impact-summary")).getByRole("button", { name: /Citations/ }),
    );
    expect(names(q)).toEqual(["Bob Exampleton", "Ann Testperson"]);
    fireEvent.change(q.getByRole("searchbox", { name: /Find a scholar/ }), {
      target: { value: "zza" },
    });
    expect(names(q)).toEqual(["Ann Testperson"]);
    fireEvent.change(q.getByRole("searchbox", { name: /Find a scholar/ }), {
      target: { value: "nobody" },
    });
    expect(q.getByText("No scholars match “nobody”.")).toBeTruthy();
  });

  it("a row shows its position split and journals; selecting it lists that scholar's publications with their position", () => {
    const q = renderResults("summary");
    const ann = q.getAllByTestId("high-impact-scholar-row")[0];
    expect(ann.textContent).toContain("1 first");
    expect(ann.textContent).toContain("1 last");
    expect(q.queryByTestId("high-impact-scholar-pubs")).toBeNull();
    fireEvent.click(ann);
    const list = q.getByTestId("high-impact-scholar-pubs");
    const items = list.querySelectorAll("li");
    // Newest first: 333 (2026) before 111 (2025).
    expect([...items].map((li) => li.querySelector("a")?.textContent)).toEqual([
      "Title 333",
      "Title 111",
    ]);
    expect(items[0].textContent).toContain("Last author");
    expect(items[1].textContent).toContain("First author");
    fireEvent.click(within(ann).getByRole("button", { name: "Ann Testperson" }));
    expect(q.queryByTestId("high-impact-scholar-pubs")).toBeNull();
  });

  it("25 rows, then Show 25 more", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      pub(String(1000 + i), {}, [
        { cwid: `zzc${9100 + i}`, name: `Person ${i}`, position: "first" },
      ]),
    );
    const q = renderResults("summary", many);
    expect(q.getAllByTestId("high-impact-scholar-row")).toHaveLength(25);
    expect(q.getByText(/Showing 25 of 30 scholars/)).toBeTruthy();
    fireEvent.click(q.getByRole("button", { name: "Show 25 more" }));
    expect(q.getAllByTestId("high-impact-scholar-row")).toHaveLength(30);
    expect(q.queryByRole("button", { name: "Show 25 more" })).toBeNull();
  });

  it("the table scrolls inside its own box, never the page", () => {
    const q = renderResults("summary");
    expect(q.getByTestId("high-impact-summary").parentElement?.className).toContain(
      "overflow-x-auto",
    );
  });
});

describe("report 9 Publications tab", () => {
  it("each row keeps impact factor, DOI, date added to PubMed and PMID, and names the matching scholars", () => {
    const q = renderResults("publications");
    const items = q.getByTestId("high-impact-publications").querySelectorAll("li");
    const first = [...items].find((li) => li.textContent?.includes("Title 333"))!;
    expect(first.textContent).toContain("Impact factor 50.1");
    expect(first.textContent).toContain("Added to PubMed 2026-03-04");
    expect(within(first).getByRole("link", { name: "DOI 10.1000/x333" }).getAttribute("href")).toBe(
      "https://doi.org/10.1000/x333",
    );
    expect(within(first).getByRole("link", { name: "PMID 333" }).getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/333/",
    );
    expect(first.textContent).toContain("Bob Exampleton (last author)");
    expect(first.textContent).toContain("Ann Testperson (last author)");
    expect(first.textContent).toContain("Nature Medicine. 2026;12(3):100-110.");
    // Matching WCM authors bold in the byline, each the trigger of its scholar's hover card.
    const beta = within(first).getByText("Beta B");
    expect(beta.className).toContain("font-bold");
    expect(beta.getAttribute("data-state")).toBe("closed");
    expect(within(first).getByText("Alpha A").getAttribute("data-state")).toBeNull();
    const noDoi = [...items].find((li) => li.textContent?.includes("Title 222"))!;
    expect(noDoi.textContent).not.toContain("DOI");
    expect(noDoi.textContent).not.toContain("Impact factor");
  });

  it("sorts: newest first by default, then most cited, journal A–Z, highest impact factor", () => {
    const q = renderResults("publications");
    const order = () =>
      [...q.getByTestId("high-impact-publications").querySelectorAll("li > a:first-child")].map(
        (a) => a.textContent,
      );
    // 222 and 333 are both 2026 with the same add date: higher PMID first.
    expect(order()).toEqual(["Title 333", "Title 222", "Title 111"]);
    const sort = q.getByTestId("high-impact-pub-sort");
    expect([...sort.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Newest first",
      "Most cited",
      "Journal A–Z",
      "Highest impact factor",
    ]);
    fireEvent.change(sort, { target: { value: "cites" } });
    expect(order()).toEqual(["Title 222", "Title 333", "Title 111"]);
    fireEvent.change(sort, { target: { value: "journal" } });
    expect(order()).toEqual(["Title 111", "Title 333", "Title 222"]);
    fireEvent.change(sort, { target: { value: "jif" } });
    expect(order()).toEqual(["Title 333", "Title 111", "Title 222"]);
  });
});

describe("RailChecklist (roomy)", () => {
  const OPTS = Array.from({ length: 10 }, (_, i) => ({
    value: `dept:D${i}`,
    label: `Dept ${i}`,
    count: 10 - i,
  }));

  it("past `collapseAfter` options are hidden, not removed, so a ticked one still submits; Show all reveals them", () => {
    const r = render(
      <form data-testid="f">
        <RailChecklist
          roomy
          name="unit"
          options={OPTS}
          selected={["dept:D9"]}
          collapseAfter={3}
          countLabel="People"
        />
      </form>,
    );
    const q = within(r.container);
    const hidden = [...r.container.querySelectorAll("li")].filter((l) => l.hidden);
    // D3..D8 hidden; D9 is ticked so it lists.
    expect(hidden).toHaveLength(6);
    expect(new FormData(q.getByTestId("f") as HTMLFormElement).getAll("unit")).toEqual(["dept:D9"]);
    fireEvent.click(q.getByRole("button", { name: "Show all 10" }));
    expect([...r.container.querySelectorAll("li")].filter((l) => l.hidden)).toHaveLength(0);
  });

  it("typing in the search box filters the options and never reaches the form's change handler", () => {
    const onChange = vi.fn();
    const r = render(
      <form onChange={onChange}>
        <RailChecklist
          roomy
          name="unit"
          options={OPTS}
          selected={[]}
          searchPlaceholder="Search departments…"
          collapseAfter={8}
        />
      </form>,
    );
    const q = within(r.container);
    fireEvent.change(q.getByRole("searchbox", { name: "Search departments…" }), {
      target: { value: "Dept 4" },
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      [...r.container.querySelectorAll("li")].filter((l) => !l.hidden).map((l) => l.textContent),
    ).toEqual(["Dept 46"]);
    fireEvent.click(q.getByRole("checkbox", { name: /Dept 4/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
