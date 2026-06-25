/**
 * MeSH curated-topic anchor ETL — spec §1.4.
 *
 * Run via `npm run etl:mesh-anchors`. One run does:
 *
 *   1. Read curated CSV at etl/mesh-anchors/curated.csv.
 *   2. Compute derived anchors via one SQL aggregation over
 *      `publication.mesh_terms` × `publication_topic`, restricted to papers
 *      judged highly relevant to a topic (publication_topic.score ≥
 *      MESH_ANCHOR_SCORE_MIN, default 0.9 — #1258). A descriptor anchors a
 *      topic when its relevance-weighted share of that topic (relP) ≥
 *      MESH_ANCHOR_THRESHOLD (default 0.30) over ≥ MESH_ANCHOR_MIN_SUPPORT
 *      high-relevance papers.
 *   3. Truncate `mesh_curated_topic_anchor`, insert curated rows first,
 *      then insert derived rows whose (descriptor_ui, parent_topic_id)
 *      isn't already covered by a curated row. All inside one
 *      $transaction so an insert failure rolls back the truncate.
 *   4. Log an instrumentation line with curated/derived counts and the
 *      n_desc / ratio percentile distributions, so threshold / min-support
 *      can be tuned from real data once §1.6 surfaces a consumer signal.
 *   5. Record the run in `etl_run` under source="MeshAnchor".
 *
 * Cadence: in the nightly chain (etl/orchestrate.ts) after MeshCoverage, once
 * #1258 made the derived anchors useful. Curated rows in the committed CSV
 * always win over derived (confidence: curated > derived).
 *
 * Env:
 *   MESH_ANCHOR_SCORE_MIN     (default 0.9; min publication_topic.score for a
 *                              paper to feed the derivation — #1258. Set >1 to
 *                              disable derived anchors and ship curated-only.)
 *   MESH_ANCHOR_THRESHOLD     (default 0.30; min relevance-weighted topic share)
 *   MESH_ANCHOR_MIN_SUPPORT   (default 5; min high-relevance papers per anchor)
 *   MESH_ANCHOR_CURATED_PATH  (default etl/mesh-anchors/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { parseCuratedCsv } from "./csv";
import { filterDerived, mergeAnchors, percentiles } from "./derive";
import type { AnchorRow, DerivedRowRaw } from "./types";

const THRESHOLD = parseFloat(process.env.MESH_ANCHOR_THRESHOLD ?? "0.30");
const MIN_SUPPORT = parseInt(process.env.MESH_ANCHOR_MIN_SUPPORT ?? "5", 10);
// #1258 — only papers ReciterAI judged highly relevant to a topic feed the
// derivation. 0.9 ≈ top ~12% of publication_topic.score (range [0.30, 0.98]).
const SCORE_MIN = parseFloat(process.env.MESH_ANCHOR_SCORE_MIN ?? "0.9");
const CURATED_PATH =
  process.env.MESH_ANCHOR_CURATED_PATH ?? "etl/mesh-anchors/curated.csv";

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "MeshAnchor",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

/**
 * Relevance-weighted co-occurrence aggregation (#1258). One scan over
 * `publication.mesh_terms` via JSON_TABLE, joined to `publication_topic`.
 *
 * Only papers ReciterAI judged highly relevant to a topic feed the join:
 * `pub_topics` keeps a (pmid, parent_topic) membership iff its strongest
 * per-paper score (MAX over co-authors) ≥ SCORE_MIN. That relevance filter —
 * not a precision threshold — is what makes the derived anchors trustworthy
 * (validated against the #1258 curated set: a bare 0.30 co-occurrence gate
 * reproduced ~1/137; this reproduces ~37/137 with far less noise).
 *
 * `ratio` returned here is relP = the descriptor's relevance-weighted SHARE of
 * a topic = relBoth(d,t) / Σ_t relBoth(d,t). Direction mirrors the old
 * `n(d∩t)/n(d)` precision ("given the descriptor, how concentrated in this
 * topic"), but weighted by relevance and computed only over high-relevance
 * memberships. `n_both` is the high-relevance support count (the real
 * min-support gate); `n_desc` stays the descriptor's all-publication total,
 * kept for the percentile instrumentation and the Node-side defensive filter
 * (n_desc ≥ n_both ≥ MIN_SUPPORT, so that filter stays a true no-op).
 *
 * MariaDB 10.6+ / MySQL 8.0+ for JSON_TABLE. Local dev: MariaDB 12.x.
 */
async function loadDerivedRaw(): Promise<DerivedRowRaw[]> {
  // $queryRaw with positional binds keeps the score/relP/min-support gates
  // server-side so only rows that clear them return to Node.
  //
  // Coerce Prisma's Decimal / BigInt return types to number at this boundary:
  // `ratio` arrives as Prisma.Decimal, `n_both`/`n_desc` as bigint — both
  // serialize poorly through JSON.stringify if left raw.
  const raw = await db.write.$queryRaw<
    { descriptor_ui: string; parent_topic_id: string; ratio: unknown; n_both: unknown; n_desc: unknown }[]
  >`
    WITH pub_descriptors AS (
      SELECT DISTINCT p.pmid, jt.ui AS descriptor_ui
      FROM publication p
      CROSS JOIN JSON_TABLE(
        p.mesh_terms,
        '$[*]' COLUMNS (ui VARCHAR(10) PATH '$.ui')
      ) jt
      WHERE jt.ui IS NOT NULL
    ),
    descriptor_totals AS (
      SELECT descriptor_ui, COUNT(DISTINCT pmid) AS n_desc
      FROM pub_descriptors
      GROUP BY descriptor_ui
    ),
    pub_topics AS (
      SELECT pmid, parent_topic_id, MAX(score) AS rel
      FROM publication_topic
      GROUP BY pmid, parent_topic_id
      HAVING MAX(score) >= ${SCORE_MIN}
    ),
    co AS (
      SELECT pd.descriptor_ui, pt.parent_topic_id,
             COUNT(DISTINCT pd.pmid) AS n_both,
             SUM(pt.rel) AS rel_both
      FROM pub_descriptors pd
      INNER JOIN pub_topics pt USING (pmid)
      GROUP BY pd.descriptor_ui, pt.parent_topic_id
    ),
    desc_rel_total AS (
      SELECT descriptor_ui, SUM(rel_both) AS rel_desc_total
      FROM co
      GROUP BY descriptor_ui
    )
    SELECT co.descriptor_ui,
           co.parent_topic_id,
           co.rel_both / drt.rel_desc_total AS ratio,
           co.n_both,
           dt.n_desc
    FROM co
    INNER JOIN desc_rel_total drt USING (descriptor_ui)
    INNER JOIN descriptor_totals dt USING (descriptor_ui)
    WHERE co.n_both >= ${MIN_SUPPORT}
      AND co.rel_both / drt.rel_desc_total >= ${THRESHOLD}
    ORDER BY co.descriptor_ui, ratio DESC
  `;
  return raw.map((r) => ({
    descriptor_ui: r.descriptor_ui,
    parent_topic_id: r.parent_topic_id,
    ratio: Number(r.ratio),
    n_both: Number(r.n_both),
    n_desc: Number(r.n_desc),
  }));
}

/**
 * Survey-after-the-fact: pull descriptor pub-count totals for *all*
 * descriptors (no threshold), so we can log the full distribution and
 * tune min-support from real data later. Cheap — one aggregate over
 * the same JSON_TABLE expansion.
 */
async function loadDescriptorTotals(): Promise<number[]> {
  const rows = await db.write.$queryRaw<{ n_desc: bigint | number }[]>`
    WITH pub_descriptors AS (
      SELECT p.pmid, jt.ui AS descriptor_ui
      FROM publication p
      CROSS JOIN JSON_TABLE(
        p.mesh_terms,
        '$[*]' COLUMNS (ui VARCHAR(10) PATH '$.ui')
      ) jt
      WHERE jt.ui IS NOT NULL
    )
    SELECT COUNT(DISTINCT pmid) AS n_desc
    FROM pub_descriptors
    GROUP BY descriptor_ui
  `;
  return rows.map((r) => Number(r.n_desc));
}

async function replaceAnchors(anchors: AnchorRow[]): Promise<void> {
  // Single transaction: truncate + bulk-insert. If insert fails mid-way,
  // the truncate rolls back and the table retains its prior contents.
  // The resolver's in-memory cache (§1.5) keeps serving the previous load
  // until the next 1h refresh tick, so an aborted run causes no visible
  // breakage.
  const CHUNK = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.meshCuratedTopicAnchor.deleteMany({});
      for (let i = 0; i < anchors.length; i += CHUNK) {
        const batch = anchors.slice(i, i + CHUNK);
        await tx.meshCuratedTopicAnchor.createMany({
          data: batch.map((a) => ({
            descriptorUi: a.descriptorUi,
            parentTopicId: a.parentTopicId,
            confidence: a.confidence,
            sourceNote: a.sourceNote,
            refreshedAt: new Date(),
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

function readCurated(): ReturnType<typeof parseCuratedCsv> {
  const abs = resolve(process.cwd(), CURATED_PATH);
  let text: string;
  try {
    text = readFileSync(abs, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(
        `[MeshAnchor] ${JSON.stringify({
          event: "curated_csv_missing",
          path: abs,
        })}`,
      );
      return [];
    }
    throw err;
  }
  return parseCuratedCsv(text);
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  if (!Number.isFinite(THRESHOLD) || THRESHOLD < 0 || THRESHOLD > 1) {
    throw new Error(
      `MESH_ANCHOR_THRESHOLD must be a number in [0, 1] (got ${process.env.MESH_ANCHOR_THRESHOLD})`,
    );
  }
  if (!Number.isFinite(MIN_SUPPORT) || MIN_SUPPORT < 1) {
    throw new Error(
      `MESH_ANCHOR_MIN_SUPPORT must be a positive integer (got ${process.env.MESH_ANCHOR_MIN_SUPPORT})`,
    );
  }
  // SCORE_MIN ≥ 0; a value > 1 is the intentional kill-switch (no paper clears
  // it → zero derived rows → curated-only).
  if (!Number.isFinite(SCORE_MIN) || SCORE_MIN < 0) {
    throw new Error(
      `MESH_ANCHOR_SCORE_MIN must be a non-negative number (got ${process.env.MESH_ANCHOR_SCORE_MIN})`,
    );
  }

  const curated = readCurated();
  console.log(
    `[MeshAnchor] ${JSON.stringify({
      event: "curated_loaded",
      rows: curated.length,
    })}`,
  );

  // Both queries run in parallel — they're independent reads.
  const [derivedRaw, descriptorTotals] = await Promise.all([
    loadDerivedRaw(),
    loadDescriptorTotals(),
  ]);
  // Re-apply filter in Node as a defensive no-op (SQL already enforced).
  const derivedFiltered = filterDerived(derivedRaw, {
    threshold: THRESHOLD,
    minSupport: MIN_SUPPORT,
  });
  const anchors = mergeAnchors(curated, derivedFiltered);

  await replaceAnchors(anchors);

  const nDescStats = percentiles(descriptorTotals);
  const relPStats = percentiles(derivedFiltered.map((r) => r.ratio));
  const curatedRows = anchors.filter((a) => a.confidence === "curated").length;
  const derivedRows = anchors.filter((a) => a.confidence === "derived").length;

  console.log(
    `[MeshAnchor] ${JSON.stringify({
      event: "mesh_anchor_etl_complete",
      curatedRows,
      derivedRows,
      derivedRowsAboveThreshold: derivedFiltered.length,
      scoreMin: SCORE_MIN,
      threshold: THRESHOLD,
      minSupport: MIN_SUPPORT,
      nDescP50: nDescStats.p50,
      nDescP90: nDescStats.p90,
      nDescP99: nDescStats.p99,
      relPP50: relPStats.p50,
      relPP90: relPStats.p90,
      relPP99: relPStats.p99,
      durationMs: Date.now() - startedAt,
    })}`,
  );

  await recordRun({ status: "success", rowsProcessed: anchors.length });
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[MeshAnchor] ${JSON.stringify({ event: "fatal", error: message })}`,
    );
    await recordRun({
      status: "failed",
      rowsProcessed: 0,
      errorMessage: message,
    }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
