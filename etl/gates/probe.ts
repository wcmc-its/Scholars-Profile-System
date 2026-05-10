/**
 * Gates probe — fetch the BMGF grants CSV, sanity-check the schema,
 * and report the candidate set the ETL would attempt against Postgres.
 *
 * Usage: `npm run etl:gates:probe`
 */
import { prisma } from "../../lib/db";
import { gatesGrantId } from "@/lib/award-number";
import { fetchGatesGrants } from "./fetcher";

async function main() {
  console.log("=== Gates probe ===");

  console.log("Fetching CSV...");
  const t0 = Date.now();
  const rows = await fetchGatesGrants();
  console.log(`  Got ${rows.length} grants with non-empty PURPOSE in ${Date.now() - t0}ms.`);
  if (rows.length === 0) {
    console.error("  No usable rows. CSV schema may have drifted — check fetcher.ts.");
    process.exit(2);
  }
  const sample = rows.slice(0, 3);
  for (const s of sample) {
    console.log(
      `  - ${s.grantId.padEnd(12)} | ${s.grantee.slice(0, 40).padEnd(40)} | ${s.purpose.slice(0, 80)}…`,
    );
  }

  console.log("\nCandidate selection from Postgres...");
  const grants = await prisma.grant.findMany({
    where: { awardNumber: { not: null } },
    select: {
      awardNumber: true,
      funder: true,
      primeSponsor: true,
      primeSponsorRaw: true,
    },
  });

  const csvIds = new Set(rows.map((r) => gatesGrantId(r.grantId) ?? "").filter(Boolean));

  let gatesFunder = 0;
  let gatesFunderWithId = 0;
  let gatesFunderWithIdInCsv = 0;
  const samplePairs: Array<{ awardNumber: string; canonical: string; inCsv: boolean }> = [];

  for (const g of grants) {
    const isGates =
      g.primeSponsor === "Gates Foundation" ||
      /gates foundation|\bbmgf\b/i.test(`${g.primeSponsorRaw ?? ""} ${g.funder ?? ""}`);
    if (!isGates) continue;
    gatesFunder++;
    const id = gatesGrantId(g.awardNumber);
    if (!id) continue;
    gatesFunderWithId++;
    const inCsv = csvIds.has(id);
    if (inCsv) gatesFunderWithIdInCsv++;
    if (samplePairs.length < 10) samplePairs.push({ awardNumber: g.awardNumber!, canonical: id, inCsv });
  }

  console.log(`  Total grants:               ${grants.length}`);
  console.log(`  Gates-funded:               ${gatesFunder}`);
  console.log(`  …with parsable Gates id:    ${gatesFunderWithId}`);
  console.log(`  …matching a CSV row:        ${gatesFunderWithIdInCsv}`);
  if (samplePairs.length) {
    console.log("\n  Sample mappings (✓ = in CSV):");
    for (const s of samplePairs) {
      const mark = s.inCsv ? "✓" : "✗";
      console.log(`    ${mark} ${s.awardNumber.padEnd(28)} → ${s.canonical}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
