/**
 * Volunteers (and interns, whom ED records as volunteers) → the faculty member
 * they worked with, for `volunteer_mentor_relationship` (report 7's "Volunteer
 * or intern" type). The rule, decided 2026-10-14:
 *   - the record's `manager;sponsor` when that CWID is faculty, else its
 *     `manager;manager` when THAT is — a faculty sponsor or manager alone makes
 *     the pair (an administrator who sponsors makes none);
 *   - a record whose volunteer is faculty themselves is not a mentee;
 *   - a record naming no faculty member makes no row.
 * "Faculty" includes FORMER faculty (a soft-deleted Scholar row keeps its role
 * category): a historical record keeps its sponsor after the sponsor leaves,
 * rather than passing to the manager or being tombstoned.
 *
 * `pairVolunteers` is the pure rule; `syncVolunteerMentors` is the nightly
 * pass `etl:ed` runs, written to never fail that run.
 */
import { assertPruneVolume } from "@/lib/etl-guard";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { EdVolunteerRoleRecord, PersonLookup } from "@/lib/sources/ldap";

/** The role categories that count as faculty for a volunteer's sponsor or
 *  manager, and for "the volunteer is faculty themselves".
 *  ponytail: the faculty tiers by name; widen if a real sponsor population
 *  turns up outside them. */
export const VOLUNTEER_MENTOR_ROLES = [
  "full_time_faculty",
  "affiliated_faculty",
  "instructor",
  "lecturer",
  "emeritus",
] as const;

export type VolunteerPair = EdVolunteerRoleRecord & {
  mentorCwid: string;
  mentorRole: "sponsor" | "manager";
};

export function pairVolunteers(
  records: ReadonlyArray<EdVolunteerRoleRecord>,
  faculty: ReadonlySet<string>,
): { pairs: VolunteerPair[]; facultyVolunteers: number; noFacultyMentor: number } {
  const pairs: VolunteerPair[] = [];
  let facultyVolunteers = 0;
  let noFacultyMentor = 0;
  for (const r of records) {
    if (faculty.has(r.cwid)) {
      facultyVolunteers += 1;
      continue;
    }
    if (r.sponsorCwid && faculty.has(r.sponsorCwid)) {
      pairs.push({ ...r, mentorCwid: r.sponsorCwid, mentorRole: "sponsor" });
    } else if (r.managerCwid && faculty.has(r.managerCwid)) {
      pairs.push({ ...r, mentorCwid: r.managerCwid, mentorRole: "manager" });
    } else {
      noFacultyMentor += 1;
    }
  }
  return { pairs, facultyVolunteers, noFacultyMentor };
}

/** The columns' widths (`volunteer_mentor_relationship`): a longer value is
 *  cut rather than failing the row. */
const clip = (v: string | null, n: number) => (v === null ? null : v.slice(0, n));

/**
 * The nightly pass: fetch → pair → upsert by SORID → tombstone. Best-effort
 * end to end — the ED step is an abort-tier step of the nightly, so nothing
 * here may throw: a failed or empty fetch changes nothing, and any later
 * failure (a missing table on a night the migration has not run yet, a row
 * error) ends the pass before its tombstone, logged, and the run goes on.
 *   - Names come from `ou=people` (volunteers hold no Scholar row). A name
 *     the lookup did not return is never written over: a failed lookup, or an
 *     expired volunteer `ou=people` no longer lists, keeps the stored name.
 *   - The tombstone is capped (`assertPruneVolume`, 20% of rows): a feed
 *     silently scoped to active records (the postdoc pass's incident) would
 *     otherwise delete every past volunteer. Over the cap it is skipped.
 */
export async function syncVolunteerMentors(deps: {
  db: Pick<PrismaClient, "scholar" | "volunteerMentorRelationship">;
  fetchRecords: () => Promise<EdVolunteerRoleRecord[]>;
  fetchNames: (cwids: string[]) => Promise<Map<string, PersonLookup>>;
  log?: Pick<Console, "log" | "warn">;
}): Promise<void> {
  const { db, log = console } = deps;
  const why = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let records: EdVolunteerRoleRecord[];
  try {
    log.log("Fetching volunteer affiliate role records (active + expired)...");
    records = await deps.fetchRecords();
    log.log(`ED returned ${records.length} volunteer role records.`);
  } catch (err) {
    log.warn(`Volunteer role-record fetch skipped: ${why(err)}`);
    return;
  }
  if (records.length === 0) return;

  try {
    // Former faculty count (no deletedAt / status filter): see the module doc.
    const faculty = new Set(
      (
        await db.scholar.findMany({
          where: { roleCategory: { in: [...VOLUNTEER_MENTOR_ROLES] } },
          select: { cwid: true },
        })
      ).map((s) => s.cwid.toLowerCase()),
    );
    const { pairs, facultyVolunteers, noFacultyMentor } = pairVolunteers(records, faculty);

    let names = new Map<string, PersonLookup>();
    try {
      names = await deps.fetchNames(Array.from(new Set(pairs.map((p) => p.cwid))));
    } catch (err) {
      log.warn(`Volunteer name lookup skipped (stored names kept): ${why(err)}`);
    }

    // A row error ends the pass at the outer catch, before the tombstone.
    const seen = new Set<string>();
    for (const p of pairs) {
      const externalId = `ED-VOLUNTEER-${p.sorId}`;
      seen.add(externalId);
      const name = names.get(p.cwid);
      const nameFields = name
        ? { menteeFirstName: clip(name.firstName, 64), menteeLastName: clip(name.lastName, 64) }
        : {};
      const fields = {
        mentorCwid: p.mentorCwid,
        menteeCwid: p.cwid,
        mentorRole: p.mentorRole,
        startDate: p.startDate,
        endDate: p.endDate,
        status: clip(p.status, 32),
      };
      await db.volunteerMentorRelationship.upsert({
        where: { externalId },
        create: { externalId, ...fields, ...nameFields },
        update: { ...fields, ...nameFields, lastRefreshedAt: new Date() },
      });
    }

    const existing = await db.volunteerMentorRelationship.findMany({ select: { externalId: true } });
    const stale = existing.map((r) => r.externalId).filter((eid) => !seen.has(eid));
    let deleted = 0;
    try {
      assertPruneVolume("ed-volunteers", { pruning: stale.length, of: existing.length, maxPct: 20 });
      if (stale.length > 0) {
        deleted = (await db.volunteerMentorRelationship.deleteMany({ where: { externalId: { in: stale } } })).count;
      }
    } catch (err) {
      log.warn(`[ED] volunteer tombstone skipped: ${why(err)}`);
    }
    const viaSponsor = pairs.filter((p) => p.mentorRole === "sponsor").length;
    log.log(
      `[ED] volunteer mentees: ${pairs.length} relationships upserted ` +
        `(${viaSponsor} via sponsor, ${pairs.length - viaSponsor} via manager; ` +
        `${noFacultyMentor} records name no faculty sponsor or manager; ` +
        `${facultyVolunteers} faculty volunteers skipped; ${deleted} stale rows tombstoned)`,
    );
  } catch (err) {
    log.warn(`[ED] volunteer pass skipped: ${why(err)}`);
  }
}
