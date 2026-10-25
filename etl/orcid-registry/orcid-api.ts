/**
 * ORCID public API (v3.0) client for the registry sweep. Optional
 * client-credentials token (`ORCID_CLIENT_ID` + `ORCID_CLIENT_SECRET`, else
 * anonymous with one warning), ≤10 req/s, 3 retries on 429/5xx/network honouring
 * `Retry-After`, paged `expanded-search`, and a per-run cache for `/works` and
 * `/record` (etl/orcid-evidence). The token and client id are never logged.
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
  /** `self` = this work's own id; `part-of` / `version-of` = its container (book,
   *  proceedings volume) — not the person's work. Absent on some older records. */
  "external-id-relationship"?: string | null;
};
type ExternalIds = { "external-id": ExternalId[] | null } | null;
type Value<T> = { value: T } | null;
/** One source's copy of a work. `title` / `publication-date` / `source` are read
 *  only by etl/orcid-evidence (the new-works sample); the registry reads ids. */
export type WorkSummary = {
  "external-ids": ExternalIds;
  title?: { title: Value<string> | null } | null;
  "publication-date"?: { year: Value<string> | null } | null;
  source?: { "source-name": Value<string> | null } | null;
};
export type WorksResponse = {
  "last-modified-date": { value: number } | null;
  group: Array<{
    "external-ids": ExternalIds;
    "work-summary": WorkSummary[] | null;
  }> | null;
};

/** An employment / education summary's organization. */
export type AffiliationOrg = {
  name: string | null;
  "disambiguated-organization": {
    "disambiguated-organization-identifier": string | null;
    "disambiguation-source": string | null;
  } | null;
};
type AffiliationGroups = {
  "affiliation-group": Array<{
    summaries: Array<Record<string, { organization: AffiliationOrg | null } | null>> | null;
  }> | null;
} | null;

/** The parts of `/v3.0/{orcid}/record` etl/orcid-evidence reads. Only PUBLIC
 *  fields are ever returned, so an absent block is "not public", not "none". */
export type RecordResponse = {
  history?: { "last-modified-date": Value<number> | null } | null;
  person: {
    name: {
      "given-names": Value<string> | null;
      "family-name": Value<string> | null;
      "credit-name": Value<string> | null;
    } | null;
    "other-names": { "other-name": Array<{ content: string | null }> | null } | null;
    emails: { email: Array<{ email: string | null; verified?: boolean | null }> | null } | null;
  } | null;
  "activities-summary": {
    "last-modified-date": Value<number> | null;
    employments: AffiliationGroups;
    educations: AffiliationGroups;
    works: WorksResponse | null;
  } | null;
};

/** A non-2xx reply after retries. `status` lets the caller tell an auth/blocking
 *  failure (401/403 — every further call will fail too) from a per-record one
 *  (404 unknown iD, 409 deactivated or locked record). */
export class OrcidHttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`ORCID HTTP ${status} for ${url}`);
    this.name = "OrcidHttpError";
  }
}

/** A deprecated (merged) record. ORCID answers 3xx and names the primary iD in
 *  the body ("This account is deprecated. Please refer to account: …"). Before
 *  this, `fetch` followed the redirect and the deprecated iD was scored with its
 *  primary record's emails, affiliations and works. `primary` is null when the
 *  response names no other iD. */
export class OrcidDeprecatedError extends OrcidHttpError {
  constructor(
    status: number,
    url: string,
    public readonly deprecated: string | null,
    public readonly primary: string | null,
  ) {
    super(status, url);
    this.name = "OrcidDeprecatedError";
  }
}

const ORCID_ID = /\d{4}-\d{4}-\d{4}-\d{3}[\dX]/g;

/** The first iD in the redirect's Location or body that is not the requested one. Pure. */
export function primaryFromRedirect(
  url: string,
  location: string | null,
  body: string,
): { deprecated: string | null; primary: string | null } {
  const deprecated = url.match(ORCID_ID)?.[0] ?? null;
  const ids = [...(location ?? "").matchAll(ORCID_ID), ...body.matchAll(ORCID_ID)].map((m) => m[0]);
  return { deprecated, primary: ids.find((i) => i !== deprecated) ?? null };
}

let token: string | null = null;
let lastRequestAt = 0;
const worksCache = new Map<string, Promise<WorksResponse>>();
const recordCache = new Map<string, Promise<RecordResponse>>();

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
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(30_000),
        // A deprecated record redirects to its primary; following it silently
        // would credit the primary's data to the deprecated iD.
        redirect: "manual",
      });
    } catch (err) {
      lastErr = err; // network / DNS / timeout
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (resp.ok) return resp.json();
    if (resp.status >= 300 && resp.status < 400) {
      const body = await resp.text().catch(() => "");
      const { deprecated, primary } = primaryFromRedirect(url, resp.headers.get("location"), body);
      throw new OrcidDeprecatedError(resp.status, url, deprecated, primary);
    }
    lastErr = new OrcidHttpError(resp.status, url);
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

/** `/v3.0/{orcid}/record`, fetched once per run per iD (shared across scholars). */
export function fetchRecord(orcid: string): Promise<RecordResponse> {
  let p = recordCache.get(orcid);
  if (!p) {
    p = orcidGet(`${PUB}/${orcid}/record`) as Promise<RecordResponse>;
    recordCache.set(orcid, p);
  }
  return p;
}
