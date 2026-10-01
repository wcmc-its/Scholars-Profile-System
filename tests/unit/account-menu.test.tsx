import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AccountMenu, nameInitials, shortName } from "@/components/site/account-menu";
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
    cwid: null,
    scholar: null,
    displayName: null,
    impersonating: null,
    canImpersonate: false,
    isSuperuser: false,
    isContentEditor: false,
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
  it("comms_steward with no profile (dwd2001) → Admin console link, displayName fallback label, no Edit/View", () => {
    mockProbe({
      scholar: null,
      displayName: "Dana Davis",
      consoleLinks: [{ id: "manage-profiles", label: "Admin console", href: "/edit/profiles" }],
    });
    render(<AccountMenu scholar={null} />);
    // No scholar row → trigger falls back to the probe's stewardDirectory name,
    // not the bare "Account" default.
    expect(screen.getByText("Dana Davis")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Account menu"));

    const manage = screen.getByTestId("account-menu-console-manage-profiles");
    expect(manage.getAttribute("href")).toBe("/edit/profiles");
    expect(manage.textContent).toContain("Admin console");

    // The console section renders even without a profile — the whole point.
    expect(screen.queryByTestId("account-menu-edit")).toBeNull();
    expect(screen.queryByTestId("account-menu-view")).toBeNull();
    expect(screen.getByTestId("account-menu-signout")).toBeTruthy();
  });

  it("no scholar row and no displayName fallback → trigger falls back to 'Account'", () => {
    mockProbe({ scholar: null, displayName: null, consoleLinks: [] });
    render(<AccountMenu scholar={null} />);
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("superuser → a single 'Admin' link to the roster", () => {
    const sue = { slug: "sue-admin", preferredName: "Sue Admin" };
    mockProbe({
      scholar: sue,
      consoleLinks: [{ id: "manage-profiles", label: "Admin", href: "/edit/profiles" }],
    });
    render(<AccountMenu scholar={sue} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const manage = screen.getByTestId("account-menu-console-manage-profiles");
    expect(manage.getAttribute("href")).toBe("/edit/profiles");
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

  it("unit Owner/Curator → both rows, Profiles before Org units", () => {
    mockProbe({
      consoleLinks: [
        { id: "profiles", label: "Profiles", href: "/edit/profiles" },
        { id: "units", label: "Org units", href: "/edit/units" },
      ],
    });
    render(<AccountMenu scholar={null} />);
    fireEvent.click(screen.getByLabelText("Account menu"));

    const rows = screen
      .getAllByTestId(/^account-menu-console-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(rows).toEqual(["account-menu-console-profiles", "account-menu-console-units"]);
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
      consoleLinks: [{ id: "manage-profiles", label: "Admin console", href: "/edit/profiles" }],
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
        { id: "manage-profiles", label: "Admin console", href: "/edit/profiles" },
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

// Front page tweaks mockup (2026-09-30): identity row, target-named trigger,
// and the target's destinations (moved here from the banner).
describe("AccountMenu — identity and View as", () => {
  const paul = { slug: "paul-albert", preferredName: "Paul Albert" };
  const viewing = (role: ImpersonationProbe["impersonating"]) =>
    mockProbe({ scholar: paul, canImpersonate: true, isSuperuser: true, impersonating: role });
  const target = (over: Partial<NonNullable<ImpersonationProbe["impersonating"]>>) => ({
    targetCwid: "own001",
    targetName: "Jane Owner",
    role: "owner" as const,
    unitKind: "department" as const,
    unit: "Cardiology",
    startedAt: 0,
    ...over,
  });
  const targetLinks = () =>
    screen.getAllByTestId("account-menu-target-link").map((el) => [el.textContent, el.getAttribute("href")]);

  it("names a superuser's role in the header row", () => {
    mockProbe({ scholar: paul, canImpersonate: true, isSuperuser: true });
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.getByTestId("account-menu-identity").textContent).toBe("Paul AlbertSuperuser");
    expect(screen.getByTestId("account-menu-view-as").textContent).toContain("View as another user…");
  });

  it("prefixes the role with the REAL cwid when the probe has it", () => {
    mockProbe({ cwid: "pja2001", scholar: paul, canImpersonate: true, isSuperuser: true });
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.getByTestId("account-menu-identity").textContent).toBe("Paul Albertpja2001 · Superuser");
  });

  it("labels canImpersonate without superuser as Observer", () => {
    mockProbe({ scholar: paul, canImpersonate: true, isSuperuser: false });
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.getByTestId("account-menu-identity").textContent).toBe("Paul AlbertObserver");
  });

  it("labels a content editor as Content Editor, not Observer", () => {
    mockProbe({ scholar: paul, canImpersonate: true, isSuperuser: false, isContentEditor: true });
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.getByTestId("account-menu-identity").textContent).toBe("Paul AlbertContent Editor");
  });

  it("no identity row for a plain scholar", () => {
    mockProbe({ scholar: paul });
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.queryByTestId("account-menu-identity")).toBeNull();
  });

  it("while viewing as, the trigger names the target, not the real user", () => {
    viewing(target({ targetName: "Terrie Rose Wheeler" }));
    render(<AccountMenu scholar={paul} />);
    expect(screen.getByLabelText("Account menu").textContent).toBe("TWTerrie R. Wheeler");
    expect(screen.getByLabelText("Account menu").textContent).not.toContain("Paul Albert");
  });

  it("unit owner target → Profiles + Org units under '{First} can access'", () => {
    viewing(target({}));
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(screen.getByText("Jane can access")).toBeTruthy();
    expect(targetLinks()).toEqual([
      ["Profiles", "/edit/profiles"],
      ["Org units", "/edit/units"],
    ]);
  });

  it("search-blind global role (development) → its one console page", () => {
    viewing(target({ targetName: "lmp2006", role: "development", unitKind: null, unit: null }));
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(targetLinks()).toEqual([["Grant Matcha", "/edit/grant-matcha"]]);
  });

  it("comms_steward → the Admin console (the #2521 collapse)", () => {
    viewing(target({ targetName: "Dan Dickinson", role: "comms_steward", unitKind: null, unit: null }));
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(targetLinks()).toEqual([["Admin console", "/edit/profiles"]]);
  });

  it("plain scholar target → their own self-edit surface", () => {
    viewing(target({ targetName: "Jane Scholar", role: "scholar", unitKind: null, unit: null }));
    render(<AccountMenu scholar={paul} />);
    fireEvent.click(screen.getByLabelText("Account menu"));
    expect(targetLinks()).toEqual([["Their profile", "/edit"]]);
  });
});

describe("AccountMenu — pill trigger", () => {
  it("shortName keeps first + last, initials the middles, keeps a suffix", () => {
    expect(shortName("Terrie Rose Wheeler")).toBe("Terrie R. Wheeler");
    expect(shortName("Paul J. Albert")).toBe("Paul J. Albert");
    expect(shortName("Jane Smith")).toBe("Jane Smith");
    expect(shortName("John Q Public Jr.")).toBe("John Q. Public Jr.");
    expect(shortName("lmp2006")).toBe("lmp2006");
  });

  it("nameInitials uses first + surname, skipping a suffix", () => {
    expect(nameInitials("Terrie Rose Wheeler")).toBe("TW");
    expect(nameInitials("John Q Public Jr.")).toBe("JP");
    expect(nameInitials("lmp2006")).toBe("L");
  });

  it("renders the initials avatar and short name; no avatar for the 'Account' fallback", () => {
    const { unmount } = render(<AccountMenu scholar={{ slug: "t", preferredName: "Terrie Rose Wheeler" }} />);
    expect(screen.getByLabelText("Account menu").textContent).toBe("TWTerrie R. Wheeler");
    unmount();
    render(<AccountMenu scholar={null} />);
    expect(screen.getByLabelText("Account menu").textContent).toBe("Account");
  });
});
