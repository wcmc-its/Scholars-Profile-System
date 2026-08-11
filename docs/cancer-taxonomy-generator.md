# Cancer taxonomy generator — logic and rationale

**Status (2026-08-11):** the generator, its persisted table, and its ETL step are merged
and live (#2356), including the content-review ruleset fixes (#2358) — staging's
`CancerTaxonomyDescriptor` reflects the final 878-descriptor ruleset. The Reports tab, the
CSV export, and the "How cancer-relevance is determined" modal all read this table directly
now — the old, hand-picked taxonomy described below (for context on what it replaced) is
retired. This doc explains the new system on its own terms; see
`docs/cancer-taxonomy-ruleset.csv`'s own row-level `note` comments for the current,
authoritative content of the ruleset — this doc does not attempt to freeze that in prose.

## Why this exists

The taxonomy that ships today, `docs/cancer-center-disease-taxonomy.csv`, is a single
hand-picked list: 18 disease codes, 29 MeSH anchor terms, no generation, no provenance, no
review queue. It conflates two different questions into one axis — *"is this paper
cancer-relevant at all"* and *"which of 18 sites does it belong to"* — so a paper about
tumor biology with no organ-specific term (say, general oncogene research) has nowhere to
go, and there's no way to tell a curator's confident anchor call from theirs guessing.

The replacement is a **generator**, not a second hand-curated list: a small, git-versioned
ruleset (`docs/cancer-taxonomy-ruleset.csv`, ~164 rows) expanded against the full NLM MeSH
descriptor release into a complete, provenanced closure over **two independent axes**.
Widening the definition of "cancer-relevant" from 18 codes to (effectively) the whole of
MeSH's C04 tree is a real behavior change — it changes who clears ADD/recruit thresholds in
the Cancer Center Reports tab — which is why the rollout is staged (see "Current status"
below) rather than a drop-in swap.

## The two-axis model

- **`cancer_relevant`** (boolean) — the count a CCSG-style report should key on. The whole
  of MeSH's C04 (Neoplasms) subtree, **minus** `Cysts` and `Hamartoma` (non-neoplastic
  despite living in C04 — chalazion, ganglion cysts, developmental malformations), **plus**
  a curated set of non-C04 headings (therapeutics, cancer control, tumor biology, cancer-gene
  concepts), with a small number of individually-readmitted exclusions (Dermoid Cyst,
  Tuberous Sclerosis, Cowden syndrome — genuinely neoplastic despite sitting in an excluded
  subtree).
- **`topics`** (multi-valued, often empty) — a separate site facet: ~20 disease-site buckets
  (`breast`, `lung-thoracic`, ...) plus 6 cross-cutting `cc-*` buckets
  (`cc-experimental-models`, `cc-biology`, `cc-therapeutics`, `cc-control-survivorship`,
  `cc-hereditary`, `cc-precancerous`). A descriptor can carry more than one topic, and
  **legitimately carries none** — a genuinely cancer-relevant paper with no site-specific
  angle (e.g. `Carcinogenesis` itself) is not a data gap, it's `unassigned`. Never sum topic
  counts to a total across rows.

A special case worth naming: **experimental-model records count as cancer-relevant but must
not attribute to a human disease site.** `Liver Neoplasms, Experimental` sits under both
`Liver Neoplasms` (site) and `Neoplasms, Experimental` (model-system) in the MeSH tree — the
generator strips the site topic from anything caught by the model-system sweep and routes it
to `cc-experimental-models` only. A mouse-model paper is cancer research; it is not a liver
cancer paper in the sense the report means.

## How the generator works

`etl/cancer-taxonomy/generate.ts` is a pure TS port of a Python prototype
(`build_cancer_taxonomy.py`), run against the already-persisted `MeshDescriptor` table
(`etl/mesh-descriptors/index.ts`) instead of a separate XML download. Six rule types, three
per axis:

| Rule | Effect |
|---|---|
| `rel_include_subtree` / `rel_include_term` | add the descriptor (and, for `_subtree`, everything below it in the MeSH tree) to `included` |
| `rel_exclude_subtree` / `rel_exclude_term` | add to `excluded` |
| `rel_readmit_term` | add to `readmitted` — wins even over an exclusion |
| `topic_subtree` / `topic_term` | assign a topic bucket to the descriptor (and, for `_subtree`, its descendants) |

Final admission: **`relevant = (included \ excluded) ∪ readmitted`**. Every accumulator
above is a pure set union with no removal until that final computation — rule processing
order does not affect the result. That's what makes the port tractable: there is no
precedence to get subtly wrong in translation, only the closure math itself, which golden-file
testing (below) checks directly rather than by inspection.

A **fallback topic** (`fallback` column, e.g. `Urologic Neoplasms`) is only assigned when
nothing more specific matched — a kidney paper reads as `kidney-bladder-testicular` via its
own specific anchor, not the fallback, if both would otherwise apply.

### Proven equivalent to the source, not just reimplemented

`tests/unit/cancer-taxonomy-generate.test.ts` runs the *actual* Python script against a
small, hand-built MeSH XML fixture and checks in its output as `testdata/golden-expected.csv`.
The TS port is asserted to reproduce it row-for-row. This caught two real bugs before they
shipped — most notably a `*/` inside a doc comment that broke both the TypeScript source file
*and*, separately, the generated Prisma client (same failure mode twice) — converting "I
reimplemented the algorithm" into "I proved equivalence," per the redesign plan's own
requirement.

## Versioning: a paired hash, not a version string

A taxonomy resolution is only reproducible as the **combination** of (ruleset content, MeSH
release) — either alone is not enough. This is a direct lesson from a separate system in
this codebase (ReciterAI's `topic_scores_version`), whose version label was measured
identical across 113,605 rows and 7 real taxonomy edits — a hand-typed label that answered
"which taxonomy produced this row" for nobody.

The `CancerTaxonomy` `EtlRun` row instead pairs `sha256(ruleset CSV bytes)`
(`manifestSha256`, the same convention `etl/mesh-descriptors/index.ts` already uses for its
own source bytes) with the *paired* MeSH source's own most recent `manifestSha256`/year,
packed into `manifestTaxonomyVersion` as `mesh<year>:<sha256 prefix>`. No new `EtlRun`
columns were needed. The ETL step short-circuits (skips the full-replace) only when **both**
match the last successful run.

## Rot detection: what "fails loudly" means, and what it doesn't

MeSH retires, renames, and re-trees headings every year. The generator distinguishes two
failure signals from the closure it just computed:

- **`unresolved`** — a ruleset row's descriptor name doesn't exist in the current MeSH
  release at all. Unambiguous rot (a renamed or retired heading) — **fails the run**.
- **`emptySubtrees`** — a `_subtree` rule's anchor resolved but has zero descendants this
  release. A real signal, but **not** unambiguous: some ruleset anchors are legitimately leaf
  concepts by design. This was proven empirically, not assumed — the tiny test fixture
  predicted it (3 leaf anchors), and the **first real run against staging confirmed it**: 20
  genuinely benign leaf concepts (`Breast Neoplasms, Male` among them — exactly matching the
  fixture's own prediction), none of them rot. Treating this as fatal would have failed the
  very first production run for no real reason. It's logged loudly as a review signal
  instead.

## The ETL step and chaining

`etl/cancer-taxonomy/index.ts` (`npm run etl:cancer-taxonomy`) is chained after
`etl/mesh-descriptors/index.ts` (`npm run etl:mesh`) as a child process — **after both its
short-circuit and full-replace paths**, not just the full-replace. The dependent step's own
paired-hash short-circuit makes a no-op re-run nearly free, so there's no cost to always
chaining it; without this, a new MeSH year would silently leave the persisted table resolved
against descriptors that no longer exist, with nothing else to trigger a re-run. The
chaining is an isolated child-process spawn — a cancer-taxonomy failure is logged loudly but
does not fail the MeSH replace itself, which already succeeded on its own terms.
`etl:mesh` itself remains off the daily/weekly orchestrator cadence (yearly, on-demand), so
neither step runs automatically; both are triggered manually or via the deployed Step
Functions cadence for MeSH.

## Editing the ruleset: measure before deciding

The ruleset (`docs/cancer-taxonomy-ruleset.csv`) is checked-in data — editing it is a PR,
same "backend, not self-service" posture as the taxonomy it replaces. The working discipline
established during the post-merge content review, and expected of future edits: **size a
candidate rule against real WCM publication data before adopting or rejecting it** — domain
knowledge motivates a hypothesis, real counts decide it. Four cases from that review, kept
here as worked examples:

- **A large "would-gain" number is not automatically a good rule.** Cancer-etiology
  infections (HPV, EBV, *H. pylori*, Hepatitis B) were sized by counting WCM papers tagged
  with the term but carrying no independent neoplasm co-tag. HPV and EBV came in at 31%/38%
  no-co-tag — the majority of local usage is already cancer-adjacent, so they were added
  cleanly. Hepatitis B came in at **90%** — the overwhelming majority of WCM's Hepatitis B
  work is general hepatology/virology, not cancer research. The narrower `Hepatitis B,
  Chronic` was sized too before deciding: 86%, barely better. The row was **dropped
  entirely**, with the rejection and its numbers left as an inline CSV comment so a future
  editor doesn't re-propose it blind. (A `review`-flagged row is *not* a safe way to defer
  this decision — the generator admits a flagged row identically to an unflagged one; the
  flag is advisory metadata for a human, not a gate.)
- **Sometimes the gap doesn't exist in practice — say so and stop.** Specific antineoplastic
  drug names (Cisplatin, Doxorubicin, ...) were hypothesized as a gap, since only the broad
  `Antineoplastic Agents` class was admitted. Sizing showed cancer-primary drugs
  (Trastuzumab, Bevacizumab, Carboplatin) are already mostly swept in via a co-tagged
  neoplasm term (3–17% miss rate). The drugs with high raw miss counts (Methotrexate 61%,
  Rituximab 46%, Cyclophosphamide 35%) turned out to have substantial real non-cancer
  clinical use (rheumatoid arthritis, transplant, lupus) — adding them would have hurt
  precision, not fixed a gap. **Nothing was added.**
- **A structural fix needs its own precision pass, not just a correctness check.** Asymmetric
  gene admission (BRCA1/2 individually admitted; TP53, HER2, RAS, MYC not) was fixed
  structurally — admitting MeSH's own `Genes, Neoplasm` / `Oncogenes` / `Genes, Tumor
  Suppressor` / `Neoplasm Proteins` branches as subtrees, verified against live MeSH tree
  numbers before drafting (not guessed). That resolved the asymmetry, but subtree admission
  is a blunter instrument than a hand-picked list, and the newly-admitted descriptors were
  **separately ranked by real WCM tagged-pub count** to check for a "Methotrexate of the
  protein axis." Two headings stood out well above a calibrated baseline (p53/myc/ras run
  20–35% no-neoplasm-co-tag even as uncontroversial cancer genes): `Proto-Oncogene Proteins
  c-akt` (46% — real non-cancer use in metabolism/neuroscience research at WCM) and `Janus
  Kinase 2` (58% — broad cytokine-signaling/hematopoiesis use well beyond myeloproliferative
  neoplasms). Both were excluded via `rel_exclude_term` — the same mechanism the ruleset
  already uses for this exact kind of call, applied to the newly-swept-in set instead of only
  the newly-drafted rows.
- **Cheap completeness fixes are still worth doing, and still worth documenting why.** Three
  siblings of an already-admitted concept (`Neoplasm Metastasis`) were missing their own
  topic row for no stated reason; adding them was a one-line-per-row fix with no sizing
  question attached.

## Current status

- **Merged and live** (#2356 + #2358): the generator, `CancerTaxonomyDescriptor`, the ETL
  step, MeSH-chaining, and the four content-gap fixes. Staging reflects the final ruleset:
  164 rules → 878 cancer-relevant descriptors (vs. 308 under the old 18-code taxonomy).
- **Cutover shipped**: `etl/cancer-center-collab-report/index.ts`, the Reports tab's "How
  cancer-relevance is determined" modal, and the per-paper CSV export all read
  `CancerTaxonomyDescriptor` via `lib/cancer-taxonomy.ts` now — the old CSV taxonomy
  (`docs/cancer-center-disease-taxonomy.csv`, `lib/cancer-center-mesh-taxonomy.ts`) is
  retired. The go decision was made on the population-widening evidence gathered before
  cutover: at Meyer Cancer Center's default thresholds, 146 candidates cleared ADD/recruit
  under the old taxonomy; 196 clear under the new one (+51/−1), combining the original C04
  widening with the gap #1/#3/#4 additions. Searching the relevance threshold for a
  "preserve who clears" recalibration (against the pre-gap-additions baseline) found the
  *default* threshold already near-optimal — raising it trades a small reduction in
  newly-qualifying candidates for a much larger loss of people who qualified before, at every
  value tested. Widening the definition was not undone by nudging a threshold; it was a real
  effect of a more complete definition, and the cutover was decided on those terms.
