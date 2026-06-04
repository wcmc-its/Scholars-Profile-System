/**
 * `components/edit/first-hide-notice-dialog.tsx` — the once-per-session
 * educational notice shown before the first publication hide (#570).
 *
 * Presentational contract only (the once-per-session bookkeeping lives in
 * `publications-card.tsx`, covered in publications-card.test.tsx): copy biased
 * toward Hide, a primary "Hide it", the educational inline "it's not mine"
 * reject link that opens Publication Manager in a new tab, and a Cancel. The
 * footer no longer carries a duplicate reject button — the standing per-row
 * "Not mine?" affordance covers the repeat case (vision-round finding 4.9).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { FirstHideNoticeDialog } from "@/components/edit/first-hide-notice-dialog";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";

function defaults() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onHide: vi.fn(),
    onNotMine: vi.fn(),
  };
}

describe("FirstHideNoticeDialog — copy + structure", () => {
  it("leads with Hide as the display-only, reversible, upstream-neutral tool", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    expect(screen.getByText("You're about to hide this paper.")).toBeTruthy();
    expect(
      screen.getByText(/display-only and reversible, and it changes nothing upstream/i),
    ).toBeTruthy();
  });

  it("gates the reject path behind an explicit 'not actually yours' question", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    expect(screen.getByText(/Is this paper not actually yours\?/i)).toBeTruthy();
  });

  it("warns against rejecting one's own work (algorithm-integrity guardrail)", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    expect(
      screen.getByText(/Only reject papers that genuinely aren't yours/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/feeds the wrong signal into the matching algorithm/i),
    ).toBeTruthy();
  });

  it("the primary action is Hide it (default variant); the footer carries no duplicate reject button", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    const hide = screen.getByTestId("first-hide-confirm");
    expect(hide.getAttribute("data-variant")).toBe("default");
    // The duplicate footer reject affordance was removed (#570 / finding 4.9):
    // the not-mine path lives only in the educational inline link above.
    expect(screen.queryByTestId("first-hide-not-mine")).toBeNull();
  });

  it("autofocuses Hide it — the action the scholar already initiated", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    expect(document.activeElement).toBe(screen.getByTestId("first-hide-confirm"));
  });
});

describe("FirstHideNoticeDialog — actions", () => {
  it("Hide it calls onHide", () => {
    const d = defaults();
    render(<FirstHideNoticeDialog {...d} />);
    fireEvent.click(screen.getByTestId("first-hide-confirm"));
    expect(d.onHide).toHaveBeenCalledTimes(1);
    expect(d.onNotMine).not.toHaveBeenCalled();
  });

  it("the inline body reject link routes to Publication Manager and signals not-mine", () => {
    const d = defaults();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<FirstHideNoticeDialog {...d} />);
    const inline = screen.getByRole("link", { name: /reject it in Publication Manager/i });
    expect(inline.getAttribute("href")).toBe(PUBLICATION_MANAGER_URL);
    fireEvent.click(inline);
    expect(d.onNotMine).toHaveBeenCalledTimes(1);
    expect(d.onHide).not.toHaveBeenCalled();
  });

  it("Cancel calls onOpenChange(false), not onHide or onNotMine", () => {
    const d = defaults();
    render(<FirstHideNoticeDialog {...d} />);
    fireEvent.click(screen.getByTestId("first-hide-cancel"));
    expect(d.onOpenChange).toHaveBeenCalledWith(false);
    expect(d.onHide).not.toHaveBeenCalled();
    expect(d.onNotMine).not.toHaveBeenCalled();
  });
});
