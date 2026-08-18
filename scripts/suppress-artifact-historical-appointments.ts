/**
 * One-time remediation, companion to scripts/backfill-reveal-historical-appointments.ts.
 *
 * That backfill revealed every pre-2026-08 historical (ED-HISTORICAL)
 * appointment. Most are real career history, but a chunk are WOOFA
 * effective-dating artifacts — an "(Interim)" title swap, a "Pre-Start
 * Academic" placeholder — that read as confusing noise on a public profile
 * (e.g. "Assistant Professor of Surgery (Interim)" for exactly one day).
 * Measured on prod 2026-08: 276 of 12,177 historical rows are <= 7 days, with
 * a clean gap to the next bucket (35 at 2-7 days vs 484 at 8-30) — every
 * sampled row at or below the cutoff was one of these shapes. Same threshold
 * as `ARTIFACT_MAX_DAYS` / `looksLikeArtifactAppointment` in etl/ed/index.ts,
 * which now applies it going forward on INSERT; this script re-hides the
 * already-revealed backlog. Duplicated as a raw SQL predicate rather than
 * imported — etl/ed/index.ts runs its full ED sync as an import side effect
 * outside vitest (`if (!process.env.VITEST) main()`), so importing it from a
 * plain script would kick off a full sync.
 *
 * Only touches rows nobody has ever acted on — same rule as the reveal
 * backfill: anything with an `appointment_visibility_set` audit row (a
 * curator explicitly showed OR hid it, including a curator choosing to show
 * a short one) is left exactly as a human set it.
 *
 * Two connections, one process — see backfill-reveal-historical-appointments.ts
 * for why (the etl role can't read scholars_audit).
 *
 * Dry-run by default; pass --apply to write.
 *
 * Run (needs DATABASE_URL; in-VPC, e.g. via sps-etl-<env>):
 *   npx tsx scripts/suppress-artifact-historical-appointments.ts
 *   npx tsx scripts/suppress-artifact-historical-appointments.ts --apply
 */
import "dotenv/config";
import { createConnection, type Connection } from "mariadb";

/** Same source of truth as etl/ed/index.ts's ARTIFACT_MAX_DAYS. */
const ARTIFACT_MAX_DAYS = 7;

/** Pure set-difference so the "don't touch curator decisions" rule is
 *  testable without a database. */
export function idsToSuppress(artifactShownIds: string[], auditedIds: Set<string>): string[] {
  return artifactShownIds.filter((id) => !auditedIds.has(id));
}

const CHUNK = 500;

async function connect(url: string | undefined, label: string): Promise<Connection> {
  if (!url) {
    console.error(`${label} not set. Copy .env.example to .env.local and set it.`);
    process.exit(1);
  }
  const u = new URL(url);
  return createConnection({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.slice(1),
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ro = await connect(process.env.DATABASE_URL_RO ?? process.env.DATABASE_URL, "DATABASE_URL_RO/DATABASE_URL");

  let toSuppress: string[];
  try {
    const artifactRows: Array<{ external_id: string }> = await ro.query(
      "SELECT external_id FROM appointment WHERE source = 'ED-HISTORICAL' AND show_on_profile = 1 " +
        "AND end_date IS NOT NULL AND DATEDIFF(end_date, start_date) <= ?",
      [ARTIFACT_MAX_DAYS],
    );
    const auditedRows: Array<{ target_entity_id: string }> = await ro.query(
      "SELECT DISTINCT target_entity_id FROM scholars_audit.manual_edit_audit " +
        "WHERE target_entity_type = 'appointment' AND action = 'appointment_visibility_set'",
    );
    const audited = new Set(auditedRows.map((r) => r.target_entity_id));
    toSuppress = idsToSuppress(artifactRows.map((r) => r.external_id), audited);

    console.log(`${artifactRows.length} shown historical rows are <= ${ARTIFACT_MAX_DAYS} days`);
    console.log(`${audited.size} appointments have a curator visibility decision on file`);
    console.log(`${toSuppress.length} rows are untouched defaults -- would flip to showOnProfile=false`);
  } finally {
    await ro.end();
  }

  if (!apply) {
    console.log("\nDry run only (default). Re-run with --apply to write.");
    return;
  }
  if (toSuppress.length === 0) {
    console.log("nothing to do");
    return;
  }

  const rw = await connect(process.env.DATABASE_URL, "DATABASE_URL");
  try {
    for (let i = 0; i < toSuppress.length; i += CHUNK) {
      const chunk = toSuppress.slice(i, i + CHUNK);
      await rw.query(
        `UPDATE appointment SET show_on_profile = 0 WHERE external_id IN (${chunk.map(() => "?").join(",")})`,
        chunk,
      );
    }
    console.log(`updated ${toSuppress.length} rows`);
  } finally {
    await rw.end();
  }
}

// --- self-check: the one rule this script exists to enforce -----------------
export function selfCheck(): void {
  const shown = ["untouched-1", "curator-showed-2", "untouched-3"];
  const audited = new Set(["curator-showed-2"]);
  const result = idsToSuppress(shown, audited);
  if (result.length !== 2 || result.includes("curator-showed-2")) {
    throw new Error(`a curator decision must survive the remediation: ${JSON.stringify(result)}`);
  }
}

if (process.argv[1] && process.argv[1].includes("suppress-artifact-historical-appointments")) {
  selfCheck();
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
