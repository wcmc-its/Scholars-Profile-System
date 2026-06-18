/**
 * `components/edit/admin-subnav.tsx` — the superuser admin sub-nav
 * (#497 PR-3c, `slug-personalization-ui-spec.md` § 3.1).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
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

  // role-aware-navigation-entry-points-spec.md — the strip now also renders on the
  // self-edit surface (active="self"), where "My Profile" is the active tab.
  it('active="self" renders "My Profile" as the active tab (not a back-link)', () => {
    render(<AdminSubnav active="self" pendingSlugRequests={null} methodsTab={0} />);
    const self = screen.getByTestId("admin-subnav-self-edit");
    expect(self.tagName.toLowerCase()).toBe("span"); // active = span, not a link
    expect(self.getAttribute("aria-current")).toBe("page");
    expect(self.getAttribute("href")).toBeNull();
    expect(self.textContent).toBe("My Profile");
  });

  it('active="self" for a superuser shows the full tab strip + My Profile active', () => {
    render(
      <AdminSubnav active="self" pendingSlugRequests={0} administratorsTab={0} methodsTab={0} />,
    );
    // All admin tabs are present and are links (none active — we're on self).
    for (const id of ["profiles", "slugs", "administrators", "methods"]) {
      const tab = screen.getByTestId(`admin-tab-${id}`);
      expect(tab.getAttribute("aria-current")).toBeNull();
    }
    expect(screen.getByTestId("admin-subnav-self-edit").getAttribute("aria-current")).toBe("page");
  });

  it('active="self" for a steward-only viewer shows only Method families + My Profile', () => {
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
    expect(screen.getByTestId("admin-subnav-self-edit").getAttribute("aria-current")).toBe("page");
  });

  it("renders the My-Profile back-link (a real link) when selfEditHref is set and not on self", () => {
    render(<AdminSubnav active="methods" pendingSlugRequests={null} methodsTab={0} selfEditHref="/edit" />);
    const self = screen.getByTestId("admin-subnav-self-edit");
    expect(self.tagName.toLowerCase()).toBe("a");
    expect(self.getAttribute("href")).toBe("/edit");
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
});
