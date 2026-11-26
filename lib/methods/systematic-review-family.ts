/**
 * Which method family is the systematic review family: the one family whose
 * publication list is built by two sources (methods extracted from papers, and
 * PubMed's systematic review filter; `etl/tools/systematic-review-rule.ts`).
 * The method page uses this to show its "About this list" note.
 *
 * The two constants repeat `SR_FAMILY_SUPERCATEGORY` / `SR_FAMILY_LABEL` from
 * the import rule, and the label is compared the way the rule compares it. They
 * are repeated, not imported, so a public page does not pull in ETL code.
 * Pure: safe in a client or a server component.
 */
const SR_FAMILY_SUPERCATEGORY = "computational_statistical";
const SR_FAMILY_LABEL = "systematic review and meta-analysis";

/** Case-fold, turn hyphens/underscores into spaces, collapse whitespace. */
function normalizeFamilyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[-_‐-―]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SR_FAMILY_LABEL_KEY = normalizeFamilyLabel(SR_FAMILY_LABEL);

export function isSystematicReviewFamily(supercategory: string, familyLabel: string): boolean {
  return (
    supercategory === SR_FAMILY_SUPERCATEGORY &&
    normalizeFamilyLabel(familyLabel) === SR_FAMILY_LABEL_KEY
  );
}
