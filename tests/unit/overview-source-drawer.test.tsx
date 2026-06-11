/**
 * `components/edit/overview-source-drawer.tsx` (#742 v3.1 §3 / #875 §5). The
 * Sources trigger row summarizes the committed selection; clicking it opens the
 * drawer with the picker over a BUFFERED local copy. Done commits the buffer to
 * the parent; Cancel / X / Escape / click-outside discard. The combined live
 * budget counter reads the buffer.
 */
import { describe, expect, it, vi } from "vitest";
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
  it("opens the drawer with the picker, shows the combined budget counter, and closes on Done", () => {
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
    // No tools → methods band omitted.
    expect(screen.getByTestId("overview-sources-counter").textContent).toBe(
      "2 of 25 papers + awards",
    );

    fireEvent.click(screen.getByTestId("overview-sources-done"));
    expect(screen.queryByTestId("overview-include-picker")).toBeNull();
  });

  it("shows the methods band in the budget counter when tools exist", () => {
    const withTools: OverviewSourceOptions = {
      ...OPTIONS,
      tools: [
        {
          toolName: "AAV",
          category: "vector",
          pmidCount: 12,
          maxConfidence: 0.9,
          defaultSelected: true,
        },
      ],
    };
    render(
      <OverviewSourceDrawer
        options={withTools}
        selection={sel({ pmids: ["11"], toolNames: ["AAV"] })}
        onSelectionChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-sources-counter").textContent).toBe(
      "1 of 25 papers + awards · 1 of 10 methods",
    );
  });
});

describe("OverviewSourceDrawer — buffered Done/Cancel contract (#875 §5)", () => {
  it("Done commits the edited buffer to the parent", () => {
    const onSelectionChange = vi.fn();
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        selection={sel({ pmids: ["11"] })}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    // Edit the buffer: add pmid 22.
    fireEvent.click(screen.getByTestId("overview-source-pub-22"));
    // Not committed yet.
    expect(onSelectionChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("overview-sources-done"));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ pmids: ["11", "22"] }),
    );
  });

  it("Cancel discards the buffer — the parent selection is untouched", () => {
    const onSelectionChange = vi.fn();
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        selection={sel({ pmids: ["11"] })}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    fireEvent.click(screen.getByTestId("overview-source-pub-22"));
    fireEvent.click(screen.getByTestId("overview-sources-cancel"));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("overview-include-picker")).toBeNull();
  });

  it("re-opening after Cancel re-seeds the buffer from the committed selection", () => {
    const onSelectionChange = vi.fn();
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        selection={sel({ pmids: ["11"] })}
        onSelectionChange={onSelectionChange}
      />,
    );
    // Open, edit, cancel.
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    fireEvent.click(screen.getByTestId("overview-source-pub-22"));
    fireEvent.click(screen.getByTestId("overview-sources-cancel"));
    // Re-open: the abandoned edit is gone (pub-22 unchecked again).
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-source-pub-22").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("overview-source-pub-11").getAttribute("aria-checked")).toBe("true");
  });
});
