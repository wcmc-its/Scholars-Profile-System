/**
 * The "About Available technologies" info button (#1715).
 *
 * The licensing attribution + contact moved off a footer paragraph and behind
 * the section heading. The load-bearing requirement is that the contact stays
 * ACTIONABLE once it is behind the trigger: a hover `Tooltip` (what the two
 * sibling section tooltips on this page use) cannot host a reachable link, which
 * is why this one is a click-toggled Popover. These tests pin that — if someone
 * "unifies" this back onto Tooltip, the mailto assertion fails.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TechnologiesInfoButton } from "@/components/scholar/technologies-info-button";

const EMAIL = "enterpriseinnovation@med.cornell.edu";

describe("TechnologiesInfoButton", () => {
  it("keeps the panel closed until the trigger is clicked", () => {
    render(<TechnologiesInfoButton />);
    expect(screen.getByRole("button", { name: "About Available technologies" })).toBeTruthy();
    expect(screen.queryByText(new RegExp(EMAIL))).toBeNull();
  });

  it("opens on click and exposes the licensing inbox as a clickable mailto", () => {
    render(<TechnologiesInfoButton />);
    fireEvent.click(screen.getByRole("button", { name: "About Available technologies" }));

    const mailto = screen.getByRole("link", { name: EMAIL });
    expect(mailto.getAttribute("href")).toBe(`mailto:${EMAIL}`);
  });

  it("links Enterprise Innovation to the About Us page", () => {
    render(<TechnologiesInfoButton />);
    fireEvent.click(screen.getByRole("button", { name: "About Available technologies" }));

    const about = screen.getByRole("link", { name: "Enterprise Innovation" });
    expect(about.getAttribute("href")).toBe("https://innovation.weill.cornell.edu/about-us");
    expect(about.getAttribute("rel")).toContain("noopener");
  });
});
