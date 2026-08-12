/**
 * `/edit/reports/4` — "Grants active as of a date" (report 4 of the
 * `/edit/reports/*` console, `app/edit/reports/4/page.tsx`).
 *
 * One row per `Grant` row held by a Cancer Center member — NOT deduped into
 * multi-investigator "projects" the way `lib/api/unit-grant-projects.ts`
 * does for the public department/division Grants tabs. `Grant.externalId` is
 * `INFOED-{account}-{cwid}`, i.e. one row per (grant, investigator), so a
 * shared award with two center members already yields two rows here — which
 * is what this report wants (each member's own role on their own row), not
 * the public tabs' one-card-per-project collapse.
 *
 * Membership resolution reuses `loadActiveCenterMemberCwids` (the same § 3.3
 * active-date-window + non-deleted/`status='active'` gate every other center
 * surface — publications, top research areas, the collaboration network —
 * already applies) rather than re-querying `CenterMembership` here, so this
 * report's roster can never drift from what those surfaces call "this
 * center's members."
 *
 * `source: { not: "RePORTER" }` excludes the NIH RePORTER portfolio backfill
 * (#1307) — a scholar's prior-institution/history rows, not WCM-administered
 * awards — mirroring `buildAwards` (`lib/api/center-collaboration.ts`) and
 * the center roster's per-member grant count (`lib/api/centers.ts`).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadActiveCenterMemberCwids } from "@/lib/api/centers";
import { isFundingActiveAsOf } from "@/lib/funding-active";
import { extractLastNameSort } from "@/lib/name-sort";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";

/** Minimal client surface for {@link loadCenterActiveGrants}. */
export type CenterActiveGrantsClient = Pick<PrismaClient, "grant" | "scholar">;

export type CenterActiveGrant = {
  cwid: string;
  /** The member's display name — the person this `Grant` row belongs to,
   *  regardless of `role` (a Co-I's row is still "theirs", not the PI's). */
  piName: string;
  title: string;
  /** Same fold the self-edit Funding panel uses (`lib/api/edit-context.ts`
   *  `funderLabel`): the structured `primeSponsor`, else a canonicalization
   *  of the raw sponsor string, else the legacy pre-rendered `funder`. */
  sponsor: string;
  role: string;
  startDate: Date;
  endDate: Date;
};

/**
 * Active-as-of-`asOfDate` `Grant` rows for a Cancer Center's members, sorted
 * by the row's member's last name (then full name to break ties) — the DT2A
 * "alphabetical by principal investigator's last name" convention, applied
 * to whichever member the row belongs to since `Grant` carries no separate
 * "the PI" pointer distinct from the investigator each row already names.
 */
export async function loadCenterActiveGrants(
  centerCode: string,
  asOfDate: Date,
  db: CenterActiveGrantsClient,
): Promise<CenterActiveGrant[]> {
  const memberCwids = await loadActiveCenterMemberCwids(centerCode);
  if (memberCwids.length === 0) return [];

  const grants = (await db.grant.findMany({
    where: { cwid: { in: memberCwids }, source: { not: "RePORTER" } },
    select: {
      cwid: true,
      title: true,
      role: true,
      funder: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      startDate: true,
      endDate: true,
    },
  })) as Array<{
    cwid: string;
    title: string;
    role: string;
    funder: string;
    primeSponsor: string | null;
    primeSponsorRaw: string | null;
    startDate: Date;
    endDate: Date;
  }>;

  const active = grants.filter((g) => isFundingActiveAsOf(g, asOfDate));
  if (active.length === 0) return [];

  const scholars = await db.scholar.findMany({
    where: { cwid: { in: [...new Set(active.map((g) => g.cwid))] } },
    select: { cwid: true, preferredName: true },
  });
  const nameByCwid = new Map(scholars.map((s) => [s.cwid, s.preferredName]));

  return active
    .map((g) => ({
      cwid: g.cwid,
      piName: nameByCwid.get(g.cwid) ?? g.cwid,
      title: g.title,
      sponsor: g.primeSponsor ?? canonicalizeSponsor(g.primeSponsorRaw) ?? g.funder,
      role: g.role,
      startDate: g.startDate,
      endDate: g.endDate,
    }))
    .sort(
      (a, b) =>
        extractLastNameSort(a.piName).localeCompare(extractLastNameSort(b.piName)) ||
        a.piName.localeCompare(b.piName),
    );
}
