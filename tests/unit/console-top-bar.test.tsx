/**
 * `components/edit/console-top-bar.tsx` — dwd2001 nav fix (bug #4). Every
 * `/edit` detail page needs a structural path back to `/edit` (the brand link)
 * and a real account menu (not a bare Sign-out, and not nothing at all for a
 * non-scholar actor). Pins:
 *   - the `editor` variant always mounts the self-fetching
 *     `AccountMenu context="console"` (same mount `AdminSubnav` uses) — no
 *     scholar prop threaded in, no bare-signout fallback;
 *   - the `console` variant leaves that to `AdminSubnav` by default, but can
 *     render it itself via `showAccountMenu` for the two audit-history pages
 *     that have no `AdminSubnav` in their tree;
 *   - the brand (WCM badge + wordmark) is a `Link` to `/edit` in both
 *     variants, nested inside the `<h1>` (editor) / `<span>` (console) — never
 *     the reverse, which would make the console-variant name element itself a
 *     link wrapper instead of a real heading/span.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// The bar mounts the real AccountMenu (a client island that probes
// /api/auth/session) at its right end on some paths. Stub it so the bar is
// tested in isolation without a live fetch / Popover — same pattern as
// admin-subnav.test.tsx / console-shell.test.tsx.
import { vi } from "vitest";
vi.mock("@/components/site/account-menu", () => ({
  AccountMenu: ({ context }: { context?: string }) => (
    <div data-testid="account-menu-stub" data-context={context} />
  ),
}));

import { ConsoleTopBar } from "@/components/edit/console-top-bar";

describe("ConsoleTopBar — editor variant (default)", () => {
  it("renders the console-context account menu — no scholar prop, no bare signout", () => {
    render(<ConsoleTopBar />);
    const menu = screen.getByTestId("account-menu-stub");
    expect(menu.getAttribute("data-context")).toBe("console");
    expect(screen.queryByTestId("edit-signout")).toBeNull();
  });

  it("renders the brand as a Link to /edit nested inside the <h1>", () => {
    render(<ConsoleTopBar />);
    const heading = screen.getByRole("heading", { level: 1 });
    const link = screen.getByRole("link", { name: /Scholars Profile Console/ });
    expect(heading.contains(link)).toBe(true);
    expect(link.getAttribute("href")).toBe("/edit");
  });
});

describe("ConsoleTopBar — console variant", () => {
  it("renders no account menu by default (AdminSubnav supplies it below)", () => {
    render(<ConsoleTopBar variant="console" />);
    expect(screen.queryByTestId("account-menu-stub")).toBeNull();
  });

  it("renders the console-context account menu when showAccountMenu is set (the two AdminSubnav-less audit pages)", () => {
    render(<ConsoleTopBar variant="console" showAccountMenu />);
    const menu = screen.getByTestId("account-menu-stub");
    expect(menu.getAttribute("data-context")).toBe("console");
  });

  it("renders the brand as a Link to /edit nested inside a non-heading <span> — no <h1>", () => {
    render(<ConsoleTopBar variant="console" />);
    expect(screen.queryByRole("heading")).toBeNull();
    const link = screen.getByRole("link", { name: /Scholars Profile Console/ });
    expect(link.getAttribute("href")).toBe("/edit");
    expect(link.closest("span")?.textContent).toContain("Scholars Profile Console");
  });
});
