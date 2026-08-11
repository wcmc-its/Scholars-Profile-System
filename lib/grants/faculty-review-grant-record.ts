/**
 * Shared `GrantRecord` shape + row mapper, used by BOTH:
 *   - app/api/faculty-review/[cwid]/grants/route.ts — the per-cwid Faculty
 *     Review Tool API (Bearer-gated, one scholar at a time).
 *   - scripts/exports/grants-bulk-export.ts — the nightly all-scholars NDJSON
 *     export to S3 for the Research Informatics cross-account consumer.
 *
 * Extracted so the two callers can never drift on field selection or
 * derivation (`fundingRoleLabel` / `isPiRole` / `isFundingActive`) — this
 * codebase's rule is one shared vocabulary per concept, never a second copy.
 *
 * `FACULTY_REVIEW_GRANT_SELECT` is the LEAN Prisma select both callers use:
 * only the columns {@link toGrantRecord} reads. Without it a `Grant` row drags
 * `abstract` (@db.Text) + `keywords`/`meshDescriptorUis` (Json) and several
 * other unused columns — see the route's original #1881 comment.
 */
import { isFundingActive } from "@/lib/funding-active";
import { fundingRoleLabel, isPiRole } from "@/lib/funding-roles";

export interface GrantRecord {
  /** Stable, source-issued unique id for the grant (the dedupe key). */
  externalId: string;
  /** "InfoEd" (WCM-administered) or "RePORTER" (NIH prior/dropped history). */
  source: string;
  title: string;
  /** This scholar's role, RAW as stored: PI | PI-Subaward | Co-PI | Co-I | Key Personnel.
   *  A stable passthrough of the source vocabulary — never relabelled here, so an existing
   *  caller keying off these tokens keeps working. For prose, use `roleLabel`.
   *
   *  `Co-PI` is InfoEd's NON-CONTACT PD/PI: the other principal investigator on an NIH
   *  multiple-PD/PI (MPI) award, holding FULL principal-investigator standing. It is not a
   *  junior or associate role, and NIH has no "co-PI" designation at all (that is NSF's
   *  term) — do not render this token verbatim in a promotion packet. */
  role: string;
  /** The role in WORDS, ready to print: "Principal Investigator", "Principal Investigator
   *  (subaward)", "Multiple Principal Investigator (MPI)" (for `Co-PI`), "Co-Investigator",
   *  "Key Personnel". Derived from `role` via the shared vocabulary; an unrecognized future
   *  source value passes through unchanged rather than rendering blank. */
  roleLabel: string;
  /** True when the role carries principal-investigator standing — `PI`, `PI-Subaward`, or
   *  `Co-PI`/MPI. Use this rather than testing `role === "PI"`, which silently excludes both
   *  the MPI and the subaward PI. `Co-I` and `Key Personnel` are false. */
  isPrincipalInvestigator: boolean;
  /** Sponsor-issued award number (e.g. "R01 AG067497"); null when none. */
  awardNumber: string | null;
  /** Pre-rendered sponsor display string (e.g. "NCI via Duke University"). */
  funder: string;
  /** Canonical short prime/direct sponsor names; null when not in the lookup. */
  primeSponsor: string | null;
  directSponsor: string | null;
  isSubaward: boolean;
  /** Grant | Contract with funding | Fellowship | Career | Training | … */
  programType: string;
  /** NIH-only, derived from the award number; null otherwise. */
  mechanism: string | null;
  nihIc: string | null;
  /** RePORTER application id for outbound deep-links; null for non-NIH. */
  applId: number | null;
  /** ISO date (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  /** End date + 12-month NCE grace — the same badge the profile shows. */
  isActive: boolean;
}

/**
 * The lean `Grant` select both callers use — exactly the columns
 * {@link toGrantRecord} reads, nothing more. Keep this and `toGrantRecord` in
 * lockstep: a field added to one belongs in the other.
 */
export const FACULTY_REVIEW_GRANT_SELECT = {
  externalId: true,
  source: true,
  title: true,
  role: true,
  awardNumber: true,
  funder: true,
  primeSponsor: true,
  directSponsor: true,
  isSubaward: true,
  programType: true,
  mechanism: true,
  nihIc: true,
  applId: true,
  startDate: true,
  endDate: true,
} as const;

/** A `Grant` row shaped exactly like {@link FACULTY_REVIEW_GRANT_SELECT}. */
export interface GrantRowForFacultyReview {
  externalId: string;
  source: string;
  title: string;
  role: string;
  awardNumber: string | null;
  funder: string;
  primeSponsor: string | null;
  directSponsor: string | null;
  isSubaward: boolean;
  programType: string;
  mechanism: string | null;
  nihIc: string | null;
  applId: number | null;
  startDate: Date;
  endDate: Date;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Map one lean `Grant` row (see {@link FACULTY_REVIEW_GRANT_SELECT}) to a {@link GrantRecord}. */
export function toGrantRecord(row: GrantRowForFacultyReview, now: Date): GrantRecord {
  return {
    externalId: row.externalId,
    source: row.source,
    title: row.title,
    // ADDITIVE: `role` stays a raw passthrough of the stored vocabulary (an existing
    // caller may key off it); `roleLabel`/`isPrincipalInvestigator` are the new derived
    // fields, so the tool prints "Multiple Principal Investigator (MPI)" for a `Co-PI`
    // row instead of an NSF-flavoured token NIH does not use.
    role: row.role,
    roleLabel: fundingRoleLabel(row.role),
    isPrincipalInvestigator: isPiRole(row.role),
    awardNumber: row.awardNumber,
    funder: row.funder,
    primeSponsor: row.primeSponsor,
    directSponsor: row.directSponsor,
    isSubaward: row.isSubaward,
    programType: row.programType,
    mechanism: row.mechanism,
    nihIc: row.nihIc,
    applId: row.applId,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    isActive: isFundingActive(row.endDate, now),
  };
}
