import { describe, expect, it, vi } from "vitest";

import {
  authorizeFieldEdit,
  authorizeRevoke,
  authorizeSuppress,
  canAccessPublicationEditPage,
  canAccessScholarEditPage,
  requireSuperuserGet,
  verifyRequestOrigin,
  type AuthzDenialReason,
} from "@/lib/edit/authz";
import type { EditSession } from "@/lib/auth/superuser";

const SELF: EditSession = { cwid: "self01", isSuperuser: false };
const ADMIN: EditSession = { cwid: "adm001", isSuperuser: true };

// ---------------------------------------------------------------------------
// authorizeFieldEdit  (self-edit-spec.md § Authorization, edge case 2)
// ---------------------------------------------------------------------------

describe("authorizeFieldEdit — overview is self OR superuser (#844)", () => {
  it("allows a scholar editing their own overview", () => {
    expect(authorizeFieldEdit(SELF, { entityId: "self01", fieldName: "overview" })).toEqual({
      ok: true,
    });
  });

  it("denies a non-superuser editing another scholar's overview", () => {
    expect(authorizeFieldEdit(SELF, { entityId: "other9", fieldName: "overview" })).toEqual({
      ok: false,
      reason: "not_self",
    });
  });

  it("allows a superuser editing another scholar's overview (#844)", () => {
    expect(authorizeFieldEdit(ADMIN, { entityId: "other9", fieldName: "overview" })).toEqual({
      ok: true,
    });
  });

  it("allows a superuser editing their own overview", () => {
    expect(authorizeFieldEdit(ADMIN, { entityId: "adm001", fieldName: "overview" })).toEqual({
      ok: true,
    });
  });
});

describe("authorizeFieldEdit — selectedHighlightPmids stays self-only (#844 scope)", () => {
  it("allows a scholar editing their own highlights", () => {
    expect(
      authorizeFieldEdit(SELF, { entityId: "self01", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: true });
  });

  it("denies a scholar editing another scholar's highlights", () => {
    expect(
      authorizeFieldEdit(SELF, { entityId: "other9", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: false, reason: "not_self" });
  });

  it("does NOT extend the #844 superuser widening to highlights (overview-only)", () => {
    // The #844 admin widening is scoped strictly to `overview`; a superuser does
    // not inherit `selectedHighlightPmids` for another scholar.
    expect(
      authorizeFieldEdit(ADMIN, { entityId: "other9", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: false, reason: "not_self" });
  });
});

describe("authorizeFieldEdit — slug is superuser-only", () => {
  it("allows a superuser", () => {
    expect(authorizeFieldEdit(ADMIN, { entityId: "any", fieldName: "slug" })).toEqual({ ok: true });
  });

  it("denies a non-superuser, even on their own record", () => {
    expect(authorizeFieldEdit(SELF, { entityId: "self01", fieldName: "slug" })).toEqual({
      ok: false,
      reason: "not_superuser",
    });
  });
});

// ---------------------------------------------------------------------------
// authorizeSuppress  (self-edit-spec.md § Authorization, edge cases 3, 6, 17)
// ---------------------------------------------------------------------------

describe("authorizeSuppress — scholar (whole profile)", () => {
  it("allows a self-suppress", () => {
    expect(authorizeSuppress(SELF, { entityType: "scholar", entityId: "self01" })).toEqual({
      ok: true,
    });
  });

  it("denies suppressing another scholar's profile", () => {
    expect(authorizeSuppress(SELF, { entityType: "scholar", entityId: "other9" })).toEqual({
      ok: false,
      reason: "not_self",
    });
  });

  it("allows a superuser to suppress any profile", () => {
    expect(authorizeSuppress(ADMIN, { entityType: "scholar", entityId: "other9" })).toEqual({
      ok: true,
    });
  });
});

describe("authorizeSuppress — publication (per-author hide)", () => {
  it("allows hiding oneself as a contributor", () => {
    expect(
      authorizeSuppress(SELF, {
        entityType: "publication",
        entityId: "999",
        contributorCwid: "self01",
      }),
    ).toEqual({ ok: true });
  });

  it("denies hiding another scholar as a contributor (edge case 17)", () => {
    expect(
      authorizeSuppress(SELF, {
        entityType: "publication",
        entityId: "999",
        contributorCwid: "other9",
      }),
    ).toEqual({ ok: false, reason: "not_self" });
  });

  it("allows a superuser to hide any contributor", () => {
    expect(
      authorizeSuppress(ADMIN, {
        entityType: "publication",
        entityId: "999",
        contributorCwid: "other9",
      }),
    ).toEqual({ ok: true });
  });
});

describe("authorizeSuppress — publication (whole-publication takedown)", () => {
  it("denies a non-superuser whole-publication takedown", () => {
    expect(
      authorizeSuppress(SELF, { entityType: "publication", entityId: "999", contributorCwid: null }),
    ).toEqual({ ok: false, reason: "not_superuser" });
  });

  it("allows a superuser whole-publication takedown", () => {
    expect(
      authorizeSuppress(ADMIN, { entityType: "publication", entityId: "999" }),
    ).toEqual({ ok: true });
  });
});

describe("authorizeSuppress — grant / education / appointment (whole-entity, #160)", () => {
  it.each(["grant", "education", "appointment"] as const)(
    "allows the owning scholar to suppress their own %s",
    (entityType) => {
      expect(
        authorizeSuppress(SELF, { entityType, entityId: "EXT-1", ownerCwid: "self01" }),
      ).toEqual({ ok: true });
    },
  );

  it.each(["grant", "education", "appointment"] as const)(
    "denies a non-owner suppressing someone else's %s",
    (entityType) => {
      expect(
        authorizeSuppress(SELF, { entityType, entityId: "EXT-1", ownerCwid: "other9" }),
      ).toEqual({ ok: false, reason: "not_self" });
    },
  );

  it.each(["grant", "education", "appointment"] as const)(
    "allows a superuser to suppress any %s",
    (entityType) => {
      expect(
        authorizeSuppress(ADMIN, { entityType, entityId: "EXT-1", ownerCwid: "other9" }),
      ).toEqual({ ok: true });
    },
  );

  it("denies a non-superuser when ownerCwid is unresolved (never implicitly self)", () => {
    expect(authorizeSuppress(SELF, { entityType: "education", entityId: "EXT-1" })).toEqual({
      ok: false,
      reason: "not_self",
    });
  });
});

// ---------------------------------------------------------------------------
// authorizeRevoke  (self-edit-spec.md § Authorization, edge cases 4, 5)
// ---------------------------------------------------------------------------

describe("authorizeRevoke", () => {
  it("allows revoking a suppression the actor created", () => {
    expect(authorizeRevoke(SELF, { createdBy: "self01" })).toEqual({ ok: true });
  });

  it("denies revoking a suppression created by someone else (edge case 5)", () => {
    expect(authorizeRevoke(SELF, { createdBy: "adm001" })).toEqual({
      ok: false,
      reason: "not_owner",
    });
  });

  it("allows a superuser to revoke any suppression", () => {
    expect(authorizeRevoke(ADMIN, { createdBy: "self01" })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// page-access predicates  (the GET-time re-check, edge case 15)
// ---------------------------------------------------------------------------

describe("canAccessScholarEditPage", () => {
  it("allows the scholar themselves", () => {
    expect(canAccessScholarEditPage(SELF, "self01")).toBe(true);
  });

  it("allows a superuser for any cwid", () => {
    expect(canAccessScholarEditPage(ADMIN, "other9")).toBe(true);
  });

  it("denies a non-superuser viewing another scholar's edit page", () => {
    expect(canAccessScholarEditPage(SELF, "other9")).toBe(false);
  });
});

describe("canAccessPublicationEditPage", () => {
  it("allows only a superuser", () => {
    expect(canAccessPublicationEditPage(ADMIN)).toBe(true);
    expect(canAccessPublicationEditPage(SELF)).toBe(false);
  });
});

describe("requireSuperuserGet (Phase 7 §11)", () => {
  it("returns null for a superuser session and emits no denial log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      requireSuperuserGet({ session: ADMIN, path: "/edit/scholar/other9", targetId: "other9" }),
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns 'not_superuser' for a non-superuser and emits one edit_authz_denied line", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = requireSuperuserGet({
      session: SELF,
      path: "/edit/scholar/other9",
      targetId: "other9",
    });
    expect(result).toBe("not_superuser");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe("edit_authz_denied");
    expect(parsed.path).toBe("/edit/scholar/other9");
    expect(parsed.actor_cwid).toBe("self01");
    expect(parsed.target_cwid).toBe("other9");
    expect(parsed.reason).toBe("not_superuser_get");
    warn.mockRestore();
  });

  it("works for the publication path too (the same helper serves both routes)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      requireSuperuserGet({
        session: SELF,
        path: "/edit/publication/12345",
        targetId: "12345",
      }),
    ).toBe("not_superuser");
    const line = warn.mock.calls[0][0] as string;
    expect(JSON.parse(line).path).toBe("/edit/publication/12345");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// verifyRequestOrigin  (defense in depth beyond SameSite=Lax)
// ---------------------------------------------------------------------------

function req(headers: Record<string, string>) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null } };
}

describe("verifyRequestOrigin", () => {
  it("accepts a same-origin JSON POST", () => {
    expect(
      verifyRequestOrigin(req({ "content-type": "application/json", "sec-fetch-site": "same-origin" })),
    ).toEqual({ ok: true });
  });

  it("rejects a cross-site POST", () => {
    expect(
      verifyRequestOrigin(req({ "content-type": "application/json", "sec-fetch-site": "cross-site" })),
    ).toEqual({ ok: false, reason: "cross_origin" });
  });

  it("rejects a non-JSON content type", () => {
    expect(
      verifyRequestOrigin(
        req({ "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }),
      ),
    ).toEqual({ ok: false, reason: "bad_content_type" });
  });

  it("rejects a missing content type", () => {
    expect(verifyRequestOrigin(req({ "sec-fetch-site": "same-origin" }))).toEqual({
      ok: false,
      reason: "bad_content_type",
    });
  });

  it("falls back to Origin/Host when Sec-Fetch-Site is absent", () => {
    expect(
      verifyRequestOrigin(
        req({ "content-type": "application/json", origin: "https://scholars.weill.edu", host: "scholars.weill.edu" }),
      ),
    ).toEqual({ ok: true });
  });

  it("rejects a mismatched Origin host", () => {
    expect(
      verifyRequestOrigin(
        req({ "content-type": "application/json", origin: "https://evil.example", host: "scholars.weill.edu" }),
      ),
    ).toEqual({ ok: false, reason: "cross_origin" });
  });

  it("rejects when neither Sec-Fetch-Site nor Origin can verify the request", () => {
    expect(verifyRequestOrigin(req({ "content-type": "application/json" }))).toEqual({
      ok: false,
      reason: "cross_origin",
    });
  });
});

// ---------------------------------------------------------------------------
// AuthzDenialReason — `ed_locked` membership (#728 § 2.2 #3 / § 5 MUST-7)
// ---------------------------------------------------------------------------

describe("AuthzDenialReason — ed_locked is a stable member", () => {
  it("includes ed_locked in the union (guards the route's editError(403, 'ed_locked'))", () => {
    // A compile-time guard: if `ed_locked` were dropped from the union this
    // assignment would fail typecheck, breaking the grant route's gate.
    const reason: AuthzDenialReason = "ed_locked";
    expect(reason).toBe("ed_locked");
  });
});
