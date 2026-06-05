/**
 * `components/edit/overview-source-drawer.tsx` (#742 v3.1 §3). The Sources
 * trigger row summarizes the selection; clicking it opens the drawer with the
 * picker; Done closes it. The selection itself lives upstream, so the trigger
 * just reflects counts.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// The drawer mounts a Radix Dialog (Sheet); the feedback-badge context hook it
// uses must resolve under jsdom.
import { OverviewSourceDrawer } from "@/components/edit/overview-source-drawer";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import type { OverviewSelection } from "@/lib/edit/overview-params";

const OPTIONS: OverviewSourceOptions = {
  publications: [
    {
      pmid: "11",
      title: "P1",
      venue: "Cell",
      year: 2024,
      impact: 90,
      isFirstOrLast: true,
      authorPosition: "first",
      defaultSelected: true,
    },
    {
      pmid: "22",
      title: "P2",
      venue: "Nature",
      year: 2022,
      impact: 70,
      isFirstOrLast: false,
      authorPosition: "middle",
      defaultSelected: false,
    },
  ],
  funding: [
    {
      id: "g1",
      role: "PI",
      funder: "NIH",
      title: "Proj 1",
      award: "R01 X",
      endYear: 2027,
      defaultSelected: true,
    },
  ],
  tools: [],
};

const sel = (over: Partial<OverviewSelection> = {}): OverviewSelection => ({
  pmids: [],
  grantIds: [],
  toolNames: [],
  ...over,
});

describe("OverviewSourceDrawer — trigger row", () => {
  it("shows a loading state and disables the trigger until options arrive", () => {
    render(<OverviewSourceDrawer options={null} selection={sel()} onSelectionChange={() => {}} />);
    expect(screen.getByText("Loading your sources…")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-trigger").hasAttribute("disabled")).toBe(true);
  });

  it("summarizes the current selection (pluralized)", () => {
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        selection={sel({ pmids: ["11", "22"], grantIds: ["g1"] })}
        onSelectionChange={() => {}}
      />,
    );
    expect(screen.getByText("2 publications · 1 award")).toBeTruthy();
  });
});

describe("OverviewSourceDrawer — open / close", () => {
  it("opens the drawer with the picker, shows the 25 counter, and closes on Done", () => {
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        selection={sel({ pmids: ["11"], grantIds: ["g1"] })}
        onSelectionChange={() => {}}
      />,
    );
    // Closed initially.
    expect(screen.queryByTestId("overview-include-picker")).toBeNull();

    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-include-picker")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-counter").textContent).toContain("2 / 25 selected");

    fireEvent.click(screen.getByTestId("overview-sources-done"));
    expect(screen.queryByTestId("overview-include-picker")).toBeNull();
  });
});
