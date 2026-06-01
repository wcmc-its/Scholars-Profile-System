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
