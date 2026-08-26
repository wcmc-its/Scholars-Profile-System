/**
 * `resolveCornellRosterAdd` (#2519 PR 1 §5/§14) — the Cornell-add resolution
 * used by `POST /api/edit/roster`'s `source:"cornell"` branch:
 *   - bridge resolution: a `cornellEduCWID` matching an ACTIVE Scholar steers
 *     to the WCM add path; no match (or no bridge attribute) steers external.
 *   - the defensive cuid check: a netid that collides with an active
 *     Scholar.cwid is rejected — the disjointness invariant fails closed.
 *
 * All deps injected as fakes — no live LDAP, no DB.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolveCornellRosterAdd,
  type CornellAddDeps,
} from "@/lib/edit/cornell-roster";
import type { CornellDirectoryPerson } from "@/lib/sources/cornell-ldap";

const PERSON: CornellDirectoryPerson = {
  netid: "ab123",
  name: "Ada Byron",
  givenName: "Ada",
  familyName: "Byron",
  title: "Research Associate",
  dept: "Computer Science",
  email: "ab123@cornell.edu",
  affiliation: "staff",
  cornellEduCWID: null,
};

function makeDeps(overrides: Partial<CornellAddDeps> = {}): CornellAddDeps {
  return {
    fetchByNetid: vi.fn(async () => PERSON),
    findActiveScholarByCwid: vi.fn(async () => null),
    ...overrides,
  };
}

describe("resolveCornellRosterAdd — bridge resolution", () => {
  it("steers to the WCM add path when cornellEduCWID resolves to an active Scholar", async () => {
    const bridgedPerson = { ...PERSON, cornellEduCWID: "wcm999" };
    const deps = makeDeps({
      fetchByNetid: vi.fn(async () => bridgedPerson),
      findActiveScholarByCwid: vi.fn(async (cwid: string) =>
        cwid === "wcm999" ? { cwid: "wcm999" } : null,
      ),
    });
    const result = await resolveCornellRosterAdd("ab123", deps);
    expect(result).toEqual({ kind: "wcm", cwid: "wcm999" });
  });

  it("steers to the external add path when cornellEduCWID does not resolve to an active Scholar", async () => {
    const bridgedPerson = { ...PERSON, cornellEduCWID: "wcm999" };
    const deps = makeDeps({
      fetchByNetid: vi.fn(async () => bridgedPerson),
      findActiveScholarByCwid: vi.fn(async () => null), // no active Scholar for wcm999 either
    });
    const result = await resolveCornellRosterAdd("ab123", deps);
    expect(result.kind).toBe("external");
    if (result.kind === "external") {
      expect(result.cuid).toBe("ab123");
      expect(result.snapshot).toEqual({
        displayName: "Ada Byron",
        givenName: "Ada",
        familyName: "Byron",
        title: "Research Associate",
        dept: "Computer Science",
        email: "ab123@cornell.edu",
        affiliation: "staff",
      });
    }
  });

  it("steers to the external add path when the entry carries no bridge attribute at all", async () => {
    const deps = makeDeps(); // PERSON.cornellEduCWID is null
    const result = await resolveCornellRosterAdd("ab123", deps);
    expect(result.kind).toBe("external");
    // findActiveScholarByCwid is called once for the defensive netid check
    // only — no second bridge-lookup call, since there's no bridge cwid.
    expect(deps.findActiveScholarByCwid).toHaveBeenCalledTimes(1);
    expect(deps.findActiveScholarByCwid).toHaveBeenCalledWith("ab123");
  });

  it("returns not_found when no Cornell entry matches the netid", async () => {
    const deps = makeDeps({ fetchByNetid: vi.fn(async () => null) });
    const result = await resolveCornellRosterAdd("ghost1", deps);
    expect(result).toEqual({ kind: "not_found" });
  });
});

describe("resolveCornellRosterAdd — defensive cuid check", () => {
  it("rejects the add when the netid already IS an active Scholar.cwid", async () => {
    const deps = makeDeps({
      findActiveScholarByCwid: vi.fn(async (cwid: string) =>
        cwid === "ab123" ? { cwid: "ab123" } : null,
      ),
    });
    const result = await resolveCornellRosterAdd("ab123", deps);
    expect(result).toEqual({ kind: "disjoint_violation" });
    // Fails closed BEFORE ever fetching from Cornell LDAP or writing anything.
    expect(deps.fetchByNetid).not.toHaveBeenCalled();
  });

  it("does not reject when the netid collides with an INACTIVE/nonexistent Scholar.cwid", async () => {
    // findActiveScholarByCwid models "active only" — an inactive/soft-deleted
    // Scholar with the same cwid string must resolve to null from the caller,
    // so this fake returning null for it is the correct contract.
    const deps = makeDeps({ findActiveScholarByCwid: vi.fn(async () => null) });
    const result = await resolveCornellRosterAdd("ab123", deps);
    expect(result.kind).not.toBe("disjoint_violation");
  });
});
