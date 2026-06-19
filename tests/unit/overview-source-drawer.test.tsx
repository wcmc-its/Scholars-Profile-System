/**
 * `components/edit/overview-source-drawer.tsx` (#742 §2 / Phase 2). The Sources
 * trigger summarizes what the committed deltas RESOLVE to; clicking it opens the
 * drawer over a BUFFERED local copy of the deltas. The header status line counts
 * divergences ("Using your recommended set · N pinned · M hidden"). Done commits
 * the buffer; Close / Escape discard; Reset to recommended clears the buffer.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { OverviewSourceDrawer } from "@/components/edit/overview-source-drawer";
import type { OverviewSourceOptions } from "@/lib/edit/overview-facts";
import {
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";

const OPTIONS: OverviewSourceOptions = {
  publications: [
    { pmid: "11", title: "P1", venue: "Cell", year: 2024, impact: 90, isFirstOrLast: true, authorPosition: "first", defaultSelected: true, featured: true },
    { pmid: "33", title: "P3", venue: "Nature", year: 2021, impact: 50, isFirstOrLast: true, authorPosition: "first", defaultSelected: false, featured: false },
  ],
  funding: [
    { id: "g1", role: "PI", funder: "NIH", title: "Proj 1", award: "R01 X", endYear: 2027, defaultSelected: true },
  ],
  tools: [],
};

function deltas(over: Partial<OverviewSelectionDeltas> = {}): OverviewSelectionDeltas {
  return { ...DEFAULT_OVERVIEW_SELECTION_DELTAS, ...over };
}

describe("OverviewSourceDrawer — trigger row", () => {
  it("shows a loading state and disables the trigger until options arrive", () => {
    render(<OverviewSourceDrawer options={null} deltas={deltas()} onCommit={() => {}} />);
    expect(screen.getByText("Loading your sources…")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-trigger").hasAttribute("disabled")).toBe(true);
  });

  it("summarizes what the deltas resolve to against the auto-set", () => {
    // Empty deltas → just the default-selected pub 11 + grant g1.
    const { rerender } = render(
      <OverviewSourceDrawer options={OPTIONS} deltas={deltas()} onCommit={() => {}} />,
    );
    expect(screen.getByText("1 publication · 1 award")).toBeTruthy();
    // Pinning the non-default pub 33 lifts the resolved count to two.
    rerender(
      <OverviewSourceDrawer
        options={OPTIONS}
        deltas={deltas({ pinned: { publication: ["33"] } })}
        onCommit={() => {}}
      />,
    );
    expect(screen.getByText("2 publications · 1 award")).toBeTruthy();
  });

  it("adds a methods band to the summary when tools are selected", () => {
    const withTools: OverviewSourceOptions = {
      ...OPTIONS,
      tools: [{ toolName: "AAV", category: "vector", pmidCount: 12, maxConfidence: 0.9, defaultSelected: true }],
    };
    render(<OverviewSourceDrawer options={withTools} deltas={deltas()} onCommit={() => {}} />);
    expect(screen.getByText("1 publication · 1 award · 1 method")).toBeTruthy();
  });
});

describe("OverviewSourceDrawer — open / status line", () => {
  it("opens the drawer with the picker and the recommended-set status line", () => {
    render(<OverviewSourceDrawer options={OPTIONS} deltas={deltas()} onCommit={() => {}} />);
    expect(screen.queryByTestId("overview-include-picker")).toBeNull();
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-include-picker")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set",
    );
  });

  it("reflects buffered divergences in the status line", () => {
    render(<OverviewSourceDrawer options={OPTIONS} deltas={deltas()} onCommit={() => {}} />);
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set · 1 hidden",
    );
  });
});

describe("OverviewSourceDrawer — buffered Done / discard contract (#875 §5)", () => {
  it("Done commits the edited deltas to the parent", () => {
    const onCommit = vi.fn();
    render(<OverviewSourceDrawer options={OPTIONS} deltas={deltas()} onCommit={onCommit} />);
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("overview-sources-done"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(
      expect.objectContaining({ excluded: expect.objectContaining({ publication: ["11"] }) }),
    );
  });

  it("Close discards the buffer — the parent is untouched and the buffer re-seeds", () => {
    const onCommit = vi.fn();
    render(<OverviewSourceDrawer options={OPTIONS} deltas={deltas()} onCommit={onCommit} />);
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onCommit).not.toHaveBeenCalled();
    // Re-open: the abandoned veto is gone (status line back to recommended).
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set",
    );
  });

  it("Reset to recommended clears the buffered deltas", () => {
    render(
      <OverviewSourceDrawer
        options={OPTIONS}
        deltas={deltas({ excluded: { publication: ["11"] } })}
        onCommit={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set · 1 hidden",
    );
    fireEvent.click(screen.getByTestId("overview-sources-reset"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set",
    );
  });
});
