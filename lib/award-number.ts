/**
 * Parse an NIH award number into its mechanism (activity code), funding
 * Institute/Center (NIH IC), and serial. Used by the InfoEd ETL to
 * populate `Grant.mechanism` and `Grant.nihIc` (issue #78 F2), and by the
 * Funding result row to render mechanism + IC pills.
 *
 * NIH award numbers follow the pattern (with optional support flag,
 * dashes, and suffix variants):
 *
 *   [<flag>]?<activity-code> <IC-prefix><serial>[-<seq>][<suffix>]
 *
 * Examples:
 *   "R01 CA245678"            → mechanism R01, IC CA (NCI), serial 245678
 *   "1R01CA245678-01A1"       → mechanism R01, IC CA, serial 245678
 *   "K23 HL157640"            → mechanism K23, IC HL (NHLBI), serial 157640
 *   "U01 AI234567"            → mechanism U01, IC AI (NIAID), serial 234567
 *   "UG3 AG098024"            → mechanism UG3, IC AG (NIA),   serial 098024
 *   "S10 OD030447"            → mechanism S10, IC OD (OD),    serial 030447
 *
 * Non-NIH award numbers ("OCRA-2024-091", "AZ-OVA-8472") return null for
 * each component.
 */

import { NIH_INSTITUTE_BY_PREFIX } from "@/lib/nih-ic-prefixes";

export interface ParsedAward {
  mechanism: string | null;
  nihIc: string | null;
  serial: string | null;
}

const EMPTY: ParsedAward = { mechanism: null, nihIc: null, serial: null };

/** Activity code: 1 letter + 2 alphanumerics (R01, K23, UG3, U2C, S10,
 *  DP1, etc.). May be preceded by an optional support-type digit. Then
 *  2-letter IC prefix + 6/7-digit serial, with optional dash-separated
 *  sequence/suffix. */
const NIH_AWARD_RE = /^\s*[1-9]?\s*([A-Z][A-Z0-9][A-Z0-9])\s*([A-Z]{2})\s*(\d{6,7})(?:[-\s][\w]+)?\s*$/i;

export function parseNihAward(awardNumber: string | null | undefined): ParsedAward {
  if (!awardNumber) return EMPTY;
  const m = awardNumber.trim().match(NIH_AWARD_RE);
  if (!m) return EMPTY;
  const mechanism = m[1].toUpperCase();
  const prefix = m[2].toUpperCase();
  const serial = m[3];
  const ic = NIH_INSTITUTE_BY_PREFIX[prefix] ?? null;
  return { mechanism, nihIc: ic, serial };
}

/** True when the award number parses as an NIH award. Convenience for
 *  ETL filtering and tests. */
export function isNihAwardNumber(awardNumber: string | null | undefined): boolean {
  return parseNihAward(awardNumber).mechanism !== null;
}
