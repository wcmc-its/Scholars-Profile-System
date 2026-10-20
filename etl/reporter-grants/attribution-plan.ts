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
 *      curator saw. A review reopened from a decision stays pending, with the
 *      curator's last decision still in force, until a curator decides again:
 *      later runs only refresh its score, never withdraw it or touch a hide.
 *   2. A system-unverified hide a PERSON revoked is never re-minted, and a
 *      pending review on it is withdrawn (the person already decided).
 *   3. A hide the ETL itself revoked (`SYSTEM_RESCORED`) may be minted again.
 *   4. The ETL revokes its own hide only when `allowRevoke`, which the caller
 *      clears whenever a negative cue source is unavailable, run-wide
 *      (`attributionGate`) or for this award (`buildAwardEvidence`'s
 *      `revocable`): missing evidence against an award must never lift a hide.
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
  review: {
    status: ReviewStatus;
    evidenceKey: string;
    /** Pending again after the ETL reopened a CURATOR decision (the decision
     *  fields are kept on the row; see `isReopenedFromDecision`). */
    reopenedFromDecision?: boolean;
  } | null;
}

/** A pending review whose decision fields still name a person: the ETL
 *  reopened a curator's decision. A withdrawn review the ETL re-queues carries
 *  `SYSTEM_RESCORED` (or nothing) there instead. */
export function isReopenedFromDecision(row: {
  status: string;
  decidedByCwid: string | null;
}): boolean {
  return row.status === "pending" && row.decidedByCwid !== null && row.decidedByCwid !== SYSTEM_RESCORED;
}

/**
 * Run-wide gate: may the ETL score at all, and may it revoke? Scoring needs
 * InfoEd (the dedup floor and cue 1): an empty read is a degraded one, never
 * "no other WCM holder". Revoking also needs every other negative source run-
 * wide: the ReCiter rejection mirror (cue 2) and the education read (cue 3).
 * Pure; the counts are of the rows `index.ts` loaded.
 */
export function attributionGate(counts: {
  infoedRows: number;
  educationRows: number;
  rejectedRows: number;
}): { score: boolean; allowRevoke: boolean; warnings: string[] } {
  if (counts.infoedRows === 0) {
    return {
      score: false,
      allowRevoke: false,
      warnings: ["InfoEd returned no rows; scoring skipped this run."],
    };
  }
  const warnings: string[] = [];
  if (counts.rejectedRows === 0) {
    warnings.push(
      "no ReCiter rejections mirrored yet (etl:reciter); the rejected-papers cue is off and no hide is revoked this run.",
    );
  }
  if (counts.educationRows === 0) {
    warnings.push("education returned no rows; the timeline cue is off and no hide is revoked this run.");
  }
  return { score: true, allowRevoke: warnings.length === 0, warnings };
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

  // 1b. Reopened from a decision: waiting on a curator. Refresh the card only.
  if (r?.status === "pending" && r.reopenedFromDecision) {
    return { ...NOTHING, review: "refresh" };
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
