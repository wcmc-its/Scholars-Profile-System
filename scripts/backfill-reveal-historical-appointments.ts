/**
 * One-time backfill for the #1323 follow-up (etl/ed/index.ts): historical
 * (ED-HISTORICAL) appointments now default to `showOnProfile: true` on
 * INSERT, but that only applies to rows the ETL creates going forward.
 * Existing hidden rows need this backfill to reveal, or a long-tenured
 * scholar keeps looking newly arrived until their next role change re-syncs.
 *
 * Only touches rows nobody has ever acted on. Anything with an
 * `appointment_visibility_set` audit row (a curator explicitly showed OR
 * hid it) is left exactly as a human set it — this can't tell "curator hid
 * it on purpose" apart from "still at the old default" except via the audit
 * log, so the audit log is the source of truth for "untouched."
 *
 * Dry-run by default; pass --apply to write.
 *
 * Run (needs DATABASE_URL; in-VPC, e.g. via sps-etl-<env>):
 *   npx tsx scripts/backfill-reveal-historical-appointments.ts
 *   npx tsx scripts/backfill-reveal-historical-appointments.ts --apply
 */
import "dotenv/config";
import { createConnection } from "mariadb";

/** Pure set-difference so the "don't touch curator decisions" rule is
 *  testable without a database. */
export function idsToReveal(hiddenExternalIds: string[], auditedExternalIds: Set<string>): string[] {
  return hiddenExternalIds.filter((id) => !auditedExternalIds.has(id));
}

const CHUNK = 500;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Copy .env.example to .env.local and set it.");
    process.exit(1);
  }
  const u = new URL(url);
  const conn = await createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.slice(1),
  });

  try {
    const hiddenRows: Array<{ external_id: string }> = await conn.query(
      "SELECT external_id FROM appointment WHERE source = 'ED-HISTORICAL' AND show_on_profile = 0",
    );
    const auditedRows: Array<{ target_entity_id: string }> = await conn.query(
      "SELECT DISTINCT target_entity_id FROM scholars_audit.manual_edit_audit " +
        "WHERE target_entity_type = 'appointment' AND action = 'appointment_visibility_set'",
    );
    const audited = new Set(auditedRows.map((r) => r.target_entity_id));
    const toReveal = idsToReveal(hiddenRows.map((r) => r.external_id), audited);

    console.log(`${hiddenRows.length} historical rows currently hidden`);
    console.log(`${audited.size} appointments have a curator visibility decision on file`);
    console.log(`${toReveal.length} rows are untouched defaults -- would flip to showOnProfile=true`);

    if (!apply) {
      console.log("\nDry run only (default). Re-run with --apply to write.");
      return;
    }
    if (toReveal.length === 0) {
      console.log("nothing to do");
      return;
    }
    for (let i = 0; i < toReveal.length; i += CHUNK) {
      const chunk = toReveal.slice(i, i + CHUNK);
      await conn.query(
        `UPDATE appointment SET show_on_profile = 1 WHERE external_id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
    }
    console.log(`updated ${toReveal.length} rows`);
  } finally {
    await conn.end();
  }
}

// --- self-check: the one rule this script exists to enforce -----------------
export function selfCheck(): void {
  const hidden = ["untouched-1", "curator-hid-2", "untouched-3"];
  const audited = new Set(["curator-hid-2"]);
  const result = idsToReveal(hidden, audited);
  if (result.length !== 2 || result.includes("curator-hid-2")) {
    throw new Error(`a curator decision must survive the backfill: ${JSON.stringify(result)}`);
  }
}

if (process.argv[1] && process.argv[1].includes("backfill-reveal-historical-appointments")) {
  selfCheck();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
