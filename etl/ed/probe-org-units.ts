/**
 * One-shot probe to verify D-02 LDAP attribute names against real WCM ED data.
 * Resolves 03-RESEARCH.md Pitfall 2 + Open Question 1 before Plan 03 ETL work.
 *
 * Run: `npx tsx etl/ed/probe-org-units.ts`
 *
 * Output: prints a Markdown report to stdout. Caller redirects to:
 *   .planning/phases/03-topic-and-department-detail-pages/03-LDAP-PROBE.md
 *
 * Probes these candidate attributes per CONTEXT.md D-02:
 *   - departmentNumber              (already in ED_FACULTY_ATTRIBUTES line ~39)
 *   - weillCornellEduOrgUnit
 *   - weillCornellEduOrgUnitCode
 *   - weillCornellEduDepartmentCode
 *
 * PII rule: do NOT log raw cwid or preferredCN values. Log only attribute
 * presence (non-empty count) and value SHAPE (e.g., "5-digit numeric",
 * "alphanumeric with hyphens"). This probe output lands in .planning/ which
 * is gitignored per project discipline.
 *
 * The probe SHOULD NOT modify any database state. Read-only.
 */
import {
  DEFAULT_ACTIVE_FILTER,
  DEFAULT_SEARCH_BASE,
  openLdap,
} from "@/lib/sources/ldap";

const PROBE_ATTRIBUTES = [
  "weillCornellEduCWID",
  "preferredCN",
  "departmentNumber",
  "weillCornellEduOrgUnit",
  "weillCornellEduOrgUnitCode",
  "weillCornellEduDepartmentCode",
] as const;

const SAMPLE_LIMIT = 10;

/** Classify value shape without revealing PII */
function describeShape(value: string): string {
  if (!value) return "empty";
  if (/^\d+$/.test(value)) return `${value.length}-digit numeric`;
  if (/^[a-z0-9]+$/i.test(value)) return `${value.length}-char alphanumeric`;
  if (/^[a-z0-9-]+$/i.test(value)) return `${value.length}-char alphanumeric-with-hyphens`;
  return `${value.length}-char mixed`;
}

function firstString(v: unknown): string {
  if (Array.isArray(v)) {
    const f = v.find((x) => typeof x === "string");
    return typeof f === "string" ? f : "";
  }
  return typeof v === "string" ? v : "";
}

async function main() {
  const url = process.env.SCHOLARS_LDAP_URL;
  if (!url) {
    console.error("ERROR: SCHOLARS_LDAP_URL not set. Ensure VPN is connected and ~/.zshenv has SCHOLARS_LDAP_* vars.");
    process.exit(1);
  }

  console.log("# Phase 3 LDAP Org-Unit Attribute Probe");
  console.log(`\nRun at: ${new Date().toISOString()}`);
  console.log(`Sample size target: ${SAMPLE_LIMIT}`);
  console.log("\nConnecting to LDAP...");

  let client;
  try {
    client = await openLdap();
  } catch (err) {
    console.error(`ERROR: Could not connect to LDAP: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Ensure VPN is connected and SCHOLARS_LDAP_BIND_PASSWORD is set in ~/.zshenv.");
    process.exit(1);
  }

  const searchBase = process.env.SCHOLARS_LDAP_SEARCH_BASE ?? DEFAULT_SEARCH_BASE;
  const filter = process.env.SCHOLARS_LDAP_ACTIVE_FILTER ?? DEFAULT_ACTIVE_FILTER;

  try {
    const { searchEntries } = await client.search(searchBase, {
      scope: "sub",
      filter,
      attributes: [...PROBE_ATTRIBUTES],
      paged: { pageSize: SAMPLE_LIMIT },
    });

    const sample = searchEntries.slice(0, SAMPLE_LIMIT);
    console.log(`\nActual sample size: ${sample.length}`);

    // Tally presence and shape for each candidate attribute
    // (never log raw cwid or preferredCN values — PII rule)
    const attrStats: Record<string, { nonEmpty: number; shapes: Set<string> }> = {
      departmentNumber: { nonEmpty: 0, shapes: new Set() },
      weillCornellEduOrgUnit: { nonEmpty: 0, shapes: new Set() },
      weillCornellEduOrgUnitCode: { nonEmpty: 0, shapes: new Set() },
      weillCornellEduDepartmentCode: { nonEmpty: 0, shapes: new Set() },
    };

    for (const entry of sample) {
      for (const attr of Object.keys(attrStats)) {
        const val = firstString(entry[attr]);
        if (val) {
          attrStats[attr].nonEmpty++;
          attrStats[attr].shapes.add(describeShape(val));
        }
      }
    }

    console.log("\n## Attribute Presence Summary\n");
    console.log("| Attribute | Non-empty / Sample | Value Shape(s) |");
    console.log("|-----------|-------------------|----------------|");
    for (const [attr, stats] of Object.entries(attrStats)) {
      const shapes = stats.shapes.size > 0 ? [...stats.shapes].join(", ") : "n/a (all empty)";
      console.log(`| ${attr} | ${stats.nonEmpty}/${sample.length} | ${shapes} |`);
    }

    // Cross-comparison: do departmentNumber and weillCornellEduOrgUnitCode match?
    let matchCount = 0;
    let bothPresentCount = 0;
    for (const entry of sample) {
      const deptNum = firstString(entry.departmentNumber);
      const orgUnitCode = firstString(entry.weillCornellEduOrgUnitCode);
      if (deptNum && orgUnitCode) {
        bothPresentCount++;
        if (deptNum === orgUnitCode) matchCount++;
      }
    }

    console.log("\n## Cross-Attribute Comparison\n");
    if (bothPresentCount > 0) {
      console.log(
        `departmentNumber == weillCornellEduOrgUnitCode: ${matchCount}/${bothPresentCount} entries where both are non-empty`
      );
    } else {
      console.log("Could not compare: at least one of departmentNumber / weillCornellEduOrgUnitCode was empty in all sample entries.");
    }

    // Conclusion
    console.log("\n## Conclusion\n");
    const deptNumStats = attrStats.departmentNumber;
    const orgUnitCodeStats = attrStats.weillCornellEduOrgUnitCode;
    const deptCodeStats = attrStats.weillCornellEduDepartmentCode;
    const orgUnitStats = attrStats.weillCornellEduOrgUnit;

    if (deptNumStats.nonEmpty === sample.length && matchCount === bothPresentCount && bothPresentCount > 0) {
      console.log(`departmentNumber and weillCornellEduOrgUnitCode return identical values for ${matchCount}/${sample.length} faculty.`);
      console.log("RECOMMENDED MAPPING: scholar.deptCode = e.departmentNumber (already fetched; no new LDAP attribute needed)");
    } else if (orgUnitCodeStats.nonEmpty > 0) {
      console.log(`weillCornellEduOrgUnitCode is populated for ${orgUnitCodeStats.nonEmpty}/${sample.length} entries.`);
      console.log("RECOMMENDED MAPPING: scholar.deptCode = e.weillCornellEduOrgUnitCode");
    } else if (deptCodeStats.nonEmpty > 0) {
      console.log(`weillCornellEduDepartmentCode is populated for ${deptCodeStats.nonEmpty}/${sample.length} entries.`);
      console.log("RECOMMENDED MAPPING: scholar.deptCode = e.weillCornellEduDepartmentCode");
    } else if (deptNumStats.nonEmpty > 0) {
      console.log(`departmentNumber is the only non-empty org-unit field (${deptNumStats.nonEmpty}/${sample.length} entries).`);
      console.log("RECOMMENDED MAPPING: scholar.deptCode = e.departmentNumber");
    } else {
      console.log("WARNING: No org-unit attributes returned non-empty values in this sample.");
      console.log("RECOMMENDED ACTION: Expand sample, verify search filter, or check VPN connectivity to LDAP.");
    }

    if (orgUnitStats.nonEmpty > 0) {
      console.log(`\nweillCornellEduOrgUnit (display name) is non-empty for ${orgUnitStats.nonEmpty}/${sample.length} entries — use for display only, not as stable join key.`);
      console.log("RECOMMENDED MAPPING: scholar.divCode = e.weillCornellEduOrgUnit (if subdivision granularity needed) — verify with Plan 03 ETL author.");
    } else {
      console.log("\nweillCornellEduOrgUnit: all entries empty in this sample. Division code may not be available via LDAP — verify with Plan 03 ETL author.");
    }

  } finally {
    await client.unbind();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
