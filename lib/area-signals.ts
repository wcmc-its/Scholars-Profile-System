/**
 * Grants and clinical trials as research-area signals: which rows count.
 *
 * Pure (no Prisma, no node built-ins) so both halves of the feature share ONE
 * definition: etl/area-signal-inputs decides which texts are sent to ReciterAI
 * for area scoring, and the topic ranking (lib/api/topics.ts) re-applies the
 * same predicate at read time. A forked copy would be a grant that is scored
 * but never counted, or counted on a stale score.
 *
 * Every rule below is ported from the 2026-10-14 pilot builder (Gate 2 passed
 * for "option A": grants and trials re-rank scholars who already have papers in
 * an area, never add them). Regexes are the pilot's verbatim; do not widen or
 * "tidy" them without a new review round, since the review marks they were
 * tuned against are the only evidence for them.
 */
import { isHiddenTrialStatus } from "@/lib/clinical-trial-status";

/** Grants and trials count from this start date on (the publication carve's year floor). */
export const AREA_SIGNAL_START_DATE = "2020-01-01";

/**
 * InfoEd rows only. RePORTER-materialized rows carry the wrong-person matches
 * the pilot review found (issue #3071); revisit when that is fixed.
 */
export const AREA_GRANT_SOURCE = "InfoEd";

/** Leadership roles only, mirroring the first/last-author rule for papers. */
export const AREA_GRANT_ROLES: readonly string[] = ["PI", "PI-Subaward", "Co-PI"];

/**
 * A non-NIH row (no mechanism) qualifies only under one of these program
 * types; Training and Fellowship are then dropped again by the training rule
 * below. Kept as two steps because that is how the pilot built it.
 */
const PROGRAM_TYPES_WITHOUT_MECHANISM = new Set(["Grant", "Career", "Training", "Fellowship"]);

/** Fellowships, institutional training and program awards (pilot "training" fix). */
const TRAINING_MECHANISM = /^(F\d|T\d|TL1|K12|KL2|R25|D43|R90)/;
const TRAINING_PROGRAM_TYPES = new Set(["Training", "Fellowship"]);
const TRAINING_TITLE = /fellowship|training (grant|program)|development program|scholars? program/i;

/** Conference and meeting grants, PSDP-style scholar awards (pilot "hygiene" fix). */
const CONFERENCE_MECHANISM = /^(R13|U13)/;
const CONFERENCE_TITLE = /annual meeting|conference|summit|symposium|workshop|congress|\bPSDP\b|\(scholar:/i;

/** A grant abstract at least this long is synopsized; shorter text is scored title-first. */
export const AREA_GRANT_FULL_TEXT_MIN_CHARS = 200;

/** The only PersonClinicalTrial role that gets credit. */
export const AREA_TRIAL_PI_ROLE = "Principal Investigator";

export type AreaGrantCandidate = {
  source: string;
  role: string;
  startDate: Date;
  title: string;
  mechanism: string | null;
  programType: string | null;
};

/**
 * Whether one `Grant` row can be an area signal, on its own fields. Suppression
 * and the scholar's `hideFunding` override are applied by the callers, which
 * hold those reads.
 */
export function isEligibleAreaGrant(g: AreaGrantCandidate): boolean {
  if (g.source !== AREA_GRANT_SOURCE) return false;
  if (!AREA_GRANT_ROLES.includes(g.role)) return false;
  if (g.startDate.getTime() < Date.parse(`${AREA_SIGNAL_START_DATE}T00:00:00Z`)) return false;
  const mechanism = (g.mechanism ?? "").toUpperCase();
  if (!g.mechanism && !PROGRAM_TYPES_WITHOUT_MECHANISM.has(g.programType ?? "")) return false;
  if (CONFERENCE_MECHANISM.test(mechanism) || CONFERENCE_TITLE.test(g.title)) return false;
  if (
    TRAINING_MECHANISM.test(mechanism) ||
    TRAINING_PROGRAM_TYPES.has(g.programType ?? "") ||
    TRAINING_TITLE.test(g.title)
  ) {
    return false;
  }
  return true;
}

export type AreaTrialCandidate = {
  nctNumber: string | null;
  /** CT.gov start date as stored: "YYYY-MM" or "YYYY-MM-DD". */
  startDate: string | null;
  status: string | null;
};

/**
 * Whether one `ClinicalTrial` can be an area signal: NCT-registered (only those
 * carry the CT.gov summary, conditions and interventions), started 2020 or
 * later, and not in a status the profile hides. The PI role is a property of
 * the person row, checked by the callers.
 */
export function isEligibleAreaTrial(t: AreaTrialCandidate): boolean {
  if (!t.nctNumber || !t.nctNumber.trim()) return false;
  const start = (t.startDate ?? "").trim();
  if (!/^\d{4}/.test(start) || start.slice(0, 4) < AREA_SIGNAL_START_DATE.slice(0, 4)) return false;
  return !isHiddenTrialStatus(t.status);
}
