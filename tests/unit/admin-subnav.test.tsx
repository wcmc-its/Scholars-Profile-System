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
});
