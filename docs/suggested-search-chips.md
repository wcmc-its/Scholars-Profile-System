# Scholars Suggested-Search Chips — Methodology Spec & Reproduction Prompt

> Purpose of this document: the chip *list* goes stale (hot topics rotate, MeSH evolves, WCM's
> research mix shifts), but the *method* for regenerating it does not. This captures the process
> used to build the 2026 master list so it can be re-run in a couple of years and produce a
> comparable, refreshed set. Section 9 is the "what's different on a refresh" checklist.
> Appendix A is the copy-paste prompt. Appendix B records the 2026 baseline so you can diff against it.

---

## 0. Implementation in this repo (2026-06-02)

Where the method's output actually lives and runs:

| Concern | Location |
|---|---|
| **Master list** (full schema: `id`, `area`, `label`, `mesh`, `wcm_pubs_2023_present`, `replaces`, `notes`) | [`data/suggested-searches.json`](../data/suggested-searches.json) — 169 chips across 65 research areas. The source of record; diff future refreshes against it (Appendix B). |
| **Runtime pool** (the lay-term `label` strings only) | [`lib/hero-search-suggestions.ts`](../lib/hero-search-suggestions.ts) → `HERO_SEARCH_SUGGESTIONS`. A lean projection of the master's `label` column, kept apart from the metadata so the homepage client bundle ships only the strings. |
| **Sampler** | `sampleHeroSuggestions(n)` in the same file — a uniform Fisher–Yates draw over the **whole** pool (no length filter), so each page load shows a broad range of terms. |
| **Render** | [`components/home/try-suggestions-chips.tsx`](../components/home/try-suggestions-chips.tsx) — client-only sampling on mount (avoids ISR cache freeze), routes each chip to `/search?q=<label>`. |
| **Sync guard** | [`tests/unit/hero-search-suggestions.test.ts`](../tests/unit/hero-search-suggestions.test.ts) — asserts the runtime pool equals the master's labels (count, set, order) and re-checks the master's own integrity (contiguous ids, no duplicate labels). Edit the JSON, then regenerate the array; the test fails if they drift. |

**Rotation / "on each visit."** The chips are on the public homepage (no auth gate), so the
"random selection" happens client-side on every page load — every visitor, including a returning
one, sees a fresh broad sample. There is no per-user state.

**Regenerating the runtime array after a master edit:**

```bash
node -e 'const d=require("./data/suggested-searches.json");
  process.stdout.write(d.map(x=>"  "+JSON.stringify(x.label)+",").join("\n")+"\n")'
```

Paste the output as the body of `HERO_SEARCH_SUGGESTIONS`, then run
`npx vitest run tests/unit/hero-search-suggestions.test.ts`.

**2026 swap.** This replaced the previous pool of generic department / topic / subtopic *entity
names* with the 169 specific lay-term chips below. The earlier "balanced length" constraint
(12–22 chars, issue #214) was removed because it hid ~60% of the curated terms — including the
punchiest demos ("Sepsis", "Melanoma", "Long COVID", "Radiomics") and the longer descriptive ones.

> **Validation status:** per Section 8, each `label` should be confirmed against the live Scholars
> index before it is leaned on as a marketing demo. The depth proxy (`wcm_pubs_2023_present`) is
> from external PubMed affiliation counts, not the Scholars corpus.

---

## 1. Goal

Replace generic, department-level homepage search chips (e.g. "Gynecologic Oncology", "Pharmacology")
with **specific, current research topics** that do two things at once:

1. **Show off MeSH-aware search.** The chip displays the *lay term* a visitor would actually type
   (e.g. "CAR-T cell therapy", "antibody-drug conjugates", "long COVID"). Behind the scenes the
   search resolves it to a *differently-named* MeSH descriptor (Receptors, Chimeric Antigen;
   Immunoconjugates; Post-Acute COVID-19 Syndrome) and surfaces scholars who never wrote the
   buzzword verbatim. The bigger the gap between the typed term and the descriptor, the more
   visibly the matching is "doing work."
2. **Reflect real WCM depth.** Every chip must return a satisfying roster of WCM scholars — no
   chips that land on 3 people.

## 2. Inputs

- **The current research-area taxonomy** of the Scholars system, with per-area counts (the
  `/topics/...` pages). Used as the scaffold to mine — roughly two chips per area.
- **The current homepage chips** (the generic ones to replace).
- **A source of WCM-affiliated publications with MeSH indexing.** In 2026 this was the PubMed
  MCP `search_articles` tool. Any equivalent that supports an affiliation filter + returns total
  counts and the MeSH query translation works.
- **The live Scholars index itself**, for final validation (see Section 8).

## 3. Method

For each research area in the taxonomy:

1. **Brainstorm 2–4 candidate sub-topics** that are (a) more specific than the area name and
   (b) genuinely current/cutting-edge for the *then-present* year. Lean toward terms whose lay
   form differs from the MeSH descriptor.
2. **Verify WCM depth via an affiliation search**, scoped to the most recent ~3 calendar years
   so the result reflects *active* work, not history. Query template (PubMed syntax):

   ```
   "Weill Cornell"[Affiliation] AND (<candidate terms, OR-joined>)
   date_from = <current year minus ~3>   sort = pub_date   max_results = 1
   ```

   You only need two fields back: `total_count` (the depth signal) and `query_translation`.
3. **Read `query_translation`** — it is the most useful output:
   - It shows **which MeSH descriptor** the lay term resolves to → confirms the showcase gap and
     gives you the value for the `mesh_descriptor` column.
   - It **warns about inflation** (see Section 5): if the term expands to a broad umbrella
     descriptor or a common subheading, the count is an upper bound.
4. **Screen** against the quality gates in Section 5. Drop thin ones; flag inflated ones.
5. **Select ~2 per area** (1 for small areas, occasionally a 3rd for very large ones). Skip areas
   already covered by a chip selected elsewhere — record the dedup decision rather than repeating.
6. **Record** each survivor in the output schema (Section 7).

Cost note: each verification is one cheap call (`max_results=1`). A full sweep of ~65 areas at
~2 candidates each is ~130 calls plus a handful of re-queries to disambiguate inflated counts.

## 4. What makes a good chip (selection criteria)

- **Specific** — a sub-topic, not a department. "Bladder cancer", not "Urology".
- **Lay term ≠ descriptor** — the matching "wow." Best examples: antibody-drug conjugates →
  *Immunoconjugates*; PROTAC → *Proteolysis Targeting Chimera*; ECMO → *Extracorporeal Membrane
  Oxygenation*; C. difficile → *Clostridioides difficile*. Chips where the label *is* the descriptor
  (e.g. "Obesity" → *Obesity*) are fine for volume but weak as demos.
- **Above the depth floor** — see Section 5.
- **Recognizable** — this is a public homepage. Favor terms a non-specialist or a journalist would
  recognize over deep jargon, where you have a choice.
- **The chip stores the lay term, never the descriptor.** If the chip literally said
  "Immunoconjugates", there'd be nothing left to show off.

## 5. Quality gates & screening rules

**Depth floor.** Drop a candidate if the recent affiliation count is roughly **< 50**; below ~40
it's almost always too sparse to give a good result. Counts of ~45–65 are judgment calls — keep one
only if it's distinctive, recognizable, or strategically on-brand.

> 2026 rejects for being thin: psilocybin (24), lipoprotein(a) (29), glymphatic system (34),
> CAR-NK cells (16), phage therapy (24), wastewater surveillance (24), federated learning (25),
> vaccine hesitancy (29), competency-based medical education (32), ketamine-for-depression (26),
> intermittent fasting (12), Mediterranean diet (26), biomolecular condensates (8),
> organ-on-a-chip (4), brain-computer interfaces (37), epigenetic clocks (15), HER2-low breast (16),
> xenotransplantation (40).

**Inflation detection.** A high `total_count` can be an artifact. Suspect inflation when
`query_translation` shows the term mapping to:
- a **broad umbrella descriptor** — e.g. *Precision Medicine* (caught "theranostics"),
  *Brain Neoplasms* (caught "brain metastases"), *fibrosis* (caught "liver cirrhosis"),
  *Antigens, Neoplasm* (caught "neoantigen vaccines"), *Aging* (caught "biological aging"); or
- a **MeSH subheading** that rides on huge numbers of papers — e.g. the `pathology` subheading
  inflated "computational/molecular pathology" into the thousands.

When you suspect it, **re-query the exact phrase in quotes** (`... AND "digital pathology"`) to get
a clean count, then either use the clean number or flag the row as an upper bound in `notes`.

**OR-expansion.** Joining a niche term with a broad synonym (e.g. `intermittent fasting OR ...`
that pulls a generic descriptor) can mask a thin true count. Re-check the niche term alone.

## 6. Pitfalls & lessons (read before re-running)

- **Topic-page counts UNDERCOUNT the real footprint.** The `/topics/...` numbers reflect primary
  research-area assignment, not every contributing author. Do not use them to decide an area is
  "too small to bother." In 2026 the Lung Cancer page read 85 but NSCLC affiliation papers were
  ~745; Gyn Onc read 58 but ovarian cancer was ~730. **Always judge depth by the affiliation
  search, not the page count.**
- **Some hot topics are genuinely thin at WCM.** Don't force a chip where depth isn't there.
  Biomedical Engineering ran lean (the hard-engineering work lives at Cornell-Ithaca / Cornell
  Tech); there is no dental school (Oral & Craniofacial Health was unusable); the big
  xenotransplantation programs are elsewhere.
- **Some hot topics publish OUTSIDE PubMed.** CS/ML-flavored work (e.g. federated learning) is
  under-counted by a biomedical-literature affiliation search. Flag these; optionally cross-check a
  CS index, or confirm against the Scholars system's own corpus.
- **Use the ACTUAL current year in date filters.** A stale hardcoded year ("...2025" run in 2028)
  degrades relevance. Compute the window from today's date.
- **Affiliation matching is the right semantics.** `"Weill Cornell"[Affiliation]` returns papers
  with *any* author at WCM — i.e. "researchers at the school working on X," which is exactly what a
  scholar-discovery chip should surface.
- **MeSH evolves.** Several 2026 descriptors were recent additions (*Large Language Models*,
  *Spatial Transcriptomics*, *Post-Acute COVID-19 Syndrome*, *Radiomics*). On a refresh, re-check
  mappings rather than assuming a lay term still maps where it used to.

## 7. Output schema

Produce a CSV (config/spreadsheet) and/or a flat JSON array (app ingestion). One row per chip:

| column | meaning |
|---|---|
| `id` | stable integer identifier |
| `research_area` | the taxonomy area it was mined from |
| `chip_label` | **the lay term shown on the chip** |
| `mesh_descriptor` | what the search resolves it to (from `query_translation`); `;`-separated if several |
| `wcm_pubs_<window>` | affiliation count for the recency window used (a *proxy* for depth) |
| `replaces_current_chip` | the generic homepage chip this one retires, if any |
| `notes` | caveats — upper-bound/inflated counts, overlaps with other chips, text-leaning matches |

Integrity checks before shipping: IDs contiguous, no duplicate `chip_label`.

## 8. Validation (do not skip)

`wcm_pubs_<window>` is a **proxy** from external literature, not the Scholars corpus. Before any
chip goes live, run its `chip_label` through the Scholars index itself and confirm it returns a
satisfying scholar roster. The index's own MeSH coverage and de-duplication set the real number —
which, per Section 6, usually runs **higher** than the affiliation proxy suggests.

## 9. Refresh checklist (what's different when you re-run in ~2 years)

1. **Re-pull the inputs as they exist then** — the current taxonomy + counts, and the current
   homepage chips. The taxonomy itself may have gained/renamed areas.
2. **Re-brainstorm for the then-present year. Do NOT reuse the 2026 buzzwords blindly.** Some of
   2026's "cutting edge" (GLP-1 agonists, LLMs-in-medicine, spatial transcriptomics, PROTACs) may
   be mainstream or dated; new modalities will have appeared. Ask "what's hot *now*."
3. **Re-verify everything** — counts drift, programs grow and shrink. Re-run the affiliation
   searches; recompute the recency window from the current date.
4. **Re-check MeSH mappings** — new descriptors may exist for terms that previously broad-matched.
5. **Re-screen the prior list** — flag 2026 chips that have gone thin or stale and retire them.
6. **Keep this schema** so the new file diffs cleanly against the prior master (Appendix B), making
   "what's new / what's retired" obvious.

---

## Appendix A — Ready-to-run prompt

Paste this to a capable assistant that has a PubMed (or equivalent affiliation-filtered,
MeSH-indexed literature) search tool. Fill the bracketed parameters first.

```
You are helping build "suggested search" chips for an academic medical center's public scholar-
discovery homepage. Goal: replace generic, department-level chips with SPECIFIC, currently
cutting-edge research topics that (a) showcase MeSH-aware search — the chip shows the lay term a
visitor types, and the search resolves it to a differently-named MeSH descriptor and finds scholars
who never used the buzzword — and (b) reflect real institutional research depth (no chip that lands
on a handful of people).

PARAMETERS
- AFFILIATION        = "Weill Cornell"        # the [Affiliation] string for the institution
- RECENCY_WINDOW     = the most recent 3 full calendar years, computed from TODAY'S date
- MIN_RECENT_PAPERS  = 50                     # soft depth floor; <40 is almost always too sparse
- CHIPS_PER_AREA     = 2                       # 1 for small areas, up to 3 for very large ones
- OUTPUT             = CSV + flat JSON, schema below

INPUTS I WILL PROVIDE
- The current research-area taxonomy with per-area counts.
- The current homepage chips (the generic ones to replace).

METHOD — for each research area:
1. Brainstorm 2–4 candidate sub-topics that are more specific than the area name and genuinely
   hot RIGHT NOW (this year, not from a static list). Prefer terms whose lay form differs from the
   MeSH descriptor.
2. Verify institutional depth with one cheap search per candidate:
   query = AFFILIATION[Affiliation] AND (<candidate terms, OR-joined>)
   date_from = start of RECENCY_WINDOW ; sort = pub_date ; max_results = 1
   Read only total_count and the query translation.
3. Use the query translation to (a) record the MeSH descriptor the lay term resolves to, and
   (b) detect inflation: if the term expands to a broad umbrella descriptor (e.g. "Precision
   Medicine", "Brain Neoplasms", "fibrosis", "Antigens, Neoplasm") or to a common MeSH subheading
   (e.g. "pathology"), the count is an upper bound — re-query the exact phrase in quotes for a clean
   count and flag it.
4. Screen: drop candidates below MIN_RECENT_PAPERS; ~45–65 is a judgment call (keep only if
   distinctive/recognizable/strategic). Skip areas already covered by a chip chosen elsewhere.
5. Select CHIPS_PER_AREA survivors.

RULES & PITFALLS
- The chip stores the LAY TERM, never the MeSH descriptor.
- Do NOT trust the taxonomy's per-area page counts as a depth gauge — they undercount the true
  footprint (primary-area assignment, not all authors). Judge depth ONLY by the affiliation search.
- Some hot topics are genuinely thin at this institution, or publish outside the biomedical
  literature (CS/ML work). Don't force a chip; flag under-counted ones.
- Compute the date window from the CURRENT date; never hardcode a stale year.
- Affiliation search = "any author at the institution" = the correct "scholars who work on X."

OUTPUT SCHEMA (one row per chip)
id | research_area | chip_label | mesh_descriptor | wcm_pubs_<window> | replaces_current_chip | notes
Integrity: contiguous ids, no duplicate chip_label. Map generic homepage chips to their specific
replacement via replaces_current_chip.

CLOSING NOTE TO INCLUDE
The wcm_pubs count is a PROXY from external literature, not the institution's own index. Tell me to
validate each chip_label against the live index before launch — its own MeSH coverage and dedup set
the real roster size (usually higher than the proxy).

Work through the taxonomy area by area, verifying as you go, and deliver the file(s). Flag anything
you screened out and why.
```

---

## Appendix B — 2026 baseline (for diffing)

- **Run date:** 2026-06-02
- **Affiliation string:** `"Weill Cornell"[Affiliation]` (PubMed MCP `search_articles`)
- **Recency window:** 2023–present (`date_from=2023`)
- **Depth floor used:** ~50 recent affiliated papers (soft)
- **Result:** 169 chips across 65 research areas; ~15 candidates screened out as thin.
- **Generic chips retired:** Gynecologic Oncology → Ovarian cancer; Emergency Medicine → Sepsis;
  Pharmacology → Drug repurposing. Implementation Science kept (already a clean, high-volume chip).
- **Master files:** `wcm_scholars_suggested_searches.csv` / `.json` (same schema as Section 7).
- **Counts flagged as upper bounds in 2026:** health equity, neoantigen vaccines, tissue
  engineering, liver cirrhosis, brain metastases, molecular imaging; text-leaning: real-world
  evidence, Mendelian randomization.
