/**
 * Server-side duplicate-content guard for feedback submissions
 * (#538, docs/feedback-badge-spec.md § Anti-spam).
 *
 * Catches the most common spam shape — someone hitting "Submit" 50
 * times with the same text — without the storage + identity-fingerprint
 * cost of a real per-IP rate-limit. The lightweight v1 trade-off is:
 *
 *   - We compare the FINAL post-sanitization text against the same
 *     column in any submission within the last hour
 *   - On match, the API route returns a silent `{ok:true}` with no
 *     INSERT (mirroring the honeypot pattern — telling a spammer they
 *     were caught trains them to vary input)
 *   - Pure-metric submissions (Likerts + role, all four textareas
 *     null) are NOT deduped — a thousand "useful=5, role=faculty"
 *     rows are not the spam pattern we target here
 *
 * Scope: the four conditional textareas only (`whatHelped`,
 * `whatMissing`, `oneChange`, `taskFailureIntent`). The shorter
 * `purpose_other` (200) and `role_other` (100) fields are excluded —
 * they are unlikely spam vehicles (free-text alternatives to enum
 * picks, not the canvas a spammer would use). If abuse appears in
 * those columns later, this helper is the natural place to extend.
 *
 * If dedup alone proves insufficient against sustained abuse, the
 * SPEC names **option (B)** — a per-IP daily cap backed by a small
 * `FeedbackRateLimit` table — as the next escalation. Schema is
 * additive-compatible; adding (B) does not invalidate this helper.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** Match-window in minutes. An hour is generous enough that legitimate
 *  users repeating themselves are unaffected, narrow enough that
 *  identical-text spam in a single sitting is caught. */
export const DEDUP_WINDOW_MINUTES = 60;

export interface DedupCandidate {
  whatHelped: string | null;
  whatMissing: string | null;
  oneChange: string | null;
  taskFailureIntent: string | null;
}

/**
 * Returns `true` when any non-null text field on `candidate` matches
 * the same column on an existing row within the dedup window. Returns
 * `false` when there's nothing to check (every text field is null) so
 * the caller can fast-path past the DB round-trip on metric-only rows.
 *
 * Pass `now` for deterministic testing.
 */
export async function isDuplicateSubmission(
  db: Pick<PrismaClient, "feedbackSubmission">,
  candidate: DedupCandidate,
  now: Date = new Date(),
): Promise<boolean> {
  const clauses: Array<Record<string, string>> = [];
  if (candidate.whatHelped) clauses.push({ whatHelped: candidate.whatHelped });
  if (candidate.whatMissing) clauses.push({ whatMissing: candidate.whatMissing });
  if (candidate.oneChange) clauses.push({ oneChange: candidate.oneChange });
  if (candidate.taskFailureIntent) {
    clauses.push({ taskFailureIntent: candidate.taskFailureIntent });
  }
  if (clauses.length === 0) return false;

  const cutoff = new Date(now.getTime() - DEDUP_WINDOW_MINUTES * 60 * 1000);

  const match = await db.feedbackSubmission.findFirst({
    where: {
      submittedAt: { gte: cutoff },
      OR: clauses,
    },
    select: { id: true },
  });
  return match !== null;
}
