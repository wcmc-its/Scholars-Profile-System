/**
 * Recover publication titles that ReCiterDB delivers BLANK — issue #2209.
 *
 * ReCiterDB's `analysis_summary_article.articleTitle` arrives as an empty
 * string for a small set of PubMed records. Every affected record measured on
 * 2026-08-05 has the same signature: the PubMed `<ArticleTitle>` carries a
 * SELF-CLOSING inline tag, e.g.
 *
 *   <ArticleTitle>CD38 is methylated in prostate cancer and regulates
 *   extracellular NAD<sup/>.</ArticleTitle>
 *
 * (3 of 190,366 prod rows: PMIDs with a void `<sup/>` in the title). PubMed
 * itself still has the title, so this is recoverable, not lost — the row is a
 * complete publication in every other respect (journal, year, authors, DOI,
 * abstract). Suppressing it from the public render would delete real scholarly
 * output from a scholar's profile and desynchronise every publication count in
 * the app; backfilling from the source of record is the correct repair.
 *
 * Runs inside `etl:reciter` rather than as its own cadence step so it needs no
 * CDK change and re-converges every night: if ReCiterDB later fixes the row,
 * the upstream title simply wins and nothing here fires. Same self-healing
 * shape as the PubMed-retraction step (#604), which already proves NAT egress
 * to E-utilities from the ETL task.
 *
 * NOT a general title source: only PMIDs whose upstream title is blank are ever
 * queried, so a converged corpus makes ZERO network calls.
 */

/** NCBI E-utilities ESummary. No auth required; `NCBI_API_KEY` raises the rate
 *  limit from 3 to 10 req/s. */
const ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

/** IDs per ESummary call. NCBI's documented ceiling for a GET id list is 200. */
const ID_BATCH = 200;

/**
 * Hard ceiling on how many blank titles one run will try to recover. The
 * measured population is 3; anything approaching this is a systemic ReCiterDB
 * regression, not the `<sup/>` long tail, and must not turn the nightly into a
 * corpus-wide E-utilities crawl. Overflow is logged and left to the
 * `(untitled, pmid …)` placeholder.
 */
const MAX_RECOVER = 1000;

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const DEFAULT_DELAY_MS = 350;
/** Per-request ceiling. A hung E-utilities socket must never stall the nightly. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Injectable for tests; defaults to global fetch. */
export type FetchFn = typeof fetch;

export interface FetchTitlesOptions {
  fetchFn?: FetchFn;
  apiKey?: string;
  delayMs?: number;
  timeoutMs?: number;
  maxRecover?: number;
  /** Base backoff between retries; tests pass 0 so the retry path stays fast. */
  retryBaseMs?: number;
}

/** True when a source title carries no renderable text. */
export function isBlankTitle(title: string | null | undefined): boolean {
  return title == null || title.trim() === "";
}

/**
 * Clean an ESummary `title`.
 *
 * ESummary serves the title with inline markup already stripped, which is why
 * a void `<sup/>` surfaces as an empty `()` — the exact records this module
 * exists for read `…extracellular NAD().`. An empty parenthesis pair carries no
 * information in any title, so it is dropped and the surrounding whitespace
 * re-collapsed. Returns `null` when nothing renderable is left.
 */
export function normalizeEsummaryTitle(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  return cleaned === "" ? null : cleaned;
}

interface EsummaryDoc {
  uid?: string;
  title?: string;
  error?: string;
}

interface EsummaryEnvelope {
  result?: Record<string, EsummaryDoc | string[]> & { uids?: string[] };
  error?: string;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esummaryBatch(
  pmids: number[],
  fetchFn: FetchFn,
  apiKey: string | undefined,
  timeoutMs: number,
  retryBaseMs: number,
): Promise<Map<number, string>> {
  const params = new URLSearchParams({
    db: "pubmed",
    retmode: "json",
    id: pmids.join(","),
  });
  if (apiKey) params.set("api_key", apiKey);
  const url = `${ESUMMARY}?${params.toString()}`;

  let retries = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { "User-Agent": "scholars-etl/1.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (retries < MAX_RETRIES) {
        retries++;
        await sleep(retryBaseMs * retries);
        continue;
      }
      throw err;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && retries < MAX_RETRIES) {
        retries++;
        await sleep(retryBaseMs * retries);
        continue;
      }
      throw new Error(`ESummary ${response.status} for ${pmids.length} pmid(s)`);
    }
    const json = (await response.json()) as EsummaryEnvelope;
    if (json.error) throw new Error(`ESummary error: ${json.error}`);
    const result = json.result;
    const out = new Map<number, string>();
    if (!result) return out;
    for (const pmid of pmids) {
      const doc = result[String(pmid)];
      // `uids` is the only array-valued key; a per-uid doc may carry `error`
      // instead of a title (withdrawn record, bad id).
      if (doc == null || Array.isArray(doc) || doc.error) continue;
      const title = normalizeEsummaryTitle(doc.title);
      if (title) out.set(pmid, title);
    }
    return out;
  }
}

/**
 * Fetch titles from PubMed for the given PMIDs. Returns only the PMIDs PubMed
 * could actually name — a missing entry means "still untitled", never an
 * empty-string title. Throws if E-utilities cannot be reached; callers in the
 * nightly path MUST treat that as non-fatal (see `etl/reciter/index.ts`).
 */
export async function fetchPubmedTitles(
  pmids: number[],
  options: FetchTitlesOptions = {},
): Promise<Map<number, string>> {
  const {
    fetchFn = fetch,
    apiKey,
    delayMs = DEFAULT_DELAY_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRecover = MAX_RECOVER,
    retryBaseMs = RETRY_BASE_MS,
  } = options;

  // Real PubMed identifiers only. External-source pubs (#101) carry a synthetic
  // NEGATIVE pmid that PubMed knows nothing about; asking for one wastes a call
  // and pollutes the id list.
  const wanted = Array.from(new Set(pmids.filter((n) => Number.isInteger(n) && n > 0))).sort(
    (a, b) => a - b,
  );
  if (wanted.length === 0) return new Map();

  const capped = wanted.slice(0, maxRecover);
  if (capped.length < wanted.length) {
    console.warn(
      `[pubmed-titles] ${wanted.length} blank upstream titles exceeds the ${maxRecover} recovery cap; ` +
        `repairing the first ${capped.length}. A population this size is an upstream regression, not the <sup/> tail.`,
    );
  }

  const out = new Map<number, string>();
  const batches = chunks(capped, ID_BATCH);
  for (const [i, batch] of batches.entries()) {
    for (const [pmid, title] of await esummaryBatch(
      batch,
      fetchFn,
      apiKey,
      timeoutMs,
      retryBaseMs,
    )) {
      out.set(pmid, title);
    }
    if (i < batches.length - 1) await sleep(delayMs);
  }
  return out;
}

export { ESUMMARY, ID_BATCH, MAX_RECOVER };
