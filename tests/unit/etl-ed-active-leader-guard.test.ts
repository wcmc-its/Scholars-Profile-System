/**
 * `guardActiveLeaderCwid` — the active-member guard the ED ETL applies to a
 * title-detected dept chair / division chief before writing `chairCwid` /
 * `chiefCwid`. ED keeps a "Chair of X" title (and the chief manager graph) on a
 * person whose entry has expired, so a detected candidate must be dropped when
 * `weillCornellEduActiveMember` is not TRUE — the direct upsert then self-clears
 * the stale assignment.
 */
import { describe, expect, it } from "vitest";

import { guardActiveLeaderCwid } from "@/etl/ed/index";

describe("guardActiveLeaderCwid", () => {
  const active = new Map<string, boolean>([
    ["chair1", true],
    ["expired1", false],
  ]);

  it("keeps an active member's CWID", () => {
    expect(guardActiveLeaderCwid("chair1", active, true)).toBe("chair1");
  });

  it("drops a candidate whose person is not an active member (self-clears)", () => {
    expect(guardActiveLeaderCwid("expired1", active, true)).toBeNull();
  });

  it("drops a candidate absent from the active-member map (fail-closed)", () => {
    expect(guardActiveLeaderCwid("unknown", active, true)).toBeNull();
  });

  it("returns null for a null candidate", () => {
    expect(guardActiveLeaderCwid(null, active, true)).toBeNull();
  });

  it("matches case-insensitively against the lowercased map", () => {
    expect(guardActiveLeaderCwid("CHAIR1", active, true)).toBe("CHAIR1");
  });

  it("retains the candidate unchanged when the guard did not run (LDAP failure)", () => {
    // guardApplied=false — a transient active-member lookup failure must never
    // mass-clear every chair/chief.
    expect(guardActiveLeaderCwid("expired1", active, false)).toBe("expired1");
    expect(guardActiveLeaderCwid("unknown", active, false)).toBe("unknown");
  });
});
