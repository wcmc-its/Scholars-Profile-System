/**
 * Authorization for POST /api/edit/core-claim (lib/edit/authz core-claim helpers).
 * `authorizeCoreClaim` is pure; `getCoreOwnerRole` takes an injectable lookup.
 */
import { describe, expect, it } from "vitest";
import type { EditSession } from "@/lib/auth/superuser";
import { authorizeCoreClaim, getCoreOwnerRole, type CoreOwnerLookup } from "@/lib/edit/authz";

const OWNER: EditSession = { cwid: "own001", isSuperuser: false, isCommsSteward: false };
const SUPER: EditSession = { cwid: "sup001", isSuperuser: true, isCommsSteward: false };
const NOBODY: EditSession = { cwid: "nob001", isSuperuser: false, isCommsSteward: false };

function lookup(role: "owner" | "curator" | null): CoreOwnerLookup {
  return {
    unitAdmin: {
      findUnique: async () => (role ? { role } : null),
    },
  };
}

describe("authorizeCoreClaim", () => {
  it("allows a superuser regardless of core role", () => {
    expect(authorizeCoreClaim(SUPER, "none").ok).toBe(true);
  });

  it("allows an owner or curator of the core", () => {
    expect(authorizeCoreClaim(OWNER, "owner").ok).toBe(true);
    expect(authorizeCoreClaim(OWNER, "curator").ok).toBe(true);
  });

  it("denies a non-owner non-superuser with not_core_owner", () => {
    expect(authorizeCoreClaim(NOBODY, "none")).toEqual({ ok: false, reason: "not_core_owner" });
  });
});

describe("getCoreOwnerRole", () => {
  it("returns the unit_admin role for the (core, cwid) pair", async () => {
    expect(await getCoreOwnerRole(OWNER, "2", lookup("owner"))).toBe("owner");
    expect(await getCoreOwnerRole(OWNER, "2", lookup("curator"))).toBe("curator");
  });

  it("returns none when the actor has no row on the core", async () => {
    expect(await getCoreOwnerRole(NOBODY, "2", lookup(null))).toBe("none");
  });
});
