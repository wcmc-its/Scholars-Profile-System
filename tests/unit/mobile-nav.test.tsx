import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { MobileNav } from "@/components/site/mobile-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/about" }));

/**
 * Guards the #1902 fix. jsdom has no layout engine, so the reflow itself is
 * verified in a real browser, not here. What this pins is the part that would
 * silently regress in code review: that the destination links exist behind the
 * trigger at all. Before the fix they were rendered but off-canvas, which is
 * exactly the failure a render-only assertion cannot see -- hence the emphasis
 * on the trigger being operable and the links being reachable through it.
 */
describe("MobileNav", () => {
  it("keeps the primary destinations behind an operable trigger", async () => {
    render(<MobileNav />);

    const trigger = screen.getByRole("button", { name: "Open menu" });
    expect(screen.queryByRole("link", { name: "Browse" })).toBeNull();

    fireEvent.click(trigger);

    const browse = await screen.findByRole("link", { name: "Browse" });
    expect(browse.getAttribute("href")).toBe("/search");
    expect(screen.getByRole("link", { name: "About" }).getAttribute("href")).toBe("/about");
  });

  it("marks the current page for assistive tech", async () => {
    render(<MobileNav />);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    const about = await screen.findByRole("link", { name: "About" });
    expect(about.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Browse" }).getAttribute("aria-current")).toBeNull();
  });
});
