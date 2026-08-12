# Cancer Center disease-expertise taxonomy

Status: **proposal, awaiting Cancer Center review.** Nothing here is wired into
the app, the ETL, or the search index. It is a script plus two curated seed
files that produce a reviewable sheet.

> **Update, cancer taxonomy versioned redesign:** the "how it works" mechanism
> sections below (the 18-code CSV, `buildCodeByUi`, the live MeSH-subtree walk)
> describe the ORIGINAL design and are now superseded. The script reads topics
> from the generated `CancerTaxonomyDescriptor` table (`lib/cancer-taxonomy.ts`)
> and rolls them up to person codes via `docs/cancer-center-person-rollup.csv`,
> per `docs/cancer-center-disease-taxonomy-decisions.md`'s D0/D0a. Everything
> else on this page — evidence model, weights, confidence tiers, focus,
> recency, suppression — is unchanged.

## What it answers

"Which cancers does each Meyer Cancer Center member actually work on?" — one
member may hold several, ordered by importance, each labelled with how much
evidence stands behind it.

## What already assigns people to cancers, and why this is not that

**Read this before writing any consumer.** Production already renders a
per-person, disease-named label, and it is not this one.

`TopicAssignment` (`prisma/schema.prisma:1211-1223`) stores `cwid -> topic` with
a score. The ReciterAI topic catalog is disease-named — *Breast Cancer, Lung
Cancer, Gastrointestinal Cancer, Gynecologic Oncology, Prostate & Urologic
Cancer, Melanoma & Skin Cancer, Neuro-Oncology, Hematology*. The top-scored row
is resolved to a label in `lib/api/popover-context.ts:102-131` and rendered
**bolded in the person hover card** (`components/scholar/person-popover.tsx:483`).

Its provenance is the opposite of this document's:

| | `TopicAssignment` | this taxonomy |
|---|---|---|
| Source | ReciterAI DynamoDB `FACULTY#cwid_*` rollups | MeSH tags on WCM pubs, grants, trials |
| Writer | `etl/dynamodb/index.ts:522-596`, full-replace | this script |
| Basis | an upstream score | counted evidence, auditable per row |
| Override | none | the point of this design |
| Public today | yes, hover card | no |

**The risk is not building an assignment; it is building a second one.** If a
curated disease label ships while `topTopic` keeps rendering, the site gives two
different public answers to "what cancer does this person work on," from two
unrelated pipelines, one of which nobody at WCM can correct. Reconciling them is
Open Decision 1 and precedes any UI work.

Two other things sit nearby and do *not* answer the question:

- **Meyer program codes** are curated by hand but **mechanism-based, not
  site-based** — CB/CGE/CPC/CT/ZY are Cancer Biology, Cancer Genetics &
  Epigenetics, Cancer Prevention and Control, Cancer Therapeutics, Non-aligned
  Clinical. A program tells you *how* someone works on cancer, never *which*.
- **`clinicalExpertise`** (POPS) is human-authored upstream and may literally
  read "breast cancer", but it is read-only in SPS and surfaces only when a
  search query matches it — never as a standing label.

What does not exist anywhere: a stored, per-person, disease-site-grained label
with a curation surface. The ingredients are already built and simply unjoined —
`matchedCodes()` (`lib/cancer-center-mesh-taxonomy.ts:103`) already produces
per-**paper** disease codes and powers an admin CSV export filterable by cwid.
Nothing rolls it up to a person.

## The taxonomy

`docs/cancer-center-disease-taxonomy.csv` — 18 disease codes over 29 NLM MeSH
descriptors (a code may span several descriptors, one per row).

Human-facing columns read "Cancer"; the `nlm_descriptor` column keeps NLM's own
wording ("Breast Neoplasms") because it is the join key into `mesh_descriptor`.
Names are resolved to descriptor UIs at runtime and the run **fails loudly** if
any name stops resolving, so an NLM rename can't silently drop a disease.

Deliberately absent:

- **No pediatric code.** Pediatric oncology is an age axis, not a site. MeSH has
  no clean descriptor and forcing one mis-tags adult researchers.
- **No pan-cancer / cancer-biology catch-all.** A basic scientist matching zero
  diseases is a real finding, not a coverage gap. Do not add a bucket to make
  the numbers look fuller.

### Anchor specificity

A descriptor can sit under two anchors when one anchor is itself a descendant of
the other — `Melanoma` lives under `Neuroendocrine Tumors` in MeSH. The naive
subtree walk therefore hands every melanoma paper to the endocrine code. Only
the **most specific** matching anchors are kept: any anchor whose tree number is
a proper prefix of another match is dropped.

This is not hypothetical. It silently mis-assigned 13 melanoma descriptors, and
also leaked thyroid and esophageal work into Head & Neck, until it was caught by
a melanoma specialist scoring nearly identically on two unrelated codes.

## Evidence

Four independent axes. A person needs none of them to be a member, and having
none is recorded as such rather than guessed at.

| Axis | Source | Lead | Supporting |
|---|---|---|---|
| Publications | `publication_author` + `publication.mesh_terms` | first / last / sole author | penultimate, middle |
| Grants | `grant.mesh_descriptor_uis` + `grant.role` | PI, Co-PI, PI-Subaward | Co-I, Key Personnel |
| Clinical trials | `clinical_trial.mesh_terms` + `person_clinical_trial.role` | Principal Investigator | Investigator |
| Clinical specialty | `scholar.pops_specialties`, board certifications | — | corroborates only |

The three MeSH sources do **not** share a storage shape, and each needs its own
reader before it can reach the shared subtree map:

- `publication.mesh_terms` — JSON, either bare strings or `{ui, label}` objects.
- `grant.mesh_descriptor_uis` — JSON array of descriptor **UIs**.
- `clinical_trial.mesh_terms` — **Text**, a semicolon-delimited list of
  descriptor **names**. Split on `;` only: descriptor names contain commas
  ("Carcinoma, Non-Small-Cell Lung"), so a comma split silently shreds them into
  non-resolving fragments. `selfCheck()` asserts this.

Authorship weights (`firstOrLast: 10, secondOrPenultimate: 4, middle: 1`) are
imported verbatim from `lib/search-index-docs.ts`, not re-invented, so this
ranking cannot drift from how search already values authorship. Sole authorship
counts as both first and last, matching `authorRole()`.

Grant and trial roles use the same lead/supporting split: being PI on a
disease-tagged award, or running the trial, is the same class of claim as
senior-authoring a paper on it.

```
pub_score = 10·(lead papers) + 4·(penultimate) + 1·(middle)
score     = pub_score + 10·(led grants + led trials) + 4·(supporting grants + supporting trials)
```

### Rank is decided by publications, not by the combined score

Ranking on `score` exposed the headline disease to the noisiest axis. One
keyword-resolved PI grant scores 10 and outranked **nine** middle-author papers
scoring 9 — so grant MeSH could pick a member's primary disease while the
confidence tiers, which deliberately cap that same lone grant at `medium` and
never `high`, looked on. What governs confidence must also govern rank.

Publications are the only axis with curated NLM indexing; grant MeSH is
keyword-resolved and trial MeSH comes from ClinicalTrials.gov enrichment. So
**`pub_score` decides rank**, `score` orders within equal publication evidence,
and grants and trials still raise confidence and can still contribute a disease
the publications alone would never surface. `selfCheck()` pins the nine-papers
counterexample.

`rank = 1` is the primary disease. Every component stays in the output so any row
can be audited back to its evidence.

## Focus: primary, secondary, peripheral

Cancer Center review (2026-08) raised two things confidence could not answer:
*"there are medium or low confidence areas that are pretty far afield from their
focus — could we allow someone to filter for a minor or secondary focus?"* and a
member listed under breast cancer whose only breast papers were **2011 and 2017**.

Confidence answers *how sure are we*. It cannot answer *is this what they work on
now*. So `focus` is a separate axis:

| Focus | Rule |
|---|---|
| `primary` | rank 1, not stale, confidence above `low` |
| `secondary` | rank ≥2, not stale, confidence above `low` |
| `peripheral` | no publication within `STALE_AFTER_YEARS` (8), or `low` confidence |

This is the filter the Center asked for: `focus = primary` is the headline
roster, `secondary` is genuine minor interests, `peripheral` is everything a
reviewer should not read as current practice.

### Recency is surfaced, never silently weighted

`first_year`, `last_year` and `recent_pubs` (within `RECENT_WINDOW_YEARS`, 5) are
emitted per row. They do **not** feed `score` or `rank`.

That restraint is deliberate and load-bearing. A scholar's uncurated papers are
simply absent from `publication_author`, and that gap is not random — it
concentrates on affiliated faculty, of whom **31.3% read ≥8 years stale on
curation alone**, against 8.2% of full-time faculty. A recency *weight* would
therefore demote the least-curated people and present it as a finding about their
focus. A recency *column* lets a human see `2011-2017, recent=0` and decide.
The dates come from `publication.year`, not `dateAddedToEntrez`, which is a
curation timestamp rather than a fact about the work.

## Confidence, not a pass/fail gate

An earlier draft used a hard threshold and a percentage-of-total-publications
share. Both were wrong:

- The **share test penalised prolific researchers.** A pathologist with 172
  papers had 16 neuroendocrine and 11 kidney/bladder papers rejected purely
  because the denominator was large. 43 people were affected; the worst case was
  43 colorectal papers rejected at 8.4%.
- The **hard gate buried sparse profiles**, which is exactly where a taxonomy is
  most useful.

Percentage is gone. The rule is now, with
`leadEvidence = lead papers + led grants + led trials`:

| Confidence | Rule |
|---|---|
| high | `leadEvidence >= 2` |
| medium | `leadEvidence == 1`, or ≥2 supporting awards/trials, or specialty + ≥3 papers |
| low | ≥3 papers in any position, any tagged award/trial, or specialty alone |

Volume of middle authorship can never reach `high`, however large. This is the
property that separates disease *ownership* from disease *collaboration*: a
biostatistician with a 2% lead share collapses from 10 diseases to 2, while a
researcher with a 63% lead share keeps their primary.

## Specialty corroboration and why a non-match is not a disagreement

`specialty_status` replaces an earlier bare Y/N, which conflated four different
situations and left an SME unable to audit a row (#2033):

| Value | Meaning |
|---|---|
| `match` | a mapped specialty of this member points at this code |
| `other-code` | member has mapped specialties, none is this code — **the only contradiction** |
| `code-unmapped` | no specialty in the map reaches this code, for anyone |
| `specialty-unmapped` | member has specialties, none appear in the map |
| `no-specialty` | no POPS specialty on file |

The output also carries the raw `specialties` string, so a reviewer can check the
row rather than take the flag on trust.

Four codes can never reach `match`, and that is a fact about American board
certification rather than a gap to fill: `BREAST`, `GI_PANCREAS`, `GI_UPPER` and
`SARCOMA` are all fellowship territory with no ABMS board. Rows for them report
`code-unmapped` — silence, not disagreement.

Specialty remains **corroboration only**: a match can raise confidence, a
non-match never lowers it, and no row reaches `high` on specialty. Whether
specialty alone should assign a disease at all is still open (#2033).

## Clinical specialty map

`docs/cancer-center-specialty-map.csv` — 24 rows, matched with the same
normalisation as `lib/clinical-mesh-anchors.ts` (lowercase, strip
non-alphanumerics) so POPS casing and punctuation drift can't cause a miss.

The high-volume specialty strings are **deliberately excluded**: Internal
Medicine, Medical Oncology, Hematology/Oncology, Hematology, Surgery, Pathology
and Radiology do not discriminate between cancers, and mapping them would assign
much of the roster to everything. Only specialties that name a site or system
are mapped. `Hematology` is mapped despite being high-volume: it reaches 4 of 18
codes, so unlike "Medical Oncology" it genuinely narrows. It cannot separate
leukemia from lymphoma — that is the publication axis's job. Adding it produced
58 specialty-only rows, all `low`. The existing `etl/clinical-mesh/specialty-anchors.csv` is unsuitable
here for the same reason — it anchors both "Medical Oncology" and "Gynecologic
Oncology" to `Neoplasms (C04)`, the whole cancer tree.

## Running it

```
npx tsx scripts/cancer-center-disease-assignments.ts > docs/cancer-center-disease-assignments.csv
```

Needs `DATABASE_URL` and in-VPC network access. Deterministic: the same database
state, the same two seed files **and the same `asOf`** produce byte-identical
output — verified by running twice and diffing at each stage as axes were added.
Sorts are total, so ties can never reorder between runs.

`asOf` (default today, override with `ASSIGNMENTS_AS_OF=YYYY-MM-DD`) is the one
wall-clock input, and it feeds **both** the active-membership filter and the
staleness cut, so those two can never disagree about what "now" means. Pinning it
makes a run reproducible across days.

`selfCheck()` runs before every execution and fails the run on the defects this
script exists to prevent: broad-anchor absorption, publication volume alone
reaching high confidence, the trial-MeSH comma split, and the lead/supporting
role splits for grants and trials.

The generated sheet is **not checked in** — it is ETL output and it names
individual faculty. That also means a copy someone downloaded is unversioned and
can silently go stale.

### Failure modes, and what each one looks like

| Condition | Behaviour | Why |
|---|---|---|
| An `nlm_descriptor` stops resolving | **Throws**, whole run fails | A silently dropped disease is worse than no sheet. The shipped ETL takes the same posture (`etl/cancer-center-collab-report/index.ts:126`) |
| A grant's MeSH is JSON scalar `null` | Excluded | Filtered on `JSON_TYPE(...)='ARRAY'`; `IS NOT NULL` over-reports because a JSON null passes it |
| A trial's MeSH names a non-disease descriptor | Contributes nothing | It lands in no disease subtree. Expected, not an error |
| A member is on the roster but absent from `scholar` | No rows | There is deliberately **no FK** from `CenterMembership` to `Scholar` (incoming hires), so a typo'd CWID is accepted and simply produces nothing |
| Two anchors overlap | Most specific wins | Otherwise a broad anchor absorbs a narrow one's whole cohort — see Anchor specificity |

### Known gap: the output carries no version stamp

The columns have changed three times (grants, then trials, then
`specialty_status` + `specialties`). A reviewer holding an older copy has no way
to tell — this already happened, and cost a review cycle on a sheet that could
not show trial or specialty evidence. **Recommended:** emit a `# schema_version`
comment line, which `parseCsv` already skips. Deliberately *not* a timestamp: a
generated-at stamp would break the byte-identical determinism property, which is
worth more. Version the schema, not the run.

## Human override

The shape is settled and is the house pattern: **a deterministic script proposes,
a human confirms or corrects, the human's answer wins forever.** No model is
involved. This is exactly how NCI Table 2A treats program codes (resolved from
membership, an honest `null` when unresolvable, never inferred) and how
peer-review status works (closed-list lookup, no badge, "a lookup, not a
judgment").

### The four-part contract

Copied from `CancerCenterFundingAward`, which already ships all four:

1. **Per-value provenance.** Every stored assignment carries
   `source: "script" | "human"`. Editing in `/edit` flips it to `human`.
2. **Non-clobber, with the subtle case.** A re-run must not overwrite `human`.
   And — the bug a naive check introduces — a re-run that *fails or returns
   nothing* must not erase a value a prior successful run wrote. The funding
   importer states the rule explicitly: a transient failure must not revert a row
   to "not yet inferred."
3. **Audit.** `appendAuditRow` inside the same transaction as the write,
   recording the real actor **and** `impersonatedCwid`, with full before/after.
4. **Visible state.** A script-sourced value reads as a suggestion until a human
   confirms it. The funding card's contract — "an LLM value must never read as a
   settled fact" — applies identically to a script value.
5. **Drift is surfaced, never silently honoured.** Non-clobber is right, but
   *forever* is long. A human-confirmed disease whose evidence later falls to
   zero, or a human-rejected disease whose evidence subsequently triples, must
   raise a visible disagreement — a flag on the row, never an automatic
   overwrite. Without this the curation layer fossilizes and nobody can tell
   which human decisions the evidence still supports. Concretely: store the
   evidence snapshot (`pub_score`, `score`, `confidence`) as of the confirming
   decision, and emit an `evidence_drift` column comparing it to the current run.
   The human still wins; they just stop winning invisibly.

### Reseed safety: absence must never mean a decision

`FamilyTierDecision` (`prisma/schema.prisma:2951-2971`) exists because of exactly
the bug this design could reintroduce. In the methods-family work, "public" was
encoded as *the absence of a row*, so every ETL reseed silently reverted human
decisions. The fix was a durable, explicit record of the human's choice, held
**independently of row membership**. Its doc comment generalises the rule to any
future curation loader.

Applied here: **"this person does NOT work on breast cancer" is a decision, not a
missing row.** A curator removing a suggested disease must write a durable
rejection, or the next run silently restores it. Any schema that represents
rejection as deletion is wrong.

### Where the UI goes

The roster editor at `/edit/center/<code>`, alongside Program. Two reasons it
fits without new chrome:

- The Type/Program columns are already **data-driven gated**, not hardcoded to
  Meyer — `hasPrograms = programs.length > 0`
  (`components/edit/center-roster-card.tsx:96`). A disease column can hang off
  the same gate.
- Authorization, denial logging, impersonation handling and the audit-history
  view (`/edit/center/[code]/history`) already exist on that surface via
  `canEditUnit` — Superuser, comms steward, or a **direct** Owner/Curator grant.
  Department owners deliberately do not cascade into centers, and roster
  membership itself confers no edit rights.

### Cost of entry: audit registration in five places

A new editable entity needs its audit enum registered in **five** places in this
codebase. TypeScript unions alone produce green tests and a 500 on **every**
write, because `appendAuditRow` runs inside the write transaction. Budget for
this explicitly; it is the difference between "the cell is editable" and "the
feature works."

## Open decisions

Ordered by what blocks what. 0, 1 and 2 gate the schema; the rest can move after.

0. **Reconcile with the versioned two-axis ruleset (#2356, MERGED).** This spec's
   18-code CSV is the file that redesign exists to replace. Its own rationale
   names this taxonomy directly: *"a single hand-picked list: 18 disease codes,
   29 MeSH anchor terms, no generation, no provenance, no review queue. It
   conflates two different questions into one axis."* The ruleset separates them:

   | Axis | Shape | Vocabulary |
   |---|---|---|
   | `cancer_relevant` | boolean | all of MeSH C04 minus Cysts/Hamartoma, plus ~30 curated non-C04 headings |
   | `topics` | `string[]`, multi-valued, legitimately empty | 31 local buckets — 25 disease-site plus 6 cross-cutting `cc-*` |

   State: generator, `CancerTaxonomyDescriptor` table and ETL step are **merged
   and have run** (687 relevant descriptors, 881 after the #2358 content review,
   versus 308 under this taxonomy). But **nothing reads the new table** — all
   five live consumers still walk this CSV, and the cutover is unbuilt, tracked
   by no issue, and gated on a product decision, because widening relevance
   while holding ADD/recruit thresholds fixed is "a second, separate decision,
   not a neutral migration step." Measured at Meyer: 146 clear ADD becomes 196
   (+51/−1), and threshold recalibration was tested and **cannot** undo it.

   The choice: consume the ruleset's `topics` as this rollup's site vocabulary,
   or define the 18 codes as an explicitly curated view over it. Either is
   defensible; discovering it at cutover is not. Left unresolved, the site ends
   up with **three** disease vocabularies from three pipelines — `topTopic`,
   this, and the ruleset.

   **Blocking mechanical issue, and this one is a genuine gap in the ruleset,
   not just in this spec.** The anchor-specificity rule below has *no counterpart
   in the new generator*: `topics` is a plain set union, narrowed only by the
   experimental-models strip and a hand-declared `fallback` column on 6 rows.
   `Melanoma` → `melanoma-skin` and `Neuroendocrine Tumors` →
   `thyroid-neuroendocrine` are both plain `topic_subtree` rules, so under the
   ruleset every melanoma descriptor carries **both** buckets — the exact
   absorption this taxonomy had to fix. Multi-valued assignment makes that not
   obviously an error the way it was for a single code, but the case appears
   nowhere in the ruleset's notes and is covered by no test. Adopting `topics`
   without resolving it silently discards this system's one piece of real
   assignment intelligence.

1. **Does the curated label replace, override, or sit beside `topTopic`?**
   Beside means the site publishes two competing answers from two unrelated
   pipelines. Replace means the hover card reads from this instead. Override
   means `TopicAssignment` stays but a curated row wins at read time. This is a
   question about what the public site claims, not an implementation detail.
2. **Which rows become records? — DECIDED: persist all rows with their
   confidence, and gate at display time.** Storing everything and choosing the
   cut in the consumer is the reversible version of a decision the spec itself
   flags as a migration rather than an edit. The framing collision behind #2033
   stands as the reason the display contract must still be written down: the
   sheet ranks *evidence*, an SME read it as *a clinical roster*, and both
   readings are reasonable.
3. **Are the 18 codes the right cut?** They follow MeSH site/histology, not the
   Center's disease management teams. Largely subsumed by Decision 0 — the
   ruleset offers 25 site buckets with provenance. If DMTs are the target, that
   mapping should be stated by the Center rather than inferred by either system.
4. **Should specialty alone assign a disease? — DECIDED: no.** Cancer Center
   review: *"for some of the faculty with a low frequency of publications, there
   is a lot of noise around their specialty."* A board-certified hematologist
   with no leukemia, lymphoma, myeloma or MDS output was carrying all four as
   rows. Specialty corroborates evidence; it does not manufacture it. Reverting
   is one `|| specialtyMatch` in `confidenceOf`.
5. **How should breadth be displayed?** A cytopathologist legitimately leads work
   across many organs; `rank` exists so a consumer can take the top N rather than
   all of them, but the cut-off is a product call.
6. **Prod has no Meyer roster.** All figures come from staging; the prod
   membership load is tracked separately (#906 / #552).

## Known limitations

- **Staging only.**
- **Grant MeSH is keyword-resolved**, not NLM-curated indexing like publication
  MeSH — 1,256 of 3,487 Meyer grants carry a real descriptor array. It is the
  noisier axis, which is why one PI grant reaches `medium` but never `high`
  alone. Coverage must be read with `JSON_TYPE(...) = 'ARRAY'`; `IS NOT NULL`
  over-reports, because a JSON scalar null passes it.
- **Trial MeSH covers about half the trials** — 370 of 686 Meyer person-trial
  links. It comes from the ClinicalTrials.gov enrichment, so trials with no NCT
  registration carry none, and a registered trial's terms can include non-disease
  descriptors ("Recurrence") that land in no disease subtree. 53 members gain
  disease evidence from trials; 12 of them had no publication or grant evidence
  for that disease at all.
- **Publication and grant suppression ARE applied** (was a footnoted gap).
  A person-named artifact headed for SME review must not carry papers hidden for
  cause, whatever the count delta. The people-side predicate is reused verbatim:
  a pmid is excluded if it carries a whole-entity takedown (`contributor_cwid IS
  NULL` — which means *everyone*, not *no one*) or a per-author hide for that
  cwid. Active means `revoked_at IS NULL` **only**; revoked rows are retained,
  never deleted, so omitting that predicate would silently re-hide restored
  papers. Grant takedowns are whole-entity, keyed on `external_id`. Excluded
  counts are reported on stderr each run. Derived-dark is deliberately not
  applied — on the people side it cannot fire, per the indexer's own reasoning.
- **Clinical trials have no suppression concept.** `EntityType` has no trial
  member, so a trial cannot be hidden the way a paper or grant can.
