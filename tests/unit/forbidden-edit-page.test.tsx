/**
 * `components/edit/forbidden-edit-page.tsx` — the visible 403 page rendered for
 * an authenticated-but-unauthorized `/edit/*` request (#356 Phase 7 C5, UI-SPEC
 * § States row 2), generalized 2026-08-19 to also cover the ~20 console list/
 * queue/dashboard pages this component is shared with, then widened the same
 * day to redirect straight through — no interstitial at all — whenever the
 * viewer's session resolves to exactly one destination. A page renders only
 * when there's a genuine choice to show (2+ destinations) or the "unit" variant
 * (which always has a definite, single answer but keeps its own copy).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
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

const mockRedirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`__REDIRECT__:${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

import { ForbiddenEditPage } from "@/components/edit/forbidden-edit-page";

beforeEach(() => {
  mockRedirect.mockClear();
});

describe("ForbiddenEditPage — single destination redirects straight through (2026-08-19)", () => {
  it.each([
    ["isCvGenerator", "/edit/scholars"],
    ["isHonorsCurator", "/edit/honors-queue"],
    ["isDataSharingViewer", "/edit/data-sharing"],
    ["isDeveloper", "/edit/find-researchers"],
  ] as const)("with only %s on the session, redirects straight to %s — no interstitial", (flag, href) => {
    // React re-invokes a throwing function component once to distinguish a
    // transient error from a deterministic one (test-harness behavior, not
    // real SSR) — assert the URL, not an exact call count.
    expect(() => render(<ForbiddenEditPage session={{ [flag]: true }} />)).toThrow(`__REDIRECT__:${href}`);
    expect(mockRedirect).toHaveBeenCalledWith(href);
  });

  it.each([["isSuperuser"], ["isCommsSteward"]] as const)(
    "%s alone redirects to Profiles, not the generic /edit — they can genuinely edit any scholar's profile",
    (flag) => {
      expect(() => render(<ForbiddenEditPage session={{ [flag]: true }} />)).toThrow(
        "__REDIRECT__:/edit/scholars",
      );
    },
  );

  it("a superuser who also happens to be cv_generator redirects to Profiles — no redundant read-only duplicate to choose between", () => {
    expect(() =>
      render(<ForbiddenEditPage session={{ isSuperuser: true, isCvGenerator: true }} />),
    ).toThrow("__REDIRECT__:/edit/scholars");
    expect(mockRedirect).toHaveBeenCalledWith("/edit/scholars");
  });

  it("no session passed (the two bare-ConsoleTopBar detail pages) redirects to /edit, same as the old fallback link's target", () => {
    expect(() => render(<ForbiddenEditPage />)).toThrow("__REDIRECT__:/edit");
  });

  it("a session with none of the recognized grants (e.g. a unit admin with no other role) redirects to /edit", () => {
    expect(() => render(<ForbiddenEditPage session={{}} />)).toThrow("__REDIRECT__:/edit");
  });
});

describe("ForbiddenEditPage — multiple destinations renders a choice, doesn't guess", () => {
  it("a viewer holding more than one grant sees a link to EACH, and no redirect fires", () => {
    render(<ForbiddenEditPage session={{ isCommsSteward: true, isHonorsCurator: true, isDeveloper: true }} />);
    expect(mockRedirect).not.toHaveBeenCalled();
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Profiles", "Honors queue", "Funding matcher"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/edit/scholars",
      "/edit/honors-queue",
      "/edit/find-researchers",
    ]);
  });

  it("renders the generic title and subline — no specific page/action/role named", () => {
    render(<ForbiddenEditPage session={{ isCommsSteward: true, isHonorsCurator: true }} />);
    expect(screen.getByText("You don't have access to this page.")).toBeTruthy();
    expect(screen.getByText(/Your account's role doesn't include it/i)).toBeTruthy();
  });

  it("carries the target cwid as a data attribute (diagnostic only — never visible)", () => {
    render(
      <ForbiddenEditPage
        targetCwid="other7"
        session={{ isCommsSteward: true, isHonorsCurator: true }}
      />,
    );
    const root = document.querySelector('[data-slot="forbidden-edit-page"]');
    expect(root?.getAttribute("data-target-cwid")).toBe("other7");
    // The cwid is never in user-visible copy.
    expect(root?.textContent).not.toContain("other7");
  });

  it("omits a target cwid cleanly when none is provided", () => {
    render(<ForbiddenEditPage session={{ isCommsSteward: true, isHonorsCurator: true }} />);
    const root = document.querySelector('[data-slot="forbidden-edit-page"]');
    expect(root?.getAttribute("data-target-cwid")).toBe("");
  });
});

describe("ForbiddenEditPage — unit variant (unaffected by any of the above)", () => {
  it("keeps its own copy and never redirects, regardless of session", () => {
    render(<ForbiddenEditPage variant="unit" targetEntity="cardiology" session={{ isDeveloper: true }} />);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByText("You don't have permission to edit this unit.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Return to Scholars" });
    expect(link.getAttribute("href")).toBe("/");
  });
});
