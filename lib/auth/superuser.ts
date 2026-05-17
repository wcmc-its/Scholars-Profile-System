/**
 * B02 — superuser resolution (issue #101).
 *
 * `isSuperuser(cwid)` answers "is this CWID a member of the `scholars-admins`
 * group?" with a live LDAPS query against the WCM Enterprise Directory —
 * re-evaluated per request, never cached (`self-edit-spec.md` § Authorization;
 * B01's cookie is identity-only by design). `getEditSession()` pairs B01's
 * identity session with that answer as `{ cwid, isSuperuser }`, the shape the
 * `/edit/*` pages and `/api/edit/*` handlers (#356) consume.
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets and
 * TLS): this module, and anything importing it, must never be pulled into the
 * Edge middleware bundle — the same constraint `lib/auth/saml.ts` carries.
 *
 * The check is **fail-closed**: a missing group DN, an unreachable directory,
 * a bind failure, or a search error all resolve to "not a superuser". A
 * directory problem can never *grant* the admin tier.
 */
import { getSuperuserConfig } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session-server";
import { DEFAULT_SEARCH_BASE, openLdap } from "@/lib/sources/ldap";

/** B01 identity (`cwid`) paired with the live B02 superuser verdict. */
export interface EditSession {
  cwid: string;
  isSuperuser: boolean;
}

/**
 * Escape a value for safe interpolation into an LDAP search filter (RFC 4515).
 * The CWID comes from the validated SAML assertion, but an authorization
 * filter must not be injectable regardless. NUL — the fifth RFC 4515
 * metacharacter — cannot occur in a CWID (XML character data forbids it) and
 * is not handled here.
 */
function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      default:
        return "\\29";
    }
  });
}

/** One structured log line for a directory-side failure of the superuser check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(
    JSON.stringify({ event: "superuser_check_failed", reason, cwid }),
  );
}

/**
 * Whether `cwid` is a member of the `scholars-admins` group, by a live LDAPS
 * membership search. Never throws — every failure mode resolves to `false`.
 */
export async function isSuperuser(cwid: string): Promise<boolean> {
  if (!cwid) return false;
  const { adminGroupDn } = getSuperuserConfig();
  // Group not provisioned yet — the admin tier is dormant, not broken.
  if (!adminGroupDn) return false;

  let client: Awaited<ReturnType<typeof openLdap>>;
  try {
    client = await openLdap();
  } catch {
    // No LDAP config, host unreachable, or bind rejected — fail closed.
    logCheckFailed(cwid, "ldap_unavailable");
    return false;
  }

  try {
    const base = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
    // One minimal query: does a person entry for this CWID also carry the
    // admin group in `memberOf`? `dn` only — existence is the whole answer,
    // and an authorization probe has no business reading person attributes.
    const filter = `(&(uid=${escapeLdapFilterValue(cwid)})(memberOf=${adminGroupDn}))`;
    const { searchEntries } = await client.search(base, {
      scope: "sub",
      filter,
      attributes: ["dn"],
    });
    return searchEntries.length > 0;
  } catch {
    // Search timed out or the directory returned an error — fail closed.
    logCheckFailed(cwid, "ldap_search_failed");
    return false;
  } finally {
    await client.unbind().catch(() => {});
  }
}

/**
 * The current edit session: B01's identity plus the live `isSuperuser` verdict.
 * `null` when unauthenticated — the caller's gate (B01 middleware, and the
 * per-route check) handles the 401 / redirect. Resolved fresh on every call;
 * the group claim is never cached for the session.
 */
export async function getEditSession(): Promise<EditSession | null> {
  const session = await getSession();
  if (!session) return null;
  return { cwid: session.cwid, isSuperuser: await isSuperuser(session.cwid) };
}
