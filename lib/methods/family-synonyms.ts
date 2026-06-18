/**
 * Method-family search synonyms — curated `lay-term / brand / acronym → canonical
 * family` map so user queries reach the existing taxonomy families that the
 * substring matcher (`matchKey.includes(query)`) can't (e.g. "Seahorse" →
 * `extracellular flux respirometry`). The methods analog of the MeSH curated-alias
 * layer (`etl/mesh-aliases/curated.csv`).
 *
 * Pure module (no Prisma / env / flag) — safe to import anywhere. Consumed by
 * `loadMethodCandidates` in `lib/api/search-taxonomy.ts`, gated behind
 * `METHODS_LENS_FAMILY_SYNONYMS`. Each entry keys to an EXISTING family by
 * `(supercategory, familyLabel)`; a synonym for a family absent from
 * `scholar_family` simply never attaches (harmless). Matching is whole-word-window
 * exact (NOT raw substring), so a short acronym like "ML" cannot match "html".
 *
 * Draft + rationale: `docs/method-family-synonyms-draft.md`. Animal / in-vivo
 * vertebrate model families are intentionally excluded.
 *
 * Polysemous 3-letter acronyms (OCT, SEM, PALM) are intentionally NOT curated —
 * they collide with everyday date / statistics / anatomy terms ("OCT 2024", the
 * "standard error of the mean", "palm of the hand"), and their families stay
 * reachable via the retained full-form synonyms (#1094 review follow-up).
 */
import { normalizeForMatch } from "@/lib/api/normalize";

export type FamilySynonymEntry = {
  /** Snake_case A2 supercategory id, matches `scholarFamily.supercategory`. */
  supercategory: string;
  /** Canonical family label (display form; matched normalized, casing-insensitive). */
  familyLabel: string;
  /** User-typed surface forms (lay terms / brands / acronyms). */
  synonyms: readonly string[];
};

export const FAMILY_SYNONYMS: readonly FamilySynonymEntry[] = [
  { supercategory: "genomics_sequencing", familyLabel: "single cell rna sequencing", synonyms: ["scRNA-seq", "single-cell RNA-seq", "single cell sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "whole genome sequencing", synonyms: ["WGS", "whole-genome sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "whole exome sequencing", synonyms: ["WES", "whole-exome sequencing", "exome sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "chromatin accessibility profiling", synonyms: ["ATAC-seq", "chromatin accessibility"] },
  { supercategory: "genomics_sequencing", familyLabel: "chromatin immunoprecipitation sequencing chip seq", synonyms: ["ChIP-seq", "ChIP sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "functional genomic screening", synonyms: ["CRISPR screen", "CRISPR screening", "genetic screen"] },
  { supercategory: "genomics_sequencing", familyLabel: "genome wide association studies", synonyms: ["GWAS", "genome-wide association"] },
  { supercategory: "genomics_sequencing", familyLabel: "quantitative pcr methods", synonyms: ["qPCR", "RT-qPCR", "real-time PCR"] },
  { supercategory: "genomics_sequencing", familyLabel: "long read sequencing", synonyms: ["nanopore sequencing", "long-read sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "16s rrna amplicon sequencing", synonyms: ["16S rRNA", "16S sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "next generation sequencing", synonyms: ["NGS", "next-gen sequencing"] },
  { supercategory: "genomics_sequencing", familyLabel: "variant calling and genotyping", synonyms: ["variant calling"] },
  { supercategory: "genomics_sequencing", familyLabel: "whole genome bisulfite sequencing", synonyms: ["bisulfite sequencing", "methylation sequencing"] },
  { supercategory: "imaging_image_analysis", familyLabel: "functional mri", synonyms: ["fMRI", "functional MRI"] },
  { supercategory: "imaging_image_analysis", familyLabel: "diffusion mri", synonyms: ["DTI", "diffusion tensor imaging", "tractography"] },
  { supercategory: "imaging_image_analysis", familyLabel: "pet imaging", synonyms: ["PET scan", "FDG-PET", "PET molecular imaging"] },
  { supercategory: "imaging_image_analysis", familyLabel: "pet ct", synonyms: ["PET/CT"] },
  { supercategory: "imaging_image_analysis", familyLabel: "optical coherence tomography", synonyms: ["optical coherence"] },
  { supercategory: "imaging_image_analysis", familyLabel: "spect imaging", synonyms: ["SPECT"] },
  { supercategory: "imaging_image_analysis", familyLabel: "echocardiography", synonyms: ["echocardiogram", "cardiac echo"] },
  { supercategory: "microscopy_histology", familyLabel: "multiphoton microscopy", synonyms: ["two-photon microscopy", "2-photon", "multiphoton"] },
  { supercategory: "microscopy_histology", familyLabel: "super resolution microscopy", synonyms: ["STORM", "STED", "super-resolution"] },
  { supercategory: "microscopy_histology", familyLabel: "electron microscopy", synonyms: ["TEM", "electron micrograph"] },
  { supercategory: "microscopy_histology", familyLabel: "immunohistochemistry", synonyms: ["IHC"] },
  { supercategory: "microscopy_histology", familyLabel: "in situ hybridization", synonyms: ["FISH", "in-situ hybridization"] },
  { supercategory: "microscopy_histology", familyLabel: "immunofluorescence microscopy", synonyms: ["immunofluorescence"] },
  { supercategory: "microscopy_histology", familyLabel: "digital pathology imaging", synonyms: ["digital pathology", "whole-slide imaging"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "liquid chromatography mass spectrometry", synonyms: ["LC-MS/MS", "LC-MS", "tandem MS"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "mass spectrometry based proteomics", synonyms: ["proteomics"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "mass spectrometry based metabolomics", synonyms: ["metabolomics"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "mass spectrometry based lipidomics", synonyms: ["lipidomics"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "maldi mass spectrometry", synonyms: ["MALDI"] },
  { supercategory: "mass_spec_proteomics", familyLabel: "proximity extension assay proteomics", synonyms: ["Olink", "proximity extension assay"] },
  { supercategory: "structural_biophysical", familyLabel: "cryo em structure determination", synonyms: ["cryo-EM", "cryoEM", "cryo-electron microscopy"] },
  { supercategory: "structural_biophysical", familyLabel: "x ray crystallography", synonyms: ["x-ray crystallography"] },
  { supercategory: "structural_biophysical", familyLabel: "nmr spectroscopy", synonyms: ["NMR"] },
  { supercategory: "structural_biophysical", familyLabel: "binding kinetics assays", synonyms: ["SPR", "surface plasmon resonance", "BLI"] },
  { supercategory: "structural_biophysical", familyLabel: "atomic force microscopy", synonyms: ["AFM"] },
  { supercategory: "computational_statistical", familyLabel: "molecular simulation methods", synonyms: ["molecular dynamics", "MD simulation"] },
  { supercategory: "computational_statistical", familyLabel: "machine learning classification", synonyms: ["machine learning", "ML"] },
  { supercategory: "computational_statistical", familyLabel: "deep learning models", synonyms: ["deep learning", "neural network"] },
  { supercategory: "computational_statistical", familyLabel: "large language model applications", synonyms: ["LLM", "large language model", "GPT"] },
  { supercategory: "computational_statistical", familyLabel: "causal inference methods", synonyms: ["causal inference"] },
  { supercategory: "computational_statistical", familyLabel: "survival analysis methods", synonyms: ["survival analysis", "Kaplan-Meier", "Cox regression"] },
  { supercategory: "computational_statistical", familyLabel: "systematic review and meta analysis", synonyms: ["meta-analysis", "systematic review"] },
  { supercategory: "computational_statistical", familyLabel: "polygenic risk scoring", synonyms: ["polygenic risk score", "PRS"] },
  { supercategory: "computational_statistical", familyLabel: "clinical text mining", synonyms: ["NLP", "natural language processing"] },
  { supercategory: "software_informatics", familyLabel: "bioinformatics analysis pipelines", synonyms: ["bioinformatics pipeline", "Nextflow", "Snakemake"] },
  { supercategory: "software_informatics", familyLabel: "electronic health record systems", synonyms: ["EHR system", "EMR"] },
  { supercategory: "software_informatics", familyLabel: "clinical decision support systems", synonyms: ["clinical decision support", "CDSS"] },
  { supercategory: "software_informatics", familyLabel: "mobile health applications", synonyms: ["mHealth", "mobile health app"] },
  { supercategory: "software_informatics", familyLabel: "statistical computing environments", synonyms: ["R statistical", "Python analysis", "SAS"] },
  { supercategory: "datasets_cohorts", familyLabel: "electronic health record datasets", synonyms: ["EHR data", "claims-linked EHR"] },
  { supercategory: "datasets_cohorts", familyLabel: "biobank cohort datasets", synonyms: ["biobank", "UK Biobank", "All of Us"] },
  { supercategory: "datasets_cohorts", familyLabel: "medicare medicaid claims data", synonyms: ["Medicare", "Medicaid", "claims data"] },
  { supercategory: "datasets_cohorts", familyLabel: "cancer registry datasets", synonyms: ["SEER", "cancer registry"] },
  { supercategory: "datasets_cohorts", familyLabel: "clinical registry datasets", synonyms: ["patient registry"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "wearable activity monitoring", synonyms: ["wearables", "actigraphy", "Fitbit", "smartwatch"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "patient reported outcome instruments", synonyms: ["PROM", "PROMs", "patient-reported outcomes"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "immunoassay biomarker quantitation", synonyms: ["ELISA"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "electrocardiographic assessment", synonyms: ["ECG", "EKG"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "electroencephalography eeg recording", synonyms: ["EEG"] },
  { supercategory: "clinical_instruments_assays", familyLabel: "pulmonary function testing", synonyms: ["PFT", "spirometry"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "cytokine and biomarker immunoassays", synonyms: ["Luminex", "multiplex cytokine"] },
  { supercategory: "functional_metabolic_cellular_assays", familyLabel: "extracellular flux respirometry", synonyms: ["Seahorse", "extracellular flux", "Seahorse assay"] },
  { supercategory: "functional_metabolic_cellular_assays", familyLabel: "glucose clamp techniques", synonyms: ["glucose clamp", "euglycemic clamp"] },
  { supercategory: "functional_metabolic_cellular_assays", familyLabel: "mitochondrial respiration assays", synonyms: ["mito stress test", "mitochondrial respiration"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "crispr genome editing", synonyms: ["CRISPR", "CRISPR-Cas9", "gene editing"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "flow cytometry assays", synonyms: ["FACS", "flow cytometry"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "rna interference reagents", synonyms: ["siRNA", "shRNA", "RNAi", "knockdown"] },
  { supercategory: "therapeutics_interventions", familyLabel: "aav gene therapy vectors", synonyms: ["AAV", "adeno-associated virus"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "viral gene delivery vectors", synonyms: ["lentivirus", "viral vector"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "protein detection and quantification assays", synonyms: ["Western blot", "immunoblot"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "antibody reagents", synonyms: ["monoclonal antibody", "mAb"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "optogenetic tools", synonyms: ["optogenetics"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "protein protein interaction assays", synonyms: ["co-IP", "immunoprecipitation"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "electrophysiological recording", synonyms: ["patch-clamp", "electrophysiology"] },
  { supercategory: "molecular_biochem_reagents", familyLabel: "intracellular ion measurement", synonyms: ["calcium imaging", "GCaMP"] },
  { supercategory: "animal_cell_models", familyLabel: "organoid models", synonyms: ["organoid"] },
  { supercategory: "animal_cell_models", familyLabel: "ipsc derived cell models", synonyms: ["iPSC", "iPSCs", "induced pluripotent stem cells"] },
  { supercategory: "animal_cell_models", familyLabel: "gene knockout cell models", synonyms: ["knockout cells", "KO cell line"] },
  { supercategory: "animal_cell_models", familyLabel: "cancer cell lines", synonyms: ["cancer cell line"] },
  { supercategory: "therapeutics_interventions", familyLabel: "car t cell immunotherapy", synonyms: ["CAR-T", "chimeric antigen receptor"] },
  { supercategory: "therapeutics_interventions", familyLabel: "mrna vaccine platforms", synonyms: ["mRNA vaccine"] },
  { supercategory: "therapeutics_interventions", familyLabel: "antibody drug conjugate therapeutics", synonyms: ["ADC", "antibody-drug conjugate"] },
  { supercategory: "therapeutics_interventions", familyLabel: "deep brain stimulation systems", synonyms: ["DBS", "deep brain stimulation"] },
  { supercategory: "therapeutics_interventions", familyLabel: "immune checkpoint inhibitor therapeutics", synonyms: ["checkpoint inhibitor", "anti-PD-1", "PD-L1"] },
  { supercategory: "therapeutics_interventions", familyLabel: "glp 1 receptor agonist therapeutics", synonyms: ["GLP-1", "semaglutide"] },
  { supercategory: "therapeutics_interventions", familyLabel: "transcatheter valve replacement", synonyms: ["TAVR", "transcatheter aortic valve"] },
  { supercategory: "therapeutics_interventions", familyLabel: "robotic assisted surgery", synonyms: ["robotic surgery"] },
  { supercategory: "therapeutics_interventions", familyLabel: "parp inhibitor therapeutics", synonyms: ["PARP inhibitor"] },
  { supercategory: "therapeutics_interventions", familyLabel: "cdk4 6 inhibitor therapeutics", synonyms: ["CDK4/6 inhibitor"] },
  { supercategory: "other", familyLabel: "additive manufacturing 3d printing", synonyms: ["3D printing", "bioprinting"] },
  { supercategory: "other", familyLabel: "virtual reality technology", synonyms: ["VR", "virtual reality"] },
  { supercategory: "other", familyLabel: "simulation based training methods", synonyms: ["simulation training"] },
];

/** Index key for a family: `${supercategory}\u0000${normalizeForMatch(label)}`. */
export function familySynonymIndexKey(supercategory: string, familyLabel: string): string {
  return supercategory + "\u0000" + normalizeForMatch(familyLabel);
}

// Built once: family index key -> normalized synonym keys (length >= 2).
const SYNONYM_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const e of FAMILY_SYNONYMS) {
    const keys = e.synonyms
      .map((s) => normalizeForMatch(s))
      .filter((s) => s.length >= 2);
    if (keys.length === 0) continue;
    const k = familySynonymIndexKey(e.supercategory, e.familyLabel);
    const prev = m.get(k);
    if (prev) prev.push(...keys);
    else m.set(k, [...keys]);
  }
  return m;
})();

/** Normalized synonym keys for a family, or [] if none are curated. */
export function familySynonymKeys(supercategory: string, familyLabel: string): readonly string[] {
  return SYNONYM_INDEX.get(familySynonymIndexKey(supercategory, familyLabel)) ?? [];
}
