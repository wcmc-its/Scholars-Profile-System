import { describe, expect, it } from "vitest";

import { buildConsoleLinks } from "@/lib/auth/console-links";

/**
 * Policy for the account-menu's role-aware console entry points
 * (role-aware-navigation-entry-points-spec.md §5/§6). `buildConsoleLinks` is the
 * single source of *which* links a viewer sees; these cases pin the matrix.
 */
describe("buildConsoleLinks", () => {
  it("superuser → 'Manage profiles' only (the roster's AdminSubnav fans out to the rest)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Manage profiles", href: "/edit/scholars" },
    ]);
  });

  it("superuser → still only 'Manage profiles', even if also a steward / unit admin (no redundant rows)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: true,
      managesUnits: true,
    });
    expect(links.map((l) => l.id)).toEqual(["manage-profiles"]);
  });

  it("comms_steward (not a superuser) → 'Method Families'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: true,
      managesUnits: false,
    });
    expect(links).toEqual([
      { id: "methods", label: "Method Families", href: "/edit/methods" },
    ]);
  });

  it("unit Owner/Curator (not a superuser) → 'Units you manage'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: true,
    });
    expect(links).toEqual([
      { id: "units", label: "Units you manage", href: "/edit/units" },
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

  it("steward with the flag off (canManageMethods already folds in COMMS_STEWARD_ENABLED) → no Method Families", () => {
    // The route passes `isMethodsTabVisible(...)`, which is false when the flag
    // is off — so a dark deployment advertises nothing even to a real steward.
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: false,
    });
    expect(links).toEqual([]);
  });
});
