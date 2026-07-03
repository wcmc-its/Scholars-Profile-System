/**
 * Access gate for the global Usage dashboard (`/edit/usage`): a **superuser**,
 * or **any unit administrator** — a person holding at least one `UnitAdmin`
 * grant (owner OR curator). The dashboard shows site-wide aggregates only, so a
 * unit admin sees the same global view a superuser does (decision 2026-07-03);
 * there is no per-unit scoping to resolve, hence a plain existence check rather
 * than the owner-subtree resolver in `administrators.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The one Prisma model this check needs — keeps callers/tests minimal. */
export type UsageAccessClient = Pick<PrismaClient, "unitAdmin">;

/** The session fields the check reads (structural — decoupled from EditSession). */
export type UsageViewer = { cwid: string; isSuperuser: boolean };

/**
 * True if `viewer` may see the Usage dashboard: a superuser, or the holder of
 * any `UnitAdmin` grant (either role). Superuser short-circuits before any DB
 * read.
 */
export async function canViewUsage(
  viewer: UsageViewer,
  db: UsageAccessClient,
): Promise<boolean> {
  if (viewer.isSuperuser) return true;
  const grant = await db.unitAdmin.findFirst({
    where: { cwid: viewer.cwid },
    select: { cwid: true },
  });
  return grant !== null;
}
