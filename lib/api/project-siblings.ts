/**
 * The sibling-PD/PI lookup behind `isMultiPi`, shared by every surface that
 * needs the project-level multi-PI fact from the DB rather than the funding
 * index.
 *
 * Extracted from `lib/api/profile.ts` (#2075) so the department and division
 * grant lists can reuse it without importing the whole profile loader. The RULE
 * itself lives in `multiPiExternalIds` (lib/funding-projection.ts); this module
 * only answers "which rows could share a project with these rows".
 */
import { parseNihAward } from "@/lib/award-number";
import { prisma } from "@/lib/db";
import { GRANT_INDEX_WHERE, parseExternalId } from "@/lib/funding-projection";

/** The columns that decide a grant row's funding-project key, plus the cwid and
 *  role the ≥2-distinct-PD/PI rule counts. Kept as a named type so the candidate
 *  query, `groupGrantsByProject`, and the tests all agree on the projection. */
export type ProjectKeyRow = {
  cwid: string;
  role: string;
  externalId: string | null;
  awardNumber: string | null;
};

/**
 * ONE query that pulls every Grant row which could share a funding project with
 * the given rows — the sibling PD/PIs the caller's own row set cannot see.
 *
 * THE KEY. A funding project is `coreProjectNum(awardNumber) ?? accountNumber`
 * (lib/funding-projection.ts) — derived in app code, NOT a queryable column. So
 * this can only fetch a SUPERSET and let `groupGrantsByProject` do the exact
 * grouping. Two OR arms, one per half of that expression:
 *
 *   1. `external_id LIKE 'INFOED-<account>-%'` — every WCM investigator on the
 *      same InfoEd Account_Number (the id is `INFOED-{account}-{cwid}`, so this
 *      is a left-anchored prefix on the `external_id` UNIQUE index). Covers the
 *      non-NIH key entirely and the common same-account MPI.
 *   2. `award_number LIKE '%<serial>%'` — the NIH serial (6-7 digits) of each
 *      NIH award. `coreProjectNum` collapses renewals and supplements whose
 *      award-number STRINGS differ ("1R01CA245678-01" vs "5 R01 CA245678-02"),
 *      and those may sit on a different Account_Number, so arm 1 alone would
 *      miss an MPI listed on the renewal. The serial is the longest substring
 *      common to every spelling of one core project.
 *
 * Over-matching is harmless — `groupGrantsByProject` re-derives the real key and
 * anything that lands in another project's bucket is simply never looked up.
 * Under-matching would not be: it silently under-flags.
 *
 * VISIBILITY: `GRANT_INDEX_WHERE` — active, non-deleted scholars only, the exact
 * population the funding index walks. A soft-deleted or `status = 'suppressed'`
 * sibling therefore cannot flip the flag. Note this deliberately does NOT filter
 * `source = 'RePORTER'` or on `endDate`: the funding index build
 * (`etl/search-index/index.ts`, bare `GRANT_INDEX_WHERE`) does not either, and a
 * surface that narrowed the population here would contradict
 * `/search?type=funding` and the profile about which award is multi-PI — the
 * precise divergence #2063/#2066/#2075 exist to remove.
 *
 * 🔴 ARM COUNT IS THE CALLER'S PROBLEM. This builds up to two OR arms PER
 * DISTINCT account/serial, and arm 2 is an unanchored `LIKE` the index cannot
 * serve. A profile passes one scholar's rows (tens). A department grants page
 * must pass only the rows it is about to RENDER — never its whole active-grant
 * pool, which is ~2k rows for a large department and would build thousands of
 * arms. See the call sites in `lib/api/dept-lists.ts` / `lib/api/divisions.ts`,
 * which pass the paginated slice.
 *
 * Returns [] without querying when no input row yields a project key at all.
 */
export async function loadProjectSiblingRows(
  grants: ReadonlyArray<{ externalId: string | null; awardNumber: string | null }>,
): Promise<ProjectKeyRow[]> {
  const arms: Array<{ externalId?: { startsWith: string } } | { awardNumber: { contains: string } }> =
    [];
  const seenAccounts = new Set<string>();
  const seenSerials = new Set<string>();
  for (const g of grants) {
    const ext = parseExternalId(g.externalId);
    if (ext && !seenAccounts.has(ext.accountNumber)) {
      seenAccounts.add(ext.accountNumber);
      arms.push({ externalId: { startsWith: `INFOED-${ext.accountNumber}-` } });
    }
    const serial = parseNihAward(g.awardNumber).serial;
    if (serial && !seenSerials.has(serial)) {
      seenSerials.add(serial);
      arms.push({ awardNumber: { contains: serial } });
    }
  }
  if (arms.length === 0) return [];
  return (await prisma.grant.findMany({
    where: { AND: [GRANT_INDEX_WHERE, { OR: arms }] },
    select: { cwid: true, role: true, externalId: true, awardNumber: true },
  })) as ProjectKeyRow[];
}
