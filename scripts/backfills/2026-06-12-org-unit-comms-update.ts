/**
 * Org-unit comms update backfill (2026-06-12, one-shot per DB).
 *
 * Applies the Head of Communications' department / center / institute changes to
 * an EXISTING database (staging now, prod later). The version-controlled seeds
 * (`prisma/center-seed-data.ts`, `lib/department-names.ts`,
 * `lib/department-categories.ts`) keep fresh clones correct on CREATE; this
 * backfill aligns rows that already exist. The two together are the durable,
 * promotable source of truth — and because the ED ETL never writes
 * officialName/compactName/category on UPDATE, none of this is clobbered by a
 * refresh.
 *
 * What it does, idempotently (every step is upsert / updateMany / deleteMany —
 * no throw on a missing row, safe to re-run):
 *
 *   Centers
 *     • rename + compact-name + type + director patches to existing rows
 *       (slugs kept stable to preserve URLs)
 *     • create the 5 new centers from the seed (+ their directors)
 *     • hard-delete Computational Biomedicine + Iris Cantor (memberships and
 *       programs cascade)
 *   Departments
 *     • officialName / compactName for the 5 renamed departments
 *     • category corrections (Medicine, Pathology -> clinical; Systems & Comp
 *       Bio -> basic)
 *     • chairs the ED title regex missed, set via field_override(leaderCwid)
 *       (durable across ETL) AND written to chairCwid for immediate display
 *
 * Joel Stein (Rehabilitation Medicine) is not a WCM scholar (Columbia primary
 * appointment), so his chairCwid (jos7021) renders via the external-leader
 * carve-out in lib/external-leaders.ts — name + Directory photo, no profile
 * link. The override + chairCwid are still written for data consistency.
 *
 * Flags:
 *   --dry-run   report intended changes; write nothing.
 *
 * Run: npx tsx scripts/backfills/2026-06-12-org-unit-comms-update.ts [--dry-run]
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";
import { DEPARTMENT_NAMES } from "../../lib/department-names";
import { CENTERS } from "../../prisma/center-seed-data";

/** field_override.actor_cwid sentinel attributing rows to this backfill. */
const ACTOR = "org-unit-comms";

type CenterPatch = {
  code: string;
  /** Rename — sets the full / official name. Omitted = no rename. */
  name?: string;
  compactName: string;
  centerType?: "center" | "institute";
  /** Set in-row. Omitted = leave the existing director untouched. */
  directorCwid?: string;
};

const CENTER_PATCHES: CenterPatch[] = [
  { code: "englander_ipm", compactName: "Institute for Precision Medicine", directorCwid: "ole2001" },
  { code: "cardiovascular_ri", compactName: "Cardiovascular Research", directorCwid: "gep9004" },
  { code: "aging_research", compactName: "Aging Research", directorCwid: "mslachs" },
  { code: "meyer_cancer_center", compactName: "Meyer Cancer Center" },
  {
    code: "health_equity",
    name: "Cornell Center for Health Equity",
    compactName: "Center for Health Equity",
    directorCwid: "mms9024",
  },
  {
    code: "inflammation_research",
    name: "Jill Roberts Institute for Research in Inflammatory Bowel Disease",
    compactName: "Jill Roberts Institute",
    centerType: "institute",
  },
];

const NEW_CENTER_CODES = [
  "drukier_childrens_health",
  "weill_metabolic_health",
  "global_health",
  "appel_alzheimers",
  "friedman_nutrition",
];

/** Directors for the new centers. Friedman is being recruited -> no entry. */
const NEW_CENTER_DIRECTORS: Record<string, string> = {
  drukier_childrens_health: "vip2021", // Virginia Pascual
  weill_metabolic_health: "lca4001", // Laura Alonso
  global_health: "dwf2001", // Daniel W. Fitzgerald
  appel_alzheimers: "lig2033", // Li Gan
};

const REMOVE_CENTER_CODES = ["computational_biomed", "iris_cantor_womens_health"];

const DEPT_CATEGORY_PATCHES: Array<{ code: string; category: string }> = [
  { code: "N1280", category: "clinical" }, // Medicine
  { code: "N1420", category: "clinical" }, // Pathology and Laboratory Medicine
  { code: "N1740", category: "basic" }, // Systems and Computational Biomedicine
];

const DEPT_CHAIRS: Array<{ code: string; cwid: string }> = [
  { code: "N1760", cwid: "coi2001" }, // Costantino Iadecola — Brain & Mind
  { code: "N1400", cwid: "mgs2002" }, // Michael G. Stewart — Otolaryngology
  { code: "N1740", cwid: "rbsilve" }, // Randi B. Silver — Systems & Comp Bio
  // Joel Stein — Rehabilitation Medicine. NOT a WCM scholar (Columbia primary
  // appointment), so the chairCwid resolves via the external-leader carve-out
  // in lib/external-leaders.ts (rendered name + Directory photo, no profile
  // link). The override + chairCwid are still written for data consistency.
  { code: "N1540", cwid: "jos7021" },
];

const log = (m: string) => console.log(m);

async function run(dryRun: boolean) {
  log(`Org-unit comms update${dryRun ? " [DRY RUN — no writes]" : ""}`);

  // 1. Center patches (rename / compact / type / director) on existing rows.
  log("\n--- Centers: patch existing ---");
  for (const p of CENTER_PATCHES) {
    const data: Record<string, unknown> = { compactName: p.compactName };
    if (p.name !== undefined) data.name = p.name;
    if (p.centerType !== undefined) data.centerType = p.centerType;
    if (p.directorCwid !== undefined) data.directorCwid = p.directorCwid;
    log(`  ${p.code}: ${JSON.stringify(data)}`);
    if (!dryRun) {
      const { count } = await db.write.center.updateMany({ where: { code: p.code }, data });
      if (count === 0) log(`    ! no row matched ${p.code} (skipped)`);
    }
  }

  // 2. Create the new centers from the seed (+ directors). Upsert = idempotent.
  log("\n--- Centers: create new ---");
  for (const code of NEW_CENTER_CODES) {
    const seed = CENTERS.find((c) => c.code === code);
    if (!seed) {
      log(`  ! ${code} missing from center-seed-data.ts (skipped)`);
      continue;
    }
    const directorCwid = NEW_CENTER_DIRECTORS[code] ?? null;
    log(`  ${code} "${seed.name}" (${seed.centerType})${directorCwid ? ` director=${directorCwid}` : " no director"}`);
    if (!dryRun) {
      await db.write.center.upsert({
        where: { code: seed.code },
        create: {
          code: seed.code,
          name: seed.name,
          slug: seed.slug,
          compactName: seed.compactName,
          description: seed.description,
          sortOrder: seed.sortOrder,
          centerType: seed.centerType,
          directorCwid,
          source: "manual",
        },
        update: {
          name: seed.name,
          slug: seed.slug,
          compactName: seed.compactName,
          description: seed.description,
          sortOrder: seed.sortOrder,
          centerType: seed.centerType,
          ...(directorCwid ? { directorCwid } : {}),
        },
      });
    }
  }

  // 3. Hard-delete removed centers (memberships + programs cascade).
  log("\n--- Centers: remove ---");
  log(`  delete: ${REMOVE_CENTER_CODES.join(", ")}`);
  if (!dryRun) {
    const { count } = await db.write.center.deleteMany({
      where: { code: { in: REMOVE_CENTER_CODES } },
    });
    log(`    deleted ${count} center row(s).`);
  }

  // 4. Department official / compact names (from lib/department-names.ts).
  log("\n--- Departments: official / compact names ---");
  for (const [code, names] of Object.entries(DEPARTMENT_NAMES)) {
    log(`  ${code}: official="${names.officialName}" compact="${names.compactName}"`);
    if (!dryRun) {
      const { count } = await db.write.department.updateMany({
        where: { code },
        data: { officialName: names.officialName, compactName: names.compactName },
      });
      if (count === 0) log(`    ! no row matched ${code} (skipped)`);
    }
  }

  // 5. Department category corrections.
  log("\n--- Departments: category ---");
  for (const c of DEPT_CATEGORY_PATCHES) {
    log(`  ${c.code} -> ${c.category}`);
    if (!dryRun) {
      const { count } = await db.write.department.updateMany({
        where: { code: c.code },
        data: { category: c.category },
      });
      if (count === 0) log(`    ! no row matched ${c.code} (skipped)`);
    }
  }

  // 6. Department chairs the regex missed — durable override + immediate column.
  log("\n--- Departments: chairs (field_override leaderCwid + chairCwid) ---");
  for (const ch of DEPT_CHAIRS) {
    log(`  ${ch.code} chair=${ch.cwid}`);
    if (!dryRun) {
      await db.write.fieldOverride.upsert({
        where: {
          entityType_entityId_fieldName: {
            entityType: "department",
            entityId: ch.code,
            fieldName: "leaderCwid",
          },
        },
        create: {
          entityType: "department",
          entityId: ch.code,
          fieldName: "leaderCwid",
          value: ch.cwid,
          actorCwid: ACTOR,
        },
        update: { value: ch.cwid, actorCwid: ACTOR },
      });
      const { count } = await db.write.department.updateMany({
        where: { code: ch.code },
        data: { chairCwid: ch.cwid },
      });
      if (count === 0) log(`    ! no row matched ${ch.code} (chair override set, column skip)`);
    }
  }

  // 7. Verification read-back.
  log("\n--- Verify: centers ---");
  const centers = await db.read.center.findMany({
    select: { code: true, name: true, compactName: true, centerType: true, directorCwid: true },
    orderBy: { sortOrder: "asc" },
  });
  for (const c of centers) {
    log(`  ${c.code.padEnd(26)} ${c.centerType.padEnd(9)} dir=${(c.directorCwid ?? "—").padEnd(8)} ${c.name}  [${c.compactName ?? "—"}]`);
  }
  log(`  ${centers.length} center(s).`);

  log("\n--- Verify: departments ---");
  const codes = [
    ...new Set([
      ...Object.keys(DEPARTMENT_NAMES),
      ...DEPT_CATEGORY_PATCHES.map((c) => c.code),
      ...DEPT_CHAIRS.map((c) => c.code),
    ]),
  ];
  const depts = await db.read.department.findMany({
    where: { code: { in: codes } },
    select: { code: true, name: true, officialName: true, compactName: true, category: true, chairCwid: true },
    orderBy: { code: "asc" },
  });
  for (const d of depts) {
    log(
      `  ${d.code} ${d.category.padEnd(14)} chair=${(d.chairCwid ?? "—").padEnd(9)} ` +
        `official="${d.officialName ?? "—"}" compact="${d.compactName ?? "—"}" (ED name: ${d.name})`,
    );
  }

  log(`\nDone${dryRun ? " (dry run)" : ""}.`);
}

const main = async () => {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  await run(dryRun);
  await db.write.$disconnect();
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
