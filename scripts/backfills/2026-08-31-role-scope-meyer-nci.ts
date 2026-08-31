/**
 * #2557 Phase E (T2) — seed the day-one `OrgUnitRoleScope` allowlist: the
 * `center` vocabulary's `research`/`clinical` roles (NCI CCSG vocabulary,
 * shared into all 11 centers by #2553 but used only by Meyer — measured prod
 * 2026-08-31: `research` 298 rows, `clinical` 54, all at
 * `meyer_cancer_center`) are restricted to Meyer, and nowhere else.
 *
 * Inserts EXACTLY two rows:
 *   center / research / meyer_cancer_center
 *   center / clinical / meyer_cancer_center
 *
 * Zero rows for a (entityType, roleKey) pair means UNRESTRICTED — see
 * `lib/api/org-unit-role-scope.ts` and issue #2557. This script is what turns
 * that default off for exactly these two roles.
 *
 * ============================================================================
 * ROLLOUT ORDER — READ BEFORE DEPLOYING #2557 T2's app change
 * ============================================================================
 * Run this script BEFORE, or together with, the app deploy that wires
 * `isRoleAllowedAtUnit` into `/api/edit/roster`'s `handleCenter` gate.
 *
 * Order does NOT matter for safety — only for whether the gate does anything
 * yet. If the gate ships (deploys) BEFORE this script runs, the scope table
 * is empty, so `research`/`clinical` are simply UNRESTRICTED everywhere,
 * exactly like today, before this ticket. That is the PERMISSIVE default by
 * design — an empty scope table stays permissive so no unit can be born
 * unable to render a leader (issue #2557) — not a bug and not a security hole
 * to page anyone about. State this explicitly so nobody "fixes" it by
 * hot-patching the gate — the fix is running this script, not touching the
 * app.
 *
 * ============================================================================
 * WARNING — DO NOT REMOVE THESE ROWS LATER WITHOUT READING THIS
 * ============================================================================
 * `CenterMembership.membershipType` is DERIVED from `membershipRoleKey`
 * (`deriveMembershipType`, `lib/org-unit-roles.ts`) and is an NCI CCSG
 * REPORTING PREDICATE, not a cosmetic badge. Deleting
 * Meyer's `research`/`clinical` scope rows does NOT touch those 298 + 54
 * `CenterMembership` rows directly — but it WOULD make the roster-write gate
 * reject any FUTURE edit to Meyer's own research/clinical roster (Meyer would
 * no longer be on the allowlist for its own NCI roles), stranding curation for
 * program Meyer already reports on to NCI. There is no console UI for this
 * table in this slice (rows are seeded by this script only) — if that ever
 * changes, the write path MUST warn with the live holder count before letting
 * anyone remove `meyer_cancer_center` from either allowlist, exactly as
 * `renameBlastRadiusText` does for a unit rename.
 *
 * Safety:
 *   - VERIFY-BEFORE-WRITE: refuses to run (throws, writes nothing) unless
 *     BOTH `center` vocabulary rows (`research`, `clinical`, entityType
 *     `center`) already exist — otherwise the FK
 *     (`org_unit_role_scope` → `org_unit_role`) would dangle — AND the
 *     `meyer_cancer_center` `Center` row exists. `--dry-run` runs the same
 *     checks and reports what would happen without writing.
 *   - Idempotent: `createMany` + `skipDuplicates`, safe to re-run.
 *
 * Flags:
 *   --dry-run   verify + report what would change; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-08-31-role-scope-meyer-nci.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { CENTER_ENTITY_TYPE } from "../../lib/org-unit-roles";
import { CENTER_MEMBERSHIP_TYPES } from "../../lib/edit/validators";

/** The center this day-one allowlist scopes both NCI roles to. */
export const MEYER_CENTER_CODE = "meyer_cancer_center";

/** The two role keys being scoped — reuses the same literal source as the
 *  roster route's `membershipType` validator, so this script can never seed a
 *  scope row for a role key the app doesn't otherwise recognize as NCI
 *  vocabulary. */
const SCOPED_ROLE_KEYS: readonly string[] = CENTER_MEMBERSHIP_TYPES;

/** Structural slice of the Prisma client this seed needs, so the unit test
 *  never loads the real one — same posture as `CenterRoleBackfillDb` in
 *  `2026-08-29-center-role-vocabulary.ts`. */
export type RoleScopeSeedDb = {
  center: {
    findUnique: (args: unknown) => Promise<{ code: string } | null>;
  };
  orgUnitRole: {
    findMany: (args: unknown) => Promise<{ entityType: string; key: string }[]>;
  };
  orgUnitRoleScope: {
    findMany: (
      args: unknown,
    ) => Promise<{ entityType: string; roleKey: string; entityId: string }[]>;
    createMany: (args: unknown) => Promise<{ count: number }>;
  };
};

export type SeedOptions = { dryRun: boolean };

export type SeedResult = {
  rowsInserted: number;
  rowsAlreadyPresent: number;
  dryRun: boolean;
};

export function parseArgs(argv: string[]): SeedOptions {
  return { dryRun: argv.includes("--dry-run") };
}

const log = (msg: string): void => {
  console.log(msg);
};

export async function runRoleScopeSeed(
  db: RoleScopeSeedDb,
  opts: SeedOptions,
): Promise<SeedResult> {
  // ---- verify the center exists ---------------------------------------------
  const center = await db.center.findUnique({
    where: { code: MEYER_CENTER_CODE },
    select: { code: true },
  });
  if (!center) {
    throw new Error(
      `Center '${MEYER_CENTER_CODE}' not found — refusing to seed an OrgUnitRoleScope row for a center that does not exist.`,
    );
  }

  // ---- VERIFY-BEFORE-WRITE: both vocabulary rows must already exist --------
  // `org_unit_role_scope` FKs (entityType, roleKey) -> `org_unit_role`
  // (entityType, key). Writing before the vocabulary exists would dangle that
  // FK — refuse with a clear message rather than a partial state.
  const vocab = await db.orgUnitRole.findMany({
    where: { entityType: CENTER_ENTITY_TYPE, key: { in: [...SCOPED_ROLE_KEYS] } },
    select: { entityType: true, key: true },
  });
  const presentKeys = new Set(vocab.map((r) => r.key));
  const missingKeys = SCOPED_ROLE_KEYS.filter((k) => !presentKeys.has(k));
  if (missingKeys.length > 0) {
    throw new Error(
      `Missing 'center' vocabulary row(s) for: ${missingKeys.join(", ")} — refusing to write a dangling org_unit_role_scope FK. Run scripts/backfills/2026-08-29-center-role-vocabulary.ts first (it seeds the 'center' vocabulary, including these two keys).`,
    );
  }

  // ---- insert (or report, in --dry-run) -------------------------------------
  const rows = SCOPED_ROLE_KEYS.map((roleKey) => ({
    entityType: CENTER_ENTITY_TYPE,
    roleKey,
    entityId: MEYER_CENTER_CODE,
  }));

  if (opts.dryRun) {
    const existing = await db.orgUnitRoleScope.findMany({
      where: {
        entityType: CENTER_ENTITY_TYPE,
        roleKey: { in: [...SCOPED_ROLE_KEYS] },
        entityId: MEYER_CENTER_CODE,
      },
      select: { entityType: true, roleKey: true, entityId: true },
    });
    const rowsAlreadyPresent = existing.length;
    const rowsInserted = rows.length - rowsAlreadyPresent;
    log(`Would insert ${rowsInserted} scope row(s); ${rowsAlreadyPresent} already present.`);
    return { rowsInserted, rowsAlreadyPresent, dryRun: true };
  }

  const { count: rowsInserted } = await db.orgUnitRoleScope.createMany({
    data: rows,
    skipDuplicates: true,
  });
  const rowsAlreadyPresent = rows.length - rowsInserted;
  log(`Inserted ${rowsInserted} scope row(s); ${rowsAlreadyPresent} already present.`);
  return { rowsInserted, rowsAlreadyPresent, dryRun: false };
}

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  log(`#2557 Phase E Meyer NCI role-scope seed${opts.dryRun ? " [DRY RUN — no writes]" : ""}`);

  // Lazily imported so the structural type stays the contract and the unit
  // test never loads the real client.
  const { db } = await import("../../lib/db");
  try {
    await runRoleScopeSeed(db.write as unknown as RoleScopeSeedDb, opts);
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
