/**
 * Issue #92 — NSF abstracts ETL.
 *
 * Populates `grant.{abstract, abstractFetchedAt, abstractSource}` for
 * NSF-funded grants. Mirrors etl/reporter's "match by award number,
 * idempotent diff write" shape, except the source of truth is the public
 * NSF Awards API rather than a ReCiterDB-side table.
 *
 * Source-of-truth chain:
 *   NSF Awards API (api.nsf.gov/services/v1/awards.json)
 *     → per-id fetcher (etl/nsf/fetcher.ts)
 *     → grant.{abstract, abstractFetchedAt, abstractSource='nsf'}
 *
 * Match key: 7-digit NSF award ID parsed from `grant.awardNumber` via
 * `nsfAwardId()`. The candidate set is gated on NSF being the canonical
 * sponsor — a bare 7-digit string in awardNumber isn't enough on its own
 * (could be ACS/foundation/etc).
 *
 * Refresh policy: foundation/agency abstracts are stable; refetch only
 * when we don't have one yet, OR when the existing fetch is older than
 * REFRESH_TTL_DAYS. RePORTER pattern is "rewrite every run"; NSF doesn't
 * need that and it's wasteful given the rate-limited one-request-per-grant
 * call shape.
 *
 * Usage: `npm run etl:nsf`
 */
import { prisma } from "../../lib/db";
import { nsfAwardId } from "@/lib/award-number";
import { fetchNsfAward, sleepBetweenRequests } from "./fetcher";

const REFRESH_TTL_DAYS = 90;

function isNsfFunder(g: {
  primeSponsor: string | null;
  primeSponsorRaw: string | null;
  funder: string;
}): boolean {
  if (g.primeSponsor === "NSF") return true;
  // Falls through when primeSponsor canonicalization missed the row. Look
  // for "NSF" / "National Science Foundation" in raw or eyebrow `funder`.
  const hay = `${g.primeSponsorRaw ?? ""} ${g.funder ?? ""}`.toLowerCase();
  return /\bnsf\b/.test(hay) || /national science foundation/.test(hay);
}

function isStale(fetchedAt: Date | null): boolean {
  if (!fetchedAt) return true;
  const ageMs = Date.now() - fetchedAt.getTime();
  return ageMs > REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
}

async function main() {
  const start = Date.now();
  console.log("=== NSF abstracts ETL ===");

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

  // Two filters: funder must look NSF, and awardNumber must yield a
  // 7-digit NSF id. Skip rows with a fresh non-NSF abstract (e.g. RePORTER
  // got there first via mis-attribution) — NSF should never overwrite a
  // RePORTER abstract on a row that NIH also claims.
  type Candidate = {
    id: string;
    nsfId: string;
    awardNumber: string;
    abstractFetchedAt: Date | null;
    currentAbstract: string | null;
    currentSource: string | null;
  };
  const candidates: Candidate[] = [];
  let skippedNotNsf = 0;
  let skippedNoId = 0;
  let skippedFresh = 0;
  let skippedOtherSource = 0;
  for (const g of grants) {
    if (!isNsfFunder(g)) {
      skippedNotNsf++;
      continue;
    }
    const nsfId = nsfAwardId(g.awardNumber);
    if (!nsfId) {
      skippedNoId++;
      continue;
    }
    if (g.abstractSource && g.abstractSource !== "nsf") {
      // Another source owns this row's abstract. Don't fight over it.
      skippedOtherSource++;
      continue;
    }
    if (g.abstract && !isStale(g.abstractFetchedAt)) {
      skippedFresh++;
      continue;
    }
    candidates.push({
      id: g.id,
      nsfId,
      awardNumber: g.awardNumber!,
      abstractFetchedAt: g.abstractFetchedAt,
      currentAbstract: g.abstract,
      currentSource: g.abstractSource,
    });
  }
  console.log(
    `Candidate selection: ${candidates.length} to fetch ` +
    `(${skippedNotNsf} not NSF, ${skippedNoId} no parsable NSF id, ` +
    `${skippedFresh} have fresh NSF abstract, ${skippedOtherSource} owned by another source).`,
  );

  if (candidates.length === 0) {
    console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
    return;
  }

  let fetched = 0;
  let matched = 0;
  let unchanged = 0;
  let unmatched = 0;
  let errored = 0;
  const fetchedAt = new Date();

  for (const c of candidates) {
    fetched++;
    let award;
    try {
      award = await fetchNsfAward(c.nsfId);
    } catch (err) {
      errored++;
      console.warn(`  [${c.nsfId}] fetch error: ${(err as Error).message}`);
      await sleepBetweenRequests();
      continue;
    }
    if (!award) {
      unmatched++;
    } else if (!award.abstractText) {
      // NSF has the award but no abstract published (rare; happens for
      // some legacy program announcements). Still mark it as touched so
      // we don't refetch every run.
      unmatched++;
    } else {
      matched++;
      if (award.abstractText === c.currentAbstract && c.currentSource === "nsf") {
        unchanged++;
      } else {
        await prisma.grant.update({
          where: { id: c.id },
          data: {
            abstract: award.abstractText,
            abstractFetchedAt: fetchedAt,
            abstractSource: "nsf",
          },
        });
      }
    }
    if (fetched % 25 === 0) {
      console.log(
        `  ...${fetched}/${candidates.length} fetched ` +
        `(matched ${matched}, unmatched ${unmatched}, errored ${errored})`,
      );
    }
    await sleepBetweenRequests();
  }

  console.log(
    `\nNSF coverage: ${matched}/${candidates.length} candidates matched ` +
    `(${unchanged} no-op, ${matched - unchanged} written, ${unmatched} unmatched, ${errored} errored).`,
  );
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
