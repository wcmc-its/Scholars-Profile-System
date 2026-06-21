/**
 * `development` role resolution (GrantRecs Phase 4 — the "Find researchers"
 * reverse-matcher admin surface, `2026-06-20-grantrecs-phase4-design-plan.md`).
 *
 * `isDeveloper(cwid)` answers "is this CWID a member of the development group?"
 * with a live LDAPS query against the WCM Enterprise Directory — re-evaluated
 * per request, never cached for the session, exactly like `isSuperuser`
 * (`lib/auth/superuser.ts`) and `isCommsSteward` (`lib/auth/comms-steward.ts`),
 * which this module mirrors. The verdict is paired into `EditSession` as
 * `isDeveloper` by `getEditSession()` / `getEffectiveEditSession()`.
 *
 * The role is **global** (not per-scholar, not unit-scoped). Its only purpose is
 * to open in-progress admin tooling — currently the `/edit/find-researchers`
 * page and its data route — to a tightly-scoped operator set WITHOUT making them
 * full superusers. It confers no profile-field writes and no other `/edit` tabs.
 * Superusers pass every `development` guard (superset) — that direction lives in
 * the authz predicate at the call site (`isSuperuser || isDeveloper`), not here.
 *
 * The development group is a real Enterprise Directory group object under
 * `ou=Groups` (cn env `SCHOLARS_DEVELOPMENT_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/development-role`); membership is the group's `member`
 * attribute, which lists person DNs (`uid=<cwid>,ou=people,…`). The check is one
 * subtree search under `ou=Groups`: does the named group carry this CWID's
 * person DN in `member`?
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets and
 * TLS): this module, and anything importing it, must never be pulled into the
 * Edge middleware bundle — the same constraint `lib/auth/superuser.ts` carries.
 *
 * The whole role is gated by the `DEVELOPMENT_ENABLED` kill switch: when it is
 * not `"on"`, `isDeveloper` short-circuits to `false` before any directory work,
 * so the role is dormant for everyone (the surface stays superuser-only).
 *
 * The check is **fail-closed**: a disabled flag, a missing group cn, an
 * unreachable directory, a bind failure, or a search error all resolve to "not
 * a developer". A directory problem can never *grant* the role.
 */
import { cache } from "react";
import { DEFAULT_SEARCH_BASE, openLdap } from "@/lib/sources/ldap";

/** The Enterprise Directory container holding group objects. */
const GROUPS_BASE = "ou=Groups,dc=weill,dc=cornell,dc=edu";

/**
 * Whether the `development` role is enabled at all (master kill switch).
 * `DEVELOPMENT_ENABLED` must be exactly `"on"`; any other value (unset, `"off"`,
 * anything else) leaves the role dormant — `isDeveloper` returns `false` for
 * everyone and the dev-only surfaces stay reachable to superusers only.
 */
export function isDevelopmentEnabled(): boolean {
  return process.env.DEVELOPMENT_ENABLED === "on";
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

/**
 * Dev/interim allowlist — confers the `development` role WITHOUT LDAP.
 * `SCHOLARS_DEVELOPMENT_ALLOWLIST` is a comma-separated CWID list, mirroring
 * `SCHOLARS_SUPERUSER_CWIDS` / `SCHOLARS_COMMS_STEWARD_ALLOWLIST`: the SPS VPC
 * has no route to the WCM directory yet, so the live group search below fails
 * closed; this is the operative membership mechanism today, keeping a
 * tightly-scoped operator set able to use the dev-only surfaces in the meantime.
 * Lower-cased + de-duplicated for case-insensitive matching; empty (the default)
 * is a no-op, leaving the LDAP group as the sole source of truth.
 */
function getDevelopmentAllowlist(): string[] {
  const raw = process.env.SCHOLARS_DEVELOPMENT_ALLOWLIST;
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
}

/** One structured log line for a directory-side failure of the development check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(
    JSON.stringify({ event: "development_check_failed", reason, cwid }),
  );
}

/**
 * Whether `cwid` is a member of the development group, by a live LDAPS search of
 * the group's `member` attribute. Never throws — every failure mode (incl. the
 * disabled kill switch) resolves to `false`.
 *
 * Wrapped in React `cache()`, keyed on `cwid` (mirroring `isSuperuser`), so a
 * given CWID is resolved at most once per server request — the LDAPS bind/search
 * is deduped when the same CWID is checked by both `getEffectiveEditSession` and
 * the per-route gate within one request. Request-scoped only: it does NOT cache
 * across requests or for the session, so the verdict is re-evaluated live on
 * every `/edit` GET and every guarded API call.
 */
export const isDeveloper = cache(async (cwid: string): Promise<boolean> => {
  // Master kill switch — short-circuit before any allowlist or directory work.
  // Flag-off leaves the role dormant for everyone.
  if (!isDevelopmentEnabled()) return false;
  if (!cwid) return false;
  // Interim allowlist — confers the role WITHOUT LDAP, checked before any
  // directory work (VPC↔WCM routing pending, so the live search fails closed).
  // Matched case-insensitively; empty/unset => no-op.
  if (getDevelopmentAllowlist().includes(cwid.toLowerCase())) return true;
  const groupCn = process.env.SCHOLARS_DEVELOPMENT_GROUP_CN;
  // Group cn not configured yet — the role is dormant, not broken.
  if (!groupCn) return false;

  let client: Awaited<ReturnType<typeof openLdap>>;
  try {
    client = await openLdap();
  } catch {
    // No LDAP config, host unreachable, or bind rejected — fail closed.
    logCheckFailed(cwid, "ldap_unavailable");
    return false;
  }

  try {
    const peopleBase =
      process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
    const userDn = `uid=${escapeLdapFilterValue(cwid)},${peopleBase}`;
    // One subtree search under ou=Groups: the named group, carrying this
    // person's DN in `member`. `cn` only — existence is the whole answer.
    const filter = `(&(cn=${escapeLdapFilterValue(groupCn)})(member=${userDn}))`;
    const { searchEntries } = await client.search(GROUPS_BASE, {
      scope: "sub",
      filter,
      attributes: ["cn"],
    });
    return searchEntries.length > 0;
  } catch {
    // Search timed out or the directory returned an error — fail closed.
    logCheckFailed(cwid, "ldap_search_failed");
    return false;
  } finally {
    await client.unbind().catch(() => {});
  }
});
