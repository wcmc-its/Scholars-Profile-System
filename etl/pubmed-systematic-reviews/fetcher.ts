/**
 * Asks PubMed which corpus PMIDs its systematic review filter matches. Thin
 * wrapper over NCBI E-utilities ESearch. No auth required (an optional
 * NCBI_API_KEY raises the rate limit from 3 to 10 req/s).
 *
 * One call per batch of PMIDs: the term ORs the batch as `[uid]` clauses and
 * ANDs the filter, so the idlist that comes back is the flagged subset. The
 * request is a form-encoded POST because the term is too long for a GET URL.
 *
 * Retry and backoff match etl/pubmed-retractions/fetcher.ts: a network error,
 * a 429 or 5xx, and an HTTP 200 carrying an ERROR body all retry, then throw.
 * This job also retries a 200 whose body does not parse, because it makes one
 * call per 100 corpus PMIDs and a single bad body would cost the whole run.
 * Every batch either returns its full answer or throws, so the caller never
 * writes from a partial set.
 */
import { BATCH_SIZE, batchPmids, buildTerm } from "./select";

const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";

/** Backoff doubles from RETRY_BASE_MS (2+4+8+16+32s, about a minute per
 *  batch), long enough to ride out a short NCBI backend outage. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
/** Spacing between calls: under 3 a second without a key, under 10 with one. */
const DELAY_MS_KEYLESS = 350;
const DELAY_MS_WITH_KEY = 110;
const CONCURRENCY_WITH_KEY = 3;
const TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injectable for tests; defaults to global fetch. */
export type FetchFn = typeof fetch;

/** The form body for one batch. */
export function esearchBody(pmids: readonly string[], apiKey?: string): URLSearchParams {
  const body = new URLSearchParams({
    db: "pubmed",
    term: buildTerm(pmids),
    retmode: "json",
    retmax: String(BATCH_SIZE),
  });
  if (apiKey) body.set("api_key", apiKey);
  return body;
}

interface EsearchResult {
  count?: string;
  idlist?: string[];
  ERROR?: string;
}

/** The PMIDs of one batch that the filter matches. */
async function esearchBatch(
  pmids: readonly string[],
  fetchFn: FetchFn,
  apiKey: string | undefined,
  retryBaseMs: number,
): Promise<string[]> {
  const body = esearchBody(pmids, apiKey);
  const label = `batch starting ${pmids[0]}`;

  let retries = 0;
  const backoff = () => sleep(retryBaseMs * 2 ** (retries - 1));
  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(ESEARCH, {
        method: "POST",
        body,
        headers: { "User-Agent": "scholars-etl/1.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (retries < MAX_RETRIES) {
        retries++;
        await backoff();
        continue;
      }
      throw err;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries < MAX_RETRIES) {
        retries++;
        await backoff();
        continue;
      }
      throw new Error(`ESearch ${response.status} for ${label}: ${(await response.text()).slice(0, 200)}`);
    }
    // A 200 whose body is not JSON (an HTML error page, a truncated body, a
    // timeout mid-read) is as transient as a failed request: retry it too.
    let json: { esearchresult?: EsearchResult } | null;
    try {
      json = (await response.json()) as { esearchresult?: EsearchResult } | null;
    } catch (err) {
      if (retries < MAX_RETRIES) {
        retries++;
        await backoff();
        continue;
      }
      throw err;
    }
    const res = json?.esearchresult;
    // NCBI reports backend outages ("Search Backend failed ... Cannot connect
    // to SOLR") as HTTP 200 with an ERROR body, so retry these too. A count
    // that disagrees with the idlist is a truncated answer: same treatment.
    const idlist = res?.idlist ?? [];
    const fault = !res
      ? "no esearchresult"
      : res.ERROR
        ? res.ERROR
        : Number(res.count) !== idlist.length
          ? `count ${res.count} but ${idlist.length} ids returned`
          : null;
    if (fault !== null) {
      if (retries < MAX_RETRIES) {
        retries++;
        await backoff();
        continue;
      }
      throw new Error(`ESearch error for ${label}: ${fault}`);
    }
    return idlist;
  }
}

interface FetchOptions {
  fetchFn?: FetchFn;
  apiKey?: string;
  delayMs?: number;
  retryBaseMs?: number;
  /** Calls in flight at once. Defaults to 3 with a key (about 5 requests a second
   *  against NCBI's 10) and 1 without (NCBI allows 3 a second keyless). */
  concurrency?: number;
  /** Called after each batch, for progress logging. */
  onBatch?: (done: number, total: number) => void;
}

export interface FlaggedResult {
  flagged: Set<string>;
  /** All-digit PMIDs asked about. */
  asked: number;
  batches: number;
}

/**
 * Of `pmids`, the ones PubMed's systematic review filter matches. Non-numeric
 * PMIDs are skipped. An id PubMed returns that was not in the batch sent is
 * ignored. Throws on any failed batch.
 */
export async function fetchSystematicReviewPmids(
  pmids: Iterable<string>,
  options: FetchOptions = {},
): Promise<FlaggedResult> {
  const {
    fetchFn = fetch,
    apiKey,
    delayMs = apiKey ? DELAY_MS_WITH_KEY : DELAY_MS_KEYLESS,
    retryBaseMs = RETRY_BASE_MS,
    concurrency = apiKey ? CONCURRENCY_WITH_KEY : 1,
    onBatch,
  } = options;
  const batches = batchPmids(pmids);
  const flagged = new Set<string>();
  let asked = 0;
  let next = 0;
  let done = 0;

  // Each worker takes the next unclaimed batch, then pauses before its next call.
  // A failed batch rejects Promise.all, so the caller never sees a partial set;
  // `failed` stops the other workers from starting further calls.
  let failed = false;
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i];
      const sent = new Set(batch);
      asked += batch.length;
      let ids: string[];
      try {
        ids = await esearchBatch(batch, fetchFn, apiKey, retryBaseMs);
      } catch (err) {
        failed = true;
        throw err;
      }
      for (const id of ids) {
        if (sent.has(id)) flagged.add(id);
      }
      onBatch?.(++done, batches.length);
      if (next < batches.length) await sleep(delayMs);
    }
  };
  const workers = Math.max(1, Math.min(Math.trunc(concurrency) || 1, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { flagged, asked, batches: batches.length };
}
