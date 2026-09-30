/**
 * `components/edit/mentored-publications-table.tsx` — report 7's results
 * island after the 2026-09-24 redesign, rendered with RTL. Every filter now
 * lives in the body's rail (URL params), so the island only tabs, finds,
 * sorts, pages and expands. Pinned here:
 *   - Learners: the mockup's columns (Learner · Mentors · In window · All
 *     years · JIF ≥ 10 · First author, plus "With a mentor" in the
 *     all-publications set) — no separate Grad year / Type / Department /
 *     Institution columns (the width bug); each mentor with the pair's type
 *     badge (hovering its description) and "Department · Institution"; "—"
 *     never 0 for an unknowable window; the numbers and mentors also stacked
 *     in the Learner cell for phones; grad-year desc default with nulls last;
 *     header sort + `aria-sort`; the find box (name, CWID or mentor) narrows
 *     the rows only and rides the URL / the rail forms as `q`; a row opens to
 *     that learner's papers; "Show 25 more".
 *   - Publications: dateAdded desc by default (the fixture's year order
 *     disagrees on purpose); the sort select; the PMID link and a Scopus-only
 *     row with none; each learner's byline position + window badge; each
 *     mentor's type badge; "No mentor co-author" in the all set.
 *   - Tabs: a click swaps in place and rewrites the URL, a modifier-click is
 *     left to the browser; the hidden `view` input is bound to BOTH rail forms.
 * Every query is scoped to the render container or a test id inside it,
 * never `document.body`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

vi.mock("@/components/ui/hover-tooltip", () => ({
  HoverTooltip: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span data-tooltip={text}>{children}</span>
  ),
}));

import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
import type {
  MentoredPubsPublicationRow,
  MentoredPubsSummaryRow,
} from "@/lib/edit/mentored-publications-report";

const MD = { program: "md", source: "roster", tier: "confirmed" } as const;
const MDPHD = { program: "mdphd", source: "roster", tier: "confirmed" } as const;
const PHD = { program: "phd", source: "jenzabar", tier: "confirmed" } as const;
const VOL = { program: "volunteer", source: "coauthor", tier: "presumptive" } as const;
const CHEN = { cwid: "men0001", name: "Chen, Lin", department: "Medicine", institution: "WCM" };
const OKAFOR = { cwid: "men0002", name: "Okafor, Tunde", department: null, institution: "MSKCC" };
const NKEMELU = { cwid: "men0003", name: "Nkemelu, Obi" };
const FORMS = ["mentored-pubs-filters", "mentored-pubs-filters-sheet"];

function pub(o: Partial<MentoredPubsPublicationRow> & Pick<MentoredPubsPublicationRow, "pmid">): MentoredPubsPublicationRow {
  return {
    title: `Paper ${o.pmid}`,
    journal: "J Test",
    year: null,
    citation: `Paper ${o.pmid}.`,
    jif: null,
    citations: null,
    dateAdded: null,
    authorCount: 3,
    learners: [],
    mentors: [],
    withMentor: true,
    ...o,
  };
}
const onPub = (cwid: string, lastName: string, authorPosition: number | null, inWindow: boolean | null) => ({
  cwid,
  firstName: "Ada",
  lastName,
  firstAuthor: authorPosition === 1,
  authorPosition,
  inWindow,
});

const PUBS: MentoredPubsPublicationRow[] = [
  // NOT in loader order (dateAdded desc, nulls last): a no-op sort would
  // render 3, 4, 1, 2, SCOPUS.
  pub({ pmid: "3", year: 2023, learners: [onPub("stu0002", "Park", 2, null)], mentors: [{ ...NKEMELU, mentorships: [VOL] }] }),
  pub({
    pmid: "4",
    year: 2021,
    dateAdded: new Date("2023-06-01"),
    learners: [onPub("stu0003", "Wu", 2, null)],
    mentors: [{ ...OKAFOR, mentorships: [PHD] }],
  }),
  pub({
    pmid: "1",
    year: 2022,
    dateAdded: new Date("2024-03-01"),
    jif: 5.5,
    citations: 7,
    learners: [onPub("stu0001", "Learner", 1, true)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
  pub({
    pmid: "2",
    year: 2024,
    dateAdded: new Date("2024-01-01"),
    jif: 2,
    learners: [onPub("stu0001", "Learner", 3, false)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
  pub({
    pmid: "SCOPUS:105037533819",
    year: 2020,
    dateAdded: new Date("2023-01-01"),
    learners: [onPub("stu0001", "Learner", 1, true)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
];

function summaryRow(o: Partial<MentoredPubsSummaryRow> & Pick<MentoredPubsSummaryRow, "cwid">): MentoredPubsSummaryRow {
  return {
    gradYear: null,
    entryYear: null,
    entryYearSource: null,
    firstName: "Ada",
    lastName: "Learner",
    program: "MD",
    mentors: [],
    pubsInWindow: null,
    withMentorInWindow: null,
    pubsAllTime: 0,
    highImpactInWindow: null,
    firstAuthorInWindow: null,
    ...o,
  };
}

const LEARNERS: MentoredPubsSummaryRow[] = [
  // Reversed on purpose: a no-op sort would render Park, Wu, Learner, Zed.
  summaryRow({ cwid: "stu0002", lastName: "Park", firstName: "Jun", mentors: [{ ...NKEMELU, mentorship: VOL }], pubsAllTime: 1 }),
  summaryRow({ cwid: "stu0003", lastName: "Wu", firstName: "Hana", mentors: [{ ...OKAFOR, mentorship: MDPHD }] }),
  summaryRow({
    cwid: "stu0001",
    gradYear: 2025,
    entryYear: 2021,
    entryYearSource: "fallback",
    lastName: "Learner",
    mentors: [
      { ...CHEN, mentorship: MD },
      { ...OKAFOR, mentorship: PHD },
    ],
    pubsInWindow: 2,
    withMentorInWindow: 2,
    pubsAllTime: 3,
    highImpactInWindow: 0,
    firstAuthorInWindow: 2,
  }),
  summaryRow({
    cwid: "stu0004",
    gradYear: 2026,
    lastName: "Zed",
    firstName: "Zo",
    mentors: [{ ...CHEN, mentorship: MD }],
    pubsInWindow: 0,
    withMentorInWindow: 0,
    pubsAllTime: 0,
    highImpactInWindow: 0,
    firstAuthorInWindow: 0,
  }),
];

const HREFS = {
  summary: "/edit/reports/mentored-publications?years=2025&mtype=aoc&tail=1&pubs=mentored",
  publications: "/edit/reports/mentored-publications?years=2025&mtype=aoc&tail=1&pubs=mentored&view=publications",
};

type Props = Partial<React.ComponentProps<typeof MentoredPublicationsTable>>;
function renderTable(p: Props = {}) {
  return render(
    <MentoredPublicationsTable
      view="summary"
      viewHrefs={HREFS}
      summary={LEARNERS}
      publications={PUBS}
      pubsMode="mentored"
      highImpactThreshold={10}
      tail={1}
      formIds={FORMS}
      {...p}
    />,
  );
}

const learnerIds = (table: HTMLElement) =>
  [...table.querySelectorAll("tbody tr[data-testid^='mentored-pubs-learner-']")].map((tr) =>
    tr.getAttribute("data-testid")?.replace("mentored-pubs-learner-", ""),
  );
const pubIds = (list: HTMLElement) =>
  [...list.querySelectorAll(":scope > li")].map((li) => li.getAttribute("data-testid")?.replace("mentored-pubs-pub-", ""));

afterEach(() => vi.restoreAllMocks());

describe("MentoredPublicationsTable — learners", () => {
  it("the mockup's columns, no Grad year / Type / Department / Institution columns; 'With a mentor' only in the all set", () => {
    const headers = (el: HTMLElement) =>
      [...within(el).getByTestId("mentored-pubs-summary").querySelectorAll("thead th")].map((th) => th.textContent);
    const { container, unmount } = renderTable();
    expect(headers(container)).toEqual(["Learner·Grad year↓", "Mentors", "In window", "All years", "JIF ≥ 10", "First author"]);
    unmount();
    const all = renderTable({ pubsMode: "all" });
    expect(headers(all.container)).toEqual([
      "Learner·Grad year↓",
      "Mentors",
      "In window",
      "With a mentor",
      "All years",
      "JIF ≥ 10",
      "First author",
    ]);
  });

  it("the Learner cell: name, CWID, 'Grad YYYY' (or 'No grad year'), the entry-year estimate; mentors with a type badge and 'Department · Institution'", () => {
    const { getByTestId } = renderTable();
    const row = getByTestId("mentored-pubs-learner-stu0001");
    const cells = row.querySelectorAll(":scope > td");
    expect(cells[0].textContent).toContain("Learner, Ada");
    expect(cells[0].textContent).toContain("stu0001");
    expect(cells[0].textContent).toContain("Grad 2025");
    expect(cells[0].textContent).toContain("(entry est. 2021)");
    expect(getByTestId("mentored-pubs-learner-stu0002").querySelector("td")!.textContent).toContain("No grad year");
    // The md+ Mentors column: one block per mentor.
    const mentors = cells[1];
    expect(mentors.textContent).toContain("Chen, Lin");
    expect(mentors.textContent).toContain("Medicine · WCM");
    expect(mentors.textContent).toContain("Okafor, Tunde");
    expect(mentors.textContent).toContain("MSKCC");
    expect(within(mentors as HTMLElement).getByText("PhD thesis advisor").closest("[data-tooltip]")?.getAttribute("data-tooltip")).toContain(
      "Jenzabar",
    );
    // A mentor with neither field reads "—".
    expect(getByTestId("mentored-pubs-learner-stu0002").querySelectorAll(":scope > td")[1].textContent).toContain("—");
  });

  it("'—' (never 0) for an unknowable window; a known 0 is 0; the phone stack repeats the numbers in the Learner cell", () => {
    const { getByTestId } = renderTable();
    const nums = (cwid: string) =>
      [...getByTestId(`mentored-pubs-learner-${cwid}`).querySelectorAll(":scope > td")].slice(2).map((td) => td.textContent);
    expect(nums("stu0002")).toEqual(["—", "1", "—", "—"]);
    expect(nums("stu0004")).toEqual(["0", "0", "0", "0"]);
    expect(nums("stu0001")).toEqual(["2", "3", "0", "2"]);
    const stacked = within(getByTestId("mentored-pubs-learner-stu0002")).getByTestId("mentored-pubs-stacked");
    expect(stacked.textContent).toContain("In window—");
    expect(stacked.textContent).toContain("Nkemelu, Obi");
  });

  it("grad-year desc by default, nulls last; Learner sorts by last, first; a header click sets aria-sort and flips", () => {
    const { getByTestId } = renderTable();
    const table = getByTestId("mentored-pubs-summary");
    expect(learnerIds(table)).toEqual(["stu0004", "stu0001", "stu0002", "stu0003"]);
    fireEvent.click(within(table).getByRole("button", { name: /^Learner/ }));
    expect(learnerIds(table)).toEqual(["stu0001", "stu0002", "stu0003", "stu0004"]);
    fireEvent.click(within(table).getByRole("button", { name: /All years/ }));
    expect(learnerIds(table)).toEqual(["stu0001", "stu0002", "stu0003", "stu0004"]);
    const allYears = within(table).getByRole("button", { name: /All years/ }).closest("th")!;
    expect(allYears.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(table).getByRole("button", { name: /In window/ }));
    // Nulls last either way.
    expect(learnerIds(table)).toEqual(["stu0001", "stu0004", "stu0002", "stu0003"]);
    fireEvent.click(within(table).getByRole("button", { name: /In window/ }));
    expect(learnerIds(table)).toEqual(["stu0004", "stu0001", "stu0002", "stu0003"]);
  });

  it("the find box narrows by learner name, CWID or mentor — rows only — and rides the URL and both rail forms as q", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { getByTestId, container } = renderTable();
    const find = getByTestId("mentored-pubs-find");
    fireEvent.change(find, { target: { value: "okafor" } });
    expect(learnerIds(getByTestId("mentored-pubs-summary"))).toEqual(["stu0001", "stu0003"]);
    // The tab count is the filtered report's, not the find box's.
    expect(getByTestId("mentored-pubs-view-summary").textContent).toBe("Learners (4)");
    expect(replaceState).toHaveBeenLastCalledWith(null, "", `${HREFS.summary}&q=okafor`);
    const hidden = [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="q"]')];
    expect(hidden.map((i) => [i.getAttribute("form"), i.value])).toEqual(FORMS.map((f) => [f, "okafor"]));
    fireEvent.change(find, { target: { value: "stu0002" } });
    expect(learnerIds(getByTestId("mentored-pubs-summary"))).toEqual(["stu0002"]);
    fireEvent.change(find, { target: { value: "nobody" } });
    expect(getByTestId("mentored-pubs-empty").textContent).toBe("No learners or mentors match “nobody”.");
  });

  it("starts from the URL's q", () => {
    const { getByTestId } = renderTable({ initialQuery: "zed" });
    expect((getByTestId("mentored-pubs-find") as HTMLInputElement).value).toBe("zed");
    expect(learnerIds(getByTestId("mentored-pubs-summary"))).toEqual(["stu0004"]);
  });

  it("a row with publications opens to that learner's papers (row click or the chevron); a row with none does not", () => {
    const { getByTestId, queryByTestId } = renderTable();
    fireEvent.click(getByTestId("mentored-pubs-learner-stu0001"));
    const open = getByTestId("mentored-pubs-expanded-stu0001");
    // Newest year first; only this learner's badge.
    expect(pubIds(open.querySelector("ol")!)).toEqual(["2", "1", "SCOPUS:105037533819"]);
    expect(within(open).getByTestId("mentored-pubs-pub-1").textContent).toContain("In window");
    expect(within(open).getByTestId("mentored-pubs-pub-2").textContent).toContain("Outside window");
    const toggle = within(getByTestId("mentored-pubs-learner-stu0001")).getByRole("button", {
      name: "Hide publications of Learner, Ada",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(queryByTestId("mentored-pubs-expanded-stu0001")).toBeNull();
    fireEvent.click(getByTestId("mentored-pubs-learner-stu0004"));
    expect(queryByTestId("mentored-pubs-expanded-stu0004")).toBeNull();
  });

  it("25 rows, then 'Show 25 more'", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      summaryRow({ cwid: `stu${String(i).padStart(4, "0")}`, lastName: `L${String(i).padStart(2, "0")}` }),
    );
    const { getByTestId, queryByTestId } = renderTable({ summary: many });
    expect(learnerIds(getByTestId("mentored-pubs-summary"))).toHaveLength(25);
    expect(getByTestId("mentored-pubs-learners-range").textContent).toBe(
      "Showing 25 of 30 learners · select a row to see its publications",
    );
    fireEvent.click(getByTestId("mentored-pubs-learners-more"));
    expect(learnerIds(getByTestId("mentored-pubs-summary"))).toHaveLength(30);
    expect(queryByTestId("mentored-pubs-learners-more")).toBeNull();
  });

  it("an empty report renders the empty copy and no table", () => {
    const { getByTestId, queryByTestId } = renderTable({ summary: [], publications: [] });
    expect(getByTestId("mentored-pubs-empty").textContent).toBe("No learners match these filters.");
    expect(queryByTestId("mentored-pubs-summary")).toBeNull();
  });
});

describe("MentoredPublicationsTable — publications", () => {
  it("dateAdded desc by default (not year); the sort select re-orders; PMID links, a Scopus-only row has none", () => {
    const { getByTestId } = renderTable({ view: "publications" });
    const list = getByTestId("mentored-pubs-publications");
    expect(pubIds(list)).toEqual(["1", "2", "4", "SCOPUS:105037533819", "3"]);
    fireEvent.change(getByTestId("mentored-pubs-sort"), { target: { value: "year" } });
    expect(pubIds(list)).toEqual(["2", "3", "1", "4", "SCOPUS:105037533819"]);
    fireEvent.change(getByTestId("mentored-pubs-sort"), { target: { value: "jif" } });
    expect(pubIds(list).slice(0, 2)).toEqual(["1", "2"]);
    expect(within(getByTestId("mentored-pubs-pub-1")).getByRole("link", { name: "1" }).getAttribute("href")).toBe(
      "https://pubmed.ncbi.nlm.nih.gov/1/",
    );
    const scopus = getByTestId("mentored-pubs-pub-SCOPUS:105037533819");
    expect(scopus.textContent).toContain("Scopus: 105037533819");
    expect(within(scopus).queryByRole("link", { name: "105037533819" })).toBeNull();
  });

  it("each entry: JIF, citations, date added; each learner's byline position and window badge; each mentor's type badge", () => {
    const { getByTestId } = renderTable({ view: "publications" });
    const one = getByTestId("mentored-pubs-pub-1").textContent;
    expect(one).toContain("JIF 5.5");
    expect(one).toContain("7 citations");
    expect(one).toContain("Added to PubMed 2024-03-01");
    expect(one).toContain("Learner, Ada");
    expect(one).toContain("1st author");
    expect(one).toContain("In window");
    expect(one).toContain("Chen, Lin");
    expect(one).toContain("MD");
    const three = getByTestId("mentored-pubs-pub-3").textContent;
    expect(three).toContain("JIF —");
    expect(three).toContain("Citations —");
    expect(three).toContain("Window unknown");
    expect(three).toContain("Volunteer · likely mentee (from co-authorship)");
    expect(getByTestId("mentored-pubs-pub-2").textContent).toContain("last author");
  });

  it("the all set: a paper with no mentor reads 'No mentor co-author'", () => {
    const { getByTestId } = renderTable({
      view: "publications",
      pubsMode: "all",
      publications: [pub({ pmid: "9", learners: [onPub("stu0001", "Learner", 2, true)], withMentor: false })],
    });
    expect(getByTestId("mentored-pubs-pub-9").textContent).toContain("No mentor co-author");
  });

  it("25 entries, then 'Show 25 more'; the empty copy with none", () => {
    const many = Array.from({ length: 27 }, (_, i) => pub({ pmid: String(100 + i) }));
    const { getByTestId, unmount } = renderTable({ view: "publications", publications: many });
    expect(pubIds(getByTestId("mentored-pubs-publications"))).toHaveLength(25);
    expect(getByTestId("mentored-pubs-publications-range").textContent).toBe("Showing 25 of 27 publications");
    fireEvent.click(getByTestId("mentored-pubs-publications-more"));
    expect(pubIds(getByTestId("mentored-pubs-publications"))).toHaveLength(27);
    unmount();
    const empty = renderTable({ view: "publications", publications: [] });
    expect(empty.getByTestId("mentored-pubs-empty").textContent).toBe("No publications match these filters.");
  });
});

describe("MentoredPublicationsTable — view tabs", () => {
  it("a tab click swaps the view in place, rewrites the URL, and keeps BOTH rail forms' hidden view current", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { getByTestId, queryByTestId, container } = renderTable();
    const hidden = () =>
      [...container.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="view"]')].map((i) => [
        i.getAttribute("form"),
        i.value,
      ]);
    expect(getByTestId("mentored-pubs-view-summary").getAttribute("aria-current")).toBe("page");
    expect(getByTestId("mentored-pubs-view-summary").textContent).toBe("Learners (4)");
    expect(getByTestId("mentored-pubs-view-publications").textContent).toBe("Publications (5)");
    expect(getByTestId("mentored-pubs-view-publications").getAttribute("href")).toBe(HREFS.publications);
    expect(hidden()).toEqual(FORMS.map((f) => [f, "summary"]));

    fireEvent.click(getByTestId("mentored-pubs-view-publications"));

    expect(getByTestId("mentored-pubs-publications")).toBeTruthy();
    expect(queryByTestId("mentored-pubs-summary")).toBeNull();
    expect(queryByTestId("mentored-pubs-find")).toBeNull();
    expect(getByTestId("mentored-pubs-view-publications").getAttribute("aria-current")).toBe("page");
    expect(hidden()).toEqual(FORMS.map((f) => [f, "publications"]));
    expect(replaceState).toHaveBeenCalledWith(null, "", HREFS.publications);
  });

  it("a modifier-click is left to the browser (opens the real link, no in-place swap)", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { getByTestId, queryByTestId } = renderTable();
    const link = getByTestId("mentored-pubs-view-publications");
    // jsdom cannot navigate; stand in for the browser so the default is consumed here, not logged.
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link, { metaKey: true });
    expect(queryByTestId("mentored-pubs-publications")).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
