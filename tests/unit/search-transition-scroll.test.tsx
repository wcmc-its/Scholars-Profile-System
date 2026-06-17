/**
 * Scroll preservation on /search in-place refinements (#1069 follow-up).
 *
 * `scroll: false` is INERT on the search page: the App Router's
 * ScrollAndFocusHandler focuses `<main>` after a navigation commits, and
 * focusing an off-screen landmark scrolls it into view, re-jumping the page to
 * the top — `scroll: false` only suppresses the explicit `window.scrollTo`, not
 * that focus-into-view. SearchTransitionProvider works around it by saving the
 * scroll offset when a `scroll: false` nav starts and restoring it once the
 * transition commits.
 *
 * This is the regression guard the original #1069 lacked: it shipped CI-green
 * but did nothing, because the broken behaviour was pure client-side scroll —
 * invisible to build/typecheck/unit gates. Here we assert the restore actually
 * fires (and that pagination, which omits `scroll: false`, does NOT restore).
 */
import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/lib/analytics/nav-watchdog", () => ({
  reportNavWatchdog: vi.fn(),
}));

import { SearchTransitionProvider, TransitionLink } from "@/components/search/transition-link";

const SAVED_Y = 700;
let scrollToSpy: ReturnType<typeof vi.fn>;
let scrollYDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  push.mockClear();
  scrollToSpy = vi.fn();
  // jsdom defines scrollY as a getter; override it to the user's scroll offset.
  scrollYDescriptor = Object.getOwnPropertyDescriptor(window, "scrollY");
  Object.defineProperty(window, "scrollY", { configurable: true, value: SAVED_Y });
  window.scrollTo = scrollToSpy as unknown as typeof window.scrollTo;
  // Run rAF synchronously so the restore is observable without a real frame.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  if (scrollYDescriptor) Object.defineProperty(window, "scrollY", scrollYDescriptor);
  vi.unstubAllGlobals();
});

describe("SearchTransitionProvider scroll preservation", () => {
  it("restores the saved scroll offset after a scroll:false refinement commits", async () => {
    const { getByText } = render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=x&sort=year" scroll={false}>
          Year (newest)
        </TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(getByText("Year (newest)"));

    // The transition (synchronous mock push) commits, isPending falls, and the
    // armed restore fires on the next frame.
    await waitFor(() => expect(scrollToSpy).toHaveBeenCalledWith(0, SAVED_Y));
    expect(push).toHaveBeenCalledWith("/search?q=x&sort=year", { scroll: false });
  });

  it("does NOT restore scroll for pagination (no scroll:false → conventional scroll-to-top)", async () => {
    const { getByText } = render(
      <SearchTransitionProvider>
        <TransitionLink href="/search?q=x&page=2">Next page</TransitionLink>
      </SearchTransitionProvider>,
    );

    fireEvent.click(getByText("Next page"));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/search?q=x&page=2", undefined));
    expect(scrollToSpy).not.toHaveBeenCalled();
  });
});
