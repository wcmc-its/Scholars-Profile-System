/**
 * #3259 — abstracts for OpenAlex-lane external pubs (conference abstracts, preprints).
 *
 * `reporting_abstracts` is keyed by PubMed pmid, so an `OPENALEX:W…` pub never gets an
 * abstract from reciterdb. OpenAlex has one for ~89% of them (812 of 911 accepted or
 * assigned lane works, 2026-11-03), shipped as an inverted index.
 */
import { reconstructAbstract } from "../fundable-work/work";
import { getJson } from "@/lib/seo/openalex";

const BATCH = 50; // OpenAlex caps an `openalex:` OR-filter at 50 ids

type Work = { id: string; abstract_inverted_index: Record<string, number[]> | null };

/** Bare W id ("W4417001897") → reconstructed abstract, skipping works with none. */
export function abstractsFromWorks(works: Work[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of works) {
    const text = reconstructAbstract(w.abstract_inverted_index);
    if (text) out.set(w.id.slice(w.id.lastIndexOf("/") + 1), text);
  }
  return out;
}

/**
 * Best-effort: a failed batch is counted and skipped, never thrown. The caller keeps the
 * abstract it stored last run for any id missing here, so an OpenAlex outage can't null
 * the column.
 */
export async function fetchOpenAlexAbstracts(
  bareIds: string[],
  mailto: string | undefined,
): Promise<{ abstracts: Map<string, string>; failedBatches: number }> {
  const abstracts = new Map<string, string>();
  let failedBatches = 0;
  for (let i = 0; i < bareIds.length; i += BATCH) {
    const ids = bareIds.slice(i, i + BATCH);
    try {
      const body = await getJson<{ results: Work[] }>(
        `https://api.openalex.org/works?filter=openalex:${ids.join("|")}` +
          `&select=id,abstract_inverted_index&per-page=${BATCH}`,
        mailto,
      );
      for (const [id, text] of abstractsFromWorks(body.results)) abstracts.set(id, text);
    } catch (err) {
      failedBatches++;
      console.warn(
        `OpenAlex abstract batch failed (keeping stored abstracts): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { abstracts, failedBatches };
}
