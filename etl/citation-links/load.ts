/**
 * Citation-links import, the part with no command line: the reciterdb read is
 * passed in, so it is tested against an in-memory client
 * (tests/unit/citation-links.test.ts). index.ts supplies reciterdb.
 */
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { keepLinks, PairBuffer } from "./shape";

const CITED_BATCH = 500;
const INSERT_BATCH = 5000;

export type CitationLinkSources = {
  /** `[cited, citing]` for each cited PMID given, from `analysis_nih_cites`. Throws on a failed read. */
  readLinks: (cited: number[]) => Promise<Array<[number, number]>>;
};

export type CitationLinkSummary = {
  /** Cited papers read. */
  publications: number;
  /** Links the source returned for them. */
  read: number;
  /** Of those, distinct links with both ends in Scholars and two different papers. */
  kept: number;
  /** Of those, links not stored before. */
  added: number;
};

/**
 * Load the citations of `cited` by any paper in `scholars`. Writes only ever
 * add links; a link stored before keeps its `first_seen_at`.
 *
 * Every read finishes before the first write, so an empty, failed or short
 * read writes nothing. The links kept wait in a packed buffer (8 bytes each)
 * rather than as objects; only `scholars` is held as a Set.
 */
export async function loadCitationLinks(
  cited: number[],
  scholars: ReadonlySet<number>,
  opts: { partial: boolean },
  src: CitationLinkSources,
): Promise<CitationLinkSummary> {
  const summary: CitationLinkSummary = { publications: cited.length, read: 0, kept: 0, added: 0 };
  const kept = new PairBuffer();

  for (let i = 0; i < cited.length; i += CITED_BATCH) {
    const rows = await src.readLinks(cited.slice(i, i + CITED_BATCH));
    summary.read += rows.length;
    // Each batch holds whole cited papers, so a pair can only repeat inside one
    // batch: deduping the batch dedupes the run.
    for (const [c, g] of keepLinks(rows, scholars)) kept.push(c, g);
    if ((i / CITED_BATCH) % 50 === 49) {
      console.log(`  ...${Math.min(i + CITED_BATCH, cited.length)}/${cited.length} publications read`);
    }
  }
  summary.kept = kept.length;
  console.log(
    `${summary.read} citation links read for ${cited.length} publications; ` +
      `${summary.kept} have both papers in Scholars.`,
  );

  if (summary.read === 0) {
    // A spot check of a paper nothing cites is an answer. Over the whole
    // corpus it is a broken read.
    if (!opts.partial) throw new Error("analysis_nih_cites returned no citation links for the corpus.");
    return summary;
  }
  if (!opts.partial) {
    // Rows read but none kept means the pmid match is broken (a type or format
    // change), not that no paper cites another. The volume guard below cannot
    // catch it on the first load, when nothing is stored yet.
    if (summary.kept === 0) throw new Error("No citation link has both papers in Scholars; the pmid match is broken.");
    assertSourceVolume("citation-links:links", {
      incoming: summary.kept,
      existing: await db.write.publicationCitation.count(),
      maxDropPct: 50,
    });
  }

  for (let i = 0; i < kept.length; i += INSERT_BATCH) {
    summary.added += (
      await db.write.publicationCitation.createMany({ data: kept.rows(i, i + INSERT_BATCH), skipDuplicates: true })
    ).count;
  }
  console.log(`Written: ${summary.added} citation links added (${summary.kept - summary.added} already stored).`);
  return summary;
}
