/**
 * Shared types for the MeSH curated-alias ETL (issue #642).
 */

export type AliasRow = {
  alias: string;
  descriptorUi: string;
  sourceNote: string | null;
};
