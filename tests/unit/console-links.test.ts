import { describe, expect, it } from "vitest";

import { buildConsoleLinks } from "@/lib/auth/console-links";

/**
 * Policy for the account-menu's role-aware console entry points
 * (role-aware-navigation-entry-points-spec.md §5/§6). `buildConsoleLinks` is the
 * single source of *which* links a viewer sees; these cases pin the matrix.
 */
describe("buildConsoleLinks", () => {
  it("superuser → 'Admin' only (the roster's AdminSubnav fans out to the rest)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin", href: "/edit/scholars" },
    ]);
  });

  it("superuser → still only 'Admin', even if also a steward / unit admin (no redundant rows)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: true,
      managesUnits: true,
    });
    expect(links.map((l) => l.id)).toEqual(["manage-profiles"]);
  });

  it("comms_steward (not a superuser) → 'Method families'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: true,
      managesUnits: false,
    });
    expect(links).toEqual([
      { id: "methods", label: "Method families", href: "/edit/methods" },
    ]);
  });

  it("unit Owner/Curator (not a superuser) → 'Org units'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: true,
    });
    expect(links).toEqual([
      { id: "units", label: "Org units", href: "/edit/units" },
    ]);
  });

  it("steward AND unit admin → both, methods before units", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: true,
      managesUnits: true,
    });
    expect(links.map((l) => l.id)).toEqual(["methods", "units"]);
  });

  it("plain scholar (no privileged role) → no console section", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links).toEqual([]);
  });

  it("steward with the flag off (canManageMethods already folds in COMMS_STEWARD_ENABLED) → no Method families", () => {
    // The route passes `isMethodsTabVisible(...)`, which is false when the flag
    // is off — so a dark deployment advertises nothing even to a real steward.
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links).toEqual([]);
  });

  // GrantRecs "Funding matcher" is NO LONGER a dropdown row — it moved into the
  // in-console AdminSubnav (`/edit/find-researchers`). The dropdown never carries it.
  it("never surfaces a find-researchers / Funding-matcher row, for any viewer", () => {
    const matrices = [
      { isSuperuser: true, canManageMethods: false, managesUnits: false },
      { isSuperuser: true, canManageMethods: true, managesUnits: true },
      { isSuperuser: false, canManageMethods: true, managesUnits: true },
    ];
    for (const v of matrices) {
      expect(buildConsoleLinks(v).some((l) => l.href === "/edit/find-researchers")).toBe(false);
    }
  });

  // account-dropdown-nav handoff, Workstream B — the ACCOUNT_CONSOLE_NAV_RESTRUCTURE
  // flag relabels the superuser roster row; ids / hrefs / gating are unchanged.
  it("unifiedNav → 'Admin' becomes 'Admin console'", () => {
    const links = buildConsoleLinks(
      { isSuperuser: true, canManageMethods: false, managesUnits: false },
      { unifiedNav: true },
    );
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin console", href: "/edit/scholars" },
    ]);
  });

  it("unifiedNav leaves the Method families / Org units labels unchanged", () => {
    const links = buildConsoleLinks(
      { isSuperuser: false, canManageMethods: true, managesUnits: true },
      { unifiedNav: true },
    );
    expect(links).toEqual([
      { id: "methods", label: "Method families", href: "/edit/methods" },
      { id: "units", label: "Org units", href: "/edit/units" },
    ]);
  });

  it("unifiedNav omitted → classic labels (flag off / prod default)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links.map((l) => l.label)).toEqual(["Admin"]);
  });
});
