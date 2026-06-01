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
  /**
   * The AI Overview block Google sometimes renders above the organic results.
   * Already present in the response `seo:track` fetches, so parsing it costs
   * ZERO extra SerpAPI searches (see `findAiOverviewCitation`).
   */
  ai_overview?: AiOverview;
  /** SerpAPI surfaces request/quota errors in a top-level `error` string. */
  error?: string;
  search_metadata?: { id?: string; status?: string; created_at?: string };
}

/** One reference cited by a Google AI Overview block. */
export interface AiOverviewReference {
  /** SerpAPI's own 1-based reference index within the block. */
  index?: number;
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
}

/** The slice of SerpAPI's `ai_overview` object we consume. */
export interface AiOverview {
  text_blocks?: Array<{ type?: string; snippet?: string; reference_indexes?: number[] }>;
  references?: AiOverviewReference[];
  /**
   * Sometimes SerpAPI returns only a `page_token` instead of the full block;
   * the references then require a SEPARATE (billed) `google_ai_overview` fetch.
   * We do NOT pay for that by default — see the `page_token_only` status.
   */
  page_token?: string;
  error?: string;
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
 * Does `link`'s path start with `pathPrefix`? Used to scope a target to a
 * sub-path of a shared host — e.g. Penn has no dedicated profiles host, so its
 * profile pages live under `www.med.upenn.edu/apps/faculty/`. Without this, a
 * bare host match would count any PSOM page and break the profiles-only scope.
 * No prefix → always true (host-level match, the default for every other
 * target). Unparseable link → false.
 */
export function pathMatches(
  link: string | undefined | null,
  pathPrefix: string | undefined,
): boolean {
  if (!pathPrefix) return true;
  if (!link) return false;
  try {
    return new URL(link).pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

/**
 * Best (lowest-numbered) organic placement of `targets` in `results`.
 * `targets` is one or more hosts treated as aliases of the same property
 * (VIVO ran at both `vivo.weill.cornell.edu` and `vivo.med.cornell.edu`), so a
 * hit on any alias counts and we keep the highest-ranked one. An optional
 * `pathPrefix` further restricts matches to URLs whose path starts with it
 * (Penn's `/apps/faculty/`); omitted = host-level match as before.
 */
export function findDomainRank(
  results: SerpOrganicResult[] | undefined,
  targets: string | string[],
  pathPrefix?: string,
): DomainPlacement {
  const hosts = Array.isArray(targets) ? targets : [targets];
  let best: DomainPlacement = { position: null, url: null, title: null };
  for (const r of results ?? []) {
    if (typeof r.position !== "number") continue;
    if (!hosts.some((h) => hostMatches(r.link, h))) continue;
    if (!pathMatches(r.link, pathPrefix)) continue;
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

/**
 * How long (ms) to wait before making another call so that no more than
 * `maxPerHour` calls land in any trailing 60-minute window. Pure: the caller
 * passes the timestamps of prior calls and the current clock.
 *
 * Returns 0 when a slot is free (the common case — a single ~164-query snapshot
 * is well under SerpAPI's Starter cap of 200/hour, so this never throttles it),
 * or when the cap is disabled (`maxPerHour <= 0`). When the trailing window is
 * already full, returns the ms until the oldest in-window call ages out — i.e.
 * we burst up to the cap, then wait, rather than artificially spacing every call.
 */
export function throttleWaitMs(
  callTimestamps: number[],
  maxPerHour: number,
  now: number,
): number {
  if (maxPerHour <= 0) return 0;
  const windowStart = now - 3_600_000;
  const inWindow = callTimestamps.filter((t) => t > windowStart).sort((a, b) => a - b);
  if (inWindow.length < maxPerHour) return 0;
  // The call at this index must exit the window before we can proceed.
  const mustExit = inWindow[inWindow.length - maxPerHour];
  return Math.max(0, mustExit + 3_600_000 - now);
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

// ── AI Overview (Google's citation-RAG SERP block) ──────────────────────────

/**
 * - "parsed": the AI Overview block was present WITH references we could scan.
 * - "page_token_only": the block exists but its references are behind a
 *   `page_token` we deliberately did not pay a second search to expand.
 * - "absent": no AI Overview rendered for this query.
 */
export type AiOverviewStatus = "absent" | "page_token_only" | "parsed";

/** Where a target landed among an AI Overview's cited references. */
export interface AiOverviewPlacement {
  status: AiOverviewStatus;
  /** 1-based position within the (ordered) references list, or null. */
  citationIndex: number | null;
  url: string | null;
  title: string | null;
}

/**
 * Find a target host's citation within a Google AI Overview block. Pure and
 * network-free, reusing the same host/path matchers as `findDomainRank` so an
 * AI-Overview reference and an organic result count a target identically.
 *
 * Honest about partial data: an absent block and a present-but-unexpanded block
 * (`page_token` only, references withheld) are reported via `status`, never
 * conflated with "target not cited". We pay for no second fetch — capturing the
 * AI Overview alongside the organic SERP `seo:track` already retrieved is free.
 */
export function findAiOverviewCitation(
  aiOverview: AiOverview | undefined,
  targets: string | string[],
  pathPrefix?: string,
): AiOverviewPlacement {
  const miss = (status: AiOverviewStatus): AiOverviewPlacement => ({
    status,
    citationIndex: null,
    url: null,
    title: null,
  });
  if (!aiOverview) return miss("absent");
  const refs = aiOverview.references;
  if (!refs || refs.length === 0) {
    return miss(aiOverview.page_token ? "page_token_only" : "absent");
  }
  const hosts = Array.isArray(targets) ? targets : [targets];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (!hosts.some((h) => hostMatches(r.link, h))) continue;
    if (!pathMatches(r.link, pathPrefix)) continue;
    return { status: "parsed", citationIndex: i + 1, url: r.link ?? null, title: r.title ?? null };
  }
  return { status: "parsed", citationIndex: null, url: null, title: null };
}
