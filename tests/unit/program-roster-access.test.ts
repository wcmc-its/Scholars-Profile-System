/**
 * The internal program roster's gate (`lib/edit/program-roster-access.ts`).
 * Sensitive: everything that is not "flag on AND (superuser OR
 * program_roster_editor)" is denied, and no write runs under "View as".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { canEditProgramRoster, canViewProgramRoster } from "@/lib/edit/program-roster-access";

const NONE = { isSuperuser: false };
const EDITOR = { isSuperuser: false, isProgramRosterEditor: true };
const SUPER = { isSuperuser: true };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("EDIT_PROGRAM_ROSTER", "on");
});

describe("program roster access", () => {
  it.each([["superuser", SUPER], ["program_roster_editor", EDITOR]])("%s sees and edits it", (_n, s) => {
    expect(canViewProgramRoster(s)).toBe(true);
    expect(canEditProgramRoster(s, null)).toBe(true);
  });

  // Extra fields are the point: each role below carries them on its real session.
  it.each<[string, Parameters<typeof canViewProgramRoster>[0] & Record<string, unknown>]>([
    ["no role, unit Owner or Curator (a grant, not a session flag)", NONE],
    ["role flag false", { ...NONE, isProgramRosterEditor: false }],
    ["comms_steward", { ...NONE, isCommsSteward: true }],
    ["observer (synthetic steward)", { ...NONE, isCommsSteward: true, isObserver: true }],
    ["content editor (synthetic steward)", { ...NONE, isCommsSteward: true, isContentEditor: true }],
    ["development", { ...NONE, isDeveloper: true }],
    ["honors_curator", { ...NONE, isHonorsCurator: true }],
    ["data_sharing_viewer", { ...NONE, isDataSharingViewer: true }],
    ["research_security_viewer", { ...NONE, isResearchSecurityViewer: true }],
    ["core_director", { ...NONE, isCoreDirector: true }],
  ])("denies %s", (_n, s) => {
    expect(canViewProgramRoster(s)).toBe(false);
    expect(canEditProgramRoster(s, null)).toBe(false);
  });

  it("a View as overlay a non-superuser started sees nothing, whatever the target holds", () => {
    for (const s of [EDITOR, SUPER]) {
      expect(canViewProgramRoster({ ...s, sensitiveDashboardsBlocked: true })).toBe(false);
    }
  });

  it("a superuser's View as reads but never writes", () => {
    expect(canViewProgramRoster(EDITOR)).toBe(true);
    expect(canEditProgramRoster(EDITOR, "tgt0001")).toBe(false);
    expect(canEditProgramRoster(SUPER, "tgt0001")).toBe(false);
  });

  it("is closed to everyone unless the flag is exactly 'on'", () => {
    for (const v of ["off", "ON", "true", ""]) {
      vi.stubEnv("EDIT_PROGRAM_ROSTER", v);
      expect(canViewProgramRoster(SUPER)).toBe(false);
      expect(canEditProgramRoster(EDITOR, null)).toBe(false);
    }
  });
});
