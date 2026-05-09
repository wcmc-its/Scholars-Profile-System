/**
 * NSF probe — confirm the NSF Awards API endpoint is reachable, sample a
 * known-good award ID, and report the candidate set in our Postgres so we
 * know roughly how many grants the ETL would attempt before running it.
 *
 * Usage: `npm run etl:nsf:probe`
 */
import { prisma } from "../../lib/db";
import { nsfAwardId } from "@/lib/award-number";
import { fetchNsfAward } from "./fetcher";

// A long-running, public NSF award used as an availability ping. If this
// ever stops returning, the API has changed shape — don't run the ETL.
const KNOWN_GOOD_ID = "2138052";

async function main() {
  console.log("=== NSF API probe ===");
  console.log(`Pinging NSF Awards API with id=${KNOWN_GOOD_ID}...`);
  try {
    const award = await fetchNsfAward(KNOWN_GOOD_ID);
    if (!award) {
      console.error("  NSF returned no award for the known-good id. API may have changed.");
      process.exit(2);
    }
    console.log(
      `  OK — awardee="${award.awardeeName}", title="${(award.title ?? "").slice(0, 60)}…", ` +
      `abstract length=${(award.abstractText ?? "").length}`,
    );
  } catch (err) {
    console.error(`  FAIL — ${(err as Error).message}`);
    process.exit(2);
  }

  console.log("\nCandidate selection from Postgres...");
  const grants = await prisma.grant.findMany({
    where: { awardNumber: { not: null } },
    select: {
      id: true,
      awardNumber: true,
      funder: true,
      primeSponsor: true,
      primeSponsorRaw: true,
    },
  });

  let nsfFunder = 0;
  let nsfFunderWithId = 0;
  const sample: Array<{ awardNumber: string; nsfId: string }> = [];
  for (const g of grants) {
    const isNsf =
      g.primeSponsor === "NSF" ||
      /\bnsf\b|national science foundation/i.test(
        `${g.primeSponsorRaw ?? ""} ${g.funder ?? ""}`,
      );
    if (!isNsf) continue;
    nsfFunder++;
    const id = nsfAwardId(g.awardNumber);
    if (id) {
      nsfFunderWithId++;
      if (sample.length < 10) sample.push({ awardNumber: g.awardNumber!, nsfId: id });
    }
  }

  console.log(`  Total grants: ${grants.length}`);
  console.log(`  NSF-funded:   ${nsfFunder}`);
  console.log(`  …with parsable NSF id: ${nsfFunderWithId}`);
  if (sample.length) {
    console.log("\n  Sample mappings:");
    for (const s of sample) console.log(`    ${s.awardNumber.padEnd(24)} → ${s.nsfId}`);
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
