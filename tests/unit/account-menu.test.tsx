import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AccountMenu } from "@/components/site/account-menu";
import { useImpersonationProbe } from "@/components/site/use-impersonation-probe";
import type { ImpersonationProbe } from "@/components/site/use-impersonation-probe";

// The account-menu reads its admin/console rows from the `/api/auth/session`
// probe. Mock the hook so the render branches are exercised deterministically
// without a live fetch; it defaults to `null` (probe in flight / error), which
// is exactly what the existing no-probe cases below expect.
vi.mock("@/components/site/use-impersonation-probe", () => ({
  useImpersonationProbe: vi.fn(() => null),
}));

function mockProbe(probe: Partial<ImpersonationProbe>): void {
  vi.mocked(useImpersonationProbe).mockReturnValue({
    authenticated: true,
    scholar: null,
    impersonating: null,
    canImpersonate: false,
    consoleLinks: [],
    ...probe,
  });
}

beforeEach(() => {
  vi.mocked(useImpersonationProbe).mockReturnValue(null);
});

describe("AccountMenu — with a scholar row", () => {
  const scholar = { slug: "jane-smith", preferredName: "Jane Smith" };

  it("renders the scholar's preferredName as the trigger label", () => {
    render(<AccountMenu scholar={scholar} />);
    expect(screen.getByLabelText("Account menu")).toBeTruthy();
    expect(screen.getByText("Jane Smith")).toBeTruthy();
  });

  it("on open, surfaces Edit / View / Sign out (the full three-item menu + separator)", () => {
    render(<AccountMenu scholar={scholar} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const edit = screen.getByTestId("account-menu-edit");
    expect(edit.getAttribute("href")).toBe("/edit");
    expect(edit.textContent).toBe("Edit my profile");

    const view = screen.getByTestId("account-menu-view");
    // #671 — profile links use the root `/{slug}` form (profilePath).
    expect(view.getAttribute("href")).toBe("/jane-smith");
    expect(view.textContent).toBe("View my profile");

    const signout = screen.getByTestId("account-menu-signout");
    expect(signout.textContent).toBe("Sign out");
    expect(signout.closest("form")?.getAttribute("action")).toBe("/api/auth/logout");
    expect(signout.closest("form")?.getAttribute("method")?.toLowerCase()).toBe("post");

    // The Separator is rendered between View and Sign out (data-slot from separator.tsx).
    expect(document.querySelector('[data-slot="separator"]')).toBeTruthy();
  });
});

describe("AccountMenu — without a scholar row (D5.3)", () => {
  it("falls back to 'Account' as the trigger label", () => {
    render(<AccountMenu scholar={null} />);
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("on open, surfaces ONLY Sign out — no Edit / View / Separator", () => {
    render(<AccountMenu scholar={null} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    expect(screen.queryByTestId("account-menu-edit")).toBeNull();
    expect(screen.queryByTestId("account-menu-view")).toBeNull();
    expect(document.querySelector('[data-slot="separator"]')).toBeNull();

    const signout = screen.getByTestId("account-menu-signout");
    expect(signout.textContent).toBe("Sign out");
    expect(signout.closest("form")?.getAttribute("action")).toBe("/api/auth/logout");
  });
});

describe("AccountMenu — role-aware console links", () => {
  it("comms_steward with no profile (dwd2001) → Method families link, no Edit/View", () => {
    mockProbe({
      scholar: null,
      consoleLinks: [{ id: "methods", label: "Method families", href: "/edit/methods" }],
    });
    render(<AccountMenu scholar={null} />);
    // No scholar row → trigger still falls back to "Account".
    expect(screen.getByText("Account")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Account menu"));

    const methods = screen.getByTestId("account-menu-console-methods");
    expect(methods.getAttribute("href")).toBe("/edit/methods");
    expect(methods.textContent).toContain("Method families");

    // The console section renders even without a profile — the whole point.
    expect(screen.queryByTestId("account-menu-edit")).toBeNull();
    expect(screen.queryByTestId("account-menu-view")).toBeNull();
    expect(screen.getByTestId("account-menu-signout")).toBeTruthy();
  });

  it("superuser → a single 'Admin' link to the roster", () => {
    const sue = { slug: "sue-admin", preferredName: "Sue Admin" };
    mockProbe({
      scholar: sue,
      consoleLinks: [{ id: "manage-profiles", label: "Admin", href: "/edit/scholars" }],
    });
    render(<AccountMenu scholar={sue} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const manage = screen.getByTestId("account-menu-console-manage-profiles");
    expect(manage.getAttribute("href")).toBe("/edit/scholars");
    expect(screen.queryByTestId("account-menu-console-methods")).toBeNull();
    expect(screen.queryByTestId("account-menu-console-units")).toBeNull();
  });

  it("unit Owner/Curator → 'Org units' link", () => {
    mockProbe({
      consoleLinks: [{ id: "units", label: "Org units", href: "/edit/units" }],
    });
    render(<AccountMenu scholar={null} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const units = screen.getByTestId("account-menu-console-units");
    expect(units.getAttribute("href")).toBe("/edit/units");
  });

  it("steward AND unit admin → both rows, Method families before Org units", () => {
    mockProbe({
      consoleLinks: [
        { id: "methods", label: "Method families", href: "/edit/methods" },
        { id: "units", label: "Org units", href: "/edit/units" },
      ],
    });
    render(<AccountMenu scholar={null} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const rows = screen
      .getAllByTestId(/^account-menu-console-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual(["account-menu-console-methods", "account-menu-console-units"]);
  });

  it("plain scholar (empty consoleLinks) → no console section, just Edit/View/Sign out", () => {
    const jane = { slug: "jane-smith", preferredName: "Jane Smith" };
    mockProbe({ scholar: jane, consoleLinks: [] });
    render(<AccountMenu scholar={jane} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    expect(screen.queryAllByTestId(/^account-menu-console-/)).toHaveLength(0);
    expect(screen.getByTestId("account-menu-edit")).toBeTruthy();
  });
});

// account-dropdown-nav handoff, Workstream A — the unified dropdown (its
// ACCOUNT_CONSOLE_NAV_RESTRUCTURE flag was retired in #1440; unified is the
// only order).
describe("AccountMenu — unified dropdown", () => {
  const order = () =>
    screen
      .getAllByTestId(/^account-menu-(view|edit)$/)
      .map((el) => el.getAttribute("data-testid"));

  it("public → View precedes Edit, no Back-to-Scholars row", () => {
    const sue = { slug: "sue-admin", preferredName: "Sue Admin" };
    mockProbe({
      scholar: sue,
      consoleLinks: [{ id: "manage-profiles", label: "Admin console", href: "/edit/scholars" }],
    });
    render(<AccountMenu scholar={sue} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(order()).toEqual(["account-menu-view", "account-menu-edit"]);
    expect(screen.queryByTestId("account-menu-back-to-scholars")).toBeNull();
    // The superuser roster row renders verbatim from the probe (relabeled server-side).
    expect(screen.getByTestId("account-menu-console-manage-profiles").textContent).toContain(
      "Admin console",
    );
  });

  it("console context → View→Edit, a Back-to-Scholars link replaces the roster row; other role rows stay", () => {
    const sue = { slug: "sue-admin", preferredName: "Sue Admin" };
    mockProbe({
      scholar: sue,
      // No prop scholar is passed (the AdminSubnav mount omits it) — the chip and
      // links come from the probe.
      consoleLinks: [
        { id: "manage-profiles", label: "Admin console", href: "/edit/scholars" },
        { id: "methods", label: "Method families", href: "/edit/methods" },
      ],
    });
    render(<AccountMenu context="console" />);
    // The chip falls back to the probe's scholar name.
    expect(screen.getByText("Sue Admin")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Account menu"));

    expect(order()).toEqual(["account-menu-view", "account-menu-edit"]);
    expect(screen.getByTestId("account-menu-back-to-scholars").getAttribute("href")).toBe("/");
    // The roster row is dropped (the Profiles tab covers it)…
    expect(screen.queryByTestId("account-menu-console-manage-profiles")).toBeNull();
    // …but other role destinations stay (no roster-tab equivalent for them here).
    expect(screen.getByTestId("account-menu-console-methods").textContent).toContain(
      "Method families",
    );
  });
});
