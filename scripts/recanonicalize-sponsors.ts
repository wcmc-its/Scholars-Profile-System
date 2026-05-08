/**
 * Issue #80 item 8 — backfill canonical sponsor short names on existing
 * Grant rows after a `lib/sponsor-lookup` edit.
 *
 * The InfoEd ETL writes:
 *   - `prime_sponsor_raw` / `direct_sponsor_raw` (always populated with
 *     the upstream string)
 *   - `prime_sponsor` / `direct_sponsor` (canonical short when the raw
 *     resolved against the lookup at ingest time; null otherwise)
 *
 * When a sponsor lookup entry is added or normalization tweaks land, the
 * runtime fallback in `lib/api/profile.ts` and `lib/api/search-funding.ts`
 * already exposes the new mapping to the UI. But facet filters / OpenSearch
 * indexing read the stored values directly — those need to be backfilled.
 *
 * This script re-runs `canonicalizeSponsor()` against every Grant row's raw
 * fields and updates the stored short name in place when:
 *   - Stored is null and a canonical now resolves, OR
 *   - Stored differs from what the lookup currently produces (lookup edited).
 *
 * Idempotent — running twice is a no-op.
 *
 * Usage: npx tsx scripts/recanonicalize-sponsors.ts [--dry-run]
 */
import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../lib/generated/prisma/client";
import { canonicalizeSponsor } from "../lib/sponsor-canonicalize";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(url) });

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const grants = await prisma.grant.findMany({
    select: {
      id: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      directSponsor: true,
      directSponsorRaw: true,
      isSubaward: true,
    },
  });

  let primeUpdated = 0;
  let primeUnchanged = 0;
  let primeUnresolved = 0;
  let directUpdated = 0;
  let directUnchanged = 0;
  let directUnresolved = 0;
  let isSubawardFlipped = 0;

  for (const g of grants) {
    const update: {
      primeSponsor?: string | null;
      directSponsor?: string | null;
      isSubaward?: boolean;
    } = {};

    const primeNew = canonicalizeSponsor(g.primeSponsorRaw);
    if (primeNew !== g.primeSponsor) {
      update.primeSponsor = primeNew;
      primeUpdated += 1;
      console.log(
        `  prime  id=${g.id}: "${g.primeSponsor ?? "(null)"}" → "${primeNew ?? "(null)"}" (raw="${g.primeSponsorRaw ?? ""}")`,
      );
    } else if (primeNew === null) {
      primeUnresolved += 1;
    } else {
      primeUnchanged += 1;
    }

    const directNew = canonicalizeSponsor(g.directSponsorRaw);
    if (directNew !== g.directSponsor) {
      update.directSponsor = directNew;
      directUpdated += 1;
      console.log(
        `  direct id=${g.id}: "${g.directSponsor ?? "(null)"}" → "${directNew ?? "(null)"}" (raw="${g.directSponsorRaw ?? ""}")`,
      );
    } else if (directNew === null) {
      directUnresolved += 1;
    } else {
      directUnchanged += 1;
    }

    // Recompute the subaward flag whenever either canonical changes —
    // canonicalization can collapse two raw strings (e.g. "NCI/NIH/DHHS"
    // and "National Cancer Institute") to the same short, in which case
    // `is_subaward` should flip to false.
    const effectivePrime = update.primeSponsor ?? g.primeSponsor;
    const effectiveDirect = update.directSponsor ?? g.directSponsor;
    const effectivePrimeKey = effectivePrime ?? g.primeSponsorRaw;
    const effectiveDirectKey = effectiveDirect ?? g.directSponsorRaw;
    const newIsSubaward =
      !!effectiveDirectKey &&
      !!effectivePrimeKey &&
      effectiveDirectKey !== effectivePrimeKey;
    if (newIsSubaward !== g.isSubaward) {
      update.isSubaward = newIsSubaward;
      isSubawardFlipped += 1;
    }

    if (Object.keys(update).length === 0) continue;

    if (!DRY_RUN) {
      await prisma.grant.update({
        where: { id: g.id },
        data: update,
      });
    }
  }

  console.log(
    `\nDone${DRY_RUN ? " (dry run — no writes)" : ""}.\n` +
      `  Prime  : ${primeUpdated} updated, ${primeUnchanged} unchanged, ${primeUnresolved} still unresolved\n` +
      `  Direct : ${directUpdated} updated, ${directUnchanged} unchanged, ${directUnresolved} still unresolved\n` +
      `  isSubaward flag flipped on ${isSubawardFlipped} rows`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
