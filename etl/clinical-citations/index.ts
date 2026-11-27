/**
 * Clinical-citations ETL: the clinical articles that cite our publications.
 *
 * "Clinical" is iCite's flag: the citing article is a clinical trial, a
 * clinical study or a guideline by its PubMed publication type. The links come
 * from `reciterdb.analysis_nih_cites_clin` (cited and citing PMID), for the
 * papers in `publication`. Each citing article's citation (title, authors,
 * journal, year, volume, issue, pages, DOI) comes from PubMed ESummary, which
 * is asked only about articles not stored yet.
 *
 * What it writes (load.ts):
 *   - `citing_document`: one row per citing article, `source` 'pubmed',
 *     `level` 'clinical'.
 *   - `publication_citing_document`: one row per paper and citing article,
 *     `evidence` `{ ownWork: true }` when the citing article is one of ours and
 *     shares a confirmed WCM author with the paper.
 *   - `publication.clinical_cite_count`: citing clinical articles, less the
 *     authors' own.
 * 'clinical' is not a ranked level (`POLICY_LEVELS`), so report 24, the public
 * badges, the publication modal and the Bibliometrics tab do not see any of it.
 *
 * One article, one row. PubMed documents are shared with etl:policy-citations,
 * and `citing_document` is unique on source and PMID. An article that import
 * stored as a guideline, consensus statement or review keeps its level: this
 * one writes it nothing, so it is counted once, where it ranks. And when
 * PubMed later types a row stored here as one of those, etl:policy-citations
 * moves it up (`retypedLevel`) and the count here drops by one.
 *
 * Writes only ever add: a document or link is inserted if new and left alone
 * otherwise. An empty or failed reciterdb read throws before any write, and a
 * read under half the stored links is refused (guard `clinical-citations:links`;
 * bypass deliberately with ETL_GUARD_BYPASS). Every NCBI call returns a whole
 * answer or throws (etl/policy-citations/ncbi.ts). If one throws mid-fetch, the
 * articles already stored are still flagged and counted, and the run then fails.
 *
 * The first load is about 445,000 citing articles, 200 to a PubMed call (some
 * 2,200 calls, one at a time). The fetch runs on a budget (`--minutes`); when it runs out, what
 * was fetched is stored and the next run continues with the rest. The weekly
 * step keeps the default, which is ample for a week's new citing articles, so
 * the first load is a hand run with a long budget, repeated until it reports
 * nothing waiting. Counts are short until then.
 *
 * // ponytail: nothing is ever removed, as in etl:policy-citations. A citation
 * // iCite later drops, or an article it stops flagging as clinical, stays.
 * // ponytail: every confirmed authorship is read to flag own work, also on a
 * // `--pmids` spot check. Narrow it to the PMIDs in play if that read grows.
 *
 * Env: SCHOLARS_RECITERDB_* (lib/sources/reciterdb.ts), optional NCBI_API_KEY.
 *
 * Usage:
 *   npm run etl:clinical-citations
 *   npm run etl:clinical-citations -- --minutes 300      # first load
 *   npm run etl:clinical-citations -- --pmids 24928290   # spot check
 *   npm run etl:clinical-citations -- --limit 2000       # smoke test
 */
import { db } from "../../lib/db";
import { withEtlRun } from "@/lib/etl-run";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { esummary } from "../policy-citations/ncbi";
import type { PubmedSummary } from "../policy-citations/shape";
import { loadClinicalCitations } from "./load";

/**
 * Minutes the PubMed fetch may run; `--minutes` overrides it. The weekly
 * machine's duration alarm (cdk/lib/etl-stack.ts, Weekly maxDuration) has room
 * for this much. Raise both together.
 */
const FETCH_BUDGET_MIN = 30;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const readLinks = (cited: string[]) =>
  withReciterConnection(
    (conn) =>
      conn.query(
        {
          sql: `SELECT DISTINCT cited_pmid, citing_pmid FROM analysis_nih_cites_clin
                 WHERE cited_pmid IN (${cited.map(() => "?").join(",")})`,
          rowsAsArray: true,
        },
        cited.map(Number),
      ) as Promise<Array<[number, number]>>,
  );

async function main(): Promise<number> {
  const start = Date.now();
  const only = arg("--pmids")?.split(",").filter(Boolean);
  const limit = Number(arg("--limit")) || undefined;
  const budgetMin = Number(arg("--minutes")) || FETCH_BUDGET_MIN;

  try {
    const corpus = await db.write.publication.findMany({
      where: only ? { pmid: { in: only } } : undefined,
      select: { pmid: true },
      orderBy: { pmid: "asc" },
    });
    // `publication.pmid` also holds source-prefixed ids for papers not in PubMed.
    const pmids = corpus.map((p) => p.pmid).filter((p) => /^\d{1,9}$/.test(p)).slice(0, limit);
    console.log(`${pmids.length} publications.`);
    if (pmids.length === 0) throw new Error("No publications to check.");

    const summary = await loadClinicalCitations(
      pmids,
      { partial: Boolean(only || limit), budgetMin },
      { readLinks, summaries: (ids) => esummary("pubmed", ids) as Promise<Map<string, PubmedSummary>> },
    );
    console.log(`Done in ${Math.round((Date.now() - start) / 1000)}s: ${summary.linksAdded} citation links added.`);
    return summary.linksAdded;
  } finally {
    await closeReciterPool();
  }
}

// process.exitCode (not process.exit) so the .finally cleanup still runs; the
// disconnect waits for withEtlRun's trailing etl_run write (see etl/data-sharing).
withEtlRun("ClinicalCitations", main)
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.write.$disconnect());
