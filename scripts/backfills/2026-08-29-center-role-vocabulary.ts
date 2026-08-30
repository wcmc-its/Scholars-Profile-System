/**
 * #2542 Phase 1 — seed every center's role vocabulary, classify its members,
 * and migrate the two deprecated leadership columns into `CenterLeader`.
 *
 * Runs AFTER migration `20260829143000_center_role_vocabulary`. That migration
 * is deliberately DDL-only: `center_role.center_code` FKs to `center`, which is
 * empty when `prisma migrate deploy` runs against CI's fresh database, so an
 * in-migration seed dies with MySQL 1452 (the #584 regression that
 * `tests/unit/migrations-empty-db-safe.test.ts` guards).
 *
 * It is NOT a deploy-ordering hazard that this is manual. The app dual-reads
 * (`CenterLeader` ?? `Center.directorCwid`) and dual-writes both, and both write
 * routes seed a center's vocabulary lazily before referencing it — so between
 * the ECS roll and this script nothing breaks and nothing renders differently.
 * This script exists to move the data once; the fallbacks go in the contract PR.
 *
 * What it does, in order:
 *   1. Seeds `DEFAULT_CENTER_ROLES` for every center (`createMany` +
 *      `skipDuplicates`, so a curator's renamed label is never clobbered).
 *   2. Classifies existing members: `membershipType` research/clinical carry
 *      over under the SAME literals; unclassified legacy rows become `member`.
 *   3. Creates a `CenterLeader` row (`roleKey: "director"`) from
 *      `Center.directorCwid` / `.leaderInterim`, for centers that do not
 *      already have one.
 *   4. Asserts the derived-`membershipType` invariant, because nothing else can:
 *      a missed derivation leaves NULL, which is a legal and common value, so it
 *      would surface as a quietly shorter NCI REMOVE list rather than an error.
 *
 * Leadership goes to its OWN table, so this script never touches a membership
 * row on a leader's behalf. A director who was never on the roster gets a
 * `CenterLeader` row and no `CenterMembership` row — which is why no member
 * count, roster, search facet or proxy-edit reach changes.
 *
 * Safety:
 *   - VERIFY-ALL-BEFORE-WRITE for the leadership step. Every center's `director`
 *     vocabulary row must exist before any leadership row is written; otherwise
 *     the run THROWS rather than leaving a dangling FK, and `--dry-run` performs
 *     the same check. NOTE: the steps are separate statements, not one
 *     transaction, so a throw in step 3 or 4 leaves steps 1 and 2 committed.
 *     That is safe because both are idempotent and behaviour-preserving on their
 *     own — re-run after fixing whatever threw.
 *   - Idempotent, and safe AFTER a curator has edited a director. Step 3 skips
 *     any center that already holds a `director` assignment, so a re-run can
 *     never resurrect a replaced director alongside the current one.
 *   - A director cwid is NOT required to resolve to a `scholar` row. That is
 *     deliberate: `directorCwid` is allowed to name a non-scholar (pre-hire
 *     pinning, and the external-leader case in `lib/external-leaders.ts`).
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-08-29-center-role-vocabulary.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  CENTER_ENTITY_TYPE,
  DIRECTOR_ROLE_KEY,
  MEMBER_ROLE_KEY,
  deriveMembershipType,
  orgUnitRoleSeedRows,
} from "../../lib/org-unit-roles";

/** Structural slice of the Prisma client this backfill needs, so the unit test
 *  never loads the real one. */
export type CenterRoleBackfillDb = {
  center: {
    findMany: (
      args: unknown,
    ) => Promise<{ code: string; directorCwid: string | null; leaderInterim: boolean }[]>;
  };
  orgUnitRole: {
    createMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<{ entityType: string; key: string }[]>;
  };
  orgUnitRoleAssignment: {
    findMany: (args: unknown) => Promise<{ entityId: string; cwid: string; roleKey: string }[]>;
    create: (args: unknown) => Promise<unknown>;
  };
  centerMembership: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<
      {
        centerCode: string;
        cwid: string;
        membershipRoleKey: string | null;
        membershipType: string | null;
      }[]
    >;
  };
};

export type BackfillOptions = { dryRun: boolean };

export type BackfillResult = {
  centers: number;
  rolesSeeded: number;
  membersClassified: number;
  leadersCreated: number;
  leadersAlreadyPresent: number;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): BackfillOptions {
  return { dryRun: argv.includes("--dry-run") };
}

const log = (msg: string): void => {
  console.log(msg);
};

export async function runBackfill(
  db: CenterRoleBackfillDb,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const centers = await db.center.findMany({
    select: { code: true, directorCwid: true, leaderInterim: true },
    orderBy: { code: "asc" },
  });
  log(`Centers: ${centers.length}`);

  // ---- 1. Seed the default vocabulary --------------------------------------
  // ONE list for the whole `center` kind, not a copy per center: re-keying the
  // vocabulary by kind is what makes divergence between units unrepresentable.
  const seedRows = orgUnitRoleSeedRows(CENTER_ENTITY_TYPE);
  let rolesSeeded = 0;
  if (opts.dryRun) {
    const present = new Set(
      (
        await db.orgUnitRole.findMany({
          where: { entityType: CENTER_ENTITY_TYPE },
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
  log(`${opts.dryRun ? "Would seed" : "Seeded"} ${rolesSeeded} vocabulary row(s).`);

  // ---- 2. Classify existing members ----------------------------------------
  // research/clinical keep their literals so `isCurrentMember` is untouched;
  // everything else becomes `member`, which derives back to a NULL enum.
  //
  // The research/clinical steps match on the ENUM disagreeing with the key, not
  // merely on a null key, so they also REPAIR drift. That matters during the
  // rolling deploy, when an old task can `set` membershipType on a row a new
  // task already keyed — leaving a row step 4's invariant check would reject
  // and a null-guarded classify could never fix. Both are still no-ops on a
  // second run. The `member` step keeps the null guard: once Phase 3 lets
  // curators mint entries, a null `membershipType` is legitimate on any key.
  const classify: { where: Record<string, unknown>; key: string }[] = [
    {
      where: { membershipType: "research", NOT: { membershipRoleKey: "research" } },
      key: "research",
    },
    {
      where: { membershipType: "clinical", NOT: { membershipRoleKey: "clinical" } },
      key: "clinical",
    },
    { where: { membershipRoleKey: null, membershipType: null }, key: MEMBER_ROLE_KEY },
  ];
  let membersClassified = 0;
  for (const step of classify) {
    if (opts.dryRun) {
      // A dry run must report the real number: this is the largest mutation in
      // the script and the operator's only pre-flight check.
      const rows = await db.centerMembership.findMany({
        where: step.where,
        select: { centerCode: true, cwid: true, membershipRoleKey: true, membershipType: true },
      });
      membersClassified += rows.length;
      continue;
    }
    const { count } = await db.centerMembership.updateMany({
      where: step.where,
      data: { membershipRoleKey: step.key },
    });
    membersClassified += count;
  }
  log(`${opts.dryRun ? "Would classify" : "Classified"} ${membersClassified} member row(s).`);

  // ---- 3. Migrate the director into CenterLeader ----------------------------
  const led = centers.filter((c) => c.directorCwid !== null && c.directorCwid !== "");

  // VERIFY-ALL-BEFORE-WRITE: every led center must already have the `director`
  // vocabulary row, or the leadership FK would dangle.
  const seededDirectorRoles = await db.orgUnitRole.findMany({
    where: { key: DIRECTOR_ROLE_KEY, entityType: CENTER_ENTITY_TYPE },
    select: { entityType: true, key: true },
  });
  let haveDirectorRole = seededDirectorRoles.length > 0;
  if (opts.dryRun) {
    // Step 1 wrote nothing, so credit the row it WOULD have written — otherwise
    // every dry run reports a dangling FK that the real run would not have.
    haveDirectorRole ||= seedRows.some((r) => r.key === DIRECTOR_ROLE_KEY);
  }
  // Checked in dry-run too — detecting a dangling-FK condition before the real
  // run is the entire point of a pre-flight. One check now, not one per center:
  // the vocabulary is shared, so either every center can be assigned or none can.
  if (led.length > 0 && !haveDirectorRole) {
    throw new Error(
      `Missing '${DIRECTOR_ROLE_KEY}' vocabulary row for entityType '${CENTER_ENTITY_TYPE}' — refusing to write a dangling leadership key.`,
    );
  }

  // Skip any center that ALREADY holds a director assignment. The app is the
  // source of truth once a row exists, so a re-run after a curator changed the
  // director cannot resurrect the old one alongside the new.
  const already = new Set(
    (
      await db.orgUnitRoleAssignment.findMany({
        where: {
          roleKey: DIRECTOR_ROLE_KEY,
          entityType: CENTER_ENTITY_TYPE,
          entityId: { in: led.map((c) => c.code) },
        },
        select: { entityId: true, cwid: true, roleKey: true },
      })
    ).map((r) => r.entityId),
  );

  let leadersCreated = 0;
  for (const c of led) {
    if (already.has(c.code)) continue;
    if (!opts.dryRun) {
      await db.orgUnitRoleAssignment.create({
        data: {
          entityType: CENTER_ENTITY_TYPE,
          entityId: c.code,
          cwid: c.directorCwid as string,
          roleKey: DIRECTOR_ROLE_KEY,
          interim: c.leaderInterim,
        },
      });
    }
    leadersCreated += 1;
  }
  log(
    `${opts.dryRun ? "Would create" : "Created"} ${leadersCreated} director assignment(s); ${already.size} already present.`,
  );

  // ---- 4. Invariant: membershipType agrees with membershipRoleKey ----------
  if (!opts.dryRun) {
    const all = await db.centerMembership.findMany({
      select: { centerCode: true, cwid: true, membershipRoleKey: true, membershipType: true },
    });
    const drift = all.filter((m) => m.membershipType !== deriveMembershipType(m.membershipRoleKey));
    if (drift.length > 0) {
      throw new Error(
        `${drift.length} membership row(s) whose membershipType disagrees with membershipRoleKey — first: ${drift[0].centerCode}. The derivation missed a write path.`,
      );
    }
    log(`Invariant OK: ${all.length} row(s) agree with deriveMembershipType.`);
  }

  return {
    centers: centers.length,
    rolesSeeded,
    membersClassified,
    leadersCreated,
    leadersAlreadyPresent: already.size,
    dryRun: opts.dryRun,
  };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`#2542 Phase 1 center-role backfill${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  // Lazily imported so the structural type stays the contract and the unit test
  // never loads the real client.
  const { db } = await import("../../lib/db");
  try {
    await runBackfill(db.write as unknown as CenterRoleBackfillDb, opts);
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
