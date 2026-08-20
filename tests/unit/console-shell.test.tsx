/**
 * `components/edit/console-shell.tsx` — the shared chrome for the /edit console
 * list/queue pages (console-shell-migration-plan.md; `loadConsoleTabs` migration,
 * docs/edit-console-ia-spec.md Part B §2). Asserts the shell wiring: the
 * warm-page shell, ONE console-variant top bar (no second <h1>, no in-bar
 * account menu / Sign out), the correct AdminSubnav `active`, the `#console-main`
 * region, and that the tab set ConsoleShell renders matches whatever
 * `loadConsoleTabs` returns (mocked here — its own role × tab matrix is
 * `tests/unit/console-tab-matrix.test.ts`'s job, not this file's).
 *
 * `ConsoleShell` is an async Server Component (it awaits `loadConsoleTabs`), so
 * every test resolves it first (`render(await ConsoleShell({...}))`) rather than
 * passing JSX straight to `render()` — react-dom's synchronous renderer can't
 * mount an unresolved async component.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { EditSession } from "@/lib/auth/superuser";
import type { ConsoleTabState } from "@/lib/edit/console-tabs.server";

const { mockLoadConsoleTabs } = vi.hoisted(() => ({ mockLoadConsoleTabs: vi.fn() }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The AdminSubnav strip mounts the real AccountMenu (a client island probing
// /api/auth/session) at its right end — stub it so the shell renders without a
// live fetch. Its presence here is what makes the top bar deliberately menu-free.
vi.mock("@/components/site/account-menu", () => ({
  AccountMenu: ({ context }: { context?: string }) => (
    <div data-testid="account-menu-stub" data-context={context} />
  ),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));
vi.mock("@/lib/edit/console-tabs.server", () => ({ loadConsoleTabs: mockLoadConsoleTabs }));

import { ConsoleShell } from "@/components/edit/console-shell";

function session(overrides: Partial<EditSession>): EditSession {
  return { cwid: "aaa0001", isSuperuser: false, isCommsSteward: false, ...overrides };
}

const NO_TABS: ConsoleTabState = {
  profiles: false,
  units: false,
  slugRequests: false,
  honors: false,
  news: false,
  slugs: false,
  administrators: false,
  methods: false,
  reports: false,
  coi: false,
  dataSharing: false,
  activity: false,
  usage: false,
  etlStatus: false,
  cores: false,
  fundingMatcher: false,
  matcha: false,
  grantMatcha: false,
};

function tabs(overrides: Partial<ConsoleTabState>): ConsoleTabState {
  return { ...NO_TABS, ...overrides };
}

describe("ConsoleShell", () => {
  it("renders the shell chrome once, with the page's <h1> the only h1", async () => {
    mockLoadConsoleTabs.mockResolvedValue(tabs({ activity: true }));
    const { container } = render(
      await ConsoleShell({
        active: "activity",
        session: session({ isSuperuser: true }),
        pendingSlugRequests: null,
        pendingHonors: null,
        children: <h1>Edit activity</h1>,
      }),
    );

    // Warm-page shell + a skip link into the main region.
    expect(container.querySelector(".bg-apollo-page")).toBeTruthy();
    expect(screen.getByText("Skip to content").getAttribute("href")).toBe("#console-main");

    // The console-variant top bar: the console name is a NON-heading span, so the
    // page's own <h1> is the ONLY h1 — no double-heading.
    const title = screen.getByText("Scholars Profile Console");
    expect(title.tagName).toBe("SPAN");
    const h1s = container.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe("Edit activity");

    // No in-bar account menu / Sign out — the account menu lives in the subnav.
    expect(screen.queryByTestId("edit-signout")).toBeNull();
    expect(screen.getByTestId("account-menu-stub").getAttribute("data-context")).toBe("console");

    // The active tab is marked; the main region is present.
    expect(screen.getByTestId("admin-tab-activity").getAttribute("aria-current")).toBe("page");
    const main = container.querySelector("#console-main");
    expect(main?.tagName).toBe("MAIN");
  });

  it("renders every tab loadConsoleTabs turns on (superuser — full strip)", async () => {
    mockLoadConsoleTabs.mockResolvedValue(
      tabs({
        profiles: true,
        units: true,
        administrators: true,
        activity: true,
        usage: true,
        reports: true,
      }),
    );
    render(
      await ConsoleShell({
        active: "activity",
        session: session({ isSuperuser: true }),
        pendingSlugRequests: null,
        pendingHonors: null,
        children: <h1>Edit activity</h1>,
      }),
    );
    expect(screen.getByTestId("admin-tab-administrators")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-slugs")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-activity")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-usage")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-reports").getAttribute("href")).toBe("/edit/reports");
    expect(mockLoadConsoleTabs).toHaveBeenCalledWith(session({ isSuperuser: true }), {});
  });

  it("hides whatever loadConsoleTabs turns off (comms_steward — no superuser-only surfaces)", async () => {
    mockLoadConsoleTabs.mockResolvedValue(
      tabs({ profiles: true, units: true, methods: true, reports: true }),
    );
    render(
      await ConsoleShell({
        active: "methods",
        session: session({ isCommsSteward: true }),
        pendingSlugRequests: null,
        pendingHonors: null,
        children: <h1>Method families</h1>,
      }),
    );
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-units")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-reports")).toBeTruthy();
    // Superuser-only surfaces stay hidden — `superuserSurfaces` still comes
    // straight from `session.isSuperuser`, independent of `loadConsoleTabs`.
    expect(screen.queryByTestId("admin-tab-slugs")).toBeNull();
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
    expect(screen.queryByTestId("admin-tab-activity")).toBeNull();
  });

  it("hides the Reports tab from a plain scholar with no reportsTab override", async () => {
    mockLoadConsoleTabs.mockResolvedValue(NO_TABS);
    render(
      await ConsoleShell({
        active: "profiles",
        session: session({}),
        pendingSlugRequests: null,
        pendingHonors: null,
        children: <h1>Profiles</h1>,
      }),
    );
    expect(screen.queryByTestId("admin-tab-reports")).toBeNull();
  });

  it("shows the Reports tab to a unit Owner/Curator via the page's reportsTab override, even when loadConsoleTabs itself says no", async () => {
    // `reports: false` — this viewer doesn't earn the tab everywhere, but the
    // page they're standing on (one of the /edit/reports/* family) forces it on
    // unconditionally, an OR-only escape hatch that can't reintroduce a
    // Gap-3/4b-shaped bug (see the module doc comment).
    mockLoadConsoleTabs.mockResolvedValue(NO_TABS);
    render(
      await ConsoleShell({
        active: "reports",
        session: session({}),
        pendingSlugRequests: null,
        pendingHonors: null,
        reportsTab: true,
        children: <h1>Reports</h1>,
      }),
    );
    expect(screen.getByTestId("admin-tab-reports")).toBeTruthy();
    // Neither Profiles nor the superuser strip leaks in from this override.
    expect(screen.queryByTestId("admin-tab-profiles")).toBeNull();
    expect(screen.queryByTestId("admin-tab-slugs")).toBeNull();
  });

  it("shows the Units tab to anyone via the page's unitsTab override, even when loadConsoleTabs itself says no", async () => {
    // `/edit/units` has no unit-admin gate of its own — see the module doc
    // comment — so it forces `unitsTab` on unconditionally too.
    mockLoadConsoleTabs.mockResolvedValue(NO_TABS);
    render(
      await ConsoleShell({
        active: "units",
        session: session({}),
        pendingSlugRequests: null,
        pendingHonors: null,
        unitsTab: true,
        children: <h1>Org units</h1>,
      }),
    );
    expect(screen.getByTestId("admin-tab-units")).toBeTruthy();
  });
});
