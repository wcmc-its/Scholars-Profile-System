/**
 * `cv_generator` role resolution (Faculty Affairs read-only rollout).
 *
 * `isCvGenerator(cwid)` answers "is this CWID a member of the cv-generator
 * group?" with a live LDAPS query against the WCM Enterprise Directory —
 * re-evaluated per request, never cached for the session, exactly like
 * `isSuperuser` (`lib/auth/superuser.ts`), `isCommsSteward`
 * (`lib/auth/comms-steward.ts`), `isHonorsCurator`
 * (`lib/auth/honors-curator.ts`), and `isDataSharingViewer`
 * (`lib/auth/data-sharing-viewer.ts`), which this module mirrors most closely
 * (same shape: no interim allowlist, one kill switch, one group). The verdict
 * is paired into `EditSession` as `isCvGenerator` by `getEditSession()` /
 * `getEffectiveEditSession()`.
 *
 * The role is **global** (not per-scholar, not unit-scoped) and grants
 * **read-only** access to every scholar's `/edit/scholar/[cwid]` surface plus
 * the `/edit/scholars` roster — the same content a superuser sees, but with
 * no write affordance anywhere. It exists for CV generation (staff who need
 * to browse a scholar's full profile to assemble a CV) and, more broadly, to
 * let Faculty Affairs staff see the tool without editing rights (#2482).
 *
 * WHY READ-ONLY FALLS OUT OF THE EXISTING CHOKEPOINT, NOT A NEW ONE.
 * `resolveScholarEditAccess` (`lib/edit/scholar-edit-access.ts`) is the GET
 * gate — admitting `isCvGenerator` there is enough to render the page. Every
 * mutation goes through a SEPARATE chokepoint: the `/api/edit/*` write
 * predicates in `lib/edit/authz.ts` (`authorizeFieldEdit`, `authorizeSuppress`,
 * `authorizeRevoke`, `canEditUnit`, …), all of which key off
 * `session.isSuperuser` / `session.isCommsSteward` / an `EffectiveUnitRole`.
 * `isCvGenerator` is deliberately never referenced there, so every mutation
 * 403s for this role automatically — read access without write access is a
 * property of what this module does NOT touch, not something it enforces
 * itself.
 *
 * WHY A NEW ROLE AND NOT `comms_steward` / `superuser`. Both already carry
 * write capability; granting either to a broad read-only audience (to
 * "socialize the app") would hand out edit rights nobody asked for. A
 * non-superuser global role is always added via a narrow predicate at its own
 * surface, never by widening a shared one — same reasoning as
 * `honors-curator.ts` / `data-sharing-viewer.ts`'s own docblocks.
 *
 * The cv-generator group is a real Enterprise Directory group object under
 * `ou=Groups` (cn env `SCHOLARS_CV_GENERATOR_GROUP_CN`, e.g.
 * `ITS:Library:Scholars/cv-generator-role`), structurally identical to its
 * siblings: an OpenLDAP *dynamic* group (`objectClass: groupOfURLs`) under
 * `ou=application security`, membership synthesized by the dynlist overlay.
 * See `lib/auth/ldap-group.ts` for why this is a group-DN resolve plus an
 * LDAP `compare`, not a single filtered search.
 *
 * Node-runtime only. Reuses `lib/sources/ldap.ts` (`ldapts` — Node sockets
 * and TLS): this module, and anything importing it, must never be pulled
 * into the Edge middleware bundle — the same constraint every sibling role
 * carries.
 *
 * The whole role is gated by the `CV_GENERATOR_ENABLED` kill switch: when it
 * is not `"on"`, `isCvGenerator` short-circuits to `false` before any
 * directory work, so the role is dormant for everyone.
 *
 * The check is **fail-closed**: a disabled flag, a missing group cn, an
 * unreachable directory, a bind failure, or a search error all resolve to
 * "not a cv generator". A directory problem can never *grant* the role.
 * Membership is a directory-side change, not a code deploy — adding or
 * removing a `memberURL` on the ED group takes effect immediately, with no
 * redeploy of this app.
 */
import { cache } from "react";

import { isGroupMember } from "@/lib/auth/ldap-group";

/**
 * Whether the `cv_generator` role is enabled at all (master kill switch).
 * `CV_GENERATOR_ENABLED` must be exactly `"on"`; any other value (unset,
 * `"off"`, anything else) leaves the role dormant — `isCvGenerator` returns
 * `false` for everyone.
 */
export function isCvGeneratorEnabled(): boolean {
  return process.env.CV_GENERATOR_ENABLED === "on";
}

/** One structured log line for a directory-side failure of the role check. */
function logCheckFailed(cwid: string, reason: string): void {
  console.warn(JSON.stringify({ event: "cv_generator_check_failed", reason, cwid }));
}

/**
 * Whether `cwid` is a member of the cv-generator group, by a live LDAPS
 * lookup of the group's `member` attribute. Never throws — every failure
 * mode (incl. the disabled kill switch) resolves to `false`.
 *
 * Wrapped in React `cache()`, keyed on `cwid` (mirroring `isSuperuser` /
 * `isHonorsCurator` / `isDataSharingViewer`), so a given CWID is resolved at
 * most once per server request. Request-scoped only: it does NOT cache
 * across requests or for the session, so the verdict is re-evaluated live on
 * every `/edit` GET.
 */
export const isCvGenerator = cache(async (cwid: string): Promise<boolean> => {
  // Master kill switch — short-circuit before any directory work. Flag-off
  // leaves the role dormant for everyone.
  if (!isCvGeneratorEnabled()) return false;
  if (!cwid) return false;
  const groupCn = process.env.SCHOLARS_CV_GENERATOR_GROUP_CN;
  // Group cn not configured yet — the role is dormant, not broken.
  if (!groupCn) return false;
  return isGroupMember(groupCn, cwid, (reason) => logCheckFailed(cwid, reason));
});
