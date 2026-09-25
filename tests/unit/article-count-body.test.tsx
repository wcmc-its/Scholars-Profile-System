/**
 * `components/edit/reports/article-count-body.tsx` — report 8's redesigned
 * body: the rail's sections (lg-only, and a phone `FiltersSheet` copy with its
 * own form id whose ticks submit THAT form), the submitted marker, the chips
 * and their remove links, the By year bars (YTD, year → Articles tab), the
 * Articles tab (citation rows with the matching scholars bold; the "too many"
 * panel and its two combinations above the cap), the download note, the
 * bare-URL unit default, the date-added window and the CWID list. Loaders are
 * mocked at the module boundary; assertions are scoped to the rendered body
 * and the sheet dialog, never `document.body`.
 */
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ choices: vi.fn(), counts: vi.fn(), list: vi.fn(), units: vi.fn(), cwidList: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/manageable-units", () => ({ loadManageableUnits: h.units }));
vi.mock("@/lib/edit/cwid-list", () => ({ loadCwidList: h.cwidList }));
vi.mock("@/lib/edit/article-count-report", async (orig) => ({
  ...(await orig<typeof import("@/lib/edit/article-count-report")>()),
  loadArticleCountChoices: h.choices,
  loadArticleCounts: h.counts,
  loadArticleList: h.list,
}));

import { citationAuthors, renderArticleCountReport, unplacedScholars } from "@/components/edit/reports/article-count-body";

const FACETS = {
  roleCategories: [{ value: "postdoc", label: "Postdoc", count: 3 }],
  departments: [
    {
      value: "dept:MED",
      label: "Medicine",
      count: 9,
      divisions: [{ value: "div:CARD", label: "Cardiology (Medicine)", count: 4 }],
    },
  ],
  centers: [{ value: "center:CC", label: "Cancer Center", count: 2 }],
  institutions: [{ value: "inst:I1", label: "Institution 1", count: 1 }],
};
const BASE = "/edit/reports/article-count";
const SUPERUSER = { cwid: "su00001", isSuperuser: true, isCommsSteward: false };
const UNIT_ADMIN = { cwid: "ua00001", isSuperuser: false, isCommsSteward: false };
const thisYear = new Date().getUTCFullYear();

const ARTICLE = {
  pmid: "100",
  citation: "",
  journal: "J Test",
  year: 2024,
  articleType: "Review",
  jif: 12.5,
  dateAdded: "2024-03-05",
  doi: "10.1/x",
  scholars: [],
  title: "A <i>title</i>.",
  authors: ["Smith JA", "Jones B", "Roe R"],
  matches: [{ cwid: "abc1234", name: "Test Person", rank: 2 }],
  source: "2024;12(3):1-9",
  id: { label: "PMID", value: "100", href: "https://pubmed.ncbi.nlm.nih.gov/100/" },
};

const original = HTMLFormElement.prototype.requestSubmit;
beforeEach(() => {
  vi.clearAllMocks();
  h.choices.mockResolvedValue({ facets: FACETS, atypes: ["Review", "Article"] });
  h.counts.mockResolvedValue({ rows: [{ year: 2024, count: 5 }, { year: 2025, count: 2 }], total: 7 });
  h.list.mockResolvedValue([ARTICLE]);
  h.units.mockResolvedValue({ departments: [], divisions: [], centers: [], cores: [], institutions: [], total: 0 });
});
afterEach(() => {
  HTMLFormElement.prototype.requestSubmit = original;
});

async function renderBody(searchParams: Record<string, string | string[]>, session = SUPERUSER) {
  const { main } = await renderArticleCountReport({ searchParams, basePath: BASE, session } as Parameters<
    typeof renderArticleCountReport
  >[0]);
  const r = render(<div data-testid="body">{main}</div>);
  return { ...r, body: within(r.getByTestId("body")) };
}

const hrefOf = (el: HTMLElement) => new URL(el.getAttribute("href")!, "http://x");

describe("report 8 body — rail and phone sheet", () => {
  it("rail sections in order; the desktop rail is lg-only; the form carries the submitted marker", async () => {
    const { body } = await renderBody({ f: "1" });
    const panel = body.getByTestId("article-count-rail-panel");
    const wrapper = panel.parentElement!.className.split(/\s+/);
    expect(wrapper).toEqual(expect.arrayContaining(["hidden", "lg:block"]));
    const labels = [...panel.querySelectorAll("details > summary")].map(
      (s) => s.querySelector("span > span")?.textContent,
    );
    expect(labels).toEqual([
      "Years",
      "Person type",
      "Department / division",
      "Centers",
      "Institution",
      "CWID list",
      "Article type",
      "Journal Impact Factor",
      "Author position",
    ]);
    expect(within(panel).getByText(/count active people, not articles/)).toBeTruthy();
    const form = within(panel).getByTestId("article-count-filters") as HTMLFormElement;
    expect(new FormData(form).get("f")).toBe("1");
    // Article type is a checkbox list now (was a multi-select); same `atype` param.
    expect(within(panel).getByRole("checkbox", { name: "Review" }).getAttribute("name")).toBe("atype");
  });

  it('counts active filters on the trigger; plain "Filters" when nothing is set', async () => {
    const filtered = await renderBody({ type: "postdoc", unit: ["dept:MED", "center:CC"], pos: "first" });
    const trigger = filtered.body.getByTestId("article-count-filters-sheet-trigger");
    expect(trigger.textContent).toBe("Filters (4)");
    expect(trigger.className).toContain("lg:hidden");
    filtered.unmount();
    const bare = await renderBody({});
    expect(bare.body.getByTestId("article-count-filters-sheet-trigger").textContent).toBe("Filters");
  });

  it("the sheet copy has its own form id, no id is shared, and a tick there submits the sheet's form", async () => {
    const submitted: HTMLFormElement[] = [];
    HTMLFormElement.prototype.requestSubmit = vi.fn(function (this: HTMLFormElement) {
      submitted.push(this);
    });
    const { body, getByTestId, getByRole } = await renderBody({ unit: "dept:MED" });
    fireEvent.click(body.getByTestId("article-count-filters-sheet-trigger"));
    const dialog = getByRole("dialog");
    const railForm = within(body.getByTestId("article-count-rail-panel")).getByTestId(
      "article-count-filters",
    ) as HTMLFormElement;
    const sheetForm = within(dialog).getByTestId("article-count-filters") as HTMLFormElement;
    expect(railForm.id).toBe("article-count-filters");
    expect(sheetForm.id).toBe("article-count-filters-sheet");
    for (const f of [railForm, sheetForm]) {
      expect(f.getAttribute("action")).toBe(BASE);
      expect(f.getAttribute("method")).toBe("get");
    }
    const ids = [...getByTestId("body").querySelectorAll("[id]"), ...dialog.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Cancer Center/ }));
    expect(submitted).toEqual([sheetForm]);
    expect(new FormData(sheetForm).getAll("unit")).toEqual(["dept:MED", "center:CC"]);
    expect(new FormData(railForm).getAll("unit")).toEqual(["dept:MED"]);
  });
});

describe("report 8 body — results card", () => {
  it("chips: the window is fixed; each filter's remove link drops only it and keeps f=1", async () => {
    const { body } = await renderBody({ f: "1", type: "postdoc", unit: ["div:CARD"], jif: "5", from: "2024", to: "2025" });
    const chips = body.getByTestId("article-count-chips");
    expect(within(chips).queryByRole("link", { name: /Remove Years/ })).toBeNull();
    expect(chips.textContent).toContain("Years:2024–2025");
    const div = hrefOf(within(chips).getByRole("link", { name: "Remove Division: Cardiology (Medicine)" }));
    expect(div.pathname).toBe(BASE);
    expect(div.searchParams.getAll("unit")).toEqual([]);
    expect(div.searchParams.get("type")).toBe("postdoc");
    expect(div.searchParams.get("f")).toBe("1");
    const jif = hrefOf(within(chips).getByRole("link", { name: "Remove Impact Factor: ≥ 5" }));
    expect(jif.searchParams.get("jif")).toBe("0");
    expect(jif.searchParams.getAll("unit")).toEqual(["div:CARD"]);
  });

  it("with no filters, a fixed 'All people and article types' chip; reset is disabled on a bare URL only", async () => {
    const bare = await renderBody({});
    expect(bare.body.getByTestId("article-count-chips").textContent).toContain("Scholars:All people and article types");
    expect(within(bare.body.getByTestId("article-count-rail-panel")).queryByRole("link", { name: "Reset to defaults" })).toBeNull();
    bare.unmount();
    const submitted = await renderBody({ f: "1" });
    expect(
      within(submitted.body.getByTestId("article-count-rail-panel"))
        .getByRole("link", { name: "Reset to defaults" })
        .getAttribute("href"),
    ).toBe(BASE);
  });

  it("By year: a bar per year linking to the Articles tab for that year; YTD only on the current year", async () => {
    h.counts.mockResolvedValue({ rows: [{ year: thisYear - 1, count: 5 }, { year: thisYear, count: 2 }], total: 7 });
    const { body } = await renderBody({ f: "1", from: String(thisYear - 1), to: String(thisYear) });
    const rows = within(body.getByTestId("article-count-table")).getAllByRole("link");
    expect(rows.map((r) => r.textContent)).toEqual([`${thisYear - 1}5›`, `${thisYear}YTD2›`]);
    const link = hrefOf(rows[0]);
    expect(link.searchParams.get("tab")).toBe("articles");
    expect(link.searchParams.get("year")).toBe(String(thisYear - 1));
    expect(body.getByTestId("article-count-ytd-note").textContent).toMatch(new RegExp(`^${thisYear} counts articles published through `));
    expect(body.getByTestId("report-stats").textContent).toContain("7");
    expect(body.getByTestId("article-count-articles-tab").textContent).toBe("Articles (7)");
  });

  it("Articles tab: a year pick loads that year's citations, bolds the matching scholar and offers a way back to all years", async () => {
    const { body } = await renderBody({ f: "1", from: "2024", to: "2025", tab: "articles", year: "2024" });
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ from: 2024, to: 2025 }), { year: 2024 });
    expect(body.getByTestId("article-count-articles-tab").textContent).toBe("Articles (5)");
    const row = body.getByTestId("article-row");
    expect(within(row).getByRole("link", { name: "A title" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/100/");
    expect(within(row).getByText("Jones B").tagName).toBe("STRONG");
    expect(within(row).getByText("Smith JA", { exact: false }).tagName).not.toBe("STRONG");
    expect(row.textContent).toContain("JIF 12.5");
    const chip = body.getByTestId("article-year-chip");
    expect(chip.textContent).toContain("Year: 2024");
    const back = hrefOf(within(chip).getByRole("link", { name: "Show all years" }));
    expect(back.searchParams.get("tab")).toBe("articles");
    expect(back.searchParams.has("year")).toBe(false);
  });

  it("Articles tab: a matching scholar with no known author rank is listed on a WCM authors line", async () => {
    h.list.mockResolvedValue([
      {
        ...ARTICLE,
        matches: [
          { cwid: "abc1234", name: "Test Person", rank: 2 },
          { cwid: "zzz0001", name: "Rankless Person", rank: 0 },
        ],
      },
    ]);
    const { body } = await renderBody({ f: "1", from: "2024", to: "2025", tab: "articles" });
    const row = body.getByTestId("article-row");
    const line = within(row).getByTestId("article-other-scholars");
    expect(line.textContent).toBe("WCM authors: Rankless Person");
    expect(within(line).getByText("Rankless Person").tagName).toBe("STRONG");
    // The ranked match stays in the byline, not repeated on the line.
    expect(line.textContent).not.toContain("Test Person");
  });

  it("Articles tab above the cap: no list load, the panel and its two combinations; the download note turns amber", async () => {
    h.counts.mockResolvedValue({ rows: [{ year: 2024, count: 6000 }], total: 6000 });
    const { body } = await renderBody({ f: "1", from: "2024", to: "2024", tab: "articles" });
    expect(h.list).not.toHaveBeenCalled();
    const panel = body.getByTestId("article-count-too-many");
    expect(panel.textContent).toContain("6,000 articles match");
    const a = hrefOf(within(panel).getByRole("link", { name: "First or last author, JIF ≥ 10" }));
    expect([a.searchParams.get("pos"), a.searchParams.get("jif"), a.searchParams.get("tab")]).toEqual(["either", "10", "articles"]);
    const b = hrefOf(within(panel).getByRole("link", { name: "Full-time faculty, last author" }));
    expect([b.searchParams.getAll("type"), b.searchParams.get("pos")]).toEqual([["full_time_faculty"], "last"]);
    const note = body.getByTestId("article-count-download-note");
    expect(note.className).toContain("text-apollo-amber");
    expect(note.textContent).toContain("left out above 5,000 articles");
  });

  it("a year pick narrows the list, and the download note says the download still covers every year", async () => {
    const picked = await renderBody({ f: "1", from: "2024", to: "2025", tab: "articles", year: "2024" });
    expect(picked.body.getByTestId("article-count-download-note").textContent).toContain(
      "The download covers every year in the window, not just 2024.",
    );
    picked.unmount();
    const all = await renderBody({ f: "1", from: "2024", to: "2025", tab: "articles" });
    expect(all.body.getByTestId("article-count-download-note").textContent).not.toContain("every year in the window");
  });

  it("the download link carries the canonical query and the marker, never the view params", async () => {
    const { body } = await renderBody({ f: "1", unit: "dept:MED", tab: "articles", year: "2024", from: "2024", to: "2025" });
    const dl = hrefOf(body.getByTestId("article-count-download"));
    expect(dl.pathname).toBe("/api/edit/reports/article-count");
    expect(dl.searchParams.getAll("unit")).toEqual(["dept:MED"]);
    expect(dl.searchParams.get("f")).toBe("1");
    expect(dl.searchParams.has("tab")).toBe(false);
    expect(dl.searchParams.has("year")).toBe(false);
  });
});

describe("report 8 body — unit default, date added, CWID list", () => {
  it("a bare URL takes the unit administrator's own units (chip + note); a submitted form does not", async () => {
    h.units.mockResolvedValue({
      departments: [],
      divisions: [{ kind: "division", code: "CARD", name: "Cardiology", role: "owner", href: "" }],
      centers: [],
      cores: [{ kind: "core", code: "7", name: "A core", role: "owner", href: "" }],
      institutions: [],
      total: 2,
    });
    const bare = await renderBody({}, UNIT_ADMIN);
    expect(h.counts).toHaveBeenLastCalledWith(expect.objectContaining({ units: ["div:CARD"] }));
    const chip = within(bare.body.getByTestId("article-count-chips")).getByRole("link", {
      name: "Remove Division: Cardiology (Medicine)",
    });
    // Removing the default keeps the marker, so it never comes back.
    expect(hrefOf(chip).searchParams.get("f")).toBe("1");
    expect(bare.body.getByTestId("article-count-default-note")).toBeTruthy();
    const box = within(bare.body.getByTestId("article-count-rail-panel")).getByRole("checkbox", {
      name: /Cardiology \(Medicine\)/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    bare.unmount();

    const cleared = await renderBody({ f: "1" }, UNIT_ADMIN);
    expect(h.counts).toHaveBeenLastCalledWith(expect.objectContaining({ units: [] }));
    expect(cleared.body.queryByTestId("article-count-default-note")).toBeNull();
  });

  it("date-added mode: the date inputs replace the year selects, with quick picks; the stats name the window", async () => {
    const { body } = await renderBody({ f: "1", basis: "added", added_from: "2026-06-26", added_to: "2026-09-24" });
    const years = body.getByTestId("rail-years");
    expect((within(years).getByRole("radio", { name: "Date added to PubMed" }) as HTMLInputElement).checked).toBe(true);
    expect(years.querySelector('select[name="from"]')).toBeNull();
    expect((years.querySelector('input[name="added_from"]') as HTMLInputElement).value).toBe("2026-06-26");
    const picks = within(body.getByTestId("added-quick-picks")).getAllByRole("link");
    expect(picks.map((p) => p.textContent)).toEqual(["Last 30 days", "Last 60 days", "Last 90 days"]);
    expect(hrefOf(picks[0]).searchParams.get("basis")).toBe("added");
    expect(body.getByTestId("report-stats").textContent).toContain("distinct articles added to PubMed Jun 26 – Sep 24, 2026");
    expect(body.getByTestId("article-count-chips").textContent).toContain("Added to PubMed:Jun 26 – Sep 24, 2026");
  });

  it("date-added mode: typing a date does not submit the rail form; Apply dates does", async () => {
    const submitted: FormData[] = [];
    HTMLFormElement.prototype.requestSubmit = vi.fn(function (this: HTMLFormElement) {
      submitted.push(new FormData(this));
    });
    const { body } = await renderBody({ f: "1", basis: "added", added_from: "2026-06-26", added_to: "2026-09-24" });
    const years = within(body.getByTestId("article-count-rail-panel")).getByTestId("rail-years");
    fireEvent.change(within(years).getByLabelText("Added to PubMed from"), { target: { value: "2026-01-02" } });
    fireEvent.change(within(years).getByLabelText("Added to PubMed to"), { target: { value: "2026-02-01" } });
    expect(submitted).toHaveLength(0);
    fireEvent.click(within(years).getByRole("button", { name: "Apply dates" }));
    expect(submitted.map((f) => [f.get("basis"), f.get("added_from"), f.get("added_to")])).toEqual([
      ["added", "2026-01-02", "2026-02-01"],
    ]);
  });

  it("an applied CWID list: counts in the rail, the list id rides the form, a removable chip", async () => {
    h.cwidList.mockResolvedValue({ id: "AbCdEf123456", found: true, cwids: ["aaa1111", "bbb2222"], unmatched: ["bbb2222"] });
    const { body } = await renderBody({ f: "1", list: "AbCdEf123456" });
    const panel = body.getByTestId("article-count-rail-panel");
    expect(within(panel).getByTestId("cwid-list-counts").textContent).toBe("2 entries · 1 matched · 1 not found");
    expect(within(panel).getByTestId("cwid-list-unmatched").textContent).toBe("bbb2222");
    expect(new FormData(within(panel).getByTestId("article-count-filters") as HTMLFormElement).get("list")).toBe("AbCdEf123456");
    const chip = hrefOf(within(body.getByTestId("article-count-chips")).getByRole("link", { name: "Remove CWID list: 2 entries" }));
    expect(chip.searchParams.has("list")).toBe(false);
  });
});

describe("unplacedScholars", () => {
  it("rank-0 and out-of-range matches (and a second match on a placed rank), once per CWID; placed ones never", () => {
    expect(
      unplacedScholars({
        authors: ["A", "B"],
        matches: [
          { cwid: "x", name: "X Person", rank: 2 },
          { cwid: "u", name: "U Person", rank: 0 },
          { cwid: "u", name: "U Person", rank: 0 },
          { cwid: "o", name: "", rank: 9 },
          { cwid: "d", name: "D Person", rank: 2 },
        ],
      }),
    ).toEqual([
      // Two matches on rank 2: the byline carries one (the later), the other is listed.
      { cwid: "x", name: "X Person" },
      { cwid: "u", name: "U Person" },
      { cwid: "o", name: "o" },
    ]);
  });
});

describe("citationAuthors", () => {
  it("a short list in full; a long one keeps the first six, every match and the last author, with gaps marked", () => {
    expect(citationAuthors({ authors: ["A", "B"], matches: [{ cwid: "x", name: "", rank: 2 }] })).toEqual([
      { text: "A" },
      { text: "B", cwid: "x" },
    ]);
    const authors = Array.from({ length: 20 }, (_, i) => `N${i + 1}`);
    const out = citationAuthors({ authors, matches: [{ cwid: "m", name: "", rank: 10 }, { cwid: "u", name: "", rank: 0 }] });
    expect(out.map((a) => a.text)).toEqual(["N1", "N2", "N3", "N4", "N5", "N6", "…", "N10", "…", "N20"]);
    expect(out.find((a) => a.cwid)).toEqual({ text: "N10", cwid: "m" });
  });
});
