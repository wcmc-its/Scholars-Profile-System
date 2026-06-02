# Cleaned-bio preview — ~85 Grad School net-new, normalize pass

**Status:** Quality preview (sample)
**Date:** 2026-06-01
**Parent:** [gradschool-bio-analysis.md](./gradschool-bio-analysis.md) · [../overview-statement-generator-spec.md](../overview-statement-generator-spec.md)
**Source set:** the 85 net-new candidates (FT faculty, no overview, with a Grad School bio) — full list in [`net-new-candidates`](./bio-metadata.csv) (`net_new=1`).

This shows what the ~85 bios look like **after a normalize pass**, so quality can be judged before committing to a seed. The "after" texts here were written by Claude (the local `AI_GATEWAY_API_KEY` isn't set); **in production this is the [option-4 generator](../overview-statement-generator-spec.md) doing it at scale via the AI Gateway.** The samples below demonstrate the *target*.

## What the normalize pass does

| Step | Type | Rule |
|---|---|---|
| Strip empty `<p>`, `panopoly`/caption wrappers, embedded `<img>` | **mechanical** | deterministic, scriptable |
| Drop embedded **publications** citation dumps (PMIDs/DOIs) | **mechanical** | publications live elsewhere in Scholars |
| Extract appended **honors lists** to a structured block | **mechanical** | don't leave a raw `<ul>` in prose |
| Drop **pointer-stubs** + bios < ~30 words | **mechanical** | flag for original authorship instead |
| Normalize **voice → third person, person-centric** | **LLM** | "I/We/Our lab" → "Dr. X / her lab" |
| **Trim** long CVs to a ~120–180-word overview | **LLM** | |
| Fix **scrape concatenations & typos** | **LLM** | "Research inMedicine" → "Research in Medicine" |
| Use the **current Scholars (ED) title**, not the bio's stale one | **mechanical** | source bios are often years out of date |

**Faithfulness rule:** the rewrite only rephrases/cleans what the source states (plus the authoritative Scholars title). **No facts are invented** — sparse bios stay short rather than getting padded.

---

## Before → after (9 representative, spanning every issue type)

### 1. Ronald Crystal — `rgcryst` · Chair, Genetic Medicine *(the #1 name on the gap list — 921 pubs, no overview)*
**Issue:** already clean third-person; light touch only.
**Before:** "Dr. Crystal is Professor and Chair of the Department of Genetic Medicine at Weill Cornell Medicine. He is also the Bruce Webster Professor of Internal Medicine, Director of the Belfer Gene Therapy Core Facility and Attending Physician at NewYork-Presbyterian Hospital/Weill Cornell Medical Center. Dr. Crystal holds an MD from **the UPenn** and had post-graduate training at Mass General and UCSF. His laboratory focuses on gene therapy and the molecular basis of pulmonary disorders. Dr. Crystal was formerly Branch Chief for the Pulmonary Division at NHLBI, founded or co-founded 5 biotechnology companies, and serves on several Scientific Advisory Boards."
**After:** "Ronald G. Crystal is Professor and Chair of the Department of Genetic Medicine at Weill Cornell Medicine, where he is also the Bruce Webster Professor of Internal Medicine, Director of the Belfer Gene Therapy Core Facility, and an Attending Physician at NewYork-Presbyterian/Weill Cornell Medical Center. He holds an MD from the University of Pennsylvania and completed postgraduate training at Massachusetts General Hospital and the University of California, San Francisco. His laboratory studies gene therapy and the molecular basis of pulmonary disorders. Previously Branch Chief of the Pulmonary Division at the NHLBI, Dr. Crystal has founded or co-founded five biotechnology companies and serves on several scientific advisory boards."
*Changed:* "the UPenn" → University of Pennsylvania; expanded Mass General/UCSF; "5" → "five". Otherwise faithful.

### 2. Amelia Bond — `amb2036` · Associate Professor
**Issue:** stale title in source ("Assistant"); typo "Projects areas".
**Before:** "Amelia Bond is an **Assistant Professor** of Health Policy and Economics in the Department of Population Health Sciences at Weill Cornell Medical College, Cornell University. Dr. Bond's research focuses on provider incentives. **Projects areas** include the design and evaluation of new payment models, particularly surrounding primary care, and the impact of provider-hospital structures on provider incentives."
**After:** "Amelia M. Bond is an **Associate Professor** of Health Policy and Economics in the Department of Population Health Sciences at Weill Cornell Medicine. Her research focuses on provider incentives, including the design and evaluation of new payment models — particularly in primary care — and the effect of provider–hospital structures on those incentives."
*Flag:* title corrected from the source's stale "Assistant" to the current Scholars value "Associate." This is why the seed must take the title from ED, not the bio.

### 3. Francis Lee — `fslee` · Professor/Chair
**Issue:** lab-framed third person + time-relative "currently".
**Before:** "Dr. Lee is **currently** director of a laboratory whose main area of research is in basic molecular, neural mechanisms that are relevant to neuropsychiatric disorders. In particular, his research is focused on using genetic models to delineate the role of growth factors, such as BDNF, in complex behaviors related to the pathophysiology and treatment of affective disorders."
**After:** "Francis S. Lee is a Professor and Chair whose research examines the basic molecular and neural mechanisms underlying neuropsychiatric disorders. His laboratory uses genetic models to define the role of growth factors such as BDNF in the complex behaviors tied to the pathophysiology and treatment of affective disorders."
*Changed:* dropped "currently"; made person-centric; fixed stray comma.

### 4. Yiye Zhang — `yiz2014` · Associate Professor
**Issue:** first-person; a URL concatenated onto the last word.
**Before:** "**My** research interests are "learning health systems", where data-driven approaches such as machine learning and data mining are applied in creating the next generation of healthcare information technology to better assist healthcare providers and patients in making **decisions.http://www.yiyezhang.com**"
**After:** "Yiye Zhang is an Associate Professor whose research centers on "learning health systems" — applying data-driven approaches such as machine learning and data mining to build the next generation of healthcare information technology that helps providers and patients make better decisions."
*Flag:* removed the broken inline URL stuck to "decisions."; flipped first → third person.

### 5. Matthias Stadtfeld — `mas4011` · Associate Professor
**Issue:** first-person plural, lab-centric.
**Before:** "**Our laboratory** uses cellular reprogramming technology as a tractable experimental approach to identify and study mechanisms that control gene expression and determine cell identity in mammals. **We are** pursuing state-of-the-art genetics and genomics approaches to understand the coordination of transcriptional, metabolic and chromatin remodeling during reprogramming and to pinpoint the reasons for the occurrence of epigenetic abnormalities in pluripotent cells and human malignancies."
**After:** "Matthias Stadtfeld is an Associate Professor whose laboratory uses cellular reprogramming as a tractable approach to study the mechanisms that control gene expression and determine cell identity in mammals. Using genetics and genomics, his group investigates how transcriptional, metabolic, and chromatin-remodeling programs are coordinated during reprogramming, and works to pinpoint the causes of epigenetic abnormalities in pluripotent cells and human malignancies."
*Changed:* "Our/We" → third person.

### 6. Iman Hajirasouliha — `imh2003` · Associate Professor
**Issue:** first-person plural; very short (34 words); lowercased institute names.
**Before:** "**We are** a computational science oriented group, affiliated with the **institute of precision medicine** and the **institute of computational biomedicine**. **We are** passionate about developing new algorithms and applications of computational methods to genomics."
**After:** "Iman Hajirasouliha is an Associate Professor who leads a computational research group affiliated with the Institute for Precision Medicine and the Institute for Computational Biomedicine. His group develops new algorithms and computational methods for genomics."
*Note:* kept it short (no padding); only proper-cased institute names already present — did **not** add "Englander" or any unstated detail.

### 7. Barbara Hempstead — `blhempst` · Dean
**Issue:** first-person-plural lab voice (from a *Dean*); source typos "differentation", "indentifies".
**Before:** "**Our lab** has focused on defining the actions of the neurotrophin growth factors in the vasculature and in neurons. Although neurotrophins are best known for their survival and **differentation**-inducing actions on neurons, recent work **indentifies** critical functions in modulating synaptic activity and mediating cell death. **Our** current studies are focused on identifying (1) … (2) … (3) …"
**After:** "Barbara L. Hempstead is a Dean whose laboratory studies the actions of neurotrophin growth factors in the vasculature and in neurons. Although neurotrophins are best known for promoting neuronal survival and differentiation, her work identifies additional roles in modulating synaptic activity and mediating cell death. Her current research spans the role of pro-neurotrophins in injury-induced apoptosis and nervous-system development, the roles of BDNF and proNGF in angiogenesis and the vascular response to injury, and the mechanisms by which neurotrophins are released and processed from pro- to mature forms to alter receptor specificity."
*Changed:* voice flip; fixed "differentation"→differentiation, "indentifies"→identifies; folded the (1)(2)(3) list into prose.

### 8. Geraldine McGinty — `gbm9002` · Professor (Senior Associate Dean)
**Issue:** an inline **awards** block *and* a **Selected Publications** citation dump (PMID/DOI/URL) pasted into the bio.
**Before (excerpt):** "…she serves as Senior Associate Dean for Clinical Affairs. … **Distinctions:** Named Most Effective Radiology Educator in 2015 by Aunt Minnie … 2024 American College of Radiology Gold Medal **Selected Publications:** McGinty G. Choosing Wisely: Mentors, Sponsors, and Your Kitchen Cabinet. J Am Coll Radiol. 2017 Dec;14(12):1637-1638. doi:… PMID: 28870410. https://pubmed…"
**After (overview prose):** "Geraldine B. McGinty is an internationally recognized expert in healthcare strategy and imaging economics. A Professor of Clinical Radiology and Population Health Sciences at Weill Cornell Medicine, she serves as Senior Associate Dean for Clinical Affairs. She holds an MBA from Columbia University and an MB from the National University of Ireland, Galway. Her research examines the implications of new payment models and policy change in healthcare. As founding Academic Director (2017–2019) of the joint Weill Cornell / Johnson School Executive MBA and Master's in Healthcare Leadership, she built the curriculum and recruited faculty; she currently teaches Healthcare Leadership and Innovation and Transformation in Healthcare."
**After (honors → structured, not inline):** ACR Gold Medal (2024) · AAWR Alice Ettinger Award (2023) · Bibliowicz Award (2019) · Most Powerful Women in Health IT (2019) · Most Effective Radiology Educator, Aunt Minnie (2015).
*Dropped:* the "Selected Publications" citation dump entirely — publications already live on the Scholars profile.

### 9. Taha Merghoub — `tam2037` · Professor *(985-word CV → ~150-word overview)*
**Issue:** longest bio in the set; scrape concatenations ("Research inMedicine", "swim across Americalaboratory").
**Before (excerpt of 985 words):** "Dr. Taha Merghoub is the Deputy Director of the Meyer Cancer Center… He is also Professor of Pharmacology, Professor of Immunology **Research inMedicine** and Margaret and Herman Sokol Professor of Oncology Research… director of the Ludwig collaborative and **swim across Americalaboratory**… He received his BA degree from the University of Algiers… MS and PhD… After graduation, he pursued his postdoctoral research with Dr. Pier Paolo Pandolfi at Memorial Sloan Kettering… He subsequently joined Alan Houghton laboratory… developed mouse models of melanoma… [continues ~700 more words]"
**After:** "Taha Merghoub is a Professor of Pharmacology and of Immunology Research in Medicine, the Margaret and Herman Sokol Professor of Oncology Research, and Deputy Director of the Meyer Cancer Center at Weill Cornell Medicine, where he directs the Ludwig Collaborative and Swim Across America Laboratory. He earned his BA from the University of Algiers and MS and PhD degrees from the University of Paris, where his thesis examined genetic polymorphism in the fetal hemoglobin gene in sickle cell anemia and thalassemia. Following postdoctoral work with Pier Paolo Pandolfi at Memorial Sloan Kettering, he joined Alan Houghton's laboratory to study tumor immunity, developing mouse models of melanoma to evaluate new immunotherapies. His research focuses on the mechanisms of antitumor immunity and the design of combination immunotherapies for cancer."
*Changed:* fixed concatenations; trimmed 985 → ~150 words; kept only stated facts.

---

## Quality verdict

**The corpus normalizes well.** Across the spread, the source content is factually rich and the issues are *mechanical and stylistic*, not substantive — exactly what a clean + voice pass fixes. Rough split of the 85:

| Bucket | ~Count | Effort |
|---|---:|---|
| Already good third-person — light touch | ~36 | trivial |
| Third-person but lab-framed / needs person-centering | ~38 | light LLM |
| First-person / first-plural — needs voice flip | ~11 | light LLM |
| Long CV (>350w) — needs trimming | ~11 (overlaps) | moderate LLM |
| Has embedded honors/publications to extract | ~50 (the lists) | mechanical |
| Pointer-stubs / <30w — exclude, write fresh | small | n/a |

**Recurring flags the seed must honor (not bio-specific):**
1. **Titles in the source are stale** (Bond: "Assistant" → now "Associate"). Always take the title from Scholars/ED, never the bio.
2. **Scrape artifacts** ("Research inMedicine", broken URLs) and **source typos** ("differentation") are common — the LLM pass catches them; a pure mechanical copy would not.
3. **Embedded publications** (McGinty) must be dropped — they duplicate the profile and add citation noise.
4. **Honors are valuable structured data** — extract them; decide whether they render as a separate block or are dropped (they may belong to a future "Honors" field, not the overview prose).

**Recommendation:** quality is good enough to proceed — but it confirms the [scope memo's](../overview-coverage-scope.md) **generator-first** conclusion. Every "after" above is a generator output; building the generator gives you this cleaning at scale (all 85 + the long tail) with a review gate, rather than a one-off script. Suggested next step: wire the generator's prompt to exactly these rules and run it over the 85 behind the **owner-review** flow (resolution A in the [generator SPEC](../overview-statement-generator-spec.md)) so faculty approve before publish.
