/**
 * #3071 — WCM directory namesakes for the grant attribution scorer.
 *
 * "Held at WCM" is the scorer's strongest tie for a scholar whose NIH profile
 * was matched by name alone: an award under their name at WCM is taken to be
 * theirs. That fails when someone else at WCM, current or former, shares the
 * name and could have held the award (a postdoc's F32, a fellow's K award).
 * Our scholar list can't see them; the directory can.
 *
 * For each scholar the weekly scorer judges under the name-only or grant-join
 * policy (for grant-join, "held at WCM" counts only when nobody shares the
 * name), count
 * the other directory people with the same directory first and last name
 * (givenName, sn: the scholar's own entry's) who could hold
 * an NIH award, and store the count (never who they are) in `wcm_namesake`.
 * Runs inside etl:ed because only the LDAP task has the directory bind.
 *
 * Who counts. A typed entry counts when its primary person type is faculty,
 * academic staff, a postdoc or a student. NYP and Columbia affiliates, alumni
 * and other affiliates never hold NIH awards here and do not. Former people
 * lose their type in the directory and keep only a status such as
 * "faculty:expired"; those count when the status is faculty, employee or
 * student (a former postdoc and a former administrator look the same, so this
 * errs toward counting). A retired CWID may be the scholar under an old ID and
 * never counts.
 *
 * Non-fatal by design: a failure leaves the table as it was, and the scorer
 * treats a missing count as "not looked up". The first directory error stops
 * the loop, so an outage cannot stall the nightly import one timeout at a time.
 */
import type { Client } from "ldapts";
import { db } from "@/lib/db";
import { DEFAULT_SEARCH_BASE, escapeLdapFilter } from "@/lib/sources/ldap";
import { corroborationPolicy } from "@/etl/reporter-grants/transform";

const values = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);

const ELIGIBLE_TYPE = /^(employee-faculty|employee-academic|employee-postdoc|student-|academic)/;
const ELIGIBLE_STATUS = /^(faculty|employee|student):/;

/** Whether a directory entry, other than the scholar, is someone who could
 *  hold an NIH award at WCM. Pure. */
export function isNihEligibleNamesake(entry: {
  primaryType: string | null;
  statuses: ReadonlyArray<string>;
}): boolean {
  if (entry.statuses.includes("retired-cwid")) return false;
  if (entry.primaryType) return ELIGIBLE_TYPE.test(entry.primaryType);
  return entry.statuses.some((s) => ELIGIBLE_STATUS.test(s));
}

/** Most entries one name search reads: a name shared by more is common, and
 *  the count only needs to be above 0. */
const SEARCH_SIZE_LIMIT = 50;

export async function refreshWcmNamesakes(client: Client): Promise<void> {
  const rows = await db.write.personNihProfile.findMany({
    where: { scholar: { deletedAt: null } },
    select: { cwid: true, resolutionSource: true },
  });
  const byCwid = new Map<string, { sources: string[] }>();
  for (const r of rows) {
    const e = byCwid.get(r.cwid) ?? { sources: [] };
    e.sources.push(r.resolutionSource);
    byCwid.set(r.cwid, e);
  }
  // Grant-join profiles too: WCM counts for them only once the count is 0.
  const cohort = [...byCwid.entries()].filter(([, v]) => corroborationPolicy(v.sources) !== "none");

  const counts = new Map<string, number>();
  const skipped: string[] = [];
  let stopped = false;
  for (const [cwid] of cohort) {
    try {
      // The scholar's own directory name, not one rebuilt from fullName: a
      // middle name or suffix there would make an exact match miss everyone.
      const self = (
        await client.search(DEFAULT_SEARCH_BASE, {
          scope: "sub",
          filter: `(weillCornellEduCWID=${escapeLdapFilter(cwid)})`,
          attributes: ["givenName", "sn"],
          sizeLimit: 1,
        })
      ).searchEntries[0];
      const givenName = self ? values(self.givenName)[0] : undefined;
      const sn = self ? values(self.sn)[0] : undefined;
      if (!givenName || !sn) {
        // Not in the directory under this CWID: leave the count unknown.
        skipped.push(cwid);
        continue;
      }
      const { searchEntries } = await client.search(DEFAULT_SEARCH_BASE, {
        scope: "sub",
        filter: `(&(sn=${escapeLdapFilter(sn)})(givenName=${escapeLdapFilter(givenName)}))`,
        attributes: [
          "weillCornellEduCWID",
          "weillCornellEduPrimaryPersonTypeCode",
          "weillCornellEduStatus",
        ],
        sizeLimit: SEARCH_SIZE_LIMIT,
      });
      const eligible = searchEntries.filter(
        (e) =>
          !values(e.weillCornellEduCWID).includes(cwid) &&
          isNihEligibleNamesake({
            primaryType: values(e.weillCornellEduPrimaryPersonTypeCode)[0] ?? null,
            statuses: values(e.weillCornellEduStatus),
          }),
      ).length;
      // ldapts returns a capped result without throwing, so a full one is
      // truncated: a name that common is shared.
      counts.set(
        cwid,
        searchEntries.length >= SEARCH_SIZE_LIMIT ? Math.max(eligible, 1) : eligible,
      );
    } catch (err) {
      // Any throw is the directory, not the name: stop rather than wait out a
      // timeout per scholar. Scholars not reached keep their last count.
      console.warn(
        `[ED] #3071 WCM namesakes: stopping after a directory error: ${err instanceof Error ? err.message : String(err)}`,
      );
      stopped = true;
      break;
    }
  }

  const now = new Date();
  // Replace the counted rows in two statements, not one upsert per scholar: a
  // thousand upserts outran the 5 s transaction timeout in prod.
  await db.write.$transaction([
    db.write.wcmNamesake.deleteMany({ where: { cwid: { notIn: cohort.map(([c]) => c) } } }),
    db.write.wcmNamesake.deleteMany({ where: { cwid: { in: [...skipped, ...counts.keys()] } } }),
    db.write.wcmNamesake.createMany({
      data: [...counts].map(([cwid, count]) => ({ cwid, count, checkedAt: now })),
    }),
  ]);
  // Aggregates only: never a cwid or name.
  const withAny = [...counts.values()].filter((n) => n > 0).length;
  console.log(
    `[ED] #3071 WCM namesakes: ${counts.size} of ${cohort.length} name-only or grant-join scholars checked, ` +
      `${withAny} share a name with someone who could hold an NIH award; ${skipped.length} not in the directory` +
      `${stopped ? "; stopped early on a directory error" : ""}.`,
  );
}
