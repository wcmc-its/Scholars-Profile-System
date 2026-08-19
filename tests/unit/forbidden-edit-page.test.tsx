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
    const link = screen.getByRole("link", { name: "your own console" });
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

describe("ForbiddenEditPage — session-aware own-destination link(s) (2026-08-19)", () => {
  it.each([
    ["isCvGenerator", "/edit/scholars", "Profiles (read-only)"],
    ["isHonorsCurator", "/edit/honors-queue", "Honors queue"],
    ["isDataSharingViewer", "/edit/data-sharing", "Data sharing"],
    ["isDeveloper", "/edit/find-researchers", "Funding matcher"],
  ] as const)(
    "with %s alone on the session, links straight to %s instead of bouncing through /edit",
    (flag, href, label) => {
      render(<ForbiddenEditPage session={{ [flag]: true }} />);
      const link = screen.getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      // The one link this session has — no extras.
      expect(screen.getAllByRole("link")).toHaveLength(1);
    },
  );

  it.each([["isSuperuser"], ["isCommsSteward"]] as const)(
    "%s goes to Profiles, not the generic /edit — they can genuinely edit any scholar's profile",
    (flag) => {
      render(<ForbiddenEditPage session={{ [flag]: true }} />);
      const link = screen.getByRole("link", { name: "Profiles" });
      expect(link.getAttribute("href")).toBe("/edit/scholars");
    },
  );

  it("a superuser who also happens to be cv_generator gets ONE 'Profiles' link, not a redundant read-only duplicate", () => {
    render(<ForbiddenEditPage session={{ isSuperuser: true, isCvGenerator: true }} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Profiles" }).getAttribute("href")).toBe("/edit/scholars");
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("a viewer holding more than one grant gets a link to EACH, not just the first match", () => {
    render(<ForbiddenEditPage session={{ isCommsSteward: true, isHonorsCurator: true, isDeveloper: true }} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Profiles", "Honors queue", "Funding matcher"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/edit/scholars",
      "/edit/honors-queue",
      "/edit/find-researchers",
    ]);
  });

  it("falls back to the generic /edit link when no session is passed (the two bare-ConsoleTopBar detail pages)", () => {
    render(<ForbiddenEditPage />);
    const link = screen.getByRole("link", { name: "your own console" });
    expect(link.getAttribute("href")).toBe("/edit");
  });

  it("falls back to /edit for a session with none of the recognized grants (e.g. a unit admin with no other role)", () => {
    render(<ForbiddenEditPage session={{}} />);
    const link = screen.getByRole("link", { name: "your own console" });
    expect(link.getAttribute("href")).toBe("/edit");
  });
});
