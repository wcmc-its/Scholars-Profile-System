/**
 * `components/edit/find-researchers-tabs.tsx` — the Browse / Submissions
 * sub-tab strip on `/edit/find-researchers` (intake-flag-on only; the page
 * renders bare `<FindResearchers />` when the flag is off, so there is no
 * flag-off case to test here):
 *  - `?tab=` drives the active tab (default Browse), preserving `?opp=`;
 *  - Browse carries the "Not in the list? Submit a URL" affordance that jumps
 *    to Submissions — the discoverability point of the split.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/edit/find-researchers",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/components/edit/find-researchers", () => ({
  FindResearchers: () => <div data-testid="browse-content" />,
}));
vi.mock("@/components/edit/opportunity-intake-panel", () => ({
  OpportunityIntakePanel: () => <div data-testid="submissions-content" />,
}));

import { FindResearchersTabs } from "@/components/edit/find-researchers-tabs";

describe("FindResearchersTabs", () => {
  it("defaults to Browse: matcher content + the submit-a-URL affordance", () => {
    search = "";
    render(<FindResearchersTabs />);
    expect(screen.getByTestId("browse-content")).toBeTruthy();
    expect(screen.queryByTestId("submissions-content")).toBeNull();

    const browseTab = screen.getByTestId("find-researchers-tab-browse");
    expect(browseTab.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByTestId("find-researchers-tab-submissions").getAttribute("aria-selected"),
    ).toBe("false");

    // The affordance jumps to the Submissions tab.
    const link = screen.getByRole("link", { name: "Submit a URL" });
    expect(link.getAttribute("href")).toBe("/edit/find-researchers?tab=submissions");
  });

  it("?tab=submissions shows the intake panel and keeps ?opp= on the Browse href", () => {
    search = "tab=submissions&opp=wcm_curated%3Ahartwell-abc123";
    render(<FindResearchersTabs />);
    expect(screen.getByTestId("submissions-content")).toBeTruthy();
    expect(screen.queryByTestId("browse-content")).toBeNull();
    expect(
      screen.getByTestId("find-researchers-tab-submissions").getAttribute("aria-selected"),
    ).toBe("true");

    // Switching back to Browse drops `tab` but preserves the drilled-in `opp`.
    expect(screen.getByTestId("find-researchers-tab-browse").getAttribute("href")).toBe(
      "/edit/find-researchers?opp=wcm_curated%3Ahartwell-abc123",
    );
  });
});
