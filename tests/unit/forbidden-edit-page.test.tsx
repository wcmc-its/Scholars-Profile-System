/**
 * `components/edit/forbidden-edit-page.tsx` — the visible 403 page rendered for
 * an authenticated-but-unauthorized `/edit/*` request (#356 Phase 7 C5, UI-SPEC
 * § States row 2), generalized 2026-08-19 to also cover the ~20 console list/
 * queue/dashboard pages this component is shared with.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { vi } from "vitest";

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";

describe("ForbiddenEditPage", () => {
  it("renders a generic title — no specific page/action named, true for both a record editor and a console dashboard", () => {
    render(<ForbiddenEditPage />);
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
  });

  it("renders an explanatory subline naming no specific role (accurate for both an admin-only page and a narrower-role one)", () => {
    render(<ForbiddenEditPage />);
    expect(screen.getByText(/Your account's role doesn't include it/i)).toBeTruthy();
  });

  it("links to /edit so the signed-in user can fall back to their own surface", () => {
    render(<ForbiddenEditPage />);
    const link = screen.getByRole("link", { name: /Go to your own console/i });
    expect(link.getAttribute("href")).toBe("/edit");
  });

  it("carries the target cwid as a data attribute (diagnostic only — never visible)", () => {
    render(<ForbiddenEditPage targetCwid="other7" />);
    const root = document.querySelector('[data-slot="forbidden-edit-page"]');
    expect(root?.getAttribute("data-target-cwid")).toBe("other7");
    // The cwid is never in user-visible copy.
    expect(root?.textContent).not.toContain("other7");
  });

  it("omits a target cwid cleanly when none is provided", () => {
    render(<ForbiddenEditPage />);
    const root = document.querySelector('[data-slot="forbidden-edit-page"]');
    expect(root?.getAttribute("data-target-cwid")).toBe("");
  });
});
