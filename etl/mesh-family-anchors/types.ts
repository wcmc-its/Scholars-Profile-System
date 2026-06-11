/**
 * Shared types for the MeSH curated-family-anchor ETL (issue #879).
 */

export type FamilyAnchorRow = {
  supercategory: string;
  familyLabel: string;
  descriptorUi: string;
  confidence: "curated" | "derived";
  sourceNote: string | null;
};
