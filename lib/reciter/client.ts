/**
 * The single network-touching module for ReCiter gold-standard feedback (#746).
 *
 * The self-edit "Not mine" reject (`app/api/edit/reject`) records a publication
 * misattribution locally and — when enabled — propagates it to the ReCiter
 * disambiguation engine so the correction is made at the source. This is the
 * #570 principle made actionable: a reject is for TRUE misattribution only;
 * rejecting one's own paper feeds a false negative into ReCiter and degrades
 * attribution accuracy for the whole corpus, so the UI gates it behind a
 * soft-warning interstitial.
 *
 * Two endpoints, both on the ReCiter ENGINE (the Spring Boot service on :5000,
 * NOT ReciterDB/MySQL) and both requiring the ADMIN api-key in an `api-key`
 * header:
 *   - POST /reciter/goldstandard — add the rejected pmid to the uid's rejected
 *     set. The default merge flag is UPDATE (additive + idempotent: the pmid is
 *     added to `rejectedPmids` and removed from accepted, the rest of the record
 *     untouched). This module NEVER sends `goldStandardUpdateFlag` — sending
 *     REFRESH would overwrite the whole record and wipe a person's accepted
 *     publications.
 *   - GET /reciter/feature-generator/by/uid?analysisRefreshFlag=true — re-run the
 *     engine for that uid so the new gold-standard evidence actually changes the
 *     scores (the goldstandard write only updates DynamoDB; scores are cached).
 *     Heavy + synchronous; fired on a ~1h delay by `etl/reciter-refresh`,
 *     coalesced per uid, NEVER inline in the user's reject request.
 *
 * DORMANT-SAFE. The whole feature is gated behind `RECITER_REJECT_SEND` (default
 * off) AND a configured `RECITER_API_BASE_URL` + `RECITER_API_KEY`. While
 * dormant the reject still records its intent locally; the outbound calls are
 * skipped and retried by the scanner once configured. The api key is read from
 * the environment and NEVER logged (mirrors `gatewayKeyFromEnv` in
 * `lib/seo/llm-client.ts`).
 *
 * Connectivity caveat (#443/#483): if the ReCiter engine is WCM-internal, calls
 * from the SPS VPC can time out. Every call is bounded by `AbortSignal.timeout`
 * and surfaces failure as a thrown error the caller treats as best-effort.
 */

/** Provenance recorded on the ReCiter `GoldStandardAuditLog` — this app. */
export const GOLD_STANDARD_SOURCE = "Scholars";
/** How the curation action originated (ReCiter `EntryPath`). */
export const GOLD_STANDARD_ENTRY_PATH = "CANDIDATE_LIST";

/** Inline (request-path) goldstandard POST timeout — short, best-effort. */
export const GOLD_STANDARD_TIMEOUT_MS = 8_000;
/**
 * Feature-generator timeout — the engine re-run is heavy and synchronous, so the
 * delayed scanner allows a generous ceiling (15 min). Never used inline.
 */
export const FEATURE_GENERATOR_TIMEOUT_MS = 15 * 60_000;

export interface ReciterApiConfig {
  baseUrl: string;
  apiKey: string;
}

/** The master feature switch (default off). Gates the UI, the route, and the scanner. */
export function isReciterRejectEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RECITER_REJECT_SEND === "on";
}

/**
 * Resolve the ReCiter engine base URL + admin api-key from the environment, or
 * `null` when either is unset. `null` means "dormant": record the reject intent
 * locally and let the scanner deliver it once the secret is provisioned.
 */
export function reciterApiConfig(
  env: Record<string, string | undefined> = process.env,
): ReciterApiConfig | null {
  const baseUrl = env.RECITER_API_BASE_URL?.trim();
  const apiKey = env.RECITER_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** Whether the outbound ReCiter calls can actually be made (base URL + key present). */
export function isReciterApiConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return reciterApiConfig(env) !== null;
}

/** ReCiter models pmids as `Long`; coerce + validate so we never send a bad id. */
function toPmidLong(pmid: string): number {
  const n = Number(pmid);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid pmid for ReCiter goldstandard: ${JSON.stringify(pmid)}`);
  }
  return n;
}

export interface GoldStandardReject {
  /** The ReCiter uid — at WCM this is the scholar's CWID. */
  uid: string;
  /** The PubMed id being rejected as not this uid's. */
  pmid: string;
}

/**
 * Record one "not mine" rejection in ReCiter's gold standard. Network call;
 * throws on a non-2xx or a timeout so the caller can treat it as best-effort.
 *
 * The `goldStandardUpdateFlag` query param is DELIBERATELY omitted so ReCiter
 * defaults to UPDATE (additive merge) — the safe, idempotent behavior for a
 * single reject. Never send REFRESH/DELETE here.
 */
export async function postGoldStandardReject(
  { uid, pmid }: GoldStandardReject,
  opts: { timeoutMs?: number; config?: ReciterApiConfig } = {},
): Promise<void> {
  const config = opts.config ?? reciterApiConfig();
  if (!config) {
    throw new Error(
      "ReCiter API is not configured (RECITER_API_BASE_URL / RECITER_API_KEY).",
    );
  }
  const url = new URL("/reciter/goldstandard", config.baseUrl);
  url.searchParams.set("source", GOLD_STANDARD_SOURCE);
  url.searchParams.set("entryPath", GOLD_STANDARD_ENTRY_PATH);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": config.apiKey },
    body: JSON.stringify({ uid, rejectedPmids: [toPmidLong(pmid)] }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? GOLD_STANDARD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `ReCiter goldstandard POST failed for uid ${uid} pmid ${pmid}: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * Re-run the ReCiter engine for one uid against the freshly-written gold
 * standard (`analysisRefreshFlag=true` bypasses the cached AnalysisOutput;
 * `useGoldStandard=AS_EVIDENCE` makes the re-score persist). Heavy + synchronous
 * — call only from the delayed scanner with a generous timeout. Throws on a
 * non-2xx or timeout.
 */
export async function runFeatureGenerator(
  { uid }: { uid: string },
  opts: { timeoutMs?: number; config?: ReciterApiConfig } = {},
): Promise<void> {
  const config = opts.config ?? reciterApiConfig();
  if (!config) {
    throw new Error(
      "ReCiter API is not configured (RECITER_API_BASE_URL / RECITER_API_KEY).",
    );
  }
  const url = new URL("/reciter/feature-generator/by/uid", config.baseUrl);
  url.searchParams.set("uid", uid);
  url.searchParams.set("analysisRefreshFlag", "true");
  url.searchParams.set("useGoldStandard", "AS_EVIDENCE");

  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": config.apiKey },
    signal: AbortSignal.timeout(opts.timeoutMs ?? FEATURE_GENERATOR_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `ReCiter feature-generator failed for uid ${uid}: ${res.status} ${res.statusText}`,
    );
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Linear-backoff retry (2s/4s/6s) over a transient outbound failure (timeout,
 * 429, 5xx) — the #594 `withRetry` shape. Used by the delayed scanner, not the
 * request path (a reject must not block on retries). Re-throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 2_000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(baseDelayMs * i);
    }
  }
  throw lastErr;
}
