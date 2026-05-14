/**
 * Shared types for the MeSH curated-topic anchor ETL (spec §1.4).
 */

export type CuratedRow = {
  descriptorUi: string;
  parentTopicId: string;
  sourceNote: string | null;
};

export type DerivedRowRaw = {
  descriptor_ui: string;
  parent_topic_id: string;
  ratio: number;
  n_both: number;
  n_desc: number;
};

export type AnchorRow = {
  descriptorUi: string;
  parentTopicId: string;
  confidence: "curated" | "derived";
  sourceNote: string | null;
};
