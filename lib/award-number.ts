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

/** Reconstruct NIH RePORTER's `core_project_num` form from a raw NIH award
 *  number string. RePORTER uses no spaces, no support-flag prefix, no year
 *  suffix: e.g. "1R01 CA245678-01A1" → "R01CA245678". Returns null for
 *  non-NIH or unparsable inputs. Used by etl/reporter/* to join Postgres
 *  Grant rows to reciterdb.grant_reporter_project. */
export function coreProjectNum(awardNumber: string | null | undefined): string | null {
  if (!awardNumber) return null;
  const m = awardNumber.trim().match(NIH_AWARD_RE);
  if (!m) return null;
  return `${m[1].toUpperCase()}${m[2].toUpperCase()}${m[3]}`;
}

/**
 * Issue #92 — extract the 7-digit NSF award ID from a raw `awardNumber`.
 *
 * NSF assigns each award a 7-digit numeric identifier (e.g. "2138052").
 * Institutional systems store this in many shapes:
 *
 *   "2138052"          → 2138052
 *   "NSF-2138052"      → 2138052
 *   "NSF 2138052"      → 2138052
 *   "PHY-2138052"      → 2138052       (directorate prefix)
 *   "DMS 2138052"      → 2138052
 *   "ABI-1234567-01"   → 1234567       (with renewal suffix)
 *
 * Be permissive: accept the bare 7-digit form too, since some InfoEd rows
 * drop the prefix entirely. CALLERS must gate this by sponsor (NSF) — a
 * standalone 7-digit string is ambiguous and could be e.g. an ACS or
 * foundation reference. NIH award numbers are filtered out first because
 * the leading 1-9 followed by an activity code can collide with NSF
 * directorate prefixes in rare cases.
 *
 * Returns null when no 7-digit code is present.
 */
const NSF_AWARD_RE =
  /(?:^|[^0-9])(\d{7})(?:[-\s][\w]+)?\s*$/;

export function nsfAwardId(awardNumber: string | null | undefined): string | null {
  if (!awardNumber) return null;
  const trimmed = awardNumber.trim();
  if (!trimmed) return null;
  // Don't mistake an NIH award (e.g. "1R01CA245678-01") for an NSF ID.
  if (isNihAwardNumber(trimmed)) return null;
  const m = trimmed.match(NSF_AWARD_RE);
  return m ? m[1] : null;
}

/**
 * Issue #92 — extract the Gates Foundation grant ID from a raw
 * `awardNumber`. Gates IDs come in two stable forms:
 *
 *   "INV-NNNNNN"   — current naming (post-2019), 6-digit numeric tail
 *   "OPP-NNNNNN"   — legacy naming, same shape
 *
 * Some institutional systems prepend "Gates" / "BMGF" / no prefix. The
 * matcher accepts any common prefix and returns the canonical "INV-…"
 * or "OPP-…" form for joining against the published CSV.
 *
 *   "INV-003934"        → "INV-003934"
 *   "OPP-1234567"       → "OPP-1234567"   (7-digit tails exist on legacy)
 *   "Gates INV-003934"  → "INV-003934"
 *   "BMGF-INV-003934"   → "INV-003934"
 *   "INV3934"           → "INV-003934"     (zero-padded normalization)
 *
 * Returns null when the string doesn't contain a Gates-shaped ID.
 */
const GATES_AWARD_RE = /\b(INV|OPP)[-\s]?(\d{1,7})\b/i;

export function gatesGrantId(awardNumber: string | null | undefined): string | null {
  if (!awardNumber) return null;
  const m = awardNumber.match(GATES_AWARD_RE);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  // Pad to 6 digits for INV (the modern canonical form). OPP IDs vary
  // 6-7 digits historically; preserve the original digit count there.
  const digits = m[2];
  const tail = prefix === "INV" && digits.length < 6 ? digits.padStart(6, "0") : digits;
  return `${prefix}-${tail}`;
}
