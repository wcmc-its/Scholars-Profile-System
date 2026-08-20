/**
 * `components/edit/grant-matcha-tabs.tsx` — the Browse / Submissions sub-tab
 * strip on `/edit/grant-matcha` (mirrors `find-researchers-tabs.test.tsx`):
 *  - `?tab=` drives the active tab (default Browse); `intakeEnabled={false}`
 *    renders the bare panel with no strip at all;
 *  - the precedence rule: a non-empty `?opp=<id>` is a deep-linked SELECTED
 *    opportunity, so Browse renders regardless of `?tab=` — and the
 *    Submissions href drops `opp`, or the tab would be a no-op under that
 *    same rule.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/edit/grant-matcha",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/components/edit/grant-matcha-panel", () => ({
  GrantMatchaPanel: () => <div data-testid="browse-content" />,
}));
vi.mock("@/components/edit/opportunity-intake-panel", () => ({
  OpportunityIntakePanel: () => <div data-testid="submissions-content" />,
}));

import { GrantMatchaTabs } from "@/components/edit/grant-matcha-tabs";

describe("GrantMatchaTabs", () => {
  it("defaults to Browse: the matcher panel, Browse tab selected", () => {
    search = "";
    render(<GrantMatchaTabs intakeEnabled />);
    expect(screen.getByTestId("browse-content")).toBeTruthy();
    expect(screen.queryByTestId("submissions-content")).toBeNull();

    expect(screen.getByTestId("grant-matcha-tab-browse").getAttribute("aria-selected")).toBe(
      "true",
    );
    const submissions = screen.getByTestId("grant-matcha-tab-submissions");
    expect(submissions.getAttribute("aria-selected")).toBe("false");
    expect(submissions.getAttribute("href")).toBe("/edit/grant-matcha?tab=submissions");
  });

  it("?tab=submissions shows the intake panel", () => {
    search = "tab=submissions";
    render(<GrantMatchaTabs intakeEnabled />);
    expect(screen.getByTestId("submissions-content")).toBeTruthy();
    expect(screen.queryByTestId("browse-content")).toBeNull();
    expect(
      screen.getByTestId("grant-matcha-tab-submissions").getAttribute("aria-selected"),
    ).toBe("true");
    // Switching back to Browse simply drops `tab`.
    expect(screen.getByTestId("grant-matcha-tab-browse").getAttribute("href")).toBe(
      "/edit/grant-matcha",
    );
  });

  it("🔴 a deep-linked ?opp= wins over ?tab=submissions — Browse renders the selection", () => {
    search = "tab=submissions&opp=wcm_curated%3Ahartwell-abc123";
    render(<GrantMatchaTabs intakeEnabled />);
    // The pasted-into-Teams link lands on the selected opportunity, never the
    // intake form.
    expect(screen.getByTestId("browse-content")).toBeTruthy();
    expect(screen.queryByTestId("submissions-content")).toBeNull();
    expect(screen.getByTestId("grant-matcha-tab-browse").getAttribute("aria-selected")).toBe(
      "true",
    );
    // The Submissions href drops `opp` (a kept selection would win over `tab=`
    // and make the tab a no-op) while setting `tab=submissions`.
    expect(screen.getByTestId("grant-matcha-tab-submissions").getAttribute("href")).toBe(
      "/edit/grant-matcha?tab=submissions",
    );
  });

  it("an EMPTY ?opp= is not a selection — ?tab=submissions still wins", () => {
    // Mirrors `GrantMatchaPanel`'s own truthiness check on the same param.
    search = "tab=submissions&opp=";
    render(<GrantMatchaTabs intakeEnabled />);
    expect(screen.getByTestId("submissions-content")).toBeTruthy();
    expect(screen.queryByTestId("browse-content")).toBeNull();
  });

  it("keeps the rest of the query on the Browse href (a drilled-in ?opp= survives a round-trip)", () => {
    search = "opp=wcm_curated%3Ahartwell-abc123";
    render(<GrantMatchaTabs intakeEnabled />);
    expect(screen.getByTestId("browse-content")).toBeTruthy();
    expect(screen.getByTestId("grant-matcha-tab-browse").getAttribute("href")).toBe(
      "/edit/grant-matcha?opp=wcm_curated%3Ahartwell-abc123",
    );
  });

  it("intakeEnabled={false} renders the bare panel — no tab strip to advertise a dark surface", () => {
    search = "";
    render(<GrantMatchaTabs />);
    expect(screen.getByTestId("browse-content")).toBeTruthy();
    expect(screen.queryByTestId("grant-matcha-tab-browse")).toBeNull();
    expect(screen.queryByTestId("grant-matcha-tab-submissions")).toBeNull();
    expect(screen.queryByTestId("submissions-content")).toBeNull();
  });
});
