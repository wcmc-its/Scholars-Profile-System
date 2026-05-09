/**
 * NIH RePORTER PI Profile ETL — issue #90.
 *
 *   1. Walk NIH RePORTER `/projects/search` for every WCM-attributed
 *      project across the requested fiscal-year range.
 *
 *   2. For each project's PIs, resolve `profile_id` → `cwid`:
 *        - Primary: grant-join (project's core_project_num matches a
 *          local Grant row; pair the contact PI with that row's cwid,
 *          then name-match remaining PIs against the project's other
 *          PI-level grant rows).
 *        - Fallback: fuzzy name match against the global pool of
 *          scholars with at least one NIH grant.
 *
 *   3. PI-name query (subaward path). For NIH-grant-having scholars
 *      still unmapped after passes 1+2 — typically because their WCM
 *      grants are subawards on someone else's prime — query
 *      `pi_names: [{first_name, last_name}]` against /projects/search.
 *      Scan returned projects' `principal_investigators[]` for the
 *      matching name and pull the dominant profile_id.
 *
 *   4. For each (profile_id, cwid) pair, pick `is_preferred` per cwid
 *      using the most-recent project_end_date as tiebreaker.
 *
 *   5. Upsert into `person_nih_profile`. Updates `last_verified` on
 *      every run; preserves `first_seen` on existing rows.
 *
 * Modes:
 *   - default: fetch the last 5 fiscal years (catches new researchers,
 *     refreshes the active pool).
 *   - --full:  full backfill, FY 1985 → current.
 *
 * Usage: `npm run etl:nih-profile [--full]`
 */
import { prisma } from "../../lib/db";
import { coreProjectNum } from "@/lib/award-number";
import {
  iterateWcmProjects,
  searchProjectsByPiName,
  sleepBetweenRequests,
  type ReporterPI,
  type ReporterProject,
} from "./fetcher";
import {
  aggregatePreferred,
  resolveByNameFallback,
  resolveByPiNameQuery,
  resolveProjectGrantJoin,
  type GrantRowForResolution,
  type ResolvedObservation,
} from "./resolver";

function currentFiscalYear(): number {
  // NIH FY runs Oct 1 – Sep 30. After Sep, we're already in the next FY.
  const now = new Date();
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 9 ? y + 1 : y;
}

/** Split Scholar.fullName into the (first_name, last_name) pair NIH
 *  RePORTER's `pi_names` filter expects. Strips postnominal segments
 *  after the first comma ("Smith, MD" → "Smith"); takes first
 *  whitespace-token as first_name and last token as last_name (so
 *  "Maria T. Diaz-Meco" → first="Maria", last="Diaz-Meco"). The rare
 *  multi-word particle surnames ("van der Berg") slip through with
 *  last="Berg"; acceptable long-tail miss. */
function parseFirstLast(fullName: string): { firstName: string; lastName: string } {
  const noPostnom = fullName.split(/,\s*/)[0] ?? fullName;
  const tokens = noPostnom.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return { firstName: "", lastName: "" };
  return { firstName: tokens[0]!, lastName: tokens[tokens.length - 1]! };
}

async function loadGrantsByCoreProjectNum(): Promise<Map<string, GrantRowForResolution[]>> {
  const rows = await prisma.grant.findMany({
    where: { awardNumber: { not: null }, scholar: { deletedAt: null } },
    select: {
      cwid: true,
      role: true,
      awardNumber: true,
      scholar: { select: { fullName: true } },
    },
  });
  const byCpn = new Map<string, GrantRowForResolution[]>();
  for (const r of rows) {
    const cpn = coreProjectNum(r.awardNumber);
    if (!cpn) continue;
    const arr = byCpn.get(cpn) ?? [];
    arr.push({ cwid: r.cwid, role: r.role, fullName: r.scholar.fullName });
    byCpn.set(cpn, arr);
  }
  return byCpn;
}

/** Pool of scholars with at least one NIH grant — used for the
 *  global name-match fallback. */
async function loadNihScholarPool(): Promise<GrantRowForResolution[]> {
  const rows = await prisma.grant.findMany({
    where: {
      awardNumber: { not: null },
      scholar: { deletedAt: null, status: "active" },
      // NIH-only filter: the awardNumber parses to a coreProjectNum.
      // Cheap pre-filter; we re-check with coreProjectNum() below.
    },
    select: {
      cwid: true,
      role: true,
      awardNumber: true,
      scholar: { select: { fullName: true } },
    },
    distinct: ["cwid"],
  });
  const out: GrantRowForResolution[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!coreProjectNum(r.awardNumber)) continue;
    if (seen.has(r.cwid)) continue;
    seen.add(r.cwid);
    out.push({ cwid: r.cwid, role: r.role, fullName: r.scholar.fullName });
  }
  return out;
}

async function main() {
  const fullBackfill = process.argv.includes("--full");
  const currentFy = currentFiscalYear();
  const fromFy = fullBackfill ? 1985 : currentFy - 4;
  console.log(
    `\n=== NIH Profile ETL (FY ${fromFy} → ${currentFy}, ${fullBackfill ? "full backfill" : "incremental"}) ===\n`,
  );

  console.log("Loading WCM Grant rows by core_project_num...");
  const grantsByCpn = await loadGrantsByCoreProjectNum();
  console.log(`  ${grantsByCpn.size} distinct core_project_nums in Postgres.`);

  console.log("Loading NIH-grant scholar pool for name-match fallback...");
  const nihPool = await loadNihScholarPool();
  console.log(`  ${nihPool.length} scholars with ≥1 NIH grant.`);

  console.log("\nWalking NIH RePORTER /projects/search...");
  const observations: ResolvedObservation[] = [];
  const unresolvedPis: Array<{ pi: ReporterPI; project: ReporterProject }> = [];
  let projectCount = 0;

  for await (const project of iterateWcmProjects({ fromFiscalYear: fromFy, toFiscalYear: currentFy })) {
    projectCount++;
    const cpn = project.core_project_num;
    const grantsForProject = cpn ? grantsByCpn.get(cpn) ?? [] : [];
    const { observations: obs, unresolved } = resolveProjectGrantJoin(project, grantsForProject);
    observations.push(...obs);
    for (const u of unresolved) unresolvedPis.push({ pi: u, project });
  }

  console.log(`\n${projectCount} projects scanned.`);
  console.log(`  ${observations.length} PI observations resolved via grant-join.`);
  console.log(`  ${unresolvedPis.length} PIs unresolved after grant-join.`);

  // Pass 2: name-match fallback for the unresolved tail.
  let nameMatched = 0;
  for (const { pi, project } of unresolvedPis) {
    const cwid = resolveByNameFallback(pi, nihPool);
    if (cwid) {
      nameMatched++;
      observations.push({
        profileId: pi.profile_id,
        cwid,
        fullName: pi.full_name ?? "",
        projectEndDate: project.project_end_date,
        resolutionSource: "name_match",
      });
    }
  }
  console.log(`  ${nameMatched} resolved via name-match fallback.`);
  console.log(`  ${unresolvedPis.length - nameMatched} unresolvable (no grant-join, no unique name match).\n`);

  // Pass 3: PI-name query for NIH-grant scholars still unmapped after
  // passes 1+2. Catches subaward holders whose prime grants live under
  // another institution's org. Skipped for non-NIH-grant scholars to
  // keep API load proportional — RePORTER returns nothing useful for
  // names with no NIH funding history.
  console.log("Pass 3 (subaward path): querying RePORTER by PI name for unmapped NIH-grant scholars...");
  const mappedCwids = new Set(observations.map((o) => o.cwid));
  const unmappedNihScholars = nihPool.filter((s) => !mappedCwids.has(s.cwid));
  console.log(`  ${unmappedNihScholars.length} unmapped NIH-grant scholars to probe.`);

  let nameQueryResolved = 0;
  let nameQuerySkipped = 0;
  let processed = 0;
  for (const scholar of unmappedNihScholars) {
    const { firstName, lastName } = parseFirstLast(scholar.fullName);
    if (!firstName || !lastName) {
      nameQuerySkipped++;
      continue;
    }
    let results: ReporterProject[];
    try {
      results = await searchProjectsByPiName({ firstName, lastName });
    } catch (err) {
      console.warn(`  pi_names query failed for ${scholar.cwid} (${scholar.fullName}):`, err);
      await sleepBetweenRequests();
      continue;
    }
    const resolved = resolveByPiNameQuery(scholar.fullName, results);
    if (resolved) {
      nameQueryResolved++;
      observations.push({
        profileId: resolved.profileId,
        cwid: scholar.cwid,
        fullName: scholar.fullName,
        projectEndDate: resolved.latestEndDate,
        resolutionSource: "name_query",
      });
    }
    processed++;
    if (processed % 50 === 0) {
      console.log(`  ...probed ${processed}/${unmappedNihScholars.length} (${nameQueryResolved} resolved so far)`);
    }
    await sleepBetweenRequests();
  }
  console.log(`  ${nameQueryResolved} resolved via pi_names query.`);
  if (nameQuerySkipped > 0) {
    console.log(`  ${nameQuerySkipped} skipped (could not parse first/last from fullName).`);
  }
  console.log(`  ${unmappedNihScholars.length - nameQueryResolved - nameQuerySkipped} still unmapped.\n`);

  // Pass 4: aggregate per (cwid, profile_id), pick is_preferred.
  const aggregated = aggregatePreferred(observations);
  console.log(`Writing ${aggregated.length} (cwid, profile_id) rows to person_nih_profile...`);

  const verifiedAt = new Date();
  let upserted = 0;
  // Group by cwid so we can transactionally clear stale is_preferred
  // before flipping a new winner.
  const byCwid = new Map<string, typeof aggregated>();
  for (const r of aggregated) {
    const arr = byCwid.get(r.cwid) ?? [];
    arr.push(r);
    byCwid.set(r.cwid, arr);
  }

  for (const [cwid, rows] of byCwid.entries()) {
    // Function-form transaction. Prisma 7's array-form `$transaction([...])`
    // validates raw queries against the composite-PK model schema and
    // rejects them, even though they're literal SQL. Function form runs
    // statements sequentially against a held connection without that
    // validation pass.
    await prisma.$transaction(async (tx) => {
      // Clear is_preferred on every existing row for this scholar; the
      // upserts below set the new winner. Avoids a unique-violation
      // hazard if we ever convert is_preferred to a per-cwid unique
      // constraint.
      await tx.$executeRaw`UPDATE person_nih_profile SET is_preferred = FALSE WHERE cwid = ${cwid} AND is_preferred = TRUE`;
      for (const r of rows) {
        await tx.personNihProfile.upsert({
          where: {
            cwid_nihProfileId: { cwid: r.cwid, nihProfileId: r.profileId },
          },
          create: {
            cwid: r.cwid,
            nihProfileId: r.profileId,
            isPreferred: r.isPreferred,
            resolutionSource: r.resolutionSource,
            lastVerified: verifiedAt,
          },
          update: {
            isPreferred: r.isPreferred,
            resolutionSource: r.resolutionSource,
            lastVerified: verifiedAt,
          },
        });
      }
    });
    upserted += rows.length;
  }

  console.log(`Upserted ${upserted} rows across ${byCwid.size} scholars.`);
  console.log("\nNIH Profile ETL complete.\n");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
