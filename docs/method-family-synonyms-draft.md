# Method-family search synonyms — draft for review

**Status:** Draft. Companion to `docs/search-mesh-resolution-fallback-spec.md` §8.

**What this is:** a curated `synonym → existing canonical family` table so lay
terms, brand names, and acronyms reach the **759 families that already exist**
in the Method/Tool taxonomy. Today search matches only when the query is a
*substring of the canonical family label* (no entry-term layer), so e.g.
*Seahorse* never reaches `extracellular flux respirometry`. This is the methods
analog of the MeSH curated-alias layer (`etl/mesh-aliases/curated.csv`).

**Coverage:** 95 family targets · ~195 surface forms · all validated
against the live staging inventory (no fabricated families). Targets marked
⚠️ are approximate (nearest existing family; confirm or route to a new one).

**Implementation:** mirror the MeSH alias mechanism — a CSV
`synonym,supercategory,family_label,note` loaded into the family match map, plus
apply the spec's decompose-and-resolve windowing to method matching. App-side;
no upstream taxonomy change for anything in this table.

---

## Animal & Cell Models

| Synonyms a user might type | → existing family |
|---|---|
| organoid | `organoid models` |
| iPSC · iPSCs · induced pluripotent stem cells | `ipsc derived cell models` |
| knockout cells · KO cell line | `gene knockout cell models` |
| cancer cell line | `cancer cell lines` |

## Clinical Instruments & Assays

| Synonyms a user might type | → existing family |
|---|---|
| wearables · actigraphy · Fitbit · smartwatch | `wearable activity monitoring` |
| PROM · PROMs · patient-reported outcomes | `patient reported outcome instruments` |
| ELISA | `immunoassay biomarker quantitation` |
| ECG · EKG | `electrocardiographic assessment` |
| EEG | `electroencephalography eeg recording` |
| PFT · spirometry | `pulmonary function testing` |

## Computational & Statistical Methods

| Synonyms a user might type | → existing family |
|---|---|
| molecular dynamics · MD simulation | `molecular simulation methods` ⚠️ |
| machine learning · ML | `machine learning classification` |
| deep learning · neural network | `deep learning models` |
| LLM · large language model · GPT | `large language model applications` |
| causal inference | `causal inference methods` |
| survival analysis · Kaplan-Meier · Cox regression | `survival analysis methods` |
| meta-analysis · systematic review | `systematic review and meta analysis` |
| polygenic risk score · PRS | `polygenic risk scoring` |
| NLP · natural language processing | `clinical text mining` ⚠️ |

## Datasets & Cohorts

| Synonyms a user might type | → existing family |
|---|---|
| EHR data · claims-linked EHR | `electronic health record datasets` |
| biobank · UK Biobank · All of Us | `biobank cohort datasets` |
| Medicare · Medicaid · claims data | `medicare medicaid claims data` |
| SEER · cancer registry | `cancer registry datasets` |
| patient registry | `clinical registry datasets` |

## Functional, Metabolic & Cellular Assays

| Synonyms a user might type | → existing family |
|---|---|
| Seahorse · extracellular flux · Seahorse assay | `extracellular flux respirometry` |
| glucose clamp · euglycemic clamp | `glucose clamp techniques` |
| mito stress test · mitochondrial respiration | `mitochondrial respiration assays` |

## Genomics & Sequencing

| Synonyms a user might type | → existing family |
|---|---|
| scRNA-seq · single-cell RNA-seq · single cell sequencing | `single cell rna sequencing` |
| WGS · whole-genome sequencing | `whole genome sequencing` |
| WES · whole-exome sequencing · exome sequencing | `whole exome sequencing` |
| ATAC-seq · chromatin accessibility | `chromatin accessibility profiling` |
| ChIP-seq · ChIP sequencing | `chromatin immunoprecipitation sequencing chip seq` |
| CRISPR screen · CRISPR screening · genetic screen | `functional genomic screening` |
| GWAS · genome-wide association | `genome wide association studies` |
| qPCR · RT-qPCR · real-time PCR | `quantitative pcr methods` |
| nanopore sequencing · long-read sequencing | `long read sequencing` |
| 16S rRNA · 16S sequencing | `16s rrna amplicon sequencing` |
| NGS · next-gen sequencing | `next generation sequencing` |
| variant calling | `variant calling and genotyping` |
| bisulfite sequencing · methylation sequencing | `whole genome bisulfite sequencing` |

## Imaging & Image Analysis

| Synonyms a user might type | → existing family |
|---|---|
| fMRI · functional MRI | `functional mri` |
| DTI · diffusion tensor imaging · tractography | `diffusion mri` |
| PET scan · FDG-PET · PET molecular imaging | `pet imaging` |
| PET/CT | `pet ct` |
| OCT (imaging) · optical coherence | `optical coherence tomography` |
| SPECT | `spect imaging` |
| echocardiogram · cardiac echo | `echocardiography` |

## Mass Spectrometry & Proteomics

| Synonyms a user might type | → existing family |
|---|---|
| LC-MS/MS · LC-MS · tandem MS | `liquid chromatography mass spectrometry` |
| proteomics | `mass spectrometry based proteomics` |
| metabolomics | `mass spectrometry based metabolomics` |
| lipidomics | `mass spectrometry based lipidomics` |
| MALDI | `maldi mass spectrometry` |
| Olink · proximity extension assay | `proximity extension assay proteomics` |

## Microscopy & Histology

| Synonyms a user might type | → existing family |
|---|---|
| two-photon microscopy · 2-photon · multiphoton | `multiphoton microscopy` |
| STORM · STED · PALM · super-resolution | `super resolution microscopy` |
| TEM · SEM · electron micrograph | `electron microscopy` |
| IHC | `immunohistochemistry` |
| FISH · in-situ hybridization | `in situ hybridization` |
| immunofluorescence · IF staining | `immunofluorescence microscopy` |
| digital pathology · whole-slide imaging | `digital pathology imaging` |

## Molecular & Biochemical Reagents

| Synonyms a user might type | → existing family |
|---|---|
| Luminex · multiplex cytokine | `cytokine and biomarker immunoassays` |
| CRISPR · CRISPR-Cas9 · gene editing | `crispr genome editing` |
| FACS · flow cytometry | `flow cytometry assays` |
| siRNA · shRNA · RNAi · knockdown | `rna interference reagents` |
| lentivirus · viral vector | `viral gene delivery vectors` |
| Western blot · immunoblot | `protein detection and quantification assays` |
| monoclonal antibody (reagent) · mAb | `antibody reagents` |
| optogenetics | `optogenetic tools` |
| co-IP · immunoprecipitation | `protein protein interaction assays` |
| patch-clamp · electrophysiology | `electrophysiological recording` |
| calcium imaging · GCaMP | `intracellular ion measurement` ⚠️ |

## Other Methods

| Synonyms a user might type | → existing family |
|---|---|
| 3D printing · bioprinting | `additive manufacturing 3d printing` |
| VR · virtual reality | `virtual reality technology` |
| simulation training | `simulation based training methods` |

## Software & Informatics

| Synonyms a user might type | → existing family |
|---|---|
| bioinformatics pipeline · Nextflow · Snakemake | `bioinformatics analysis pipelines` |
| EHR system · EMR | `electronic health record systems` |
| clinical decision support · CDSS | `clinical decision support systems` |
| mHealth · mobile health app | `mobile health applications` |
| R statistical · Python analysis · SAS | `statistical computing environments` |

## Structural & Biophysical Methods

| Synonyms a user might type | → existing family |
|---|---|
| cryo-EM · cryoEM · cryo-electron microscopy | `cryo em structure determination` |
| x-ray crystallography | `x ray crystallography` |
| NMR | `nmr spectroscopy` |
| SPR · surface plasmon resonance · BLI | `binding kinetics assays` ⚠️ |
| AFM | `atomic force microscopy` |

## Therapeutics & Interventions

| Synonyms a user might type | → existing family |
|---|---|
| AAV · adeno-associated virus | `aav gene therapy vectors` |
| CAR-T · chimeric antigen receptor | `car t cell immunotherapy` |
| mRNA vaccine | `mrna vaccine platforms` |
| ADC · antibody-drug conjugate | `antibody drug conjugate therapeutics` |
| DBS · deep brain stimulation | `deep brain stimulation systems` |
| checkpoint inhibitor · anti-PD-1 · PD-L1 | `immune checkpoint inhibitor therapeutics` |
| GLP-1 · semaglutide | `glp 1 receptor agonist therapeutics` |
| TAVR · transcatheter aortic valve | `transcatheter valve replacement` |
| robotic surgery | `robotic assisted surgery` |
| PARP inhibitor | `parp inhibitor therapeutics` |
| CDK4/6 inhibitor | `cdk4 6 inhibitor therapeutics` |

---

## Genuinely missing — candidate NEW families (upstream ReciterAI/S3)

Confirmed absent from the 759-family inventory; these need a real family before
a synonym can point at them:

- **Mendelian randomization** — no family; nearest is `causal inference methods` (distinct method).
- **Radiomics** — no family; nearest is `quantitative image analysis methods` / `deep learning image analysis`.

> _Animal / in-vivo **vertebrate** model families are intentionally out of scope per
> project direction: no synonym in this table aliases to one, and the inventory's only
> obvious vertebrate organism models (`amphibian developmental models`, `avian embryo
> models`) are excluded. The in-vitro `animal-cell-models` **cell** families (organoids,
> iPSC, cell lines, knockout cells) remain; live-animal model additions are not pursued._

## Approximate mappings to confirm (⚠️ above)

- `calcium imaging / GCaMP → intracellular ion measurement` — closest existing; a dedicated `calcium imaging` family may be warranted.
- `NLP → clinical text mining` — also a `clinical nlp and text mining tools` family under Software & Informatics; pick one or alias both.
- `SPR / BLI → binding kinetics assays` — generic; fine unless a dedicated biosensor family is added.
- `molecular dynamics → molecular simulation methods` — broad; acceptable.
