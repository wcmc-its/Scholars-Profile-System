/**
 * Display labels + SEO descriptions for the closed ~14-set of A2 method
 * supercategories (the parent level of the Method taxonomy: Supercategory →
 * Family → publication).
 *
 * There is NO supercategory label in the DB or the A2 artifact — `families[]`
 * carries only the snake_case `supercategory` id. Per the standalone Method pages
 * plan (OQ-2: static map vs a `MethodSupercategory` DB dimension), a static map
 * is sufficient for the closed set and avoids a migration. The supercategory set
 * is "open" only in the drift sense (13→14 across A2 rebuilds), so an id missing
 * from this map MUST NOT crash a page — {@link supercategoryLabel} /
 * {@link supercategoryDescription} fall back to a title-case humanization of the
 * id (warn-not-fail, mirroring the mapper's posture).
 *
 * Pure module (no Prisma, no env, no flag) — safe to import from a client or
 * server component, the search layer, and the loaders alike.
 */

export type SupercategoryLabel = {
  /** Human display label rendered as the supercategory page `<h1>` + breadcrumb. */
  label: string;
  /** One-sentence SEO/meta description (interpolated into `generateMetadata`). */
  description: string;
};

/**
 * id → `{ label, description }`. Keys are the A2 supercategory ids (the
 * `families[].supercategory` snake_case values; the canonical closed set is the
 * per-supercategory export filenames in the family-consolidation output).
 */
export const SUPERCATEGORY_LABELS: Readonly<Record<string, SupercategoryLabel>> = {
  animal_cell_models: {
    label: "Animal & Cell Models",
    description:
      "Research methods using animal models, cell lines, and organoid systems across Weill Cornell Medicine.",
  },
  clinical_instruments_assays: {
    label: "Clinical Instruments & Assays",
    description:
      "Clinical measurement instruments, diagnostic assays, and patient-reported outcome tools used in research at Weill Cornell Medicine.",
  },
  computational_statistical: {
    label: "Computational & Statistical Methods",
    description:
      "Statistical modeling, study design, and computational analysis methods used by Weill Cornell Medicine researchers.",
  },
  datasets_cohorts: {
    label: "Datasets & Cohorts",
    description:
      "Research datasets, registries, and patient cohorts leveraged across Weill Cornell Medicine.",
  },
  functional_metabolic_cellular_assays: {
    label: "Functional, Metabolic & Cellular Assays",
    description:
      "Functional, metabolic, and cellular assay methods used in laboratory research at Weill Cornell Medicine.",
  },
  genomics_sequencing: {
    label: "Genomics & Sequencing",
    description:
      "Genomic, transcriptomic, and high-throughput sequencing methods used by Weill Cornell Medicine researchers.",
  },
  imaging_image_analysis: {
    label: "Imaging & Image Analysis",
    description:
      "Medical and biological imaging modalities and image-analysis methods used across Weill Cornell Medicine.",
  },
  mass_spec_proteomics: {
    label: "Mass Spectrometry & Proteomics",
    description:
      "Mass spectrometry, proteomics, and metabolomics methods used in research at Weill Cornell Medicine.",
  },
  microscopy_histology: {
    label: "Microscopy & Histology",
    description:
      "Microscopy, histology, and tissue-imaging methods used by Weill Cornell Medicine researchers.",
  },
  molecular_biochem_reagents: {
    label: "Molecular & Biochemical Reagents",
    description:
      "Molecular biology and biochemical reagents, antibodies, and constructs used in research at Weill Cornell Medicine.",
  },
  other: {
    label: "Other Methods",
    description:
      "Additional research methods and tools used across Weill Cornell Medicine that fall outside the primary method categories.",
  },
  software_informatics: {
    label: "Software & Informatics",
    description:
      "Software tools, bioinformatics pipelines, and informatics platforms used by Weill Cornell Medicine researchers.",
  },
  structural_biophysical: {
    label: "Structural & Biophysical Methods",
    description:
      "Structural biology and biophysical characterization methods used in research at Weill Cornell Medicine.",
  },
  therapeutics_interventions: {
    label: "Therapeutics & Interventions",
    description:
      "Therapeutic agents, interventions, and treatment modalities studied across Weill Cornell Medicine.",
  },
};

/**
 * Title-case humanization of a snake_case supercategory id — the fallback when
 * an id is absent from {@link SUPERCATEGORY_LABELS} (open-set drift). Splits on
 * underscores and upper-cases each word's first letter. `"animal_cell_models"`
 * → `"Animal Cell Models"`; `""` → `""`.
 */
export function humanizeSupercategoryId(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Display label for a supercategory id, with a humanize fallback. */
export function supercategoryLabel(id: string): string {
  return SUPERCATEGORY_LABELS[id]?.label ?? humanizeSupercategoryId(id);
}

/**
 * SEO/meta description for a supercategory id. Falls back to a generic sentence
 * built from the humanized label when the id is absent from the map.
 */
export function supercategoryDescription(id: string): string {
  return (
    SUPERCATEGORY_LABELS[id]?.description ??
    `Research methods in ${humanizeSupercategoryId(id)} used across Weill Cornell Medicine.`
  );
}

/**
 * Whether a supercategory id is one of the known curated supercategories (i.e.
 * present in {@link SUPERCATEGORY_LABELS}). Useful for tests and for warn-logging
 * an unmapped id; NOT a render gate (unmapped ids still render via the fallback).
 */
export function isKnownSupercategory(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPERCATEGORY_LABELS, id);
}
