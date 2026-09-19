/**
 * `components/edit/mentored-publications-table.tsx` — the report 7 client
 * island, rendered with RTL. Publications: default order is dateAdded desc
 * (the fixture's year order DISAGREES on purpose); a header click sorts and
 * sets `aria-sort`, a second click flips; a co-author-typed row is hidden
 * until its Type checkbox is ticked; a Mentor tick filters; "Showing X of Y"
 * follows; the type label renders under the mentor. Learners: the Type
 * column is one line per mentor; grad-year default sort with null last; the
 * Learner header sorts by last, first. Every query is scoped to the table's
 * test id or the render container, never `document.body`.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";

import { MentoredPublicationsTable } from "@/components/edit/mentored-publications-table";
import type {
  MentoredPubsPublicationRow,
  MentoredPubsSummaryRow,
} from "@/lib/edit/mentored-publications-report";

const MD = { program: "md", source: "roster", tier: "confirmed" } as const;
const MDPHD = { program: "mdphd", source: "roster", tier: "confirmed" } as const;
const PHD = { program: "phd", source: "jenzabar", tier: "confirmed" } as const;
const VOL = { program: "volunteer", source: "coauthor", tier: "presumptive" } as const;
const CHEN = { cwid: "men0001", name: "Chen, Lin" };
const OKAFOR = { cwid: "men0002", name: "Okafor, Tunde" };
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
    pmid: 3,
    year: 2023,
    learners: [learner("stu0002", "Park", 2, null)],
    mentors: [{ ...NKEMELU, mentorships: [VOL] }],
  }),
  pub({
    pmid: 4,
    year: 2021,
    dateAdded: new Date("2023-06-01"),
    learners: [learner("stu0003", "Wu", 2, null)],
    mentors: [{ ...OKAFOR, mentorships: [PHD] }],
  }),
  pub({
    pmid: 1,
    year: 2022,
    dateAdded: new Date("2024-03-01"),
    jif: 5.5,
    learners: [learner("stu0001", "Learner", 1, true)],
    mentors: [{ ...CHEN, mentorships: [MD] }],
  }),
  pub({
    pmid: 2,
    year: 2024,
    dateAdded: new Date("2024-01-01"),
    jif: 2,
    learners: [learner("stu0001", "Learner", 3, false)],
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
    program: "MD / PhD",
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

const rowIds = (table: HTMLElement, prefix: string) =>
  [...table.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-testid")?.replace(prefix, ""));

function renderPubs() {
  const utils = render(
    <MentoredPublicationsTable view="publications" summary={[]} publications={PUBS} pubsMode="mentored" highImpactThreshold={10} />,
  );
  const table = () => utils.getByTestId("mentored-pubs-publications");
  return { ...utils, table, ids: () => rowIds(table(), "mentored-pubs-pub-") };
}

describe("MentoredPublicationsTable — publications", () => {
  it("defaults to dateAdded desc (not year), hides co-author-typed rows, prints the date and the type under the mentor", () => {
    const { table, ids, getByTestId } = renderPubs();
    expect(ids()).toEqual(["1", "2", "4"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 3 of 4 publications");
    const row1 = within(table()).getByTestId("mentored-pubs-pub-1");
    expect(within(row1).getByText("2024-03-01")).toBeTruthy();
    expect(within(row1).getByText("MD · roster")).toBeTruthy();
    expect(within(row1).getByText("1st author")).toBeTruthy();
    expect(within(row1).getByRole("link", { name: "1" }).getAttribute("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/1/");
    expect(within(within(table()).getByTestId("mentored-pubs-pub-2")).getByText("last author")).toBeTruthy();
    const dateTh = within(table()).getByRole("columnheader", { name: /Date added/ });
    expect(dateTh.getAttribute("aria-sort")).toBe("descending");
  });

  it("clicking Year sorts by year desc and sets aria-sort; clicking again flips; nulls last", () => {
    const { table, ids } = renderPubs();
    const yearTh = within(table()).getByRole("columnheader", { name: /^Year/ });
    expect(yearTh.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(yearTh).getByRole("button"));
    expect(ids()).toEqual(["2", "1", "4"]);
    expect(within(table()).getByRole("columnheader", { name: /^Year/ }).getAttribute("aria-sort")).toBe("descending");
    expect(within(table()).getByRole("columnheader", { name: /Date added/ }).getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Year/ })).getByRole("button"));
    expect(ids()).toEqual(["4", "1", "2"]);
    expect(within(table()).getByRole("columnheader", { name: /^Year/ }).getAttribute("aria-sort")).toBe("ascending");
    // JIF asc: the two null JIFs stay last.
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^JIF/ })).getByRole("button"));
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^JIF/ })).getByRole("button"));
    expect(ids().slice(0, 2)).toEqual(["2", "1"]);
  });

  it("ticking the co-author Type checkbox reveals the row; ticking a Mentor narrows; Showing X of Y follows", () => {
    const { container, ids, getByTestId } = renderPubs();
    const rail = within(container);
    fireEvent.click(rail.getByRole("button", { name: /Volunteer · co-author \(presumptive\)/ }));
    expect(ids()).toEqual(["1", "2", "4", "3"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 4 of 4 publications");
    fireEvent.click(rail.getByRole("button", { name: /Chen, Lin/ }));
    expect(ids()).toEqual(["1", "2"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 2 of 4 publications");
    // Position facet: "Last" is only pmid 2 of the rows passing the other facets.
    expect(rail.getByRole("button", { name: /^Last/ }).textContent).toBe("Last1");
  });
});

function renderLearners() {
  const utils = render(
    <MentoredPublicationsTable view="summary" summary={LEARNERS} publications={[]} pubsMode="mentored" highImpactThreshold={10} />,
  );
  const table = () => utils.getByTestId("mentored-pubs-summary");
  return { ...utils, table, ids: () => rowIds(table(), "mentored-pubs-learner-") };
}

describe("MentoredPublicationsTable — learners", () => {
  it("Type column is one line per mentor; grad-year desc default with null last; co-author learner hidden", () => {
    const { table, ids, getByTestId } = renderLearners();
    expect(ids()).toEqual(["stu0004", "stu0001", "stu0003"]);
    expect(getByTestId("mentored-pubs-shown").textContent).toBe("Showing 3 of 4 learners");
    const row = within(table()).getByTestId("mentored-pubs-learner-stu0001");
    const typeCell = row.querySelectorAll("td")[3];
    expect([...typeCell.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["MD · roster", "PhD · Jenzabar"]);
    expect(within(table()).getByRole("columnheader", { name: /Grad year/ }).getAttribute("aria-sort")).toBe("descending");
    expect(within(table()).getByRole("columnheader", { name: /JIF ≥ 10/ })).toBeTruthy();
  });

  it("the Learner header sorts by last, first", () => {
    const { table, ids } = renderLearners();
    fireEvent.click(within(within(table()).getByRole("columnheader", { name: /^Learner/ })).getByRole("button"));
    expect(ids()).toEqual(["stu0001", "stu0003", "stu0004"]);
    expect(within(table()).getByRole("columnheader", { name: /^Learner/ }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("an empty report renders the empty copy and no table", () => {
    const { queryByTestId, getByTestId } = render(
      <MentoredPublicationsTable view="summary" summary={[]} publications={[]} pubsMode="mentored" highImpactThreshold={10} />,
    );
    expect(getByTestId("mentored-pubs-empty").textContent).toBe("No learners match these filters.");
    expect(queryByTestId("mentored-pubs-summary")).toBeNull();
  });
});
