/**
 * Center membership predicates + counting — deliberately DB-FREE.
 *
 * Everything here takes its Prisma client as a parameter and imports only the
 * PrismaClient *type* (erased at compile). Nothing in this module may import
 * `@/lib/db`.
 *
 * That constraint is load-bearing, not stylistic. `lib/edit/manageable-units.ts`
 * is server-only by convention but carries no `server-only` import (so its unit
 * tests can load it with a fake client), and it is reachable from the client
 * bundle via `components/edit/home-panel.tsx`. Importing these helpers from
 * `lib/api/centers.ts` — which constructs `prisma` at module scope — dragged the
 * mariadb driver into that bundle and broke the Next build on unresolvable `fs`
 * and `net`. Splitting them out keeps the count reusable from both the public
 * data layer and the editor without either pulling a driver into the browser.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * #552 § 3.3 — the load-bearing membership active predicate. A membership is
 * active when today falls within `[startDate, endDate]`, both ends inclusive,
 * with a null bound treated as open. This mirrors the editor's `statusOf`
 * (`components/edit/center-roster-card.tsx`) exactly: `today` is a `YYYY-MM-DD`
 * string and the `@db.Date` bounds are compared as their UTC date strings, so
 * the date-only columns never get mis-compared against a time-carrying instant.
 */
export function isCenterMembershipActive(
  startDate: Date | null,
  endDate: Date | null,
  today: string,
): boolean {
  const start = startDate ? startDate.toISOString().slice(0, 10) : null;
  const end = endDate ? endDate.toISOString().slice(0, 10) : null;
  if (start && start > today) return false; // pending
  if (end && end < today) return false; // inactive
  return true;
}

/** UTC date string for "now", matching the editor's `todayIso`. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Minimal client surface for {@link countActiveCenterMembersByCode}. */
export type CenterMemberCountClient = Pick<PrismaClient, "centerMembership" | "scholar">;

/**
 * Active member count per center, batched across many centers.
 *
 * `Center.scholarCount` is a denormalized column that NOTHING maintains: the ED
 * ETL's Phase 3 count refresh iterates departments and divisions only, and the
 * roster write path never touches it. It is `@default(0)`, so every manually
 * created center reported "0 scholars" on `/edit/units` and `/browse` forever
 * while its public page — which computes the count live — showed the real
 * number. Listing surfaces call this instead of reading the column.
 *
 * Applies the SAME gate as `loadActiveCenterMemberCwids` (§ 3.3 date window,
 * then non-deleted + `status='active'` Scholar) so a center's count means the
 * same thing everywhere, and so "scholars" in the `/edit/units` table is
 * comparable across kinds — dept/division counts are `scholar.count` under that
 * identical predicate, and that column sorts across all three kinds.
 *
 * Two queries regardless of center count, matching the batched posture of the
 * directory loader that calls it.
 */
export async function countActiveCenterMembersByCode(
  client: CenterMemberCountClient,
  centerCodes: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (centerCodes.length === 0) return counts;

  const today = todayIso();
  const rows = (await client.centerMembership.findMany({
    where: { centerCode: { in: centerCodes } },
    select: { centerCode: true, cwid: true, startDate: true, endDate: true },
  })) as Array<{
    centerCode: string;
    cwid: string;
    startDate: Date | null;
    endDate: Date | null;
  }>;
  const active = rows.filter((r) => isCenterMembershipActive(r.startDate, r.endDate, today));
  if (active.length === 0) return counts;

  const scholars = await client.scholar.findMany({
    where: {
      cwid: { in: [...new Set(active.map((r) => r.cwid))] },
      deletedAt: null,
      status: "active",
    },
    select: { cwid: true },
  });
  const visible = new Set(scholars.map((s) => s.cwid));

  for (const r of active) {
    if (visible.has(r.cwid)) counts.set(r.centerCode, (counts.get(r.centerCode) ?? 0) + 1);
  }
  return counts;
}
