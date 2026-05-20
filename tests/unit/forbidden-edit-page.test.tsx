/**
 * `components/edit/forbidden-edit-page.tsx` — the visible 403 page rendered by
 * `/edit/scholar/[cwid]` and `/edit/publication/[pmid]` for an authenticated-
 * but-unauthorized request (#356 Phase 7 C5, UI-SPEC § States row 2).
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
  it("renders the SPEC-specified title copy", () => {
    render(<ForbiddenEditPage />);
    expect(
      screen.getByText("You don't have permission to edit this profile."),
    ).toBeTruthy();
  });

  it("renders the explanatory subline naming the administrator role", () => {
    render(<ForbiddenEditPage />);
    expect(
      screen.getByText(/Only an administrator can edit another scholar's profile/i),
    ).toBeTruthy();
  });

  it("links to /edit so the signed-in user can fall back to their own surface", () => {
    render(<ForbiddenEditPage />);
    const link = screen.getByRole("link", { name: /Go to my own profile editor/i });
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
