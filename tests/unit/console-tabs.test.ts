import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EditSession } from "@/lib/auth/superuser";
import { deriveConsoleTabs } from "@/lib/edit/console-tabs";

/**
 * The console-tab role-gate decision table (console-shell-migration-plan.md §
 * "role-gate decision table"). `deriveConsoleTabs` is the ONE place the AdminSubnav
 * role-gated props are computed; each block below is one row of the table, pinned
 * so a gate can never silently flip for a role again.
 *
 * All three tab flags are ON here so the ROLE logic is what's under test; the last
 * block flips them off to prove the flag gate still hides its tab even for a
 * superuser.
 */
function session(overrides: Partial<EditSession>): EditSession {
  return { cwid: "aaa0001", isSuperuser: false, isCommsSteward: false, ...overrides };
}

describe("deriveConsoleTabs — role-gate decision table", () => {
  beforeEach(() => {
    vi.stubEnv("SELF_EDIT_ADMINISTRATORS_TAB", "on");
    vi.stubEnv("COMMS_STEWARD_ENABLED", "on");
    vi.stubEnv("EDIT_DATA_QUALITY_DASHBOARD", "on");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("superuser — every surface", () => {
    expect(deriveConsoleTabs(session({ isSuperuser: true }))).toEqual({
      superuserSurfaces: true,
      profilesTab: false, // Profiles shows via superuserSurfaces; this stays comms-only
      unitsTab: true,
      administratorsTab: 0,
      methodsTab: 0,
      dataQualityTab: 0,
      viewerIsDeveloper: false,
    });
  });

  it("comms_steward (not superuser) — Profiles + Units + Methods + Data quality, NO superuser strip", () => {
    expect(deriveConsoleTabs(session({ isCommsSteward: true }))).toEqual({
      superuserSurfaces: false,
      profilesTab: true,
      unitsTab: true,
      administratorsTab: null, // superuser-only, even with the flag on
      methodsTab: 0,
      dataQualityTab: 0,
      viewerIsDeveloper: false,
    });
  });

  it("honors_curator (not superuser) — NO tabs from here (the honors-queue leak fix)", () => {
    // Today /edit/honors-queue passes superuserSurfaces=default(true), leaking the
    // whole superuser strip to a curator. Derived from the session, they get none.
    expect(deriveConsoleTabs(session({ isHonorsCurator: true }))).toEqual({
      superuserSurfaces: false,
      profilesTab: false,
      unitsTab: false,
      administratorsTab: null,
      methodsTab: null,
      dataQualityTab: null,
      viewerIsDeveloper: false,
    });
  });

  it("developer (not superuser) — only the Funding-matcher escape hatch", () => {
    expect(deriveConsoleTabs(session({ isDeveloper: true }))).toEqual({
      superuserSurfaces: false,
      profilesTab: false,
      unitsTab: false,
      administratorsTab: null,
      methodsTab: null,
      dataQualityTab: null,
      viewerIsDeveloper: true,
    });
  });

  it("plain self (no roles) — nothing", () => {
    expect(deriveConsoleTabs(session({}))).toEqual({
      superuserSurfaces: false,
      profilesTab: false,
      unitsTab: false,
      administratorsTab: null,
      methodsTab: null,
      dataQualityTab: null,
      viewerIsDeveloper: false,
    });
  });

  it("flags OFF — Administrators / Methods / Data quality hidden even for a superuser", () => {
    vi.stubEnv("SELF_EDIT_ADMINISTRATORS_TAB", "off");
    vi.stubEnv("COMMS_STEWARD_ENABLED", "off");
    vi.stubEnv("EDIT_DATA_QUALITY_DASHBOARD", "off");
    const tabs = deriveConsoleTabs(session({ isSuperuser: true }));
    expect(tabs.administratorsTab).toBeNull();
    expect(tabs.methodsTab).toBeNull();
    expect(tabs.dataQualityTab).toBeNull();
    // The unflagged role surfaces are unaffected.
    expect(tabs.superuserSurfaces).toBe(true);
    expect(tabs.unitsTab).toBe(true);
  });
});
