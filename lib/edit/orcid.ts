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
