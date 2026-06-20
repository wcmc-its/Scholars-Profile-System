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
 * Keep in sync with the dictionary as cores are resolved. Only Biomedical Imaging
 * (`core_id` "2") is fully resolved today; the other ~12 WCM cores are named in
 * the research source ("Core inference prompt 0.txt") but not yet resolved to
 * aliases/staff in the dictionary, so they are intentionally omitted until an
 * upstream entry exists — projecting usage rows for a core with no catalog entry
 * would just FK-skip anyway.
 */
export type CoreCatalogEntry = {
  /** Dictionary `core_id`, e.g. "2". Stable string key (the DynamoDB SK suffix). */
  id: string;
  /** Display name, e.g. "Biomedical Imaging". */
  name: string;
  /** Canonical facility name, e.g. "Citigroup Biomedical Imaging Center". */
  facility: string | null;
  /**
   * CWID of the designated core owner. NULL until designated via an SPS Superuser
   * grant — owner designation + the unit-scoped RBAC role are a later piece (the
   * ADR-005 claim layer); this carries the dictionary value through as a seam.
   */
  ownerCwid: string | null;
};

/** `core.source` value stamped on every seeded row. */
export const CORE_CATALOG_SOURCE = "reciterai-core-dictionary";

export const CORE_CATALOG: ReadonlyArray<CoreCatalogEntry> = [
  {
    id: "2",
    name: "Biomedical Imaging",
    facility: "Citigroup Biomedical Imaging Center",
    ownerCwid: null,
  },
];
