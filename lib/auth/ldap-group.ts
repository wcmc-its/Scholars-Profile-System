/**
 * Shared ED group-membership check for the three role modules (`superuser`,
 * `comms-steward`, `development`), which all ask the same question: does the
 * group named by a `cn` carry this CWID's person DN in `member`?
 *
 * WHY THIS IS NOT A SINGLE FILTERED SEARCH
 * ----------------------------------------
 * The obvious shape — one subtree search under `ou=Groups` with the predicate
 * `(&(cn=<group>)(member=<userDn>))` — is what these modules used to do, and it
 * **times out** (measured 20–30 s, in-VPC, staging). The Scholars role groups are
 * OpenLDAP *dynamic* groups (`objectClass: groupOfURLs`): membership is stored as
 * a `memberURL` LDAP-URL, and `member` is synthesized on demand by the dynlist
 * overlay. A `member` predicate anywhere in a subtree search therefore forces the
 * server to expand every dynamic group under the base — there is no index to use.
 *
 * The working shape is two cheap round trips (~230 ms total, measured):
 *   1. Resolve the group's DN by `cn` alone — no `member` predicate, so no
 *      expansion. The role groups live in containers under `ou=Groups` (e.g.
 *      `ou=application security`), so this must stay a subtree search.
 *   2. Ask the server to evaluate membership *at that one entry* with an LDAP
 *      `compare` op. dynlist expands exactly one group, and the directory answers
 *      true/false without ever returning member values (the read-only bind account
 *      can compare `member` but not read it, so a base-scope read comes back empty
 *      — do not "optimize" this into a read + client-side scan; it silently
 *      evaluates to "not a member" for everyone).
 *
 * Fail-closed: every failure mode (group missing, compare error, directory down)
 * resolves to `false`. A directory problem can never *grant* a role.
 *
 * Node-runtime only (see `lib/sources/ldap.ts`) — never pull into Edge middleware.
 */
import { DEFAULT_SEARCH_BASE, openLdap } from "@/lib/sources/ldap";

/** The Enterprise Directory container holding group objects. */
export const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";

/**
 * Escape a value for safe interpolation into an LDAP search filter (RFC 4515).
 * Used for the group `cn` (operator-set env, but an authorization filter must not
 * be injectable regardless). NUL — the fifth RFC 4515 metacharacter — cannot
 * occur here and is not handled.
 */
export function escapeLdapFilterValue(value: string): string {
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

/**
 * A CWID safe to splice into a DN. The CWID arrives from a validated SAML
 * assertion, but authorization must not trust that. Note it no longer flows into
 * a *filter* (the membership question is an LDAP `compare`, whose assertion value
 * is not parsed as a filter), so RFC 4515 escaping would be the wrong tool here —
 * it would only produce a literal that matches nothing. A conservative charset
 * allowlist is both simpler and stricter: anything else fails closed.
 */
export function isSafeCwid(cwid: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(cwid);
}

/** The person DN a group's `member` values point at. Caller must pass a safe cwid. */
export function personDn(cwid: string): string {
  const peopleBase = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
  return `uid=${cwid},${peopleBase}`;
}

/**
 * Whether `cwid` is a member of the group named `groupCn`, by a live LDAPS
 * lookup. Never throws — every failure resolves to `false`.
 *
 * `onFailure` receives a short reason for the caller's structured warn log.
 */
export async function isGroupMember(
  groupCn: string,
  cwid: string,
  onFailure: (reason: string) => void,
): Promise<boolean> {
  // Reject anything that can't be a CWID before it reaches a DN — fail closed.
  if (!isSafeCwid(cwid)) {
    onFailure("invalid_cwid");
    return false;
  }

  let client: Awaited<ReturnType<typeof openLdap>>;
  try {
    client = await openLdap();
  } catch {
    // No LDAP config, host unreachable, or bind rejected — fail closed.
    onFailure("ldap_unavailable");
    return false;
  }

  try {
    // 1. Resolve the group DN by cn only. No `member` predicate — see the note
    //    above; adding one here is what made this a 20–30 s timeout.
    const { searchEntries } = await client.search(GROUPS_BASE, {
      scope: "sub",
      filter: `(cn=${escapeLdapFilterValue(groupCn)})`,
      attributes: ["cn"],
    });
    const groupDn = searchEntries[0]?.dn;
    if (!groupDn) {
      // Group cn not present in the directory — dormant, not broken.
      onFailure("group_not_found");
      return false;
    }
    // 2. Compare at that single entry: dynlist expands one group, and the server
    //    answers the membership question directly.
    return await client.compare(String(groupDn), "member", personDn(cwid));
  } catch {
    // Search/compare timed out or the directory returned an error — fail closed.
    onFailure("ldap_search_failed");
    return false;
  } finally {
    await client.unbind().catch(() => {});
  }
}
