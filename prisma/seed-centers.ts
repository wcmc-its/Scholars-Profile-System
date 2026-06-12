/**
 * RETIRED (#540 Phase 9). The 8 WCM cross-disciplinary research centers are no
 * longer seeded here — they are manually-owned rows (`source='manual'`) curated
 * through `/edit/center/*`. The unit-curation cutover moved the canonical center
 * + Meyer-program data into `prisma/center-seed-data.ts` and the load/migration
 * into the launch backfill `scripts/backfills/2026-06-10-import-unit-curation.ts`,
 * which also doubles as the dev/CI fixture loader.
 *
 * This file is kept for historical reference (and as an emergency re-seed path).
 * Running it is a no-op by default so a stray `npx tsx prisma/seed-centers.ts`
 * can never reintroduce `source='seed'` rows after the cutover. Pass `--force`
 * to actually upsert — and note it writes `source='manual'` now, matching the
 * post-cutover ownership; the program upserts are unchanged (#552/#584).
 *
 * Run (no-op):      npx tsx prisma/seed-centers.ts
 * Run (force seed):  npx tsx prisma/seed-centers.ts --force
 */
import "dotenv/config";
import { db } from "../lib/db";
import { CENTERS, CENTER_PROGRAMS } from "./center-seed-data";

async function main() {
  const force = process.argv.slice(2).includes("--force");
  if (!force) {
    console.log(
      "seed-centers.ts is retired (#540 Phase 9) — skipped. Centers are manual-layer; " +
        "use scripts/backfills/2026-06-10-import-unit-curation.ts. Pass --force to seed anyway.",
    );
    return;
  }

  let inserted = 0;
  let updated = 0;
  for (const c of CENTERS) {
    const existing = await db.write.center.findUnique({ where: { code: c.code } });
    await db.write.center.upsert({
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
    existing ? updated++ : inserted++;
  }
  console.log(`Centers seeded: ${inserted} new, ${updated} updated (source='manual')`);

  let programs = 0;
  for (const p of CENTER_PROGRAMS) {
    await db.write.centerProgram.upsert({
      where: { centerCode_code: { centerCode: p.centerCode, code: p.code } },
      create: p,
      update: { label: p.label, sortOrder: p.sortOrder },
    });
    programs++;
  }
  console.log(`Center programs seeded: ${programs}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.write.$disconnect());
