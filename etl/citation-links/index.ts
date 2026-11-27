/**
 * Citation-links ETL: which Scholars publications cite which.
 *
 * Fills `publication_citation` (cited PMID, citing PMID) from
 * `reciterdb.analysis_nih_cites`, keeping only the links where both papers
 * are in `publication`, never a paper citing itself, each pair once. About
 * 3 million links have both ends in the ReCiter corpus; Scholars holds about
 * half of those papers, so expect 1 to 2 million links. Nothing reads the
 * table yet; the Connections view will.
 *
 * Reads go by cited PMID, 500 at a time, and all finish before the first
 * write. Writes only ever add: a link is inserted if new and left alone
 * otherwise, so `first_seen_at` is when this import first saw it. An empty or
 * failed reciterdb read over the corpus throws before any write, and a read
 * that keeps under half the stored links is refused (guard
 * `citation-links:links`; bypass deliberately with ETL_GUARD_BYPASS).
 *
 * // ponytail: nothing is ever removed, as in the other citation imports. A
 * // link whose paper leaves Scholars, or that the source later drops, stays;
 * // a reader joins `publication` on both ends.
 *
 * Env: SCHOLARS_RECITERDB_* (lib/sources/reciterdb.ts).
 *
 * Usage:
 *   npm run etl:citation-links
 *   npm run etl:citation-links -- --pmids 24928290   # spot check: links citing these
 *   npm run etl:citation-links -- --limit 2000       # smoke test: the first 2000 papers
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { loadCitationLinks } from "./load";
import { citedToRead, pubmedPmids } from "./shape";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const readLinks = (cited: number[]) =>
  withReciterConnection(
    (conn) =>
      conn.query(
        {
          sql: `SELECT DISTINCT cited_pmid, citing_pmid FROM analysis_nih_cites
                 WHERE cited_pmid IN (${cited.map(() => "?").join(",")})`,
          rowsAsArray: true,
        },
        cited,
      ) as Promise<Array<[number, number]>>,
  );

async function main(): Promise<number> {
  const start = Date.now();
  const only = arg("--pmids")?.split(",").filter(Boolean);
  const limit = Number(arg("--limit")) || undefined;

  try {
    const corpus = await db.write.publication.findMany({ select: { pmid: true } });
    const scholars = pubmedPmids(corpus.map((p) => p.pmid));
    console.log(`${scholars.length} publications.`);
    if (scholars.length === 0) throw new Error("No publications to check.");

    const cited = citedToRead(scholars, { only, limit });
    if (cited.length === 0) throw new Error("None of the --pmids given is a Scholars publication.");

    const summary = await loadCitationLinks(cited, new Set(scholars), { partial: Boolean(only || limit) }, { readLinks });
    console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s: ${summary.added} citation links added.`);
    return summary.added;
  } finally {
    await closeReciterPool();
  }
}

// process.exitCode (not process.exit) so the .finally cleanup still runs; the
// disconnect waits for withEtlRun's trailing etl_run write (see etl/data-sharing).
withEtlRun("CitationLinks", main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
