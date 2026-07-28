/**
 * InfoEd ETL — Phase 4d. Grants from wc_infoedprod.dbo.* via the user's
 * 3-step query consolidated into a single CTE.
 *
 * Strategy:
 *   1. Run consolidated query once (no CWID filter) — returns all
 *      (cwid, Account_Number) pairs across all WCM faculty for active /
 *      expired / in-process awards, excluding those InfoEd flags Confidential.
 *
 * "In Process" is kept deliberately: those rows are real awards mid-setup, not
 * unfunded proposals. Verified 2026-07-14 against the funders' own records —
 * e.g. R35 GM152228 (NIGMS, active at WCM through 2028) and NSF 1817331 are
 * both In Process in InfoEd. Dropping them would delete live funding. The rows
 * that never arrive are filtered by step 2's null-date test, not by status.
 *   2. Filter result set to currently-active scholars in our local DB and
 *      drop rows with null start/end dates (per spec line 125).
 *   3. Reconcile the Grant table by externalId (create new / update
 *      changed / tombstone stale) — each row keeps its uuid PK, and the
 *      abstract/applId enrichment columns survive the run (#352).
 *
 * Role mapping from the query's Role column to our Grant.role values:
 *   PrincipalInvestigatorRole         -> 'PI'
 *   PrincipalInvestigatorSubawardRole -> 'PI-Subaward'
 *   CoPrincipalInvestigatorRole       -> 'Co-PI'
 *   CoInvestigatorRole                -> 'Co-I'
 *   KeyPersonnelRole                  -> 'Key Personnel'
 *
 * 'Co-PI' means a non-contact PD/PI, i.e. an NIH multiple-PI: InfoEd's
 * `Primary_PI_Flag` is `proppds.first_pd`, which marks the CONTACT PI only, so
 * every other PD/PI on a multi-PI award lands here. Downstream, `Co-PI` is a PI
 * (lib/api/data-quality.ts PI_ROLES) and two PI-ish CWIDs on one award raise
 * `isMultiPi`, which is what paints the "Multi-PI" pill and search facet.
 *
 * Funder = Orig_Sponsor (the original funding agency). Subward_Sponsor is
 * appended in parens when present (so the user sees "NIH (via Columbia)" etc.).
 *
 * Usage: `npm run etl:infoed`
 */
import { db } from "../../lib/db";
import { assertPruneVolume } from "../../lib/etl-guard";
import { closeInfoedPool, getInfoedPool } from "@/lib/sources/mssql-infoed";
import { canonicalizeSponsor } from "@/lib/sponsor-canonicalize";
import { coreProjectNum, parseNihAward } from "@/lib/award-number";
import { classifyByExternalId } from "@/lib/etl/reconcile";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import {
  type GapStatus,
  missingField,
  nextGapStatus,
} from "@/lib/grant-date-gap";

type GrantRow = {
  CWID: string | null;
  Account_Number: string;
  Award_Number: string | null;
  begin_date: Date | null;
  end_date: Date | null;
  proj_title: string | null;
  unit_name: string | null;
  int_unit_code: string | null;
  program_type: string | null;
  Orig_Sponsor: string | null;
  Subward_Sponsor: string | null;
  spon_code: string | null;
  Role: string;
  /// #2020 — 'Active Award' | 'Expired Award' | 'In Process'. Only consumed by
  /// the undated-award worklist; the Grant row itself derives status from dates.
  Project_Status: string | null;
};

const INSERT_BATCH = 1000;

/// Every literal the CONSOLIDATED_QUERY CASE can emit must have an entry here,
/// or `ROLE_MAP[r.Role] ?? "Key Personnel"` silently demotes it — the same
/// silent-demotion failure mode that published MPIs as Key Personnel.
const ROLE_MAP: Record<string, string> = {
  PrincipalInvestigatorRole: "PI",
  PrincipalInvestigatorSubawardRole: "PI-Subaward",
  CoPrincipalInvestigatorRole: "Co-PI",
  CoInvestigatorRole: "Co-I",
  KeyPersonnelRole: "Key Personnel",
};

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** An InfoEd row paired with where its project period came from. */
type Prepared = { row: GrantRow; datesSource: "infoed" | "reporter" };

/**
 * #2020 — project periods from `reciterdb.grant_reporter_project`, keyed by
 * core project number, for awards InfoEd left undated.
 *
 * Same join `etl/reporter` already uses for abstracts/applId. It has to happen
 * HERE rather than in that ETL because an undated award never becomes a `Grant`
 * row at all, so there is nothing downstream for the enrichment pass to attach to.
 *
 * Measured coverage (2026-07-28): 358 of 852 undated funded awards, 35 of 159
 * active ones. The remainder are non-NIH — RePORTER cannot help and only a
 * correction in InfoEd can.
 */
async function loadReporterPeriods(
  rows: GrantRow[],
): Promise<Map<string, { start: Date; end: Date }>> {
  const out = new Map<string, { start: Date; end: Date }>();
  const cores = [
    ...new Set(
      rows
        .map((r) => coreProjectNum(r.Award_Number))
        .filter((c): c is string => c !== null),
    ),
  ];
  if (cores.length === 0) return out;

  try {
    await withReciterConnection(async (conn) => {
      for (const batch of chunks(cores, 500)) {
        const placeholders = batch.map(() => "?").join(",");
        const res = (await conn.query(
          `SELECT core_project_num,
                  MIN(project_start_date) AS s,
                  MAX(project_end_date)   AS e
             FROM grant_reporter_project
            WHERE project_start_date IS NOT NULL
              AND project_end_date   IS NOT NULL
              AND core_project_num IN (${placeholders})
            GROUP BY core_project_num`,
          batch,
        )) as Array<{ core_project_num: string; s: Date | null; e: Date | null }>;
        for (const r of res) {
          if (!r.core_project_num || !r.s || !r.e) continue;
          out.set(r.core_project_num.toUpperCase(), {
            start: new Date(r.s),
            end: new Date(r.e),
          });
        }
      }
    });
  } catch (err) {
    // Degrade to the PRE-EXISTING behaviour (drop the row) — never to a wrong
    // date. Loud, because a silent skip is indistinguishable from RePORTER
    // genuinely having no coverage, and the two call for different responses.
    console.warn(
      `[InfoEd] RePORTER period lookup failed — no backfill this run: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return out;
}

const CONSOLIDATED_QUERY = `
WITH infoed_all AS (
  SELECT DISTINCT
    CASE WHEN prop.parentprop_no IS NULL THEN prop.prop_no ELSE prop.parentprop_no END AS Account_Number,
    prop.inst_no        AS RecordID,
    ct.code_desc        AS Submission_Status,
    ct.code_desc        AS Program_Type,
    p_udf.p_sin_5       AS intake_type,
    ct2.code_desc       AS Proposal_Type,
    cdp.code_desc       AS Project_Status,
    cdp2.code_desc      AS Proposal_Status,
    prop.app_st_dt      AS Project_Period_Start,
    prop.app_end_dt     AS Project_Period_End,
    prop.spon_awd       AS Award_Number,
    prop.proj_title,
    prop.spon_code,
    RTRIM(sp.spon_name) AS Sponsor,
    CASE WHEN orig_spon <> prop.spon_code THEN RTRIM(sp2.spon_name) ELSE RTRIM(sp.spon_name) END AS Orig_Sponsor,
    CASE WHEN orig_spon <> prop.spon_code THEN 'incoming subaward' ELSE NULL END AS Subward_Indicator,
    facu.employer_id    AS CWID,
    facu.lname,
    facu.fname,
    facu.title,
    unit.unit_name,
    unit.int_unit_code,
    CASE WHEN pers.first_pd = '1' THEN 'Y' ELSE 'N' END AS Primary_PI_Flag,
    CASE
      WHEN (pers.first_pd = '1' OR pers.dd_role IN ('PD/PI', 'Principal Investigator', 'Qatar PI')) THEN 'PI'
      WHEN pers.dd_role LIKE 'Co-Sponsor' THEN 'Key Personnel'
      WHEN pers.dd_role LIKE '%co-%' THEN 'Co-Investigator'
      WHEN pers.dd_role LIKE 'subaward PI' THEN 'PI Subaward'
      WHEN pers.dd_role LIKE 'SubProject PI' THEN 'PI Subproject'
      ELSE 'Key Personnel'
    END AS Role_Category,
    pers.dd_role AS Role_Description
  FROM   wc_infoedprod.dbo.proposal AS prop
  LEFT OUTER JOIN wc_infoedprod.dbo.pt_project AS subp
    ON subp.child = prop.prop_no AND subp.inst_code = prop.inst_code
  INNER JOIN wc_infoedprod.dbo.codetab    AS ct   ON prop.pgm_type   = ct.codeid
  INNER JOIN wc_infoedprod.dbo.codetab    AS ct2  ON prop.prop_type  = ct2.codeid
  INNER JOIN wc_infoedprod.dbo.projstatxref AS ps ON prop.prop_stat  = ps.appr_stat
  INNER JOIN wc_infoedprod.dbo.codetab    AS cdp  ON ps.projstat     = cdp.codeid
  LEFT OUTER JOIN wc_infoedprod.dbo.codetab AS cdp2 ON ps.appr_stat = cdp2.codeid
  INNER JOIN wc_infoedprod.dbo.projmain   AS proj ON proj.prop_no = prop.prop_no AND proj.system = prop.system AND proj.inst_code = prop.inst_code
  INNER JOIN wc_infoedprod.dbo.sponspas   AS sp   ON prop.inst_code = sp.inst_code AND prop.spon_code = sp.spon_code
  LEFT OUTER JOIN wc_infoedprod.dbo.sponspas AS sp2 ON prop.inst_code = sp2.inst_code AND prop.orig_spon = sp2.spon_code
  LEFT OUTER JOIN wc_infoedprod.dbo.proppds AS pers
    INNER JOIN wc_infoedprod.dbo.faculty   AS facu ON pers.unique_id = facu.unique_id AND pers.inst_code = facu.inst_code AND pers.role_key = 'KEY'
    ON prop.prop_no = pers.prop_no AND prop.inst_code = pers.inst_code
  LEFT OUTER JOIN wc_infoedprod.dbo.pt_unit AS dept ON dept.prop_no = prop.prop_no AND dept.inst_code = prop.inst_code AND dept.prim = '1'
  LEFT OUTER JOIN wc_infoedprod.dbo.unit   AS unit ON unit.unit_code = dept.unit_code AND unit.inst_code = dept.inst_code
  LEFT OUTER JOIN wc_infoedprod.dbo.prop_u AS p_udf ON p_udf.prop_no = prop.prop_no AND p_udf.inst_code = prop.inst_code
  WHERE  prop.system = 'PT'
    AND  prop.inst_code = 'WCORNELLMC'
    AND  subp.child IS NULL
    AND  cdp.code_desc IN ('Active Award', 'Expired Award', 'In Process')
    -- Confidential (prop_u.p_log_50, surfaced as "Confidential" in InfoEd's own
    -- dbo.VIVO integration view) means do-not-publish. Excluded here at the
    -- source, so a flagged award cannot reach a public profile via any later
    -- code path. Was computed and then ignored: 18 accounts were being
    -- published, one as active funding.
    AND  ISNULL(p_udf.p_log_50, 0) <> 1
)
SELECT DISTINCT
  v.CWID, v.Account_Number, x.Award_Number, y.begin_date, z.end_date,
  REPLACE(REPLACE(REPLACE(z.proj_title, CHAR(13), ' '), CHAR(10), ' '), '    ', '') AS proj_title,
  z.unit_name, z.int_unit_code, z.program_type, z.Orig_Sponsor, z.Project_Status,
  CASE WHEN z.Sponsor = z.Orig_Sponsor THEN NULL ELSE z.Sponsor END AS Subward_Sponsor,
  z.spon_code,
  CASE
    WHEN z.Sponsor = z.Orig_Sponsor AND z.Primary_PI_Flag = 'Y' THEN 'PrincipalInvestigatorRole'
    WHEN z.Sponsor <> z.Orig_Sponsor AND z.Primary_PI_Flag = 'Y' THEN 'PrincipalInvestigatorSubawardRole'
    -- A non-contact PD/PI (Primary_PI_Flag = 'N', Role_Category = 'PI') is an NIH
    -- multiple-PI. This branch used to require Sponsor <> Orig_Sponsor, so it only
    -- fired on subawards: an MPI on a DIRECT award missed every branch above and
    -- fell through to ELSE, landing as 'Key Personnel'. Verified against a raw
    -- InfoEd extract: R01 NS126342 and R01 NS136423 both carry
    -- Role_Description = 'PD/PI' with Primary_PI_Flag = 'N' and were published as
    -- Key Personnel, while the same investigator's contact-PI award (R01
    -- AG083949) published as PI. LIKE '%PI' only ever matches Role_Category =
    -- 'PI' ('PI Subaward' / 'PI Subproject' don't end in "PI"), so this branch
    -- stays scoped to PD/PIs and the Co-I branch below stays reachable.
    WHEN z.Role_Category LIKE '%PI' THEN 'CoPrincipalInvestigatorRole'
    WHEN z.Role_Category LIKE '%Co-investigator' THEN 'CoInvestigatorRole'
    ELSE 'KeyPersonnelRole'
  END AS Role
FROM infoed_all AS v
LEFT JOIN (SELECT cwid, Account_Number, MAX(Award_Number) AS Award_Number FROM infoed_all GROUP BY cwid, Account_Number) AS x
  ON x.cwid = v.cwid AND x.Account_Number = v.Account_Number
LEFT JOIN (SELECT cwid, Account_Number, MIN(Project_Period_Start) AS begin_date FROM infoed_all GROUP BY cwid, Account_Number) AS y
  ON y.cwid = v.cwid AND y.Account_Number = v.Account_Number
LEFT JOIN (
  SELECT cwid, Account_Number,
    MAX(Project_Period_End) AS end_date, MAX(Sponsor) AS Sponsor, MAX(Orig_Sponsor) AS Orig_Sponsor,
    MAX(spon_code) AS spon_code, MAX(proj_title) AS proj_title,
    -- The outer WHERE drops 'Contract without funding' row-by-row (on v), but
    -- this aggregate ran over EVERY row of the account — so on an account that
    -- mixes program types, MIN() returned 'Contract without funding' ('C' sorts
    -- before 'G') and wrote it to Grant.programType anyway, defeating the
    -- exclusion the schema documents. Aggregate only over the types we keep.
    MIN(CASE WHEN program_type <> 'Contract without funding' THEN program_type END) AS program_type,
    MIN(unit_name) AS unit_name, MIN(int_unit_code) AS int_unit_code,
    MAX(Primary_PI_Flag) AS Primary_PI_Flag, MIN(role_category) AS Role_Category,
    -- #2020 — triage field for the undated-award worklist. MIN() so an account
    -- mixing statuses reports 'Active Award' ('A' sorts before 'E' and 'I'):
    -- an undated ACTIVE award is the one a faculty member notices missing.
    MIN(Project_Status) AS Project_Status
  FROM infoed_all GROUP BY cwid, Account_Number
) AS z
  ON z.cwid = v.cwid AND z.Account_Number = v.Account_Number
WHERE v.unit_name IS NOT NULL
  AND v.program_type <> 'Contract without funding'
ORDER BY v.CWID, v.Account_Number;
`;

/**
 * #2020 — reconcile the undated-award worklist.
 *
 * Upserts a `GrantDateGap` for every award InfoEd left without a project
 * period, and auto-resolves any previously-recorded gap the source has since
 * fixed. Dismissals are never overwritten.
 *
 * A gap that disappears from the feed entirely (award withdrawn, CWID
 * deactivated) also lands in `resolved` — from the worklist's point of view it
 * no longer needs OSRA action either way, and `lastSeenAt` distinguishes the
 * two cases for anyone auditing later.
 */
async function reconcileDateGaps(
  undated: GrantRow[],
  backfilledIds: Set<string>,
): Promise<void> {
  const now = new Date();
  const existing = await db.write.grantDateGap.findMany({
    select: { externalId: true, status: true },
  });
  const statusByExternalId = new Map<string, GapStatus>(
    existing.map((g) => [g.externalId, g.status as GapStatus]),
  );

  const seen = new Set<string>();
  let opened = 0;
  let backfilledCount = 0;

  for (const r of undated) {
    const externalId = `INFOED-${r.Account_Number}-${r.CWID}`;
    // The consolidated query yields one row per (cwid, account) after the outer
    // DISTINCT, but guard anyway — a duplicate would double-count the log line.
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const wasBackfilled = backfilledIds.has(externalId);
    const status = nextGapStatus(statusByExternalId.get(externalId) ?? null, {
      stillUndated: true,
      backfilled: wasBackfilled,
    });
    if (status === "open") opened++;
    if (status === "backfilled") backfilledCount++;

    const shared = {
      cwid: r.CWID!,
      accountNumber: r.Account_Number,
      awardNumber: r.Award_Number?.trim() || null,
      // The only recognizable identifier on the ~74% of these that carry no
      // award number. Unlike the Grant row, no "(untitled …)" placeholder —
      // a genuinely untitled InfoEd record is a finding, not a rendering problem.
      title: r.proj_title?.trim() || null,
      sponsor: r.Orig_Sponsor?.trim() || null,
      projectStatus: r.Project_Status?.trim() || "(unknown)",
      programType: r.program_type?.trim() || "Grant",
      unitName: r.unit_name?.trim() || null,
      missingField: missingField(r.begin_date, r.end_date) ?? "both",
      status,
      backfillSource: wasBackfilled ? "reporter" : null,
      lastSeenAt: now,
    };

    await db.write.grantDateGap.upsert({
      where: { externalId },
      create: { externalId, ...shared },
      // firstSeenAt is deliberately absent from the update — "how long has this
      // been undated" is the number that moves a data-quality conversation, and
      // it only means that if it survives every subsequent run.
      update: shared,
    });
  }

  const stale = existing.filter(
    (g) =>
      !seen.has(g.externalId) &&
      g.status !== "dismissed" &&
      g.status !== "resolved",
  );
  if (stale.length > 0) {
    await db.write.grantDateGap.updateMany({
      where: { externalId: { in: stale.map((g) => g.externalId) } },
      data: { status: "resolved", resolvedAt: now, lastSeenAt: now },
    });
  }

  console.log(
    `Date-gap worklist: ${opened} open, ${backfilledCount} backfilled (source still wrong), ` +
      `${stale.length} newly resolved.`,
  );
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "InfoEd", status: "running" },
  });

  try {
    console.log("Loading active CWIDs from local DB...");
    const ourScholars = await db.write.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));
    console.log(`Active scholars: ${ourCwidSet.size}`);

    console.log("Running consolidated InfoEd query (this can take a couple of minutes)...");
    const pool = await getInfoedPool();
    const queryStart = Date.now();
    const result = await pool.request().query(CONSOLIDATED_QUERY);
    const queryElapsed = Math.round((Date.now() - queryStart) / 1000);
    const rows = result.recordset as GrantRow[];
    console.log(`InfoEd returned ${rows.length} grant rows in ${queryElapsed}s.`);

    // Filter to our active CWIDs, then split on whether InfoEd gave us a
    // project period. #2020 — these two losses used to share one predicate and
    // one post-filter total, so a 23.6% drop was invisible in the run log.
    const ours = rows.filter((r) => r.CWID !== null && ourCwidSet.has(r.CWID));
    const dated = ours.filter(
      (r) => r.begin_date !== null && r.end_date !== null,
    );
    const undated = ours.filter(
      (r) => r.begin_date === null || r.end_date === null,
    );
    const undatedFunded = undated.filter((r) => r.Award_Number?.trim()).length;
    console.log(
      `Rows for active CWIDs: ${ours.length} (with project period ${dated.length}, ` +
        `without ${undated.length}, of which ${undatedFunded} carry an award number).`,
    );

    // Adopt a period from RePORTER where one exists. This makes the grant
    // RENDER; it does not make InfoEd correct. Every undated award is recorded
    // as a gap below whether or not it was backfilled — see GrantDateGap.
    const periods = await loadReporterPeriods(undated);
    const prepared: Prepared[] = dated.map((row) => ({
      row,
      datesSource: "infoed" as const,
    }));
    const backfilledIds = new Set<string>();
    for (const row of undated) {
      const period = periods.get(coreProjectNum(row.Award_Number) ?? "");
      if (!period) continue;
      backfilledIds.add(`INFOED-${row.Account_Number}-${row.CWID}`);
      prepared.push({
        row: { ...row, begin_date: period.start, end_date: period.end },
        datesSource: "reporter",
      });
    }
    console.log(
      `Backfilled ${backfilledIds.size} of ${undated.length} undated awards from RePORTER; ` +
        `${undated.length - backfilledIds.size} remain invisible pending an InfoEd fix.`,
    );
    console.log(
      `After filtering to active CWIDs + non-null dates: ${prepared.length} grants.`,
    );

    const inserts = prepared.map(({ row: r, datesSource }) => {
      const role = ROLE_MAP[r.Role] ?? "Key Personnel";

      // Issue #78 F6 — prime is Orig_Sponsor (always populated when this row
      // exists; defensive-fallback to "(unknown sponsor)" matches the prior
      // funder-string contract). Direct equals prime when WCM holds the
      // award directly; Subward_Sponsor is set by the query when WCM is the
      // sub-recipient.
      const primeRaw = r.Orig_Sponsor?.trim() || null;
      const directRaw = (r.Subward_Sponsor?.trim() || primeRaw) ?? null;
      const isSubaward =
        !!primeRaw && !!directRaw && primeRaw !== directRaw;

      const funderParts = [primeRaw ?? "(unknown sponsor)"];
      if (r.Subward_Sponsor) funderParts.push(`via ${r.Subward_Sponsor}`);

      // Issue #78 F2 — derive mechanism + IC from the award number for NIH
      // grants. Returns nulls for non-NIH formats.
      const award = parseNihAward(r.Award_Number);

      return {
        cwid: r.CWID!,
        title: r.proj_title?.trim() || `(untitled grant ${r.Account_Number})`,
        role,
        funder: funderParts.join(" "),
        startDate: r.begin_date!,
        endDate: r.end_date!,
        externalId: `INFOED-${r.Account_Number}-${r.CWID}`,
        awardNumber: r.Award_Number?.trim() || null,
        source: "InfoEd",
        datesSource,
        programType: r.program_type?.trim() || "Grant",
        primeSponsor: canonicalizeSponsor(primeRaw),
        primeSponsorRaw: primeRaw,
        directSponsor: canonicalizeSponsor(directRaw),
        directSponsorRaw: directRaw,
        mechanism: award.mechanism,
        nihIc: award.nihIc,
        isSubaward,
      };
    });

    // Issue #352 — reconcile grants by externalId instead of truncate-and-
    // recreate, so each row keeps its uuid PK across runs and the manual-
    // override layer (ADR-005) can key on it. Updating in place also preserves
    // the abstract / applId enrichment columns written by the gates / nsf /
    // reporter ETLs — the old deleteMany wiped them on every run.
    const existingGrants = await db.write.grant.findMany({
      where: { source: "InfoEd" },
      select: {
        externalId: true, cwid: true, title: true, role: true, funder: true,
        startDate: true, endDate: true, awardNumber: true, source: true,
        datesSource: true,
        programType: true, primeSponsor: true, primeSponsorRaw: true,
        directSponsor: true, directSponsorRaw: true, mechanism: true,
        nihIc: true, isSubaward: true,
      },
    });
    const plan = classifyByExternalId({
      incoming: inserts,
      existing: existingGrants,
      contentKey: (g) =>
        JSON.stringify([
          g.cwid, g.title, g.role, g.funder,
          g.startDate.toISOString().slice(0, 10),
          g.endDate.toISOString().slice(0, 10),
          g.awardNumber, g.source, g.datesSource, g.programType, g.primeSponsor,
          g.primeSponsorRaw, g.directSponsor, g.directSponsorRaw,
          g.mechanism, g.nihIc, g.isSubaward,
        ]),
    });
    if (plan.duplicateExternalIds.length > 0) {
      console.warn(
        `[InfoEd] ${plan.duplicateExternalIds.length} duplicate externalId(s) in ` +
          `source rows — last occurrence wins: ${plan.duplicateExternalIds
            .slice(0, 10)
            .join(", ")}`,
      );
    }

    console.log(
      `Reconciling grants: ${plan.toCreate.length} new, ${plan.toUpdate.length} ` +
        `changed, ${plan.staleExternalIds.length} stale...`,
    );
    for (const batch of chunks(plan.toCreate, INSERT_BATCH)) {
      await db.write.grant.createMany({ data: batch });
    }
    for (const g of plan.toUpdate) {
      await db.write.grant.update({
        where: { externalId: g.externalId },
        data: { ...g, lastRefreshedAt: new Date() },
      });
    }
    // A truncated-but-successful MSSQL read marks every missing grant stale;
    // normal expiration churn is a trickle, so a >10% single-run tombstone
    // means a bad source read, not real attrition.
    assertPruneVolume("infoed:stale-grants", {
      pruning: plan.staleExternalIds.length,
      of: await db.write.grant.count({ where: { source: "InfoEd" } }),
      maxPct: 10,
    });
    let tombstoned = 0;
    if (plan.staleExternalIds.length > 0) {
      tombstoned = (
        await db.write.grant.deleteMany({
          where: { source: "InfoEd", externalId: { in: plan.staleExternalIds } },
        })
      ).count;
    }
    console.log(
      `Grant reconcile complete: +${plan.toCreate.length} ~${plan.toUpdate.length} -${tombstoned}`,
    );

    await reconcileDateGaps(undated, backfilledIds);

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: inserts.length,
      },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`InfoEd ETL complete in ${elapsed}s: grants=${inserts.length}`);
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
    await closeInfoedPool();
    await closeReciterPool();
  });
