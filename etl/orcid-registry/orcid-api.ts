/**
 * ORCID public API (v3.0) client for the registry sweep. Optional
 * client-credentials token (`ORCID_CLIENT_ID` + `ORCID_CLIENT_SECRET`, else
 * anonymous with one warning), ≤10 req/s, 3 retries on 429/5xx/network honouring
 * `Retry-After`, paged `expanded-search`, and a per-run cache for `/works`.
 * The token and client id are never logged.
 */
const PUB = "https://pub.orcid.org/v3.0";
const TOKEN_URL = "https://orcid.org/oauth/token";
const MIN_GAP_MS = 100;
const ROWS = 200;
const MAX_RETRIES = 3;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export type ExpandedResult = {
  "orcid-id": string;
  "given-names": string | null;
  "family-names": string | null;
  "credit-name": string | null;
  "other-name": string[] | null;
  email: string[] | null;
  "institution-name": string[] | null;
};

export type ExternalId = {
  "external-id-type": string;
  "external-id-value": string;
  "external-id-normalized": { value: string } | null;
};
type ExternalIds = { "external-id": ExternalId[] | null } | null;
export type WorksResponse = {
  "last-modified-date": { value: number } | null;
  group:
    | Array<{
        "external-ids": ExternalIds;
        "work-summary": Array<{ "external-ids": ExternalIds }> | null;
      }>
    | null;
};

let token: string | null = null;
let lastRequestAt = 0;
const worksCache = new Map<string, Promise<WorksResponse>>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetches a /read-public token when both env vars are set; otherwise runs anonymously. */
export async function initOrcidAuth(): Promise<void> {
  const id = process.env.ORCID_CLIENT_ID;
  const secret = process.env.ORCID_CLIENT_SECRET;
  if (!id || !secret) {
    console.warn(
      "ORCID_CLIENT_ID / ORCID_CLIENT_SECRET not set — querying pub.orcid.org anonymously (shared rate pool).",
    );
    return;
  }
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "client_credentials",
      scope: "/read-public",
    }),
  });
  if (!resp.ok) throw new Error(`ORCID token request failed: HTTP ${resp.status}`);
  token = ((await resp.json()) as { access_token: string }).access_token;
}

function retryAfterMs(resp: Response): number | null {
  const h = resp.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function orcidGet(url: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      lastErr = err; // network / DNS / timeout
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (resp.ok) return resp.json();
    lastErr = new Error(`ORCID HTTP ${resp.status} for ${url}`);
    if (!RETRYABLE.has(resp.status)) throw lastErr;
    await sleep(Math.max(retryAfterMs(resp) ?? 0, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

/** Every hit for a Solr query, paged 200 at a time until `start` reaches `num-found`. */
export async function expandedSearchAll(
  q: string,
): Promise<{ numFound: number; results: ExpandedResult[] }> {
  const results: ExpandedResult[] = [];
  let numFound = 0;
  for (let start = 0; start === 0 || start < numFound; start += ROWS) {
    const page = (await orcidGet(
      `${PUB}/expanded-search/?q=${encodeURIComponent(q)}&start=${start}&rows=${ROWS}`,
    )) as { "num-found": number; "expanded-result": ExpandedResult[] | null };
    numFound = page["num-found"];
    // The live API returns `null`, not `[]`, when a page is empty.
    const hits = page["expanded-result"] ?? [];
    results.push(...hits);
    if (hits.length === 0) break;
  }
  return { numFound, results };
}

/** `/v3.0/{orcid}/works`, fetched once per run per iD. */
export function fetchWorks(orcid: string): Promise<WorksResponse> {
  let p = worksCache.get(orcid);
  if (!p) {
    p = orcidGet(`${PUB}/${orcid}/works`) as Promise<WorksResponse>;
    worksCache.set(orcid, p);
  }
  return p;
}
