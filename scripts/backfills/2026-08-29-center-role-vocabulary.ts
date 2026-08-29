/**
 * #2542 Phase 1 — seed every center's role vocabulary and migrate the two
 * deprecated leadership columns onto membership rows.
 *
 * Runs AFTER migration `20260829143000_center_role_vocabulary`. That migration
 * is deliberately DDL-only: `center_role.center_code` FKs to `center`, which is
 * empty when `prisma migrate deploy` runs against CI's fresh database, so an
 * in-migration seed dies with MySQL 1452 (the #584 regression that
 * `tests/unit/migrations-empty-db-safe.test.ts` guards). Until this script runs,
 * every new column reads NULL and nothing changes.
 *
 * What it does, in order:
 *   1. Seeds `DEFAULT_CENTER_ROLES` for every center (`createMany` +
 *      `skipDuplicates`, so a curator's renamed label is never clobbered).
 *   2. Classifies existing members: `membershipType` research/clinical carry
 *      over under the SAME literals; unclassified legacy rows become `member`.
 *   3. Moves `Center.directorCwid` / `Center.leaderInterim` onto that person's
 *      `CenterMembership` row as `leadershipRoleKey = "director"`, minting the
 *      row when the director was never on the roster.
 *   4. Asserts the derived-`membershipType` invariant, because nothing else can:
 *      a missed derivation leaves NULL, which is a legal and common value, so it
 *      would surface as a quietly shorter NCI REMOVE list rather than an error.
 *
 * Why step 2 gives unclassified rows `member` rather than NULL: a NULL
 * `membershipRoleKey` is the ONLY way to tell a leadership-only row (step 3's
 * minted director) from a real roster member, because `CenterMembership` is
 * `@@id([centerCode, cwid])` and the two share one row. Member counts and the
 * public roster filter on `membershipRoleKey IS NOT NULL`. The change is
 * invisible publicly: `member` derives to a NULL `membershipType`, and the
 * roster badge and type facet both read `membershipType`.
 *
 * Safety:
 *   - VERIFY-ALL-BEFORE-WRITE. Every center's `director` vocabulary row must
 *     exist before any leadership row is written; otherwise the run THROWS and
 *     writes nothing rather than leaving a dangling FK.
 *   - Idempotent. Every step is a skipDuplicates insert or a guarded updateMany,
 *     so a re-run is a no-op. Step 2 excludes rows that already carry a
 *     leadership key, so a re-run cannot turn a minted director into a member.
 *   - A director cwid is NOT required to resolve to a `scholar` row. That is
 *     deliberate: `directorCwid` is allowed to name a non-scholar (pre-hire
 *     pinning, and the external-leader case in `lib/external-leaders.ts`), and
 *     there is no FK from `center_membership.cwid` to `scholar`.
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-08-29-center-role-vocabulary.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CENTER_ROLES,
  DIRECTOR_ROLE_KEY,
  MEMBER_ROLE_KEY,
  deriveMembershipType,
} from "../../lib/center-roles";

/** Structural slice of the Prisma client this backfill needs, so the unit test
 *  never loads the real one. */
export type CenterRoleBackfillDb = {
  center: {
    findMany: (
      args: unknown,
    ) => Promise<{ code: string; directorCwid: string | null; leaderInterim: boolean }[]>;
  };
  centerRole: {
    createMany: (args: unknown) => Promise<{ count: number }>;
    findMany: (args: unknown) => Promise<{ centerCode: string; key: string }[]>;
  };
  centerMembership: {
    updateMany: (args: unknown) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<unknown>;
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
  directorsMigrated: number;
  directorRowsMinted: number;
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
  let rolesSeeded = 0;
  if (!opts.dryRun) {
    const { count } = await db.centerRole.createMany({
      data: centers.flatMap((c) =>
        DEFAULT_CENTER_ROLES.map((r) => ({
          centerCode: c.code,
          key: r.key,
          label: r.label,
          roleGroup: r.group,
          scope: r.scope,
          singleHolder: r.singleHolder,
          sortOrder: r.sortOrder,
          profileTitle: r.profileTitle,
          source: "seed",
        })),
      ),
      // Never clobber a label a curator has already renamed.
      skipDuplicates: true,
    });
    rolesSeeded = count;
  } else {
    rolesSeeded = centers.length * DEFAULT_CENTER_ROLES.length;
  }
  log(`${opts.dryRun ? "Would seed" : "Seeded"} ${rolesSeeded} vocabulary row(s).`);

  // ---- 2. Classify existing members ----------------------------------------
  // research/clinical keep their literals so `isCurrentMember` is untouched;
  // everything else becomes `member`, which derives back to a NULL enum.
  let membersClassified = 0;
  if (!opts.dryRun) {
    for (const type of ["research", "clinical"] as const) {
      const { count } = await db.centerMembership.updateMany({
        where: { membershipRoleKey: null, membershipType: type },
        data: { membershipRoleKey: type },
      });
      membersClassified += count;
    }
    const { count } = await db.centerMembership.updateMany({
      // `leadershipRoleKey: null` keeps a re-run from demoting step 3's minted
      // director rows into roster members.
      where: { membershipRoleKey: null, membershipType: null, leadershipRoleKey: null },
      data: { membershipRoleKey: MEMBER_ROLE_KEY },
    });
    membersClassified += count;
  }
  log(`${opts.dryRun ? "Would classify" : "Classified"} ${membersClassified} member row(s).`);

  // ---- 3. Migrate the director ---------------------------------------------
  const led = centers.filter((c) => c.directorCwid !== null && c.directorCwid !== "");

  // VERIFY-ALL-BEFORE-WRITE: every led center must already have the `director`
  // vocabulary row, or the leadership FK would dangle.
  const seededDirectorRoles = await db.centerRole.findMany({
    where: { key: DIRECTOR_ROLE_KEY, centerCode: { in: led.map((c) => c.code) } },
    select: { centerCode: true, key: true },
  });
  const haveDirectorRole = new Set(seededDirectorRoles.map((r) => r.centerCode));
  const missing = opts.dryRun ? [] : led.filter((c) => !haveDirectorRole.has(c.code));
  if (missing.length > 0) {
    throw new Error(
      `Missing '${DIRECTOR_ROLE_KEY}' vocabulary row for: ${missing
        .map((c) => c.code)
        .join(", ")} — refusing to write a dangling leadership key.`,
    );
  }

  const existing = await db.centerMembership.findMany({
    where: { centerCode: { in: led.map((c) => c.code) } },
    select: { centerCode: true, cwid: true, membershipRoleKey: true, membershipType: true },
  });
  const isMember = new Set(existing.map((m) => `${m.centerCode} ${m.cwid}`));

  let directorsMigrated = 0;
  let directorRowsMinted = 0;
  for (const c of led) {
    const cwid = c.directorCwid as string;
    const mints = !isMember.has(`${c.code} ${cwid}`);
    if (!opts.dryRun) {
      await db.centerMembership.upsert({
        where: { centerCode_cwid: { centerCode: c.code, cwid } },
        // A minted row carries NO membership role: the director was never on
        // the roster, and moving the column must not add them to it.
        create: {
          centerCode: c.code,
          cwid,
          membershipRoleKey: null,
          membershipType: null,
          leadershipRoleKey: DIRECTOR_ROLE_KEY,
          leadershipInterim: c.leaderInterim,
          source: "center-role-backfill",
        },
        update: {
          leadershipRoleKey: DIRECTOR_ROLE_KEY,
          leadershipInterim: c.leaderInterim,
        },
      });
    }
    directorsMigrated += 1;
    if (mints) {
      directorRowsMinted += 1;
      log(`  ${c.code}: director is not on the roster — minting a leadership-only row.`);
    }
  }
  log(
    `${opts.dryRun ? "Would migrate" : "Migrated"} ${directorsMigrated} director(s); ${directorRowsMinted} row(s) minted.`,
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
    directorsMigrated,
    directorRowsMinted,
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
