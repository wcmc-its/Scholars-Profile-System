/**
 * RePORTER grant materialization ETL (spec §12).
 *
 * Turns confirmed NIH eRA Commons `profile_id`s into `Grant` rows
 * (`source = "RePORTER"`) so the existing profile / search / edit stack renders
 * a scholar's prior-institution and dropped-WCM-history federal grants — the
 * portion InfoEd (WCM-administered awards only) never had. Distinct from its
 * siblings: `etl/reporter` enriches existing rows, `etl/nih-profile` resolves
 * profile_ids; this one CREATES grant rows.
 *
 * v1 scope: materialize ONLY from `person_nih_profile` (the curated resolver
 * output). The PMID name-matcher (`lib/edit/reporter-grants.rankByPmidOverlap`)
 * is NOT wired in here — that needs a confirm UI (v2).
 *
 * Per scholar:
 *   1. Fetch every fiscal year of every award for their profile_id(s).
 *   2. Collapse fiscal years per core_project_num (min/max dates, org pref WCM).
 *   3. Drop awards InfoEd already covers (`dedupeAgainstInfoEd`, spec §6a).
 *   4. Upsert a deterministic Grant row per net-new core (idempotent).
 *   5. Default-hide awards older than RECENCY_YEARS via a system `Suppression`
 *      (user-revocable to surface; spec §6c).
 *   6. Reconcile: delete `source='RePORTER'` rows no longer returned. NEVER
 *      touches `source='InfoEd'` rows.
 *
 * Usage: `npm run etl:reporter-grants`
 */
import { db } from "../../lib/db";
import { dedupeAgainstInfoEd, type InfoedGrant } from "@/lib/edit/reporter-grants";
import { fetchGrantProjectsByProfileIds, sleepBetweenRequests } from "../nih-profile/fetcher";
import {
  RECENCY_YEARS,
  buildReporterGrantRow,
  groupProjectsByCore,
  recencyShouldSuppress,
  toReporterProject,
  type ReporterGrantRow,
} from "./transform";

/** createdBy marker for the age-based default-hide. User overrides (a manual
 *  "not mine" hide, or a revoke of this row) carry a different createdBy and are
 *  never touched by this ETL. */
const SYSTEM_RECENCY = "system-recency";

const DELETE_BATCH = 500;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("\n=== RePORTER Grants ETL ===\n");
  const currentYear = new Date().getUTCFullYear();

  // 1. Confirmed profile_ids per active scholar (resolution source #1; v1).
  //    Union all of a scholar's profile_ids — the PK allows multiple.
  const profileRows = await db.write.personNihProfile.findMany({
    where: { scholar: { deletedAt: null, status: "active" } },
    select: { cwid: true, nihProfileId: true },
  });
  const profilesByCwid = new Map<string, number[]>();
  for (const r of profileRows) {
    const arr = profilesByCwid.get(r.cwid) ?? [];
    arr.push(r.nihProfileId);
    profilesByCwid.set(r.cwid, arr);
  }
  console.log(
    `${profilesByCwid.size} active scholars with ≥1 confirmed RePORTER profile_id.`,
  );

  // 2. InfoEd grants per scholar, for dedup (spec §6a). InfoEd is WCM's system,
  //    so these rows are the WCM-administered floor a RePORTER award must clear.
  const infoedRows = await db.write.grant.findMany({
    where: { source: "InfoEd", awardNumber: { not: null } },
    select: { cwid: true, awardNumber: true },
  });
  const infoedByCwid = new Map<string, InfoedGrant[]>();
  for (const r of infoedRows) {
    const arr = infoedByCwid.get(r.cwid) ?? [];
    arr.push({ awardNumber: r.awardNumber });
    infoedByCwid.set(r.cwid, arr);
  }

  // Existing system-recency suppressions (active OR revoked). Revoked rows stay
  // in this set so a user who surfaced an old grant isn't re-hidden next run.
  const existingRecencyHides = new Set(
    (
      await db.write.suppression.findMany({
        where: { entityType: "grant", createdBy: SYSTEM_RECENCY },
        select: { entityId: true },
      })
    ).map((s) => s.entityId),
  );

  // 3. Per scholar: fetch → group → dedup → upsert (+ recency suppression).
  const keptIds = new Set<string>();
  let processed = 0;
  let grantsUpserted = 0;
  let newlySuppressed = 0;
  let skippedNoDate = 0;
  let errored = 0;

  const scholars = [...profilesByCwid.entries()];
  for (const [cwid, profileIds] of scholars) {
    let fetched;
    try {
      fetched = await fetchGrantProjectsByProfileIds(profileIds);
    } catch (err) {
      errored++;
      console.warn(`  [${cwid}] RePORTER fetch failed: ${(err as Error).message}`);
      await sleepBetweenRequests();
      continue;
    }

    const grouped = groupProjectsByCore(fetched);
    const byCore = new Map(grouped.map((g) => [g.coreProjectNum, g]));
    const { netNew } = dedupeAgainstInfoEd(
      grouped.map(toReporterProject),
      infoedByCwid.get(cwid) ?? [],
    );

    const toWrite: Array<{ row: ReporterGrantRow; maxFiscalYear: number | null }> = [];
    for (const p of netNew) {
      const g = byCore.get(p.coreProjectNum.toUpperCase());
      if (!g) continue;
      const row = buildReporterGrantRow(cwid, g);
      if (!row) {
        skippedNoDate++;
        continue;
      }
      toWrite.push({ row, maxFiscalYear: g.maxFiscalYear });
    }

    if (toWrite.length > 0) {
      await db.write.$transaction(async (tx) => {
        for (const { row, maxFiscalYear } of toWrite) {
          await tx.grant.upsert({
            where: { id: row.id },
            create: row,
            update: {
              title: row.title,
              role: row.role,
              funder: row.funder,
              mechanism: row.mechanism,
              nihIc: row.nihIc,
              startDate: row.startDate,
              endDate: row.endDate,
              awardNumber: row.awardNumber,
              programType: row.programType,
              source: row.source,
              lastRefreshedAt: new Date(),
            },
          });
          keptIds.add(row.id);

          if (
            recencyShouldSuppress(maxFiscalYear, currentYear) &&
            !existingRecencyHides.has(row.externalId)
          ) {
            await tx.suppression.create({
              data: {
                entityType: "grant",
                entityId: row.externalId,
                reason:
                  `RePORTER grant default-hidden by age: last fiscal year ` +
                  `${maxFiscalYear ?? "unknown"} is more than ${RECENCY_YEARS} ` +
                  `years old. Revoke to surface it on the profile.`,
                createdBy: SYSTEM_RECENCY,
              },
            });
            existingRecencyHides.add(row.externalId);
            newlySuppressed++;
          }
        }
      });
      grantsUpserted += toWrite.length;
    }

    processed++;
    if (processed % 50 === 0) {
      console.log(
        `  ...processed ${processed}/${scholars.length} scholars ` +
          `(${grantsUpserted} grants upserted, ${errored} fetch errors)`,
      );
    }
    await sleepBetweenRequests();
  }

  console.log(
    `\nMaterialized ${grantsUpserted} net-new RePORTER grants across ` +
      `${processed} scholars ` +
      `(${newlySuppressed} default-hidden by age, ${skippedNoDate} skipped: no dates, ` +
      `${errored} fetch errors).`,
  );

  // 4. Reconcile (ADR-005). Delete RePORTER rows no longer returned — a
  //    profile_id was unlinked, or a grant aged out of fetch. Suppressions are
  //    left in place so a "not mine" / system hide survives a later re-add.
  //    The `source: "RePORTER"` guard means InfoEd rows are never touched.
  const existingReporter = await db.write.grant.findMany({
    where: { source: "RePORTER" },
    select: { id: true },
  });
  const staleIds = existingReporter.map((g) => g.id).filter((id) => !keptIds.has(id));
  let deleted = 0;
  for (const batch of chunks(staleIds, DELETE_BATCH)) {
    const res = await db.write.grant.deleteMany({
      where: { source: "RePORTER", id: { in: batch } },
    });
    deleted += res.count;
  }
  console.log(`Reconcile: deleted ${deleted} stale RePORTER grant rows.`);
  console.log("\nRePORTER Grants ETL complete.\n");
}

main()
  .then(() => db.write.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.write.$disconnect();
    process.exit(1);
  });
