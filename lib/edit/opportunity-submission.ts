/**
 * Opportunity URL intake — the SPS half of the manual funding-opportunity
 * submission round trip (`docs/opportunity-url-intake-spec.md`).
 *
 * Development-role staff submit a URL; SPS writes a `SUBMISSION` queue item to
 * the shared `reciterai` DynamoDB table and does nothing else — ALL processing
 * (fetch, extraction, denoise judge, topic scoring, prestige, persist as
 * `GRANT#manual_url:*`) happens upstream in ReciterAI's
 * `pipeline_grants.ingest_submissions` drain, so manual opportunities go
 * through the SAME scorer as the rest of the corpus and DynamoDB stays the
 * source of truth. Rows come back through the ordinary nightly `etl:dynamodb`
 * projection; the drain marks each item `processed` / `rejected` and this
 * module's Query surfaces that status on `/edit/find-researchers`.
 *
 * Key shape: every queue item shares the constant partition key `SUBMISSION`
 * with a time-ordered sort key (`<ISO ts>#<uuid8>`). One partition keeps the
 * list a single `Query` (newest-first via `ScanIndexForward: false`) AND lets
 * the task-role IAM grant pin `dynamodb:LeadingKeys` to exactly `SUBMISSION` —
 * a `Scan` could never be scoped that way, and `GRANT#` items stay unreachable
 * from the app credential (app-stack `TaskRoleOpportunitySubmissionPolicy`).
 *
 * The client mirrors `lib/cores/claim-writeback.ts` (SPS's first DynamoDB
 * write) — but unlike that best-effort mirror, the Put here IS the write the
 * user asked for, so failures propagate to the route as a 502.
 */
import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/** The shared ReciterAI table (same default as the ETL and the cores writeback). */
const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
/** ReciterAI's DynamoDB lives in us-east-1 regardless of the SPS region. */
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
/** An interactive submit/list must not hang the edit console. */
const DDB_TIMEOUT_MS = 5_000;

/** The constant partition key every submission shares (see module doc). */
export const SUBMISSION_PK = "SUBMISSION";

/** Master switch (default off) — gates the panel, both routes, and the Put. */
export function isOpportunityIntakeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.OPPORTUNITY_URL_INTAKE === "on";
}

// ---------------------------------------------------------------------------
// URL normalization + dedup
// ---------------------------------------------------------------------------

export type NormalizeUrlResult =
  | { ok: true; normalized: string }
  | { ok: false; error: "invalid_url" | "https_required" };

/** Tracking params that never distinguish one opportunity page from another. */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/;

/**
 * Canonicalize a submitted URL so the SAME page always yields the SAME string:
 * https-only, lowercased scheme+host, fragment and tracking params stripped,
 * trailing slash trimmed (except at the root). This is the dedup key against
 * both `opportunity.sourceUrl` (the projected corpus) and pending submissions —
 * corpus URLs are stored raw, so BOTH sides normalize at compare time.
 */
export function normalizeOpportunityUrl(raw: string): NormalizeUrlResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return { ok: false, error: "invalid_url" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "https_required" };
  url.hash = "";
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return { ok: true, normalized: url.toString() };
}

// ---------------------------------------------------------------------------
// Queue items
// ---------------------------------------------------------------------------

/**
 * `pending` / `processed` / `rejected` are written by the drain round trip;
 * `suppressed` is SPS-written (an accidental submission the team retracted
 * AFTER processing — see {@link suppressSubmission}). A pending/rejected
 * mistake is simply deleted ({@link deleteSubmission}), so it never needs a
 * status of its own.
 */
export type SubmissionStatus = "pending" | "processed" | "rejected" | "suppressed";

/** The `SUBMISSION` item contract shared with ReciterAI's drain (spec §5/§6). */
export interface OpportunitySubmission {
  /** The sort key — doubles as the submission id everywhere (audit, API, UI). */
  submissionId: string;
  url: string;
  normalizedUrl: string;
  note: string | null;
  submittedBy: string;
  submittedAt: string;
  status: SubmissionStatus;
  processedAt: string | null;
  producedOpportunityIds: string[];
  rejectReason: string | null;
}

/** The minimal `.send()` surface this module uses; injectable for tests. */
export interface SubmissionDdbClient {
  send(
    command: PutCommand | QueryCommand | DeleteCommand | UpdateCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ Items?: Record<string, unknown>[] }>;
}

let ddbSingleton: SubmissionDdbClient | undefined;
function defaultDdb(): SubmissionDdbClient {
  if (!ddbSingleton) {
    ddbSingleton = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    ) as unknown as SubmissionDdbClient;
  }
  return ddbSingleton;
}

/**
 * Append one pending submission. The sort key is time-prefixed so the list
 * Query is naturally newest-first; the condition expression turns a (already
 * astronomically unlikely) key collision into a loud failure instead of a
 * silent overwrite. Throws on any DynamoDB failure — the route maps it to 502.
 */
export async function putSubmission(
  input: { url: string; normalizedUrl: string; note: string | null; submittedBy: string },
  opts: { ddb?: SubmissionDdbClient; now?: Date } = {},
): Promise<OpportunitySubmission> {
  const ddb = opts.ddb ?? defaultDdb();
  const now = opts.now ?? new Date();
  const submissionId = `${now.toISOString()}#${randomUUID().slice(0, 8)}`;
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: SUBMISSION_PK,
        SK: submissionId,
        url: input.url,
        normalized_url: input.normalizedUrl,
        note: input.note,
        submitted_by: input.submittedBy,
        submitted_at: now.toISOString(),
        status: "pending",
      },
      ConditionExpression: "attribute_not_exists(SK)",
    }),
    { abortSignal: AbortSignal.timeout(DDB_TIMEOUT_MS) },
  );
  return {
    submissionId,
    url: input.url,
    normalizedUrl: input.normalizedUrl,
    note: input.note,
    submittedBy: input.submittedBy,
    submittedAt: now.toISOString(),
    status: "pending",
    processedAt: null,
    producedOpportunityIds: [],
    rejectReason: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Defensive read-side mapping — one raw `SUBMISSION` item → the contract shape. */
function mapSubmissionItem(item: Record<string, unknown>): OpportunitySubmission {
  const status = item.status;
  return {
    submissionId: asString(item.SK) ?? "",
    url: asString(item.url) ?? "",
    normalizedUrl: asString(item.normalized_url) ?? "",
    note: asString(item.note),
    submittedBy: asString(item.submitted_by) ?? "",
    submittedAt: asString(item.submitted_at) ?? "",
    status:
      status === "processed" || status === "rejected" || status === "suppressed"
        ? status
        : ("pending" as const),
    processedAt: asString(item.processed_at),
    producedOpportunityIds: Array.isArray(item.produced_opportunity_ids)
      ? item.produced_opportunity_ids.filter((id): id is string => typeof id === "string")
      : [],
    rejectReason: asString(item.reject_reason),
  };
}

/**
 * All submissions, newest-first (the SK is ISO-time-prefixed, so key order IS
 * time order). The queue is human-paced — a page of 200 covers years; no
 * pagination until reality disagrees.
 */
export async function listSubmissions(
  opts: { ddb?: SubmissionDdbClient } = {},
): Promise<OpportunitySubmission[]> {
  const ddb = opts.ddb ?? defaultDdb();
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": SUBMISSION_PK },
      ScanIndexForward: false,
      Limit: 200,
    }),
    { abortSignal: AbortSignal.timeout(DDB_TIMEOUT_MS) },
  );
  return (result.Items ?? []).map(mapSubmissionItem);
}

/**
 * One submission by its sort key — a targeted Query (not GetItem) so the read
 * stays inside the existing `dynamodb:Query` + `LeadingKeys=SUBMISSION` IAM
 * pin. `null` when no such item exists.
 */
export async function getSubmission(
  submissionId: string,
  opts: { ddb?: SubmissionDdbClient } = {},
): Promise<OpportunitySubmission | null> {
  const ddb = opts.ddb ?? defaultDdb();
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": SUBMISSION_PK, ":sk": submissionId },
      Limit: 1,
    }),
    { abortSignal: AbortSignal.timeout(DDB_TIMEOUT_MS) },
  );
  const item = (result.Items ?? [])[0];
  return item ? mapSubmissionItem(item) : null;
}

/**
 * `true` when a DynamoDB write was refused by its `ConditionExpression` — the
 * route maps this to a `409` (the drain raced us and changed the status, or
 * the item vanished) rather than a `502`.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/**
 * Hard-delete an accidental submission that the pipeline has NOT consumed —
 * status `pending` or `rejected` only, enforced atomically by the condition
 * expression (the route pre-checks too, but the drain may process an item
 * between that read and this write). A `processed` item must be
 * {@link suppressSubmission}-ed instead: its produced `GRANT#` rows exist and
 * need the drain's cooperation to retract.
 */
export async function deleteSubmission(
  submissionId: string,
  opts: { ddb?: SubmissionDdbClient } = {},
): Promise<void> {
  const ddb = opts.ddb ?? defaultDdb();
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: SUBMISSION_PK, SK: submissionId },
      ConditionExpression: "attribute_exists(SK) AND #s IN (:pending, :rejected)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":pending": "pending", ":rejected": "rejected" },
    }),
    { abortSignal: AbortSignal.timeout(DDB_TIMEOUT_MS) },
  );
}

/**
 * Retract a PROCESSED submission: set `status = 'suppressed'` on the
 * `SUBMISSION` item (never a delete — the item is the retraction's record).
 * ReciterAI's drain companion honors `suppressed` by removing the
 * `GRANT#manual_url:*` items this submission produced (separate ReciterAI PR,
 * in flight), and the vanished rows fall out of SPS on the next nightly
 * projection. Condition-pinned to `processed` so a double-suppress or a
 * pending item can't take this path.
 */
export async function suppressSubmission(
  submissionId: string,
  input: { suppressedBy: string },
  opts: { ddb?: SubmissionDdbClient; now?: Date } = {},
): Promise<void> {
  const ddb = opts.ddb ?? defaultDdb();
  const now = opts.now ?? new Date();
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: SUBMISSION_PK, SK: submissionId },
      UpdateExpression: "SET #s = :suppressed, suppressed_at = :at, suppressed_by = :by",
      ConditionExpression: "attribute_exists(SK) AND #s = :processed",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":suppressed": "suppressed",
        ":processed": "processed",
        ":at": now.toISOString(),
        ":by": input.suppressedBy,
      },
    }),
    { abortSignal: AbortSignal.timeout(DDB_TIMEOUT_MS) },
  );
}

// ---------------------------------------------------------------------------
// Duplicate detection (spec §7 — submit-time layer)
// ---------------------------------------------------------------------------

export interface DuplicateCheckResult {
  /** A corpus row already carries this URL (any source). */
  opportunity: { opportunityId: string; title: string } | null;
  /** A queue item (pending or processed) already carries this URL. */
  submission: { submissionId: string; status: SubmissionStatus } | null;
}

/**
 * Compare a normalized URL against the projected corpus and the existing queue.
 * Corpus URLs are stored raw → normalize each at compare time (the corpus is
 * ~900 rows; in-process is fine). A `rejected` submission does NOT block — the
 * whole point of a rejection reason is fixing and resubmitting. Neither does a
 * `suppressed` one: suppression means "this was a mistake", and a later
 * DELIBERATE submission of the same URL must stay possible. (Until the drain
 * removes the suppressed items' `GRANT#` rows and the nightly projection
 * catches up, the corpus check above still 409s — a transient, honest window.)
 */
export function findDuplicate(
  normalizedUrl: string,
  corpus: ReadonlyArray<{ opportunityId: string; title: string; sourceUrl: string }>,
  submissions: ReadonlyArray<OpportunitySubmission>,
): DuplicateCheckResult {
  let opportunity: DuplicateCheckResult["opportunity"] = null;
  for (const row of corpus) {
    const normalized = normalizeOpportunityUrl(row.sourceUrl);
    if (normalized.ok && normalized.normalized === normalizedUrl) {
      opportunity = { opportunityId: row.opportunityId, title: row.title };
      break;
    }
  }
  const match = submissions.find(
    (s) =>
      s.status !== "rejected" && s.status !== "suppressed" && s.normalizedUrl === normalizedUrl,
  );
  return {
    opportunity,
    submission: match ? { submissionId: match.submissionId, status: match.status } : null,
  };
}
