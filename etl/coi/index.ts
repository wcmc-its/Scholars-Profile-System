/**
 * COI ETL — Phase 4e. Disclosures from v_coi_vivo_activity_group.
 * No privacy filtering per user 2026-04-30 — all rows imported.
 *
 * Phase 1 spec amendment: spec didn't enumerate a Disclosures section, but
 * the VIVO predecessor surfaced this data; preserving it.
 *
 * Usage: `npm run etl:coi`
 */
import { prisma } from "@/lib/db";
import { closeCoiPool, withCoiConnection } from "@/lib/sources/mysql-coi";

type Row = {
  cwid: string | null;
  entity: string | null;
  activity_type: string | null;
  value: string | null;
  activity_relates_to: string | null;
  wcmc_facilities: string | null;
  purchasing_procurement: string | null;
  chair_approval: string | null;
  vivo_pops_activity_group: string | null;
  description: string | null;
};

const INSERT_BATCH = 1000;

function chunks<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({ data: { source: "COI", status: "running" } });

  try {
    console.log("Loading active CWIDs...");
    const ours = await prisma.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourSet = new Set(ours.map((s) => s.cwid));
    console.log(`Active scholars: ${ourSet.size}`);

    console.log("Querying v_coi_vivo_activity_group...");
    const rows = await withCoiConnection(async (conn) => {
      const result = (await conn.query(
        `SELECT cwid, entity, activity_type, value, activity_relates_to,
                wcmc_facilities, purchasing_procurement, chair_approval,
                vivo_pops_activity_group, description
         FROM v_coi_vivo_activity_group
         WHERE cwid IS NOT NULL`,
      )) as Row[];
      return result;
    });
    console.log(`COI returned ${rows.length} rows.`);

    const filtered = rows.filter((r) => r.cwid !== null && ourSet.has(r.cwid));
    console.log(`After filter to active scholars: ${filtered.length} rows.`);

    console.log("Resetting coi_activity table...");
    await prisma.coiActivity.deleteMany();

    const inserts = filtered.map((r) => ({
      cwid: r.cwid!,
      entity: r.entity,
      activityType: r.activity_type,
      value: r.value,
      activityRelatesTo: r.activity_relates_to,
      wcmcFacilities: r.wcmc_facilities,
      purchasingProcurement: r.purchasing_procurement,
      chairApproval: r.chair_approval,
      activityGroup: r.vivo_pops_activity_group,
      description: r.description,
      source: "COI",
    }));

    console.log(`Inserting ${inserts.length} disclosures...`);
    let inserted = 0;
    for (const batch of chunks(inserts, INSERT_BATCH)) {
      await prisma.coiActivity.createMany({ data: batch, skipDuplicates: true });
      inserted += batch.length;
      if (inserted % (INSERT_BATCH * 10) === 0) {
        console.log(`  ...${inserted}/${inserts.length}`);
      }
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: inserts.length },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`COI ETL complete in ${elapsed}s: disclosures=${inserts.length}`);
  } catch (err) {
    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await closeCoiPool();
  });
