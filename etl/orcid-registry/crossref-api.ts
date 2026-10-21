/**
 * Crossref REST client for the `orcid_crossref` step of the registry sweep: the
 * author list (with any publisher-deposited ORCID iD) of many DOIs per request,
 * via repeated `doi:` filters, which Crossref ORs. Anonymous public pool, so
 * ≤4 req/s, one at a time; 3 retries on 429/5xx/network honouring `Retry-After`.
 */
const API = "https://api.crossref.org/works";
const MIN_GAP_MS = 250;
const MAX_RETRIES = 3;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
export const DOIS_PER_REQUEST = 50;

export type CrossrefAuthor = { given?: string; family?: string; ORCID?: string };
type CrossrefItem = { DOI: string; author?: CrossrefAuthor[] };

export class CrossrefHttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`Crossref HTTP ${status} for ${url}`);
    this.name = "CrossrefHttpError";
  }
}

let lastRequestAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crossrefGet(url: string): Promise<{ message: { items: CrossrefItem[] } }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "WCM-Scholars-ETL/1.0 (+https://scholars.weill.cornell.edu)" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (resp.ok) return resp.json() as Promise<{ message: { items: CrossrefItem[] } }>;
    lastErr = new CrossrefHttpError(resp.status, url);
    if (!RETRYABLE.has(resp.status)) throw lastErr;
    const ra = Number(resp.headers.get("retry-after"));
    await sleep(Math.max(Number.isFinite(ra) ? ra * 1000 : 0, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

/** Author lists for up to DOIS_PER_REQUEST DOIs, keyed by lowercased DOI. A DOI
 *  Crossref does not know is simply absent. Callers must not pass a DOI with a
 *  comma (it would split the filter). */
export async function crossrefAuthors(dois: string[]): Promise<Map<string, CrossrefAuthor[]>> {
  const filter = dois.map((d) => `doi:${d}`).join(",");
  const url = `${API}?filter=${encodeURIComponent(filter)}&select=DOI,author&rows=${dois.length}`;
  const out = new Map<string, CrossrefAuthor[]>();
  for (const it of (await crossrefGet(url)).message.items)
    out.set(it.DOI.toLowerCase(), it.author ?? []);
  return out;
}
