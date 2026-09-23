/**
 * `components/edit/overview-source-drawer.tsx` (#742 §2 / Phase 2). The rail's
 * Sources row summarizes what the committed deltas RESOLVE to; the inline panel
 * edits a BUFFERED local copy and hands it back on close (Done or "‹ Overview").
 * The status line counts divergences ("Using your recommended set · N hidden").
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  OverviewSourcePanel,
  OverviewSourcesRow,
} from "@/components/edit/overview-source-drawer";
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
    { id: "g1", role: "PI", roleLabel: "Principal Investigator", funder: "NIH", title: "Proj 1", award: "R01 X", endYear: 2027, defaultSelected: true },
  ],
  tools: [],
};

function deltas(over: Partial<OverviewSelectionDeltas> = {}): OverviewSelectionDeltas {
  return { ...DEFAULT_OVERVIEW_SELECTION_DELTAS, ...over };
}

describe("OverviewSourcesRow", () => {
  it("shows a loading state and disables Edit until options arrive", () => {
    render(<OverviewSourcesRow options={null} deltas={deltas()} open={false} onToggle={() => {}} />);
    expect(screen.getByText("Loading sources…")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-trigger").hasAttribute("disabled")).toBe(true);
  });

  it("summarizes what the deltas resolve to against the auto-set", () => {
    const { rerender } = render(
      <OverviewSourcesRow options={OPTIONS} deltas={deltas()} open={false} onToggle={() => {}} />,
    );
    expect(screen.getByText("1 publication · 1 award")).toBeTruthy();
    rerender(
      <OverviewSourcesRow
        options={OPTIONS}
        deltas={deltas({ pinned: { publication: ["33"] } })}
        open={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("2 publications · 1 award")).toBeTruthy();
  });

  it("adds a methods band when the scholar has tools", () => {
    const withTools: OverviewSourceOptions = {
      ...OPTIONS,
      tools: [{ toolName: "AAV", category: "vector", pmidCount: 12, maxConfidence: 0.9, defaultSelected: true }],
    };
    render(<OverviewSourcesRow options={withTools} deltas={deltas()} open={false} onToggle={() => {}} />);
    expect(screen.getByText("1 publication · 1 award · 1 method")).toBeTruthy();
  });

  it("reads Edit when closed and Close when open", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <OverviewSourcesRow options={OPTIONS} deltas={deltas()} open={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByTestId("overview-sources-trigger"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("overview-sources-trigger").textContent).toBe("Edit");
    rerender(<OverviewSourcesRow options={OPTIONS} deltas={deltas()} open onToggle={onToggle} />);
    expect(screen.getByTestId("overview-sources-trigger").textContent).toBe("Close");
  });
});

describe("OverviewSourcePanel — buffered edits", () => {
  it("shows the picker and reflects buffered divergences in the status line", () => {
    render(<OverviewSourcePanel options={OPTIONS} deltas={deltas()} onClose={() => {}} />);
    expect(screen.getByTestId("overview-include-picker")).toBeTruthy();
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set",
    );
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set · 1 hidden",
    );
  });

  it.each(["overview-sources-done", "overview-sources-back"])(
    "%s hands the edited deltas back",
    (testId) => {
      const onClose = vi.fn();
      render(<OverviewSourcePanel options={OPTIONS} deltas={deltas()} onClose={onClose} />);
      fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId(testId));
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({ excluded: expect.objectContaining({ publication: ["11"] }) }),
      );
    },
  );

  it("closing untouched hands back the SAME deltas object (no write)", () => {
    const onClose = vi.fn();
    const d = deltas();
    render(<OverviewSourcePanel options={OPTIONS} deltas={d} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("overview-sources-done"));
    expect(onClose.mock.calls[0][0]).toBe(d);
  });

  it("Reset to recommended clears the buffered deltas", () => {
    render(
      <OverviewSourcePanel
        options={OPTIONS}
        deltas={deltas({ excluded: { publication: ["11"] } })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set · 1 hidden",
    );
    fireEvent.click(screen.getByTestId("overview-sources-reset"));
    expect(screen.getByTestId("overview-sources-statusline").textContent).toBe(
      "Using your recommended set",
    );
  });

  it("warns the reviewed draft is stale only once sources actually change", () => {
    render(<OverviewSourcePanel options={OPTIONS} deltas={deltas()} onClose={() => {}} staleDraft />);
    expect(screen.queryByText(/Regenerate to update the draft/)).toBeNull();
    fireEvent.click(screen.getByTestId("overview-source-exclude-publication-11"));
    expect(screen.getByText(/Regenerate to update the draft/)).toBeTruthy();
  });
});
