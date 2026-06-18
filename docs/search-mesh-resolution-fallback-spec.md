# Search: graceful MeSH resolution (decompose-and-resolve fallback + curated aliases)

**Status:** Draft spec — awaiting approval before implementation.
**Author:** (investigation 2026-06-17)
**Scope:** `/search` query → MeSH-descriptor resolution. People, Publications, and
Funding tabs all consume the same resolver, so all three improve.

---

## 1. Problem

The hero "Try:" chips (`lib/hero-search-suggestions.ts`) and the curated master
(`data/suggested-searches.json`) are designed so a lay term *resolves* to its NLM
MeSH descriptor and surfaces scholars **tagged** with that concept ("…doubles as a
search demo"). For a large fraction of queries this resolution **silently fails**,
and the search degrades to generic free-text matching over name / areas / title /
overview / publication-title fields. Symptoms in the UI:

- Top scholars show **"— no specific match for this query —"** (evidence kind `none`).
- Ranking looks arbitrary (a topical match sits next to an unrelated scholar who
  merely shares a stemmed token like "device" in their bio).
- Recall drops sharply vs. the resolved concept.

### 1.1 Root cause

`resolveMeshDescriptor` (`lib/api/search-taxonomy.ts`) resolves **only on an exact
normalized-form match** of the whole query against a descriptor **name**, an NLM
**entry term**, or a **curated alias** (`etl/mesh-aliases/curated.csv`). The
normalizer (`lib/api/normalize.ts`) lowercases, drops the word "and", and strips
non-alphanumerics:

```
normalizeForMatch("Wearable devices & sensors") === "wearabledevicessensors"
```

That string equals no descriptor name (`"wearableelectronicdevices"`), no entry
term, and no alias — so the resolver returns `null`, `searchInterpretation.meshMapped`
is `false`, and the concept path never runs.

### 1.2 Evidence (measured against staging, 2026-06-17)

Same string, two ways:

| Query sent | `meshMapped` | Scholars | Top-hit evidence |
|---|---|---|---|
| `Wearable devices & sensors` (chip label) | **false** | 82 | mostly *"no specific match"* |
| `Wearable Electronic Devices` (real MeSH name) | **true** | **178** | *"N of M publications **tagged** Wearable Electronic Devices"* |

Audited all 169 chips against `GET /api/search?...&type=people`
(`searchInterpretation.meshMapped`):

- **105 mapped**, **64 fail to map (38%)**. (13 of the 64 first threw transient
  cold-start 500s under concurrency; all resolved on serial retry — not a code bug.)

The 64 failures fall into four classes; the master already records each chip's
intended descriptor, so the target is known in every case:

1. **`&`-joined (5)** — *Wearable devices & sensors*, *Base & prime editing*, …
2. **`/`-joined (27)** — *Liquid biopsy / circulating tumor DNA*, *CRISPR / gene editing*, …
3. **Parenthetical (9)** — *Polycystic ovary syndrome (PCOS)*, *Targeted protein degradation (PROTAC)*, …
4. **Lay phrase, no NLM surface form (23)** — *Causal inference*, *Robotic surgery*, *Single-cell RNA sequencing*, …

### 1.3 Key observation that shapes the design

Classes 1–3 (and some of class 4) **contain a real descriptor as a sub-phrase** —
the query simply isn't *equal* to one. Measured: a "decompose the query and resolve
the best sub-phrase" fallback auto-resolves **33 of the 64** with zero curation
(longest-window-first; see Appendix A). The remaining **31** have no NLM sub-phrase
and need a curated alias (Appendix B).

This is why the fix is two complementary layers, not one.

---

## 2. Goals / non-goals

**Goals**
- Resolve far more queries to the right descriptor, **including free-typed queries
  nobody curated** (the long tail — the real win over chips alone).
- When resolution is a *guess*, mark it **low-confidence** and treat it honestly in
  both UI (tentative phrasing + escape hatch) and ranking (admit/boost below an
  exact match; never let a guess dominate genuine lexical matches).
- Keep curation as a precise override that always beats the guess.

**Non-goals**
- Multi-descriptor resolution (a query mapping to *two* descriptors at once). The
  alias mechanism and the fallback both pick a **single** dominant descriptor; true
  multi-descriptor support is a separate, larger change (Open Question OQ-1).
- Any reindex. This is resolve-time only; the publications index is untouched.
- External calls (PubMed ATM). The team already found ATM mis-maps exactly these
  queries (see `curated.csv` notes); the fallback stays in-process over the
  already-loaded MeSH map.

---

## 3. Design

### Layer 1 — decompose-and-resolve fallback (automatic)

Add a fallback inside `resolveMeshDescriptor` that runs **only when the existing
exact lookup misses** (`map.byForm.get(normalized)` is empty). Aliases live in
`byForm`, so a curated alias short-circuits the fallback — curation always wins.

**Algorithm**
1. Tokenize the trimmed query on non-alphanumeric runs, preserving token order and
   boundaries: `"Liquid biopsy / circulating tumor DNA"` → `[liquid, biopsy,
   circulating, tumor, dna]`.
2. Enumerate contiguous token windows (n-grams), **longest first**, then
   left-to-right within a length.
3. For each window, look up `byForm.get(normalizeForMatch(window))`. Take the
   **first hit** (longest, leftmost) and run it through the existing candidate
   tiebreaker (exact > entry-term, anchor-exists, `localPubCoverage`, `dateRevised`).
4. Return that descriptor with **`confidence: "partial"`** and `matchedForm` = the
   window's surface form. Set `ambiguous: true` if two windows of the maximum
   matching length resolve to different descriptors.

**Why longest-window-first (not densest):** my throwaway probe tie-broke on
publication count and mis-picked *"morbidity"* for *Maternal mortality & morbidity*
and *"Hormones"* for *Menopause / hormone therapy*. Longest-window-first instead
matches the 2-gram *"maternal mortality"* → **Maternal Mortality** — the specific,
correct descriptor — and avoids the generic single-token trap.

**Guardrails (the "less reliable" handled honestly)**
- **Single-token windows are the danger zone — block them unless exact-name.**
  Empirically (Appendix C), longest-window-first falls through to a *single common
  word* when no multi-word window resolves, and that single word lands on a generic
  or homonymous descriptor with false confidence:
  *Seahorse metabolic flux* → **Smegmamorpha** (the fish order!), *Patient-derived
  xenografts* → **Patients**, *Calcium imaging* → **Calcium**, *Genetically
  engineered mouse models* → **Mice**, *Mendelian randomization* → **Random
  Allocation**. Rule: a single-token window may resolve **only** if it is an *exact
  descriptor-name* match (`confidence === "exact"`) AND ≥ 5 chars AND not a
  stopword; otherwise require a **≥ 2-token** window. This keeps *Radiomics*,
  *Proteomics* while killing the homonym traps.
- **Confidence cap:** a fallback hit is **never** higher than `"partial"`, even when
  the matched window is an exact name — so it always sorts/ranks below a genuine
  whole-query exact/entry match and renders with the tentative UI.
- **Stopword/generic skip:** drop windows that are entirely stopwords or
  `deprioritized-terms` filler before lookup.
- **Fail closed:** any error → `null`, exactly as today.
- **Takeaway for narrow method terms:** even with the guard, most narrow
  method/instrument terms have **no** clean MeSH descriptor. They should resolve via
  the **method-family taxonomy** (§8), not MeSH. The fallback's real job is the
  multi-concept *topic* chips (the original 64), where it is accurate.

### Layer 2 — curated aliases (precision override)

For the 31 chips with no NLM sub-phrase, add `alias,descriptor_ui,source_note` rows
to `etl/mesh-aliases/curated.csv` (the existing #642 mechanism — already merged into
`byForm` before the fallback). Generate candidates from the master's `mesh` column
(name → UI lookup against `mesh_descriptor`); a human confirms each before commit.
Aliases also let curators **correct any fallback mis-pick** by hand.

Single-descriptor chips (~single name in the `mesh` column) get one alias each.
Multi-descriptor chips (`;` in the `mesh` column, e.g. *Tissue Engineering;
Regenerative Medicine*) get an alias to their **dominant** descriptor for now
(OQ-1).

### 3.1 The new confidence tier — `"partial"`

`MeshResolution.confidence` becomes `"exact" | "entry-term" | "partial"`. The tier
must propagate to three places:

**(a) Resolver** — `lib/api/search-taxonomy.ts`: emit `"partial"` from the fallback;
unchanged for exact/entry-term.

**(b) Ranking** — `lib/api/search.ts`: the concept-admission boost ladder
(`MESH_ADMIT_WEIGHT`: exact 3 / anchored-entry 1.5 / entry 0.7) gains a **partial
tier strictly below entry** (e.g. ~0.3). A partial resolution should:
- still drive the per-scholar **evidence counts** (`reasonCounts` tagged/mention) and
  the "showing results for X" affordance, but
- contribute concept-admission OR-clauses **only under the existing #726
  sparse-escalation floor** (i.e. only when lexical results are sparse), never on
  dense result sets — so a guess can broaden a thin result page but cannot reorder a
  healthy lexical ranking.

**(c) UI** — surface the tier so a guess reads as a guess:
- `app/api/search/route.ts`: add `meshConfidence` (or `approximate: boolean`) to
  `searchInterpretation` alongside `meshMapped`/`conceptLabel`.
- Search header (`app/(public)/search/page.tsx` + `components/search/…`): for a
  partial match render *"Showing results for **{name}** — interpreted from your
  search. [Search the exact term instead]"* rather than asserting the concept.
- `components/search/match-reason.tsx`: per-hit "tagged {name}" phrasing is fine; no
  change required, but copy review for the partial case.

---

## 4. Files touched (estimate)

| File | Change |
|---|---|
| `lib/api/search-taxonomy.ts` | Fallback in `resolveMeshDescriptor`; `"partial"` in `MeshResolution.confidence`; window enumerator helper |
| `lib/api/normalize.ts` | (reuse) — possibly export a token-split helper |
| `lib/api/search.ts` | `MESH_ADMIT_WEIGHT` partial tier; gate partial admission behind the sparse floor |
| `app/api/search/route.ts` | `meshConfidence`/`approximate` in `searchInterpretation` |
| `app/(public)/search/page.tsx` + `components/search/*` | tentative header copy + "exact term" escape hatch |
| `etl/mesh-aliases/curated.csv` | +31 curated alias rows (data) |
| `tests/unit/search-taxonomy*.test.ts` | window fallback, confidence tier, guardrails, alias-wins-over-fallback |

---

## 5. Flags & rollout

- **`SEARCH_MESH_RESOLUTION_FALLBACK`** (default off). Gates Layer 1 only; aliases
  (Layer 2) are data and can land independently/always-on.
- Rollout: land aliases → land fallback dark → flip on **staging** → measure the
  same 64-chip audit (expect ≈0 unmapped) + spot-check that dense lexical rankings
  are unchanged with the flag on (the ranking-restraint guarantee) → prod flip.
- No reindex; resolve-time only.

---

## 6. Testing

- Unit: `normalizeForMatch`/window enumerator (boundaries, min-size, stopword skip).
- Unit: fallback resolves the 33 Appendix-A windows to the expected descriptor;
  longest-window-first picks *Maternal Mortality*, not *Morbidity*.
- Unit: a curated alias for a fallback-reachable query **wins** over the window pick.
- Unit: `confidence: "partial"` set on fallback hits; `ambiguous` on max-length ties.
- Ranking: partial admission fires under the sparse floor and is inert on a dense
  page (snapshot the admitted-set delta).
- Staging: re-run the 169-chip `meshMapped` audit; assert unmapped count collapses.

---

## 7. Open questions

- **OQ-1 — multi-descriptor chips.** ~24 of the 64 map to *two* descriptors in the
  master. Single-descriptor alias/fallback picks one. Acceptable v1? Or invest in
  multi-descriptor resolution (resolver returns N descriptors; admission ORs all)?
- **OQ-2 — partial admission on dense pages.** Spec says inert unless sparse. Confirm
  that's the desired conservatism, or allow a small partial boost always.
- **OQ-3 — Methods/Tools resolution path (see §8).**

---

## 8. Parallel path: Methods & Tools resolution (relates to "add methods/tools")

The resolver is not the only matcher. `matchQueryToTaxonomy` also matches the
**Method/Tool taxonomy** (`loadMethodCandidates`, `search-taxonomy.ts`) —
14 supercategories (`lib/methods/supercategory-labels.ts`) → families (generated
upstream in ReciterAI, published to S3 `tools/latest/{tools,families}.json`, loaded
into `scholar_family`/`scholar_tool`), gated behind `METHODS_LENS_PAGES`. It renders
the "Methods and Tools" chip row next to "Research Areas".

### 8.1 The real finding: families exist; the *connection* is missing

The `/methods` index lists the live inventory: **759 families across the 14
supercategories** — already comprehensive and granular. *"Add ~50 families"* is
largely unnecessary; nearly every candidate already exists, often under a more
canonical (jargon) name:

| Lay term | Existing canonical family |
|---|---|
| Seahorse metabolic flux | `extracellular flux respirometry` |
| Causal inference | `causal inference methods` |
| Variant-calling pipelines | `variant calling and genotyping` |
| iPSC-derived cell models | `ipsc derived cell models` |
| CAR-T cell therapy | `car t cell immunotherapy` |
| Flow cytometry & FACS | `flow cytometry assays` |

**The gap is search connectivity, not coverage.** `matchQueryToTaxonomy` matches a
family only when the normalized query is a **substring of the canonical family
label** (`matchKey.includes(normalized)`). There is **no synonym/entry-term layer**
for families (unlike MeSH descriptors, which carry entry terms). So:

- Lay terms that happen to be substrings of the canonical label resolve
  (*single cell rna sequencing*, *electron microscopy*, *spatial transcriptomics*).
- Brand names (*Seahorse*, *FACS*), acronyms (*fMRI*, *PDX*, *GEMM*), and
  qualifier-laden phrases (*CRISPR screens*, *Whole-genome & exome sequencing*) do
  **not** — even though the family exists.

**Measured (staging, 2026-06-17):** of 53 lay-term method candidates, only **13
surface the right family**; **36 are gaps** whose family already exists but is
unreachable by that wording. (The remaining few resolve only as MeSH topics.)

### 8.2 Recommended work: a method-family synonym layer

The productive task is the **methods analog of the MeSH curated-alias layer**: a
curated `lay-term / brand / acronym → canonical family` table, plus applying the
Layer-1 **windowing** to method matching. Examples: `Seahorse → extracellular flux
respirometry`, `FACS → flow cytometry assays`, `fMRI → functional mri`,
`qPCR → quantitative pcr methods`. The full draft is `docs/method-family-synonyms-draft.md`
(95 families · ~195 surface forms, all validated against the live inventory).

Net-new families are a *small* residual (e.g. *Mendelian randomization* / *Radiomics*
appear to have no home family) — those, and only those, are the upstream ReciterAI/S3
change. Everything else is a synonym-mapping + matching-logic change, mostly app-side.
_Animal / in-vivo model families are out of scope per project direction._

---

## Appendix A — 33 chips auto-resolved by the fallback (no curation)

`Acute respiratory distress syndrome (ARDS)`→Respiratory Distress Syndrome ·
`Advance care planning / goals of care`→Advance Care Planning ·
`Air pollution / particulate matter`→Air Pollution ·
`Alpha-synuclein / Parkinson disease`→Parkinson Disease ·
`Amyloid-beta / Alzheimer disease`→Alzheimer Disease ·
`Amyotrophic lateral sclerosis (ALS)`→Amyotrophic Lateral Sclerosis ·
`Atopic dermatitis (dupilumab)`→Dermatitis, Atopic ·
`CRISPR / gene editing`→Gene Editing ·
`Cancer epigenetics / DNA methylation`→DNA Methylation ·
`Cardio-oncology / cardiotoxicity`→Cardiotoxicity ·
`Cellular senescence / senolytics`→Cellular Senescence ·
`Extracellular vesicles / exosomes`→Extracellular Vesicles ·
`Health equity & disparities`→Health Equity ·
`Health information exchange / interoperability`→Health Information Exchange ·
`Hearing loss / cochlear implants`→Hearing Loss ·
`Idiopathic pulmonary fibrosis / ILD`→Idiopathic Pulmonary Fibrosis ·
`Inflammasome / NLRP3`→Inflammasomes ·
`Invasive fungal infections / antifungal resistance`→Invasive Fungal Infections ·
`Ischemic stroke / thrombectomy`→Ischemic Stroke ·
`Kidney stones / nephrolithiasis`→Kidney Calculi ·
`Liquid biopsy / circulating tumor DNA`→Circulating Tumor DNA ·
`Liver cirrhosis / portal hypertension`→Liver Cirrhosis ·
`MASLD / nonalcoholic fatty liver`→Non-alcoholic Fatty Liver Disease ·
`Maternal mortality & morbidity`→Maternal Mortality *(longest-window fix)* ·
`Menopause / hormone therapy`→Menopause *(longest-window fix)* ·
`Phase I clinical trials (first-in-human)`→Clinical Trials, Phase I as Topic ·
`Polycystic ovary syndrome (PCOS)`→Polycystic Ovary Syndrome ·
`Tauopathy / tau protein`→Tauopathies ·
`Telemedicine / telehealth`→Telemedicine ·
`Tissue engineering & regenerative medicine`→Tissue Engineering ·
`Wearable devices & sensors`→Wearable Electronic Devices ·
`Whole-genome / exome sequencing`→Exome Sequencing ·
`m6A RNA methylation / epitranscriptomics`→RNA Methylation

## Appendix B — 31 chips that still need a curated alias

AAV gene therapy · Antimicrobial resistance · Atrial fibrillation ablation ·
Base & prime editing · Biobanking · CDK4/6 inhibitors · Cardiac amyloidosis ·
Causal inference · Deep learning in radiology · Digital / computational pathology ·
EGFR-mutant lung cancer (osimertinib) · HIV / AIDS · HIV pre-exposure prophylaxis (PrEP) ·
Heart failure with preserved EF (HFpEF) · KRAS inhibitors · Large language models in medicine ·
Mendelian randomization · Neoantigen cancer vaccines · PSMA PET imaging ·
Patient-derived organoids · Physician burnout · Preimplantation genetic testing ·
Real-world evidence · Robotic surgery · Simulation-based medical education ·
Single-cell RNA sequencing · Structure-based drug design ·
Targeted protein degradation (PROTAC) · Total joint arthroplasty · Value-based care ·
siRNA therapeutics

## Appendix C — Method-family candidate validation (staging, 2026-06-17)

53 candidate method families (a mix of broad + narrow, across the 14
supercategories) probed against staging `/search`. Bucketed by how the query
resolves **today** (before any change):

- **✅ Resolves cleanly to a MeSH descriptor — 18.** Work as-is, no taxonomy change
  needed (Spatial Transcriptomics, PET molecular imaging, Electron microscopy,
  Immunohistochemistry, Metabolomics, Lipidomics, Cryo-EM, X-ray crystallography,
  NMR spectroscopy, Survival analysis, Biobanks, Patient-reported outcome measures,
  Monoclonal antibodies, Organoids, CAR-T, mRNA vaccines, Antibody-drug conjugates,
  Deep brain stimulation).
- **🟡 Only fuzzy-resolves — 28** — and **~9 of these fuzzy maps are WRONG** (see
  guardrail above): Seahorse→Smegmamorpha, Patient-derived xenografts→Patients,
  Calcium imaging→Calcium, GEMMs→Mice, Mendelian randomization→Random Allocation,
  ATAC-seq→ChIP-seq, Confocal/Super-res→Microscopy (over-broad), Multiplex
  cytokine→Cytokines. These belong in the **method-family taxonomy**, not MeSH.
- **🔴 Dead — 3** (no resolution, no usable sub-window): Causal inference,
  Variant-calling pipelines, iPSC-derived cell models.

**Conclusion:** "narrow works" only if the narrow term is backed by a real
method-family in the upstream `families.json`. MeSH fallback cannot safely stand in
for narrow method/instrument terms — it mis-maps them. So the ~50 families are
primarily an **upstream taxonomy** task (ReciterAI consolidation → S3), with the
MeSH path reserved for the 18 that happen to be descriptors.
