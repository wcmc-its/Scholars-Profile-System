/**
 * The `EditShell` superuser-mode sub-nav shows a "Profiles / {name}" crumb.
 * Before the first fix the "Profiles" link was unconditional — correct for a
 * scholar profile (`isProfileEntity` defaults true, unchanged), wrong for a
 * unit editor (department/division/center/core), where it was a dead-end
 * link to a roster the page has nothing to do with.
 *
 * `isProfileEntity` alone now gates it — page identity, not the viewer's own
 * rights: navigable "Profiles / {name}" only when actually viewing a scholar
 * profile; a flat, non-navigable label for a unit editor regardless of
 * whether the viewer happens to be a real superuser (per explicit feedback:
 * "No < Profiles unless user is in a profile" — a unit owner/curator with
 * broad profile-editing rights elsewhere STILL has nowhere for "Profiles" to
 * go FROM a unit page, so `canBrowseProfiles` no longer factors into this
 * branch at all; it stays self-mode-only for the "All profiles" link).
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
  it("scholar profile (default isProfileEntity=true): navigable crumb", () => {
    render(
      <EditShell {...base} scholarName="Jane Doe">
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-profiles");
    expect(link.getAttribute("href")).toBe("/edit/scholars");
    expect(within(crumb).getByText("Jane Doe").textContent).toBe("Jane Doe");
  });

  it("unit editor (isProfileEntity=false): flat label, no link", () => {
    render(
      <EditShell {...base} isProfileEntity={false}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });

  it("unit editor stays flat even for a real superuser — canBrowseProfiles no longer overrides page identity", () => {
    render(
      <EditShell {...base} isProfileEntity={false} canBrowseProfiles={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });
});
