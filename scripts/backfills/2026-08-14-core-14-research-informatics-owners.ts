/**
 * Grant the initial owners for core 14 (Research Informatics) — see #2405 /
 * ReciterAI #369 and `docs/core-facility-claim-queue-spec.md` § "Adding a
 * core" step 3: "A `UnitAdmin(entityType='core', ...)` row ... by direct
 * insert today (no admin write-UI yet)." This is that direct insert, done as
 * a checked-in, idempotent script rather than an untracked ad-hoc SQL command
 * — the RBAC-widen PR (P2 of `core-as-org-unit-plan.md`) will eventually let
 * an existing owner grant *subsequent* core owners through the real
 * `/api/edit/grant` UI; it does not change this bootstrap step.
 *
 * Owners requested directly (2026-08-14), not from the ReciterAI dictionary's
 * `owner_cwid` (left `null` there, matching all 13 other entries — that field
 * has never been operationally read by SPS; ownership always lives here):
 *   evs2008  Evan Sholle
 *   nik2004  Nivedita Chang
 *   saa3011  Sajjad Abedian
 *   thc2015  Thomas Campion
 *
 * Mirrors `POST /api/edit/grant`'s write shape exactly (one transaction: a
 * `unit_admin` upsert + one B03 audit row, `action: "grant_change"`) so this
 * grant is indistinguishable in the audit trail from one a human made through
 * the API — `lib/edit/audit.ts`'s `AuditEntityType` already carries `"core"`
 * (added alongside `core_claim`), so no schema/enum change is needed.
 * `grantedBy`/`actorCwid` is the operator running this script, not a fixed
 * sentinel — pass `--granted-by=<cwid>` (defaults to the sentinel
 * `"backfill"` if omitted, so a real actor should always be supplied).
 *
 * Safety (data-integrity rule — never write a guessed/typo'd id):
 *   - `entityId` must be a real `CORE_CATALOG` id (catches a typo'd core
 *     number). Unlike department/division/center grants, `cwid` need NOT
 *     resolve to a `scholar` row (ADR-005 Amendment 1: "Owners and Curators
 *     are commonly administrative staff with no profile" — `UnitAdmin.cwid`
 *     references a WCM person by LDAP identity, not a Scholar FK). The four
 *     cwids below were independently verified against `reciterdb.identity` /
 *     `analysis_summary_author` before this script was written (see PR
 *     #2405's description) — this script does not re-verify identity, only
 *     the core id.
 *   - The `core` table row itself need not exist yet (`unit_admin` has no FK
 *     by design) — the next ETL run creates it from `CORE_CATALOG`. Granting
 *     ahead of that is harmless: `authorizeCoreClaim` never checks core
 *     existence, only the `UnitAdmin` row.
 *   - Idempotent: each row is an upsert by composite PK `(entityType,
 *     entityId, cwid)` — a re-run updates `role`/`grantedBy` to the values
 *     below and appends a fresh audit row (matching the real API's
 *     re-grant-updates-audit-too behavior) rather than erroring.
 *
 * Flags:
 *   --dry-run              verify + report; write nothing.
 *   --granted-by=<cwid>    actor CWID recorded as grantor (required for a
 *                          real run; a dry-run may omit it).
 *
 * Run: npx tsx scripts/backfills/2026-08-14-core-14-research-informatics-owners.ts --granted-by=paa2013 [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";

import { CORE_CATALOG } from "../../etl/dynamodb/core-catalog";

const CORE_ID = "14";

const OWNERS: ReadonlyArray<{ cwid: string; name: string }> = [
  { cwid: "evs2008", name: "Evan Sholle" },
  { cwid: "nik2004", name: "Nivedita Chang" },
  { cwid: "saa3011", name: "Sajjad Abedian" },
  { cwid: "thc2015", name: "Thomas Campion" },
];

/** The narrow Prisma slice this backfill touches — structural so the unit
 *  test can supply a mock without a live DB. Matches `POST /api/edit/grant`'s
 *  own write shape (upsert + one B03 audit row, same transaction). */
export type CoreOwnerBackfillDb = {
  $transaction<T>(fn: (tx: CoreOwnerBackfillTx) => Promise<T>): Promise<T>;
};
export type CoreOwnerBackfillTx = {
  unitAdmin: {
    findUnique(args: {
      where: { entityType_entityId_cwid: { entityType: "core"; entityId: string; cwid: string } };
      select: { role: true; grantedBy: true };
    }): Promise<{ role: string; grantedBy: string } | null>;
    upsert(args: {
      where: { entityType_entityId_cwid: { entityType: "core"; entityId: string; cwid: string } };
      create: {
        entityType: "core";
        entityId: string;
        cwid: string;
        role: "owner";
        grantedBy: string;
        granteeName: string;
      };
      update: { role: "owner"; grantedBy: string; granteeName: string };
    }): Promise<unknown>;
  };
  $executeRawUnsafe?: unknown; // appendAuditRow needs only $executeRaw at the real call site
  $executeRaw: (...args: unknown[]) => Promise<unknown>;
};

export type BackfillOpts = { dryRun: boolean; grantedBy: string | null };
export type BackfillResult = { verified: number; upserted: number; dryRun: boolean };

function log(msg: string): void {
  console.log(msg);
}

export function parseArgs(argv: ReadonlyArray<string>): BackfillOpts {
  const grantedByArg = argv.find((a) => a.startsWith("--granted-by="));
  return {
    dryRun: argv.includes("--dry-run"),
    grantedBy: grantedByArg ? grantedByArg.slice("--granted-by=".length) : null,
  };
}

export async function runBackfill(
  db: CoreOwnerBackfillDb,
  appendAuditRow: (tx: CoreOwnerBackfillTx, row: Record<string, unknown>) => Promise<void>,
  opts: BackfillOpts,
): Promise<BackfillResult> {
  // 1. Verify the core id is real (catches a typo'd core number).
  if (!CORE_CATALOG.some((c) => c.id === CORE_ID)) {
    throw new Error(`Aborting — core id ${CORE_ID} not found in CORE_CATALOG. No rows written.`);
  }

  log(`Verified core ${CORE_ID} is in CORE_CATALOG. Granting owner to:`);
  for (const o of OWNERS) log(`  ${o.cwid.padEnd(10)} (${o.name})`);

  if (opts.dryRun) {
    log(`\n[DRY RUN] would upsert ${OWNERS.length} unit_admin row(s) + ${OWNERS.length} audit row(s). Nothing written.`);
    return { verified: OWNERS.length, upserted: 0, dryRun: true };
  }

  if (!opts.grantedBy) {
    throw new Error("Aborting — --granted-by=<cwid> is required for a real (non-dry-run) write.");
  }
  const grantedBy = opts.grantedBy;

  let upserted = 0;
  await db.$transaction(async (tx) => {
    for (const o of OWNERS) {
      const existing = await tx.unitAdmin.findUnique({
        where: { entityType_entityId_cwid: { entityType: "core", entityId: CORE_ID, cwid: o.cwid } },
        select: { role: true, grantedBy: true },
      });
      await tx.unitAdmin.upsert({
        where: { entityType_entityId_cwid: { entityType: "core", entityId: CORE_ID, cwid: o.cwid } },
        create: {
          entityType: "core",
          entityId: CORE_ID,
          cwid: o.cwid,
          role: "owner",
          grantedBy,
          granteeName: o.name,
        },
        update: { role: "owner", grantedBy, granteeName: o.name },
      });
      await appendAuditRow(tx, {
        actorCwid: grantedBy,
        impersonatedCwid: null,
        targetEntityType: "core",
        targetEntityId: CORE_ID,
        action: "grant_change",
        fieldsChanged: null,
        beforeValues: existing ? { cwid: o.cwid, role: existing.role, granted_by: existing.grantedBy } : null,
        afterValues: { cwid: o.cwid, role: "owner", granted_by: grantedBy },
        ts: new Date(),
        requestId: null,
      });
      upserted += 1;
    }
  });
  log(`\nUpserted ${upserted} unit_admin row(s) + ${upserted} audit row(s).`);
  return { verified: OWNERS.length, upserted, dryRun: false };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`core-14 owners backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  const { db } = await import("../../lib/db");
  const { appendAuditRow } = await import("../../lib/edit/audit");
  try {
    await runBackfill(
      db.write as unknown as CoreOwnerBackfillDb,
      appendAuditRow as unknown as (tx: CoreOwnerBackfillTx, row: Record<string, unknown>) => Promise<void>,
      opts,
    );
  } finally {
    await db.write.$disconnect();
  }
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
