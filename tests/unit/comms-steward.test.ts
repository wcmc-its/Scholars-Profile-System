import { afterEach, describe, expect, it } from "vitest";

import {
  isMethodsTabVisible,
  listCommsStewardCwids,
} from "@/lib/auth/comms-steward";

/**
 * `listCommsStewardCwids` is the enumerable steward source behind the "View as"
 * candidate list (impersonation-spec.md §7, role-aware-navigation-entry-points-
 * spec.md). It must stay dark when the kill switch is off and otherwise echo the
 * interim allowlist, lower-cased + de-duplicated. `isMethodsTabVisible` is the
 * paired display gate.
 */
describe("listCommsStewardCwids", () => {
  const ENABLED = process.env.COMMS_STEWARD_ENABLED;
  const ALLOW = process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST;

  afterEach(() => {
    process.env.COMMS_STEWARD_ENABLED = ENABLED;
    process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST = ALLOW;
  });

  it("returns [] when the kill switch is off, even with an allowlist set", () => {
    process.env.COMMS_STEWARD_ENABLED = "off";
    process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST = "dwd2001,abc1234";
    expect(listCommsStewardCwids()).toEqual([]);
  });

  it("echoes the allowlist (lower-cased, de-duplicated, trimmed) when enabled", () => {
    process.env.COMMS_STEWARD_ENABLED = "on";
    process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST = "dwd2001, DWD2001 , abc1234";
    expect(listCommsStewardCwids()).toEqual(["dwd2001", "abc1234"]);
  });

  it("returns [] when enabled but the allowlist is unset (group-only — not yet enumerable)", () => {
    process.env.COMMS_STEWARD_ENABLED = "on";
    delete process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST;
    expect(listCommsStewardCwids()).toEqual([]);
  });
});

describe("isMethodsTabVisible", () => {
  const ENABLED = process.env.COMMS_STEWARD_ENABLED;
  afterEach(() => {
    process.env.COMMS_STEWARD_ENABLED = ENABLED;
  });

  it("is true for a steward or a superuser when enabled, false otherwise", () => {
    process.env.COMMS_STEWARD_ENABLED = "on";
    expect(isMethodsTabVisible({ isSuperuser: false, isCommsSteward: true })).toBe(true);
    expect(isMethodsTabVisible({ isSuperuser: true, isCommsSteward: false })).toBe(true);
    expect(isMethodsTabVisible({ isSuperuser: false, isCommsSteward: false })).toBe(false);
  });

  it("is false for everyone when the kill switch is off", () => {
    process.env.COMMS_STEWARD_ENABLED = "off";
    expect(isMethodsTabVisible({ isSuperuser: true, isCommsSteward: true })).toBe(false);
  });
});
