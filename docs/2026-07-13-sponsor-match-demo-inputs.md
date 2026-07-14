# Sponsor-match demo inputs

Thirty pastes for demoing the sponsor-match console, grouped by the capability each one exercises,
plus one honest stress test. Nothing here is tailored to specific WCM faculty — each input is built
to make the *system* do something visible and non-obvious.

These are deliberately **not** the fifteen gold fixtures in `scripts/search-eval/sponsor-fixtures.json`.
Those are the set the ranker was tuned against; demoing on them would be circular. These are fresh.

Each entry lists what to expect so you can narrate while the results render. `Expect (primary)` is the
concept that should take centrality 1.0 in the rail.

## Reading the paste — what survives, what gets thrown away

### 1. Sepsis FOA, buried in boilerplate

**Voice.** A federal program officer issuing a formal NIH-style funding opportunity announcement

**Demonstrates.** The extractor discards award ceilings, direct-cost caps, project period, LOI/application dates, page limits, F&A rules, eligibility, and review scoring, and surfaces only the sepsis biology from a FOA where mechanics outnumber science two-to-one.

**Watch for.** Watch the concept rail fill with sepsis immunobiology while every dollar figure, due date, page limit, and eligibility rule lands nowhere — the two-thirds of the text that is award mechanics leaves no trace on the ranking.

```text
Funding Opportunity Announcement RFA-XX-26-001 (Reissue of PAR-23-114)

Purpose. This Funding Opportunity Announcement solicits R01 applications to elucidate the dysregulated host response that drives sepsis and to improve outcomes among critically ill adults. Responsive projects may interrogate early hyperinflammation and the ensuing immunoparalysis, endothelial barrier breakdown with microvascular leak, sepsis-induced coagulopathy, mitochondrial dysfunction in vital organs, and the pathogenesis of septic acute kidney injury and the acute respiratory distress syndrome. Studies pairing single-cell transcriptomics of circulating leukocytes, longitudinal plasma proteomics, and electronic health record cohorts to derive and validate biomarkers of impending organ failure are of particular interest.

Award Information. Estimated total funding is $6,000,000; the Institute intends to make 8-10 awards. Direct costs may not exceed $500,000 in any single year. The maximum project period is 5 years. Facilities and Administrative costs are reimbursed at the applicant's federally negotiated rate.

Key Dates. Letters of Intent are due 30 days before the application due date. Applications are due October 5, 2026, by 5:00 PM local time of the applicant organization. Earliest anticipated start date is July 2027.

Eligibility. Only domestic non-profit institutions are eligible. The PD/PI must hold a doctoral degree. Foreign components are not allowed. The Research Strategy is limited to 12 pages.

Peer Review. Applications will be scored for Significance, Investigators, Innovation, Approach, and Environment on the 1-9 scale. Direct programmatic inquiries to the Program Officer named in Section VII.
```

**Expect (primary).** sepsis (the dysregulated host response to infection)

**Expect (supporting).** immunoparalysis / immune dysregulation; endothelial dysfunction and microvascular leak; sepsis-induced coagulopathy; mitochondrial dysfunction; septic acute kidney injury; acute respiratory distress syndrome; single-cell transcriptomics (method); plasma proteomics / biomarker discovery (method)

### 2. Scraped grants-portal listing — pulmonary arterial hypertension

**Voice.** Page furniture, not prose. A funding-portal detail page dragged straight from the browser to the clipboard: a nav breadcrumb, a stray "Print | Subscribe | Share", colon-delimited metadata fields (Opportunity Number, Assistance Listing, Status, Close Date, Award Ceiling), ALL-CAPS section headers, research priorities as bare noun-phrase bullets with no verbs, an eligibility checklist, and a cookie banner plus copyright footer at the bottom. Nobody wrote this for the tool; nobody cleaned it up. There is not one authored sentence in it.

**Demonstrates.** The extractor needs neither prose nor clean formatting. It pulls a correct, correctly-weighted concept set out of scraped page furniture — one primary target (PAH) at 1.0, disease mechanisms in the middle band, assays and endpoints capped as methods — while every breadcrumb, opportunity number, assistance listing, close date, dollar ceiling, eligibility rule and cookie notice lands nowhere. It also has to survive the two traps that only appear in scraped text: an out-of-scope ("Not responsive") block naming diseases it must NOT target, and dense clinical abbreviation/brand jargon (mPAP, PVR, RV–PA, PASMC, 6MWD, "the sotatercept class", Sugen) that must canonicalize rather than tokenize.

**Watch for.** FURNITURE THAT MUST EXTRACT TO NOTHING: the breadcrumb ("Home › Funding › Open Opportunities › Cardiopulmonary › Detail"), "Skip to main content", "Print | Subscribe | Share", "Back to search results", "1 of 3", Opportunity Number ALD-2026-PVD-04, Assistance Listing 93.837, "Status: Posted", Posted/Close/Last-Updated dates, Award Ceiling $450,000 / Award Floor $150,000, "Expected Number of Awards 6–8", "Version: Synopsis 2", the whole ELIGIBILITY and HOW TO APPLY blocks, the cookie banner, the copyright/Privacy-Policy footer, "Page ID: 41732", "Rendered in 0.148s", "JavaScript is disabled". None of these may become a concept, and none may leak into a researcher's evidence lines.
ELIGIBILITY BLEED: "Doctoral degree", "Assistant or Associate Professor", "≤ 10 years from first independent appointment", "501(c)(3)", "indirect costs", "letter of intent" must not surface medical-education, faculty-development, or research-administration scholars. This is the single most likely failure on a scraped paste.
NEGATION TRAP: chronic thromboembolic pulmonary hypertension, PH of left heart disease, and PH of lung disease/hypoxia appear ONLY in the "Not responsive" line. They must not be extracted as targets. A CTEPH pulmonary thromboendarterectomy surgeon, an HFpEF cardiologist, or a COPD investigator appearing in the top ranks = failure, even though the words are in the paste.
PROPER-NOUN MISREADS: "Wood units" is a resistance unit, not a person. "Sugen" is the compound SU5416 in the Sugen/hypoxia rat model, not a company or a funder. "Aldercrest" is the funder and must be ignored entirely. "REVEAL"-style phrasing is absent by design, but "multiparameter risk stratification" must not become a standalone target.
CENTRALITY INVERSION (the known IDF failure): the rare, distinctive tokens here are the mechanisms — "RV–PA uncoupling", "plexiform lesion", "ActRIIA-Fc", "SMAD1/5/9" — while "pulmonary arterial hypertension" is the corpus-common term. Rarity weighting must not promote a mechanism above the disease: PAH stays at 1.0. Conversely, "endothelial dysfunction" and "cardiac MRI" are corpus-common and generic — a cardiac-MRI physicist or a general vascular-biology lab with zero pulmonary-vascular work must not out-rank a PAH investigator. Methods stay capped in the 0.3–0.5 band.
CLUSTERING: PAH / pulmonary hypertension / WSPH Group 1 / pulmonary vascular disease / the hemodynamic definition are one concept. BMPR2 and the BMP9–ALK1–SMAD1/5/9 bullets are one axis. RV failure, RV hypertrophy, RV fibrosis and RV–PA uncoupling are one concept. A scholar strong on the disease must not be triple-credited for the restatements.

```text
Skip to main content

Home › Funding › Open Opportunities › Cardiopulmonary › Detail
Print | Subscribe | Share

Aldercrest Foundation for Cardiopulmonary Research
Investigator-Initiated Research Award — Cycle 12
Pulmonary Vascular Disease Program

Opportunity Number:   ALD-2026-PVD-04
Assistance Listing:   93.837 — Cardiovascular Diseases Research
Opportunity Category:   Discretionary
Funding Instrument Type:   Grant
Status: Posted
Posted Date:   Feb 03, 2026
Close Date:   Apr 17, 2026  05:00 PM ET
Last Updated:   Feb 03, 2026  09:14 AM ET
Expected Number of Awards:   6 – 8
Award Ceiling:   $450,000 direct / 3 years
Award Floor:   $150,000
Cost Sharing or Matching Requirement:   No
Version:   Synopsis 2

Back to search results  |  Related opportunities (3)  |  1 of 3

PROGRAM DESCRIPTION

Pulmonary arterial hypertension (WSPH Group 1). Precapillary disease. Mean pulmonary artery pressure > 20 mmHg, pulmonary artery wedge pressure ≤ 15 mmHg, pulmonary vascular resistance > 2 Wood units. Idiopathic, heritable, drug- and toxin-associated, connective-tissue-disease-associated, congenital-heart-disease-associated. Mechanism-driven work only.

RESEARCH PRIORITIES

Responsive proposals address one or more of:

• BMPR2 loss of function — haploinsufficiency, incomplete penetrance, modifier loci, second-hit models
• BMP9/GDF2 – ALK1 – endoglin axis; restoration of SMAD1/5/9 tone
• pulmonary vascular remodeling — muscularization of distal arterioles, concentric intimal fibrosis, plexiform lesion biology
• endothelial dysfunction — apoptosis-resistant hyperproliferative endothelial clones; loss of nitric oxide and prostacyclin; endothelin-1 excess
• pulmonary artery smooth-muscle cell and pericyte proliferation; pericyte–endothelial crosstalk; perivascular inflammation
• metabolic reprogramming of the pulmonary vasculature — glycolytic shift, mitochondrial dysfunction
• prostacyclin (IP receptor) and endothelin (ETA/ETB) pathway pharmacology; nitric oxide / soluble guanylate cyclase axis
• activin-signaling inhibition — activin receptor type IIA–Fc ligand traps ("the sotatercept class"); activin A and GDF-8/11 sequestration; SMAD2/3 ↔ SMAD1/5/9 rebalancing
• right ventricular failure — maladaptive RV hypertrophy, RV fibrosis, RV–PA uncoupling (Ees/Ea), pressure–volume loop physiology
• pediatric PAH — congenital systemic-to-pulmonary shunts, trisomy 21, developmental lung disease, transition to adult care
• sex differences and estrogen metabolism in penetrance
• hemodynamic endpoints — right-heart catheterization; mPAP, PVR, cardiac index; 6MWD; NT-proBNP; multiparameter risk stratification
• cardiac MRI endpoints — RV ejection fraction, RV end-systolic volume index, stroke volume, late gadolinium enhancement at RV insertion points
• preclinical platforms — patient-derived iPSC endothelial models, precision-cut lung slices, Sugen/hypoxia and monocrotaline rodent models

Not responsive: chronic thromboembolic pulmonary hypertension surgical series; pulmonary hypertension of left heart disease; PH of lung disease and hypoxia; device-only trials with no mechanistic aim.

ELIGIBILITY

• Doctoral degree (MD, PhD, MD/PhD, or equivalent)
• Independent faculty appointment at time of award
• Assistant or Associate Professor; ≤ 10 years from first independent appointment
• U.S. and Canadian non-profit institutions; 501(c)(3) or equivalent
• Concurrent federal PI-level support on overlapping specific aims — not permitted
• Indirect costs capped at 10% of direct
• Letter of intent required; full applications by invitation only
• One application per principal investigator per cycle

HOW TO APPLY

Register in the applicant portal. LOI template (DOCX, 42 KB). Budget worksheet (XLSX, 88 KB).
Questions: grants@aldercrestfdn.org

Related opportunities (3)   |   Back to top

We use cookies and similar technologies to analyze traffic and improve your experience. By continuing to browse you consent to our use of cookies.
Manage preferences | Accept all | Reject non-essential

© 2026 Aldercrest Foundation for Cardiopulmonary Research. All rights reserved.
Privacy Policy · Terms of Use · Accessibility Statement · Contact
Page ID: 41732 | Rendered in 0.148s
JavaScript is disabled in your browser. Some features of this page may not work.
```

**Expect (primary).** Pulmonary arterial hypertension (concept, centrality 1.0) — the one primary target. "PAH", "WSPH Group 1", "pulmonary vascular disease", "precapillary pulmonary hypertension" and the hemodynamic definition line (mPAP > 20 mmHg / PAWP ≤ 15 / PVR > 2 WU) must all cluster into this single concept and be credited once, not five times.

**Expect (supporting).** Pulmonary vascular remodeling — concept, ~0.7–0.8 (distal arteriolar muscularization, intimal fibrosis, plexiform lesions cluster in here); Right ventricular failure / RV–PA uncoupling — concept, ~0.7 (maladaptive RV hypertrophy, RV fibrosis, Ees/Ea, pressure–volume loops cluster in here; 'RV' canonicalizes to right ventricle); BMPR2 loss of function and BMP9/GDF2–ALK1–endoglin–SMAD1/5/9 signaling — concept, ~0.6–0.7 (the two bullets are one signaling axis, not two independent concepts); Activin signaling inhibition / activin receptor type IIA–Fc ligand trap — concept, ~0.5–0.6; 'the sotatercept class' is brand-ish jargon that must canonicalize to the ActRIIA-Fc / activin-GDF8/11 trap mechanism; Pulmonary endothelial dysfunction — concept, ~0.5–0.6 (apoptosis-resistant endothelial clones, nitric oxide and prostacyclin loss, endothelin-1 excess); Pulmonary artery smooth-muscle cell and pericyte proliferation — concept, ~0.5; Prostacyclin (IP receptor) and endothelin receptor pathway pharmacology; NO/soluble guanylate cyclase axis — concept, ~0.45–0.55; Pediatric pulmonary arterial hypertension — concept (subpopulation), ~0.4–0.5; Metabolic reprogramming / mitochondrial dysfunction in the pulmonary vasculature — concept, ~0.4; Sex differences and estrogen metabolism in disease penetrance — concept, ~0.3–0.4; Right-heart catheterization and invasive hemodynamics (mPAP, PVR, cardiac index) — METHOD, 0.3–0.45; Cardiac MRI (RV ejection fraction, RV end-systolic volume index, stroke volume, late gadolinium enhancement) — METHOD, 0.3–0.45; Functional and biomarker endpoints — 6-minute walk distance, NT-proBNP — METHOD/endpoint, ~0.3; Preclinical models — patient-derived iPSC endothelial cells, precision-cut lung slices, SU5416(Sugen)/hypoxia and monocrotaline rodent models — METHOD, 0.3–0.4

### 3. Type 1 diabetes RFP — target in one sentence, buried under mechanism

**Voice.** A diabetes research foundation's program office, writing a formal RFP

**Demonstrates.** Centrality is distance-from-target, not prose volume: a one-sentence primary target still scores 1.0 while paragraphs of mechanism and assay detail rank as supporting.

**Watch for.** Watch type 1 diabetes take the top spot at full centrality even though it gets a single sentence, while the CD8 T-cell, HLA, and ER-stress mechanisms that eat 70% of the text settle at 0.3-0.5 — the ranker is measuring distance from the target, not column inches.

```text
The Foundation invites applications that dissect the immune and beta-cell events driving progression to type 1 diabetes, with the singular goal of preserving residual beta-cell function in recently diagnosed and at-risk individuals. We are especially interested in how autoreactive CD8 T cells recognize islet-derived epitopes presented on high-risk HLA class I alleles such as HLA-A*02:01, and how the class II haplotypes DR3-DQ2 and DR4-DQ8 shape the CD4 repertoire that licenses this attack. A central mechanistic question is how beta-cell endoplasmic reticulum stress, under inflammatory and metabolic load, generates neoantigens — hybrid insulin peptides, deamidated and citrullinated epitopes, and defective ribosomal products — that break tolerance to insulin, GAD65, IA-2, and ZnT8. We encourage proposals leveraging HLA-transgenic NOD and humanized NSG mouse models, peptide-MHC tetramer staining and single-cell TCR sequencing of islet-infiltrating lymphocytes, live-islet and 68Ga-exendin PET imaging of beta-cell mass, and microfluidic islet-on-chip platforms. Work that rationalizes antigen-specific tolerance, low-dose IL-2 Treg expansion, or anti-CD3 (teplizumab-style) immune modulation to halt the autoimmune cascade is likewise welcome. Every funded project must ultimately serve the protection of functional beta-cell mass. Awards provide up to $1.5M over four years; only tenure-track faculty at nonprofit institutions may apply, and letters of intent are due March 15.
```

**Expect (primary).** type 1 diabetes

**Expect (supporting).** autoreactive CD8 T cells (mechanism, ~0.4); HLA risk haplotypes / class I and II alleles (mechanism, ~0.4); beta-cell ER stress and neoantigen formation (mechanism, ~0.4); islet autoantigens: insulin, GAD65, IA-2, ZnT8 (concept, ~0.3); peptide-MHC tetramer staining + single-cell TCR sequencing (method, ~0.3); 68Ga-exendin PET / live-islet imaging of beta-cell mass (method, ~0.3); HLA-transgenic NOD / humanized NSG mouse models (method, ~0.3); anti-CD3 (teplizumab-style) immune modulation (method, ~0.4)

### 4. Kidney-failure RFP: nine names, one target

**Voice.** A disease foundation's research office, writing a formal RFP

**Demonstrates.** Nine surface phrasings for the same disease collapse into one weighted cluster instead of consuming nine competing fan-out slots, while award mechanics and the biosketch line are ignored.

**Watch for.** Count how many different names this RFP gives the same disease — CKD, chronic kidney disease, renal failure, diabetic nephropathy, ESRD, declining eGFR, kidney function loss, dialysis, renal replacement therapy — and watch them all fold into a single top-weighted cluster while the three-year award term, the dollar cap, and the biosketch requirement drop out entirely.

```text
The Foundation invites applications from investigators committed to slowing, halting, or reversing chronic kidney disease. Too many people in our community watch their eGFR decline year after year until renal failure forces them onto dialysis or a transplant waiting list, and we do not accept that the path from early kidney function loss to end-stage renal disease is inevitable. We are especially interested in the mechanisms that drive progressive nephron loss: tubulointerstitial fibrosis, podocyte injury and glomerulosclerosis, maladaptive proximal tubule repair, chronic interstitial inflammation, and the metabolic stress of diabetic nephropathy, still the leading cause of ESRD worldwide. We welcome mechanistic work that dissects these pathways using single-nucleus RNA sequencing, spatial transcriptomics, and patient-derived kidney organoids, anchored wherever possible in longitudinal cohorts with serial biopsies and measured eGFR slope. We are equally eager to understand how SGLT2 inhibitors and nonsteroidal mineralocorticoid receptor antagonists such as finerenone preserve surviving nephrons and flatten the eGFR slope in patients who still have measurable kidney function, how early in the course of CKD such therapy must begin to matter, and how many dialysis-free years it can buy a patient with diabetic nephropathy. Proposals introducing biomarkers that predict who will progress from stable CKD to renal replacement therapy are strongly encouraged. Awards run three years at up to $250,000 per year; a detailed budget and NIH-format biosketch are required at submission.
```

**Expect (primary).** chronic kidney disease

**Expect (supporting).** tubulointerstitial fibrosis; podocyte injury / glomerulosclerosis; renal interstitial inflammation; single-nucleus RNA sequencing; spatial transcriptomics; patient-derived kidney organoids; SGLT2 inhibitors / mineralocorticoid receptor antagonists (finerenone); eGFR slope in longitudinal cohorts

### 5. Dry-AMD foundation RFP, acronyms never spelled out

**Voice.** A retina-focused foundation program officer writing a research RFP

**Demonstrates.** The extractor resolves retina-specialist acronyms from context alone — AMD to age-related macular degeneration (not the chip maker, not "advanced macular degeneration"), RPE to retinal pigment epithelium, GA to geographic atrophy, CNV to choroidal neovascularization — with only OCT ever expanded.

**Watch for.** Watch AMD land a retina cohort rather than semiconductor engineers, and GA resolve to geographic atrophy — not Georgia or general anesthesia — even though neither phrase ever appears spelled out in the paste.

```text
Our Foundation invites proposals confronting AMD, the leading cause of irreversible central vision loss in adults over sixty, across the full arc of disease from its earliest signs to its advanced, sight-threatening stages. We are most interested in mechanistic work on the atrophic pathway, in which progressive dysfunction of the RPE and death of the photoreceptors it supports produce the expanding lesions of GA — for which no therapy yet restores lost vision. Strong applications will interrogate the drivers of this decline: chronic complement dysregulation and the CFH risk locus, drusen accumulating beneath the RPE and lipofuscin accumulating within it, oxidative injury in the outer retina, and dropout of the underlying choriocapillaris. We equally welcome studies of the neovascular transition, where CNV invades the macula and current anti-VEGF regimens control exudation without arresting the atrophy beneath. Competitive proposals will pair faithful disease models — iPSC-derived RPE, aged animal models, and human donor eyes — with quantitative endpoints from optical coherence tomography (OCT) and fundus autofluorescence to measure lesion progression. Our goal is to fund investigators who will move past symptom control toward strategies that protect, regenerate, or replace the RPE and rescue the photoreceptors that depend on it. Three-year awards; separate planning grants support first-in-human studies.
```

**Expect (primary).** age-related macular degeneration

**Expect (supporting).** geographic atrophy (concept, ~0.5 — the atrophic form the RFP most wants to fund); retinal pigment epithelium / RPE (concept, ~0.4 — the target tissue whose degeneration drives disease); complement dysregulation / complement factor H (CFH) (mechanism, ~0.4); choroidal neovascularization (concept, ~0.3 — the neovascular form); VEGF signaling / anti-VEGF therapy (mechanism, ~0.3); drusen and Bruch's membrane deposits (concept/biomarker, ~0.2); optical coherence tomography (OCT) (method, ~0.3 — the only expanded acronym); iPSC-derived RPE cell replacement (method, ~0.3)

### 6. MASLD RFP, buried under a foundation's house brands

**Voice.** A foundation drowning in its own internal branding

**Demonstrates.** That the extractor strips a sponsor's proprietary program names, trademarked indices, and named cohort down to the standard medical concepts beneath them — including canonicalizing the sponsor's "NASH"/"NAFLD" to MASLD.

**Watch for.** Watch the concept list come back clean — no "Hepatic Horizons," no "MetaboliQ," no "LIVERIGHT" — and notice the system quietly rewrote the sponsor's "NASH" and "NAFLD" into MASLD and kept only the biology.

```text
Applications to our Foundation's flagship Hepatic Horizons™ program should map to Pillar II of the Strategic Framework — "From Steatosis to Scar" — which carries forward our board-approved commitment to what our clinical partners long filed under NASH and NAFLD, now consolidated under the field's updated nomenclature. Within the Signal-to-Cell workstream we favor projects that trace how surplus hepatic fat tips into lipotoxic injury, how quiescent hepatic stellate cells transdifferentiate into collagen-depositing myofibroblasts, and how systemic insulin resistance keeps that cascade burning. Our proprietary MetaboliQ™ Index and its companion FibroSort™ tier both run on FIB-4 under the hood, so we ask applicants to show how their work would sharpen non-invasive fibrosis staging across the LIVERIGHT Cohort, our 4,200-participant registry. Under the Pillar II "Bench-to-Bedside Bridge" sub-theme we are particularly drawn to therapeutic mechanism: incretin biology and GLP-1 receptor agonism, FGF21 analog signaling, and the resolution of established bridging fibrosis before it hardens into cirrhosis and its portal-hypertensive sequelae. Funding is disbursed through the Catalyst tier of our giving structure; consult the Applicant Portal for the current Pillar II scoring rubric well ahead of the cycle deadline.
```

**Expect (primary).** Metabolic dysfunction-associated steatotic liver disease (MASLD)

**Expect (supporting).** Hepatic fibrosis progression to cirrhosis; Hepatic steatosis; Lipotoxicity; Hepatic stellate cell activation; Insulin resistance; FIB-4 / non-invasive fibrosis staging (method); GLP-1 receptor agonists; FGF21 analogs

### 7. A daughter's memorial gift letter — zero medical jargon

**Voice.** grieving private donor writing to a development officer

**Demonstrates.** The extractor canonicalizes fully lay, grief-voiced prose containing no taxonomy label at all into standard medical concepts — pancreatic cancer, early detection, metastasis — with correct centralities.

**Watch for.** There is not one medical term in this letter — yet watch it resolve 'the cancer in his pancreas' to pancreatic cancer at 1.0, and turn 'no test that catches it early' and 'it had already spread' into early-detection biomarkers and metastasis.

```text
Dear Ms. Alvarez,

Thank you for sitting with me last month, and for listening. My family is ready to move forward with the gift we discussed, in memory of my father.

Dad was healthy his whole life — still splitting his own firewood at seventy-four. Then last spring he started losing weight and his back ached, and by the time the doctors found the cancer in his pancreas, it had already spread to his liver. They were kind, but they were honest with us: there is no test that catches this early, nothing they would have thought to order for a man who felt fine. The chemotherapy bought him four months, most of them hard ones. He died eleven weeks after we first heard the word.

What we want is simple. We want a doctor, someday, to be able to find this disease while it can still be taken out — a blood test, anything, before it travels. And we want gentler treatments for the people who, like Dad, are found too late. If part of the gift could support a young researcher giving their career to this, that would have made him proud.

With gratitude,
Margaret
```

**Expect (primary).** pancreatic cancer

**Expect (supporting).** early detection of pancreatic cancer; cancer screening biomarkers; liver metastasis / metastatic spread; blood-based (liquid biopsy) diagnostics; chemotherapy for advanced pancreatic cancer; surgical resectability; treatment tolerability / supportive care

## Concepts vs. methods — the two rails

### 8. Cryo-EM platform RFP — the Method panel takes the 1.0

**Voice.** A structural-biology program officer at a private institute issuing a methods-development RFP

**Demonstrates.** The system can anchor centrality 1.0 on a METHOD/platform rather than a disease, even when several named diseases occupy the prose, because the funder is buying a technique.

**Watch for.** Watch the Method panel grab the top chip — the paste names neurodegeneration, cardiac arrhythmia, and antibiotic resistance, yet every disease term sinks to the bottom, because the funder is paying to advance the microscope, not to cure a disease.

```text
A 40-kilodalton membrane transporter in a lipid nanodisc still sits below the practical size limit for single-particle reconstruction; a conformationally heterogeneous signaling complex still averages into featureless density; a transient catalytic intermediate inside an unbroken cell still has nowhere to be caught. Those failures, not one more static structure, are what this call is meant to attack, and they have to be attacked at the level of the platform. We are interested in robust cryo-electron tomography of intact cells, in cryo-focused-ion-beam milling that yields thin lamellae reproducibly rather than heroically, and in sub-tomogram averaging that reaches near-atomic resolution in situ. Time-resolved cryo-electron microscopy is a priority: microfluidic mixing-and-spraying devices that vitrify conformational intermediates on the millisecond timescale. So are integrative pipelines that fuse AlphaFold-derived predictions with sparse experimental density to build and validate models of flexible, low-abundance complexes. Advances in sample vitrification, grid reproducibility, direct-detector performance, and automated particle picking are equally welcome. Applicants should explain how a proposed innovation generalizes across the hard target classes — G-protein-coupled receptors, voltage-gated ion channels, ABC transporters — rather than rescuing a single specimen. Neurodegeneration, cardiac arrhythmia, and antibiotic resistance sit behind this program as long-term motivations, but the review panel will weight demonstrated technical advance of the imaging platform far above any single disease application. Preliminary data showing a reusable, shareable methodological gain carry the most weight of all.
```

**Expect (primary).** cryo-electron microscopy (kind: method, centrality 1.0)

**Expect (supporting).** cryo-electron tomography (method, mid); sub-tomogram averaging (method, mid); cryo-focused-ion-beam milling / lamella preparation (method, mid); time-resolved cryo-EM (method, mid); AlphaFold-assisted model building / integrative modeling (method, mid); single-particle reconstruction (method, mid); membrane proteins (concept, low-mid); G-protein-coupled receptors / ion channels / ABC transporters (concept, low); neurodegeneration / cardiac arrhythmia / antibiotic resistance (concept, 0.1-0.2)

### 9. Organoid platform RFP, no single disease

**Voice.** A research foundation's program officer, writing a formal RFP

**Demonstrates.** Method-primary extraction that stays disease-agnostic: the system ranks the organoid platform as the sole 1.0 target and refuses to invent a dominant disease despite gut, lung, brain, and tumor all being named.

**Watch for.** Watch that even though the text names gut, lung, brain, and tumor organoids, the system holds "patient-derived organoids" as the lone 1.0 primary and scatters every disease down at 0.1-0.2 — it never promotes cancer, or any one organ, into the top slot. The opening drug-failure vignette should not be read as a pharmacology or drug-screening target in its own right.

```text
A compound that clears an immortalized cell monolayer tells you almost nothing about what a given person's epithelium will do when it meets that same drug: the dish has no crypt architecture, no autologous immune cells, no mechanical load, and no donor. That gap, between what a culture well can report and what a patient's tissue actually does, is the subject of this call. We fund the technology itself and treat patient-derived organoids as the object of study rather than a vehicle for any single indication; intestinal, airway, cerebral, tumor, kidney, and hepatic systems are weighed equally. Priorities include raising derivation efficiency from limited or cryopreserved biopsy material; driving organoids past fetal-like states toward adult cell-type diversity and function; engineering perfusable vascular networks to relieve the necrotic core that caps organoid size; co-culture that restores the autologous immune compartment, including tissue-resident macrophages and tumor-infiltrating lymphocytes; and microfluidic organ-on-chip formats that impose physiological shear and mechanical cues. Fidelity must be quantified against matched primary tissue using single-cell and spatial transcriptomics. We are especially interested in pharmacotyping pipelines whose drug-response readouts track prospectively with clinical outcome. Awards support methods development and cross-disease validation; a protocol that only one laboratory, in one disease, can execute has not yet succeeded.
```

**Expect (primary).** patient-derived organoids (method)

**Expect (supporting).** organoid derivation efficiency; organoid maturation / adult cell-type differentiation; perfusable vascularization; autologous immune cell co-culture; microfluidic organ-on-chip; benchmarking against primary tissue via single-cell and spatial transcriptomics; drug-response prediction / pharmacotyping; individual disease areas (intestinal, airway, cerebral, tumor, kidney, hepatic) — each expected at low centrality 0.1-0.2, none dominating

### 10. IRD gene-therapy RFP — modality and disease braided in one sentence

**Voice.** A vision-research foundation's program officer, formal RFP register

**Demonstrates.** The extractor cleanly separates a densely interwoven paste into disease/gene CONCEPTS and gene-therapy modality METHODS instead of collapsing "base editing of rhodopsin P23H" or "AAV gene augmentation for RPE65" into single blended tags.

**Watch for.** Watch how one clause — "base editing aimed at recurrent point mutations, of which rhodopsin P23H in autosomal dominant retinitis pigmentosa is the paradigm" — gets split: the disease and the gene land in the Concept panel while the editing and delivery modalities land in Methods, instead of fusing into a single tag. Base editing and allele-specific knockdown should also stay distinct methods rather than clustering, since they attack the same dominant allele by different means.

```text
A single subretinal injection has already restored useful vision in one genetic form of childhood blindness. That success now defines our agenda largely by what it left undone: gene augmentation rescues recessive loss-of-function lesions in genes small enough to fit inside an AAV capsid, and it does nothing for dominant gain-of-function alleles, nothing for genes too large to package, and nothing for the deep-intronic splice-altering variants that dominate several of these disorders. We therefore solicit preclinical programs that close those gaps in inherited retinal degeneration, including retinitis pigmentosa, Leber congenital amaurosis, Stargardt disease, and Usher syndrome.

Because the strategy must be matched to the lesion, we welcome work across the modality spectrum: AAV-mediated gene augmentation delivered by subretinal injection, as in RPE65-associated disease; in vivo adenine and cytosine base editing aimed at genuinely recurrent point mutations, of which rhodopsin P23H in autosomal dominant retinitis pigmentosa is the paradigm; allele-specific knockdown of that same toxic transcript; splice-modulating antisense oligonucleotides for CEP290- and USH2A-associated disease; and dual-vector or overlapping-AAV designs that defeat the packaging limit for ABCA4 and MYO7A. Capsid engineering for photoreceptor tropism, promoter selection, and immune responses to subretinal vector are equally in scope.

We will read most closely for a genotype-to-phenotype rationale interrogated in patient-derived retinal organoids or an informative animal model, and for a defensible route to first-in-human study. Awards support two years of preclinical work; clinical-stage programs are out of scope.
```

**Expect (primary).** inherited retinal degeneration

**Expect (supporting).** AAV subretinal gene delivery (method); base editing (method); allele-specific knockdown (method); antisense oligonucleotides (method); dual-vector AAV gene delivery (method); retinitis pigmentosa (concept); Leber congenital amaurosis (concept); Stargardt disease (concept); Usher syndrome (concept)

### 11. Global-health funder: broadly protective vaccines (methods vs. threats)

**Voice.** A program officer at a global-health foundation

**Demonstrates.** Platform methods and pathogen-family concepts coexist in a single funder call and split cleanly across the Method and Concept panels, with heavily-worded delivery tech held at supporting centrality below the immunological target it serves.

**Watch for.** Watch the platform terms — mRNA, self-amplifying RNA, nanoparticle display — drop cleanly into the Method panel while the pathogen families and the broadly protective vaccine target hold the Concept panel, and notice the delivery tech never outranks the immunological goal it serves despite filling half the prose.

```text
The last decade taught us that chasing one pathogen at a time is a losing game. Our foundation is redirecting its infectious-disease portfolio toward vaccines that protect broadly — against entire viral families rather than single strains — so the next spillover meets a world already defended. We want teams pursuing durable, broadly protective immunity across the coronaviruses and the influenza A subtypes most likely to seed a pandemic, working from a prototype-pathogen logic in which what we learn from one family member generalizes to the rest.

Mechanistically, we are drawn to elicitation of broadly neutralizing antibodies through germline-targeting immunogen design and structure-based nanoparticle display, and to vaccines that engage mucosal immunity at the respiratory surfaces where transmission actually starts. Delivery matters as much as the antigen: we will back mRNA and self-amplifying RNA platforms that can be reprogrammed and released quickly. We are equally serious about defining robust correlates of protection, because without them no rapid-response effort can move confidently from sequence to shots.

Finally, none of this serves a low-income setting if it cannot be made there, so proposals should address distributed, rapid-response manufacturing. Award ceilings and project periods are set out in the attached terms.
```

**Expect (primary).** Broadly protective vaccines

**Expect (supporting).** Broadly neutralizing antibodies (concept); Mucosal immunity (concept); Correlates of protection (concept); mRNA and self-amplifying RNA vaccine platforms (method); Germline-targeting immunogen design (method); Structure-based nanoparticle immunogen display (method); Prototype-pathogen approach across coronaviruses and influenza A (concept); Rapid-response distributed manufacturing (method)

## What is the funder actually buying?

### 12. Maternal mortality RFP — the 1.0 target is a population, not a disease

**Voice.** A maternal-health foundation's program officer, writing a formal RFP

**Demonstrates.** Proves the extractor will seat a POPULATION (pregnant and postpartum people) as the sole 1.0 primary target and demote the five diseases that dominate the prose — preeclampsia, postpartum hemorrhage, peripartum cardiomyopathy, maternal sepsis, VTE — to the 0.3-0.5 "means to the end" band, instead of defaulting to whichever disease got the most words.

**Watch for.** Watch what does NOT win: preeclampsia and postpartum hemorrhage get the most ink in this RFP, but the system pins centrality 1.0 on the population — pregnant and postpartum people — and drops every named condition into the 0.3-0.5 "means to the end" band, which is why a maternal health-services researcher can outrank a card-carrying preeclampsia bench scientist.

```text
The United States is the outlier among wealthy countries in maternal death: mothers here die at several times the rate of peers abroad, and review committees judge most of those deaths preventable. This program funds work that keeps pregnant and postpartum people alive — through pregnancy, delivery, and the full year after birth, including the late deaths that 42-day surveillance windows never count.

We are agnostic about the clinical entry point. Applicants may pursue hypertensive disorders of pregnancy, including preeclampsia with severe features and eclampsia; postpartum hemorrhage and the coagulopathies that complicate it; peripartum cardiomyopathy and other cardiovascular contributors to late maternal death; maternal sepsis; venous thromboembolism; or the perinatal mental-health and opioid-overdose deaths that now rival any obstetric cause. These conditions interest us only insofar as they explain why mothers die and how to stop it; one treated as an end in itself, divorced from maternal survival, will not compete well here.

We take the same view of inequity. Black and Indigenous birthing people die at two to three times the rate of their white peers, a gap that persists after adjustment for income and education. Closing it is central to this charge, not an addendum to it.

Reviewers will weigh a team's command of maternal mortality review committee data, linked birth–death and Medicaid claims cohorts, severe maternal morbidity indices, community-engaged study design, and evaluation of care-delivery interventions such as obstetric hemorrhage bundles and postpartum remote blood-pressure monitoring.
```

**Expect (primary).** pregnant and postpartum people — maternal mortality and morbidity (concept; the POPULATION is the target, centrality 1.0)

**Expect (supporting).** hypertensive disorders of pregnancy / preeclampsia and eclampsia (concept, ~0.4-0.5 — a route to the target, not the target); postpartum hemorrhage (concept, ~0.4-0.5); peripartum cardiomyopathy (concept, ~0.3-0.4); maternal sepsis (concept, ~0.3-0.4); racial and ethnic inequities in maternal mortality (concept, ~0.4-0.5 — explicitly 'central, not an addendum', but still instrumental to the population target); severe maternal morbidity (concept, ~0.3-0.4 — an index/outcome measure serving the target); perinatal mental health and opioid overdose in the postpartum year (concept, ~0.3); maternal mortality review committee data and linked birth–death / Medicaid claims cohorts (method, ~0.2-0.3); venous thromboembolism (concept, ~0.1-0.2, incidental in a list)

### 13. Longevity foundation RFP — aging is the target, diseases are downstream

**Voice.** A longevity-focused foundation setting its funding thesis

**Demonstrates.** The extractor holds a single abstract target (the biology of aging) at centrality 1.0 while distributing eight named mechanisms below it and demoting three heavily-worded age-related diseases to incidental, because the prose frames them as downstream consequences rather than the thing being studied.

**Watch for.** Watch the biology of aging itself take the 1.0 while Alzheimer's, osteoarthritis, and cancer — which get a whole closing sentence of prose — land near the floor as downstream consequences, exactly the way a geroscientist would rank them.

```text
For too long, medicine has fought age-related disease one organ at a time. Our Foundation was built on a different premise: that aging itself is a modifiable process, and that slowing its underlying biology is the most powerful lever we have against the conditions it spawns. We fund investigators who treat aging as the primary target, not any single downstream pathology. We are drawn to the hallmarks that appear to drive the aging phenotype across tissues — cellular senescence and the senescence-associated secretory phenotype, the design and testing of senolytic agents such as dasatinib-plus-quercetin and Bcl-2/Bcl-xL inhibitors, mitochondrial dysfunction and collapsing NAD+ availability, loss of proteostasis and autophagic capacity, epigenetic drift as read out by DNA-methylation clocks, exhaustion of hematopoietic and muscle stem-cell pools, and nutrient-sensing through the mTOR, AMPK, and sirtuin axes that caloric restriction and rapamycin engage. Heterochronic parabiosis and circulating rejuvenation factors are of particular interest. We fully expect that intervening on these mechanisms will delay Alzheimer disease, osteoarthritis, sarcopenia, and cancer in parallel — but we ask applicants to keep the shared biology of aging, not any one of these conditions, at the center of the proposed work.
```

**Expect (primary).** Biology of aging (geroscience) — aging as a treatable process

**Expect (supporting).** cellular senescence / senescence-associated secretory phenotype; senolytics (dasatinib + quercetin, Bcl-2/Bcl-xL inhibitors); mitochondrial dysfunction / NAD+ decline; loss of proteostasis and autophagy; epigenetic clocks (DNA-methylation aging clocks); stem-cell exhaustion; mTOR / AMPK / sirtuin nutrient-sensing (caloric restriction, rapamycin); heterochronic parabiosis / circulating rejuvenation factors; Alzheimer disease (low — downstream consequence); osteoarthritis (low — downstream consequence); cancer (low — downstream consequence)

### 14. The foundation that funds all of mental health

**Voice.** foundation/institute RFP program officer

**Demonstrates.** Graceful handling of an intentionally over-broad sponsor: the extractor keeps one honest umbrella primary and distributes many disorders and modalities at mid centrality instead of inventing a narrow focus the funder never stated.

**Watch for.** Watch how it resists false precision — the only 1.0 is the umbrella "mental health," while a dozen named disorders and delivery modalities all settle into the honest middle band, which is exactly what this sponsor actually said.

```text
The mission of our Foundation is to reduce the burden of mental illness in all its forms, and this year's open call reflects that breadth deliberately. We will consider proposals across the full spectrum of psychiatric conditions — major depressive disorder, anxiety disorders, schizophrenia and other psychotic disorders, bipolar disorder, and post-traumatic stress disorder — as well as cross-cutting priorities in suicide prevention and the mental health of children and adolescents. We are equally open on approach: basic and translational neuroscience, clinical trials of established psychotherapies such as cognitive behavioral therapy, novel interventions including digital therapeutics and psychedelic-assisted treatment with psilocybin or MDMA, and health services research that improves access to care in underserved communities, whether through telepsychiatry, collaborative care in primary care settings, or task-sharing with community health workers. We do not privilege one level of analysis over another; a genome-wide association study of bipolar disorder, a smartphone-based ecological momentary assessment platform for adolescents at risk of self-harm, and a policy evaluation of school-based mental health screening are all equally responsive. Investigators at any career stage may apply, and we encourage teams that bridge disciplines. What matters to us is a rigorous question, a feasible plan, and a credible account of how the answer would eventually change what happens in a clinic, a classroom, or a waiting room.
```

**Expect (primary).** mental health

**Expect (supporting).** major depressive disorder; schizophrenia; post-traumatic stress disorder; suicide prevention; adolescent mental health; digital therapeutics; psychedelic-assisted therapy; access to mental health care

### 15. Climate-and-health RFP with no MeSH home

**Voice.** A program director at an environmental-health foundation

**Demonstrates.** A sponsor scope with no clean MeSH anchor, whose exposures scatter across six branches of the taxonomy, still resolves to a coherent, defensible ranked set of experts instead of an empty result.

**Watch for.** There is no single MeSH heading for "climate and health," and the exposures scatter across six corners of the tree — heat, smoke, mosquitoes, floods, hunger, trauma — yet watch the system return one coherent ranked panel instead of nothing, with the health outcomes on top and the epidemiology methods correctly demoted beneath them.

```text
For three decades our Foundation backed research on the ordinary exposures that make people sick — lead paint, diesel corridors, tainted well water. What preoccupies us now is broader and harder to pin down: climate change is quietly rewriting the map of human health, and we are opening this cycle to investigators who can document how.

The manifestations are scattered, which is exactly the problem. We want studies of extreme heat and the physiology of heatstroke during prolonged heat waves; of wildfire smoke and the cardiopulmonary damage from fine particulate matter (PM2.5); of dengue and Lyme disease pushing into latitudes and elevations that were until recently too cold for their vectors; of the malnutrition and diarrheal illness that trail climate-driven food and water insecurity; and of the depression, anxiety, and post-traumatic stress that follow displacement after floods and fires. We care most about those who absorb these shocks first: outdoor farm and construction workers, and low-income families in the urban heat islands our cities have built.

Methodologically, we expect environmental epidemiology anchored to satellite exposure mapping and downscaled climate projections, with community partners shaping the design rather than reviewing it at the end. The work we fund will trace the full chain and name the mechanism at each link: a heat wave to a farmworker's core-temperature crisis, a smoke plume to a week of cardiopulmonary admissions downwind, a shortened winter to a tick's new elevation.
```

**Expect (primary).** Human health effects of climate change

**Expect (supporting).** Extreme heat and heat-related illness (heatstroke); Fine particulate matter (PM2.5) / wildfire smoke air pollution; Vector-borne disease range expansion (dengue, Lyme disease); Climate-driven food and water insecurity (malnutrition, diarrheal disease); Mental health effects of displacement (post-traumatic stress, depression); Environmental health disparities / environmental justice (outdoor workers, urban heat islands); Environmental epidemiology (method); Remote-sensing exposure assessment and downscaled climate modeling (method)

## Discrimination — the near-miss the keyword would have caught

### 16. Obesity/GLP-1 RFP — metabolism, but not cancer metabolism

**Voice.** A disease foundation's program officer issuing a research RFP

**Demonstrates.** Context discrimination: the extractor recognizes energy-homeostasis/obesity metabolism as the target and does NOT conflate it with oncologic (cancer-cell) metabolism, despite heavy shared vocabulary (mitochondrial, lipid, adipose, glucose, fatty-acid flux), so tumor-metabolism labs do not surface.

**Watch for.** Watch the top hits come back as appetite-circuit and adipose-thermogenesis labs — and notice the tumor-metabolism group that lives on 'mitochondrial,' 'lipid,' and 'glucose' never appears, because the system weighted the obesity context, not the shared metabolism keywords.

```text
The Foundation is launching a program on the biology of durable weight loss. Incretin-based pharmacotherapy — GLP-1 receptor agonists such as semaglutide, and dual GLP-1/GIP agonists such as tirzepatide — has transformed obesity management, yet how the body defends its weight remains poorly understood. We are funding work that dissects the central and peripheral circuits governing energy balance: hypothalamic melanocortin signaling through AgRP and POMC neurons, MC4R- and leptin-responsive pathways, and the vagal–brainstem relays that convert gut-hormone signals into satiety. The energy-expenditure side interests us equally — adaptive thermogenesis, brown and beige adipose tissue, mitochondrial uncoupling via UCP1-dependent and -independent heat production, lipid handling in the adipocyte, and sympathetic control of glucose and fatty-acid flux. Pressing clinical problems are in scope: weight regain and metabolic adaptation after drug discontinuation, preservation of lean muscle mass during rapid weight loss, and durable remission of type 2 diabetes and steatotic liver disease after bariatric procedures such as Roux-en-Y gastric bypass and sleeve gastrectomy, including the contributions of bile acids, FGF19, and enteroendocrine L-cell secretion. Reviewers will weigh proposals chiefly on the depth of their metabolic phenotyping — indirect calorimetry, hyperinsulinemic-euglycemic clamps, single-nucleus profiling of hypothalamus and adipose depots — and on whether a candidate mechanism is carried from genetically engineered and diet-induced rodent models into human physiology studies.
```

**Expect (primary).** Energy homeostasis and body-weight regulation in obesity

**Expect (supporting).** GLP-1/GIP incretin receptor agonism (obesity pharmacotherapy); Hypothalamic melanocortin appetite circuits (AgRP/POMC, MC4R, leptin); Adaptive thermogenesis and brown/beige adipose tissue (UCP1, mitochondrial uncoupling); Weight regain and metabolic adaptation after drug discontinuation; Lean muscle mass preservation during weight loss; Bariatric surgery outcomes (RYGB, sleeve gastrectomy; bile acids, FGF19, L cells); Metabolic phenotyping methods (indirect calorimetry, hyperinsulinemic-euglycemic clamp); Single-nucleus RNA-seq of hypothalamus and adipose tissue

### 17. Allograft-tolerance RFP — adjacent immunology, not cancer immunotherapy

**Voice.** A solid-organ transplant foundation / institute program officer writing an RFP

**Demonstrates.** That the extractor resolves adjacent transplant immunology (Treg therapy, costimulation blockade, chimerism, DSA/AMR) to allograft-tolerance experts rather than collapsing into cancer-immunotherapy labs that share the same mechanistic vocabulary.

**Watch for.** Watch the top hits stay transplant immunologists — the Treg-therapy, chimerism, and belatacept labs — and not the checkpoint-blockade or CAR-T tumor-immunology crowd, even though the mechanistic vocabulary overlaps almost word for word. The opener's toll of immunosuppression (infection, skin cancer, PTLD, nephrotoxicity) is framing, not target: it should land at 0.1-0.2 centrality and must not pull dermatology, ID, or lymphoma labs to the top.

```text
Every transplant recipient makes the same bargain: a working kidney, liver, heart, or lung in exchange for a lifetime of immunosuppression — the opportunistic infections, the skin cancers and post-transplant lymphoproliferative disease, the drug nephrotoxicity — and an allograft that is often lost in the end anyway to chronic rejection. We fund the science that would retire that bargain: durable immunological tolerance to solid-organ allografts, meaning donor-specific unresponsiveness robust enough to support safe withdrawal of immunosuppression while the graft goes on working.

The mechanisms we most want interrogated are regulatory T-cell biology and adoptive Treg therapy; the induction of mixed hematopoietic chimerism through combined bone-marrow and organ transplantation; and costimulation blockade with agents such as belatacept and anti-CD40L. The humoral barrier matters just as much: how donor-specific HLA antibodies arise, how they drive antibody-mediated rejection and chronic allograft vasculopathy, and whether B-cell- and plasma-cell-directed strategies can forestall them. Work on T-cell-mediated rejection, memory alloreactivity, and the tolerance defects that follow viral infection is equally welcome.

Readouts should be serious ones — protocol allograft biopsies, donor-derived cell-free DNA surveillance, HLA single-antigen bead assays, flow-cytometric crossmatching, and single-cell profiling of graft-infiltrating lymphocytes. Nonhuman-primate studies and early-phase recipient cohorts are in scope, as is preclinical xenotransplantation pursued specifically as a route to tolerance induction.
```

**Expect (primary).** Immunological tolerance to solid-organ allografts (operational transplant tolerance / immunosuppression-free graft survival)

**Expect (supporting).** Regulatory T-cell (Treg) adoptive therapy; Mixed hematopoietic chimerism induction; Costimulation blockade (belatacept, anti-CD40L); Donor-specific antibodies (DSA) and antibody-mediated rejection; Donor-derived cell-free DNA monitoring (method); HLA single-antigen bead assay and flow-cytometric crossmatch (method); Chronic allograft vasculopathy (low centrality); Xenotransplantation (incidental, low centrality)

### 18. Non-opioid pain RFP, where "opioid" is a decoy

**Voice.** A private research foundation's program office, formal RFP

**Demonstrates.** The extractor locks onto the therapeutic target (non-opioid analgesia for chronic pain), treats the repeated "opioid" mentions as out-of-scope framing rather than the subject, and reaches both basic pain-neuroscience mechanists and clinical/translational pain researchers without drifting into opioid-addiction or substance-use expertise.

**Watch for.** Watch how often 'opioid' appears in the paste, yet not one addiction or substance-use researcher surfaces — the system reads those mentions as the thing the funder wants to move away from, and instead ranks sodium-channel and nociceptor mechanists right alongside clinical neuropathic-pain trialists.

```text
Chronic pain reaches roughly one in five adults, and the single answer medicine reached for at scale — opioid analgesia — manufactured a second catastrophe of dependence and overdose on top of the first. This call funds the way out of that trap, and the way out runs through the biology of pain itself rather than through the treatment of opioid dependence. We are looking for investigators who can explain how persistent pain is initiated, amplified, and maintained, and who can convert that insight into analgesics that do not act on the opioid receptor system.

Areas of particular interest include the molecular physiology of peripheral nociceptors and the dorsal root ganglion, with emphasis on voltage-gated sodium channels such as Nav1.7 and Nav1.8 and their role in aberrant neuronal excitability; the circuitry of central sensitization and impaired descending modulation that distinguishes neuropathic from nociplastic pain; and neuroimmune crosstalk, including microglial and satellite glial signaling that sustains chronic pain states. We equally welcome clinical and translational work — quantitative sensory testing, patient-derived iPSC sensory neurons, and rigorously designed trials of non-pharmacologic interventions such as neuromodulation and behavioral therapy.

A strong proposal names one mechanism, molecular or circuit-level, characterizes it well enough to be drugged, and shows why the resulting target would quiet intractable pain without recreating the dependence we are trying to escape.
```

**Expect (primary).** Non-opioid analgesia for chronic pain (non-opioid therapeutic targets for chronic pain)

**Expect (supporting).** Voltage-gated sodium channels Nav1.7 and Nav1.8 (SCN9A/SCN10A) — high rarity, mid centrality; Nociceptor biology and dorsal root ganglion sensory neurons; Central sensitization; Neuropathic pain vs. nociplastic pain; Descending pain modulation; Neuroimmune interactions — microglia and satellite glia; Non-pharmacologic interventions / neuromodulation (method); Quantitative sensory testing and patient-derived iPSC sensory neurons (methods)

### 19. Buprenorphine access, a policy funder's brief

**Voice.** a health-policy funder

**Demonstrates.** The extractor handles pure health-services/implementation-science prose with zero wet-lab content, ranking implementation and health-policy researchers rather than defaulting to neuropharmacologists.

**Watch for.** Notice every name that surfaces is a health-services or implementation scientist — no neuropharmacologists — and the concept list stays free of receptor pharmacology even though the paste explicitly names it, because the system reads it as an exclusion.

```text
Overdose deaths have fallen only where treatment actually reached people, and it still mostly doesn't. Our foundation's health policy program is directing its next round of grants at the question of why medication for opioid use disorder — buprenorphine above all — remains so hard to get in ordinary care settings, and what actually moves the needle. Two years after the X-waiver's elimination, most primary care practices and emergency departments still initiate few or no patients; prescribing authority turned out not to be the binding constraint. We want proposals that treat this as an implementation problem: hub-and-spoke arrangements linking addiction specialists to community practices, emergency department-initiated buprenorphine with warm handoffs to office-based treatment, strategies that address clinician stigma and low perceived self-efficacy, and the Medicaid reimbursement and prior-authorization levers that determine whether practices sustain these programs once grant funding ends. Harm reduction belongs in scope too: co-prescribed and community-distributed naloxone, fentanyl test strips, syringe services referral. We expect hybrid effectiveness-implementation designs, ideally type 2 or 3, with prespecified outcomes framed in RE-AIM terms — reach into rural and Medicaid-insured populations matters to us as much as retention in treatment. We are not funding receptor pharmacology or new molecules; the science we need is about delivery.
```

**Expect (primary).** buprenorphine treatment for opioid use disorder in primary care

**Expect (supporting).** emergency department-initiated buprenorphine; hub-and-spoke care model; clinician stigma toward addiction treatment; naloxone distribution / harm reduction; Medicaid reimbursement policy; hybrid effectiveness-implementation trial (method); RE-AIM framework (method)

## Range — straight, strong matches across the map

### 20. IBD microbiome RFP — bridging microbes and the clinic

**Voice.** A disease foundation's research office issuing a formal RFP

**Demonstrates.** Proves the extractor canonicalizes the acronym IBD and its subtypes (Crohn's disease, ulcerative colitis) to standard disease terms and ranks the host-microbe interface as the single primary target, forcing matches that span microbial ecology and clinical gastroenterology.

**Watch for.** Watch IBD resolve to inflammatory bowel disease — not a gene or an immune marker — and see the top matches pair a gut-microbial-ecology lab with a GI clinician, because the target is the interface between them, not either field alone.

```text
This program invites applications from investigators seeking to define how the intestinal microbiome shapes the onset and course of inflammatory bowel disease. We will fund mechanistic work on the host-microbe interface in Crohn's disease and ulcerative colitis: how shifts in bacterial and fungal community composition disrupt the mucosal barrier, and how microbial metabolites — short-chain fatty acids such as butyrate, secondary bile acids, and tryptophan-derived indoles — signal to the intestinal epithelium and the mucosal immune system. Of particular interest are studies that connect these signals to the dysregulated IL-23 and Th17 responses that sustain chronic inflammation in IBD. We encourage projects that move from description to causation, pairing shotgun metagenomics and untargeted metabolomics in patient cohorts with gnotobiotic and germ-free mouse models to test candidate strains. We especially welcome translational proposals that rationally design defined bacterial consortia or refine fecal microbiota transplantation into durable, mechanism-based therapies, moving beyond the variable results of current donor-stool approaches. The strongest applications will bridge clinical gastroenterology and gut microbial ecology, pairing endoscopic and histologic readouts with strain-level microbiology. Purely descriptive surveys of community composition, with no path to mechanism or intervention, fall outside the scope of this call.
```

**Expect (primary).** Gut microbiome in inflammatory bowel disease (the host-microbe interface)

**Expect (supporting).** Short-chain fatty acids / butyrate (concept, mid); Secondary bile acid metabolism (concept, mid); Tryptophan-derived indole metabolites (concept, mid); Intestinal mucosal barrier / epithelium (concept, mid); IL-23 / Th17 mucosal immune axis (concept, mid); Fungal community / mycobiome (concept, low-mid); Fecal microbiota transplantation (method, mid); Defined bacterial consortia (method, mid); Shotgun metagenomics + untargeted metabolomics (method, low-mid); Gnotobiotic / germ-free mouse models (method, low)

### 21. Preemptive pharmacogenomics RFP — genotyping is the method, ancestry is the second thread

**Voice.** A funding institute's program office issuing a formal RFP, opening on a single patient case before broadening to scope

**Demonstrates.** That the extractor keeps genotyping, sequencing, and EHR decision-support as methods subordinate to the clinical drug-response target; that the opening patient vignette's incidental details (colorectal cancer, capecitabine, neutropenic sepsis) stay low-centrality color rather than hijacking the target; and that a single equity clause about non-European ancestries recruits a distinct ancestry-diversity research community.

**Watch for.** Watch whether the vivid opening case pulls the target off course: colorectal cancer and neutropenic sepsis are narrative color and should score ~0.1-0.2, while DPYD–fluoropyrimidine toxicity registers as one gene-drug pair among several under the pharmacogenomics target. Genotyping, sequencing, and EHR decision-support should register as methods that SERVE that target rather than becoming it — and the single sentence about non-European ancestries should surface population-genetics and diverse-cohort researchers who never mention a drug.

```text
A woman with colorectal cancer receives a standard, correctly calculated dose of capecitabine and is dead six weeks later of mucositis, marrow failure, and neutropenic sepsis. Nothing was miscalculated; she carried two reduced-function DPYD alleles that no one had thought to look for. Cases like hers frame this solicitation. We support mechanistic and translational work on well-established gene-drug relationships—CYP2C19 loss-of-function alleles and impaired clopidogrel bioactivation, DPYD variants that predispose to severe fluoropyrimidine toxicity, HLA-B*57:01 and abacavir hypersensitivity—and on the polygenic contributions that shape variable drug metabolism and response beyond any single locus. The aim throughout is individualized drug response, with fewer adverse reactions and better first-dose efficacy, as ordinary practice rather than a salvage measure taken after harm. We are particularly interested in projects that embed preemptive panel-based genotyping in the electronic health record and return point-of-care clinical decision support, so that a prescriber is warned before an at-risk drug is ever ordered. We further regard the underrepresentation of non-European ancestries in pharmacogenomic reference data as both a scientific and an ethical liability, and encourage studies that generate allele-frequency and clinical-outcome data in ancestrally diverse cohorts, so that genotype-guided prescribing narrows rather than widens existing disparities in care. Awards support multi-year, multidisciplinary teams; letters of intent precede the full submission.
```

**Expect (primary).** Pharmacogenomics (genotype-guided individualized drug response)

**Expect (supporting).** Preemptive panel-based genotyping (method, ~0.4); EHR-embedded clinical decision support (method/implementation, ~0.4); Polygenic scores / polygenic contributions to drug response (method-concept, ~0.4); DPYD–fluoropyrimidine toxicity (gene-drug concept, mid — carries the opening case); CYP2C19–clopidogrel response (gene-drug concept, mid); HLA-B*57:01–abacavir hypersensitivity (gene-drug concept, mid); Ancestral diversity / underrepresentation of non-European ancestries in reference data (equity concept, mid — second community); Adverse drug reactions / drug toxicity (concept, low-mid); Colorectal cancer, capecitabine chemotherapy, neutropenic sepsis (incidental vignette detail, ~0.1-0.2 — should NOT recruit oncology or infectious-disease researchers)

### 22. Sleep & circadian FOA, molecular clock through bedside CBT-I

**Voice.** A sleep-and-circadian research foundation issuing an open RFP

**Demonstrates.** Proves the extractor holds a single research domain together across its full basic-to-clinical span, unifying molecular-clock genetics and bedside sleep medicine under one primary target instead of fragmenting into a molecular list and an unrelated clinical list.

**Watch for.** Watch it file bedside CBT-I and molecular CLOCK/BMAL1 biology under one domain and surface researchers who actually bridge bench to clinic, rather than splitting into a molecular-genetics list and a separate sleep-clinic list.

```text
A transcription-translation feedback loop keeps time in nearly every cell of the body, and modern life overrides it almost nightly: electric light long after dusk, rotating shift schedules, transmeridian travel, and screens that push sleep later while the alarm clock stays put. Our Foundation funds work that follows the consequences of that override from the oscillator to the bedside. On the mechanistic side we support study of the core clock, CLOCK and BMAL1 driving the period and cryptochrome repressors, with the REV-ERB and ROR loops stabilizing the cycle, and of how the suprachiasmatic nucleus entrains peripheral clocks in liver, heart, and immune tissue. We are equally invested in the homeostatic arm of sleep regulation: adenosine signaling, orexinergic arousal circuits, and the sleep-dependent glymphatic clearance of amyloid-beta and other metabolic waste.

That biology has to be carried into the clinic. We encourage studies of circadian misalignment in night-shift workers, of obstructive sleep apnea and intermittent hypoxia, and of chronic insomnia and its behavioral treatment with CBT-I. We want to understand how disrupted timing raises cardiometabolic and neurodegenerative risk, from hypertension and insulin resistance to tau and amyloid deposition in Alzheimer's disease. Reviewers will look hardest at whether an applicant can phenotype timing rigorously, using polysomnography, wrist actigraphy, and dim-light melatonin onset, and still say what those measurements mean back at the level of the molecular clock.
```

**Expect (primary).** circadian rhythm regulation

**Expect (supporting).** CLOCK/BMAL1 transcription-translation feedback loop; suprachiasmatic nucleus; sleep-wake homeostasis (adenosine signaling); glymphatic clearance; obstructive sleep apnea; cognitive behavioral therapy for insomnia (CBT-I); shift work circadian misalignment; polysomnography and actigraphy

### 23. Global-health TB diagnostics call — sputum-free, MDR/XDR resolve

**Voice.** A global-health foundation issuing a call for point-of-care TB diagnostics

**Demonstrates.** From a single global-health diagnostics brief the system reaches infectious-disease, diagnostics-engineering, and biomarker/transcriptomics researchers at once, weights the diagnostic target above the disease itself, and canonicalizes TB / MDR-TB / XDR-TB abbreviations to their standard medical terms.

**Watch for.** Watch TB, MDR-TB, and XDR-TB all collapse to their standard medical terms, and notice the top hits aren't only TB clinicians — diagnostics engineers and blood-transcriptomic biomarker labs surface too, pulled in by 'host-response signature' and 'drug-susceptibility testing' even though the funder never named a single gene.

```text
Tuberculosis still kills more people than any other single infectious agent, and the failure starts at diagnosis. The patients our current sputum-based tests miss most often — young children who cannot produce a specimen, people living with HIV and advanced immunosuppression, and those already carrying drug-resistant strains — are precisely the ones who die waiting. Our Foundation wants to change where and how TB is found. We are backing teams building diagnostics that work in primary clinics and community health posts: no laboratory bench, intermittent power, no trained microscopist.

We are especially interested in tests that do not depend on expectorated sputum — tongue-swab sampling, urine lipoarabinomannan, and stool-based assays for children — and in host-response biomarker signatures, including whole-blood transcriptomic panels, that can triage active disease before culture returns. Rapid, decentralized drug-susceptibility testing is a priority: same-visit detection of rifampicin, isoniazid, fluoroquinolone, and bedaquiline resistance, whether by targeted sequencing or line-probe assay, so that MDR-TB and XDR-TB patients begin effective regimens the day they present. We expect performance to be established in HIV-coinfected adults and in children, and to be measured through active case-finding across high-burden districts, where most transmission is happening well outside the clinic walls. The standard we are funding toward is a tongue swab collected at a community health post that returns a rifampicin-resistance call before the patient walks home.
```

**Expect (primary).** Point-of-care tuberculosis diagnostics (decentralized testing in low-resource settings)

**Expect (supporting).** Drug-susceptibility testing for multidrug-resistant tuberculosis (MDR-TB); Extensively drug-resistant tuberculosis (XDR-TB); Host-response biomarker signatures / whole-blood transcriptomic panels; Sputum-free sampling (tongue swab, urine lipoarabinomannan, stool assays); HIV-tuberculosis coinfection; Pediatric (childhood) tuberculosis; Active case-finding in high-burden settings; Targeted sequencing / line-probe assays for resistance detection

### 24. Engineer's foundation: soft-robotic stroke rehab, spanning two faculties

**Voice.** A foundation founded and run by engineers, funding devices that restore movement

**Demonstrates.** That a single funder paste can correctly span an engineering-heavy and a clinical-heavy researcher set — a genuinely cross-disciplinary match — instead of collapsing onto one field.

**Watch for.** Watch the ranked list straddle two faculties at once — a soft-actuator control engineer and a stroke-rehabilitation clinician surfacing side by side — because the system pinned the clinical recovery goal at centrality 1.0 and treated all the device wizardry as the means, not the target.

```text
Our Foundation was established by engineers, and we fund accordingly. We back teams building wearable technology that restores voluntary movement to people living with hemiparesis after stroke. The goal that anchors every award is functional motor recovery of the paretic arm and leg — measured, durable, and meaningful in daily life, not just on a lab bench. We want investigators who treat the impaired limb and the reorganizing brain as one control loop.

On the hardware side, we favor soft, textile-based actuators and lightweight exosuits that assist reach and grasp without the bulk of rigid exoskeletons. On the signal side, we are drawn to high-density surface EMG decoding and to brain-computer interfaces, invasive or noninvasive, that read movement intent and drive assistance in real time. We are especially interested in closed-loop functional electrical stimulation timed to a patient's own effort, because well-timed stimulation is what turns assisted motion into lasting neuroplastic change in the motor cortex.

Competitive proposals pair serious device engineering with real rehabilitation science: longitudinal trials, validated upper-limb and gait outcomes such as Fugl-Meyer scores and ten-meter walk speed, and honest attention to how people use these systems at home. Bench-only or clinic-only teams will struggle here. Bring both.
```

**Expect (primary).** Post-stroke motor rehabilitation (functional motor recovery of the paretic limb after stroke)

**Expect (supporting).** Soft robotic exosuit / wearable soft actuator (method, mid); Brain-computer interface (method/concept, mid); Surface EMG decoding of movement intent (method, mid); Closed-loop functional electrical stimulation (method, mid); Motor cortex neuroplasticity (concept, mid — mechanism serving recovery); Upper-limb and gait outcome measures / Fugl-Meyer Assessment, ten-meter walk test (method, low-mid); Hemiparesis (concept, low)

### 25. Smartwatch AF detection — engineering prose, cardiology target

**Voice.** A digital-health funder's program lead, blunt and impatient, writing an open call

**Demonstrates.** That centrality, not rarity, picks the target: the system holds the primary on a corpus-common cardiology concept (wearable-based atrial fibrillation detection) while demoting the corpus-rare sensor engineering that dominates the prose (photoplethysmography, single-lead ECG) to supporting methods, and still surfaces the clinical-epidemiology concepts (overdiagnosis, anticoagulation, equity of access) instead of discarding them as boilerplate.

**Watch for.** "Photoplethysmography" is the rarest term on this page and "atrial fibrillation" is one of the most common in our corpus — so a rarity-only ranker would hand you signal-processing engineers; watch centrality pin the primary on the cardiology target and push the sensor methods down to supporting, so the top of the list is people who actually detect arrhythmia in patients.

```text
Here is the problem. Paroxysmal and subclinical atrial fibrillation are silent. The first symptom is often a stroke. Consumer wearables were supposed to fix that. So far they have mostly produced pilot studies. We want to know whether the devices actually work. Wrist photoplethysmography. Smartwatch single-lead ECG. Validate the detection algorithms against ambulatory patch-monitor ground truth, not curated laboratory recordings. Then tell us what happens after the alert fires, because that is where this usually falls apart. Most alerts are wrong. False positives flood primary care. Overdiagnosis medicalizes benign ectopy. Somebody starts a low-risk patient on a direct oral anticoagulant and calls it prevention. It is harm. So give us a defensible threshold. At what point does a device-detected atrial high-rate episode move a patient's CHA2DS2-VASc stroke risk enough to justify anticoagulation? Answer that question. Signal quality degrades under motion, across skin tones, and at high ectopic burden. Measure it. Report it. Then tell us who owns the watch. Adherence and equity of device access across age, income, and rural communities are not footnotes; a device nobody wears detects nothing. The bar is real-world evidence. Prospective validation cohorts. Pragmatic trials. Numbers a guideline committee could act on tomorrow.
```

**Expect (primary).** wearable-based atrial fibrillation detection and remote rhythm monitoring

**Expect (supporting).** photoplethysmography (method, mid); single-lead electrocardiography (method, mid); subclinical atrial fibrillation and stroke risk (concept, mid); false-positive burden and overdiagnosis (concept, mid); oral anticoagulation decision-making and CHA2DS2-VASc stroke risk stratification (concept, mid); detection-algorithm validation against ambulatory ECG monitoring (method, mid); real-world evidence and pragmatic clinical trials (method, low-mid); adherence and equity of device access (concept, low)

## Not just grants — the console as an expert finder

### 26. ADC linker biotech emails the licensing office

**Voice.** A business-development scout at a mid-size oncology biotech, emailing a university technology-licensing office

**Demonstrates.** The extractor works on a real industry outreach email — pulling the sought research capabilities out of antibody-drug conjugate deal prose while discarding the NDA, the sponsored-research agreement, the company name, and the sender's own platform pitch.

**Watch for.** Watch the NDA, the sponsored-research agreement, and the company name vanish — and notice the site-specific conjugation platform, which eats the most words, land as a supporting method rather than the headline, while antibody-drug conjugates and the HER2-low resistance biology rise to the top.

```text
Subject: Potential ADC collaboration — payload and resistance biology

Hello,

I lead scouting for external partnerships at a mid-size oncology company, and your technology-transfer page pointed me your way. Over the past four years we've built and validated a site-specific conjugation platform — engineered cysteines plus a transglutaminase route — that gives us homogeneous, DAR-controlled antibody-drug conjugates on a stable, protease-cleavable linker. The chemistry is in good shape. Our gap is on the biology side, and that's where an academic partner would come in.

Three capabilities in particular. We want deeper work on bystander-effect payloads — membrane-permeable topoisomerase I inhibitors of the exatecan/DXd class that can reach antigen-negative cells in heterogeneous tumors. We also need someone who genuinely understands acquired resistance to ADCs in HER2-low breast cancer: antigen downregulation, defective lysosomal processing and impaired linker cleavage, and efflux through P-glycoprotein. A group running patient-derived xenografts with payload-trafficking and internalization readouts would be ideal.

If there's mutual interest, we'd put an NDA in place first and then structure a sponsored-research agreement with milestone-based funding. Happy to share the platform deck once we're covered.

Best,
Dana Whitfield
Business Development, Northlake Therapeutics
South San Francisco, CA
```

**Expect (primary).** Antibody-drug conjugates (ADCs)

**Expect (supporting).** Bystander-effect payloads / bystander killing (concept, mid centrality); Acquired resistance to ADCs (concept, mid centrality); HER2-low breast cancer (concept, mid centrality); Topoisomerase I inhibitor payloads, exatecan/DXd class (concept, mid-low centrality; canonicalized from 'DXd'); Site-specific conjugation via engineered cysteine / transglutaminase (method, low centrality — the sender's own platform, demoted despite dominating the prose); Protease-cleavable linker chemistry (method, low centrality); Drug efflux via P-glycoprotein (concept, low centrality; canonicalized from P-gp); Patient-derived xenografts (method, low centrality)

### 27. Symposium chair hunting for CAR T toxicity speakers

**Voice.** A symposium program chair emailing a colleague on a deadline to fill three session slots

**Demonstrates.** The console is a general expert finder, not just a grant matcher: it lifts the research concepts out of a speaker-recruitment email, discards all the logistics, and ranks people by expertise.

**Watch for.** Notice nobody is being funded here — the honorarium, the flights, the November 14th date and the 25-minute slots all get thrown away, and what surfaces is a ranked list of CAR T toxicity experts.

```text
Ravi — I'm pulling together the CAR T-cell toxicity session for the fall symposium and I'm right up against the deadline on speakers. The program committee approved three talks, 25 minutes each plus five for questions, on the morning of November 14th. Honorarium is $1,500 per speaker and we cover flights and two nights' lodging, so please pass names along freely.

Here's the shape I'm after. First talk: the mechanisms driving cytokine release syndrome after CAR T infusion — ideally someone deep on the IL-6 and IL-1 axis and monocyte-macrophage activation, with a view on why tocilizumab rescues some patients and not others and where IL-1 blockade with anakinra fits. Second: immune effector cell-associated neurotoxicity syndrome — blood-brain barrier breakdown, endothelial activation, and why ICANS so often trails CRS by a few days. Third, the slot I most need to fill: predicting severe toxicity before it declares itself — early biomarkers like ferritin, CRP, and peak cytokine trajectories, and how the ASTCT consensus grading is holding up at the bedside.

If you can get me two or three names by Friday, I can still fit them into the printed program. Truly grateful — this session always fills the room.
```

**Expect (primary).** CAR T-cell therapy toxicity

**Expect (supporting).** cytokine release syndrome; immune effector cell-associated neurotoxicity syndrome (ICANS); IL-6 signaling; tocilizumab; monocyte-macrophage activation; IL-1 blockade (anakinra); prediction of severe toxicity / toxicity biomarkers (ferritin, C-reactive protein); ASTCT consensus grading

### 28. Long COVID feature, reporter on Friday deadline

**Voice.** A health journalist on deadline emailing a university press office

**Demonstrates.** An informal, urgent, jargon-free email from a non-scientist still resolves to precise canonical medical concepts, while the reporter's logistics (deadline, phone-call request) are correctly ignored.

**Watch for.** She never uses a single medical term — she says "flattened for days after mild activity" and "heart pounds when they stand up" — yet watch it surface post-exertional malaise and POTS, canonicalize "long COVID" to PASC, and throw away the Friday deadline and the phone-call ask entirely.

```text
Hi there, hoping you can point me to someone fast. I'm a health reporter with a feature on long COVID due Friday, and I need a faculty expert who can actually talk mechanism, not just "we need more studies."

Here's what I keep running into with patients. A lot of them describe getting completely flattened for days after even mild activity — grocery shopping, a short walk — this delayed crash that doesn't feel like ordinary tiredness. Others tell me their heart pounds and they get dizzy or nearly faint whenever they stand up, and one clinician told me that's basically its own condition. I've also seen the argument that fragments of the virus linger in the gut and other tissue months after people test negative, and separately that the immune system starts making antibodies against the body's own proteins. Several sources keep comparing all of this to the post-viral fatigue illness people got after mono and other infections. And I really want to nail down why the treatment trials so far have mostly come up empty.

Any chance one of your researchers could do a 15-minute phone call today or tomorrow? I can work entirely around their schedule. I don't need them to dumb it down — just someone credible and quotable. Thank you!
```

**Expect (primary).** Long COVID (post-acute sequelae of SARS-CoV-2 infection / PASC)

**Expect (supporting).** post-exertional malaise; autonomic dysfunction / POTS (dysautonomia); viral persistence / viral reservoir; immune dysregulation and autoantibodies; myalgic encephalomyelitis / chronic fatigue syndrome (ME/CFS); therapeutic clinical trials

### 29. Phase 3 pediatric asthma trial — a CRO hunting for a site PI

**Voice.** A CRO feasibility manager cold-emailing a prospective site principal investigator

**Demonstrates.** That the extractor promotes a trial's PEDIATRIC population constraint to a first-class research concept — surfacing investigators who actually see 6-to-17-year-olds with severe asthma — while discarding the feasibility boilerplate (site counts, central IRB turnaround, CDA, per-patient grant, questionnaire deadline) that eats a third of the email.

**Watch for.** Watch "aged 6 to 17" survive as a concept rather than get thrown out as an eligibility rule — the adult severe-asthma heavyweights fall below people who actually run a pediatric airway clinic, while the CDA, the central IRB and the per-patient grant vanish completely.

```text
Following up on the intro from last week. I'm running site feasibility for a phase 3 program and I need to know fast whether you'd take this on as site PI, because our pediatric footprint is thin and I'd rather find out now than in October.

The asset is a fully human monoclonal antibody against thymic stromal lymphopoietin, dosed every four weeks. Population is children and adolescents aged 6 to 17 with severe eosinophilic asthma still uncontrolled on high-dose ICS-LABA. We stratify on prior anti-IL-5 exposure, since a good share of these kids have already cycled through an anti-eosinophil biologic. Primary endpoint is the annualized severe exacerbation rate; secondaries are pre-bronchodilator FEV1, ACQ-7, and oral corticosteroid burden.

What I actually need from a site: a real panel of severe pediatric asthmatics, not an adult clinic with the occasional 16-year-old. Two or more exacerbations in the prior year, screening blood eosinophils at or above 150 cells/µL, FeNO on site, spirometry with reversibility to ATS/ERS standards, and coordinators who have done adolescent assent before. Prior phase 2/3 experience in type 2 airway inflammation is a plus.

Ballpark: 10-14 randomized per site over an 18-month window, 130 sites, 21 countries. Central IRB. I'd need your IRB turnaround estimate and an executed CDA before the questionnaire closes on the 30th; per-patient grant is negotiable.
```

**Expect (primary).** severe eosinophilic asthma

**Expect (supporting).** pediatric population — children and adolescents aged 6-17 (the demo's point: a first-class concept, expected mid-high, not discarded as an eligibility rule); thymic stromal lymphopoietin (TSLP) as a therapeutic target / anti-TSLP monoclonal antibody (mechanism serving the target, mid); interleukin-5 pathway and anti-IL-5 (anti-eosinophil) biologics (mid); type 2 airway inflammation and blood eosinophil count as a biomarker (mid); severe asthma exacerbations / annualized exacerbation rate (mid); spirometry with bronchodilator reversibility, FEV1 (method, low-mid); fractional exhaled nitric oxide (FeNO) testing (method, low-mid); high-dose inhaled corticosteroid plus long-acting beta-agonist maintenance therapy (incidental, low)

### 30. AMR one-liner: two-sentence year-end note

**Voice.** A program officer firing off a two-sentence note

**Demonstrates.** The extractor produces a correct, ranked concept set from a two-sentence scrap with no RFP structure, ignoring award mechanics and deadlines.

**Watch for.** Watch it throw away the year-end money and the fiscal deadline entirely and still lock onto carbapenem resistance as the 1.0 target from a 39-word scrap, no formal RFP required.

```text
I've got year-end discretionary money to move before the fiscal close and want to find anyone working on gram-negative resistance, especially carbapenem-resistant Enterobacterales and Acinetobacter. New antibiotic classes or resistance-breaking adjuvants are very much in scope, so send names.
```

**Expect (primary).** Carbapenem-resistant gram-negative bacteria (antimicrobial resistance)

**Expect (supporting).** Gram-negative bacterial infections; Novel antibiotic classes / antibiotic discovery; Carbapenem-resistant Enterobacterales; Acinetobacter baumannii; Beta-lactamase inhibitors / resistance-breaking adjuvants; Carbapenemase enzymes

## Stress test — expected to expose a gap, not to impress

This one is here because it is the most likely way the extractor is wrong today. The extraction prompt
(`lib/api/sponsor-match-extract.ts`) says nothing about **negation** — it asks for the concepts a funder
wants funded, and a model reading for salient noun phrases may happily return the diseases a sponsor
explicitly *excluded*. Run it before a demo, not during one.

### 31. The exclusion list — an NF1 foundation that spends most of its RFP saying no

**Voice.** A disease-foundation program announcement written defensively. Scope is stated as a long, weary, itemized list of what the Foundation will NOT fund — sporadic glioblastoma, Alzheimer disease, breast cancer, dry-lab-only work, animal-only work — before it ever says what it will fund. Bureaucratic, emphatic, and (deliberately) front-loaded with the wrong nouns.

**Demonstrates.** This is a STRESS TEST, and it is designed to possibly fail. The capability under test is negation handling. Roughly half the paste is exclusions, and the excluded diseases are named explicitly, repeatedly, and with rich domain vocabulary attached (temozolomide, amyloid-beta, tau, HER2, triple-negative). The real target — neurofibromatosis type 1 — appears later and, by raw term frequency, is not obviously dominant. The extractor's prompt says nothing about negation: it is told to find salient research concepts and methods, not to check the polarity of the sentence they sit in. So a purely salience-driven read may hand back glioblastoma, Alzheimer disease, and breast cancer as things this funder WANTS, which is the exact opposite of what the sponsor said. We do not know which way this goes. That is the point of running it.

**Watch for.** This is the stress test's whole reason for existing, so grade it hard and honestly.

PRIMARY FAILURE: any excluded disease appearing in the concept rail with non-zero centrality. Specifically glioblastoma, Alzheimer disease (or amyloid/tau/alpha-synuclein/ALS/Parkinson), or breast cancer (or HER2/triple-negative/BRCA1/2). The sponsor said the exact opposite of what such a chip asserts. Severity ladder: (a) present at low centrality = wrong but survivable; (b) present at 0.3-0.5, i.e. ranked as a mechanism serving the target = clearly wrong; (c) any of them assigned centrality 1.0 as the primary = total inversion, the demo is a failure and should be reported as one.

DOWNSTREAM SYMPTOM: the researcher list is where this becomes visible and embarrassing. If a neuro-oncologist who works on sporadic GBM, a dementia researcher, or a breast oncologist ranks in the top hits, the extractor read the exclusions as the ask. Check the evidence lines on the top-ranked people — evidence citing glioblastoma or breast cancer papers is the tell.

SECONDARY FAILURE (over-correction, the opposite direction): negation handling that is too blunt may suppress legitimate content that sits near an exclusion. Watch for the pediatric cognitive phenotype being dropped because "cognition" was mentioned in the Alzheimer exclusion; for Nf1 mouse models being dropped because "animal-only" was excluded; or for MEK inhibition being demoted because the MEK allosteric pocket appeared in the computational exclusion.

ALSO WATCH: whether "purely computational", "no wet-lab component", "animal-only" get emitted as method chips at all — these are eligibility/design rules, which the extractor is already instructed to ignore, so leaking them is a second, independent bug. And whether the mechanics paragraph ($200,000, 10% indirect, 14 March, one application per laboratory) leaks in, which would mean the ignore-the-award-mechanics instruction is also not holding under this much adversarial text.

Report what actually happens. If the excluded diseases come back as wanted concepts, say so plainly — that is a real, unfixed gap in the extractor prompt, which currently says nothing about negation.

```text
PROGRAM ANNOUNCEMENT — PERIPHERAL NERVE TUMOR BIOLOGY AND NEUROCOGNITION

The Foundation supports research on neurofibromatosis type 1, and nothing else. Applicants misjudge this every cycle, so we state our boundaries before we state our interests.

WHAT WE DO NOT FUND

We do not fund sporadic glioblastoma. Applications on IDH-wild-type glioblastoma of the adult cerebral hemispheres — temozolomide resistance, tumor-treating fields, the proneural-to-mesenchymal transition, blood-brain barrier penetrance of GBM agents, recurrent GBM immunotherapy — are returned without review, however strong the science. We are asked this often enough that we now say it first.

We will not consider Alzheimer disease or any other adult neurodegenerative condition. Amyloid-beta, tau, TDP-43, alpha-synuclein, Lewy body dementia, amyotrophic lateral sclerosis, frontotemporal dementia, Parkinson disease: out of scope, all of it. Our interest in cognition is developmental and pediatric, and the two literatures are not interchangeable.

We no longer support breast cancer research. The Foundation funded breast cancer for eleven years and closed that portfolio in 2021. Do not submit on HER2-positive disease, endocrine resistance, BRCA1/2 carriers, or triple-negative breast cancer. Such applications are administratively withdrawn, not scored.

Purely computational work with no wet-lab component is out of scope. A re-analysis of public transcriptomic atlases, a deep-learning segmentation model for tumor volumetrics, a molecular-dynamics study of an allosteric MEK pocket — however elegant — must be paired with experimental validation in a laboratory we can see in the budget. Dry-lab-only applications are not reviewed.

Animal-only studies with no path to patients will not be reviewed. We fund Nf1 mouse models; we do not fund them as an endpoint. State the translational endpoint or do not apply.

WHAT WE FUND

Everything below concerns neurofibromatosis type 1 (NF1), the autosomal dominant RASopathy caused by germline loss of one NF1 allele and consequent loss of neurofibromin, the GTPase-activating protein for RAS.

1. Plexiform neurofibroma (pNF) initiation and growth. Biallelic NF1 inactivation in the Schwann cell lineage — boundary cap cells, Schwann cell precursors — the haploinsufficient microenvironment, mast cell and macrophage recruitment, and why some plexiform tumors grow explosively in early childhood and then plateau.

2. RAS/MAPK hyperactivation. RAS-GTP accumulation and downstream RAF-MEK-ERK signaling; feedback reactivation and adaptive resistance under MEK blockade.

3. MEK inhibition. Selumetinib-class MEK1/2 inhibitors have changed practice for inoperable plexiform neurofibroma. We want to know why volumetric responses are partial, why tumors regrow off drug, and where the real toxicity ceiling sits (rash, paronychia, ejection fraction). Combination and next-generation strategies are welcome.

4. Malignant transformation. Atypical neurofibromatous neoplasms of uncertain biologic potential (ANNUBP) with CDKN2A/B loss; progression to malignant peripheral nerve sheath tumor (MPNST) with loss of PRC2 components (SUZ12, EED) and collapse of H3K27me3; TP53 loss; early detection short of amputation-level surgery.

5. The learning and cognitive phenotype. Roughly half of children with NF1 carry a learning disability; attention deficits, visuospatial impairment and executive dysfunction are common. We fund mechanism — excess GABAergic inhibition, hippocampal long-term potentiation deficits — and we fund intervention trials, having been burned once already by the statin trials.

MECHANICS

Awards are $200,000 in direct costs over two years; indirect costs capped at 10%. Letters of intent close 14 March; full applications by invitation. Faculty appointment required; one application per laboratory. No conference travel, no tuition, no equipment above $25,000.

If the first noun in your abstract is glioblastoma, Alzheimer disease, or breast cancer, this is the wrong Foundation.
```

**Expect (primary).** neurofibromatosis type 1

**Watch for these as false positives.** plexiform neurofibroma (concept, high centrality — the lesion the Foundation actually cares about); Schwann cell biology / biallelic NF1 loss in the Schwann cell lineage (concept); RAS/MAPK hyperactivation — neurofibromin loss of RasGAP function, RAF-MEK-ERK signaling (concept); MEK1/2 inhibition, selumetinib class (method or therapeutic modality; canonicalize 'selumetinib-class' rather than treating the drug name as the target); malignant peripheral nerve sheath tumor (MPNST) and transformation via ANNUBP, CDKN2A/B loss, PRC2 (SUZ12/EED) loss and H3K27me3 collapse (concept); learning disability and executive/visuospatial dysfunction in children with NF1 (concept; the pediatric cognitive phenotype, NOT adult cognition); FALSE POSITIVE TO WATCH FOR — glioblastoma (incl. temozolomide resistance, tumor-treating fields, GBM immunotherapy): named ONLY as an exclusion. Any non-zero centrality here is a failure.; FALSE POSITIVE TO WATCH FOR — Alzheimer disease and adult neurodegeneration (amyloid-beta, tau, TDP-43, alpha-synuclein, ALS, Parkinson disease): named ONLY as an exclusion. Any non-zero centrality here is a failure.; FALSE POSITIVE TO WATCH FOR — breast cancer (HER2-positive, triple-negative, BRCA1/2, endocrine resistance): named ONLY as an exclusion, and a retired portfolio at that. Any non-zero centrality here is a failure.; FALSE POSITIVE TO WATCH FOR — computational methods (deep-learning segmentation, molecular dynamics, public transcriptomic atlas re-analysis): named ONLY as an exclusion. If these surface as METHOD chips the extractor has inverted the sponsor's meaning.; FALSE POSITIVE TO WATCH FOR — 'animal-only studies': an exclusion of a study DESIGN, not a research topic. Nf1 mouse models remain in scope; a chip reading 'animal models' either way is reading the exclusion clause as content.
