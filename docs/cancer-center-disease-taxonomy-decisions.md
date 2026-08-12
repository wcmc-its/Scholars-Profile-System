# Cancer Center disease expertise: decisions needed

Working document for Cancer Center leadership, Sydney, and engineering. Records
what has been decided, what is still open, and what each open item blocks.

Companion documents: `cancer-center-disease-taxonomy-spec.md` (how it works, and
why each rule is the way it is) and the generated sheet
`cancer-center-disease-assignments.csv` (not checked in — it names individual
faculty).

Status: **proposal.** Nothing is wired into the app, the ETL, or the search
index. The work sits on the unmerged branch `feat/cancer-center-disease-taxonomy`
(6 commits). All figures are from **staging**.

## The question this answers

"Which cancers does each Meyer Cancer Center member actually work on?" A member
may hold several, ordered by importance, each labelled with how much evidence
stands behind it and whether it is current.

## What exists today

A deterministic script — same database state and same curated inputs produce
byte-identical output, verified by running twice and diffing. No model, no
sampling, no hand-tuning. Every weight is either an existing repo constant or a
checked-in CSV row.

Evidence comes from four independent sources, all folded through one MeSH
subtree map:

| Axis | Coverage on the Meyer roster | Lead signal |
|---|---|---|
| Publications | the base axis | first / last / sole author |
| Grants | 1,256 of 3,487 awards carry MeSH | PI, Co-PI, PI-Subaward |
| Clinical trials | 370 of 686 person-trial links | Principal Investigator |
| Clinical specialty | 24 mapped specialty strings | corroborates only |

Current output: **340 active members, 287 carrying at least one disease, 1,288
rows.** By display band: **243 primary, 438 secondary, 607 peripheral.** 44
members are in the directory with no disease evidence; 9 roster CWIDs have no
scholar record at all.

## The vocabulary: 18 codes

`docs/cancer-center-disease-taxonomy.csv`. Human-facing labels read "Cancer"; the
descriptor column keeps NLM's own wording because it is the join key into
`mesh_descriptor`. Counts are from the current staging run — *primary* is how
many members hold the code as their headline disease, *any* is how many carry it
at any focus band.

| Code | Label | NLM MeSH descriptors | Primary | Any |
|---|---|---|---:|---:|
| `BREAST` | Breast Cancer | Breast Neoplasms | 40 | 137 |
| `LUNG` | Lung and Thoracic Cancer | Lung Neoplasms; Mesothelioma | 26 | 110 |
| `GU_PROSTATE` | Prostate Cancer | Prostatic Neoplasms | 30 | 88 |
| `GI_COLORECTAL` | Colorectal Cancer | Colorectal Neoplasms | 23 | 104 |
| `HEME_LEUK` | Leukemia | Leukemia | 18 | 79 |
| `HEME_LYMPH` | Lymphoma | Lymphoma | 17 | 92 |
| `SKIN` | Melanoma and Skin Cancer | Melanoma; Skin Neoplasms | 15 | 76 |
| `NEURO` | Brain and Nervous System Cancer | Central Nervous System Neoplasms | 12 | 57 |
| `GU_OTHER` | Kidney Bladder and Testicular Cancer | Kidney Neoplasms; Urinary Bladder Neoplasms; Testicular Neoplasms | 9 | 64 |
| `GI_LIVER` | Liver and Biliary Cancer | Liver Neoplasms; Biliary Tract Neoplasms | 8 | 69 |
| `GI_PANCREAS` | Pancreatic Cancer | Pancreatic Neoplasms | 8 | 57 |
| `GYN` | Gynecologic Cancer | Ovarian Neoplasms; Uterine Cervical Neoplasms; Endometrial Neoplasms | 8 | 68 |
| `HEME_MDS_MPN` | Myelodysplastic and Myeloproliferative Cancer | Myelodysplastic Syndromes; Myeloproliferative Disorders | 7 | 41 |
| `HEME_MYELOMA` | Multiple Myeloma | Multiple Myeloma | 7 | 34 |
| `HEAD_NECK` | Head and Neck Cancer | Head and Neck Neoplasms | 5 | 45 |
| `ENDO` | Thyroid and Neuroendocrine Cancer | Thyroid Neoplasms; Neuroendocrine Tumors | 4 | 49 |
| `GI_UPPER` | Esophageal and Gastric Cancer | Stomach Neoplasms; Esophageal Neoplasms | 4 | 46 |
| `SARCOMA` | Sarcoma and Bone Cancer | Sarcoma; Bone Neoplasms | 2 | 72 |

Two patterns worth a Center eye. **Sarcoma is almost never a headline** — 2
primary against 72 members carrying it, which fits sarcoma being a shared
consult service rather than a primary practice, but is worth confirming.
**Endocrine and upper-GI are similarly thin** at 4 primary each.

Deliberately absent: **no pediatric code** (an age axis, not a site, with no
clean MeSH descriptor), and **no pan-cancer catch-all** (a basic scientist
matching zero diseases is a real finding, not a gap to paper over).

## The two-layer model

Settled after review. **One base vocabulary, two views with different jobs.**

| | Article layer | Person layer |
|---|---|---|
| Job | classify a paper | describe a person |
| Shape | exhaustive, multi-valued, `unassigned` legal, no ranking | identity-shaped, ranked, deliberately **not** exhaustive |
| Vocabulary | 25 site + 6 cross-cutting buckets (#2356 ruleset) | 18–19 codes, defined as a rollup over the article buckets |
| Owner | the ruleset, extendable by the Center | `cancer-center-person-rollup.csv` |

The person taxonomy is **never a second ontology**. It is a rollup map, checked
in as `docs/cancer-center-person-rollup.csv`, which guarantees every person label
is explainable by article evidence and turns "what should the person taxonomy be"
into a one-page mapping the Center can correct. That is the right artifact to
hand a group that does not yet have a firm view: they are not being asked to
design an ontology, only to red-pen a mapping table and a label list.

### What the rollup does with the 7 thin buckets

| Article bucket | Person code | Why |
|---|---|---|
| `endocrine-other` | Thyroid & Endocrine | same endocrine practice; `ENDO` relabelled accordingly |
| `eye` | Melanoma & Skin | adult eye cancer is overwhelmingly ocular melanoma, treated by melanoma teams |
| `germ-cell-embryonal` | Kidney, Bladder & Testicular | dominant adult site is testicular — **flagged**, since ovarian germ-cell descriptors arguably belong to Gynecologic, and the map can split at descriptor level |
| `gi-other` | Colorectal & Anal | anal cancer sits with colorectal clinically |
| `peritoneal-abdominal` | Colorectal & Anal | peritoneal surface malignancy is surgical-onc / appendiceal territory |
| `hematologic-other` | Blood Cancers (MDS, MPN & Other) | rescues histiocytic and rare heme without a junk-drawer code |
| `unknown-primary` | *none* | CUP is a diagnostic category, not an identity |

The rule is about **rare article buckets, not low primary counts**. Sarcoma stays
at 2-primary/72-any, because that shape is a finding about consult practice
rather than a vocabulary defect.

### The cross-cutting buckets stay off the person axis

Mechanism-of-work already has a curated person-level answer at Meyer: **Program**
(CB / CGE / CPC / CT). Deriving "cancer biology" as evidence-based person
expertise would publish a second, noisier mechanism label beside a hand-curated
one — precisely the two-answers problem D1 exists to kill. The 44 zero-disease
basic scientists are not a gap to fill; their roster answer is their Program, and
"matches no disease" stays a real finding.

**One proposed exception: `cc-hereditary` → Hereditary Cancer & Genetics**, as a
19th person code. Unlike the other five it names an actual clinical practice —
cancer genetics clinic, genetic counselling — that is invisible on the site axis.
The risk is every BRCA-adjacent breast researcher carrying it as secondary noise;
rank and confidence already exist to handle that. Proposed for the Center to
accept or strike.

### Display labels need a lay pass

`mds-mpn` and "Myelodysplastic and Myeloproliferative Cancer" are both wrong for
a public hover card. The rollup carries a `display_label` column in the register
a patient-facing surface needs — "Blood Cancers (MDS, MPN & Other)". The Center
should review the words people will actually see, not just the code list.

### One axis people have that articles do not: pediatric

"Pediatric oncologist" is arguably the strongest identity label in the building,
and it should be a **boolean modifier orthogonal to site**, not a site code — a
pediatric neuro-oncologist is `NEURO` + pediatric, which is how they would
describe themselves. It must not come from MeSH: Child/Infant check tags are
ubiquitous and useless.

**But deriving it from appointment data does not work as cleanly as expected, and
this was measured.** Two sources disagree badly on the Meyer roster:

| Source | Members flagged |
|---|---|
| current `appointment.organization` naming Pediatrics | **2** |
| `scholar.primary_department` naming Pediatrics | **10** |

All 8 disagreements run the same way — a Pediatrics primary department with no
current pediatric appointment row, so appointment coverage is simply thin. Worse,
inspecting the 10 shows department membership is **organisational housing, not
clinical identity**: alongside genuine paediatric oncologists sit several basic
scientists whose labs are housed in Pediatrics. A department-derived boolean
would label bench scientists as paediatric oncologists.

**Recommendation:** derive the modifier from **board specialty** (`Pediatric
Hematology-Oncology`, `Pediatric Neurological Surgery`, `Pediatrics`), which
names clinical practice rather than reporting lines, and treat department as
corroboration only. This mirrors the rule already established for the site axis:
specialty corroborates, it does not manufacture.

## Decided

### D2. What gets persisted — all rows, gated at display

Store every row with its confidence and focus; let the consumer choose the cut.
The alternative — persisting only primary rows, or only above a confidence floor
— bakes a display decision into the schema, and the spec's own warning applies:
getting persistence scope wrong is a migration, not an edit.

*Decided by: Paul.*

### D4. Specialty alone does not assign a disease

Cancer Center review: *"for some of the faculty with a low frequency of
publications, there is a lot of noise around their specialty."* A board-certified
hematologist with no leukemia, lymphoma, myeloma or MDS output was carrying all
four as zero-evidence rows. Specialty now corroborates evidence; it does not
manufacture it. Removed 86 rows and 9 members who had nothing else.

Reverting is a one-line change if the Center wants the wider net back.

*Decided by: Cancer Center review, 2026-08.*

### D5. Minor and secondary interests are displayed separately

Cancer Center review: *"could we allow someone to filter/search for a minor or
secondary focus?"* A `focus` column now separates:

| Focus | Meaning |
|---|---|
| `primary` | rank 1, current, above `low` confidence — the headline roster |
| `secondary` | a genuine minor interest, still current |
| `peripheral` | no publication in 8 years, or `low` confidence |

Recency is reported (`first_year`, `last_year`, `recent_pubs`) but deliberately
does **not** feed score or rank — see Risks.

*Decided by: Cancer Center review, 2026-08.*

## Open — D0/D0a are resolved and executed; D1 still blocks

### D0. Reconcile with the ruleset — RESOLVED BY #2361, not by us

**The cutover shipped while this was in review.** PR #2361 cut the Reports tab,
CSV export and modal over to `CancerTaxonomyDescriptor`, and in doing so
**deleted both `docs/cancer-center-disease-taxonomy.csv` and
`lib/cancer-center-mesh-taxonomy.ts`**. The 18-code taxonomy no longer exists on
master. `parseCsv` moved to `lib/csv.ts`; `lib/cancer-taxonomy.ts` is the single
reader, exposing `topicsByUi: Map<descriptorUi, string[]>`.

So the question is answered: **the ruleset is the vocabulary.** The two-layer
model above is no longer one option among several — it is the only coherent
shape, because the person layer has nothing else to sit on. The rollup map
(`cancer-center-person-rollup.csv`) is now the whole person-vocabulary
definition.

Consequences for this work, none optional — **all three done** in the rewire:

- **The branch cannot be rebased as-is.** Its first commit adds a file master has
  since deleted; replaying it would resurrect a retired taxonomy. *(Done: the
  rewire is a fresh branch off master, not a rebase.)*
- **The script must read `CancerTaxonomyDescriptor`**, not a local CSV, and apply
  the rollup over `topics`. *(Done.)*
- **`parseCsv` should come from `lib/csv.ts`** rather than the script's own copy.
  *(Done.)*

### D0a. RESOLVED — #2370 shipped (#2372); the person layer reads the fixed table directly

Landed the way this section recommended: most-specific-wins now lives in the
generator (`etl/cancer-taxonomy/generate.ts`, merged as #2372), and the
rewired assignment script reads `topics` straight off `CancerTaxonomyDescriptor`
via `lib/cancer-taxonomy.ts` with no anchor-specificity logic of its own —
option 1 below, not option 2. The measurement that followed from this bug is
preserved as the historical record:

```
Melanoma (D008545)  ["germ-cell-embryonal", "melanoma-skin", "thyroid-neuroendocrine"]
Uveal Melanoma      ["eye", "germ-cell-embryonal", "melanoma-skin", "thyroid-neuroendocrine"]
```

`Melanoma` is a MeSH descendant of both `Neuroendocrine Tumors` and `Neoplasms,
Germ Cell and Embryonal`, and the generator resolves `topics` as a plain set
union with no most-specific-anchor rule — the rule the retired lib had, which
#2361 removed the last copy of. 92 of 878 descriptors are multi-topic.

For the article axis this only mis-buckets a paper. For the **person** axis it is
fatal: every melanoma researcher would surface as a neuroendocrine and germ-cell
researcher. Filed as **#2370**.

**Two ways forward, and the choice matters:**

1. **Wait for #2370 to restore most-specific-wins in the generator**, then have
   the person layer read the precomputed table directly. One implementation of
   specificity, in the place that owns it. Preferred.
2. **Re-derive specificity in the person layer** from `docs/cancer-taxonomy-ruleset.csv`
   anchors plus `mesh_descriptor.tree_numbers`. Unblocks immediately, but ships a
   second implementation of a rule that belongs upstream — and the two can drift.

Recommend 1 unless the person layer is urgent, in which case 2 with an explicit
note to delete it when #2370 lands.

**Taken: option 1.**

### D1. Replace, override, or sit beside `topTopic`?

Production **already** renders a per-person disease-named label. `TopicAssignment`
holds `cwid → topic` with a score, drawn from ReciterAI's catalog — *Breast
Cancer, Lung Cancer, Gynecologic Oncology, Melanoma & Skin Cancer,
Neuro-Oncology* — and the top-scored one appears in bold on the person hover
card. It is written by ETL as a full replace, from an upstream score, and
**nobody at WCM can correct it.**

| Option | Consequence |
|---|---|
| Replace | the hover card reads from the curated label; one answer, correctable |
| Override | `TopicAssignment` remains, a curated row wins at read time |
| Sit beside | the site publishes two different answers to the same question |

This is a question about what the public site claims, not an implementation
detail, which is why it is not an engineering call.

*Needs: Sydney, with Cancer Center input.*

## Open — these do not block

### D3. Are 18 codes the right cut? — SUPERSEDED by the two-layer model

Answered by the rollup: 18 site codes (19 with Hereditary), defined over the
article buckets rather than as their own ontology, plus a pediatric modifier and
Program for mechanism. If disease management teams are the target, the Center
states that as edits to the rollup map — which is a review they can do without
designing anything.

### D6. Production has no Meyer roster

Every figure here is staging. The production membership load is tracked
separately (#906 / #552).

## What is needed, and from whom

### From the Cancer Center

0. **Red-pen `cancer-center-person-rollup.csv`.** This is the main ask and the
   only one that requires domain judgement rather than a preference. It is a
   31-row mapping table: which article bucket becomes which person label, which
   buckets become no label at all, and what the public-facing wording should be.
   Specific things flagged for a decision inside it: whether ovarian germ-cell
   should split from testicular; whether peritoneal deserves its own code if WCM
   runs a HIPEC practice; and whether **Hereditary Cancer & Genetics** should
   exist as a 19th code or be struck.
1. **Validate the focus bands** against the sheet — particularly whether
   `peripheral` (607 rows, nearly half) should ship at all as a filterable tier,
   or be withheld. Some peripheral rows are people whose recent work simply is
   not curated yet, so withholding has a cost too.
2. **Confirm the deliverable contract.** The sheet ranks *evidence*; an earlier
   reviewer read it as *a clinical roster of pancreatic surgeons*. Both readings
   are reasonable, and the difference has to be written down rather than left to
   each consumer. This is the framing collision behind #2033.
3. **Curate upstream where useful.** 9 roster CWIDs have no scholar record —
   these are indistinguishable from incoming hires by design, so only a human can
   say which are typos.

### From Sydney

D0 and D1. Both gate schema; neither is an engineering decision.

### From engineering, once D0 and D1 land

1. Assignment and human-decision tables. **A curator's rejection must be a stored
   decision, never an absent row** — the methods-family work shipped that bug
   once, where "public" was encoded as the absence of a row and every reseed
   silently reverted human choices.
2. Audit enum registration **in five places**. TypeScript unions alone give green
   tests and a 500 on every write, because the audit append runs inside the write
   transaction.
3. The override column in the roster editor beside Program, which already has the
   authorization, denial logging, impersonation handling and audit-history view.
4. The drift flag: a confirmed disease whose evidence later disappears, or a
   rejected one whose evidence triples, must become visible rather than silently
   honoured forever.

### Immediately, independent of any decision

- **Rewire the script to `CancerTaxonomyDescriptor` before any push.** *(Done.)*
  The original plan — rebase and open a PR — was invalid: the branch's first
  commit added a file #2361 deleted. The rewire is a fresh branch off master,
  not a rebase. (The earlier note about deduplicating against
  `lib/cancer-center-mesh-taxonomy.ts` is moot; that module no longer exists.)
- File the ruleset anchor-nesting gap described in D0. *(Done — #2370, shipped
  as #2372.)*
- Narrow #2033 to the surviving framing question; its concrete asks are done.
- **The relabels are applied.** `ENDO` -> "Thyroid & Endocrine Cancer",
  `GI_COLORECTAL` -> "Colorectal & Anal Cancer" and `HEME_MDS_MPN` -> "Blood
  Cancers (MDS, MPN & Other)" now ship as `display_label` values in
  `docs/cancer-center-person-rollup.csv`, which the rewired script reads
  directly — landing together with the cutover onto `CancerTaxonomyDescriptor`,
  as planned, rather than early against the old 18-code file.
- Add a `schema_version` line to the output. *(Done — the CSV's first line is
  `# schema_version: ruleset:<sha12> mesh<year>:<sha12>`, sourced from the
  `EtlRun` row that produced the descriptor rows this run read, so it stays
  byte-identical across repeated runs against the same taxonomy generation.)*

## Risks and things deliberately not done

**Recency is surfaced, not weighted.** Uncurated publications are simply absent
from the data, and that gap is not evenly spread — it concentrates on affiliated
faculty. A recency weight would demote the least-curated people and present it as
a finding about their focus. Spot-checking the Meyer roster found the exposure
small (14 affiliated members, 7 with thin records, and the Center reports their
publication coverage is good), so this could be revisited — but the year columns
should stay regardless, since reviewers demonstrably read them.

**No model is involved anywhere**, and that follows the precedent this codebase
set the hard way. Bedrock program-guessing was removed even though it had a
closed list, a null-return instruction, and a second sanitize gate, and even
though it had never fired in production: *"the capability to guess should not
exist regardless of how often it fires."* Disease assignment has grounded MeSH
evidence, so it belongs on the deterministic side by that same test.

**Publication and grant suppression are applied.** 51 suppressed grants were
being counted as disease evidence before this was added. A person-named artifact
headed for review must not carry material hidden for cause.

**The generated sheet is not checked in.** It is ETL output and it names
individual faculty; this repository is public.
