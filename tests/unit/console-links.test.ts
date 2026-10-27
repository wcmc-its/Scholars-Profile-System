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
      isCommsSteward: false,
      managesUnits: false,
      isDeveloper: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin console", href: "/edit/profiles" },
    ]);
  });

  it("superuser → still only 'Admin console', even if also a steward / unit admin (no redundant rows)", () => {
    const links = buildConsoleLinks({
      isSuperuser: true,
      isCommsSteward: true,
      managesUnits: true,
      isDeveloper: false,
    });
    expect(links.map((l) => l.id)).toEqual(["manage-profiles"]);
  });

  // A comms_steward now collapses the SAME way a superuser does — a dedicated
  // "Method Families" dropdown row would be a redundant second door to the same
  // console entry point, since the steward's own AdminSubnav already fans out
  // to Method Families once they're inside.
  it("comms_steward (not a superuser) → 'Admin console', same collapse as a superuser", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      isCommsSteward: true,
      managesUnits: false,
      isDeveloper: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin console", href: "/edit/profiles" },
    ]);
  });

  // I3 — monotonicity: gaining a unit grant must never REMOVE the Admin
  // console row a steward already has. The sensible union here is the same
  // collapse, not an additive Profiles/Org-units pair alongside it — a unit
  // admin grant adds no reachable surface a steward's roster access doesn't
  // already cover (B3 scope is irrelevant once the viewer is global).
  it("comms_steward AND unit admin → still just 'Admin console' (I3: unit grant does not remove the row)", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      isCommsSteward: true,
      managesUnits: true,
      isDeveloper: false,
    });
    expect(links).toEqual([
      { id: "manage-profiles", label: "Admin console", href: "/edit/profiles" },
    ]);
  });

  // The prod complaint these rows exist to answer: a department curator signed
  // in, saw ONLY "Org units", and reported they could not see the people they
  // are supposed to edit. `/edit/profiles` is the roster that answers that, and
  // it is named "Profiles" for every role — so the row, the tab, and the page
  // heading all agree.
  it("unit Owner/Curator (not a superuser, not a steward) → 'Profiles' BEFORE 'Org units'", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      isCommsSteward: false,
      managesUnits: true,
      isDeveloper: false,
    });
    expect(links).toEqual([
      { id: "profiles", label: "Profiles", href: "/edit/profiles" },
      { id: "units", label: "Org units", href: "/edit/units" },
    ]);
  });

  it("plain scholar (no privileged role) → no console section", () => {
    const links = buildConsoleLinks({
      isSuperuser: false,
      isCommsSteward: false,
      managesUnits: false,
      isDeveloper: false,
    });
    expect(links).toEqual([]);
  });

  // 2026-10-27: a developer with no other role saw an empty dropdown.
  it("developer (not a superuser) → 'Matcha', alongside any other role's rows", () => {
    expect(
      buildConsoleLinks({ isSuperuser: false, isCommsSteward: false, managesUnits: false, isDeveloper: true }),
    ).toEqual([{ id: "matcha", label: "Matcha", href: "/edit/matcha" }]);
    expect(
      buildConsoleLinks({ isSuperuser: false, isCommsSteward: true, managesUnits: false, isDeveloper: true }).map(
        (l) => l.id,
      ),
    ).toEqual(["manage-profiles", "matcha"]);
  });

  it("superuser who is also a developer → still only 'Admin console'", () => {
    expect(
      buildConsoleLinks({ isSuperuser: true, isCommsSteward: false, managesUnits: false, isDeveloper: true }).map(
        (l) => l.id,
      ),
    ).toEqual(["manage-profiles"]);
  });
});
