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
 *
 * The suggested-articles READ (`fetchSuggestedArticles`, below) does NOT touch
 * the engine HTTP API at all — it reads ReCiter's DynamoDB (GoldStandard +
 * Analysis) and S3 (offloaded AnalysisOutput) directly with a read-only IAM
 * grant and NO api-key. The #746 reject WRITE path above is unchanged.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

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

/**
 * Live "suggested articles" read (replaces the nightly
 * `reciter_pending_suggestion` table). The freshness fix: instead of trusting a
 * cached snapshot of the engine's per-article `userAssertion`, we cross the
 * candidate list against the uid's gold standard (`knownpmids`/`rejectedpmids`),
 * which is written synchronously on every accept/reject — so a pub the scholar
 * just curated disappears from the suggestions immediately.
 *
 * SOURCE: ReCiter's own DynamoDB + S3 (account 665083158573, us-east-1), read
 * directly with a read-only IAM grant — NO api-key, no engine HTTP round-trip:
 *
 *   - DynamoDB `GoldStandard` (key uid = bare cwid): `knownpmids` /
 *     `rejectedpmids` (Number lists; ABSENT when empty), written synchronously
 *     on every curate so they are real-time fresh. A MISSING item is normal
 *     (uncurated scholar) ⇒ empty curated set.
 *   - DynamoDB `Analysis` (key uid): `reCiterFeature.reCiterArticleFeatures`.
 *     When the analysis is large it is OFFLOADED — the item then carries only
 *     uid/usingS3/schemaVersion and the full object is plain JSON (NOT gzipped)
 *     at s3://reciter-dynamodb/AnalysisOutput/<uid>, whose top level IS the
 *     reCiterFeature object.
 *
 * `GetCommand` from lib-dynamodb auto-unmarshalls, so `Item.knownpmids` is a
 * `number[]` and `Item.reCiterFeature` is a plain object. Credentials come from
 * the AWS SDK default chain (ECS task role in prod) — never hardcoded here.
 */

/** Minimum authorship-likelihood score (0-100) a candidate must clear. */
export const SUGGESTED_ARTICLES_MIN_SCORE = 40;
/** ReCiter's gold-standard table (key uid = bare cwid). */
const GOLDSTANDARD_TABLE = process.env.SCHOLARS_GOLDSTANDARD_TABLE ?? "GoldStandard";
/** ReCiter's analysis table (key uid; reCiterFeature inline or S3-offloaded). */
const ANALYSIS_TABLE = process.env.SCHOLARS_ANALYSIS_TABLE ?? "Analysis";
/** Bucket holding offloaded AnalysisOutput/<uid> JSON. */
const ANALYSIS_BUCKET = process.env.RECITER_ANALYSIS_BUCKET ?? "reciter-dynamodb";
/** ReCiter's DynamoDB/S3 live in us-east-1 regardless of the SPS region. */
const RECITER_REGION =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
/** Max authors to render inline before collapsing to "first 6 … last". */
const AUTHORS_DISPLAY_MAX = 8;

/** A suggested-article card payload (the shape the card component consumes). */
export interface ReciterSuggestion {
  pmid: string;
  score: number;
  articleTitle: string;
  authors: string;
  journal: string | null;
  datePublished: string | null;
  isPreprint: boolean;
}

interface ReciterAuthorFeature {
  rank?: number;
  firstName?: string;
  lastName?: string;
  initials?: string;
  isTargetAuthor?: boolean;
}

interface ReciterArticleFeature {
  pmid?: number;
  authorshipLikelihoodScore?: number;
  userAssertion?: string;
  articleTitle?: string;
  journalTitleVerbose?: string;
  publicationDateDisplay?: string;
  publicationType?: { publicationTypeCanonical?: string };
  reCiterArticleAuthorFeatures?: ReciterAuthorFeature[];
}

/** The `reCiterFeature` object — inline on the Analysis item or the S3 top level. */
interface ReciterFeature {
  reCiterArticleFeatures?: ReciterArticleFeature[];
}

/** The unmarshalled `Analysis` item (GetCommand auto-unmarshalls). */
interface AnalysisItem {
  uid?: string;
  reCiterFeature?: ReciterFeature;
  // Offload markers (naming varies across ReCiter versions); when present (and
  // reCiterFeature absent) the full object lives in S3.
  usingS3?: boolean;
  s3StorageFlag?: boolean;
  schemaVersion?: unknown;
}

/** The unmarshalled `GoldStandard` item — knownpmids/rejectedpmids are number lists. */
interface GoldStandardItem {
  uid?: string;
  knownpmids?: number[];
  rejectedpmids?: number[];
}

/**
 * The minimal surface of the two AWS clients this module uses. Both accept a
 * `.send(command)` and are injectable via `opts.ddb` / `opts.s3` so tests can
 * supply fakes without real AWS access.
 */
export interface ReciterDdbClient {
  send(command: GetCommand): Promise<{ Item?: Record<string, unknown> }>;
}
export interface ReciterS3Client {
  send(command: GetObjectCommand): Promise<{ Body?: { transformToString(enc: string): Promise<string> } }>;
}

// Lazily-constructed module singletons — only built when a real read happens
// (and never in tests, which inject fakes). Region-pinned to ReCiter's us-east-1.
let ddbSingleton: ReciterDdbClient | undefined;
let s3Singleton: ReciterS3Client | undefined;

function defaultDdb(): ReciterDdbClient {
  if (!ddbSingleton) {
    ddbSingleton = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: RECITER_REGION }),
    ) as unknown as ReciterDdbClient;
  }
  return ddbSingleton;
}

function defaultS3(): ReciterS3Client {
  if (!s3Singleton) {
    s3Singleton = new S3Client({ region: RECITER_REGION }) as unknown as ReciterS3Client;
  }
  return s3Singleton;
}

/**
 * Render the author byline: order by rank, "FirstName LastName" each, joined by
 * ", ". Beyond {@link AUTHORS_DISPLAY_MAX} authors, collapse to the first 6, an
 * ellipsis, then the last author ("A, B, … LastAuthor"), mirroring the mockup.
 */
export function formatSuggestionAuthors(features: ReciterAuthorFeature[]): string {
  const names = [...features]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .map((f) => [f.firstName, f.lastName].filter(Boolean).join(" ").trim())
    .filter((n) => n.length > 0);

  if (names.length <= AUTHORS_DISPLAY_MAX) return names.join(", ");

  const head = names.slice(0, 6);
  const last = names[names.length - 1];
  return [...head, "…", last].join(", ");
}

/**
 * Filter a candidate list to genuinely-uncurated suggestions and map to the card
 * shape. KEEP iff score >= {@link SUGGESTED_ARTICLES_MIN_SCORE}, the pmid is NOT
 * in `curated` (the GoldStandard known/rejected set — empty for the API source,
 * which has no live cross-check), and userAssertion is not ACCEPTED/REJECTED.
 * Sorted by score descending. Shared by the DynamoDB and engine-API sources.
 */
function articleFeaturesToSuggestions(
  features: ReciterArticleFeature[],
  curated: Set<string> = new Set(),
): ReciterSuggestion[] {
  const kept: ReciterSuggestion[] = [];
  for (const a of features) {
    const score = a.authorshipLikelihoodScore;
    if (typeof score !== "number" || score < SUGGESTED_ARTICLES_MIN_SCORE) continue;
    if (a.pmid == null) continue;
    const pmid = String(a.pmid);
    if (curated.has(pmid)) continue;
    if (a.userAssertion === "ACCEPTED" || a.userAssertion === "REJECTED") continue;

    kept.push({
      pmid,
      score: Math.round(score),
      articleTitle: a.articleTitle ?? "",
      authors: formatSuggestionAuthors(a.reCiterArticleAuthorFeatures ?? []),
      journal: a.journalTitleVerbose || null,
      datePublished: a.publicationDateDisplay || null,
      isPreprint: a.publicationType?.publicationTypeCanonical === "Preprint",
    });
  }
  kept.sort((x, y) => y.score - x.score);
  return kept;
}

/**
 * Fetch the uid's live "suggested articles" by reading ReCiter's DynamoDB +
 * S3 directly (read-only IAM, NO api-key) and filtering to genuinely-uncurated
 * candidates.
 *
 * Two parallel DynamoDB GetItem reads:
 *   1. `GoldStandard` — the fresh accept/reject sets (`knownpmids` /
 *      `rejectedpmids`), written synchronously on every curate.
 *   2. `Analysis` — the candidate list with scores
 *      (`reCiterFeature.reCiterArticleFeatures`). When OFFLOADED the item has
 *      no `reCiterFeature`; the full object is then read from
 *      s3://{ANALYSIS_BUCKET}/AnalysisOutput/<uid> (plain JSON, top level IS
 *      the reCiterFeature object).
 *
 * A candidate is KEPT iff score >= {@link SUGGESTED_ARTICLES_MIN_SCORE}, its
 * pmid is in NEITHER knownpmids nor rejectedpmids, and its (stale) userAssertion
 * is not ACCEPTED/REJECTED. Kept candidates are mapped to {@link
 * ReciterSuggestion} and sorted by score descending.
 *
 * SAFETY: a THROWN GoldStandard read (table unreadable) means we cannot apply
 * the freshness filter, so the catch returns `[]` (degrade to hidden) rather
 * than risk surfacing an already-curated pub. A MISSING GoldStandard item is
 * NORMAL (an uncurated scholar) ⇒ empty curated set ⇒ candidates returned. Any
 * error / timeout returns `[]` — this function NEVER throws.
 *
 * `opts.ddb` / `opts.s3` inject fake clients for tests; production uses the
 * lazily-built region-pinned singletons.
 */
export async function fetchSuggestedArticles(
  uid: string,
  opts: { ddb?: ReciterDdbClient; s3?: ReciterS3Client } = {},
): Promise<ReciterSuggestion[]> {
  const ddb = opts.ddb ?? defaultDdb();
  const s3 = opts.s3 ?? defaultS3();

  try {
    const [gs, an] = await Promise.all([
      ddb.send(new GetCommand({ TableName: GOLDSTANDARD_TABLE, Key: { uid } })),
      ddb.send(new GetCommand({ TableName: ANALYSIS_TABLE, Key: { uid } })),
    ]);

    // A THROW above (GoldStandard unreadable) is caught below ⇒ []. A missing
    // Item is fine: an uncurated scholar has an empty curated set.
    const gsItem = gs.Item as GoldStandardItem | undefined;
    const curated = new Set<string>(
      [...(gsItem?.knownpmids ?? []), ...(gsItem?.rejectedpmids ?? [])].map((p) =>
        String(p),
      ),
    );

    const anItem = an.Item as AnalysisItem | undefined;
    let feature: ReciterFeature | undefined = anItem?.reCiterFeature;
    // Offloaded: the item exists but carries no inline reCiterFeature ⇒ S3.
    if (anItem && !feature) {
      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: ANALYSIS_BUCKET,
          Key: `AnalysisOutput/${uid}`,
        }),
      );
      const body = await obj.Body?.transformToString("utf-8");
      feature = body ? (JSON.parse(body) as ReciterFeature) : undefined;
    }

    return articleFeaturesToSuggestions(feature?.reCiterArticleFeatures ?? [], curated);
  } catch {
    // Timeout, non-2xx parse, network failure — degrade to hidden.
    return [];
  }
}

/**
 * Engine-API timeout for the suggested-articles read. `analysisRefreshFlag=false`
 * returns the CACHED analysis (no re-run), but the body can be a few MB — a
 * generous-but-bounded ceiling for a non-blocking, client-mounted nudge.
 */
export const SUGGESTED_ARTICLES_API_TIMEOUT_MS = 12_000;

/**
 * Source selector: when `RECITER_PENDING_SOURCE=api`, the reciter-pending route
 * reads suggestions from the ReCiter engine's Feature Generator API instead of
 * ReCiter's DynamoDB/S3. Used where the SPS task can reach the engine but NOT
 * the S3-offloaded Analysis object (the offloaded read fails silently → empty
 * nudge). Default off (DynamoDB/S3 source). Flag-parity: wired per-env in CDK.
 */
export function preferReciterApiSource(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RECITER_PENDING_SOURCE === "api";
}

/**
 * Pull `reCiterArticleFeatures` from the Feature Generator response, tolerating
 * its top-level shape (the engine returns the analysis either as the
 * reCiterFeature object, a wrapper carrying it, or a single-element list).
 */
function extractArticleFeatures(json: unknown): ReciterArticleFeature[] {
  if (Array.isArray(json)) return json.length ? extractArticleFeatures(json[0]) : [];
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj.reCiterArticleFeatures)) {
    return obj.reCiterArticleFeatures as ReciterArticleFeature[];
  }
  const rf = obj.reCiterFeature as Record<string, unknown> | undefined;
  if (rf && Array.isArray(rf.reCiterArticleFeatures)) {
    return rf.reCiterArticleFeatures as ReciterArticleFeature[];
  }
  return [];
}

/**
 * Engine-API source for the suggested-articles read. The Feature Generator
 * endpoint returns `reCiterArticleFeatures` IN the HTTP response, so it
 * sidesteps the S3-offloaded `Analysis` read that {@link fetchSuggestedArticles}
 * depends on (the SPS task can reach the engine but not the offloaded object —
 * the read otherwise degrades to an empty nudge). `analysisRefreshFlag=false`
 * returns the CACHED analysis fast — NEVER the heavy synchronous re-run.
 *
 * Without the live GoldStandard cross-check we filter on the per-article
 * `userAssertion` alone — ACCEPTED/REJECTED already encode prior curation, which
 * for a curated scholar matches the DynamoDB path exactly. Degrades to `[]` on
 * not-configured / non-2xx / timeout / parse error — this function NEVER throws.
 *
 * `opts.fetchImpl` injects a fake `fetch` for tests; production uses the global.
 */
export async function fetchSuggestedArticlesViaApi(
  uid: string,
  opts: { config?: ReciterApiConfig; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReciterSuggestion[]> {
  const config = opts.config ?? reciterApiConfig();
  if (!config) return [];
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const url = new URL("/reciter/feature-generator/by/uid", config.baseUrl);
    url.searchParams.set("uid", uid);
    // CRITICAL: false ⇒ return the cached analysis, never trigger the heavy
    // synchronous re-run (that is `runFeatureGenerator`'s job, off the request path).
    url.searchParams.set("analysisRefreshFlag", "false");

    const res = await doFetch(url, {
      method: "GET",
      headers: { "api-key": config.apiKey },
      signal: AbortSignal.timeout(opts.timeoutMs ?? SUGGESTED_ARTICLES_API_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return articleFeaturesToSuggestions(extractArticleFeatures(await res.json()));
  } catch {
    return [];
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
