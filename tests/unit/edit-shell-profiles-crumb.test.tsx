/**
 * The `EditShell` superuser-mode sub-nav shows a "Profiles / {name}" crumb.
 * Before this fix the "Profiles" link was unconditional — correct for a
 * scholar profile (`isProfileEntity` defaults true, unchanged), wrong for a
 * unit editor (department/division/center/core), where a viewer with no
 * profile-browsing rights had a dead-end link to a roster they can't use.
 * `isProfileEntity={false}` + `canBrowseProfiles` now gate it: navigable
 * crumb when either holds, a flat non-navigable label when neither does.
 *
 * `AccountMenu` is a client component that fires an impersonation-probe fetch
 * on mount, so it's mocked out — this suite only exercises the shell's crumb.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/components/site/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/edit",
}));

import { EditShell } from "@/components/edit/edit-shell";

const base = {
  mode: "superuser" as const,
  scholarName: "Epigenomics",
  railItems: [],
  activeAttr: "details",
  basePath: "/edit/core/3",
};

describe("EditShell — Profiles crumb gating (superuser mode)", () => {
  it("scholar profile (default isProfileEntity=true): navigable crumb regardless of canBrowseProfiles", () => {
    render(
      <EditShell {...base} scholarName="Jane Doe" canBrowseProfiles={false}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-profiles");
    expect(link.getAttribute("href")).toBe("/edit/scholars");
    expect(within(crumb).getByText("Jane Doe").textContent).toBe("Jane Doe");
  });

  it("unit editor (isProfileEntity=false), viewer lacks canBrowseProfiles: flat label, no link", () => {
    render(
      <EditShell {...base} isProfileEntity={false} canBrowseProfiles={false}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });

  it("unit editor, viewer HAS canBrowseProfiles (real superuser): navigable crumb", () => {
    render(
      <EditShell {...base} isProfileEntity={false} canBrowseProfiles={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-profiles");
    expect(link.getAttribute("href")).toBe("/edit/scholars");
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });
});
