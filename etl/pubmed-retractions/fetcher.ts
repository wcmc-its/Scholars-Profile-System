/**
 * PubMed retracted-publication fetcher. Thin wrapper over NCBI E-utilities
 * ESearch. No auth required (an optional NCBI_API_KEY raises the rate limit
 * from 3 to 10 req/s).
 *
 * We query the publication type `Retracted Publication` (MeSH D016441), which
 * NLM stamps on the *original* article once it is retracted (the retraction
 * *notice* is a separate record typed `Retraction of Publication`). The set is
 * ~32k PMIDs corpus-wide.
 *
 * Why per-year, not the history server: plain ESearch caps `retstart` at 9,998
 * (it errors past the first 9,999 hits), and the WebEnv/EFetch path proved
 * flaky. Splitting by publication year keeps every bucket under that ceiling
 * (the largest single year is ~7k), so each call is a self-contained ESearch
 * that either returns its full idlist or throws — no silent truncation.
 *
 * Used by the PubMed-retraction ETL (issue #604) to stamp retracted originals
 * that ReCiter has not re-fetched (and therefore not collapsed to
 * `publicationType = 'Retraction'`) since their retraction was published.
 */

const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const RETRACTED_TERM = '"Retracted Publication"[Publication Type]';

/** ESearch hard cap: it refuses retstart > 9998. Year buckets must stay under
 *  this many hits or the fetch throws (so we never silently miss records). */
const ESEARCH_MAX = 9999;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const DEFAULT_DELAY_MS = 350;

/** Earliest bucket is open-ended; MeSH retraction indexing predates 1990 only
 *  thinly, so one pre-1990 bucket is comfortably under ESEARCH_MAX. */
const FIRST_YEAR = 1990;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injectable for tests; defaults to global fetch. */
export type FetchFn = typeof fetch;

interface EsearchResult {
  count: string;
  idlist: string[];
}

async function esearchYear(
  lo: number,
  hi: number,
  fetchFn: FetchFn,
  apiKey: string | undefined,
): Promise<string[]> {
  const params = new URLSearchParams({
    db: "pubmed",
    term: `${RETRACTED_TERM} AND ${lo}:${hi}[dp]`,
    retmode: "json",
    retmax: String(ESEARCH_MAX),
  });
  if (apiKey) params.set("api_key", apiKey);
  const url = `${ESEARCH}?${params.toString()}`;

  let retries = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(url, { headers: { "User-Agent": "scholars-etl/1.0" } });
    } catch (err) {
      if (retries < MAX_RETRIES) {
        retries++;
        await sleep(RETRY_BASE_MS * retries);
        continue;
      }
      throw err;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries < MAX_RETRIES) {
        retries++;
        await sleep(RETRY_BASE_MS * retries);
        continue;
      }
      throw new Error(`ESearch ${response.status} for ${lo}:${hi}: ${await response.text()}`);
    }
    const json = (await response.json()) as { esearchresult?: EsearchResult & { ERROR?: string } };
    const res = json.esearchresult;
    if (!res || res.ERROR) {
      throw new Error(`ESearch error for ${lo}:${hi}: ${res?.ERROR ?? "no esearchresult"}`);
    }
    const count = Number(res.count);
    if (count > ESEARCH_MAX) {
      // A single year exceeded the ESearch ceiling — splitting by year is no
      // longer sufficient. Fail loudly rather than silently drop the overflow.
      throw new Error(
        `Year bucket ${lo}:${hi} has ${count} hits (> ${ESEARCH_MAX}); needs a finer split.`,
      );
    }
    return res.idlist ?? [];
  }
}

interface FetchOptions {
  fetchFn?: FetchFn;
  /** Upper year bound (defaults to a fixed near-future ceiling to avoid the
   *  banned argless `new Date()` in this codebase; callers pass the run year). */
  throughYear: number;
  apiKey?: string;
  delayMs?: number;
}

/**
 * Fetch the full set of `Retracted Publication` PMIDs, paged by publication
 * year. Returns a de-duplicated Set of PMID strings. Throws on any failed
 * bucket so the caller never stamps from a partial set.
 */
export async function fetchRetractedPmids(options: FetchOptions): Promise<Set<string>> {
  const { fetchFn = fetch, throughYear, apiKey, delayMs = DEFAULT_DELAY_MS } = options;
  const out = new Set<string>();

  // One open-ended pre-1990 bucket, then one bucket per year through the run year.
  const buckets: Array<[number, number]> = [[1800, FIRST_YEAR - 1]];
  for (let y = FIRST_YEAR; y <= throughYear; y++) buckets.push([y, y]);

  for (const [lo, hi] of buckets) {
    const ids = await esearchYear(lo, hi, fetchFn, apiKey);
    for (const id of ids) out.add(id);
    await sleep(delayMs);
  }
  return out;
}

export { RETRACTED_TERM, ESEARCH_MAX };
