# Overview-statement generator — validation run 2 (post grounding-fix)

Re-run of the #742 build-of-record validation after the grounding NO-GO of
2026-06-15 (run 1, `validation-run-results.md`). Model: Claude Sonnet 4.5 on
Bedrock, default temperature. Sample: the same four faculty (rgcryst / imh2003 /
gbm9002 / jom2025).

**Result: GATE PASS — 4 / 4 drafts publishable with light edits, zero high-severity
faithfulness violations**, confirmed by a 16-agent adversarial audit (4 leak-vector
lenses × 4 drafts, two rounds).

---

## Root cause: run 1 was largely a *measurement* failure, not a model failure

Run 1 graded three of four drafts as faithfulness failures (invented tool names
"FEMI"/"BELA", a disease "alpha-1 antitrypsin deficiency", a metric "h-index of
27", grant aims "KIKO mouse"/"cerebellar circuitry"). Re-checking each against the
**actual** assembled facts showed almost all of these were **already grounded** —
they were just invisible to the grader:

- **`renderFactsSummary` (the doc's "Assembled facts") never printed `methods`,
  `facultyMetrics`, or grant `title`s.** It showed grants as funder-only.
- So: "FEMI"/"BELA"/"AI-biopsy" are literally in `methods` (`Foundational IVF Model
  for Imaging (FEMI)`, `BELA (Blastocyst Embryo Learning Algorithm)`). "h-index of
  27" is `facultyMetrics.hIndex = 27`. "alpha-1 antitrypsin deficiency" /
  "Friedreich's ataxia cardiomyopathy" / "KIKO mouse" / "cerebellar circuitry" /
  "protein replacement therapy" are all **grant titles** (e.g. *"Gene Therapy for
  Alpha 1-Antitrypsin Deficiency"*, *"Postnatal development of the cerebellar
  circuitry in the KIKO mouse model of Friedreich's ataxia"*).

The model was grounding correctly on inputs the grader couldn't see. **Fix:**
`renderFactsSummary` now renders Methods / tools and Faculty metrics (grant titles
were already assemble-side; they're surfaced via the audit ground truth).

## The genuine residual leaks (and the prompt fix that closed them)

Two real grounding leaks *did* survive — small, plausible, training-recall
embellishments the model added on top of grounded facts:

1. **Disease-indication inference** — rgcryst: "anti-eosinophil gene therapy"
   (a real pub) became "...for **hypereosinophilia**" (a disease named in no fact).
2. **Department embellishment** — jom2025: department `Brain and Mind Research`
   became "**Feil Family** Brain and Mind Research **Institute**".

Both were caught by the adversarial audit (round 1), not by eyeball review. The
`OVERVIEW_SYSTEM_PROMPT` was hardened (`lib/edit/overview-generator.ts`) with four
ABSOLUTE naming rules — a specific **tool/method**, a numeric **metric**, a
**disease/target**, and a **grant aim** may each be named ONLY when present in
FACTS — plus an explicit "do not name the indication a therapy treats", a
"use the department/title string exactly, no eponym/institute expansion" rule, a
**no-representative-publications** directive (the jom2025 middle tier: topics but no
per-paper grounding → stay at topic-area level, don't invent specifics), and a
tightened standard length band (120–160, firm ceiling). Round 2 (below) is clean.

## Caveats

- **Length is a soft directive.** The rich-data cases drift over the 160-word
  ceiling (rgcryst 197, imh2003 163); the model trades the cap for completeness.
  Not a faithfulness issue; a post-generation length trim or a hard truncate is the
  lever if the ceiling must bind.
- **This re-run used the `scholar_tool` methods source** (the local DB has no
  `scholar_family` table — it is behind master's migrations). That is exactly what
  run 1 used, so the comparison is clean and the prompt rules are source-agnostic.
  The **deployed** generator grounds `methods` on the `scholar_family` rollup. Before
  flipping `SELF_EDIT_OVERVIEW_GENERATE` on, re-run the formal `npm run
  edit:overview-validate` in an environment where `scholar_family` is populated
  (staging) as the final gate; the prompt rules degrade safely if `methods` is empty.

---

## Round-2 drafts (post-fix, adversarially audited clean)

### rgcryst — Ronald G Crystal (197 words) — PASS

> Ronald G. Crystal, M.D., is Chair of Genetic Medicine at Weill Cornell Medicine. His research spans gene and cell therapy, with particular emphasis on adeno-associated virus (AAV) vector development and clinical translation. Dr. Crystal has pioneered long-term CNS gene therapy for late infantile Batten disease, demonstrating that direct brain administration of adeno-associated virus vector serotype 2 (AAV2) expressing CLN2 slows disease progression, with twenty-year survival outcomes now documented. His laboratory employs adeno-associated virus serotype rh.10 vector and adeno-associated virus serotype 9 (AAV9) vector platforms to address diverse targets, including Alzheimer's disease through APOE4 modification via prime editing and novel APOE2-Christchurch variant delivery, which suppresses amyloid and tau pathology in TRE4 mouse model (human APOE4 knock-in). Recent work includes positron emission tomography (PET) scanner-based biodistribution studies revealing that AAV vectors administered to cerebrospinal fluid exhibit substantial systemic distribution. Additional translational efforts address alpha-1 antitrypsin deficiency, Friedreich's ataxia cardiomyopathy, and anti-eosinophil gene therapy. Dr. Crystal's investigations of airway epithelium biology have elucidated club cell dysregulation in idiopathic pulmonary fibrosis and smoking-induced differentiation shifts. He holds degrees from Tufts University, University of Pennsylvania, and University of Pennsylvania School of Medicine, and has authored 922 publications with an h-index of 155.

Every specific traces to FACTS: AAV2/CLN2, AAVrh.10, AAV9, TRE4 mouse, PET scanner →
`methods`; alpha-1 antitrypsin / Friedreich's ataxia cardiomyopathy → grant titles;
anti-eosinophil gene therapy + IPF/club cell → pub titles; 922 / h-index 155 →
metrics. (No "hypereosinophilia".)

### imh2003 — Iman Hajirasouliha (163 words) — PASS

> Iman Hajirasouliha, Ph.D., is Associate Professor of Systems and Computational Biomedicine at Weill Cornell Medicine. His research develops artificial intelligence and computational genomics methods to advance precision medicine, with recent emphasis on in vitro fertilization embryo assessment and cancer genomics. Dr. Hajirasouliha's laboratory has introduced foundational models for IVF, including FEMI—trained on 18 million time-lapse images—and BELA, which predicts blastocyst ploidy non-invasively using time-lapse imaging. His AI-biopsy deep learning software integrates MRI with pathology to classify prostate cancer, reducing unnecessary biopsies. In cancer genomics, his group has developed tools such as cloudrnaSPAdes for RNA isoform assembly, Blackbird for structural variant detection using synthetic long-reads, and Meltos for tumor phylogeny reconstruction. Dr. Hajirasouliha's work also includes weakly-supervised models for tumor purity prediction from H&E slides. His research is supported by the National Institute of General Medical Sciences, the National Human Genome Research Institute, and the National Institute of Child Health & Human Development. He holds a Ph.D. in Computing Science from Simon Fraser University.

FEMI / BELA / AI-biopsy / cloudrnaSPAdes / Blackbird → `methods`; Meltos / 18M
time-lapse images → pub titles; funders → grants. (These were the run-1 "fabrications".)

### gbm9002 — Geraldine McGinty (135 words) — PASS

> Geraldine McGinty, M.B.,B.Ch., B.A.O., M.B.A., is Professor of Clinical Radiology in the Department of Radiology at Weill Cornell Medicine. Her research addresses health equity, cost barriers, and policy in diagnostic imaging. A 2023 large claims-based study revealed that higher out-of-pocket costs significantly reduce follow-up breast imaging after screening mammograms, identifying cost-sharing as a barrier to timely diagnostic care. Her work examines how insurance mechanisms and healthcare economics shape utilization patterns and access to radiology services. Additional research explores health equity and social determinants of health within radiology, leadership curriculum development for academic medicine, and strategies to advance population health through imaging. Dr. McGinty has authored 92 publications since 1992, with an h-index of 19. She earned her medical degree from the National University of Ireland in 1988 and an M.B.A. from Columbia University in 2000.

"2023" = the breast-imaging pub's `year`; 92 / 1992 / h-index 19 → metrics +
yearsActive; education verbatim.

### jom2025 — Jordi Magrane (155 words) — PASS (sparse tier — no representative pubs)

> Jordi Magrane, Ph.D., is Associate Professor of Research in Neuroscience in the Brain and Mind Research department at Weill Cornell Medicine. He earned his B.S. and Ph.D. in Biology from the University of Barcelona, completing his doctoral degree in 2000. His research spans biochemistry and biophysics, with emphasis on enzyme kinetics, respiratory chain bioenergetics, and redox biochemistry, as well as cell and molecular biology, including organelle biology, enzyme function, and ROS signaling in mitochondria.
>
> Dr. Magrane has published 38 works since 1998 and maintains an h-index of 27. He currently serves as principal investigator on two grants from the Friedreich's Ataxia Research Alliance, examining pre-clinical assessment of protein replacement therapy in the central nervous system of Friedreich's ataxia mouse models and postnatal development of the cerebellar circuitry in the KIKO mouse model of Friedreich's ataxia. His experimental approaches include the Ciona intestinalis AOX-expressing transgenic mouse and substrates such as glycerol 3-phosphate, malate, pyruvate, and succinate.

Department now verbatim ("Brain and Mind Research", no "Feil Family … Institute");
h-index 27 + 38 since 1998 → metrics; the two grant aims are the grant *titles*;
the substrates / AOX mouse → `methods`. (Audit low-note "principal investigator" =
grant `role` field, present in FACTS — a grading-file omission, not a draft defect.)

---

## Adversarial audit

16 agents per round (4 drafts × 4 lenses: named-entities, numbers, biomed-targets,
grants-identity), each judging the draft against the closed-world assembled facts.

| Round | rgcryst | imh2003 | gbm9002 | jom2025 | Gate |
|---|---|---|---|---|---|
| 1 (pre-2nd-hardening) | FAIL — "hypereosinophilia" | PASS | (FP — "2023" is a pub year) | FAIL — "Feil Family … Institute" | FAIL |
| 2 (final) | **PASS** | **PASS** | **PASS** | **PASS** (low: PI = role field) | **PASS** |
