import { fetchPubmedTitles } from "@/etl/reciter/pubmed-titles";
import type { CueHit } from "./score";

/**
 * Cue 2's rejected papers get PubMed's title, so the queue can say which papers
 * they were. Most were never on a WCM profile, so the publication table cannot
 * name them. Best effort: an E-utilities failure leaves the PMIDs untitled.
 * Mutates the hits in place.
 */
export async function fillRejectedTitles(
  reasons: Iterable<ReadonlyArray<CueHit>>,
  fetchTitles: (pmids: number[]) => Promise<Map<number, string>> = (pmids) =>
    fetchPubmedTitles(pmids, { apiKey: process.env.NCBI_API_KEY }),
): Promise<void> {
  const papers = [...reasons].flatMap((hits) => hits.flatMap((h) => h.rejected ?? []));
  if (papers.length === 0) return;
  try {
    const titles = await fetchTitles(papers.map((p) => Number(p.pmid)));
    for (const p of papers) p.title = titles.get(Number(p.pmid)) ?? null;
  } catch (err) {
    console.warn(`  rejected-paper titles fetch failed: ${(err as Error).message}`);
  }
}
