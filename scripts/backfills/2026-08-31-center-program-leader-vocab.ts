/**
 * #2558 Phase 1 — seed the `center_program` role vocabulary (`leader`,
 * `coe_liaison`) and migrate `CenterProgramLeader` rows into
 * `OrgUnitRoleAssignment`.
 *
 * Gap left by #2542 Phase D (#2554): Phase D touched no center-program path,
 * so `center_program_leader` was never given a vocabulary to migrate onto —
 * `DEFAULT_ORG_UNIT_ROLES.center_program` was `[]` and the FK would have
 * rejected any assignment row. Measured in prod 2026-08-31:
 * `center_program_leader` holds 11 rows, ALL Meyer Cancer Center — `leader`
 * 7 rows across 4 programs, `coe_liaison` 4 rows across 4 programs (Meyer has
 * 5 programs; the fifth has no leader row today).
 *
 * `OrgUnitRoleAssignment.entityId` for a program assignment is
 * `"{centerCode}:{programCode}"` (the model's own docblock, prisma/schema.prisma)
 * — the composite PK admits one person leading two programs under the same
 * `roleKey`, the collision `CenterProgramLeader`'s own PK
 * (`[centerCode, programCode, cwid]`) could not express.
 *
 * Mirrors `scripts/backfills/2026-08-31-dept-div-role-vocabulary.ts` in
 * structure, dry-run convention, logging and idempotency. The key difference:
 * `center_program_leader` is written by the manual editor
 * (`/api/edit/center-program`), NOT an ETL, and that write path is
 * DELIBERATELY left untouched by this phase — it keeps writing
 * `CenterProgramLeader` only, exactly as it does today. This backfill is a
 * one-time copy, not a standing sync: the dual-read this phase also adds
 * (`lib/api/profile.ts`, `lib/edit/overview-facts.ts`) prefers the assignment
 * row this script writes, falling back to `CenterProgramLeader` when no
 * assignment exists yet. Keeping the two in sync going forward, and dropping
 * `CenterProgramLeader` outright, is the CONTRACT PR this phase sets up but
 * does not ship.
 *
 * What it does, in order:
 *   1. Seeds `DEFAULT_ORG_UNIT_ROLES.center_program` (`createMany` +
 *      `skipDuplicates`, so a curator's renamed label is never clobbered).
 *   2. Reads every `CenterProgramLeader` row (both `leader` and
 *      `coe_liaison`) and creates the matching `OrgUnitRoleAssignment` row
 *      for any `(entityType, entityId, cwid, roleKey)` that doesn't already
 *      hold one, carrying `interim` and `sortOrder` across unchanged — Meyer
 *      already orders its program leaders via `CenterProgramLeader.sortOrder`.
 *
 * Safety:
 *   - VERIFY-BEFORE-WRITE: refuses to run (throws, writes nothing beyond
 *     step 1) unless both vocabulary rows (`leader`, `coe_liaison`, entityType
 *     `center_program`) exist — otherwise the assignment's FK
 *     (`org_unit_role_assignment` -> `org_unit_role`) would dangle.
 *     `--dry-run` performs the same check and reports what would happen
 *     without writing.
 *   - Idempotent: skips any `(entityType, entityId, cwid, roleKey)` that
 *     already holds an assignment, so a re-run reports 0 to insert / 11
 *     already present rather than erroring or duplicating.
 *   - A leader cwid is NOT required to resolve to a `scholar` row — a program
 *     may be led by an external, non-WCM person (`lib/external-leaders.ts`),
 *     same allowance the center/dept/div backfills make.
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-08-31-center-program-leader-vocab.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { CENTER_PROGRAM_ENTITY_TYPE, orgUnitRoleSeedRows } from "../../lib/org-unit-roles";

/** Structural slice of the Prisma client this backfill needs, so the unit
 *  test never loads the real one — same posture as `DeptDivRoleBackfillDb`
 *  (`2026-08-31-dept-div-role-vocabulary.ts`). */
export type CenterProgramLeaderVocabBackfillDb = {
  centerProgramLeader: {
    findMany: (args: unknown) => Promise<
      {
        centerCode: string;
        programCode: string;
        cwid: string;
        role: string;
        interim: boolean;
        sortOrder: number;
      }[]
    >;
  };
  orgUnitRole: {
    createMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<{ entityType: string; key: string }[]>;
  };
  orgUnitRoleAssignment: {
    findMany: (
      args: unknown,
    ) => Promise<{ entityId: string; cwid: string; roleKey: string }[]>;
    create: (args: unknown) => Promise<unknown>;
  };
};

export type BackfillOptions = { dryRun: boolean };

export type BackfillResult = {
  legacyRows: number;
  rolesSeeded: number;
  assignmentsCreated: number;
  assignmentsAlreadyPresent: number;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): BackfillOptions {
  return { dryRun: argv.includes("--dry-run") };
}

const log = (msg: string): void => {
  console.log(msg);
};

/** The `entityId` a `CenterProgramLeader` row's `(centerCode, programCode)`
 *  maps to — see `OrgUnitRoleAssignment`'s own docblock. */
function programEntityId(centerCode: string, programCode: string): string {
  return `${centerCode}:${programCode}`;
}

export async function runBackfill(
  db: CenterProgramLeaderVocabBackfillDb,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const legacy = await db.centerProgramLeader.findMany({
    select: {
      centerCode: true,
      programCode: true,
      cwid: true,
      role: true,
      interim: true,
      sortOrder: true,
    },
    orderBy: [{ centerCode: "asc" }, { programCode: "asc" }, { sortOrder: "asc" }, { cwid: "asc" }],
  });
  log(`center_program_leader rows: ${legacy.length}`);

  // ---- 1. Seed the default vocabulary --------------------------------------
  const seedRows = orgUnitRoleSeedRows(CENTER_PROGRAM_ENTITY_TYPE);
  let rolesSeeded = 0;
  if (opts.dryRun) {
    const present = new Set(
      (
        await db.orgUnitRole.findMany({
          where: { entityType: CENTER_PROGRAM_ENTITY_TYPE },
          select: { entityType: true, key: true },
        })
      ).map((r) => r.key),
    );
    rolesSeeded = seedRows.filter((r) => !present.has(r.key)).length;
  } else {
    // Never clobber a label a steward has already renamed.
    ({ count: rolesSeeded } = await db.orgUnitRole.createMany({
      data: seedRows,
      skipDuplicates: true,
    }));
  }
  log(`${opts.dryRun ? "Would seed" : "Seeded"} ${rolesSeeded} center_program vocabulary row(s).`);

  // ---- 2. VERIFY-BEFORE-WRITE: both role keys must exist before any --------
  //         assignment referencing them is written, or the FK would dangle.
  //         Checked in dry-run too, crediting rows step 1 WOULD have written —
  //         otherwise a dry run on an empty vocabulary reports a
  //         dangling-FK condition the real run would not have hit.
  const neededKeys = [...new Set(legacy.map((r) => r.role))];
  const seededRoles = await db.orgUnitRole.findMany({
    where: { entityType: CENTER_PROGRAM_ENTITY_TYPE, key: { in: neededKeys } },
    select: { entityType: true, key: true },
  });
  const haveKeys = new Set(seededRoles.map((r) => r.key));
  if (opts.dryRun) {
    for (const r of seedRows) {
      if (neededKeys.includes(r.key)) haveKeys.add(r.key);
    }
  }
  const missingKeys = neededKeys.filter((k) => !haveKeys.has(k));
  if (missingKeys.length > 0) {
    throw new Error(
      `Missing 'center_program' vocabulary row(s) for key(s) ${missingKeys.join(", ")} — refusing to write a dangling org_unit_role_assignment FK.`,
    );
  }

  // ---- 3. Backfill assignment rows ------------------------------------------
  // Skip any (entityType, entityId, roleKey, cwid) that ALREADY holds an
  // assignment. The app is the source of truth once a row exists, so a re-run
  // after a curator changed a leader in the editor cannot resurrect the old
  // one alongside the current one. `CenterProgramLeader`'s own PK
  // (`[centerCode, programCode, cwid]`) means at most one row per person per
  // program, so this key needs no roleKey component to disambiguate against
  // the legacy source — but the assignment PK includes roleKey, so it is
  // checked here too, for symmetry with the department/division backfill.
  const entityIds = [...new Set(legacy.map((r) => programEntityId(r.centerCode, r.programCode)))];
  const already = new Set(
    (
      await db.orgUnitRoleAssignment.findMany({
        where: {
          entityType: CENTER_PROGRAM_ENTITY_TYPE,
          entityId: { in: entityIds },
        },
        select: { entityId: true, cwid: true, roleKey: true },
      })
    ).map((a) => `${a.entityId} ${a.cwid} ${a.roleKey}`),
  );

  let assignmentsCreated = 0;
  for (const row of legacy) {
    const entityId = programEntityId(row.centerCode, row.programCode);
    const key = `${entityId} ${row.cwid} ${row.role}`;
    if (already.has(key)) continue;
    if (!opts.dryRun) {
      await db.orgUnitRoleAssignment.create({
        data: {
          entityType: CENTER_PROGRAM_ENTITY_TYPE,
          entityId,
          cwid: row.cwid,
          roleKey: row.role,
          interim: row.interim,
          sortOrder: row.sortOrder,
        },
      });
    }
    assignmentsCreated += 1;
  }
  const assignmentsAlreadyPresent = already.size;
  log(
    `${opts.dryRun ? "Would create" : "Created"} ${assignmentsCreated} center_program assignment(s); ${assignmentsAlreadyPresent} already present.`,
  );

  return {
    legacyRows: legacy.length,
    rolesSeeded,
    assignmentsCreated,
    assignmentsAlreadyPresent,
    dryRun: opts.dryRun,
  };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`#2558 Phase 1 center_program role vocabulary backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  // Lazily imported so the structural type stays the contract and the unit
  // test never loads the real client.
  const { db } = await import("../../lib/db");
  try {
    await runBackfill(db.write as unknown as CenterProgramLeaderVocabBackfillDb, opts);
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
