import { describe, expect, it } from "vitest";

import { buildConsoleLinks } from "@/lib/auth/console-links";

/**
 * Policy for the account-menu's role-aware console entry points
 * (role-aware-navigation-entry-points-spec.md §5/§6). `buildConsoleLinks` is the
 * single source of *which* links a viewer sees; these cases pin the matrix.
 */
describe("buildConsoleLinks", () => {
  it("superuser → 'Admin console' only (the roster's AdminSubnav fans out to the rest)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: false,
      managesUnits: false,
      canBrowseScopedScholars: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin console", href: "/edit/scholars" },
    ]);
  });

  it("superuser → still only 'Admin console', even if also a steward / unit admin (no redundant rows)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: true,
      managesUnits: true,
      canBrowseScopedScholars: false,
    });
    expect(links.map((l) => l.id)).toEqual(["manage-profiles"]);
  });

  it("comms_steward (not a superuser) → 'Method families'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: true,
      managesUnits: false,
      canBrowseScopedScholars: false,
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
      canBrowseScopedScholars: false,
    });
    expect(links).toEqual([
      { id: "units", label: "Org units", href: "/edit/units" },
    ]);
  });

  // The prod complaint this row exists to answer: a department curator signed
  // in, saw ONLY "Org units", and reported they could not see the people they
  // are supposed to edit — though `/edit/data-quality` had been scoping several
  // hundred of them to that account the whole time, reachable only as a tab
  // inside /edit/units named "Data quality".
  it("unit Owner/Curator with the dashboard on → 'Scholars you can edit' BEFORE 'Org units'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: true,
      canBrowseScopedScholars: true,
    });
    expect(links).toEqual([
      { id: "scoped-scholars", label: "Scholars you can edit", href: "/edit/data-quality" },
      { id: "units", label: "Org units", href: "/edit/units" },
    ]);
  });

  it("dashboard flag off → no scoped-scholars row (the route would 404)", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: true,
      canBrowseScopedScholars: false,
    });
    expect(links.map((l) => l.id)).toEqual(["units"]);
  });

  it("superuser → still only 'Admin console', never a scoped-scholars row", () => {
    // A superuser's roster is the unscoped /edit/scholars; the scoped dashboard
    // would be a redundant, narrower door.
    const links = buildConsoleLinks({
      isSuperuser: true,
      canManageMethods: true,
      managesUnits: true,
      canBrowseScopedScholars: true,
    });
    expect(links.map((l) => l.id)).toEqual(["manage-profiles"]);
  });

  it("steward AND unit admin → both, methods before units", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: true,
      managesUnits: true,
      canBrowseScopedScholars: false,
    });
    expect(links.map((l) => l.id)).toEqual(["methods", "units"]);
  });

  it("plain scholar (no privileged role) → no console section", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      canManageMethods: false,
      managesUnits: false,
      canBrowseScopedScholars: false,
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
      canBrowseScopedScholars: false,
    });
    expect(links).toEqual([]);
  });

  // GrantRecs "Funding matcher" is NO LONGER a dropdown row — it moved into the
  // in-console AdminSubnav (`/edit/find-researchers`). The dropdown never carries it.
  it("never surfaces a find-researchers / Funding-matcher row, for any viewer", () => {
    const matrices = [
      { isSuperuser: true, canManageMethods: false, managesUnits: false, canBrowseScopedScholars: false },
      { isSuperuser: true, canManageMethods: true, managesUnits: true, canBrowseScopedScholars: true },
      { isSuperuser: false, canManageMethods: true, managesUnits: true, canBrowseScopedScholars: true },
    ];
    for (const v of matrices) {
      expect(buildConsoleLinks(v).some((l) => l.href === "/edit/find-researchers")).toBe(false);
    }
  });
});
