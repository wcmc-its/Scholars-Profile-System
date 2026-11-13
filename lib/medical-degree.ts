/**
 * Physician status from a scholar's education rows. Shared by Matcha's
 * researcher type (`lib/api/matcha-contract.ts`) and the people-index
 * `isPhysician` field (`lib/search-index-docs.ts`), so both read the same rule.
 * Pure and dependency-free (client-safe).
 */

/** Medical-degree families, compared against a degree string uppercased and stripped to
 *  letters ("M.D." and "MD-PhD" both land here). Dental, podiatry, psychology, nursing and
 *  pharmacy degrees are deliberately absent. */
const MEDICAL_DEGREES = new Set([
  "MD",
  "DO",
  "MBBS",
  "MBCHB",
  "MBBCH",
  "MBBCHIR",
  "MBBCHBAO",
  "BMBS",
  "MDPHD",
]);

export function isMedicalDegree(degree: string | null | undefined): boolean {
  const raw = (degree ?? "").toUpperCase().replace(/\./g, "");
  // Whole string first ("MD-PHD" -> MDPHD), then each part: one cell can hold several degrees
  // ("MD, MPH", "PhD, MD").
  if (MEDICAL_DEGREES.has(raw.replace(/[^A-Z]/g, ""))) return true;
  return raw.split(/[^A-Z]+/).some((part) => MEDICAL_DEGREES.has(part));
}

/** Any education degree is a medical degree. With no education rows at all,
 *  `hasClinicalProfile` stands in. */
export function isPhysicianFrom(row: {
  hasClinicalProfile: boolean;
  educations?: readonly { degree: string | null }[] | null;
}): boolean {
  const educations = row.educations ?? [];
  return educations.length > 0
    ? educations.some((e) => isMedicalDegree(e.degree))
    : row.hasClinicalProfile;
}
