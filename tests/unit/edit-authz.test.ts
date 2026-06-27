import { describe, expect, it, vi } from "vitest";

import {
  authorizeAppointmentVisibility,
  authorizeCommsStewardAction,
  authorizeFieldEdit,
  authorizeRevoke,
  authorizeSuppress,
  canAccessPublicationEditPage,
  canAccessScholarEditPage,
  canEditUnit,
  canGrant,
  canManageAccess,
  requireSuperuserGet,
  verifyRequestOrigin,
  type AuthzDenialReason,
} from "@/lib/edit/authz";
import type { EditSession } from "@/lib/auth/superuser";

const SELF: EditSession = { cwid: "self01", isSuperuser: false, isCommsSteward: false };
const ADMIN: EditSession = { cwid: "adm001", isSuperuser: true, isCommsSteward: false };
/** A pure comms_steward: the role bit set, NOT a superuser. */
const STEWARD: EditSession = { cwid: "stw001", isSuperuser: false, isCommsSteward: true };

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

describe("authorizeFieldEdit — selectedHighlightPmids is self OR superuser (#836)", () => {
  it("allows a scholar editing their own highlights", () => {
    expect(
      authorizeFieldEdit(SELF, { entityId: "self01", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: true });
  });

  it("denies a non-superuser editing another scholar's highlights", () => {
    expect(
      authorizeFieldEdit(SELF, { entityId: "other9", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: false, reason: "not_self" });
  });

  it("allows a superuser editing another scholar's highlights (unrestricted on the edit surface)", () => {
    expect(
      authorizeFieldEdit(ADMIN, { entityId: "other9", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: true });
  });

  it("allows a superuser editing their own highlights", () => {
    expect(
      authorizeFieldEdit(ADMIN, { entityId: "adm001", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: true });
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
// authorizeCommsStewardAction  (comms-steward-methods-visibility-spec.md §3/§7,
// test matrix §13 "Authenticated non-steward non-superuser → 403 (API write)")
//
// The Method-Family steward gate: the role is global (no cwid/owner dimension),
// so the verdict turns only on the actor's tier — steward OR superuser allow,
// neither denies with `not_comms_steward`.
// ---------------------------------------------------------------------------

describe("authorizeCommsStewardAction", () => {
  it("allows a comms_steward", () => {
    expect(authorizeCommsStewardAction(STEWARD)).toEqual({ ok: true });
  });

  it("allows a superuser (strict superset — passes every steward guard, §3)", () => {
    // ADMIN is a superuser whose isCommsSteward bit is false, so the allow comes
    // from the isSuperuser arm — exactly the superset property §3 asserts.
    expect(authorizeCommsStewardAction(ADMIN)).toEqual({ ok: true });
  });

  it("allows an actor who is BOTH steward and superuser", () => {
    const both: EditSession = { cwid: "x", isSuperuser: true, isCommsSteward: true };
    expect(authorizeCommsStewardAction(both)).toEqual({ ok: true });
  });

  it("denies an authenticated non-steward non-superuser with not_comms_steward (§13)", () => {
    expect(authorizeCommsStewardAction(SELF)).toEqual({
      ok: false,
      reason: "not_comms_steward",
    });
  });
});

// ---------------------------------------------------------------------------
// authorizeAppointmentVisibility  (#1323 — reveal a historical appointment)
//
// The GLOBAL base gate: comms_steward OR superuser allow; a plain scholar (self
// or other) denies with `not_comms_steward`. The UNIT-scoped curator path is
// layered on in the route (`resolveEditableUnitViaUnitAdmin`), not here — this
// predicate is pure and turns only on the actor's tier, like its siblings.
// ---------------------------------------------------------------------------

describe("authorizeAppointmentVisibility", () => {
  it("allows a comms_steward (profile parity)", () => {
    expect(authorizeAppointmentVisibility(STEWARD)).toEqual({ ok: true });
  });

  it("allows a superuser", () => {
    expect(authorizeAppointmentVisibility(ADMIN)).toEqual({ ok: true });
  });

  it("denies a plain scholar (self or other) with not_comms_steward", () => {
    expect(authorizeAppointmentVisibility(SELF)).toEqual({
      ok: false,
      reason: "not_comms_steward",
    });
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

// ---------------------------------------------------------------------------
// INVARIANT — a superuser is unrestricted across every action-authorization
// predicate on the edit surface.
//
// This is the operator rule "a superuser can do anything." It is encoded as one
// guard test so a future self-only addition (exactly the regression #836's
// `selectedHighlightPmids` was — a field that denied a superuser with `not_self`)
// fails CI here instead of silently locking admins out. Every NEW action-level
// predicate added to `lib/edit/authz.ts` must be exercised below with a superuser
// session and asserted to allow. (Pure `verifyRequestOrigin` — a CSRF/content-
// type guard, not an actor-authorization predicate — is deliberately out of
// scope: it gates request shape, not who the actor is.)
//
// DOCUMENTED EXCEPTION (route-level, not an authz.ts predicate): the COI-gap
// dismiss/restore routes (`/api/edit/coi-gap/[id]/*`) enforce GENUINE-self and
// REFUSE a superuser by design — those candidates are a sensitive LLM inference
// about a scholar's possible undisclosed conflicts, with no authorized viewer but
// the scholar (and a "Visible only to you" promise on the surface). That guard
// lives in the route, not here, so it is outside this invariant on purpose.
// ---------------------------------------------------------------------------

describe("INVARIANT: a superuser is allowed by every edit authorization predicate", () => {
  // ADMIN is a superuser whose cwid ("adm001") never matches the target entity,
  // so any allow here comes from the `isSuperuser` arm — not an incidental self
  // match — which is exactly the property the invariant asserts.
  const TARGET = "someoneElse";

  it("authorizeFieldEdit — allows a superuser for every editable field on another scholar", () => {
    for (const fieldName of ["overview", "slug", "selectedHighlightPmids"] as const) {
      expect(authorizeFieldEdit(ADMIN, { entityId: TARGET, fieldName })).toEqual({ ok: true });
    }
  });

  it("authorizeSuppress — allows a superuser for every suppressible entity type", () => {
    const types = ["scholar", "publication", "grant", "education", "appointment", "mentee"] as const;
    for (const entityType of types) {
      expect(authorizeSuppress(ADMIN, { entityType, entityId: TARGET })).toEqual({ ok: true });
    }
    // …including a whole-publication takedown (contributorCwid null) and a
    // per-author hide of a contributor who is NOT the actor.
    expect(
      authorizeSuppress(ADMIN, { entityType: "publication", entityId: "9", contributorCwid: null }),
    ).toEqual({ ok: true });
    expect(
      authorizeSuppress(ADMIN, { entityType: "publication", entityId: "9", contributorCwid: TARGET }),
    ).toEqual({ ok: true });
  });

  it("authorizeRevoke — allows a superuser to lift a suppression they did not create", () => {
    expect(authorizeRevoke(ADMIN, { createdBy: TARGET })).toEqual({ ok: true });
  });

  it("authorizeCommsStewardAction — allows a superuser even with isCommsSteward false (§3 superset)", () => {
    expect(authorizeCommsStewardAction(ADMIN)).toEqual({ ok: true });
  });

  it("authorizeAppointmentVisibility — allows a superuser even with isCommsSteward false (#1323)", () => {
    expect(authorizeAppointmentVisibility(ADMIN)).toEqual({ ok: true });
  });

  it("unit-curation predicates — allow a superuser even with no UnitAdmin role (effectiveRole 'none')", () => {
    expect(canEditUnit(ADMIN, "none")).toEqual({ ok: true });
    expect(canManageAccess(ADMIN, "none")).toEqual({ ok: true });
    expect(canGrant(ADMIN, "none", "owner")).toEqual({ ok: true });
    expect(canGrant(ADMIN, "none", "curator")).toEqual({ ok: true });
  });

  it("page-access predicates — a superuser reaches any scholar / publication edit page", () => {
    expect(canAccessScholarEditPage(ADMIN, TARGET)).toBe(true);
    expect(canAccessPublicationEditPage(ADMIN)).toBe(true);
    expect(
      requireSuperuserGet({ session: ADMIN, path: "/edit/scholar/someoneElse", targetId: TARGET }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// comms_steward profile editing  (comms-steward-profile-editing-spec.md §3b/§4)
//   superuser PROFILE parity across all scholars, MINUS slug + admin/unit
//   governance.
// ---------------------------------------------------------------------------

describe("comms_steward — profile-field parity (overview / highlights, any scholar)", () => {
  it("allows a steward editing any scholar's overview", () => {
    expect(authorizeFieldEdit(STEWARD, { entityId: "other9", fieldName: "overview" })).toEqual({
      ok: true,
    });
  });

  it("allows a steward editing any scholar's selectedHighlightPmids", () => {
    expect(
      authorizeFieldEdit(STEWARD, { entityId: "other9", fieldName: "selectedHighlightPmids" }),
    ).toEqual({ ok: true });
  });

  it("DENIES a steward setting a slug — slug is out of scope (superuser only)", () => {
    expect(authorizeFieldEdit(STEWARD, { entityId: "other9", fieldName: "slug" })).toEqual({
      ok: false,
      reason: "not_superuser",
    });
  });
});

describe("comms_steward — suppression parity (incl. publication takedown)", () => {
  it("allows a steward to take down a whole publication on any profile", () => {
    expect(
      authorizeSuppress(STEWARD, { entityType: "publication", entityId: "12345", contributorCwid: null }),
    ).toEqual({ ok: true });
  });

  it("allows a steward to suppress any scholar's grant", () => {
    expect(
      authorizeSuppress(STEWARD, { entityType: "grant", entityId: "g1", ownerCwid: "other9" }),
    ).toEqual({ ok: true });
  });

  it("allows a steward to revoke any suppression (mirror of suppress parity)", () => {
    expect(authorizeRevoke(STEWARD, { createdBy: "other9" })).toEqual({ ok: true });
  });
});

describe("comms_steward — page access", () => {
  it("may open any scholar's edit page", () => {
    expect(canAccessScholarEditPage(STEWARD, "other9")).toBe(true);
  });

  it("does NOT get the superuser-only publication takedown PAGE", () => {
    expect(canAccessPublicationEditPage(STEWARD)).toBe(false);
  });
});

describe("comms_steward — org-unit editing (content, not governance)", () => {
  it("CAN edit any existing unit's content even with no grant (curator parity, §3b)", () => {
    expect(canEditUnit(STEWARD, "none")).toEqual({ ok: true });
  });

  it("CANNOT manage unit access / grant roles ('adding/removing users')", () => {
    expect(canManageAccess(STEWARD, "none").ok).toBe(false);
    expect(canGrant(STEWARD, "none", "curator").ok).toBe(false);
  });
});
