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
 * Keep in sync with the dictionary as cores are resolved. Cores 1-14 mirror a
 * resolved dictionary entry. Cores with no firing staff/alias signal yet
 * (6 Institutional Biorepository, 7 Metabolic Phenotyping, 8 Microbiome, 10 Human
 * Immune Monitoring) seed a catalog row but currently project zero usage rows — an
 * empty core page until the upstream ReCiter target feed surfaces their staff. That
 * is harmless: the FK guard simply has no usage rows to attach.
 *
 * Cores 15 (Data Core) and 16 (Scientific Computing Unit) are catalog-ONLY: they
 * have no `core_dictionary.yaml` entry yet, because that file's loader RAISES on a
 * core with no `aliases:` (pipeline_cores/dictionary.py `_validate`) and validates
 * the WHOLE file on every load — so seeding them upstream without confirmed
 * acknowledgement strings would fail the nightly cores run for all 14 resolved
 * cores, not just these two. Seeding them HERE is the safe half: the row exists, so
 * the core is claimable / ownable / editable on /edit/core, and it projects zero
 * usage rows until the dictionary entry lands (the same harmless state cores 6/7/8/
 * 10 sit in today). `source` stays the dictionary constant because that is where
 * these two are headed, not where they are.
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
  { id: "14", name: "Research Informatics", facility: "Research Informatics" },
  { id: "15", name: "Data Core", facility: "Data Core" },
  { id: "16", name: "Scientific Computing Unit", facility: "Scientific Computing Unit" },
];
