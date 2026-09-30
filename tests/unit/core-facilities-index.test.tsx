/**
 * `/edit/core` — CoreFacilitiesIndex: KPI tiles as filters, text filter,
 * sorting, expandable detail rows, status/staff derivations. Fake cores only.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { CoreFacilitiesIndex, deriveCoreState } from "@/components/edit/core-facilities-index";
import type { CoreConsoleRow } from "@/lib/api/core-console-index";

function core(over: Partial<CoreConsoleRow> & { id: string; name: string }): CoreConsoleRow {
  return {
    facility: null,
    visible: true,
    hasUrl: false,
    hasDescription: false,
    leaders: [],
    owners: ["Owner Person"],
    curators: [],
    reviewTotal: 0,
    reviewHigh: 0,
    confirmed: 0,
    clientsWithCwid: 0,
    clientsNameOnly: 0,
    staffListed: 2,
    staffTracked: 2,
    ...over,
  };
}

const CORES: CoreConsoleRow[] = [
  core({
    id: "1",
    name: "Alpha Core",
    facility: "Alpha Facility",
    reviewTotal: 12,
    reviewHigh: 5,
    confirmed: 40,
    clientsWithCwid: 3,
    clientsNameOnly: 1,
    leaders: [{ name: "Lead Tester", role: "Director", interim: false }],
  }),
  core({
    id: "2",
    name: "Beta Core",
    visible: false,
    confirmed: 7,
    staffListed: null,
    staffTracked: null,
  }),
  core({
    id: "3",
    name: "Gamma Core",
    reviewTotal: 3,
    reviewHigh: 0,
    owners: [],
    staffListed: 4,
    staffTracked: 0,
  }),
];

const rowNames = () =>
  screen.getAllByTestId("core-row").map((r) => within(r).getAllByRole("button")[0].textContent);

describe("deriveCoreState", () => {
  it("is public only when the toggle and every flag are on", () => {
    expect(deriveCoreState(CORES[0], []).isPublic).toBe(true);
    const flagged = deriveCoreState(CORES[0], ["CORE_PAGES"]);
    expect(flagged.isPublic).toBe(false);
    expect(flagged.hiddenWhy).toBe("CORE_PAGES off");
    expect(deriveCoreState(CORES[1], []).hiddenWhy).toBe("Core toggle off");
  });

  it("flags no feed, all-untracked staff and no owner as data problems", () => {
    expect(deriveCoreState(CORES[0], []).dataProblem).toBe(false);
    expect(deriveCoreState(CORES[1], []).dataProblem).toBe(true);
    expect(deriveCoreState(CORES[2], []).dataProblem).toBe(true);
  });
});

describe("CoreFacilitiesIndex", () => {
  it("renders KPI totals and sorts by review backlog by default", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    const kpis = screen.getByTestId("core-kpis");
    expect(within(kpis).getByText("15")).toBeTruthy();
    expect(within(kpis).getByText("5 high confidence · 2 cores")).toBeTruthy();
    expect(within(kpis).getByText("47")).toBeTruthy();
    expect(screen.getByTestId("core-showing").textContent).toBe("3 of 3 cores");
    expect(rowNames()[0]).toContain("Alpha Core");
    expect(rowNames()[1]).toContain("Gamma Core");
  });

  it("links the review pill to the core's review queue", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    const link = screen.getByText("5 high →").closest("a");
    expect(link?.getAttribute("href")).toBe("/edit/core/1/review");
  });

  it("filters by a KPI tile and clears via the chip", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Data problems/ }));
    expect(screen.getByTestId("core-showing").textContent).toBe("2 of 3 cores");
    fireEvent.click(screen.getByRole("button", { name: "Clear the Data problems filter" }));
    expect(screen.getByTestId("core-showing").textContent).toBe("3 of 3 cores");
  });

  it("text-filters on leader names and shows the empty state", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    const input = screen.getByRole("textbox", { name: /Filter cores/ });
    fireEvent.change(input, { target: { value: "lead tester" } });
    expect(rowNames()).toHaveLength(1);
    fireEvent.change(input, { target: { value: "nothing-like-this" } });
    expect(screen.getByText("No cores match.")).toBeTruthy();
  });

  it("sorts by name when the Core header is clicked", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Core" }));
    expect(rowNames().map((n) => n?.replace(/#.*/, ""))).toEqual([
      "Alpha Core",
      "Beta Core",
      "Gamma Core",
    ]);
  });

  it("expands a row into its details with review + edit links", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={[]} />);
    const gamma = screen.getAllByTestId("core-row").find((r) => r.textContent?.includes("Gamma"))!;
    const toggle = within(gamma).getAllByRole("button")[0];
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(gamma).getByText("No owner. A Superuser needs to grant one.")).toBeTruthy();
    expect(
      within(gamma).getByText(
        "Add staff CWIDs to the dictionary so the co-author signal can match them.",
      ),
    ).toBeTruthy();
    expect(within(gamma).getByText("Review 3 suggestions →").getAttribute("href")).toBe(
      "/edit/core/3/review",
    );
    expect(within(gamma).getByText("Edit core").getAttribute("href")).toBe("/edit/core/3");
  });

  it("names the off flag in the Hidden KPI", () => {
    render(<CoreFacilitiesIndex cores={CORES} offFlags={["CORE_PUB_MODAL"]} />);
    expect(screen.getByText("CORE_PUB_MODAL is off")).toBeTruthy();
    expect(screen.getAllByText("Hidden").length).toBe(3);
  });
});
