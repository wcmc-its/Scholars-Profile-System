/**
 * `components/edit/admin-subnav.tsx` — the superuser admin sub-nav
 * (#497 PR-3c, `slug-personalization-ui-spec.md` § 3.1).
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The strip mounts the real AccountMenu (a client island that probes
// /api/auth/session) at its right end. Stub it so the strip is tested in
// isolation without a live fetch / Popover.
vi.mock("@/components/site/account-menu", () => ({
  AccountMenu: ({ context }: { context?: string }) => (
    <div data-testid="account-menu-stub" data-context={context} />
  ),
}));

import { AdminSubnav } from "@/components/edit/admin-subnav";

describe("AdminSubnav", () => {
  it("renders both tabs with the pending-count pill when the feature is on", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={3} />);
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-slug-requests")).toBeTruthy();
    expect(screen.getByTestId("admin-subnav-pending-count").textContent).toBe("3");
  });

  it("marks the active tab with aria-current and links the inactive one", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={1} />);
    expect(screen.getByTestId("admin-tab-profiles").getAttribute("aria-current")).toBe("page");
    // The inactive tab is a link to its surface.
    expect(screen.getByTestId("admin-tab-slug-requests").getAttribute("href")).toBe(
      "/edit/slug-requests",
    );
  });

  it("hides the URL-requests tab when the feature is off (pendingSlugRequests null)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.queryByTestId("admin-tab-slug-requests")).toBeNull();
  });

  it("always shows the Slug-registry tab — even when the URL-requests tab is hidden", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    const tab = screen.getByTestId("admin-tab-slugs");
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("href")).toBe("/edit/slugs");
    // it stays visible even when the slug-request feature is on too
    render(<AdminSubnav active="profiles" pendingSlugRequests={3} />);
    expect(screen.getAllByTestId("admin-tab-slugs").length).toBeGreaterThan(0);
  });

  it("marks the Slug-registry tab active with aria-current", () => {
    render(<AdminSubnav active="slugs" pendingSlugRequests={null} />);
    expect(screen.getByTestId("admin-tab-slugs").getAttribute("aria-current")).toBe("page");
  });

  it("omits the count pill when zero pending", () => {
    render(<AdminSubnav active="slug-requests" pendingSlugRequests={0} />);
    expect(screen.getByTestId("admin-tab-slug-requests").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("hides the Administrators tab when administratorsTab is null", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} administratorsTab={null} />);
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
  });

  it("hides the Administrators tab when administratorsTab is omitted (undefined)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
  });

  it("shows the Administrators tab when administratorsTab is 0 (no badge)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} administratorsTab={0} />);
    const tab = screen.getByTestId("admin-tab-administrators");
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("href")).toBe("/edit/administrators");
    // 0 is a count, not a badge — the pill only renders for count > 0.
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Administrators tab active with aria-current", () => {
    render(
      <AdminSubnav active="administrators" pendingSlugRequests={null} administratorsTab={0} />,
    );
    expect(screen.getByTestId("admin-tab-administrators").getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("hides the Method families tab when methodsTab is null/omitted", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} methodsTab={null} />);
    expect(screen.queryByTestId("admin-tab-methods")).toBeNull();
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    expect(screen.queryByTestId("admin-tab-methods")).toBeNull();
  });

  it("shows the Method families tab (linking /edit/methods) when methodsTab is 0", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} methodsTab={0} />);
    const tab = screen.getByTestId("admin-tab-methods");
    expect(tab.getAttribute("href")).toBe("/edit/methods");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Method families tab active with aria-current", () => {
    render(<AdminSubnav active="methods" pendingSlugRequests={null} methodsTab={0} />);
    expect(screen.getByTestId("admin-tab-methods").getAttribute("aria-current")).toBe("page");
  });

  it("shows the Funding matcher tab on every superuser surface (rides superuserSurfaces)", () => {
    // Default superuserSurfaces=true (a superuser-only page like Profiles).
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    expect(screen.getByTestId("admin-tab-find-researchers").getAttribute("href")).toBe(
      "/edit/find-researchers",
    );
  });

  it("hides the Funding matcher tab for a non-superuser, non-developer (comms_steward)", () => {
    render(
      <AdminSubnav active="methods" pendingSlugRequests={null} methodsTab={0} superuserSurfaces={false} />,
    );
    expect(screen.queryByTestId("admin-tab-find-researchers")).toBeNull();
  });

  it("shows the Funding matcher tab to a pure dev-role viewer via viewerIsDeveloper", () => {
    render(
      <AdminSubnav
        active="find-researchers"
        pendingSlugRequests={null}
        superuserSurfaces={false}
        viewerIsDeveloper
      />,
    );
    const tab = screen.getByTestId("admin-tab-find-researchers");
    expect(tab.getAttribute("aria-current")).toBe("page");
    // the superuser-only surfaces stay hidden for a pure dev-role viewer
    expect(screen.queryByTestId("admin-tab-slugs")).toBeNull();
    expect(screen.queryByTestId("admin-tab-profiles")).toBeNull();
  });

  it("superuserSurfaces=false shows ONLY Method families (a comms_steward who is not a superuser)", () => {
    render(
      <AdminSubnav
        active="methods"
        pendingSlugRequests={3}
        administratorsTab={0}
        methodsTab={0}
        superuserSurfaces={false}
      />,
    );
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
    expect(screen.queryByTestId("admin-tab-profiles")).toBeNull();
    expect(screen.queryByTestId("admin-tab-slugs")).toBeNull();
    expect(screen.queryByTestId("admin-tab-slug-requests")).toBeNull();
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
  });

  // account-dropdown-nav handoff, Workstream A (its ACCOUNT_CONSOLE_NAV_RESTRUCTURE
  // flag was retired in #1440) — the account chip/dropdown (context="console")
  // anchors the right end on every console surface; profile actions live in the
  // menu, so there is no "My Profile" tab.
  it("mounts the account menu (console context) at the right end — no My Profile tab", () => {
    render(<AdminSubnav active="self" pendingSlugRequests={null} methodsTab={0} />);
    expect(screen.queryByTestId("admin-subnav-self-edit")).toBeNull();
    const stub = screen.getByTestId("account-menu-stub");
    expect(stub.getAttribute("data-context")).toBe("console");
    // The console tabs themselves are unaffected.
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
  });

  it('active="self" for a superuser shows the full tab strip (no tab active)', () => {
    render(
      <AdminSubnav active="self" pendingSlugRequests={0} administratorsTab={0} methodsTab={0} />,
    );
    // All admin tabs are present and are links (none active — we're on self).
    for (const id of ["profiles", "slugs", "administrators", "methods"]) {
      const tab = screen.getByTestId(`admin-tab-${id}`);
      expect(tab.getAttribute("aria-current")).toBeNull();
    }
    expect(screen.getByTestId("account-menu-stub")).toBeTruthy();
  });

  it('active="self" for a steward-only viewer shows only Method families', () => {
    render(
      <AdminSubnav
        active="self"
        pendingSlugRequests={null}
        methodsTab={0}
        superuserSurfaces={false}
      />,
    );
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
    expect(screen.queryByTestId("admin-tab-profiles")).toBeNull();
    expect(screen.getByTestId("account-menu-stub")).toBeTruthy();
  });

  // Data Quality dashboard tab (docs/data-quality-dashboard-spec.md).
  it("hides the Data quality tab when dataQualityTab is null/omitted", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} dataQualityTab={null} />);
    expect(screen.queryByTestId("admin-tab-data-quality")).toBeNull();
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} />);
    expect(screen.queryByTestId("admin-tab-data-quality")).toBeNull();
  });

  it("shows the Data quality tab (linking /edit/data-quality) when dataQualityTab is 0", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} dataQualityTab={0} />);
    const tab = screen.getByTestId("admin-tab-data-quality");
    expect(tab.getAttribute("href")).toBe("/edit/data-quality");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Data quality tab active with aria-current", () => {
    render(<AdminSubnav active="data-quality" pendingSlugRequests={null} dataQualityTab={0} />);
    expect(screen.getByTestId("admin-tab-data-quality").getAttribute("aria-current")).toBe("page");
  });

  // A unit Owner/Curator (superuserSurfaces=false) still gets Data quality scoped
  // to their units — the `/edit/units` page passes dataQualityTab on grants.
  it("shows Data quality for a non-superuser when dataQualityTab is set", () => {
    render(
      <AdminSubnav
        active="units"
        pendingSlugRequests={null}
        superuserSurfaces={false}
        unitsTab
        dataQualityTab={0}
      />,
    );
    expect(screen.getByTestId("admin-tab-data-quality")).toBeTruthy();
    expect(screen.queryByTestId("admin-tab-profiles")).toBeNull();
  });

  // comms-steward-profile-editing-spec.md §3b — a steward edits org units, so
  // the Units tab is shown via the `unitsTab` capability.
  it("shows the Units tab (linking /edit/units) when unitsTab is true", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} profilesTab unitsTab />);
    expect(screen.getByTestId("admin-tab-units").getAttribute("href")).toBe("/edit/units");
  });

  it("hides the Units tab when unitsTab is false/omitted", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} superuserSurfaces />);
    expect(screen.queryByTestId("admin-tab-units")).toBeNull();
  });

  it('marks the Units tab active with aria-current when active="units"', () => {
    render(<AdminSubnav active="units" pendingSlugRequests={null} unitsTab />);
    expect(screen.getByTestId("admin-tab-units").getAttribute("aria-current")).toBe("page");
  });

  // ── The Matcha tab and its explanatory hover (round-2 §2) ───────────────────
  //
  // The whole suite above never sees this tab: `isMatchaEnabled()` reads env, so it is dark by
  // default and every existing assertion passes with the tab absent. That is precisely how this
  // feature shipped a shortlist that was dark in the default density while six tests clicked
  // "compact" first — so the flag is forced ON here rather than left to the ambient env.
  describe("the Matcha tab (§2)", () => {
    it("renders and links when the flag is on — the HoverCard wrap must not swallow the nav", async () => {
      vi.resetModules();
      vi.doMock("@/lib/api/matcha", () => ({ isMatchaEnabled: () => true }));
      const { AdminSubnav: Subnav } = await import("@/components/edit/admin-subnav");
      render(<Subnav active="profiles" pendingSlugRequests={null} superuserSurfaces />);
      const tab = screen.getByTestId("admin-tab-matcha");
      expect(tab.textContent).toContain("Matcha");
      // The tab is still a LINK. Wrapping a nav item in a hover trigger that ate its href would
      // be invisible to a render-only assertion — the tab would look right and go nowhere.
      expect(tab.getAttribute("href")).toBe("/edit/matcha");
      vi.doUnmock("@/lib/api/matcha");
    });

    it("carries the explanatory copy — the name is opaque BEFORE you reach the page", async () => {
      vi.resetModules();
      vi.doMock("@/lib/api/matcha", () => ({ isMatchaEnabled: () => true }));
      const { AdminSubnav: Subnav } = await import("@/components/edit/admin-subnav");
      render(<Subnav active="profiles" pendingSlugRequests={null} superuserSurfaces />);
      const tab = screen.getByTestId("admin-tab-matcha");
      // Radix HoverCard opens on pointerenter (200ms) and on focus. Focus is the deterministic
      // path in jsdom and is the accessibility-relevant one besides.
      fireEvent.focus(tab);
      const panel = await screen.findByText(/Paste the ask\. Get the shortlist\./);
      expect(panel).toBeTruthy();
      expect(panel.parentElement?.textContent).toContain("ranks scholars by fit across all of them");
      vi.doUnmock("@/lib/api/matcha");
    });

    it("leaves every other tab hover-free — the prop is additive, not a sweep", async () => {
      // ⚠ This MUST use the same mocked module as the test above. Written against the static
      // import it passed even when every tab was given the hover — the flag is off there, so the
      // card never opened and the assertion could not fail in either direction. Caught by
      // mutation, not by review.
      vi.resetModules();
      vi.doMock("@/lib/api/matcha", () => ({ isMatchaEnabled: () => true }));
      const { AdminSubnav: Subnav } = await import("@/components/edit/admin-subnav");
      render(<Subnav active="profiles" pendingSlugRequests={3} superuserSurfaces />);
      // Proves the card CAN open in this render — otherwise the negative below is vacuous.
      fireEvent.focus(screen.getByTestId("admin-tab-matcha"));
      await screen.findByText(/Paste the ask\. Get the shortlist\./);
      // …and a tab that was passed no hover opens nothing. The wait is load-bearing: Radix opens
      // on a 200ms delay, so asserting absence synchronously would pass before any card COULD
      // have opened — which is exactly how the first version of this test was vacuous.
      fireEvent.focus(screen.getByTestId("admin-tab-slug-requests"));
      await new Promise((r) => setTimeout(r, 350));
      expect(screen.getAllByText(/Paste the ask\. Get the shortlist\./)).toHaveLength(1);
      vi.doUnmock("@/lib/api/matcha");
    });
  });
});
