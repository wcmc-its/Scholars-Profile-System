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
});
