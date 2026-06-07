/**
 * Issue #766 — one-off cleanup of misattributed `person_nih_profile` rows.
 *
 * The grant-join resolver used to stamp a project's RePORTER *contact PI*
 * `profile_id` onto whichever single WCM scholar we held a PI-level grant row
 * for, with no name check. On multiple-PI / subaward grants where we hold a
 * *co*-PI's row, the contact PI is a different person — so co-investigators'
 * NIH profiles were attributed to the wrong scholar (e.g. Sabine Ehrt's profile
 * mapped to cnathan). `resolver.ts` now name-guards the contact shortcut, which
 * stops *new* bad rows, but `etl/nih-profile/index.ts` only ever upserts — it
 * never deletes rows no longer observed — so the rows already written persist
 * until removed. This script removes them.
 *
 * `person_nih_profile` stores only the `nih_profile_id`, not the RePORTER name,
 * so a wrong-person row can't be told from a legitimate duplicate-eRA-account
 * row by SQL alone. We recover the real name behind each id from RePORTER and
 * delete a row only when the profile's name does not agree with the scholar's
 * (same `namesMatch` bar the resolver uses).
 *
 * Scope / safety:
 *   - Only `is_preferred = FALSE` AND `resolution_source = 'grant_join_contact'`
 *     rows are considered. `is_preferred` rows (which drive the live "View NIH
 *     portfolio" link) are never touched; deleting a non-preferred row can never
 *     orphan a scholar's preferred mapping.
 *   - A row is deleted ONLY on positive disagreement (RePORTER returned a name
 *     for the id and none of its names match the scholar). If RePORTER returns
 *     no name for an id (deactivated / legacy), the row is KEPT and flagged for
 *     manual review — we never delete on absence of evidence.
 *   - Dry-run by default. Pass `--apply` to perform deletes.
 *
 * Usage:
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts            # dry-run
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts -- --apply # delete
 */
import { db } from "../../lib/db";
import { searchProjectsByProfileIds, sleepBetweenRequests, type ReporterPI } from "./fetcher";
import { namesMatch, reporterPiName } from "./resolver";

// One profile_id per request. `searchProjectsByProfileIds` fetches a single
// 500-row page (no pagination); batching many prolific PIs together overflows
// that page, so ids whose projects sort past row 500 came back nameless and
// were wrongly parked as "no RePORTER name → keep" (#766 cleanup under-deleted).
// With a single id, every returned project lists that id as a PI, so its name
// is always present in the first page. 1 req/sec keeps us within NIH's limit.
const BATCH_SIZE = 1;

type SuspectRow = {
  cwid: string;
  nihProfileId: number;
  scholarName: string;
};

/** Map each profile_id to the distinct PI names RePORTER reports for it. */
async function fetchProfileNames(profileIds: number[]): Promise<Map<number, Set<string>>> {
  const namesByProfileId = new Map<number, Set<string>>();
  const idSet = new Set(profileIds);
  for (let i = 0; i < profileIds.length; i += BATCH_SIZE) {
    const batch = profileIds.slice(i, i + BATCH_SIZE);
    let projects;
    try {
      projects = await searchProjectsByProfileIds(batch);
    } catch (err) {
      console.warn(
        `  RePORTER lookup failed for batch ${i / BATCH_SIZE} (${batch.length} ids):`,
        err,
      );
      await sleepBetweenRequests();
      continue;
    }
    for (const project of projects) {
      for (const pi of project.principal_investigators as ReporterPI[]) {
        if (!idSet.has(pi.profile_id)) continue;
        const name = reporterPiName(pi);
        if (!name) continue;
        const set = namesByProfileId.get(pi.profile_id) ?? new Set<string>();
        set.add(name);
        namesByProfileId.set(pi.profile_id, set);
      }
    }
    console.log(
      `  ...resolved ${Math.min(i + BATCH_SIZE, profileIds.length)}/${profileIds.length} profile ids`,
    );
    await sleepBetweenRequests();
  }
  return namesByProfileId;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    `\n=== person_nih_profile misattribution cleanup (#766) — ${apply ? "APPLY (deleting)" : "DRY RUN"} ===\n`,
  );

  // Candidate rows: non-preferred grant_join_contact. The other resolution
  // sources (grant_join_pi, name_match, name_query) already name-check, so
  // they are not part of this defect.
  const rows = await db.write.personNihProfile.findMany({
    where: { isPreferred: false, resolutionSource: "grant_join_contact" },
    select: {
      cwid: true,
      nihProfileId: true,
      scholar: { select: { fullName: true } },
    },
  });
  console.log(`${rows.length} non-preferred grant_join_contact rows to validate.`);
  if (rows.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  const suspects: SuspectRow[] = rows.map((r) => ({
    cwid: r.cwid,
    nihProfileId: r.nihProfileId,
    scholarName: r.scholar.fullName,
  }));

  const distinctIds = Array.from(new Set(suspects.map((s) => s.nihProfileId)));
  console.log(`Looking up ${distinctIds.length} distinct profile ids on RePORTER...`);
  const namesByProfileId = await fetchProfileNames(distinctIds);

  const toDelete: SuspectRow[] = [];
  const kept: SuspectRow[] = [];
  const unresolvable: SuspectRow[] = [];

  for (const s of suspects) {
    const reporterNames = namesByProfileId.get(s.nihProfileId);
    if (!reporterNames || reporterNames.size === 0) {
      unresolvable.push(s); // no evidence — keep, flag for manual review
      continue;
    }
    const matches = Array.from(reporterNames).some((n) => namesMatch(n, s.scholarName));
    if (matches) kept.push(s);
    else toDelete.push(s);
  }

  const fmt = (s: SuspectRow) => {
    const rep =
      Array.from(namesByProfileId.get(s.nihProfileId) ?? []).join(" / ") || "(no RePORTER name)";
    return `  ${s.cwid.padEnd(12)} profile ${String(s.nihProfileId).padEnd(10)} scholar="${s.scholarName}"  reporter="${rep}"`;
  };

  console.log(
    `\n--- WRONG PERSON → ${apply ? "DELETING" : "would delete"} (${toDelete.length}) ---`,
  );
  toDelete.forEach((s) => console.log(fmt(s)));
  console.log(`\n--- legitimate (name agrees) → keeping (${kept.length}) ---`);
  kept.forEach((s) => console.log(fmt(s)));
  if (unresolvable.length > 0) {
    console.log(
      `\n--- no RePORTER name for id → KEEPING, review manually (${unresolvable.length}) ---`,
    );
    unresolvable.forEach((s) => console.log(fmt(s)));
  }

  if (!apply) {
    console.log(
      `\nDry run — re-run with \`--apply\` to delete the ${toDelete.length} wrong-person rows.\n`,
    );
    return;
  }

  let deleted = 0;
  for (const s of toDelete) {
    await db.write.personNihProfile.delete({
      where: { cwid_nihProfileId: { cwid: s.cwid, nihProfileId: s.nihProfileId } },
    });
    deleted++;
  }
  console.log(
    `\nDeleted ${deleted} misattributed rows. Kept ${kept.length}; ${unresolvable.length} need manual review.\n`,
  );
}

main()
  .then(() => db.write.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.write.$disconnect();
    process.exit(1);
  });
