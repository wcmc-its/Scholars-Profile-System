/**
 * #1609 — "Grants for me" feedback vocabulary + the pure list transform.
 *
 * A scholar can Save a recommendation (pinned to the top of the list + badged)
 * or mark it Not relevant (dropped from their list), each reversible. Rows live
 * in `grant_rec_feedback` (one per scholar × opportunity); the write route is
 * `POST /api/edit/grant-recs/feedback`, the read route the matching GET.
 *
 * Client-safe: no DB / server imports, so the card and the routes share one
 * vocabulary.
 */

export const GRANT_REC_FEEDBACK_STATUSES = ["saved", "not_relevant"] as const;
export type GrantRecFeedbackStatus = (typeof GRANT_REC_FEEDBACK_STATUSES)[number];

/** Optional "why" on Not relevant. One per matcher axis a miss can come from
 *  (topic, eligibility, career stage) plus a catch-all, so the labels can be
 *  read straight back against the axis weights they are meant to calibrate. */
export const NOT_RELEVANT_REASONS = ["off_topic", "not_eligible", "wrong_stage", "other"] as const;
export type NotRelevantReason = (typeof NOT_RELEVANT_REASONS)[number];

export const NOT_RELEVANT_REASON_LABELS: Record<NotRelevantReason, string> = {
  off_topic: "Not my research area",
  not_eligible: "I'm not eligible",
  wrong_stage: "Wrong career stage",
  other: "Other",
};

export function isFeedbackStatus(v: unknown): v is GrantRecFeedbackStatus {
  return typeof v === "string" && (GRANT_REC_FEEDBACK_STATUSES as readonly string[]).includes(v);
}

export function isNotRelevantReason(v: unknown): v is NotRelevantReason {
  return typeof v === "string" && (NOT_RELEVANT_REASONS as readonly string[]).includes(v);
}

/** One live feedback entry as the GET route returns it. */
export type GrantRecFeedbackEntry = {
  opportunityId: string;
  status: GrantRecFeedbackStatus;
  reason: NotRelevantReason | null;
  updatedAt: string;
};

/** opportunityId → status. */
export type FeedbackMap = ReadonlyMap<string, GrantRecFeedbackStatus>;

/** How many results to request so the list is still full after the scholar's
 *  Not-relevant items are dropped (the route caps `limit` at 100). */
export function overfetchLimit(limit: number, feedback: FeedbackMap, max = 100): number {
  let hidden = 0;
  for (const s of feedback.values()) if (s === "not_relevant") hidden++;
  return Math.min(max, limit + hidden);
}

/**
 * Pure: apply a scholar's feedback to a ranked list. Not-relevant items are
 * removed; saved items move to the top (stable — they keep their relative rank,
 * as do the rest); the result is cut to `limit`. Every other item and the
 * server's ordering are untouched, so with no feedback this is the identity
 * (up to `limit`).
 */
export function applyGrantRecFeedback<T extends { opportunityId: string }>(
  results: readonly T[],
  feedback: FeedbackMap,
  limit: number = Number.POSITIVE_INFINITY,
): T[] {
  const saved: T[] = [];
  const rest: T[] = [];
  for (const r of results) {
    const s = feedback.get(r.opportunityId);
    if (s === "not_relevant") continue;
    (s === "saved" ? saved : rest).push(r);
  }
  return [...saved, ...rest].slice(0, limit);
}
