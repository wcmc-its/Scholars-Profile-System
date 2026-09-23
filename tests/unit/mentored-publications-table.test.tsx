/**
 * `components/edit/mentored-publications-table.tsx` — the report 7 client
 * island, rendered with RTL. Publications: default order is dateAdded desc
 * (the fixture's year order DISAGREES on purpose); a header click sorts and
 * sets `aria-sort`, a second click flips; there is NO "Type of mentorship"
 * facet (the type is the page's server-side filter) so every row shows; a
 * Mentor tick filters; "Showing X of Y" follows; the type label renders
 * under the mentor. Learners: the Type column is one line per mentor, no
 * Type facet either; grad-year default sort with null last; the
 * Learner header sorts by last, first. A Scopus-only row (`SCOPUS:` key)
 * prints "Scopus:" with no PubMed link. Every query is scoped to the table's
 * test id or the render container, never `document.body`. Type lines read
 * in the office's words ("MD", "PhD thesis advisor") and hover their
 * category's description — `HoverTooltip` is mocked to surface `text` as an
 * attribute, `publications-report-table.test.tsx`'s convention.
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
const learner = (cwid: string, lastName: string, authorPosition: number | null, inWindow: boolean | null) => ({
  cwid,
  firstName: "Ada",
  lastName,
  firstAuthor: authorPosition === 1,
  authorPosition,
  inWindow,
});

const PUBS: MentoredPubsPublicationRow[] = [
  // Deliberately NOT in loader order (dateAdded desc, nulls last): a no-op
  // sort would render 4, 1, 2 — the order assertion pins the island's sort.
  pub({
    pmid: "3",
    year: 2023,
    learners: [learner("stu0002", "Park", 2, null)],
    mentors: [{ ...NKEMELU, mentorships: [VOL] }],
  }),
  pub({
    pmid: "4",
    year: 2021,
    dateAdded: new Date("2023-06-01"),
    learners: [learner("stu0003", "Wu", 2, null)],
    mentors: [{ ...OKAFOR, mentorships: [PHD] }],
  }),
  pub({
    pmid: "1",
    year: 2022,
    dateAdded: new Date("2024-03-01"),
    jif: 5.5,
    learners: [learner("stu0001", "Learner", 1, true)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
  pub({
    pmid: "2",
    year: 2024,
    dateAdded: new Date("2024-01-01"),
    jif: 2,
    learners: [learner("stu0001", "Learner", 3, false)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
  pub({
    pmid: "SCOPUS:105037533819",
    year: 2020,
    dateAdded: new Date("2023-01-01"),
    learners: [learner("stu0001", "Learner", 1, true)],
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
  summaryRow({ cwid: "stu0002", lastName: "Park", firstName: "Jun", mentors: [{ ...NKEMELU, mentorship: VOL }] }),
  summaryRow({ cwid: "stu0003", lastName: "Wu", firstName: "Hana", mentors: [{ ...OKAFOR, mentorship: MDPHD }] }),
  summaryRow({
    cwid: "stu0001",
    gradYear: 2025,
    lastName: "Learner",
    program: "AOC / PhD",
    mentors: [
      { ...CHEN, mentorship: MD },
      { ...OKAFOR, mentorship: PHD },
    ],
    pubsInWindow: 4,
    pubsAllTime: 6,
  }),
  summaryRow({
    cwid: "stu0004",
    gradYear: 2026,
    lastName: "Zed",
    firstName: "Zo",
    mentors: [{ ...CHEN, mentorship: MD }],
    pubsInWindow: 2,
    pubsAllTime: 2,
  }),
];

const HREFS = {
  summary: "/edit/reports/7?years=2025&mtype=aoc",
  publications: "/edit/reports/7?years=2025&mtype=aoc&view=publications",
};
const DOWNLOAD = "/api/edit/reports/mentored-publications?years=2025&mtype=aoc";

const rowIds = (table: HTMLElement, prefix: string) =>
  [...table.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-testid")?.replace(prefix, ""));

function renderPubs() {
  const utils = render(
    <MentoredPublicationsTable view="publications" viewHrefs={HREFS} downloadHref={DOWNLOAD} summary={[]} publications={PUBS} pubsMode="mentored" highImpactThreshold={10} />,
  );
  const table = () => utils.getByTestId("mentored-pubs-publications");
  return { ...utils, table, ids: () => rowIds(table(), "mentored-pubs-pub-") };
}

describe("MentoredPublicationsTable — publications", () => {
  it("defaults to dateAdded desc (not year), shows every row (no Type facet), prints the date and the type under the mentor", () => {
    const { table, ids, getByTestId } = renderPubs();
    expect(ids()).toEqual(["1", "2", "4", "SCOPUS:105037533819", "3"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 5 of 5 publications");
    const row1 = within(table()).getByTestId("mentored-pubs-pub-1");
    expect(within(row1).getByText("2024-03-01")).toBeTruthy();
    const type = within(row1).getByText("MD");
    expect(type.parentElement?.getAttribute("data-tooltip")).toMatch(
      /^MD students. pairs, recorded by the Areas of Concentration \(AOC\) program/,
    );
    expect(within(row1).getByText("1st author")).toBeTruthy();
    expect(within(row1).getByRole("link", { name: "1" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/1/");
    // A Scopus-only row: "Scopus:" label, the bare id, no PubMed link.
    const scopus = within(table()).getByTestId("mentored-pubs-pub-SCOPUS:105037533819");
    expect(scopus.textContent).toContain("Scopus: 105037533819");
    expect(within(scopus).queryByRole("link", { name: "105037533819" })).toBeNull();
    expect(within(within(table()).getByTestId("mentored-pubs-pub-2")).getByText("last author")).toBeTruthy();
    const dateTh = within(table()).getByRole("columnheader", { name: /Date added/ });
    expect(dateTh.getAttribute("aria-sort")).toBe("descending");
  });

  it("clicking Year sorts by year desc and sets aria-sort; clicking again flips; nulls last", () => {
    const { table, ids } = renderPubs();
    const yearTh = within(table()).getByRole("columnheader", { name: /^Year/ });
    expect(yearTh.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(yearTh).getByRole("button"));
    expect(ids()).toEqual(["2", "3", "1", "4", "SCOPUS:105037533819"]);
    expect(within(table()).getByRole("columnheader", { name: /^Year/ }).getAttribute("aria-sort")).toBe("descending");
    expect(within(table()).getByRole("columnheader", { name: /Date added/ }).getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Year/ })).getByRole("button"));
    expect(ids()).toEqual(["SCOPUS:105037533819", "4", "1", "3", "2"]);
    expect(within(table()).getByRole("columnheader", { name: /^Year/ }).getAttribute("aria-sort")).toBe("ascending");
    // Impact factor asc: the two null JIFs stay last.
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Impact factor/ })).getByRole("button"));
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Impact factor/ })).getByRole("button"));
    expect(ids().slice(0, 2)).toEqual(["2", "1"]);
  });

  it("children (the page's server filter form) head the rail, above the first client facet, in both views", () => {
    for (const view of ["publications", "summary"] as const) {
      const { container, unmount } = render(
        <MentoredPublicationsTable
          view={view}
          viewHrefs={HREFS}
          downloadHref={DOWNLOAD}
          summary={LEARNERS}
          publications={PUBS}
          pubsMode="mentored"
          highImpactThreshold={10}
        >
          <form data-testid="server-filters" />
        </MentoredPublicationsTable>,
      );
      const form = within(container).getByTestId("server-filters");
      const firstFacet = within(container).getAllByRole("heading", { level: 3 })[0];
      // Same rail box, and the form comes first.
      expect(form.parentElement).toBe(firstFacet.closest(".bg-apollo-rail"));
      expect(form.compareDocumentPosition(firstFacet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  it("the rail has no Type facet (Year · Learner author position · In program window · Mentor); ticking a Mentor narrows; Showing X of Y follows", () => {
    const { container, ids, getByTestId } = renderPubs();
    const rail = within(container);
    expect(rail.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Year",
      "Learner author position",
      "In program window",
      "Mentor",
    ]);
    expect(
      rail.queryByRole("button", { name: /Volunteer · likely mentee \(from co-authorship\)/ }),
    ).toBeNull();
    expect(rail.queryByRole("button", { name: /^AOC/ })).toBeNull();
    fireEvent.click(rail.getByRole("button", { name: /Chen, Lin/ }));
    expect(ids()).toEqual(["1", "2", "SCOPUS:105037533819"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 3 of 5 publications");
    // Position facet: "Last" is only pmid 2 of the rows passing the other facets.
    expect(rail.getByRole("button", { name: /^Last/ }).textContent).toBe("Last1");
  });
});

function renderLearners() {
  const utils = render(
    <MentoredPublicationsTable view="summary" viewHrefs={HREFS} downloadHref={DOWNLOAD} summary={LEARNERS} publications={[]} pubsMode="mentored" highImpactThreshold={10} />,
  );
  const table = () => utils.getByTestId("mentored-pubs-summary");
  return { ...utils, table, ids: () => rowIds(table(), "mentored-pubs-learner-") };
}

describe("MentoredPublicationsTable — learners", () => {
  it("Type column is one line per mentor; grad-year desc default with null last; every learner shows, no Type facet in the rail", () => {
    const { table, ids, getByTestId, container } = renderLearners();
    expect(ids()).toEqual(["stu0004", "stu0001", "stu0002", "stu0003"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 4 of 4 learners");
    // The column stays; the facet (a button per type label) is gone.
    expect(
      within(container)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["In program window", "Mentor"]);
    expect(within(container).queryByRole("button", { name: /^AOC/ })).toBeNull();
    expect(within(container).queryByRole("button", { name: /co-author/ })).toBeNull();
    expect(within(container).getByRole("button", { name: /Chen, Lin/ })).toBeTruthy();
    const row = within(table()).getByTestId("mentored-pubs-learner-stu0001");
    // Grad year · Learner · Type — no Program column (the Type line names the
    // program; a separate column read "MD | MD").
    expect([...table().querySelectorAll("thead th")].map((th) => th.textContent?.trim())).not.toContain("Program");
    const typeCell = row.querySelectorAll("td")[2];
    expect([...typeCell.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "MD",
      "PhD thesis advisor",
    ]);
    // Each line hovers its category's description; nothing in a user-facing word is a table name.
    expect(
      [...typeCell.querySelectorAll("[data-tooltip]")].map((el) => el.getAttribute("data-tooltip")),
    ).toEqual([
      expect.stringMatching(/^MD students. pairs, recorded by the Areas of Concentration \(AOC\) program/),
      expect.stringMatching(/^Thesis-advisor pairs from the Graduate School/),
    ]);
    expect(typeCell.textContent).not.toMatch(/roster|Jenzabar|presumptive/);
    expect(within(table()).getByRole("columnheader", { name: /Grad year/ }).getAttribute("aria-sort")).toBe("descending");
    expect(within(table()).getByRole("columnheader", { name: /Impact factor ≥ 10/ })).toBeTruthy();
  });

  it("Department and Institution columns follow Mentors, one line per mentor in its order, — where unknown", () => {
    const { table } = renderLearners();
    const headers = [...table().querySelectorAll("thead th")].map((th) => th.textContent?.trim());
    expect(headers.slice(3, 6)).toEqual(["Mentors", "Department", "Institution"]);
    const cells = within(table()).getByTestId("mentored-pubs-learner-stu0001").querySelectorAll("td");
    const lines = (td: Element) => [...td.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines(cells[3])).toEqual(["Chen, Linmen0001", "Okafor, Tundemen0002"]);
    expect(lines(cells[4])).toEqual(["Medicine", "—"]);
    expect(lines(cells[5])).toEqual(["WCM", "MSKCC"]);
  });

  it("the Learner header sorts by last, first", () => {
    const { table, ids } = renderLearners();
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Learner/ })).getByRole("button"));
    expect(ids()).toEqual(["stu0001", "stu0002", "stu0003", "stu0004"]);
    expect(within(table()).getByRole("columnheader", { name: /^Learner/ }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("an empty report renders the empty copy and no table", () => {
    const { queryByTestId, getByTestId } = render(
      <MentoredPublicationsTable view="summary" viewHrefs={HREFS} downloadHref={DOWNLOAD} summary={[]} publications={[]} pubsMode="mentored" highImpactThreshold={10} />,
    );
    expect(getByTestId("mentored-pubs-empty").textContent).toBe("No learners match these filters.");
    expect(queryByTestId("mentored-pubs-summary")).toBeNull();
  });
});

describe("MentoredPublicationsTable — view tabs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a tab click swaps the view in place, rewrites the URL, and keeps the form's hidden view current", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { getByTestId, queryByTestId, container } = render(
      <MentoredPublicationsTable view="summary" viewHrefs={HREFS} downloadHref={DOWNLOAD} summary={LEARNERS} publications={PUBS} pubsMode="mentored" highImpactThreshold={10} />,
    );
    const hidden = () => container.querySelector<HTMLInputElement>('input[name="view"][form="mentored-pubs-filters"]');
    expect(getByTestId("mentored-pubs-summary")).toBeTruthy();
    expect(getByTestId("mentored-pubs-view-summary").getAttribute("aria-current")).toBe("page");
    expect(getByTestId("mentored-pubs-view-summary").textContent).toBe("Summary");
    expect(getByTestId("mentored-pubs-view-publications").getAttribute("href")).toBe(HREFS.publications);
    expect(hidden()?.value).toBe("summary");
    expect(getByTestId("mentored-pubs-download").getAttribute("href")).toBe(DOWNLOAD);

    fireEvent.click(getByTestId("mentored-pubs-view-publications"));

    expect(getByTestId("mentored-pubs-publications")).toBeTruthy();
    expect(queryByTestId("mentored-pubs-summary")).toBeNull();
    expect(getByTestId("mentored-pubs-view-publications").getAttribute("aria-current")).toBe("page");
    expect(hidden()?.value).toBe("publications");
    expect(replaceState).toHaveBeenCalledWith(null, "", HREFS.publications);
  });

  it("a modifier-click is left to the browser (opens the real link, no in-place swap)", () => {
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    const { getByTestId, queryByTestId } = render(
      <MentoredPublicationsTable view="summary" viewHrefs={HREFS} downloadHref={DOWNLOAD} summary={LEARNERS} publications={PUBS} pubsMode="mentored" highImpactThreshold={10} />,
    );
    const link = getByTestId("mentored-pubs-view-publications");
    // jsdom cannot navigate; stand in for the browser so the default is consumed here, not logged.
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link, { metaKey: true });
    expect(queryByTestId("mentored-pubs-publications")).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
