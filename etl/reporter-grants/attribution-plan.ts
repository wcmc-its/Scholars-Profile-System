/**
 * #3071 — what the RePORTER grant ETL does to one award, given the scorer's
 * band and what is already recorded about it. Pure: `index.ts` gathers the
 * state, calls `planAward`, and applies the plan in its per-scholar
 * transaction.
 *
 * Invariants the plan holds, in order of precedence:
 *   1. A curator decision (confirmed / rejected) is never overridden: the plan
 *      changes no suppression. It may REOPEN the review, and only when the new
 *      band contradicts the decision AND the evidence differs from what the
 *      curator saw.
 *   2. A system-unverified hide a PERSON revoked is never re-minted, and a
 *      pending review on it is withdrawn (the person already decided).
 *   3. A hide the ETL itself revoked (`SYSTEM_RESCORED`) may be minted again.
 *   4. The ETL revokes its own hide only when `allowRevoke`, which the caller
 *      clears whenever a negative cue source is unavailable: missing evidence
 *      against an award must never lift a hide.
 *   5. queue keeps the award hidden: a queued award always has an active hide
 *      (minted now if needed) next to its pending review.
 */
import type { AttributionBand } from "./score";

/** `suppression.revoked_by` for a revoke the ETL made because the scorer now
 *  says show. Distinct from any person's cwid, so a human revoke is never
 *  mistaken for it. */
export const SYSTEM_RESCORED = "system-rescored";

export type ReviewStatus = "pending" | "confirmed" | "rejected" | "withdrawn";

export interface AwardState {
  /** The active system-unverified suppression on this award, if any. */
  activeHideId: string | null;
  /** A system-unverified suppression on this award was revoked by a person. */
  humanRevoked: boolean;
  review: { status: ReviewStatus; evidenceKey: string } | null;
}

export interface AwardPlan {
  mintHide: boolean;
  /** Revoke this suppression id as SYSTEM_RESCORED. */
  revokeHideId: string | null;
  /** create / refresh: write the pending review (insert / update in place).
   *  reopen: move a decided or withdrawn review back to pending.
   *  withdraw: close a pending review the ETL settled on its own. */
  review: "none" | "create" | "refresh" | "reopen" | "withdraw";
}

const NOTHING: AwardPlan = { mintHide: false, revokeHideId: null, review: "none" };

export function planAward(
  band: AttributionBand,
  state: AwardState,
  newEvidenceKey: string,
  allowRevoke: boolean,
): AwardPlan {
  const r = state.review;

  // 1. Curator decisions stand.
  if (r && (r.status === "confirmed" || r.status === "rejected")) {
    const contradicts =
      (r.status === "confirmed" && band === "hide") || (r.status === "rejected" && band === "show");
    return contradicts && r.evidenceKey !== newEvidenceKey ? { ...NOTHING, review: "reopen" } : NOTHING;
  }

  // 2. A person surfaced it by hand.
  if (state.humanRevoked) {
    return r?.status === "pending" ? { ...NOTHING, review: "withdraw" } : NOTHING;
  }

  const pending = r?.status === "pending";
  if (band === "hide") {
    return { mintHide: state.activeHideId === null, revokeHideId: null, review: pending ? "withdraw" : "none" };
  }
  if (band === "queue") {
    return {
      mintHide: state.activeHideId === null,
      revokeHideId: null,
      review: r === null ? "create" : pending ? "refresh" : "reopen",
    };
  }
  // band === "show"
  if (state.activeHideId !== null) {
    if (!allowRevoke) return NOTHING;
    return { mintHide: false, revokeHideId: state.activeHideId, review: pending ? "withdraw" : "none" };
  }
  return pending ? { ...NOTHING, review: "withdraw" } : NOTHING;
}
