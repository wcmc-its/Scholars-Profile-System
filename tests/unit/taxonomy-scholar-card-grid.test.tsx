/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) — `ScholarCardGrid`: top 6 portrait cards
 * that are profile links, up to 3 area chips, "View all N scholars →" only when
 * given, the original "…in this research area" info copy, and the classes that
 * keep a long title from overflowing a 390px viewport. Fake scholars only.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { ScholarCardGrid, type ScholarCardData } from "@/components/taxonomy/scholar-card-grid";

const LONG_TITLE =
  "Distinguished Professor of Extraordinarily Long Departmental Appointment Names and Associated Interdisciplinary Research Programs";

function scholar(i: number, areas: string[] = []): ScholarCardData {
  return {
    cwid: `aaa${1000 + i}`,
    slug: `test-person-${i}`,
    preferredName: `Test Person ${i}`,
    primaryTitle: i === 1 ? LONG_TITLE : `Title ${i}`,
    identityImageEndpoint: "",
    areas,
  };
}

// Each card renders twice (a plain link below md, a popover-wrapped one at md+);
// CSS shows exactly one. Scope assertions to the grid and dedupe by href.
function cardLinks() {
  const grid = screen.getByTestId("scholar-card-grid");
  return within(grid).getAllByTestId("scholar-card") as HTMLAnchorElement[];
}

describe("ScholarCardGrid", () => {
  it("renders at most 6 cards, each one link to the profile", () => {
    render(
      <ScholarCardGrid
        heading="Scholars in this area"
        scholars={Array.from({ length: 7 }, (_, i) => scholar(i + 1))}
      />,
    );
    const hrefs = [...new Set(cardLinks().map((a) => a.getAttribute("href")))];
    expect(hrefs).toEqual([1, 2, 3, 4, 5, 6].map((i) => `/test-person-${i}`));
    expect(screen.queryByText("Test Person 7")).toBeNull();
  });

  it("has a narrow-viewport plain link and an md+ link per card", () => {
    render(<ScholarCardGrid heading="Scholars in this area" scholars={[scholar(2)]} />);
    const [narrow, wide] = cardLinks();
    // The narrow copy must be `flex` (not the default inline <a>) or the
    // avatar + text stack vertically and min-h-11 / w-full do nothing.
    expect(narrow.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "md:hidden"]));
    expect(narrow.className.split(/\s+/)).not.toContain("hidden");
    expect(wide.className).toContain("hidden md:flex");
  });

  it("renders up to 3 area chips, and none when the scholar has no areas", () => {
    render(
      <ScholarCardGrid
        heading="Scholars in this area"
        scholars={[scholar(2, ["Alpha", "Beta", "Gamma", "Delta"]), scholar(3, [])]}
      />,
    );
    const chipRows = screen.getAllByTestId("scholar-card-areas");
    // Two copies (narrow + md) of scholar 2's chips; scholar 3 has none.
    expect(chipRows).toHaveLength(2);
    expect(within(chipRows[0]).getAllByText(/Alpha|Beta|Gamma/)).toHaveLength(3);
    expect(within(chipRows[0]).queryByText("Delta")).toBeNull();
  });

  it("shows 'View all N scholars →' only when a scholars page exists", () => {
    const { rerender } = render(
      <ScholarCardGrid
        heading="Scholars in this area"
        scholars={[scholar(2)]}
        viewAll={{ href: "/topics/cardio/scholars", count: 1234 }}
      />,
    );
    const link = screen.getByRole("link", { name: "View all 1,234 scholars →" });
    expect(link.getAttribute("href")).toBe("/topics/cardio/scholars");

    rerender(<ScholarCardGrid heading="Scholars using this" scholars={[scholar(2)]} />);
    expect(screen.queryByText(/View all/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: /Scholars using this/ })).toBeTruthy();
  });

  it("keeps the ORIGINAL info copy ('…in this research area') on every heading", () => {
    render(<ScholarCardGrid heading="Scholars using this" scholars={[scholar(2)]} />);
    fireEvent.click(screen.getByRole("button", { name: "About Scholars using this" }));
    expect(
      screen.getByText(/senior-author publications in this research area\. Curators do not/),
    ).toBeTruthy();
  });

  it("guards 390px overflow: min-w-0 containers, truncated name, clamped title", () => {
    render(<ScholarCardGrid heading="Scholars in this area" scholars={[scholar(1, ["A"])]} />);
    const grid = screen.getByTestId("scholar-card-grid");
    expect(grid.className).toContain("min-w-0");
    const list = grid.querySelector("ul")!;
    expect(list.className).toMatch(/\bgrid-cols-1\b/);
    expect(list.className).toContain("sm:grid-cols-2");
    expect(list.className).toContain("lg:grid-cols-3");
    expect(list.className).toContain("min-w-0");
    for (const li of list.querySelectorAll("li")) expect(li.className).toContain("min-w-0");
    const [card] = cardLinks();
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("min-h-11");
    const name = within(card).getByText("Test Person 1");
    expect(name.className).toContain("truncate");
    const title = within(card).getByText(LONG_TITLE);
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("sm:line-clamp-2");
    expect(title.parentElement!.className).toContain("min-w-0");
  });

  it("renders nothing for an empty roster", () => {
    const { container } = render(<ScholarCardGrid heading="Scholars in this area" scholars={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
