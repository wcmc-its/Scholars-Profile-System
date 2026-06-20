/**
 * Per-cwid rate limit for the "Request a change" server send (#160 Phase 2,
 * `docs/self-edit-request-change-modal.md` § 5 abuse controls; threat model
 * § 6 — *spam/volume*).
 *
 * A fixed UTC-hour window keyed on `(cwid, window_start)` in the main-schema
 * `request_change_rate_limit` table. The increment is a single
 * `INSERT ... ON DUPLICATE KEY UPDATE count = count + 1`, which serializes on
 * the primary-key row lock and is genuinely atomic. Prisma's `upsert` is NOT a
 * native atomic upsert on MySQL — it is a read-then-write (find, then create or
 * update), so two concurrent requests for the same cwid can both miss the read
 * and double-count. That race is exactly the adversary here (a spam loop may
 * fire in parallel, and a round-robined client across ECS tasks certainly can),
 * so the hot path is raw SQL, not `upsert`.
 *
 * The follow-up keyed `SELECT` reads at least this request's own increment
 * (the counter is monotonic within a window), so the requester is never
 * under-counted; at worst a concurrent increment makes the observed count
 * higher, which only makes a 429 *more* likely — the conservative direction.
 *
 * Per-hour, not per-day, so a false positive on a real scholar self-clears
 * within the hour rather than locking them out for most of a day. The limit is
 * env-tunable (`SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT`), starting generous so it
 * is a hypothesis tuned from the 429 logs: lowering a too-high cap is free,
 * raising a too-low one only happens after a real user is turned away.
 */
import { db } from "@/lib/db";

const WINDOW_MS = 60 * 60 * 1000; // one hour
/** Generous default — a scholar cleaning up a neglected profile may legitimately
 *  file a dozen-plus corrections in one focused session; superusers are exempt
 *  upstream (route). Ratchet from the 429 logs, not from a guess. */
const DEFAULT_LIMIT = 20;

/** Default per-cwid hourly cap for an overview-generate (#742). Lower than the
 *  request-change default: a generation is an LLM call (cost), and a scholar
 *  rarely needs to redraft their bio a dozen times an hour. Env-tunable. */
const DEFAULT_OVERVIEW_GENERATE_LIMIT = 10;

/** Default per-cwid hourly cap for a NIH-biosketch generate (#917 v5). Same
 *  reasoning as the overview cap — an LLM call (cost), and a scholar rarely
 *  needs to redraft their biosketch a dozen times an hour. Env-tunable. */
export const DEFAULT_BIOSKETCH_GENERATE_LIMIT = 10;

/** The per-cwid hourly cap. Reads `SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT`; falls
 *  back to {@link DEFAULT_LIMIT} when unset or not a positive integer. */
export function requestChangeRateLimit(): number {
  const raw = Number(process.env.SELF_EDIT_REQUEST_CHANGE_RATE_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/** The per-cwid hourly overview-generate cap (#742). Reads
 *  `SELF_EDIT_OVERVIEW_GENERATE_RATE_LIMIT`; falls back to
 *  {@link DEFAULT_OVERVIEW_GENERATE_LIMIT} when unset or not a positive integer. */
export function overviewGenerateRateLimit(): number {
  const raw = Number(process.env.SELF_EDIT_OVERVIEW_GENERATE_RATE_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_OVERVIEW_GENERATE_LIMIT;
}

/** The per-cwid hourly NIH-biosketch-generate cap (#917 v5). Reads
 *  `EDIT_BIOSKETCH_GENERATE_RATE_LIMIT`; falls back to
 *  {@link DEFAULT_BIOSKETCH_GENERATE_LIMIT} when unset or not a positive integer. */
export function biosketchGenerateRateLimit(): number {
  const raw = Number(process.env.EDIT_BIOSKETCH_GENERATE_RATE_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_BIOSKETCH_GENERATE_LIMIT;
}

/** Start of the UTC hour-window containing `now` (epoch-floored, so the boundary
 *  is timezone-independent). */
function windowStartFor(now: Date): Date {
  return new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
}

export type RateLimitResult =
  | { allowed: true; count: number; limit: number }
  | { allowed: false; count: number; limit: number; retryAfterSeconds: number };

/**
 * The shared atomic increment-and-check, keyed on `(key, window_start)`. Both
 * the request-change and overview-generate limiters route through this so the
 * one genuinely-atomic `INSERT ... ON DUPLICATE KEY UPDATE` lives in exactly
 * one place. `key` is the `cwid` column value (VarChar(32)); callers namespace
 * it (e.g. `ovgen:${cwid}`) to keep the two limiters' buckets disjoint while
 * sharing the table.
 */
async function recordAttempt(key: string, limit: number, now: Date): Promise<RateLimitResult> {
  const windowStart = windowStartFor(now);

  await db.write.$executeRaw`
    INSERT INTO \`request_change_rate_limit\` (\`cwid\`, \`window_start\`, \`count\`)
    VALUES (${key}, ${windowStart}, 1)
    ON DUPLICATE KEY UPDATE \`count\` = \`count\` + 1`;

  const rows = await db.write.$queryRaw<{ count: number | bigint }[]>`
    SELECT \`count\` FROM \`request_change_rate_limit\`
    WHERE \`cwid\` = ${key} AND \`window_start\` = ${windowStart}`;
  const count = Number(rows[0]?.count ?? 1);

  if (count > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000),
    );
    return { allowed: false, count, limit, retryAfterSeconds };
  }
  return { allowed: true, count, limit };
}

/**
 * Atomically count this cwid's attempt in the current window and report whether
 * it is within the limit. Called once per send attempt, before the send, so the
 * count gates the send. A blocked request still consumed its increment (the
 * window is fixed by start, so this does not extend the lockout).
 */
export async function recordRequestChangeAttempt(
  cwid: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  return recordAttempt(cwid, requestChangeRateLimit(), now);
}

/**
 * Per-cwid hourly rate limit for the overview-generate gateway call (#742). The
 * same fixed-window mechanism, in its own bucket — the key is namespaced
 * `ovgen:${cwid}` so generations never share a counter with request-change
 * sends. The namespaced key fits the `cwid` VarChar(32) column.
 */
export async function recordOverviewGenerateAttempt(
  cwid: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  return recordAttempt(`ovgen:${cwid}`, overviewGenerateRateLimit(), now);
}

/**
 * Per-cwid hourly rate limit for the NIH-biosketch-generate gateway call
 * (#917 v5). The same fixed-window mechanism, in its own bucket — the key is
 * namespaced `biosketch:${cwid}` so biosketch generations never share a counter
 * with overview generations or request-change sends. The namespaced key fits the
 * `cwid` VarChar(32) column.
 */
export async function recordBiosketchGenerateAttempt(
  cwid: string,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  return recordAttempt(`biosketch:${cwid}`, biosketchGenerateRateLimit(), now);
}
