/**
 * ORCID iD normalization + checksum (ISO 7064 MOD 11-2), for the Identifiers &
 * Profiles tab's write. Accepts the bare iD, the dashed iD, or an orcid.org URL;
 * returns the canonical dashed form (`0000-0002-1825-0097`, check digit may be X)
 * or null when the shape or the check digit is wrong. The check digit is what
 * turns a typo into a refusal instead of a wrong iD on file.
 */
export const ORCID_URL_PREFIX = "https://orcid.org/";

export function normalizeOrcid(input: string): string | null {
  const digits = input
    .trim()
    .replace(/^https?:\/\/(www\.)?orcid\.org\//i, "")
    .replace(/[-\s]/g, "")
    .toUpperCase();
  if (!/^\d{15}[\dX]$/.test(digits)) return null;
  let total = 0;
  for (const c of digits.slice(0, 15)) total = (total + Number(c)) * 2;
  const check = (12 - (total % 11)) % 11;
  if (digits[15] !== (check === 10 ? "X" : String(check))) return null;
  return digits.replace(/(.{4})(?=.)/g, "$1-");
}

/** One `orcid_candidate` row for an iD, minus the cwid: what a source knows. */
export type OrcidEvidence = { source: string; accepted: number; rejected: number };

/** The scholar's first name — what a colleague would call them in a sentence
 *  ("Is this Olivier's ORCID iD?"). From `scholar.preferredName`. */
export function firstName(preferredName: string): string {
  return preferredName.trim().split(/\s+/)[0] || preferredName;
}

/**
 * The "why we think this is yours" line for one candidate source. Second
 * person is the EDITOR: `subject` is null when the scholar is editing their own
 * profile ("your"), else the scholar's first name ("Olivier's") so an
 * administrator reads who the evidence is about. The Identifiers & Profiles
 * card and the home board's ORCID row both read from this so they can never
 * disagree.
 */
export function orcidEvidenceLine(e: OrcidEvidence, subject: string | null): string {
  const whose = subject ? `${subject}'s` : "your";
  const who = subject ?? "you";
  const pubs = (n: number) => `${n} of ${whose} accepted publications`;
  switch (e.source) {
    case "rpm_inferred":
      return e.rejected > 0
        ? `Matched on ${pubs(e.accepted)} in ReCiter, and on ${e.rejected} ${who} rejected`
        : `Matched on ${pubs(e.accepted)} in ReCiter`;
    case "rpm_admin":
      return "Entered in ReCiter Publication Manager";
    case "orcid_email":
      return `The ORCID registry record lists ${whose} WCM email`;
    case "orcid_works":
      return e.accepted === 1
        ? `1 work on the ORCID record matches ${whose} publications`
        : `${e.accepted} works on the ORCID record match ${whose} publications`;
    case "orcid_name":
      return `The ORCID registry record matches ${whose} name`;
    default:
      return e.source;
  }
}
