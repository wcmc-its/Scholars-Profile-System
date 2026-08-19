/**
 * The global, LDAP-group-sourced roles "View as" (#637) needs to recognize as
 * assumable targets, beyond `comms_steward` (which keeps its own dedicated
 * code path — steward-directory name resolution — throughout the
 * impersonation routes and is deliberately NOT folded in here).
 *
 * Each role already has its own narrow `is<Role>` predicate
 * (`lib/auth/cv-generator.ts`, `honors-curator.ts`, `data-sharing-viewer.ts`,
 * `development.ts`) — by design, per every one of those modules' own
 * docblocks: "a non-superuser global role is always added via a narrow
 * predicate at its own surface, never by widening a shared one." This module
 * does not touch that; it only gives the impersonation POST target-check and
 * the session-probe display resolution ONE place to ask "is this CWID any of
 * them", instead of hand-listing all four at every call site. A future 5th
 * narrow role module plugs in here with one line.
 *
 * **Ceiling, not a gap to "fix" later.** Membership can only be checked
 * per-CWID (`isGroupMember`'s LDAP `compare`, `lib/auth/ldap-group.ts`) — the
 * read-only bind account can compare `member` but cannot READ the list, so
 * there is no way to enumerate who holds a role. "View as" can start a
 * session for any of these roles once you know the CWID; it can never offer
 * them as browsable search results. Any future role added to the table below
 * inherits the same ceiling.
 *
 * Node-runtime only (every predicate here reuses `lib/sources/ldap.ts`) —
 * never pull this into the Edge middleware bundle or a client component.
 */
import { isCvGenerator } from "@/lib/auth/cv-generator";
import { isHonorsCurator } from "@/lib/auth/honors-curator";
import { isDataSharingViewer } from "@/lib/auth/data-sharing-viewer";
import { isDeveloper } from "@/lib/auth/development";

export type GlobalRole = "cv_generator" | "honors_curator" | "data_sharing_viewer" | "development";

/** Display label per role — reused by the session route; client components
 *  (banner) keep their own copy rather than import this Node-only module. */
export const GLOBAL_ROLE_LABEL: Record<GlobalRole, string> = {
  cv_generator: "CV Generator",
  honors_curator: "Honors Curator",
  data_sharing_viewer: "Data Sharing Viewer",
  development: "Development",
};

/** Each role's one console entry point (every one of these modules' own
 *  docblock names its single surface) — reused by `/edit`'s profile-less
 *  fallthrough (`app/edit/page.tsx`) so a global-role holder with no Scholar
 *  row lands on their actual page instead of 404ing. */
export const GLOBAL_ROLE_HOME: Record<GlobalRole, string> = {
  cv_generator: "/edit/scholars",
  honors_curator: "/edit/honors-queue",
  data_sharing_viewer: "/edit/data-sharing",
  development: "/edit/find-researchers",
};

const GLOBAL_ROLE_CHECKS: ReadonlyArray<{ role: GlobalRole; check: (cwid: string) => Promise<boolean> }> = [
  { role: "cv_generator", check: isCvGenerator },
  { role: "honors_curator", check: isHonorsCurator },
  { role: "data_sharing_viewer", check: isDataSharingViewer },
  { role: "development", check: isDeveloper },
];

/**
 * The first matching role for `cwid` (table order breaks a multi-role tie —
 * membership in more than one of these is not expected but not impossible).
 * `null` if none match. Fail-closed: a thrown predicate counts as "not this
 * role", never as a grant. Checked in PARALLEL — each predicate is its own
 * LDAP round trip, and this sits in the impersonation POST/probe request
 * path, so latency is bounded to the slowest single check, not their sum.
 */
export async function resolveGlobalRole(cwid: string): Promise<GlobalRole | null> {
  if (!cwid) return null;
  const results = await Promise.all(GLOBAL_ROLE_CHECKS.map(({ check }) => check(cwid).catch(() => false)));
  const i = results.findIndex(Boolean);
  return i === -1 ? null : GLOBAL_ROLE_CHECKS[i].role;
}
