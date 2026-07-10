/**
 * COI-gap detection ETL (issue #594 follow-on) — daily, incremental.
 *
 * Recomputes each affected scholar's current COI gaps from already-ingested SPS
 * data (publication_conflict_statement × publication_author × coi_activity) and
 * reconciles them into `coi_gap_candidate`. Persisting — rather than computing
 * ephemerally — means:
 *   - INCREMENTAL: only scholars whose statements / disclosures / author links
 *     changed since the last successful run are reprocessed (no full retrieval).
 *   - DISAVOW: a scholar can dismiss a bad match; the dismissal is durable and
 *     this job never re-surfaces it.
 *   - TRACKING: each gap carries a lifecycle (new → acknowledged / dismissed /
 *     resolved) rather than reappearing from scratch every day.
 *
 * Reads only SPS-DB tables, so unlike the statement INGESTION
 * (`backfill-coi-statements.ts`, which depends on the WCM ReciterDB) this job is
 * NOT VPC-blocked — it runs over whatever has already been ingested.
 *
 * GOVERNANCE: writes candidates + the scholar's review status only. No verdict,
 * no ranking, self-only at render (see docs/coi-pubmed-unmatched-feasibility.md).
 *
 * Usage:
 *   npm run etl:coi-gap            # incremental since last successful run
 *   npm run etl:coi-gap -- --full  # recompute all scholars
 */
import { db, disconnect } from "../../lib/db";
import { computeScholarGaps } from "@/lib/coi-gap/compute";
import { reconcileCandidates, type CandidateStatus, type ExistingGap } from "@/lib/coi-gap/lifecycle";

const FULL = process.argv.slice(2).includes("--full");
const IN_BATCH = 1000;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Scholars whose inputs changed since the watermark (or all on full / first run). */
async function affectedCwids(watermark: Date | null): Promise<string[]> {
  if (FULL || !watermark) {
    const all = await db.write.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    return all.map((s) => s.cwid);
  }
  const set = new Set<string>();

  // Statements ingested/changed since the watermark → their confirmed authors.
  const changedStmts = await db.write.publicationConflictStatement.findMany({
    where: { lastRefreshedAt: { gt: watermark } },
    select: { pmid: true },
  });
  for (const batch of chunks(changedStmts.map((s) => s.pmid), IN_BATCH)) {
    const links = await db.write.publicationAuthor.findMany({
      where: { pmid: { in: batch }, isConfirmed: true, cwid: { not: null } },
      select: { cwid: true },
    });
    for (const l of links) if (l.cwid) set.add(l.cwid);
  }

  // Disclosures changed → re-diff (a newly-disclosed entity should resolve a gap).
  const discChanged = await db.write.coiActivity.findMany({
    where: { lastRefreshedAt: { gt: watermark } },
    select: { cwid: true },
  });
  for (const d of discChanged) set.add(d.cwid);

  // New / re-confirmed author links → newly-matched publications.
  const linkChanged = await db.write.publicationAuthor.findMany({
    where: { lastRefreshedAt: { gt: watermark }, isConfirmed: true, cwid: { not: null } },
    select: { cwid: true },
  });
  for (const l of linkChanged) if (l.cwid) set.add(l.cwid);

  // Scholars with an ACTIVE persisted candidate (new/acknowledged) — reprocess
  // them every incremental run so a gap whose underlying confirmed authorship or
  // conflict statement was DELETED gets reconciled to "resolved". A deletion
  // leaves no `lastRefreshedAt > watermark` trail (the row is simply gone — the
  // reciter ETL is delete-and-reinsert, and a deleted statement disappears), so
  // the three change-scans above can't detect a shrunk input set; the stale High
  // gap would keep nagging until a `--full` run, of which none is scheduled
  // (#988). The active set is small (only surfaced gaps), and `reconcileCandidates`
  // is a no-op when the recompute is unchanged, so this is cheap.
  const withActive = await db.write.coiGapCandidate.findMany({
    where: { status: { in: ["new", "acknowledged"] } },
    distinct: ["cwid"],
    select: { cwid: true },
  });
  for (const c of withActive) set.add(c.cwid);

  return [...set];
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({ data: { source: "COI-Gap", status: "running" } });
  try {
    const last = await db.write.etlRun.findFirst({
      where: { source: "COI-Gap", status: "success" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    const watermark = FULL ? null : (last?.completedAt ?? null);
    const cwids = await affectedCwids(watermark);
    console.log(
      `COI-Gap: ${
        FULL ? "FULL recompute" : watermark ? `incremental since ${watermark.toISOString()}` : "first run (full)"
      } — ${cwids.length} scholars to process.`,
    );

    let processed = 0;
    let upserted = 0;
    let resolved = 0;

    // Each scholar's compute → reconcile → write is independent, and the wall
    // clock is dominated by per-scholar Aurora round-trips (most scholars have no
    // gaps but still pay the read latency). Running a bounded pool of scholars in
    // parallel cuts wall-clock ~CONCURRENCY×. The cap stays below the mariadb pool
    // (connectionLimit 15, lib/db-url.ts) so workers don't starve each other on
    // connections. The shared counters mutate only synchronously between awaits
    // (JS is single-threaded), so there is no data race.
    const CONCURRENCY = 10;

    async function processScholar(cwid: string): Promise<void> {
      const fresh = await computeScholarGaps(cwid);
      const existingRows = await db.write.coiGapCandidate.findMany({
        where: { cwid },
        select: { pmid: true, normalizedEntity: true, status: true },
      });
      const existing: ExistingGap[] = existingRows.map((e) => ({
        pmid: e.pmid,
        normalizedEntity: e.normalizedEntity,
        status: e.status as CandidateStatus,
      }));
      const { upserts, resolve } = reconcileCandidates(existing, fresh);

      for (const u of upserts) {
        await db.write.coiGapCandidate.upsert({
          where: { cwid_pmid_entity: { cwid, pmid: u.pmid, normalizedEntity: u.normalizedEntity } },
          create: {
            cwid,
            pmid: u.pmid,
            entity: u.entity,
            normalizedEntity: u.normalizedEntity,
            tier: u.tier,
            attribution: u.attribution,
            entityScore: u.entityScore,
            category: u.category,
            sourceSentence: u.sourceSentence,
            status: u.status,
            // #1112 — per-mention subject attribution (self/coauthor/unknown + token).
            subjectType: u.subjectType,
            subjectMention: u.subjectMention,
          },
          update: {
            entity: u.entity,
            tier: u.tier,
            attribution: u.attribution,
            entityScore: u.entityScore,
            category: u.category,
            sourceSentence: u.sourceSentence,
            status: u.status,
            // #1112 — refresh the subject each recompute so a re-parsed clause (e.g.
            // once the byline is available) corrects an earlier "unknown".
            subjectType: u.subjectType,
            subjectMention: u.subjectMention,
            lastSeenAt: new Date(),
            // #988 — a reopened (resolved → new) gap must shed the prior review's
            // feedbackReason/reviewedAt so an active "new" row never carries a stale
            // reason (the audit `beforeValues` would otherwise report one). Only
            // "new" clears; an acknowledged/dismissed row keeps its reason. A row
            // already "new" has null here, so this is a no-op for the common case.
            ...(u.status === "new" ? { feedbackReason: null, reviewedAt: null } : {}),
          },
        });
      }

      if (resolve.length > 0) {
        await db.write.coiGapCandidate.updateMany({
          where: {
            cwid,
            status: { in: ["new", "acknowledged"] },
            OR: resolve.map((r) => ({ pmid: r.pmid, normalizedEntity: r.normalizedEntity })),
          },
          data: { status: "resolved", lastSeenAt: new Date() },
        });
      }

      processed++;
      upserted += upserts.length;
      resolved += resolve.length;
      if (processed % 500 === 0) console.log(`  ...${processed}/${cwids.length}`);
    }

    for (const batch of chunks(cwids, CONCURRENCY)) {
      await Promise.all(batch.map((cwid) => processScholar(cwid)));
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: upserted },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `COI-Gap complete in ${elapsed}s: ${processed} scholars, ${upserted} candidates upserted, ${resolved} resolved.`,
    );
  } catch (err) {
    await db.write.etlRun.update({
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
  .finally(disconnect);
