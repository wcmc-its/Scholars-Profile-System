/**
 * `lib/edit/data-sharing-dashboard.ts` — the `/edit/data-sharing` flag + role
 * gate. Had zero direct test coverage before this (only mocked out in
 * `data-sharing-export-route.test.ts`); this covers the real predicate,
 * including the 2026-08-15 `data_sharing_viewer` role addition.
 */
import { describe, expect, it, afterEach } from "vitest";

import {
  canViewDataSharingDashboard,
  isDataSharingDashboardEnabled,
  isDataSharingDashboardTabVisible,
} from "@/lib/edit/data-sharing-dashboard";

const ORIGINAL_FLAG = process.env.EDIT_DATA_SHARING_DASHBOARD;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.EDIT_DATA_SHARING_DASHBOARD;
  else process.env.EDIT_DATA_SHARING_DASHBOARD = ORIGINAL_FLAG;
});

describe("isDataSharingDashboardEnabled", () => {
  it("is true only when EDIT_DATA_SHARING_DASHBOARD is exactly 'on'", () => {
    process.env.EDIT_DATA_SHARING_DASHBOARD = "on";
    expect(isDataSharingDashboardEnabled()).toBe(true);
    process.env.EDIT_DATA_SHARING_DASHBOARD = "off";
    expect(isDataSharingDashboardEnabled()).toBe(false);
    delete process.env.EDIT_DATA_SHARING_DASHBOARD;
    expect(isDataSharingDashboardEnabled()).toBe(false);
  });
});

describe("isDataSharingDashboardTabVisible / canViewDataSharingDashboard", () => {
  const cases: Array<[string, { isSuperuser: boolean; isCommsSteward: boolean; isDataSharingViewer?: boolean }, boolean]> = [
    ["superuser", { isSuperuser: true, isCommsSteward: false }, true],
    ["comms_steward", { isSuperuser: false, isCommsSteward: true }, true],
    ["data_sharing_viewer", { isSuperuser: false, isCommsSteward: false, isDataSharingViewer: true }, true],
    ["none of the three", { isSuperuser: false, isCommsSteward: false, isDataSharingViewer: false }, false],
    ["data_sharing_viewer omitted (optional field)", { isSuperuser: false, isCommsSteward: false }, false],
  ];

  it.each(cases)("flag on: %s -> %s", (_label, session, expected) => {
    process.env.EDIT_DATA_SHARING_DASHBOARD = "on";
    expect(isDataSharingDashboardTabVisible(session)).toBe(expected);
    expect(canViewDataSharingDashboard({ cwid: "abc1234", ...session })).toBe(expected);
  });

  it("is false for every role when the flag is off — the role can never override a dark deployment", () => {
    process.env.EDIT_DATA_SHARING_DASHBOARD = "off";
    expect(
      isDataSharingDashboardTabVisible({ isSuperuser: true, isCommsSteward: true, isDataSharingViewer: true }),
    ).toBe(false);
  });
});
