/**
 * MeSH curated-topic anchor ETL — spec §1.4.
 *
 * Run via `npm run etl:mesh-anchors`. One run does:
 *
 *   1. Read curated CSV at etl/mesh-anchors/curated.csv.
 *   2. Compute derived anchors via one SQL aggregation over
 *      `publication.mesh_terms` × `publication_topic`, filtered by
 *      MESH_ANCHOR_THRESHOLD (default 0.30) and MESH_ANCHOR_MIN_SUPPORT
 *      (default 5).
 *   3. Truncate `mesh_curated_topic_anchor`, insert curated rows first,
 *      then insert derived rows whose (descriptor_ui, parent_topic_id)
 *      isn't already covered by a curated row. All inside one
 *      $transaction so an insert failure rolls back the truncate.
 *   4. Log an instrumentation line with curated/derived counts and the
 *      n_desc / ratio percentile distributions, so threshold / min-support
 *      can be tuned from real data once §1.6 surfaces a consumer signal.
 *   5. Record the run in `etl_run` under source="MeshAnchor".
 *
 * Cadence: on demand. Not wired into etl/orchestrate.ts initially — until
 * §1.6 lands and reads the anchor data, the table doesn't change anything
 * user-visible. Add to orchestrate when §1.6 makes the data path hot.
 *
 * Env:
 *   MESH_ANCHOR_THRESHOLD     (default 0.30; spec §1.4 — "≥30% co-occurrence")
 *   MESH_ANCHOR_MIN_SUPPORT   (default 5; minimum pub count per descriptor)
 *   MESH_ANCHOR_CURATED_PATH  (default etl/mesh-anchors/curated.csv)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@/lib/db";
import { parseCuratedCsv } from "./csv";
import { filterDerived, mergeAnchors, percentiles } from "./derive";
import type { AnchorRow, DerivedRowRaw } from "./types";

const THRESHOLD = parseFloat(process.env.MESH_ANCHOR_THRESHOLD ?? "0.30");
const MIN_SUPPORT = parseInt(process.env.MESH_ANCHOR_MIN_SUPPORT ?? "5", 10);
const CURATED_PATH =
  process.env.MESH_ANCHOR_CURATED_PATH ?? "etl/mesh-anchors/curated.csv";

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await prisma.etlRun.create({
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
 * Co-occurrence aggregation. One scan over `publication.mesh_terms` via
 * JSON_TABLE, joined to `publication_topic` deduped per (pmid, parent_topic).
 *
 * Both numerator and denominator use DISTINCT pmid — co-authors on the
 * same paper both tagging the same parent topic count as one pmid, not
 * one per cwid.
 *
 * Ratio direction is `n(descriptor AND topic) / n(descriptor)` — "given
 * the descriptor, how often does this topic fire?" The reversed direction
 * (denominator = pubs with topic) would bias toward niche descriptors.
 *
 * MariaDB 10.6+ / MySQL 8.0+ for JSON_TABLE. Local dev: MariaDB 12.x.
 */
async function loadDerivedRaw(): Promise<DerivedRowRaw[]> {
  // $queryRaw with positional binds keeps the threshold/min-support
  // server-side so the wire payload is small (only rows that clear both
  // gates come back to Node).
  //
  // Coerce Prisma's Decimal / BigInt return types to number at this
  // boundary: `ratio` arrives as Prisma.Decimal (division → DECIMAL in
  // MariaDB), `n_both` and `n_desc` arrive as bigint. Both serialize
  // poorly through JSON.stringify if left raw (Decimal → quoted string,
  // bigint → TypeError). Coerce once here so DerivedRowRaw's declared
  // `number` shape is honest.
  const raw = await prisma.$queryRaw<
    { descriptor_ui: string; parent_topic_id: string; ratio: unknown; n_both: unknown; n_desc: unknown }[]
  >`
    WITH pub_descriptors AS (
      SELECT p.pmid, jt.ui AS descriptor_ui
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
      SELECT DISTINCT pmid, parent_topic_id
      FROM publication_topic
    ),
    co AS (
      SELECT pd.descriptor_ui, pt.parent_topic_id,
             COUNT(DISTINCT pd.pmid) AS n_both
      FROM pub_descriptors pd
      INNER JOIN pub_topics pt USING (pmid)
      GROUP BY pd.descriptor_ui, pt.parent_topic_id
    )
    SELECT co.descriptor_ui,
           co.parent_topic_id,
           co.n_both / dt.n_desc AS ratio,
           co.n_both,
           dt.n_desc
    FROM co
    INNER JOIN descriptor_totals dt USING (descriptor_ui)
    WHERE dt.n_desc >= ${MIN_SUPPORT}
      AND co.n_both / dt.n_desc >= ${THRESHOLD}
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
  const rows = await prisma.$queryRaw<{ n_desc: bigint | number }[]>`
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
  await prisma.$transaction(
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
  const ratios = derivedFiltered.map((r) => r.ratio);
  const ratioStats = percentiles(ratios);
  const curatedRows = anchors.filter((a) => a.confidence === "curated").length;
  const derivedRows = anchors.filter((a) => a.confidence === "derived").length;

  console.log(
    `[MeshAnchor] ${JSON.stringify({
      event: "mesh_anchor_etl_complete",
      curatedRows,
      derivedRows,
      derivedRowsAboveThreshold: derivedFiltered.length,
      threshold: THRESHOLD,
      minSupport: MIN_SUPPORT,
      nDescP50: nDescStats.p50,
      nDescP90: nDescStats.p90,
      nDescP99: nDescStats.p99,
      ratioP50: ratioStats.p50,
      ratioP90: ratioStats.p90,
      ratioP99: ratioStats.p99,
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
    await prisma.$disconnect();
  });
