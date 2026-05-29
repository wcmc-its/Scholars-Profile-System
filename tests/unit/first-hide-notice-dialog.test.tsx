/**
 * `components/edit/first-hide-notice-dialog.tsx` — the once-per-session
 * educational notice shown before the first publication hide (#570).
 *
 * Presentational contract only (the once-per-session bookkeeping lives in
 * `publications-card.tsx`, covered in publications-card.test.tsx): copy biased
 * toward Hide, a primary "Hide it", a secondary "it's not mine" reject
 * affordance that opens Publication Manager in a new tab, and a Cancel.
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

  it("the primary action is Hide it (default variant), not Reject", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    const hide = screen.getByTestId("first-hide-confirm");
    expect(hide.getAttribute("data-variant")).toBe("default");
    // The reject affordance is a secondary outline button, never the loud default.
    const notMine = screen.getByTestId("first-hide-not-mine");
    expect(notMine.getAttribute("data-variant")).toBe("outline");
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

  it("the not-mine button is an anchor to Publication Manager opening a new tab", () => {
    render(<FirstHideNoticeDialog {...defaults()} />);
    const notMine = screen.getByTestId("first-hide-not-mine");
    expect(notMine.tagName).toBe("A");
    expect(notMine.getAttribute("href")).toBe(PUBLICATION_MANAGER_URL);
    expect(notMine.getAttribute("target")).toBe("_blank");
    expect(notMine.getAttribute("rel")).toContain("noreferrer");
  });

  it("clicking the not-mine button calls onNotMine, not onHide", () => {
    const d = defaults();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<FirstHideNoticeDialog {...d} />);
    fireEvent.click(screen.getByTestId("first-hide-not-mine"));
    expect(d.onNotMine).toHaveBeenCalledTimes(1);
    expect(d.onHide).not.toHaveBeenCalled();
  });

  it("the inline body reject link also routes to Publication Manager and signals not-mine", () => {
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
