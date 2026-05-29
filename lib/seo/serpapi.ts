/**
 * Thin SerpAPI client + pure SERP-parsing helpers for the Google-rank
 * baseline tracker (companion to `scripts/seo/*`).
 *
 * Why SerpAPI and not direct Google scraping: scraping Google's SERP
 * violates its ToS and gets rate-limited / CAPTCHA'd, and the results are
 * personalized and noisy. SerpAPI returns de-personalized, geolocated,
 * structured organic results — the only defensible way to track query-basket
 * positions over time short of Google Search Console (which is first-party but
 * only covers domains you've verified; see `docs/seo-rank-tracking.md`).
 *
 * The API key is read from the SERPAPI_KEY environment variable. It is NEVER
 * hardcoded and NEVER logged (the key appears only as a request query param,
 * which this module does not print).
 *
 * Everything except `fetchSerpResult` is pure and network-free so the parsing
 * logic is unit-tested without spending API credits.
 */

/** One organic result as SerpAPI returns it (only the fields we consume). */
export interface SerpOrganicResult {
  position: number;
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
}

/** The slice of a SerpAPI `engine=google` response we care about. */
export interface SerpResponse {
  organic_results?: SerpOrganicResult[];
  /** SerpAPI surfaces request/quota errors in a top-level `error` string. */
  error?: string;
  search_metadata?: { id?: string; status?: string; created_at?: string };
}

/** Where a target domain landed for a single query. */
export interface DomainPlacement {
  /** 1-based organic position, or null if the domain is not in the fetched window. */
  position: number | null;
  /** The matching result URL (for spot-checking), or null. */
  url: string | null;
  /** The matching result title, or null. */
  title: string | null;
}

const DEFAULT_ENDPOINT = "https://serpapi.com/search";

/** Normalize a hostname for comparison: lowercase, strip a leading `www.`. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * Extract the hostname from a result link. SerpAPI links are absolute URLs,
 * but we parse defensively and return null on anything unparseable.
 */
export function hostOf(link: string | undefined | null): string | null {
  if (!link) return null;
  try {
    return normalizeHost(new URL(link).hostname);
  } catch {
    return null;
  }
}

/**
 * Does `link` belong to `target` (or a subdomain of it)? `target` may be a
 * bare host like `scholars.weill.cornell.edu`. We match the host exactly or as
 * a subdomain so e.g. `www.scholars.weill.cornell.edu` still counts, but a
 * sibling like `notscholars.weill.cornell.edu` does NOT (the dot boundary
 * guards against suffix-collision false positives).
 */
export function hostMatches(link: string | undefined | null, target: string): boolean {
  const host = hostOf(link);
  if (!host) return false;
  const t = normalizeHost(target);
  return host === t || host.endsWith("." + t);
}

/**
 * Best (lowest-numbered) organic placement of `targets` in `results`.
 * `targets` is one or more hosts treated as aliases of the same property
 * (VIVO ran at both `vivo.weill.cornell.edu` and `vivo.med.cornell.edu`), so a
 * hit on any alias counts and we keep the highest-ranked one.
 */
export function findDomainRank(
  results: SerpOrganicResult[] | undefined,
  targets: string | string[],
): DomainPlacement {
  const hosts = Array.isArray(targets) ? targets : [targets];
  let best: DomainPlacement = { position: null, url: null, title: null };
  for (const r of results ?? []) {
    if (typeof r.position !== "number") continue;
    if (!hosts.some((h) => hostMatches(r.link, h))) continue;
    if (best.position === null || r.position < best.position) {
      best = { position: r.position, url: r.link ?? null, title: r.title ?? null };
    }
  }
  return best;
}

export interface SerpRequestOptions {
  /** Google country (`gl`). Default `us`. */
  country?: string;
  /** Interface language (`hl`). Default `en`. */
  language?: string;
  /** Google domain. Default `google.com`. */
  googleDomain?: string;
  /** Number of organic results to request (`num`). Default 20. */
  num?: number;
  /** Optional location string (`location`), e.g. "New York, New York, United States". */
  location?: string;
  /** Bypass SerpAPI's result cache so a re-run gets a fresh SERP. Default false. */
  noCache?: boolean;
}

/**
 * Build the SerpAPI query parameters for one search. Pure: returns a
 * URLSearchParams so the caller can inspect/serialize it. The API key is
 * included here because SerpAPI authenticates by query param; callers must not
 * log the result.
 */
export function buildRequestParams(
  query: string,
  apiKey: string,
  opts: SerpRequestOptions = {},
): URLSearchParams {
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: apiKey,
    gl: opts.country ?? "us",
    hl: opts.language ?? "en",
    google_domain: opts.googleDomain ?? "google.com",
    num: String(opts.num ?? 20),
  });
  if (opts.location) params.set("location", opts.location);
  if (opts.noCache) params.set("no_cache", "true");
  return params;
}

/** Read the SerpAPI key from the environment, or throw a clear error. */
export function serpApiKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env.SERPAPI_KEY?.trim();
  if (!key) {
    throw new Error(
      "SERPAPI_KEY is not set. Export it in your shell (it lives in ~/.zshrc per the project convention) before running a live track. Use --dry-run to validate the basket without it.",
    );
  }
  return key;
}

/**
 * Execute one SerpAPI search. Network call. Throws on transport failure,
 * non-2xx status, or a SerpAPI-level `error` field. The key is never logged
 * (only the redacted endpoint is, by the caller, if at all).
 */
export async function fetchSerpResult(
  query: string,
  apiKey: string,
  opts: SerpRequestOptions = {},
  endpoint: string = DEFAULT_ENDPOINT,
): Promise<SerpResponse> {
  const params = buildRequestParams(query, apiKey, opts);
  const res = await fetch(`${endpoint}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`SerpAPI HTTP ${res.status} ${res.statusText} for query ${JSON.stringify(query)}`);
  }
  const body = (await res.json()) as SerpResponse;
  if (body.error) {
    throw new Error(`SerpAPI error for query ${JSON.stringify(query)}: ${body.error}`);
  }
  return body;
}
