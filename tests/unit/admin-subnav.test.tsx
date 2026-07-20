/**
 * `components/edit/admin-subnav.tsx` — the superuser admin sub-nav
 * (#497 PR-3c, `slug-personalization-ui-spec.md` § 3.1).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
    render(<AdminSubnav active="profiles" pendingSlugRequests={3} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.getByTestId("admin-tab-slug-requests")).toBeTruthy();
    expect(screen.getByTestId("admin-subnav-pending-count").textContent).toBe("3");
  });

  it("marks the active tab with aria-current and links the inactive one", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={1} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-profiles").getAttribute("aria-current")).toBe("page");
    // The inactive tab is a link to its surface.
    expect(screen.getByTestId("admin-tab-slug-requests").getAttribute("href")).toBe(
      "/edit/slug-requests",
    );
  });

  it("hides the URL-requests tab when the feature is off (pendingSlugRequests null)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-profiles")).toBeTruthy();
    expect(screen.queryByTestId("admin-tab-slug-requests")).toBeNull();
  });

  it("always shows the Slug-registry tab — even when the URL-requests tab is hidden", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    const tab = screen.getByTestId("admin-tab-slugs");
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("href")).toBe("/edit/slugs");
    // it stays visible even when the slug-request feature is on too
    render(<AdminSubnav active="profiles" pendingSlugRequests={3} pendingHonors={null} />);
    expect(screen.getAllByTestId("admin-tab-slugs").length).toBeGreaterThan(0);
  });

  it("marks the Slug-registry tab active with aria-current", () => {
    render(<AdminSubnav active="slugs" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-slugs").getAttribute("aria-current")).toBe("page");
  });

  it("omits the count pill when zero pending", () => {
    render(<AdminSubnav active="slug-requests" pendingSlugRequests={0} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-slug-requests").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("hides the Administrators tab when administratorsTab is null", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} administratorsTab={null} />);
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
  });

  it("hides the Administrators tab when administratorsTab is omitted (undefined)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.queryByTestId("admin-tab-administrators")).toBeNull();
  });

  it("shows the Administrators tab when administratorsTab is 0 (no badge)", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} administratorsTab={0} />);
    const tab = screen.getByTestId("admin-tab-administrators");
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("href")).toBe("/edit/administrators");
    // 0 is a count, not a badge — the pill only renders for count > 0.
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Administrators tab active with aria-current", () => {
    render(
      <AdminSubnav active="administrators" pendingSlugRequests={null} pendingHonors={null} administratorsTab={0} />,
    );
    expect(screen.getByTestId("admin-tab-administrators").getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("hides the Method families tab when methodsTab is null/omitted", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} methodsTab={null} />);
    expect(screen.queryByTestId("admin-tab-methods")).toBeNull();
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.queryByTestId("admin-tab-methods")).toBeNull();
  });

  it("shows the Method families tab (linking /edit/methods) when methodsTab is 0", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} methodsTab={0} />);
    const tab = screen.getByTestId("admin-tab-methods");
    expect(tab.getAttribute("href")).toBe("/edit/methods");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Method families tab active with aria-current", () => {
    render(<AdminSubnav active="methods" pendingSlugRequests={null} pendingHonors={null} methodsTab={0} />);
    expect(screen.getByTestId("admin-tab-methods").getAttribute("aria-current")).toBe("page");
  });

  it("shows the Funding matcher tab on every superuser surface (rides superuserSurfaces)", () => {
    // Default superuserSurfaces=true (a superuser-only page like Profiles).
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.getByTestId("admin-tab-find-researchers").getAttribute("href")).toBe(
      "/edit/find-researchers",
    );
  });

  it("hides the Funding matcher tab for a non-superuser, non-developer (comms_steward)", () => {
    render(
      <AdminSubnav active="methods" pendingSlugRequests={null} pendingHonors={null} methodsTab={0} superuserSurfaces={false} />,
    );
    expect(screen.queryByTestId("admin-tab-find-researchers")).toBeNull();
  });

  it("shows the Funding matcher tab to a pure dev-role viewer via viewerIsDeveloper", () => {
    render(
      <AdminSubnav
        active="find-researchers"
        pendingSlugRequests={null} pendingHonors={null}
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
        pendingSlugRequests={3} pendingHonors={null}
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
    render(<AdminSubnav active="self" pendingSlugRequests={null} pendingHonors={null} methodsTab={0} />);
    expect(screen.queryByTestId("admin-subnav-self-edit")).toBeNull();
    const stub = screen.getByTestId("account-menu-stub");
    expect(stub.getAttribute("data-context")).toBe("console");
    // The console tabs themselves are unaffected.
    expect(screen.getByTestId("admin-tab-methods")).toBeTruthy();
  });

  it('active="self" for a superuser shows the full tab strip (no tab active)', () => {
    render(
      <AdminSubnav active="self" pendingSlugRequests={0} pendingHonors={null} administratorsTab={0} methodsTab={0} />,
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
        pendingSlugRequests={null} pendingHonors={null}
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
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} dataQualityTab={null} />);
    expect(screen.queryByTestId("admin-tab-data-quality")).toBeNull();
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.queryByTestId("admin-tab-data-quality")).toBeNull();
  });

  it("shows the Data quality tab (linking /edit/data-quality) when dataQualityTab is 0", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} dataQualityTab={0} />);
    const tab = screen.getByTestId("admin-tab-data-quality");
    expect(tab.getAttribute("href")).toBe("/edit/data-quality");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("marks the Data quality tab active with aria-current", () => {
    render(<AdminSubnav active="data-quality" pendingSlugRequests={null} pendingHonors={null} dataQualityTab={0} />);
    expect(screen.getByTestId("admin-tab-data-quality").getAttribute("aria-current")).toBe("page");
  });

  // A unit Owner/Curator (superuserSurfaces=false) still gets Data quality scoped
  // to their units — the `/edit/units` page passes dataQualityTab on grants.
  it("shows Data quality for a non-superuser when dataQualityTab is set", () => {
    render(
      <AdminSubnav
        active="units"
        pendingSlugRequests={null} pendingHonors={null}
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
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} profilesTab unitsTab />);
    expect(screen.getByTestId("admin-tab-units").getAttribute("href")).toBe("/edit/units");
  });

  it("hides the Units tab when unitsTab is false/omitted", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} superuserSurfaces />);
    expect(screen.queryByTestId("admin-tab-units")).toBeNull();
  });

  it('marks the Units tab active with aria-current when active="units"', () => {
    render(<AdminSubnav active="units" pendingSlugRequests={null} pendingHonors={null} unitsTab />);
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
      render(<Subnav active="profiles" pendingSlugRequests={null} pendingHonors={null} superuserSurfaces />);
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
      render(<Subnav active="profiles" pendingSlugRequests={null} pendingHonors={null} superuserSurfaces />);
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
      render(<Subnav active="profiles" pendingSlugRequests={3} pendingHonors={null} superuserSurfaces />);
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

describe("AdminSubnav — the Honors tab (#1762)", () => {
  it("shows the tab without a pending-count badge (round 4)", () => {
    // #1762 round 4: the curator asked to drop the pending count from the tab.
    // The tab still renders (and `pendingHonors` still gates its visibility), but
    // no count pill — so a non-null count no longer paints a number.
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={7} />);
    const tab = screen.getByTestId("admin-tab-honors-queue");
    expect(tab).toBeTruthy();
    expect(tab.getAttribute("href")).toBe("/edit/honors-queue");
    expect(tab.textContent).not.toContain("7");
    expect(screen.queryByTestId("admin-subnav-pending-count")).toBeNull();
  });

  it("hides the tab when the count is null", () => {
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={null} />);
    expect(screen.queryByTestId("admin-tab-honors-queue")).toBeNull();
  });

  it("🔴 shows the tab to a NON-superuser honors_curator", () => {
    // The regression this pins: the tab was gated on `superuserSurfaces &&`, which
    // is false for a curator — so the Honors tab rendered only for superusers, and
    // (because the prop was optional and defaulted to null) only on the Honors page
    // itself. The Research Dean's office could reach their own queue solely by
    // typing the URL. That is #1767's "an honors surface nobody could find",
    // verbatim. The caller decides visibility by passing a count vs null; this
    // component must not second-guess it with a superuser check.
    render(
      <AdminSubnav
        active="profiles"
        superuserSurfaces={false}
        profilesTab
        pendingSlugRequests={null}
        pendingHonors={3}
      />,
    );
    expect(screen.queryByTestId("admin-tab-honors-queue")).toBeTruthy();
  });

  it("still hides the URL-requests tab from a non-superuser", () => {
    // The counterpart: the slug tab genuinely IS superuser-only, so dropping
    // `superuserSurfaces` from the honors tab must not have leaked to its
    // neighbour.
    render(
      <AdminSubnav
        active="profiles"
        superuserSurfaces={false}
        profilesTab
        pendingSlugRequests={4}
        pendingHonors={3}
      />,
    );
    expect(screen.queryByTestId("admin-tab-slug-requests")).toBeNull();
  });

  it("renders a zero count rather than hiding an empty queue", () => {
    // 0 is not null: an empty queue is a real, reachable state and the tab must
    // stay put, or a curator with nothing to do concludes the surface vanished.
    render(<AdminSubnav active="profiles" pendingSlugRequests={null} pendingHonors={0} />);
    expect(screen.queryByTestId("admin-tab-honors-queue")).toBeTruthy();
  });
});

// ── Two-tier grouping, behind CONSOLE_SUBNAV_GROUPED ────────────────────────
//
// `docs/2026-07-20-console-subnav-two-tier-spec.md`. The flag defaults OFF, so
// every assertion ABOVE this block is now also the regression pin for the
// flag-off path: the visibility refactor (inline JSX guards → one computed list)
// had to leave that DOM byte-identical, and 35 untouched tests say it did.
//
// Each flag here is stubbed rather than left to the ambient env. That is the
// lesson of the Matcha block above: `isMatchaEnabled()` reads env, so a suite
// that leaves it ambient asserts against a tab that is simply absent, and passes
// in both directions.
describe("AdminSubnav — two-tier grouping (CONSOLE_SUBNAV_GROUPED)", () => {
  afterEach(() => vi.unstubAllEnvs());

  /** Everything a full superuser sees: all 14 tabs visible, all four groups populated. */
  const allOn = {
    pendingSlugRequests: 2,
    pendingHonors: 0,
    administratorsTab: 0,
    methodsTab: 0,
    dataQualityTab: 0,
    unitsTab: true,
  } as const;

  function grouped() {
    vi.stubEnv("CONSOLE_SUBNAV_GROUPED", "on");
    vi.stubEnv("NEWS_APPROVAL_QUEUE", "on");
    vi.stubEnv("CORE_PAGES", "on");
    vi.stubEnv("MATCHA", "on");
  }

  it("collapses 14 tabs into a 6-item tier 1", () => {
    grouped();
    render(<AdminSubnav active="profiles" {...allOn} />);
    // Profiles + Org units stay top-level; the other twelve become four groups.
    for (const id of ["profiles", "units"]) expect(screen.getByTestId(`admin-tab-${id}`)).toBeTruthy();
    for (const g of ["queues", "registries", "insights", "tools"])
      expect(screen.getByTestId(`admin-group-${g}`)).toBeTruthy();
    // …and the grouped members are NOT in tier 1 — no group is active here, so
    // they are not in the DOM at all. This is the assertion that would fail if
    // grouping silently rendered both tiers flat.
    for (const id of ["slug-requests", "slugs", "usage", "matcha", "cores", "activity"])
      expect(screen.queryByTestId(`admin-tab-${id}`)).toBeNull();
  });

  it("links a group entry to its first visible member's existing href — no route moved", () => {
    grouped();
    render(<AdminSubnav active="profiles" {...allOn} />);
    // Queues' first visible member is URL requests. A group entry is a plain
    // <Link>, never a hover menu or a button (#1783).
    expect(screen.getByTestId("admin-group-queues").getAttribute("href")).toBe("/edit/slug-requests");
    expect(screen.getByTestId("admin-group-registries").getAttribute("href")).toBe("/edit/slugs");
    expect(screen.getByTestId("admin-group-insights").getAttribute("href")).toBe("/edit/data-quality");
    expect(screen.getByTestId("admin-group-tools").getAttribute("href")).toBe("/edit/find-researchers");
  });

  it("derives the active group correctly for every grouped id", () => {
    // The map is the whole mechanism — a mis-slotted id sends the wrong group
    // maroon and strands the member in a tier 2 nobody can open.
    const expected: Record<string, string> = {
      "slug-requests": "queues", "honors-queue": "queues", "news-queue": "queues", cores: "queues",
      slugs: "registries", administrators: "registries", methods: "registries",
      "data-quality": "insights", activity: "insights", usage: "insights",
      "find-researchers": "tools", matcha: "tools",
    };
    for (const [id, group] of Object.entries(expected)) {
      grouped();
      const { unmount } = render(<AdminSubnav active={id as never} {...allOn} />);
      expect(screen.getByTestId(`admin-group-${group}`).getAttribute("aria-current")).toBe("page");
      // the member itself is reachable in tier 2, and only there
      expect(screen.getByTestId(`admin-subnav-tier2-${group}`)).toBeTruthy();
      expect(screen.getByTestId(`admin-tab-${id}`).getAttribute("aria-current")).toBe("page");
      unmount();
      vi.unstubAllEnvs();
    }
  });

  it("renders tier 2 with exactly the active group's visible members", () => {
    grouped();
    render(<AdminSubnav active="slugs" {...allOn} />);
    const tier2 = screen.getByTestId("admin-subnav-tier2-registries");
    for (const id of ["slugs", "administrators", "methods"])
      expect(tier2.querySelector(`[data-testid="admin-tab-${id}"]`)).toBeTruthy();
    // a member of a DIFFERENT group is not smuggled in
    expect(tier2.querySelector('[data-testid="admin-tab-usage"]')).toBeNull();
  });

  it('active="self" renders tier 1 only — no tier 2 row', () => {
    grouped();
    render(<AdminSubnav active="self" {...allOn} />);
    expect(screen.getByTestId("admin-group-queues")).toBeTruthy();
    for (const g of ["queues", "registries", "insights", "tools"])
      expect(screen.queryByTestId(`admin-subnav-tier2-${g}`)).toBeNull();
    expect(screen.getByTestId("account-menu-stub")).toBeTruthy();
  });

  it("omits a group entirely when all its members are hidden", () => {
    grouped();
    // A comms_steward: no superuser surfaces, no admin/data-quality props ⇒
    // Registries loses URL registry + Administrators, Insights loses everything.
    render(
      <AdminSubnav
        active="profiles"
        pendingSlugRequests={null}
        pendingHonors={null}
        methodsTab={0}
        superuserSurfaces={false}
        profilesTab
      />,
    );
    expect(screen.queryByTestId("admin-group-insights")).toBeNull();
    expect(screen.queryByTestId("admin-tab-data-quality")).toBeNull();
    expect(screen.queryByTestId("admin-tab-usage")).toBeNull();
  });

  // Single-member promotion. Narrow roles are the common case here, and without
  // this each one's entire console becomes a two-click funnel through a group
  // wrapper that only ever contains the one tab they can reach.
  describe("single-member promotion", () => {
    it("honors_curator → Queues={Honors} renders Honors directly in tier 1", () => {
      grouped();
      render(
        <AdminSubnav active="honors-queue" pendingSlugRequests={null} pendingHonors={3} superuserSurfaces={false} />,
      );
      const tab = screen.getByTestId("admin-tab-honors-queue");
      expect(tab.getAttribute("aria-current")).toBe("page");
      expect(screen.queryByTestId("admin-group-queues")).toBeNull();
      expect(screen.queryByTestId("admin-subnav-tier2-queues")).toBeNull();
    });

    it("comms_steward → News and Method families both promoted, under their own labels", () => {
      grouped();
      render(
        <AdminSubnav
          active="news-queue"
          pendingSlugRequests={null}
          pendingHonors={null}
          methodsTab={0}
          superuserSurfaces={false}
          profilesTab
          unitsTab
        />,
      );
      expect(screen.getByTestId("admin-tab-news-queue").textContent).toContain("News");
      expect(screen.getByTestId("admin-tab-methods").textContent).toContain("Method families");
      expect(screen.queryByTestId("admin-group-queues")).toBeNull();
      expect(screen.queryByTestId("admin-group-registries")).toBeNull();
    });

    it("non-superuser unit admin → Insights={Usage} promoted", () => {
      grouped();
      render(
        <AdminSubnav
          active="usage"
          pendingSlugRequests={null}
          pendingHonors={null}
          superuserSurfaces={false}
          unitsTab
          usageTab
        />,
      );
      expect(screen.getByTestId("admin-tab-usage").getAttribute("aria-current")).toBe("page");
      expect(screen.queryByTestId("admin-group-insights")).toBeNull();
    });

    it("dev-role viewer → Tools={Funding matcher} promoted while MATCHA is off, grouped when on", () => {
      vi.stubEnv("CONSOLE_SUBNAV_GROUPED", "on");
      const props = {
        active: "find-researchers",
        pendingSlugRequests: null,
        pendingHonors: null,
        superuserSurfaces: false,
        viewerIsDeveloper: true,
      } as const;
      const { unmount } = render(<AdminSubnav {...props} />);
      expect(screen.getByTestId("admin-tab-find-researchers").textContent).toContain("Funding matcher");
      expect(screen.queryByTestId("admin-group-tools")).toBeNull();
      unmount();
      // Flipping MATCHA on gives Tools a second member, so the group appears.
      vi.stubEnv("MATCHA", "on");
      render(<AdminSubnav {...props} />);
      expect(screen.getByTestId("admin-group-tools").getAttribute("aria-current")).toBe("page");
      expect(screen.getByTestId("admin-subnav-tier2-tools")).toBeTruthy();
    });
  });

  // 🔴 #1783. Matcha's tab carries a Radix HoverCard and must stay the CLIENT
  // `MatchaTab` on both tiers. Composing Radix inside this server component
  // silently dropped the tab once — a 200 with no error, which jsdom cannot see.
  // A render-only assertion would miss it too, so this opens the card.
  it("keeps Matcha a client MatchaTab inside tier 2 — the #1783 guard", async () => {
    grouped();
    // Active on Matcha's SIBLING, so Matcha is the inactive variant — a <Link>.
    // An active tab renders as an aria-current <span> with no href, which would
    // make the href assertion below vacuously unfalsifiable.
    render(<AdminSubnav active="find-researchers" {...allOn} />);
    const tab = screen.getByTestId("admin-tab-matcha");
    expect(tab.getAttribute("href")).toBe("/edit/matcha");
    expect(screen.getByTestId("admin-subnav-tier2-tools").contains(tab)).toBe(true);
    fireEvent.focus(tab);
    expect(await screen.findByText(/Paste the ask\. Get the shortlist\./)).toBeTruthy();
  });

  // Order is spec-pinned twice — the tier-1 bar as `Profiles · Org units · Queues ·
  // Registries · Insights · Tools`, and "member order within each group preserves
  // today's left-to-right bar order, except Cores". On origin/master that order was
  // implicit in a single JSX literal; grouping introduces TWO new independent
  // sources for it (GROUP_ORDER, and the tier-1 spread composition), and every
  // other assertion in this file locates nodes by testid, so an order-only edit
  // would move the console nav off spec with the whole suite green. jsdom cannot
  // verify layout, but DOM sequence is not layout — it observes that exactly.
  const order = (container: HTMLElement) =>
    Array.from(
      container.querySelectorAll("[data-testid^='admin-tab-'], [data-testid^='admin-group-']"),
    ).map((n) => n.getAttribute("data-testid"));

  it("renders tier 1 in the spec's order", () => {
    grouped();
    render(<AdminSubnav active="profiles" {...allOn} />);
    expect(order(screen.getByTestId("admin-subnav-tier1"))).toEqual([
      "admin-tab-profiles",
      "admin-tab-units",
      "admin-group-queues",
      "admin-group-registries",
      "admin-group-insights",
      "admin-group-tools",
    ]);
  });

  it("renders tier-2 members in today's left-to-right bar order, with Cores moved into Queues", () => {
    grouped();
    const { unmount } = render(<AdminSubnav active="slug-requests" {...allOn} />);
    expect(order(screen.getByTestId("admin-subnav-tier2-queues"))).toEqual([
      "admin-tab-slug-requests",
      "admin-tab-honors-queue",
      "admin-tab-news-queue",
      "admin-tab-cores",
    ]);
    unmount();
    render(<AdminSubnav active="slugs" {...allOn} />);
    expect(order(screen.getByTestId("admin-subnav-tier2-registries"))).toEqual([
      "admin-tab-slugs",
      "admin-tab-administrators",
      "admin-tab-methods",
    ]);
  });

  it("is dark by default — the flag off reproduces the flat 14-tab strip", () => {
    vi.stubEnv("NEWS_APPROVAL_QUEUE", "on");
    vi.stubEnv("CORE_PAGES", "on");
    render(<AdminSubnav active="profiles" {...allOn} />);
    expect(order(screen.getByTestId("admin-subnav-tier1"))).toEqual(
      [
        "profiles", "units", "slug-requests", "honors-queue", "news-queue", "slugs",
        "administrators", "methods", "data-quality", "activity", "usage", "cores",
        "find-researchers",
      ].map((id) => `admin-tab-${id}`),
    );
    for (const g of ["queues", "registries", "insights", "tools"])
      expect(screen.queryByTestId(`admin-group-${g}`)).toBeNull();
  });
});
