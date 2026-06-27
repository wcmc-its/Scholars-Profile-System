/**
 * #1323 pre-rollout probe — confirm the historical (expired) faculty
 * appointment token BEFORE enabling the ED-HISTORICAL import in an env.
 *
 * The importer (`lib/sources/ldap.ts` `fetchHistoricalFacultyAppointments`)
 * selects `weillCornellEduStatus=faculty:expired` from the WOOFA faculty SOR
 * (`ou=faculty,ou=sors`). That token is documented in the active-filter comment
 * but was never probed against the live directory. This script:
 *   1. Censuses every faculty SOR role record by `weillCornellEduStatus`, so you
 *      can see which non-active tokens actually exist (faculty:expired,
 *      faculty:terminated, …).
 *   2. Dry-runs the real importer query and prints a few sample rows.
 *   3. Prints a PASS / REVIEW / FAIL verdict: whether `faculty:expired` is
 *      present and whether any OTHER non-active token would be MISSED by the
 *      current filter (→ widen DEFAULT_FACULTY_SOR_HISTORICAL_FILTER per the
 *      ponytail note in lib/sources/ldap.ts).
 *
 * Must run IN-VPC with LDAP reachable (SCHOLARS_LDAP_URL / _BIND_DN /
 * _BIND_PASSWORD set) — WCM LDAP sits behind the gated TGW link, so this can't
 * run from a laptop. Read-only: no DB or LDAP writes.
 *
 * Usage:
 *   npx tsx etl/ed/probe-historical-appointments.ts
 */
import "dotenv/config";

import {
  DEFAULT_FACULTY_SOR_BASE,
  fetchHistoricalFacultyAppointments,
  openLdap,
} from "../../lib/sources/ldap";

/** ldapts surfaces attributes as string | string[] | Buffer | undefined. */
function firstStr(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
  return typeof v === "string" ? v : null;
}

/** All faculty role records, regardless of status — the census population. */
const FACULTY_ROLE_RECORD = "(objectClass=weillCornellEduSORRoleRecord)";

async function main() {
  const base = process.env.SCHOLARS_LDAP_FACULTY_SOR_BASE ?? DEFAULT_FACULTY_SOR_BASE;
  const client = await openLdap();
  try {
    // 1) Status census — every faculty role record, tallied by status. Reveals
    //    whether faculty:expired exists and whether OTHER non-active tokens do.
    console.log(`\n=== 1. weillCornellEduStatus census under ${base} ===`);
    const { searchEntries } = await client.search(base, {
      scope: "sub",
      filter: FACULTY_ROLE_RECORD,
      attributes: ["weillCornellEduStatus"],
      paged: { pageSize: 500 },
    });
    const byStatus = new Map<string, number>();
    for (const e of searchEntries) {
      const status = firstStr((e as Record<string, unknown>).weillCornellEduStatus) ?? "(none)";
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    }
    const rows = [...byStatus.entries()].sort((a, b) => b[1] - a[1]);
    for (const [status, count] of rows) {
      console.log(`  ${status.padEnd(28)} ${count.toLocaleString().padStart(8)}`);
    }
    console.log(
      `  ${"TOTAL".padEnd(28)} ${searchEntries.length.toLocaleString().padStart(8)} role records`,
    );

    // 2) Importer dry-run — exactly what the nightly ETL would pull.
    console.log(`\n=== 2. fetchHistoricalFacultyAppointments() dry-run (filter = faculty:expired) ===`);
    const historical = await fetchHistoricalFacultyAppointments(client);
    console.log(`  returned ${historical.length.toLocaleString()} historical appointment rows`);
    for (const a of historical.slice(0, 8)) {
      const start = a.startDate ? a.startDate.toISOString().slice(0, 10) : "?";
      const end = a.endDate ? a.endDate.toISOString().slice(0, 10) : "present";
      console.log(`  · ${a.cwid.padEnd(10)} ${a.title}  [${a.organization ?? "?"}]  ${start} → ${end}`);
    }
    if (historical.length > 8) {
      console.log(`  … and ${(historical.length - 8).toLocaleString()} more`);
    }

    // 3) Verdict.
    console.log(`\n=== 3. Verdict ===`);
    const expiredCount = byStatus.get("faculty:expired") ?? 0;
    const nonActiveOther = rows.filter(
      ([s]) => s.startsWith("faculty:") && s !== "faculty:active" && s !== "faculty:expired",
    );
    if (expiredCount === 0) {
      console.log("  ✗ FAIL — no `faculty:expired` records found. The importer would import");
      console.log("    nothing. Re-check the token (see the census above) or fall back to a");
      console.log("    dedicated etl/asms importer. Do NOT enable the import in this env.");
    } else if (historical.length === 0) {
      console.log(`  ⚠ REVIEW — ${expiredCount} faculty:expired role records exist, but the`);
      console.log("    importer projection returned 0 rows (missing cwid/title/SORID on expired");
      console.log("    rows?). Inspect a raw expired entry before enabling the import.");
    } else {
      console.log(
        `  ✓ PASS — faculty:expired present; importer returned ${historical.length.toLocaleString()} usable rows.`,
      );
    }
    if (nonActiveOther.length > 0) {
      console.log("  ⚠ Other non-active faculty statuses exist that the current filter MISSES:");
      for (const [s, c] of nonActiveOther) console.log(`      ${s}  (${c.toLocaleString()})`);
      console.log("    If these should also count as historical, widen");
      console.log("    DEFAULT_FACULTY_SOR_HISTORICAL_FILTER to (&(...role)(!(...faculty:active)))");
      console.log("    per the ponytail note in lib/sources/ldap.ts.");
    } else {
      console.log(
        "  (No other non-active faculty:* statuses — faculty:expired is the complete historical set.)",
      );
    }
  } finally {
    await client.unbind();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
