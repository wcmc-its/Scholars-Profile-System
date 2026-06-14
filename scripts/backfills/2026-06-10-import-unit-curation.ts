/**
 * #540 Phase 9 — unit-curation cutover backfill (launch, one-shot).
 *
 * The org-unit curation feature retires the file/seed manual curation of
 * ADR-002 (`data/division-chiefs.txt`, Path C) and ADR-003
 * (`data/center-members/*.txt`). The 8 seeded centers and their file-sourced
 * rosters move into the manual override layer so they are curated through
 * `/edit/center/*` going forward. This backfill performs that move and verifies
 * it with audit queries C and E from `docs/unit-curation-spec.md` § Audit
 * queries — the operator confirms the printed counts *before* the seed loaders
 * are removed. (Spec § Interfaces — "the backfill executes and is verified by an
 * audit query before the loader code paths are removed".)
 *
 * What it does, idempotently:
 *   1. Fixture-load — if the DB has no center rows yet (a fresh clone or CI run,
 *      now that `prisma/seed-centers.ts` is retired), recreate the 8 centers and
 *      the Meyer programs as `source='manual'`. Existing rows are left untouched
 *      so a UI-edited description is never clobbered.
 *   2. Migrate centers `source='seed'` -> `source='manual'` (WHERE-guarded; rows
 *      already `manual` are skipped). The 8 center rows become manually-owned.
 *   3. Migrate center memberships `source LIKE 'file:%'` -> `source='manual'`
 *      (WHERE-guarded). `manual-ui` / `manual` rows are never touched (edge 26).
 *   4. Print audit queries C (manually-created units) and E (manual rosters) so
 *      the operator validates the final state.
 *
 * `data/division-chiefs.txt` -> `field_override(division, leaderCwid|leaderInterim)`
 * is part of the same spec step, but those source files do not exist in the repo
 * (already deleted, never tracked) and the override row carries no `source`
 * discriminator to migrate — there is nothing to read. Any division-leader
 * overrides created through the UI are already in the correct final shape. The
 * `field_override` table is therefore left as-is; audit query A (pending slug
 * overrides) and the curation UI cover that surface.
 *
 * Idempotent and re-runnable: every step is WHERE-guarded, so a repeat run is a
 * no-op. This is nonetheless a one-shot launch migration — run it once per DB.
 *
 * Flags (see scripts/backfills/README.md):
 *   --dry-run        report counts and the audit queries; write nothing.
 *   --limit=<n>      cap the number of rows updated per step (sampling).
 *
 * Run: npx tsx scripts/backfills/2026-06-10-import-unit-curation.ts [--dry-run] [--limit=N]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { CENTERS, CENTER_PROGRAMS } from "../../prisma/center-seed-data";

/**
 * The narrow slice of the Prisma client this backfill touches. Declared
 * structurally so the unit tests can supply a mock without a live DB.
 */
export type BackfillDb = {
  center: {
    count(): Promise<number>;
    findMany(args: {
      where?: { source?: string };
      select?: Record<string, boolean>;
      take?: number;
    }): Promise<Array<{ code: string }>>;
    upsert(args: unknown): Promise<unknown>;
    updateMany(args: {
      where: { source?: string; code?: { in: string[] } };
      data: { source: string };
    }): Promise<{ count: number }>;
  };
  centerProgram: {
    upsert(args: unknown): Promise<unknown>;
  };
  centerMembership: {
    updateMany(args: {
      where: { source: { startsWith: string } };
      data: { source: string };
    }): Promise<{ count: number }>;
  };
};

export type BackfillOptions = {
  dryRun: boolean;
  limit: number | null;
};

export type AuditRowC = {
  unit: "division" | "center";
  code: string;
  name: string;
  scholarCount: number;
};

export type AuditRowE = {
  unitKind: "center" | "division";
  code: string;
  cwid: string;
  source: string;
};

export type BackfillResult = {
  fixtureCentersCreated: number;
  fixtureProgramsUpserted: number;
  centersMigrated: number;
  membershipsMigrated: number;
  auditC: AuditRowC[];
  auditE: AuditRowE[];
};

export function parseArgs(argv: string[]): BackfillOptions {
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  let limit: number | null = null;
  if (limitArg) {
    const n = Number.parseInt(limitArg.slice("--limit=".length), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
    }
    limit = n;
  }
  return { dryRun, limit };
}

const log = (msg: string) => console.log(msg);

/**
 * Step 1 — fixture load. Only when the DB has no center rows at all (fresh
 * clone / CI, post-`seed-centers.ts` retirement). Creates missing centers and
 * Meyer programs as `source='manual'`; existing rows are upserted with
 * non-destructive updates so UI edits survive.
 */
export async function fixtureLoadCenters(
  db: BackfillDb,
  opts: BackfillOptions,
): Promise<{ centersCreated: number; programsUpserted: number }> {
  const existing = await db.center.count();
  if (existing > 0) {
    log(`Fixture load: skipped (${existing} center row(s) already present).`);
    return { centersCreated: 0, programsUpserted: 0 };
  }

  log(`Fixture load: no centers present — creating ${CENTERS.length} as source='manual'.`);
  if (opts.dryRun) {
    log(`  [dry-run] would create ${CENTERS.length} centers and upsert ${CENTER_PROGRAMS.length} programs.`);
    return { centersCreated: 0, programsUpserted: 0 };
  }

  let centersCreated = 0;
  for (const c of CENTERS) {
    await db.center.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        name: c.name,
        slug: c.slug,
        compactName: c.compactName,
        description: c.description,
        sortOrder: c.sortOrder,
        centerType: c.centerType,
        source: "manual",
      },
      update: {
        name: c.name,
        slug: c.slug,
        compactName: c.compactName,
        description: c.description,
        sortOrder: c.sortOrder,
        centerType: c.centerType,
      },
    });
    centersCreated += 1;
  }

  let programsUpserted = 0;
  for (const p of CENTER_PROGRAMS) {
    await db.centerProgram.upsert({
      where: { centerCode_code: { centerCode: p.centerCode, code: p.code } },
      create: p,
      update: { label: p.label, sortOrder: p.sortOrder },
    });
    programsUpserted += 1;
  }
  log(`  created ${centersCreated} centers, upserted ${programsUpserted} programs.`);
  return { centersCreated, programsUpserted };
}

/**
 * Step 2 — migrate centers `source='seed'` -> `source='manual'`. WHERE-guarded,
 * so rows already `manual` are skipped and a repeat run is a no-op.
 *
 * `--limit` is honored by collecting the candidate codes first and scoping the
 * `updateMany` to exactly those codes (Prisma `updateMany` has no `take`, so the
 * cap is applied via the `code: { in }` filter — #991).
 */
export async function migrateCenterSource(
  db: BackfillDb,
  opts: BackfillOptions,
): Promise<number> {
  const candidates = await db.center.findMany({
    where: { source: "seed" },
    select: { code: true },
    ...(opts.limit != null ? { take: opts.limit } : {}),
  });
  log(`Centers with source='seed': ${candidates.length}${opts.limit != null ? ` (capped at --limit=${opts.limit})` : ""}.`);
  if (candidates.length === 0) return 0;

  if (opts.dryRun) {
    log(`  [dry-run] would set source='manual' on: ${candidates.map((c) => c.code).join(", ")}`);
    return 0;
  }

  // Scope the update to exactly the sampled codes (the `--limit`-capped candidate
  // set), re-asserting `source='seed'` so an already-`manual` row is never touched
  // and a repeat run stays a no-op. #991 — the prior `where: { source }` alone
  // IGNORED `--limit` and updated every seed center, contradicting the docstring.
  const { count } = await db.center.updateMany({
    where: { code: { in: candidates.map((c) => c.code) }, source: "seed" },
    data: { source: "manual" },
  });
  log(`  migrated ${count} center(s) source='seed' -> 'manual'.`);
  return count;
}

/**
 * Step 3 — migrate center memberships `source LIKE 'file:%'` -> `source='manual'`.
 * WHERE-guarded on the `file:` prefix, so `manual` / `manual-ui` rows added
 * through the UI are never touched (edge case 26).
 */
export async function migrateMembershipSource(
  db: BackfillDb,
  opts: BackfillOptions,
): Promise<number> {
  if (opts.dryRun) {
    // No cheap count without a read delegate in the structural type; report intent.
    log(`  [dry-run] would set source='manual' on center_membership rows where source LIKE 'file:%'.`);
    return 0;
  }
  const { count } = await db.centerMembership.updateMany({
    where: { source: { startsWith: "file:" } },
    data: { source: "manual" },
  });
  log(`Memberships migrated source='file:*' -> 'manual': ${count}.`);
  return count;
}

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  log(
    `#540 Phase 9 unit-curation backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}` +
      `${opts.limit != null ? ` [limit=${opts.limit}]` : ""}`,
  );

  // Imported lazily so the structural BackfillDb type stays the contract and the
  // unit tests never load the real client.
  const { db } = await import("../../lib/db");
  const { runAuditQueryC, runAuditQueryE } = await import("./audit-unit-curation");

  const fixture = await fixtureLoadCenters(db.write as unknown as BackfillDb, opts);
  const centersMigrated = await migrateCenterSource(db.write as unknown as BackfillDb, opts);
  const membershipsMigrated = await migrateMembershipSource(db.write as unknown as BackfillDb, opts);

  log("\n--- Audit query C: manually-created units (spec § Audit queries) ---");
  const auditC = await runAuditQueryC(db.read);
  for (const r of auditC) {
    log(`  ${r.unit.padEnd(8)} ${r.code.padEnd(28)} count=${r.scholarCount}  ${r.name}`);
  }
  log(`  C total: ${auditC.length} manually-owned unit(s).`);

  log("\n--- Audit query E: manual rosters (spec § Audit queries) ---");
  const auditE = await runAuditQueryE(db.read);
  for (const r of auditE) {
    log(`  ${r.unitKind.padEnd(8)} ${r.code.padEnd(28)} ${r.cwid.padEnd(12)} source=${r.source}`);
  }
  log(`  E total: ${auditE.length} manual roster row(s).`);

  const result: BackfillResult = {
    fixtureCentersCreated: fixture.centersCreated,
    fixtureProgramsUpserted: fixture.programsUpserted,
    centersMigrated,
    membershipsMigrated,
    auditC,
    auditE,
  };
  log(
    `\nDone${opts.dryRun ? " (dry run)" : ""}. ` +
      `fixtureCenters=${result.fixtureCentersCreated}, ` +
      `centersMigrated=${result.centersMigrated}, ` +
      `membershipsMigrated=${result.membershipsMigrated}, ` +
      `manualUnits=${result.auditC.length}, manualRosterRows=${result.auditE.length}.`,
  );

  await db.write.$disconnect();
};

// Run only when invoked directly (not when imported by the unit test).
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
