/**
 * UnitSectionNav — the in-page section index of the single-scroll unit editor
 * (Edit Center mockup, 2026-09-25): `#anchor` links with a right-aligned stat,
 * amber when it flags something to fill in; the first section is marked current
 * until the scroll-spy says otherwise; a click marks that section current.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { UnitSectionNav } from "@/components/edit/unit-section-nav";

const ITEMS = [
  { id: "basics", label: "Basics", stat: "No description", warn: true },
  { id: "leadership", label: "Leadership", stat: "2" },
  { id: "retire", label: "Retire" },
];

describe("UnitSectionNav", () => {
  it("renders anchor links with their stats; a warn stat is amber", () => {
    render(<UnitSectionNav items={ITEMS} />);
    const desktop = screen.getByTestId("unit-section-nav");
    const basics = within(desktop).getByTestId("section-nav-basics");
    expect(basics.getAttribute("href")).toBe("#basics");
    expect(within(basics).getByText("No description").className).toContain("text-apollo-amber");
    expect(within(desktop).getByTestId("section-nav-leadership").textContent).toBe("Leadership2");
  });

  it("marks the first section current by default, and the clicked one after a click", () => {
    render(<UnitSectionNav items={ITEMS} />);
    const desktop = screen.getByTestId("unit-section-nav");
    expect(within(desktop).getByTestId("section-nav-basics").getAttribute("aria-current")).toBe(
      "location",
    );
    fireEvent.click(within(desktop).getByTestId("section-nav-retire"));
    expect(within(desktop).getByTestId("section-nav-retire").getAttribute("aria-current")).toBe(
      "location",
    );
    expect(within(desktop).getByTestId("section-nav-basics").getAttribute("aria-current")).toBeNull();
  });

  it("an initialSection (legacy ?attr= deep link) starts as the current one", () => {
    render(<UnitSectionNav items={ITEMS} initialSection="leadership" />);
    const desktop = screen.getByTestId("unit-section-nav");
    expect(within(desktop).getByTestId("section-nav-leadership").getAttribute("aria-current")).toBe(
      "location",
    );
  });

  it("also renders a phone chip row with the same anchors", () => {
    render(<UnitSectionNav items={ITEMS} />);
    const mobile = screen.getByTestId("unit-section-nav-mobile");
    expect(within(mobile).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#basics",
      "#leadership",
      "#retire",
    ]);
  });
});
