/**
 * InfoEd grants probe — runs the user's 3-step query consolidated into a
 * single CTE statement against raw wc_infoedprod tables. Scoped to one CWID
 * so we can validate the shape without scanning the whole institution.
 *
 * The 3 steps in the original query:
 *   1. Pull all PT-system WCORNELLMC proposals with all their role/sponsor info
 *   2. Stage in temp table `infoed_all`
 *   3. Aggregate (status concat, max award number, min start, max end) per
 *      (cwid, Account_Number); compute final Role
 *
 * We collapse that into one query by replacing the temp table with a CTE.
 *
 * Usage: `npm run etl:infoed:probe`
 */
import { closeInfoedPool, getInfoedPool } from "@/lib/sources/mssql-infoed";

const TEST_CWID = "thc2015";

async function main() {
  const pool = await getInfoedPool();

  console.log(`=== Grants for CWID '${TEST_CWID}' ===\n`);
  try {
    const result = await pool
      .request()
      .input("cwid", TEST_CWID)
      .query(`
WITH infoed_all AS (
  SELECT DISTINCT
    CASE WHEN prop.parentprop_no IS NULL THEN prop.prop_no ELSE prop.parentprop_no END AS Account_Number,
    prop.inst_no        AS RecordID,
    ct.code_desc        AS Submission_Status,
    ct.code_desc        AS Program_Type,
    p_udf.p_sin_5       AS intake_type,
    CASE WHEN p_udf.p_log_50 = 1 THEN 'Y' ELSE 'N' END AS Confidential,
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
    AND  facu.employer_id = @cwid     -- scope to one CWID for the probe
),
DistinctStatuses AS (
  SELECT DISTINCT cwid, Account_Number, Project_Status FROM infoed_all
),
StatusAgg AS (
  SELECT
    cwid, Account_Number,
    STRING_AGG(Project_Status, ' > ') WITHIN GROUP (ORDER BY
      CASE Project_Status
        WHEN 'Active Award' THEN 1
        WHEN 'Award Under Review' THEN 2
        WHEN 'Not Funded' THEN 3
        WHEN 'Pending Sponsor Determination' THEN 4
        WHEN 'Pending' THEN 5
        WHEN 'In Process' THEN 6
        WHEN 'Expired Award' THEN 7
        WHEN 'Canceled' THEN 8
        WHEN 'Status Assigned in Error' THEN 9
        ELSE 10
      END) AS Project_Status
  FROM DistinctStatuses
  GROUP BY cwid, Account_Number
)
SELECT DISTINCT
  v.CWID, v.Account_Number, x.Award_Number, y.begin_date, z.end_date,
  REPLACE(REPLACE(REPLACE(z.proj_title, CHAR(13), ' '), CHAR(10), ' '), '    ', '') AS proj_title,
  z.unit_name, z.int_unit_code, z.program_type, z.Orig_Sponsor,
  CASE WHEN z.Sponsor = z.Orig_Sponsor THEN NULL ELSE z.Sponsor END AS Subward_Sponsor,
  z.spon_code,
  CASE
    WHEN z.Sponsor = z.Orig_Sponsor AND z.Primary_PI_Flag = 'Y' THEN 'PrincipalInvestigatorRole'
    WHEN z.Sponsor <> z.Orig_Sponsor AND z.Primary_PI_Flag = 'Y' THEN 'PrincipalInvestigatorSubawardRole'
    WHEN z.Sponsor <> z.Orig_Sponsor AND z.Role_Category LIKE '%PI' THEN 'CoPrincipalInvestigatorRole'
    WHEN z.Role_Category LIKE '%Co-investigator' THEN 'CoInvestigatorRole'
    ELSE 'KeyPersonnelRole'
  END AS Role,
  sa.Project_Status
FROM infoed_all AS v
LEFT JOIN (SELECT cwid, Account_Number, MAX(Award_Number) AS Award_Number FROM infoed_all GROUP BY cwid, Account_Number) AS x
  ON x.cwid = v.cwid AND x.Account_Number = v.Account_Number
LEFT JOIN (SELECT cwid, Account_Number, MIN(Project_Period_Start) AS begin_date FROM infoed_all GROUP BY cwid, Account_Number) AS y
  ON y.cwid = v.cwid AND y.Account_Number = v.Account_Number
LEFT JOIN (
  SELECT cwid, Account_Number,
    MAX(Project_Period_End) AS end_date, MAX(Sponsor) AS Sponsor, MAX(Orig_Sponsor) AS Orig_Sponsor,
    MAX(spon_code) AS spon_code, MAX(proj_title) AS proj_title, MIN(program_type) AS program_type,
    MIN(unit_name) AS unit_name, MIN(int_unit_code) AS int_unit_code,
    MAX(Primary_PI_Flag) AS Primary_PI_Flag, MIN(role_category) AS Role_Category
  FROM infoed_all GROUP BY cwid, Account_Number
) AS z
  ON z.cwid = v.cwid AND z.Account_Number = v.Account_Number
LEFT JOIN StatusAgg AS sa
  ON sa.cwid = v.cwid AND sa.Account_Number = v.Account_Number
WHERE  v.unit_name IS NOT NULL
   AND v.program_type <> 'Contract without funding'
ORDER BY v.CWID, v.Account_Number;
      `);

    console.log(`Returned ${result.recordset.length} rows.\n`);
    console.log(JSON.stringify(result.recordset, null, 2));
  } catch (e) {
    console.log(`Probe error: ${(e as Error).message}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeInfoedPool();
  });
