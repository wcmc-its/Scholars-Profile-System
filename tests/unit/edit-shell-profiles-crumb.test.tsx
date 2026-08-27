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

/**
 * dwd2001 bug #7: a unit editor's flat label was a structural dead end — the
 * only way back to the unit's own roster was the browser's Back button. A
 * unit editor now gets a navigable "Org units / {name}" crumb, gated on
 * `orgUnitsNavVisible` (the caller's own `TAB_PREDICATES.units` result — true
 * for a superuser, a comms_steward, or any viewer with a `manageableUnitCount
 * > 0` grant; false is the rare case where a role reaches a unit page with no
 * real grant behind it). The user's explicit constraint holds throughout:
 * every link here is a fixed href (`/edit/units`), never `history.back()`.
 */
describe("EditShell — Org units crumb gating (unit editor pages)", () => {
  it("a superuser on a center editor sees a navigable 'Org units' crumb", () => {
    render(
      <EditShell {...base} isProfileEntity={false} orgUnitsNavVisible={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-units");
    expect(link.getAttribute("href")).toBe("/edit/units");
    expect(link.textContent).toContain("Org units");
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });

  it("a comms_steward's units-tab grant (same orgUnitsNavVisible=true the caller computes) also renders the link", () => {
    // EditShell itself only ever sees the resolved boolean — the caller
    // (department/division/center/core page) is what runs
    // `loadConsoleTabs(session, db.read).units`, which is `true` for a
    // comms_steward via `TAB_PREDICATES.units`'s `s.isCommsSteward` arm.
    render(
      <EditShell {...base} isProfileEntity={false} orgUnitsNavVisible={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByTestId("edit-subnav-units").getAttribute("href")).toBe("/edit/units");
  });

  it("orgUnitsNavVisible=false (or omitted) keeps the flat label — no link, no history.back", () => {
    render(
      <EditShell {...base} isProfileEntity={false} orgUnitsNavVisible={false}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-units")).toBeNull();
    expect(within(crumb).queryByRole("link")).toBeNull();
    expect(within(crumb).getByText("Epigenomics").textContent).toBe("Epigenomics");
  });

  it("a scholar profile page (isProfileEntity=true) ignores orgUnitsNavVisible entirely", () => {
    render(
      <EditShell {...base} scholarName="Jane Doe" orgUnitsNavVisible={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-units")).toBeNull();
    expect(within(crumb).getByTestId("edit-subnav-profiles").getAttribute("href")).toBe(
      "/edit/scholars",
    );
  });
});

/**
 * dwd2001 bug #7 (unit-admin half): a unit admin editing a scholar had the
 * same permanent flat label as proxy mode, even though a unit admin has a
 * real roster to go back to. `profilesNavVisible` unifies this with the
 * superuser "Profiles / {name}" crumb rather than duplicating it — same
 * href, same shape, same fixed-href discipline (no `history.back()`).
 */
describe("EditShell — Profiles crumb gating (unit-admin mode)", () => {
  const unitAdminBase = {
    mode: "unit-admin" as const,
    scholarName: "Alex Rivera",
    railItems: [],
    activeAttr: "details",
    basePath: "/edit/scholar/a123",
  };

  it("a unit admin whose grant admits profilesNavVisible sees a navigable 'Profiles' crumb", () => {
    render(
      <EditShell {...unitAdminBase} profilesNavVisible={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const link = within(crumb).getByTestId("edit-subnav-profiles");
    expect(link.getAttribute("href")).toBe("/edit/scholars");
    expect(within(crumb).getByText("Alex Rivera").textContent).toBe("Alex Rivera");
  });

  it("profilesNavVisible=false (or omitted) keeps the unit-admin flat label", () => {
    render(
      <EditShell {...unitAdminBase} profilesNavVisible={false}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByTestId("edit-subnav-unit-admin").textContent).toBe("Alex Rivera");
  });

  it("a proxy editor stays flat even with profilesNavVisible=true — a proxy grant names no roster", () => {
    render(
      <EditShell {...unitAdminBase} mode="proxy" profilesNavVisible={true}>
        <div>panel</div>
      </EditShell>,
    );
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).queryByTestId("edit-subnav-profiles")).toBeNull();
    expect(within(crumb).getByTestId("edit-subnav-proxy").textContent).toBe("Alex Rivera");
  });
});
