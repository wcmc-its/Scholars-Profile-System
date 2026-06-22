/**
 * WCM core-facility catalog seed.
 *
 * A thin, version-controlled mirror of ReciterAI's `config/core_dictionary.yaml`
 * (the canonical source — per-core aliases, staff CWIDs, owner). There is NO
 * DynamoDB catalog record for cores, unlike topics which the DynamoDB ETL seeds
 * from the `TAXONOMY#` record. So `etl/dynamodb/index.ts` Block 6 upserts the
 * `core` table from this constant BEFORE projecting `publication_core`, then
 * FK-guards `publication_core.coreId` against it — the same "populate the
 * catalog, then guard the usage rows" flow Block 1 uses for `topic`.
 *
 * Keep in sync with the dictionary as cores are resolved. All 13 WCM cores in the
 * dictionary are now mirrored here. Cores with no firing staff/alias signal yet
 * (6 Institutional Biorepository, 7 Metabolic Phenotyping, 8 Microbiome, 10 Human
 * Immune Monitoring) seed a catalog row but currently project zero usage rows — an
 * empty core page until the upstream ReCiter target feed surfaces their staff. That
 * is harmless: the FK guard simply has no usage rows to attach.
 */
export type CoreCatalogEntry = {
  /** Dictionary `core_id`, e.g. "2". Stable string key (the DynamoDB SK suffix). */
  id: string;
  /** Display name, e.g. "Biomedical Imaging". */
  name: string;
  /** Canonical facility name, e.g. "Citigroup Biomedical Imaging Center". */
  facility: string | null;
};

/** `core.source` value stamped on every seeded row. */
export const CORE_CATALOG_SOURCE = "reciterai-core-dictionary";

export const CORE_CATALOG: ReadonlyArray<CoreCatalogEntry> = [
  { id: "1", name: "Applied Bioinformatics", facility: "Applied Bioinformatics Core" },
  { id: "2", name: "Biomedical Imaging", facility: "Citigroup Biomedical Imaging Center" },
  { id: "3", name: "Epigenomics", facility: "Epigenomics Core" },
  { id: "4", name: "Flow Cytometry", facility: "Flow Cytometry Core Facility" },
  { id: "5", name: "Genomics Resources", facility: "Genomics Resources Core Facility" },
  { id: "6", name: "Institutional Biorepository Core", facility: "Institutional Biorepository Core" },
  { id: "7", name: "Metabolic Phenotyping Center", facility: "Metabolic Phenotyping Center" },
  { id: "8", name: "Microbiome Sequencing", facility: "Microbiome Core" },
  { id: "9", name: "Advanced Biomolecular Analysis Core", facility: "Advanced Biomolecular Analysis Core" },
  { id: "10", name: "Human Immune Monitoring", facility: "Human Immune Monitoring Core" },
  { id: "11", name: "Microscopy and Image Analysis", facility: "Microscopy and Image Analysis Core" },
  { id: "12", name: "Nuclear Magnetic Resonance", facility: "Nuclear Magnetic Resonance (NMR) Core Facility" },
  { id: "13", name: "Proteomics and Metabolomics", facility: "Proteomics & Metabolomics Core Facility" },
];
