/**
 * COI-gap suggestion feedback — the 3-way reason a scholar (or, on their behalf,
 * a genuine superuser) records on a publication-derived suggestion.
 *
 * PURE SIGNAL: recording a reason stops the nag (the row drops off the panel —
 * see `lib/api/edit-context.ts`) and feeds suggestion-quality research. It
 * triggers no workflow, no reminder, and no Weill Research Gateway hand-off.
 *
 * The reason is captured ALONGSIDE `CoiGapCandidate.status`, not in place of it:
 *   - `will_disclose` — the scholar AFFIRMS the relationship and intends to add
 *     it to their COI statement → status `acknowledged` (the gap then closes
 *     itself as `resolved` once the disclosure appears).
 *   - `historical` — true in the past but not a current conflict → status
 *     `dismissed` (don't re-nag), reason `historical`.
 *   - `invalid` — not a valid suggestion (a false positive) → status
 *     `dismissed`, reason `invalid`.
 *
 * Splitting `historical` from `invalid` is the whole point: it lets a paper
 * separate temporally-stale-but-real extractions from model false positives, so
 * extraction precision = (will_disclose + historical) / reviewed. See
 * `docs/coi-gap-feedback-spec.md`.
 */
import type { CandidateStatus } from "@/lib/coi-gap/lifecycle";

export const FEEDBACK_REASONS = ["will_disclose", "historical", "invalid"] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** Narrow an untrusted request value to a known feedback reason. */
export function isFeedbackReason(value: unknown): value is FeedbackReason {
  return typeof value === "string" && (FEEDBACK_REASONS as readonly string[]).includes(value);
}

/**
 * The `status` a feedback reason persists. `will_disclose` affirms the
 * relationship (`acknowledged`); the two negatives both `dismissed` (never
 * re-nag). The reason itself is stored separately in `feedback_reason`.
 */
export function statusForReason(reason: FeedbackReason): CandidateStatus {
  return reason === "will_disclose" ? "acknowledged" : "dismissed";
}
