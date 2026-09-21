/**
 * Access gate for the global Usage dashboard (`/edit/usage`) — and, by reuse,
 * `/edit/orcid-coverage` and the Article-counts report: a **superuser**, or
 * **any org-unit administrator** — a person holding at least one `UnitAdmin`
 * grant (owner OR curator) on a department / division / center / core. The
 * dashboard shows site-wide aggregates only, so a unit admin sees the same
 * global view a superuser does (decision 2026-07-03); there is no per-unit
 * scoping to resolve, hence a plain existence check rather than the
 * owner-subtree resolver in `administrators.ts`.
 *
 * An `institution` grant (#2695 — an admin at an affiliate such as Hamad,
 * scoped to that institution's scholars) does NOT qualify: WCM-wide usage and
 * ORCID coverage are internal aggregates (decision 2026-09-21).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The one Prisma model this check needs — keeps callers/tests minimal. */
export type UsageAccessClient = Pick<PrismaClient, "unitAdmin">;

/** The session fields the check reads (structural — decoupled from EditSession). */
export type UsageViewer = { cwid: string; isSuperuser: boolean };

/** The grant kinds that confer the WCM-wide view — every org-unit kind, never
 *  `institution`. An allowlist (not `not: "institution"`) so a future kind is
 *  excluded until someone decides otherwise. */
const USAGE_GRANT_KINDS = ["department", "division", "center", "core"] as const;

/**
 * True if `viewer` may see the Usage dashboard: a superuser, or the holder of
 * any org-unit `UnitAdmin` grant (either role). Superuser short-circuits before
 * any DB read.
 */
export async function canViewUsage(
  viewer: UsageViewer,
  db: UsageAccessClient,
): Promise<boolean> {
  if (viewer.isSuperuser) return true;
  const grant = await db.unitAdmin.findFirst({
    where: { cwid: viewer.cwid, entityType: { in: [...USAGE_GRANT_KINDS] } },
    select: { cwid: true },
  });
  return grant !== null;
}
