/**
 * Phase D (`PLAN-org-unit-roles-next-phases-2026-08-31.md`) — seed the
 * department/division/core role vocabulary and migrate the department chair/
 * director and division chief columns into `OrgUnitRoleAssignment`.
 *
 * Mirrors `scripts/backfills/2026-08-29-center-role-vocabulary.ts` in
 * structure, dry-run convention, logging and idempotency. The key difference
 * from that script: departments and divisions are NOT manual-only like
 * centers — the nightly `etl/ed` run still rewrites `Department.chairCwid` /
 * `Division.chiefCwid` every night at 07:00 UTC, and curator corrections can
 * live in `field_override` rows (`leaderCwid` / `leaderInterim`) that this
 * script does NOT touch. Both are fine, on purpose — and, unlike an earlier
 * draft of this docblock assumed, `etl/ed` does NOT leave the assignment row
 * to go stale: this same phase teaches it to dual-write
 * (`writeUnitLeaderAssignment`, `etl/ed/index.ts`), so its nightly run keeps
 * `OrgUnitRoleAssignment` in sync with `chairCwid`/`chiefCwid` going forward:
 *
 *   - `lib/api/unit-leader.ts` (`resolveUnitLeader`) checks
 *     `field_override(leaderCwid)` FIRST, before ever looking at an
 *     assignment row — a curator's override keeps winning on read exactly as
 *     it does today, backfill or no backfill.
 *   - Absent an override, the read path now PREFERS the assignment row over
 *     the legacy column (`resolveUnitLeader` branch 2 before branch 3), so
 *     this backfill is a real precedence change, not an inert data copy: for
 *     every unit it backfills, `OrgUnitRoleAssignment` becomes the row that
 *     actually renders.
 *
 * ROLLOUT ORDER — read this before running against any environment. The new
 * ETL image and the new app build must BOTH already be live there before
 * this backfill runs. The read paths now prefer an `OrgUnitRoleAssignment`
 * row over the legacy `chairCwid`/`chiefCwid` column. If this backfill runs
 * first, the assignment rows it writes are frozen at backfill time while the
 * column keeps being rewritten by the nightly 07:00 UTC `etl/ed` run — so
 * the first upstream leadership change after the backfill renders the STALE
 * leader indefinitely, silently, until someone notices. Note also that
 * `etl/` code ships on ECR PUSH while the app ships on `cdk deploy` — they
 * are independent deploys, so "the ETL is live" and "the app is live" must
 * be confirmed SEPARATELY, never inferred from each other. Correct order per
 * environment: ECR push (ETL) + `cdk deploy` (app), confirm both live, THEN
 * run this backfill there.
 *
 * What it does, in order:
 *   1. Seeds `DEFAULT_ORG_UNIT_ROLES` for `department`, `division` and
 *      `core` (`createMany` + `skipDuplicates`, so a curator's renamed label
 *      is never clobbered).
 *   2. Creates a department leadership assignment (`departmentLeaderRoleKey`
 *      picks `chair` or `director` from `category`) from `chairCwid`, for
 *      departments that do not already hold that role's assignment.
 *   3. Creates a division `chief` assignment from `chiefCwid`, same rule.
 *   4. Does NOT touch cores. Prod has ZERO `core_leader` rows (2026-08-31
 *      probe) and `CoreLeader` storage migration is explicitly out of scope
 *      for this phase — see the plan's "Probe findings" #5. Step 1 above
 *      still seeds the `core` vocabulary's `director` row so the vocabulary
 *      is complete and the role appears in the `/edit/roles` steward roster —
 *      NOT because any core render path reads it today. It doesn't:
 *      `components/cores/core-page.tsx` renders no leader at all, and
 *      `components/edit/core-leader-card.tsx` still edits the open-string
 *      `CoreLeader.role` column, untouched by this branch
 *      (`git diff origin/master --stat -- components/cores/` is empty).
 *      Consolidating `core_leader` into `org_unit_role_assignment` and wiring
 *      a core edit surface to this vocabulary is separate, unstarted work.
 *
 * `interim`: Department and Division carry NO `leaderInterim` COLUMN — only
 * `Center.leaderInterim` does (confirmed 2026-08-31:
 * `grep -n leaderInterim prisma/schema.prisma` matches the Center model
 * only; dept/div express "interim" solely via a columnless
 * `field_override(leaderInterim)` row, per `manual-layer.ts`'s
 * `UnitFieldOverrideName` and its own docblock: "departments and divisions
 * express the same qualifier as a columnless `field_override(leaderInterim)`
 * row, which is a DIFFERENT mechanism"). There is therefore nothing to carry
 * across — every row this script creates gets `interim: false`, matching
 * what `resolveUnitLeader`'s legacy-column branch already reports today for
 * every department/division. This is safe even where a `leaderInterim`
 * override already exists (prod: 1 department, 1 division, per the plan's
 * probe): `resolveUnitLeader` layers `field_override(leaderInterim)` on top
 * of WHICHEVER store resolves the cwid — override, assignment, or column —
 * independent of the assignment row's own `interim` flag, so that curator's
 * "interim" flag keeps winning on read regardless of what this script writes.
 *
 * Safety:
 *   - VERIFY-ALL-BEFORE-WRITE, same shape as the center script: every needed
 *     vocabulary key (per kind, not per unit) must exist before any
 *     assignment row for it is written, or the run THROWS rather than
 *     leaving a dangling FK. `--dry-run` performs the same check. The steps
 *     are separate statements, not one transaction — a throw after step 1
 *     leaves the (idempotent, behavior-preserving) vocabulary seed committed;
 *     re-run after fixing whatever threw.
 *   - Idempotent, and safe AFTER a curator has edited a leader. Steps 2/3
 *     skip any (entityType, entityId, roleKey) that already holds an
 *     assignment, so a re-run can never resurrect a replaced chair/chief
 *     alongside the current one.
 *   - Skips a null OR empty-string leader column. An empty string is an
 *     explicit vacancy (the same convention `field_override(leaderCwid)`
 *     uses), not a cwid to assign.
 *   - A leader cwid is NOT required to resolve to a `scholar` row — same
 *     deliberate allowance the center backfill makes, for the same reason
 *     (pre-hire pinning / external-leader case).
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-08-31-dept-div-role-vocabulary.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  DEPARTMENT_CHAIR_ROLE_KEY,
  DEPARTMENT_DIRECTOR_ROLE_KEY,
  DIVISION_CHIEF_ROLE_KEY,
  departmentLeaderRoleKey,
  orgUnitRoleSeedRows,
} from "../../lib/org-unit-roles";

const DEPARTMENT_ENTITY_TYPE = "department";
const DIVISION_ENTITY_TYPE = "division";
const CORE_ENTITY_TYPE = "core";

/** Structural slice of the Prisma client this backfill needs, so the unit
 *  test never loads the real one. */
export type DeptDivRoleBackfillDb = {
  department: {
    findMany: (
      args: unknown,
    ) => Promise<{ code: string; category: string; chairCwid: string | null }[]>;
  };
  division: {
    findMany: (args: unknown) => Promise<{ code: string; chiefCwid: string | null }[]>;
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
  departments: number;
  divisions: number;
  rolesSeeded: number;
  departmentLeadersCreated: number;
  departmentLeadersAlreadyPresent: number;
  divisionLeadersCreated: number;
  divisionLeadersAlreadyPresent: number;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): BackfillOptions {
  return { dryRun: argv.includes("--dry-run") };
}

const log = (msg: string): void => {
  console.log(msg);
};

export async function runBackfill(
  db: DeptDivRoleBackfillDb,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const departments = await db.department.findMany({
    select: { code: true, category: true, chairCwid: true },
    orderBy: { code: "asc" },
  });
  const divisions = await db.division.findMany({
    select: { code: true, chiefCwid: true },
    orderBy: { code: "asc" },
  });
  log(`Departments: ${departments.length}, Divisions: ${divisions.length}`);

  // ---- 1. Seed the default vocabulary --------------------------------------
  // Three kinds, each its OWN shared list — not a copy per unit. Department
  // seeds BOTH `chair` and `director` unconditionally: a given department only
  // ever gets one (via `departmentLeaderRoleKey(category)` below), but both
  // keys must exist so that choice always resolves regardless of which
  // departments happen to have a leader today. Core seeds `director` only,
  // with no assignment backfill — see the docblock above.
  const seedRows = [
    ...orgUnitRoleSeedRows(DEPARTMENT_ENTITY_TYPE),
    ...orgUnitRoleSeedRows(DIVISION_ENTITY_TYPE),
    ...orgUnitRoleSeedRows(CORE_ENTITY_TYPE),
  ];
  const seedKinds = [DEPARTMENT_ENTITY_TYPE, DIVISION_ENTITY_TYPE, CORE_ENTITY_TYPE];
  let rolesSeeded = 0;
  if (opts.dryRun) {
    const present = new Set(
      (
        await db.orgUnitRole.findMany({
          where: { entityType: { in: seedKinds } },
          select: { entityType: true, key: true },
        })
      ).map((r) => `${r.entityType} ${r.key}`),
    );
    rolesSeeded = seedRows.filter((r) => !present.has(`${r.entityType} ${r.key}`)).length;
  } else {
    // Never clobber a label a steward has already renamed.
    ({ count: rolesSeeded } = await db.orgUnitRole.createMany({
      data: seedRows,
      skipDuplicates: true,
    }));
  }
  log(
    `${opts.dryRun ? "Would seed" : "Seeded"} ${rolesSeeded} vocabulary row(s) across department/division/core.`,
  );

  // ---- 2. Backfill department chair/director assignments -------------------
  const ledDepartments = departments.filter((d) => d.chairCwid !== null && d.chairCwid !== "");
  // Widened to `string[]`: `departmentLeaderRoleKey` returns the literal union
  // `"chair" | "director"`, but this list is compared against `OrgUnitRole.key`
  // (a plain `string` column) below, so keeping the narrow type buys nothing
  // and only forces an awkward cast at the `.includes` check.
  const neededDeptKeys: string[] = [
    ...new Set(ledDepartments.map((d) => departmentLeaderRoleKey(d.category))),
  ];

  // VERIFY-ALL-BEFORE-WRITE: every leadership key a department actually needs
  // (chair and/or director, whichever `category` selects) must already have
  // its vocabulary row, or the leadership FK would dangle. Checked in dry-run
  // too, crediting rows step 1 WOULD have written — otherwise a dry run on an
  // empty vocabulary reports a dangling-FK condition the real run would not
  // have hit.
  const seededDeptRoles = await db.orgUnitRole.findMany({
    where: { entityType: DEPARTMENT_ENTITY_TYPE, key: { in: neededDeptKeys } },
    select: { entityType: true, key: true },
  });
  const haveDeptKeys = new Set(seededDeptRoles.map((r) => r.key));
  if (opts.dryRun) {
    for (const r of seedRows) {
      if (r.entityType === DEPARTMENT_ENTITY_TYPE && neededDeptKeys.includes(r.key)) {
        haveDeptKeys.add(r.key);
      }
    }
  }
  const missingDeptKeys = neededDeptKeys.filter((k) => !haveDeptKeys.has(k));
  if (missingDeptKeys.length > 0) {
    throw new Error(
      `Missing department vocabulary row(s) for key(s) ${missingDeptKeys.join(", ")} — refusing to write a dangling leadership key.`,
    );
  }

  // Skip any (department, roleKey) pair that ALREADY holds an assignment. The
  // app is the source of truth once a row exists, so a re-run after a curator
  // changed the chair cannot resurrect the old one alongside the new.
  const alreadyDept = new Set(
    (
      await db.orgUnitRoleAssignment.findMany({
        where: {
          entityType: DEPARTMENT_ENTITY_TYPE,
          entityId: { in: ledDepartments.map((d) => d.code) },
          roleKey: { in: neededDeptKeys },
        },
        select: { entityId: true, cwid: true, roleKey: true },
      })
    ).map((r) => `${r.entityId} ${r.roleKey}`),
  );

  let departmentLeadersCreated = 0;
  for (const d of ledDepartments) {
    const roleKey = departmentLeaderRoleKey(d.category);
    if (alreadyDept.has(`${d.code} ${roleKey}`)) continue;
    if (!opts.dryRun) {
      await db.orgUnitRoleAssignment.create({
        data: {
          entityType: DEPARTMENT_ENTITY_TYPE,
          entityId: d.code,
          cwid: d.chairCwid as string,
          roleKey,
          // See the docblock's "`interim`" section: department carries no
          // `leaderInterim` column, so there is nothing to carry across, and
          // any curator `field_override(leaderInterim)` row keeps winning on
          // read regardless of this flag.
          interim: false,
        },
      });
    }
    departmentLeadersCreated += 1;
  }
  const departmentLeadersAlreadyPresent = alreadyDept.size;
  log(
    `${opts.dryRun ? "Would create" : "Created"} ${departmentLeadersCreated} department leader assignment(s); ${departmentLeadersAlreadyPresent} already present.`,
  );

  // ---- 3. Backfill division chief assignments -------------------------------
  const ledDivisions = divisions.filter((d) => d.chiefCwid !== null && d.chiefCwid !== "");

  const seededDivRoles = await db.orgUnitRole.findMany({
    where: { entityType: DIVISION_ENTITY_TYPE, key: DIVISION_CHIEF_ROLE_KEY },
    select: { entityType: true, key: true },
  });
  let haveChiefRole = seededDivRoles.length > 0;
  if (opts.dryRun) {
    haveChiefRole ||= seedRows.some(
      (r) => r.entityType === DIVISION_ENTITY_TYPE && r.key === DIVISION_CHIEF_ROLE_KEY,
    );
  }
  if (ledDivisions.length > 0 && !haveChiefRole) {
    throw new Error(
      `Missing '${DIVISION_CHIEF_ROLE_KEY}' vocabulary row for entityType '${DIVISION_ENTITY_TYPE}' — refusing to write a dangling leadership key.`,
    );
  }

  const alreadyDiv = new Set(
    (
      await db.orgUnitRoleAssignment.findMany({
        where: {
          entityType: DIVISION_ENTITY_TYPE,
          roleKey: DIVISION_CHIEF_ROLE_KEY,
          entityId: { in: ledDivisions.map((d) => d.code) },
        },
        select: { entityId: true, cwid: true, roleKey: true },
      })
    ).map((r) => r.entityId),
  );

  let divisionLeadersCreated = 0;
  for (const d of ledDivisions) {
    if (alreadyDiv.has(d.code)) continue;
    if (!opts.dryRun) {
      await db.orgUnitRoleAssignment.create({
        data: {
          entityType: DIVISION_ENTITY_TYPE,
          entityId: d.code,
          cwid: d.chiefCwid as string,
          roleKey: DIVISION_CHIEF_ROLE_KEY,
          // Same reasoning as the department loop above: no column to carry.
          interim: false,
        },
      });
    }
    divisionLeadersCreated += 1;
  }
  const divisionLeadersAlreadyPresent = alreadyDiv.size;
  log(
    `${opts.dryRun ? "Would create" : "Created"} ${divisionLeadersCreated} division leader assignment(s); ${divisionLeadersAlreadyPresent} already present.`,
  );

  // ---- 4. Cores: vocabulary only, no assignment backfill --------------------
  // Deliberately a no-op beyond step 1's seed. Prod has ZERO `core_leader`
  // rows (2026-08-31 probe), and migrating `CoreLeader` storage into
  // `OrgUnitRoleAssignment` is out of scope for this phase — see the plan's
  // "Probe findings" #5. This line exists so a reader of the log output sees
  // that cores were considered, not skipped by omission.
  log(
    "Cores: vocabulary seeded only — no assignment backfill (0 core_leader rows in prod; storage migration out of scope for this phase).",
  );

  return {
    departments: departments.length,
    divisions: divisions.length,
    rolesSeeded,
    departmentLeadersCreated,
    departmentLeadersAlreadyPresent,
    divisionLeadersCreated,
    divisionLeadersAlreadyPresent,
    dryRun: opts.dryRun,
  };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`Phase D dept/div/core role vocabulary backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  // Lazily imported so the structural type stays the contract and the unit
  // test never loads the real client.
  const { db } = await import("../../lib/db");
  try {
    await runBackfill(db.write as unknown as DeptDivRoleBackfillDb, opts);
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
