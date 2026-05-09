/**
 * Issue #92 — Gates Foundation abstracts ETL.
 *
 * Pulls the public BMGF committed-grants CSV in one shot (~17 MB,
 * refreshed every few weeks), indexes by canonical grant ID, and writes
 * the `PURPOSE` blurb onto matching `grant` rows in Postgres as the
 * abstract. The CSV is the only public per-grant data Gates publishes —
 * see etl/gates/fetcher.ts for schema/format details.
 *
 * Match key: gatesGrantId() against `awardNumber`. Funder gate is
 * sponsor=Gates Foundation OR raw funder text containing
 * "Gates Foundation" / "BMGF". The bare "INV-…" / "OPP-…" pattern
 * is unambiguous enough to also accept on its own when the sponsor
 * field is unhelpful (some InfoEd rows store the parent NIH-style
 * sponsor instead of the foundation).
 *
 * Refresh policy: foundation summaries don't change once published;
 * 90-day TTL avoids needless rewrites. Source-precedence guard prevents
 * Gates from overwriting an abstract that another source already owns.
 *
 * Usage: `npm run etl:gates`
 */
import { prisma } from "../../lib/db";
import { gatesGrantId } from "@/lib/award-number";
import { fetchGatesGrants } from "./fetcher";

const REFRESH_TTL_DAYS = 90;

function isGatesFunder(g: {
  primeSponsor: string | null;
  primeSponsorRaw: string | null;
  funder: string;
}): boolean {
  if (g.primeSponsor === "Gates Foundation") return true;
  const hay = `${g.primeSponsorRaw ?? ""} ${g.funder ?? ""}`.toLowerCase();
  return /gates foundation/.test(hay) || /\bbmgf\b/.test(hay);
}

function isStale(fetchedAt: Date | null): boolean {
  if (!fetchedAt) return true;
  return Date.now() - fetchedAt.getTime() > REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
}

async function main() {
  const start = Date.now();
  console.log("=== Gates Foundation abstracts ETL ===");

  console.log("Fetching BMGF grants CSV...");
  const fetchedAt = new Date();
  const rows = await fetchGatesGrants();
  console.log(`Got ${rows.length} grants with non-empty PURPOSE.`);

  // Index by canonical Gates ID for O(1) lookup against Postgres rows.
  const byId = new Map<string, { purpose: string; grantee: string }>();
  for (const r of rows) {
    const id = gatesGrantId(r.grantId);
    if (!id) continue;
    byId.set(id, { purpose: r.purpose, grantee: r.grantee });
  }
  console.log(`Indexed ${byId.size} grants by canonical Gates id.`);

  console.log("Loading WCM grants from Postgres...");
  const grants = await prisma.grant.findMany({
    where: { awardNumber: { not: null } },
    select: {
      id: true,
      awardNumber: true,
      funder: true,
      primeSponsor: true,
      primeSponsorRaw: true,
      abstract: true,
      abstractFetchedAt: true,
      abstractSource: true,
    },
  });
  console.log(`${grants.length} grants with non-null awardNumber.`);

  let matched = 0;
  let unchanged = 0;
  let written = 0;
  let skippedNotGates = 0;
  let skippedNoId = 0;
  let skippedFresh = 0;
  let skippedOtherSource = 0;
  let skippedNotInCsv = 0;

  for (const g of grants) {
    const id = gatesGrantId(g.awardNumber);
    if (!id) {
      // Not Gates-shaped, regardless of funder.
      if (isGatesFunder(g)) skippedNoId++;
      continue;
    }
    if (!isGatesFunder(g)) {
      // Has a Gates-shaped id but funder doesn't agree — defensive skip.
      // Avoids overwriting a NIH/foundation grant that happens to have
      // an INV-NNNN account number from InfoEd's own scheme.
      skippedNotGates++;
      continue;
    }
    if (g.abstractSource && g.abstractSource !== "gates") {
      skippedOtherSource++;
      continue;
    }
    const csvHit = byId.get(id);
    if (!csvHit) {
      skippedNotInCsv++;
      continue;
    }
    matched++;
    if (g.abstract && !isStale(g.abstractFetchedAt) && g.abstractSource === "gates") {
      skippedFresh++;
      continue;
    }
    if (csvHit.purpose === g.abstract && g.abstractSource === "gates") {
      unchanged++;
      continue;
    }
    await prisma.grant.update({
      where: { id: g.id },
      data: {
        abstract: csvHit.purpose,
        abstractFetchedAt: fetchedAt,
        abstractSource: "gates",
      },
    });
    written++;
  }

  console.log(
    `\nGates coverage:\n` +
    `  Matched in CSV:           ${matched}\n` +
    `  Written:                  ${written}\n` +
    `  No-op (already up to date): ${unchanged + skippedFresh}\n` +
    `  Funder=Gates but no CSV row: ${skippedNotInCsv}\n` +
    `  Funder=Gates but no parsable id: ${skippedNoId}\n` +
    `  Gates-shaped id, non-Gates funder: ${skippedNotGates}\n` +
    `  Owned by another source:  ${skippedOtherSource}\n` +
    `  Total grants scanned:     ${grants.length}`,
  );
  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
