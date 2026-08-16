/**
 * `components/edit/publications-report-table.tsx` — the report-3 client
 * island: Person-type filter rail (in-memory, no fetch) + the publications
 * table with the new Impact score / synopsis fields.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

// `HoverTooltip` wraps Radix, which PORTALS the bubble and only mounts it on
// hover — mocked to surface its `text` prop as an attribute, matching
// `tests/unit/dept-grant-card.test.tsx`'s convention.
vi.mock("@/components/ui/hover-tooltip", () => ({
  HoverTooltip: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span data-tooltip={text}>{children}</span>
  ),
}));

import { PublicationsReportTable } from "@/components/edit/publications-report-table";
import type { PublicationsReportRow } from "@/lib/edit/cancer-center-publications-report";

function row(overrides: Partial<PublicationsReportRow> & { pmid: string }): PublicationsReportRow {
  return {
    title: "A publication",
    journal: "Journal X",
    journalAbbrev: "J X",
    year: 2024,
    matchedJournalTitle: "Journal X",
    impactScore1: 5.5,
    impactScore2: 5.1,
    categoryName: "ONCOLOGY",
    quartile: "Q1",
    categoryRank: "1/100",
    impactScore: 60,
    impactJustification: null,
    synopsis: null,
    authorRoleCategories: [],
    ...overrides,
  };
}

describe("PublicationsReportTable — rows", () => {
  it("renders one row per publication", () => {
    render(
      <PublicationsReportTable
        rows={[row({ pmid: "1" }), row({ pmid: "2" })]}
      />,
    );
    expect(screen.getByTestId("pubs-report-row-1")).toBeTruthy();
    expect(screen.getByTestId("pubs-report-row-2")).toBeTruthy();
  });

  it("shows a synopsis line under the title only when present", () => {
    render(
      <PublicationsReportTable
        rows={[
          row({ pmid: "1", synopsis: "Plain-language summary." }),
          row({ pmid: "2", synopsis: null }),
        ]}
      />,
    );
    expect(screen.getByTestId("pubs-report-synopsis-1").textContent).toBe("Plain-language summary.");
    expect(screen.queryByTestId("pubs-report-synopsis-2")).toBeNull();
  });

  it("shows — for a null impact score, and the score itself otherwise", () => {
    render(
      <PublicationsReportTable
        rows={[row({ pmid: "1", impactScore: null }), row({ pmid: "2", impactScore: 77 })]}
      />,
    );
    const row1 = screen.getByTestId("pubs-report-row-1");
    const row2 = screen.getByTestId("pubs-report-row-2");
    expect(within(row1).getByText("—")).toBeTruthy();
    expect(row2.textContent).toContain("77");
  });

  it("shows the Journal IF / 5-yr IF / Quartile columns unchanged from before", () => {
    render(<PublicationsReportTable rows={[row({ pmid: "1", impactScore1: 12.3, impactScore2: 10.1, quartile: "Q2" })]} />);
    const r = screen.getByTestId("pubs-report-row-1");
    expect(r.textContent).toContain("12.3");
    expect(r.textContent).toContain("10.1");
    expect(r.textContent).toContain("Q2");
  });

  it("wraps the impact score in a tooltip carrying impactJustification when present", () => {
    render(
      <PublicationsReportTable
        rows={[row({ pmid: "1", impactScore: 88, impactJustification: "Novel mechanism, high relevance." })]}
      />,
    );
    const r = screen.getByTestId("pubs-report-row-1");
    const tooltip = within(r).getByText("88");
    expect(tooltip.closest("[data-tooltip]")?.getAttribute("data-tooltip")).toBe(
      "Novel mechanism, high relevance.",
    );
  });

  it("renders the impact score with no tooltip wrapper when impactJustification is null", () => {
    render(<PublicationsReportTable rows={[row({ pmid: "1", impactScore: 42, impactJustification: null })]} />);
    const r = screen.getByTestId("pubs-report-row-1");
    expect(r.textContent).toContain("42");
    expect(r.querySelector("[data-tooltip]")).toBeNull();
  });
});

describe("PublicationsReportTable — Person type filter", () => {
  it("with no filter selected, every row shows", () => {
    render(
      <PublicationsReportTable
        rows={[
          row({ pmid: "1", authorRoleCategories: ["full_time_faculty"] }),
          row({ pmid: "2", authorRoleCategories: ["postdoc"] }),
        ]}
      />,
    );
    expect(screen.getByTestId("pubs-report-row-1")).toBeTruthy();
    expect(screen.getByTestId("pubs-report-row-2")).toBeTruthy();
  });

  it("selecting a person type hides rows with no author of that type", () => {
    render(
      <PublicationsReportTable
        rows={[
          row({ pmid: "1", authorRoleCategories: ["full_time_faculty"] }),
          row({ pmid: "2", authorRoleCategories: ["postdoc"] }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));
    expect(screen.getByTestId("pubs-report-row-1")).toBeTruthy();
    expect(screen.queryByTestId("pubs-report-row-2")).toBeNull();
  });

  it("a row with multiple author role categories shows under either facet", () => {
    render(
      <PublicationsReportTable
        rows={[row({ pmid: "1", authorRoleCategories: ["full_time_faculty", "postdoc"] })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Postdoc/ }));
    expect(screen.getByTestId("pubs-report-row-1")).toBeTruthy();
  });

  it("selecting a role only shows rows carrying it — a row with no author of that role never matches", () => {
    render(
      <PublicationsReportTable
        rows={[
          row({ pmid: "1", authorRoleCategories: ["full_time_faculty"] }),
          row({ pmid: "2", authorRoleCategories: [] }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Full-time faculty/ }));
    expect(screen.getByTestId("pubs-report-row-1")).toBeTruthy();
    expect(screen.queryByTestId("pubs-report-row-2")).toBeNull();
  });

  it("shows a 'no rows' message when there are zero matched publications to begin with (no facet to filter by)", () => {
    render(<PublicationsReportTable rows={[]} />);
    expect(screen.getByTestId("pubs-report-no-rows")).toBeTruthy();
    expect(screen.queryByTestId("pubs-report-table")).toBeTruthy(); // header still renders, just no body rows
  });
});
