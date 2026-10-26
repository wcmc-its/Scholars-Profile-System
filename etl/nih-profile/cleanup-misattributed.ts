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
 * #3071: the rows that survived also confirm the other person's awards on the
 * scholar's profile, so preferred rows are now in scope too.
 *
 * Scope / safety:
 *   - Only `resolution_source = 'grant_join_contact'` rows are considered, the
 *     one route that paired a profile with a scholar without a name check.
 *   - A row is deleted ONLY on positive disagreement: RePORTER returned a name
 *     for the id, it matches neither the scholar's full nor preferred name, and
 *     its surname appears nowhere in either. A surname-only agreement (nickname,
 *     changed given name, or a namesake) is KEPT and listed for review, and so
 *     is an id RePORTER returns no name for. We never delete on absence of
 *     evidence.
 *   - A row a curator confirmed (`reporter_profile_candidate.status =
 *     'confirmed'`) is never deleted.
 *   - Deleting a preferred row promotes the scholar's most recently verified
 *     remaining row, so the "View NIH portfolio" link keeps a target. The next
 *     NihProfile run re-picks the preferred row for any scholar it observes.
 *   - Dry-run by default. Pass `--apply` to perform deletes.
 *
 * Usage:
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts            # dry-run
 *   npm exec tsx etl/nih-profile/cleanup-misattributed.ts -- --apply # delete
 */
// `@/` imports, not relative ones, so the dry run can ship as a read-only probe
// (scripts/run-staging-probe.sh copies this one file into the app tree).
import { db } from "@/lib/db";
import {
  searchProjectsByProfileIds,
  sleepBetweenRequests,
  type ReporterPI,
} from "@/etl/nih-profile/fetcher";
import { namesMatch, reporterPiName } from "@/etl/nih-profile/resolver";
import { piSurnameMatches } from "@/etl/reporter-grants/score";

// One profile_id per request. `searchProjectsByProfileIds` fetches a single
// 500-row page (no pagination); batching many prolific PIs together overflows
// that page, so ids whose projects sort past row 500 came back nameless and
// were wrongly parked as "no RePORTER name → keep" — the cleanup then
// under-deleted (72 vs the true 148 wrong-person rows on the first dataset run).
// With a single id, every returned project lists that id as a PI, so its name
// is always present in the first page. 1 req/sec keeps us within NIH's limit.
const BATCH_SIZE = 1;

type SuspectRow = {
  cwid: string;
  nihProfileId: number;
  isPreferred: boolean;
  scholarName: string;
  preferredName: string | null;
};

export type LinkVerdict = "ok" | "surname_only" | "wrong" | "no_name";

/** How the names RePORTER holds for a profile compare with the scholar's. */
export function classifyLink(
  reporterNames: string[],
  scholarNames: Array<string | null>,
): LinkVerdict {
  if (reporterNames.length === 0) return "no_name";
  const ours = scholarNames.filter((n): n is string => !!n && n.trim().length > 0);
  if (reporterNames.some((r) => ours.some((n) => namesMatch(r, n)))) return "ok";
  if (reporterNames.some((r) => piSurnameMatches(r, ours) === true)) return "surname_only";
  return "wrong";
}

/** The row to make preferred once `deleted` rows are gone, or null when the
 *  scholar keeps a preferred row or has none left. Most recently verified wins,
 *  lowest id breaks ties so dry run and apply agree. */
export function promotionAfterDelete(
  rows: Array<{ nihProfileId: number; isPreferred: boolean; lastVerified: Date }>,
  deleted: Set<number>,
): number | null {
  const left = rows.filter((r) => !deleted.has(r.nihProfileId));
  if (left.length === 0 || left.some((r) => r.isPreferred)) return null;
  if (!rows.some((r) => r.isPreferred && deleted.has(r.nihProfileId))) return null;
  left.sort(
    (a, b) =>
      b.lastVerified.getTime() - a.lastVerified.getTime() || a.nihProfileId - b.nihProfileId,
  );
  return left[0]!.nihProfileId;
}

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
    const done = Math.min(i + BATCH_SIZE, profileIds.length);
    if (done % 50 === 0 || done === profileIds.length) {
      console.log(`  ...resolved ${done}/${profileIds.length} profile ids`);
    }
    await sleepBetweenRequests();
  }
  return namesByProfileId;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(
    `\n=== person_nih_profile misattribution cleanup (#766, #3071) — ${apply ? "APPLY (deleting)" : "DRY RUN"} ===\n`,
  );

  // The other resolution sources (grant_join_pi, name_match, name_query)
  // always name-checked, so they are not part of this defect.
  const rows = await db.write.personNihProfile.findMany({
    where: { resolutionSource: "grant_join_contact" },
    select: {
      cwid: true,
      nihProfileId: true,
      isPreferred: true,
      scholar: { select: { fullName: true, preferredName: true } },
    },
  });
  const preferredCount = rows.filter((r) => r.isPreferred).length;
  console.log(`${rows.length} grant_join_contact rows to validate (${preferredCount} preferred).`);
  if (rows.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  const suspects: SuspectRow[] = rows.map((r) => ({
    cwid: r.cwid,
    nihProfileId: r.nihProfileId,
    isPreferred: r.isPreferred,
    scholarName: r.scholar.fullName,
    preferredName: r.scholar.preferredName,
  }));

  const confirmed = new Set(
    (
      await db.write.reporterProfileCandidate.findMany({
        where: { status: "confirmed", cwid: { in: [...new Set(suspects.map((s) => s.cwid))] } },
        select: { cwid: true, externalProfileId: true },
      })
    ).map((c) => `${c.cwid}::${c.externalProfileId}`),
  );

  const distinctIds = Array.from(new Set(suspects.map((s) => s.nihProfileId)));
  console.log(`Looking up ${distinctIds.length} distinct profile ids on RePORTER...`);
  const namesByProfileId = await fetchProfileNames(distinctIds);

  const toDelete: SuspectRow[] = [];
  const kept: SuspectRow[] = [];
  const surnameOnly: SuspectRow[] = [];
  const curatorConfirmed: SuspectRow[] = [];
  const unresolvable: SuspectRow[] = [];

  for (const s of suspects) {
    const verdict = classifyLink(Array.from(namesByProfileId.get(s.nihProfileId) ?? []), [
      s.scholarName,
      s.preferredName,
    ]);
    if (verdict === "ok") kept.push(s);
    else if (verdict === "surname_only") surnameOnly.push(s);
    else if (verdict === "no_name")
      unresolvable.push(s); // no evidence — keep, flag for manual review
    else if (confirmed.has(`${s.cwid}::${s.nihProfileId}`)) curatorConfirmed.push(s);
    else toDelete.push(s);
  }

  // Every row of each affected scholar, any source, to plan preferred promotion.
  const affectedCwids = [...new Set(toDelete.map((s) => s.cwid))];
  const allRows = await db.write.personNihProfile.findMany({
    where: { cwid: { in: affectedCwids } },
    select: { cwid: true, nihProfileId: true, isPreferred: true, lastVerified: true },
  });
  const promotions = new Map<string, number>();
  for (const cwid of affectedCwids) {
    const deleted = new Set(toDelete.filter((s) => s.cwid === cwid).map((s) => s.nihProfileId));
    const promote = promotionAfterDelete(
      allRows.filter((r) => r.cwid === cwid),
      deleted,
    );
    if (promote !== null) promotions.set(cwid, promote);
  }

  const fmt = (s: SuspectRow) => {
    const rep =
      Array.from(namesByProfileId.get(s.nihProfileId) ?? []).join(" / ") || "(no RePORTER name)";
    const pn =
      s.preferredName && s.preferredName !== s.scholarName ? ` (pref "${s.preferredName}")` : "";
    return `  ${s.cwid.padEnd(12)} profile ${String(s.nihProfileId).padEnd(10)} ${s.isPreferred ? "PREFERRED " : "          "}scholar="${s.scholarName}"${pn}  reporter="${rep}"`;
  };

  console.log(
    `\n--- WRONG PERSON → ${apply ? "DELETING" : "would delete"} (${toDelete.length}) ---`,
  );
  toDelete.forEach((s) => console.log(fmt(s)));
  const orphaned = toDelete.filter((s) => s.isPreferred && !promotions.has(s.cwid));
  console.log(
    `\n--- preferred link ${apply ? "promoted" : "would be promoted"} after a delete (${promotions.size}) ---`,
  );
  for (const [cwid, id] of promotions) console.log(`  ${cwid.padEnd(12)} profile ${id}`);
  if (orphaned.length > 0) {
    console.log(`\n--- scholar left with NO NIH profile after the delete (${orphaned.length}) ---`);
    orphaned.forEach((s) => console.log(fmt(s)));
  }
  console.log(
    `\n--- surname agrees, given name does not → KEEPING, review (${surnameOnly.length}) ---`,
  );
  surnameOnly.forEach((s) => console.log(fmt(s)));
  if (curatorConfirmed.length > 0) {
    console.log(
      `\n--- name disagrees but a curator confirmed the profile → KEEPING (${curatorConfirmed.length}) ---`,
    );
    curatorConfirmed.forEach((s) => console.log(fmt(s)));
  }
  console.log(`\n--- legitimate (name agrees) → keeping (${kept.length}) ---`);
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
  for (const cwid of affectedCwids) {
    const mine = toDelete.filter((s) => s.cwid === cwid);
    const promote = promotions.get(cwid);
    await db.write.$transaction(async (tx) => {
      for (const s of mine) {
        await tx.personNihProfile.delete({
          where: { cwid_nihProfileId: { cwid: s.cwid, nihProfileId: s.nihProfileId } },
        });
      }
      if (promote !== undefined) {
        await tx.personNihProfile.update({
          where: { cwid_nihProfileId: { cwid, nihProfileId: promote } },
          data: { isPreferred: true },
        });
      }
    });
    deleted += mine.length;
  }
  console.log(
    `\nDeleted ${deleted} misattributed rows and promoted ${promotions.size} preferred links. ` +
      `Kept ${kept.length}; ${surnameOnly.length + unresolvable.length} need manual review.\n`,
  );
}

// Guarded so the module can be imported by a unit test without running the cleanup.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main()
    .then(() => db.write.$disconnect())
    .catch(async (err) => {
      console.error(err);
      await db.write.$disconnect();
      process.exit(1);
    });
}
