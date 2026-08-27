/**
 * Cornell (Ithaca) external-member render helpers — #2519 PR 2
 * (`docs/2026-08-26-cornell-ithaca-membership-SPEC.md` §6). Shared by the
 * center (`lib/api/centers.ts`) and division (`lib/api/divisions.ts`) roster
 * readers so the "left-join `ExternalMember` instead of `Scholar`" logic
 * lives in one place rather than being duplicated per unit type.
 *
 * A Cornell external member never has a `Scholar` row (see the
 * `ExternalMember` model doc, PR 1) — `buildExternalMemberHit` shapes an
 * `ExternalMember` row into the SAME hit shape (`DepartmentFacultyHit`) the
 * WCM roster path produces, so `PersonRow` renders both without a fork in the
 * list-rendering code, only in the profile-link decision (`isExternal`).
 *
 * Every export here is gated at the CALL SITE by
 * `isCornellDirectoryMembersEnabled()` — nothing in this module reads the
 * flag itself, so a caller that forgets the gate fails open, not closed. Both
 * current callers (centers, divisions) check the flag before importing any
 * cwid into a query that reaches this module.
 */
import { prisma } from "@/lib/db";
import type { ExternalMember } from "@/lib/generated/prisma/client";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

/**
 * Batch-load `ExternalMember` rows by cuid (Cornell NetID), keyed for O(1)
 * lookup against a membership row's `cwid` column. One query regardless of
 * how many netids are requested; an empty `cuids` list short-circuits to an
 * empty map with no query.
 */
export async function loadExternalMembersByCuid(
  cuids: string[],
): Promise<Map<string, ExternalMember>> {
  if (cuids.length === 0) return new Map();
  const rows = await prisma.externalMember.findMany({
    where: { cuid: { in: cuids } },
  });
  return new Map(rows.map((r) => [r.cuid, r]));
}

/**
 * The Cornell (Ithaca) people-directory SSO landing page for one NetID — the
 * external member's stand-in for a WCM profile link (§ DECISIONS: "Cornell
 * members render inline ... with an external link to
 * `cornell.edu/search/sso/people.cfm?netid=<netid>`", opened in a new tab).
 */
export function cornellDirectoryUrl(netid: string): string {
  return `https://www.cornell.edu/search/sso/people.cfm?netid=${encodeURIComponent(netid)}`;
}

/** A Cornell external member shaped for the roster hit list. Structurally a
 *  `DepartmentFacultyHit` (so it slots into any WCM hit array unchanged) plus
 *  an explicit external marker: `isExternal` (never set on a WCM hit) and the
 *  precomputed `externalProfileUrl` — precomputed, not left for `PersonRow` to
 *  derive, so no CLIENT component ever needs to import this module (which
 *  pulls in `@/lib/db`/prisma at module scope; see the `manageable-units.ts`
 *  client-bundle trap in CLAUDE.md). */
export type ExternalMemberHit = DepartmentFacultyHit & {
  isExternal: true;
  externalProfileUrl: string;
};

/**
 * Project one `ExternalMember` row into a roster hit. `cwid` carries the
 * Cornell NetID (the disjoint-union identity, per the model doc) — there is
 * no WCM slug, so `slug` is `""` and `PersonRow` must check `isExternal`
 * BEFORE ever reading `slug`/`roleCategoryRaw` for the profile-link decision.
 * No pub/grant counts (a Cornell person has no `Publication`/`Grant` rows to
 * join) and no headshot lookup (`identityImageEndpoint: ""` forces
 * `HeadshotAvatar`'s initials fallback rather than a doomed WCM-directory
 * fetch for a Cornell netid).
 */
export function buildExternalMemberHit(m: ExternalMember): ExternalMemberHit {
  return {
    cwid: m.cuid,
    preferredName: m.displayName,
    slug: "",
    primaryTitle: m.title,
    divisionName: null,
    departmentName: m.dept ?? "",
    identityImageEndpoint: "",
    roleCategory: null,
    roleCategoryRaw: null,
    overview: null,
    pubCount: 0,
    grantCount: 0,
    isExternal: true,
    externalProfileUrl: cornellDirectoryUrl(m.cuid),
  };
}
