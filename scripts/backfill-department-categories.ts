/**
 * One-time backfill: write hand-curated categories from
 * lib/department-categories.ts onto the existing department rows.
 *
 * Idempotent — running it again only updates rows whose category drifted
 * from the seed. The ED ETL respects existing values, so once this is run
 * the categories stick.
 *
 * Usage: npx tsx scripts/backfill-department-categories.ts
 */
import "dotenv/config";
import { db } from "../lib/db";
import { DEPARTMENT_CATEGORIES } from "../lib/department-categories";

async function main() {
  const depts = await db.write.department.findMany({
    select: { code: true, name: true, category: true },
  });

  let updated = 0;
  let skippedMissingFromMap = 0;
  let alreadyCorrect = 0;

  for (const d of depts) {
    const target = DEPARTMENT_CATEGORIES[d.code];
    if (!target) {
      skippedMissingFromMap += 1;
      console.log(`  ! ${d.code} (${d.name}) — no entry in DEPARTMENT_CATEGORIES, leaving as "${d.category}"`);
      continue;
    }
    if (d.category === target) {
      alreadyCorrect += 1;
      continue;
    }
    await db.write.department.update({
      where: { code: d.code },
      data: { category: target },
    });
    updated += 1;
    console.log(`  + ${d.code} (${d.name}): "${d.category}" → "${target}"`);
  }

  console.log(
    `\nDone. ${updated} updated, ${alreadyCorrect} already correct, ${skippedMissingFromMap} missing from seed map.`,
  );
  await db.write.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
