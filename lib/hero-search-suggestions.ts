/**
 * Hero search "Try:" suggestion pool.
 *
 * 169 curated lay-term research topics ("CAR-T cell therapy", "Long COVID",
 * "Antibody-drug conjugates", …) that replace the old generic department- and
 * topic-name chips. Each one is the *lay term* a visitor would actually type;
 * the MeSH-aware search resolves it to a differently-named descriptor (CAR-T →
 * Receptors, Chimeric Antigen; antibody-drug conjugates → Immunoconjugates;
 * long COVID → Post-Acute COVID-19 Syndrome) and surfaces WCM scholars who
 * never wrote the buzzword verbatim — so the chips double as a search demo.
 *
 * This array is the runtime projection of the curated master at
 * `data/suggested-searches.json` (the lay-term `label` column, in master
 * order). The master also carries each chip's research area, MeSH descriptor,
 * WCM publication-depth proxy, and notes — kept out of the client bundle here
 * since the homepage only needs the strings. `tests/unit/hero-search-suggestions.test.ts`
 * asserts this list stays in sync with the master, so edit the JSON and
 * regenerate rather than hand-editing one side.
 *
 * The home page server-renders nothing in this slot; the client samples a
 * small random subset on mount, so what visitors see rotates every page load.
 *
 * How to refresh: see `docs/suggested-search-chips.md` — the method (mine the
 * taxonomy, verify depth via affiliation search, screen for the lay-term↔MeSH
 * gap) is meant to be re-run every couple of years. Regenerate the master JSON,
 * then regenerate the array below from its `label` column.
 */

/**
 * The curated lay-term chips, in master (`data/suggested-searches.json`) order.
 * Generated from the master's `label` column — do not hand-edit; edit the JSON.
 */
export const HERO_SEARCH_SUGGESTIONS: readonly string[] = [
  "CAR-T cell therapy",
  "Immune checkpoint inhibitors",
  "Bispecific antibodies",
  "Antibody-drug conjugates",
  "Oncolytic virotherapy",
  "Tumor-infiltrating lymphocytes",
  "Neoantigen cancer vaccines",
  "Tumor microenvironment",
  "Liquid biopsy",
  "Minimal residual disease",
  "PARP inhibitors",
  "KRAS inhibitors",
  "Targeted protein degradation (PROTAC)",
  "Patient-derived organoids",
  "Clonal hematopoiesis",
  "Cancer epigenetics",
  "Ferroptosis",
  "Myelodysplastic syndromes",
  "Spatial transcriptomics",
  "Single-cell RNA sequencing",
  "CRISPR",
  "Base & prime editing",
  "Exosomes",
  "Radiomics",
  "mRNA vaccines",
  "Antisense oligonucleotides",
  "siRNA therapeutics",
  "AAV gene therapy",
  "Gut microbiome",
  "Fecal microbiota transplantation",
  "Inflammatory bowel disease",
  "Antimicrobial resistance",
  "GLP-1 receptor agonists",
  "SGLT2 inhibitors",
  "Nonalcoholic fatty liver disease",
  "Heart failure with preserved EF (HFpEF)",
  "Cardiac amyloidosis",
  "Transcatheter aortic valve replacement",
  "Tauopathy",
  "Amyloid-beta",
  "Neuroinflammation",
  "Alpha-synuclein",
  "Senolytics",
  "Deep brain stimulation",
  "Long COVID",
  "HIV pre-exposure prophylaxis (PrEP)",
  "In vitro fertilization",
  "Preimplantation genetic testing",
  "Fertility preservation",
  "Endometriosis",
  "Social determinants of health",
  "Health equity & disparities",
  "Maternal mortality & morbidity",
  "Opioid use disorder",
  "Comparative effectiveness research",
  "Value-based care",
  "Pharmacoepidemiology",
  "Telemedicine",
  "Patient-reported outcomes",
  "Mendelian randomization",
  "Polygenic risk scores",
  "Electronic health records",
  "Clinical decision support",
  "Clinical natural language processing",
  "Real-world evidence",
  "Health information exchange",
  "Large language models in medicine",
  "Frailty",
  "Sarcopenia",
  "Systemic lupus erythematosus",
  "JAK inhibitors",
  "Cryo-electron microscopy",
  "G protein-coupled receptors",
  "Physician burnout",
  "Advance care planning",
  "Tissue engineering & regenerative medicine",
  "Wearable devices & sensors",
  "Causal inference",
  "Adaptive clinical trial design",
  "Triple-negative breast cancer",
  "CDK4/6 inhibitors",
  "Cardio-oncology",
  "Atrial fibrillation ablation",
  "Autophagy",
  "Epitranscriptomics",
  "Atopic dermatitis (dupilumab)",
  "Melanoma",
  "Induced pluripotent stem cells",
  "Drug repurposing",
  "Structure-based drug design",
  "Sepsis",
  "ECMO (extracorporeal membrane oxygenation)",
  "Air pollution",
  "Climate change & health",
  "Liver cirrhosis",
  "Pancreatic cancer",
  "Colorectal cancer",
  "Whole-genome sequencing",
  "Pharmacogenomics",
  "Tuberculosis",
  "HIV/AIDS",
  "Ovarian cancer",
  "Cost-effectiveness analysis",
  "Patient safety & quality improvement",
  "Hospital readmissions",
  "Multiple myeloma",
  "Acute myeloid leukemia",
  "Inflammasome",
  "Regulatory T cells",
  "Invasive fungal infections",
  "Clostridioides difficile",
  "Non-small cell lung cancer",
  "EGFR-mutant lung cancer (osimertinib)",
  "Preeclampsia",
  "Preterm birth",
  "Simulation-based medical education",
  "Graduate medical education",
  "Treatment-resistant depression",
  "Transcranial magnetic stimulation",
  "Obesity",
  "Osteoporosis",
  "Osteoarthritis",
  "Total joint arthroplasty",
  "Chronic kidney disease",
  "Acute kidney injury",
  "Glioblastoma",
  "Brain metastases",
  "Amyotrophic lateral sclerosis (ALS)",
  "Multiple sclerosis",
  "Ischemic stroke",
  "Optogenetics",
  "Age-related macular degeneration",
  "Diabetic retinopathy",
  "Head & neck squamous cell carcinoma",
  "Cochlear implants",
  "Chronic pain",
  "Regional anesthesia",
  "Palliative care",
  "Computational pathology",
  "Congenital heart disease",
  "Neonatal intensive care",
  "Hypertension",
  "Cancer screening",
  "Prostate cancer",
  "PSMA PET imaging",
  "Acute respiratory distress syndrome (ARDS)",
  "Idiopathic pulmonary fibrosis",
  "Deep learning in radiology",
  "Molecular imaging",
  "Spinal cord injury",
  "Stroke rehabilitation",
  "Biobanking",
  "Obstructive sleep apnea",
  "Circadian rhythm",
  "Hematopoietic stem cell transplantation",
  "Alcohol use disorder",
  "Smoking cessation",
  "Robotic surgery",
  "Bariatric surgery",
  "Metabolomics",
  "Proteomics",
  "Phase I clinical trials (first-in-human)",
  "Kidney transplantation",
  "Graft-versus-host disease",
  "Kidney stones",
  "Bladder cancer",
  "Polycystic ovary syndrome (PCOS)",
  "Menopause",
  "Implementation science",
];

/**
 * Pick `n` distinct random entries from the suggestion pool.
 *
 * Draws uniformly from the *whole* curated pool so a single page load can show
 * a broad range — short punchy terms ("Sepsis", "Melanoma", "Long COVID") next
 * to longer descriptive ones ("Antibody-drug conjugates"). The earlier
 * 12–22-character "balanced length" band (issue #214) was dropped because it
 * suppressed ~60% of the curated terms — exactly the recognizable showcase
 * chips — defeating the goal of a broad, rotating sample.
 */
export function sampleHeroSuggestions(n: number): string[] {
  const pool = [...HERO_SEARCH_SUGGESTIONS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(n, pool.length)));
}
