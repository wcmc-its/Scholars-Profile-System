/**
 * ED ETL — the title-resolution post-pass.
 *
 * Runs AFTER the leader assignments are written, because two of the tiers
 * (`chief`, `centerHead`) are `OrgUnitRoleAssignment` rows this same run
 * produces. The scholar upsert earlier in the run writes the ED value into
 * `Scholar.primaryTitle` as a seed and the raw tiers into
 * `Scholar.edPrimaryTitle` / `Scholar.workingTitle`; this pass computes the
 * winner and overwrites `primaryTitle` where it differs.
 *
 * Writing the RESOLVED value into the column every render surface already
 * reads is what keeps this change to zero read-site edits — search hits,
 * `/og` cards, popovers, result cards, the profile sidebar and `/edit` all
 * follow for free.
 *
 * SELF-HEALING IN BOTH DIRECTIONS. Because this pass recomputes every
 * scholar's title from scratch rather than only touching the ones it knows
 * changed, a scholar who stops being a chief, loses an ED working title, or
 * has their override cleared reverts on the next nightly with no backfill. It
 * is also what makes the feature flag safe to turn OFF: with the flag off the
 * resolver sees only the override and the ED primary title, so flipping it
 * back restores today's titles on the next run instead of stranding scholars
 * on a title nobody can reach.
 *
 * COST. One `findMany` over ~8,800 narrow scholar rows, three small
 * assignment/unit reads, one current-appointment read, one `field_override`
 * read, then an update ONLY where the resolved value differs from what is
 * stored — steady state is ~80 updates. No per-scholar round trip.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { CENTER_ENTITY_TYPE } from "@/lib/org-unit-roles";
import {
  isCenterDirector,
  loadCurrentAppointmentTitles,
  loadInstitutionalCenterCodes,
} from "@/lib/edit/title-picker";
import {
  ambiguousUnitNames,
  formatUnitLeadershipTitle,
  resolveScholarTitle,
} from "@/lib/scholar-title";

/** The Prisma surface this pass needs — base client or interactive tx. */
type TitleResolutionClient = Pick<
  PrismaClient,
  | "scholar"
  | "orgUnitRoleAssignment"
  | "division"
  | "center"
  | "centerProgram"
  | "fieldOverride"
  | "appointment"
>;

export type TitleResolutionResult = {
  scanned: number;
  updated: number;
  /** Rows left alone because every tier resolved empty — see the guard in
   *  the loop. Should be 0; non-zero means the ED feed under-delivered. */
  skippedNullResolution: number;
  /** How many scholars ended on each tier. Diagnostics for the run log — a
   *  sudden collapse in `working` means ED stopped serving the attribute. */
  byTier: Record<string, number>;
};

/**
 * Recompute `Scholar.primaryTitle` for every non-deleted scholar.
 *
 * `applyDerivedTiers` is the `SCHOLAR_TITLE_RESOLUTION` flag. When false only
 * the operator override and the ED primary title participate, which is exactly
 * today's behaviour plus the override — see the self-healing note above.
 */
export async function resolveScholarTitles(
  client: TitleResolutionClient,
  opts: { applyDerivedTiers: boolean },
): Promise<TitleResolutionResult> {
  const [scholars, overrideRows] = await Promise.all([
    client.scholar.findMany({
      where: { deletedAt: null },
      select: { cwid: true, primaryTitle: true, edPrimaryTitle: true, workingTitle: true },
    }),
    client.fieldOverride.findMany({
      where: { entityType: "scholar", fieldName: "primaryTitle" },
      select: { entityId: true, value: true },
    }),
  ]);
  const overrides = new Map(overrideRows.map((o) => [o.entityId, o.value]));

  const [{ chiefTitles, centerTitles }, appointmentTitles] = opts.applyDerivedTiers
    ? await Promise.all([loadLeadershipTitles(client), loadCurrentAppointmentTitles(client)])
    : [
        {
          chiefTitles: new Map<string, string>(),
          centerTitles: new Map<string, CenterTitle>(),
        },
        new Map<string, string[]>(),
      ];

  const byTier: Record<string, number> = {};
  let updated = 0;
  // Scholars holding a title that this run could not re-derive. Non-zero is
  // a signal worth reading in the run log: it means the ED feed is missing
  // rows the DB still considers active.
  let skippedNullResolution = 0;

  for (const s of scholars) {
    const resolved = resolveScholarTitle({
      override: overrides.get(s.cwid) ?? null,
      workingTitle: opts.applyDerivedTiers ? s.workingTitle : null,
      appointmentTitles: appointmentTitles.get(s.cwid) ?? [],
      chiefTitle: chiefTitles.get(s.cwid) ?? null,
      centerHeadTitle: centerTitles.get(s.cwid)?.title ?? null,
      centerHeadInstitutional: centerTitles.get(s.cwid)?.institutional ?? false,
      edPrimaryTitle: s.edPrimaryTitle,
    });

    const key = resolved.overridden ? "override" : (resolved.tier ?? "none");
    byTier[key] = (byTier[key] ?? 0) + 1;

    // A NULL resolution means we have NO INFORMATION about this scholar's
    // title this run — every tier came back empty — not that their title
    // should be cleared. Writing it would turn a degraded read into a wipe:
    // the scholar upsert only populates `edPrimaryTitle` for cwids present in
    // THIS ED feed, so any active row the feed missed would have its public
    // title blanked. A completed run soft-deletes those first, so the window
    // is narrow; it is guarded anyway because the failure is silent, public,
    // and one line to prevent. A scholar who genuinely has no title already
    // holds NULL, so skipping is a no-op for them.
    if (resolved.value === null) {
      if (s.primaryTitle !== null) skippedNullResolution++;
      continue;
    }
    if (resolved.value !== s.primaryTitle) {
      await client.scholar.update({
        where: { cwid: s.cwid },
        data: { primaryTitle: resolved.value },
      });
      updated++;
    }
  }

  return { scanned: scholars.length, updated, byTier, skippedNullResolution };
}

type CenterTitle = { title: string; institutional: boolean };

/**
 * Build cwid → formatted title for the division-chief and center-head tiers.
 *
 * `profileTitle` on the vocabulary entry is what decides whether holding a
 * role is a title at all — the same gate `lib/api/profile.ts` uses for
 * `leadershipTitles` (#1266), so the two cannot disagree about which roles
 * count.
 *
 * A scholar holding the same role on two units keeps the FIRST by
 * `(sortOrder, entityId)` — the same ordering the profile loader uses. Probed
 * 2026-09-22: nobody currently holds two division-chief or two center
 * leadership rows, so this tiebreak is defensive rather than load-bearing.
 */
async function loadLeadershipTitles(client: TitleResolutionClient): Promise<{
  chiefTitles: Map<string, string>;
  centerTitles: Map<string, CenterTitle>;
}> {
  const [divAssignments, centerAssignments, divisions, centers, institutionalCenters] = await Promise.all([
    client.orgUnitRoleAssignment.findMany({
      where: { entityType: "division", role: { roleGroup: "leadership", profileTitle: true } },
      select: {
        cwid: true,
        entityId: true,
        interim: true,
        role: { select: { label: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { entityId: "asc" }],
    }),
    client.orgUnitRoleAssignment.findMany({
      where: {
        entityType: CENTER_ENTITY_TYPE,
        role: { roleGroup: "leadership", profileTitle: true },
      },
      select: {
        cwid: true,
        entityId: true,
        interim: true,
        role: { select: { key: true, label: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { entityId: "asc" }],
    }),
    client.division.findMany({
      select: { code: true, name: true, department: { select: { name: true } } },
    }),
    client.center.findMany({ select: { code: true, name: true, officialName: true } }),
    loadInstitutionalCenterCodes(client),
  ]);

  // Ambiguity is computed from the whole unit table, not from the units that
  // happen to have a leader — otherwise "Cardiology" would read as unique on a
  // run where only one of the two divisions had a chief.
  const ambiguousDivisions = ambiguousUnitNames(divisions);
  const divisionByCode = new Map(divisions.map((d) => [d.code, d]));
  const centerNameByCode = new Map(centers.map((c) => [c.code, c.officialName ?? c.name]));

  const chiefTitles = new Map<string, string>();
  for (const a of divAssignments) {
    if (chiefTitles.has(a.cwid)) continue;
    const division = divisionByCode.get(a.entityId);
    // A row whose unit vanished contributes no title rather than a
    // half-rendered one — same posture as the profile loader.
    if (!division) continue;
    chiefTitles.set(
      a.cwid,
      formatUnitLeadershipTitle({
        roleLabel: a.role.label,
        interim: a.interim,
        unitName: division.name,
        parentName: division.department?.name ?? null,
        ambiguous: ambiguousDivisions.has(division.name.trim().toLowerCase()),
      }),
    );
  }

  const centerTitles = new Map<string, CenterTitle>();
  for (const a of centerAssignments) {
    if (!isCenterDirector(a)) continue;
    const institutional = institutionalCenters.has(a.entityId);
    // Keep the first directorship, unless a later one is institutional and
    // the kept one is not — rank 5 beats rank 10.
    const kept = centerTitles.get(a.cwid);
    if (kept && (kept.institutional || !institutional)) continue;
    const name = centerNameByCode.get(a.entityId);
    if (!name) continue;
    centerTitles.set(a.cwid, {
      // Centers are institution-wide, so their names do not collide the way
      // two departments' divisions do — no qualifier tier for them.
      title: formatUnitLeadershipTitle({
        roleLabel: a.role.label,
        interim: a.interim,
        unitName: name,
      }),
      institutional,
    });
  }

  return { chiefTitles, centerTitles };
}
