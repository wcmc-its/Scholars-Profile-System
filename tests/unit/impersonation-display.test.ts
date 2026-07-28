/**
 * #637 — "View as" impersonation: display role × unit-kind resolution
 * (impersonation-spec.md §7/§8, the role taxonomy fix).
 *
 * The switcher and banner classify a subject by the REAL RBAC model
 * (ADR-005 Amendment 1 / #540): role `owner`/`curator` over a unit kind
 * `department`/`division`/`center`, or plain `scholar`. `pickDisplayGrant` is
 * the one rule both the `/api/auth/session` probe and `/api/impersonation/candidates`
 * share, so it is tested directly; `resolveImpersonationDisplay` is checked over
 * a stub Prisma surface.
 */
import { describe, expect, it } from "vitest";

import {
  pickDisplayGrant,
  summarizeUnitAdminGrants,
  resolveImpersonationDisplay,
  type ImpersonationDisplayClient,
} from "@/lib/edit/impersonation-display";

describe("pickDisplayGrant", () => {
  it("returns null for a CWID with no unit grant (a plain scholar)", () => {
    expect(pickDisplayGrant([])).toBeNull();
  });

  it("ignores non-org-unit grant rows", () => {
    const top = pickDisplayGrant([
      { role: "owner", entityType: "scholar", entityId: "x" },
      { role: "curator", entityType: "division", entityId: "V1" },
    ]);
    expect(top).toEqual({ role: "curator", entityType: "division", entityId: "V1" });
  });

  it("prefers owner over curator regardless of unit kind", () => {
    const top = pickDisplayGrant([
      { role: "curator", entityType: "center", entityId: "C1" },
      { role: "owner", entityType: "department", entityId: "D1" },
    ]);
    expect(top).toEqual({ role: "owner", entityType: "department", entityId: "D1" });
  });

  it("breaks an equal-role tie by unit-kind rank center > division > department", () => {
    expect(
      pickDisplayGrant([
        { role: "owner", entityType: "department", entityId: "D1" },
        { role: "owner", entityType: "center", entityId: "C1" },
      ]),
    ).toMatchObject({ entityType: "center" });

    expect(
      pickDisplayGrant([
        { role: "owner", entityType: "department", entityId: "D1" },
        { role: "owner", entityType: "division", entityId: "V1" },
      ]),
    ).toMatchObject({ entityType: "division" });
  });
});

describe("resolveImpersonationDisplay", () => {
  function stubClient(
    grants: Array<{ role: "owner" | "curator"; entityType: string; entityId: string }>,
    names: { department?: string; division?: string; center?: string } = {},
  ): ImpersonationDisplayClient {
    return {
      unitAdmin: { findMany: async () => grants },
      department: { findUnique: async () => (names.department ? { name: names.department } : null) },
      division: { findUnique: async () => (names.division ? { name: names.division } : null) },
      center: { findUnique: async () => (names.center ? { name: names.center } : null) },
    } as unknown as ImpersonationDisplayClient;
  }

  it("a CWID with no grant is a scholar at their home unit", async () => {
    const out = await resolveImpersonationDisplay("sch001", stubClient([]), "Pediatrics");
    expect(out).toEqual({ role: "scholar", unitKind: null, unit: "Pediatrics" });
  });

  it("a center owner reads role=owner, unitKind=center, the center's name", async () => {
    const out = await resolveImpersonationDisplay(
      "own001",
      stubClient([{ role: "owner", entityType: "center", entityId: "meyer" }], {
        center: "Meyer Cancer Center",
      }),
      "Medicine",
    );
    expect(out).toEqual({ role: "owner", unitKind: "center", unit: "Meyer Cancer Center" });
  });

  it("a department curator reads role=curator, unitKind=department, the dept name", async () => {
    const out = await resolveImpersonationDisplay(
      "cur001",
      stubClient([{ role: "curator", entityType: "department", entityId: "CARDIO" }], {
        department: "Cardiology",
      }),
      null,
    );
    expect(out).toEqual({ role: "curator", unitKind: "department", unit: "Cardiology" });
  });

  it("falls back to the home unit when the administered unit name can't be resolved", async () => {
    const out = await resolveImpersonationDisplay(
      "own002",
      stubClient([{ role: "owner", entityType: "division", entityId: "GONE" }]),
      "Home Dept",
    );
    expect(out).toEqual({ role: "owner", unitKind: "division", unit: "Home Dept" });
  });
});

/**
 * The unit-admin pass of `/api/impersonation/candidates`: a superuser searching
 * "View as" for an org-unit administrator who has NO `Scholar` row of their own.
 * Before this, the route enumerated `Scholar` rows only (plus a comms_steward
 * allowlist), so an administrative-staff curator — a real prod case, adm001 on
 * Pediatrics — was unfindable no matter what was typed.
 */
describe("summarizeUnitAdminGrants", () => {
  const row = (
    cwid: string,
    entityType: string,
    entityId: string,
    role: "owner" | "curator" = "curator",
    granteeName: string | null = null,
  ) => ({ cwid, granteeName, entityType, entityId, role });

  it("reduces several grants for one person to a single most-privileged subject", () => {
    const out = summarizeUnitAdminGrants([
      row("adm001", "department", "DEPT1", "curator", "Alex Rivera"),
      row("adm001", "center", "CTSC", "owner"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cwid).toBe("adm001");
    expect(out[0].granteeName).toBe("Alex Rivera");
    // owner beats curator regardless of row order.
    expect(out[0].top).toEqual({ role: "owner", entityType: "center", entityId: "CTSC" });
  });

  it("keeps a granteeName found on a LATER row (the first may predate the ED pull)", () => {
    const out = summarizeUnitAdminGrants([
      row("adm001", "department", "DEPT1"),
      row("adm001", "division", "DIV1", "curator", "Alex Rivera"),
    ]);
    expect(out[0].granteeName).toBe("Alex Rivera");
  });

  it("excludes anyone the scholar pass already emitted, case-insensitively", () => {
    const out = summarizeUnitAdminGrants(
      [row("ABC123", "department", "DEPT1"), row("xyz789", "division", "DIV1")],
      new Set(["abc123"]),
    );
    expect(out.map((s) => s.cwid)).toEqual(["xyz789"]);
  });

  it("groups case-variant CWIDs as ONE person, preserving the stored casing", () => {
    const out = summarizeUnitAdminGrants([
      row("ADM001", "department", "DEPT1"),
      row("adm001", "division", "DIV1"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].cwid).toBe("ADM001");
  });

  it("reports top=null for a grant on no org unit, so the route can drop them", () => {
    const out = summarizeUnitAdminGrants([row("odd001", "scholar", "someone")]);
    expect(out[0].top).toBeNull();
  });

  it("is stable in first-appearance order (the popover must not reshuffle)", () => {
    const out = summarizeUnitAdminGrants([
      row("ccc", "department", "A"),
      row("aaa", "department", "B"),
      row("bbb", "department", "C"),
      row("aaa", "center", "D", "owner"),
    ]);
    expect(out.map((s) => s.cwid)).toEqual(["ccc", "aaa", "bbb"]);
  });

  it("returns [] for no rows", () => {
    expect(summarizeUnitAdminGrants([])).toEqual([]);
  });
});
