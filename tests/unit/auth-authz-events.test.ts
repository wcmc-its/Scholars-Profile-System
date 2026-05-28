import { describe, expect, it, vi, beforeEach } from "vitest";
import { logAuthzDenied } from "@/lib/auth/authz-events";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  warn.mockClear();
});

describe("logAuthzDenied", () => {
  it("emits one edit_authz_denied line in the documented field order", () => {
    logAuthzDenied({
      actor_cwid: "usr2002",
      target_cwid: "sch3003",
      path: "/api/edit/field",
      reason: "not_superuser",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // Exact-string match pins the shape: any extra key, or a key reordered,
    // changes the serialization and fails here.
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "edit_authz_denied",
        actor_cwid: "usr2002",
        target_cwid: "sch3003",
        path: "/api/edit/field",
        reason: "not_superuser",
      }),
    );
  });

  it("passes the reason and a self-action target through unchanged", () => {
    logAuthzDenied({
      actor_cwid: "sch3003",
      target_cwid: "sch3003",
      path: "/api/edit/suppress",
      reason: "not_self",
    });
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "edit_authz_denied",
        actor_cwid: "sch3003",
        target_cwid: "sch3003",
        path: "/api/edit/suppress",
        reason: "not_self",
      }),
    );
  });

  // #540 / Amendment 1 § A1.5 #1 — generalized event payload for unit denials.
  it("emits the org-unit target fields when provided (Amendment 1 § A1.5 #1)", () => {
    logAuthzDenied({
      actor_cwid: "usr2002",
      target_cwid: "DEPT-X", // the unit code, mirrored for legacy alarms
      path: "/api/edit/grant",
      reason: "authority_violation",
      target_entity_type: "department",
      target_entity_id: "DEPT-X",
      role: "owner",
    });
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "edit_authz_denied",
        actor_cwid: "usr2002",
        target_cwid: "DEPT-X",
        path: "/api/edit/grant",
        reason: "authority_violation",
        target_entity_type: "department",
        target_entity_id: "DEPT-X",
        role: "owner",
      }),
    );
  });
});
