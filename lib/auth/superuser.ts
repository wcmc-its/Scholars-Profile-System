/**
 * B02 — superuser resolution (issue #101).
 *
 * `isSuperuser(cwid)` answers "is this CWID a member of the superuser group?"
 * with a live LDAPS query against the WCM Enterprise Directory — re-evaluated
 * per request, never cached (`self-edit-spec.md` § Authorization; B01's cookie
 * is identity-only by design). `getEditSession()` pairs B01's identity session
 * with that answer as `{ cwid, isSuperuser }`, the shape the `/edit/*` pages
 * and `/api/edit/*` handlers (#356) consume.
 *
 * The superuser group is a real Enterprise Directory group object under
 * `ou=Groups` (cn `ITS:Library:Scholars/superuser-role`); membership is the
 * group's `member` attribute, which lists person DNs (`uid=<cwid>,ou=people,…`).
 * The check is one subtree search under `ou=Groups`: does the named group
 * carry this CWID's person DN in `member`?
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets and
 * TLS): this module, and anything importing it, must never be pulled into the
 * Edge middleware bundle — the same constraint `lib/auth/saml.ts` carries.
 *
 * The check is **fail-closed**: a missing group cn, an unreachable directory,
 * a bind failure, or a search error all resolve to "not a superuser". A
 * directory problem can never *grant* the admin tier.
 */
import { cache } from "react";
import { isCommsSteward } from "@/lib/auth/comms-steward";
import { isDeveloper } from "@/lib/auth/development";
import { getSuperuserAllowlist, getSuperuserConfig } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session-server";
import { isGroupMember } from "@/lib/auth/ldap-group";

/**
 * B01 identity (`cwid`) paired with the live authorization verdicts:
 * the B02 superuser tier and the `comms_steward` Method-Family role
 * (`comms-steward-methods-visibility-spec.md` §3). Both are resolved fresh on
 * every `getEditSession()`, never cached for the session.
 */
export interface EditSession {
  cwid: string;
  isSuperuser: boolean;
  /** Live `comms_steward` verdict (§3); a superuser is a superset of this. */
  isCommsSteward: boolean;
  /**
   * Live `development` verdict (GrantRecs Phase 4); a superuser is a superset of
   * this. Gates ONLY the in-progress admin tooling (`/edit/find-researchers` and
   * its data route) — no edit-authz predicate reads it, so unlike `isSuperuser` /
   * `isCommsSteward` it is OPTIONAL: the synthetic `EditSession` shapes the field
   * / unit authz helpers build need not carry a flag they never consume. The live
   * resolvers (`getEditSession` / `getEffectiveEditSession`) always populate it,
   * and the find-researchers gate only ever reads a session from those.
   */
  isDeveloper?: boolean;
}


/** One structured log line for a directory-side failure of the superuser check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(
    JSON.stringify({ event: "superuser_check_failed", reason, cwid }),
  );
}

/**
 * Whether `cwid` is a member of the superuser group, by a live LDAPS search of
 * the group's `member` attribute. Never throws — every failure mode resolves
 * to `false`.
 *
 * Wrapped in React `cache()`, keyed on `cwid`, so a given CWID is resolved at
 * most once per server request/render — the LDAPS bind/search is deduped when
 * the same CWID is checked repeatedly within one request (e.g. via
 * `getEditSession`, `getEffectiveEditSession`, and per-route re-checks). This is
 * request-scoped only: it does NOT cache across requests or for the session, so
 * the spec invariant holds — `isSuperuser` is re-evaluated live on every `/edit`
 * GET and every `/api/edit` POST (`self-edit-spec.md` § Authorization). Distinct
 * CWIDs (e.g. a proxy's own vs. the effective/target CWID) key independently and
 * each evaluate on their own.
 */
export const isSuperuser = cache(async (cwid: string): Promise<boolean> => {
  if (!cwid) return false;
  // Interim allowlist (#443) — confers superuser WITHOUT LDAP, checked before
  // any directory work. The SPS VPC has no route to the WCM directory yet, so
  // the live group search below times out and fails closed; this keeps the
  // admin tier (incl. #637 "View as") usable for a named operator set in the
  // meantime. Matched case-insensitively. Empty/unset => no-op (the default in
  // every env once routing lands and SCHOLARS_SUPERUSER_GROUP_CN takes over).
  if (getSuperuserAllowlist().includes(cwid.toLowerCase())) return true;
  const { groupCn } = getSuperuserConfig();
  // Group cn not configured yet — the admin tier is dormant, not broken.
  if (!groupCn) return false;

  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});

/**
 * The current edit session: B01's identity plus the live `isSuperuser` and
 * `isCommsSteward` verdicts. `null` when unauthenticated — the caller's gate
 * (B01 middleware, and the per-route check) handles the 401 / redirect.
 * Resolved fresh on every call; neither group claim is cached for the session.
 */
export async function getEditSession(): Promise<EditSession | null> {
  const session = await getSession();
  if (!session) return null;
  return {
    cwid: session.cwid,
    isSuperuser: await isSuperuser(session.cwid),
    isCommsSteward: await isCommsSteward(session.cwid),
    isDeveloper: await isDeveloper(session.cwid),
  };
}
