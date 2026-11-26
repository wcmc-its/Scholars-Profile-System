/**
 * ClinicalTrials.gov API v2 calls for the policy-citations ETL. No key. The
 * registry publishes no rate limit, so calls are made one at a time with a
 * pause between them.
 *
 * A search either yields every study it matched or throws, so the caller never
 * writes from a partial read.
 */
import { sleep } from "./ncbi";
import type { CtgovStudy } from "./shape";

const API = "https://clinicaltrials.gov/api/v2/studies";
/** Only what the trials pass stores: each page of 1,000 is about 3.5 MB. */
const FIELDS =
  "NCTId,BriefTitle,OverallStatus,StartDate,LeadSponsorName,LeadSponsorClass,StudyType,Phase,ReferencesModule";
/** The API's cap. */
const PAGE_SIZE = 1000;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const DELAY_MS = 500;
const TIMEOUT_MS = 90_000;

/** Every study that lists any of these papers as a reference, of any type. */
export const referencesTerm = (pmids: ReadonlyArray<string>) => `AREA[ReferencePMID](${pmids.join(" OR ")})`;
/** Every study with at least one background reference. */
export const BACKGROUND_TERM = "AREA[ReferenceType]BACKGROUND";

/** Injectable for tests. `retryBaseMs: 0` makes retries immediate. */
export interface CtgovOptions {
  fetchFn?: typeof fetch;
  retryBaseMs?: number;
  delayMs?: number;
}

type Page = { totalCount?: number; studies?: CtgovStudy[]; nextPageToken?: string };

async function getPage(term: string, pageToken: string | undefined, opts: CtgovOptions): Promise<Page> {
  const { fetchFn = fetch, retryBaseMs = RETRY_BASE_MS } = opts;
  const params = new URLSearchParams({ "query.term": term, fields: FIELDS, pageSize: String(PAGE_SIZE) });
  if (pageToken) params.set("pageToken", pageToken);
  else params.set("countTotal", "true");

  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const res = await fetchFn(`${API}?${params}`, {
        headers: { "User-Agent": "scholars-etl/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const page = (await res.json()) as Page;
        if (Array.isArray(page.studies)) return page;
        failure = "no studies array";
      } else if (res.status === 429 || res.status >= 500) {
        failure = `HTTP ${res.status}`;
      } else {
        throw new Error(`ctgov HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ctgov HTTP")) throw err;
      failure = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= MAX_RETRIES) throw new Error(`ctgov failed after ${attempt + 1} attempts: ${failure}`);
    await sleep(retryBaseMs * 2 ** attempt);
  }
}

/**
 * The studies matching `term`, a page at a time. Checked against the registry's
 * own count for the search, and throws if the walk came up short.
 */
export async function* ctgovStudies(term: string, opts: CtgovOptions = {}): AsyncGenerator<CtgovStudy[]> {
  const { delayMs = DELAY_MS } = opts;
  let expected = 0;
  let read = 0;
  for (let token: string | undefined, first = true; first || token; first = false) {
    const page = await getPage(term, token, opts);
    if (first) expected = page.totalCount ?? 0;
    read += page.studies!.length;
    yield page.studies!;
    token = page.nextPageToken;
    await sleep(delayMs);
  }
  // The registry updates daily, so allow a sliver of drift, not a missing page.
  if (read < expected * 0.99) throw new Error(`ctgov: read ${read} of ${expected} studies for ${term.slice(0, 60)}`);
}
