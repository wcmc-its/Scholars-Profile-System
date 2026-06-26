# Funding matcher — accuracy improvements & evaluation

Status: planning / ideas. Owner: TBD. Last updated: 2026-06-26.

How to make the funding recommendations more accurate, and how to *measure*
whether they are — including an LLM-orchestrated evaluation that uses recent
awarded grants as ground truth.

Related: the per-scholar QA lens shipped in #1292 (a superuser sees "Grants for
me" for any scholar, flag-independent) is the natural surface for capturing the
human judgments this doc relies on.

---

## 1. How the matcher scores today

`combineScore` (`lib/api/match-opportunities.ts`):

```
score = 1.0·topicAffinity
      + 0.5·stageAppeal·topicAffinity      # stage multiplies topic, can't float off-topic up
      + 0.25·meshOverlap
      + 0.1·deadlineProximity
```

- **topicAffinity** — cosine(scholar topic vector, opportunity topic vector) over
  ReciterAI **parent topic IDs**. Scholar vector = L2-normalized **sum of
  `publication_topic.score`**, year ≥ 2020, **all author positions**
  (`scholarTopicVector`).
- **meshOverlap** — **Jaccard of raw MeSH-UI strings** (scholar `publicationMeshUi`
  vs opportunity `meshDescriptorUi`). Exact-match, **hierarchy-blind**,
  "best-effort secondary."
- **stageAppeal** — `opportunity.appealByStage[scholarStage]`.
- **deadlineProximity** — time decay; rolling/continuous = 0.5 baseline.
- Hard filters (OpenSearch Stage 1): status open/forecasted/continuous, not past
  due, `us_eligible`, stage-appropriate eligibility flag.

The accuracy weak spots fall out of this: a **flat topic sum** (no notion of
*core vs incidental*), **exact-string hierarchy-blind MeSH**, and **one
un-faceted blend**.

---

## 2. Accuracy ideas (prioritized, cheap-first)

Tags: `[lookup]` deterministic, no model · `[moderate]` · `[heavy]` embeddings/LLM
· `[data]` needs labels.

### 2.1 Weight how important each area is `[lookup]`
- **Within the scholar** — `scholarTopicVector` sums *every* paper equally. Add
  **recency decay** (recent pubs weigh more, replacing the hard 2020 cliff) and
  **authorship weighting** (first/last author dominate). Makes a scholar's current
  *core* drive matches, not their long tail.
- **Global specificity (IDF)** — cosine treats every topic dimension equally.
  Weight each topic by inverse corpus frequency so **distinctive overlaps are
  decisive** and ubiquitous topics stop manufacturing matches.
- **Within the opportunity** — verify the opp `topicVector` per-topic scores
  reflect the *primary aim*, not incidental NOFO mentions (see 2.8).

### 2.2 Index to MeSH via lookup or LLM `[lookup → LLM fallback]`
Today "Breast Neoplasms" vs "Neoplasms" scores **zero** despite parent/child.
- **Tree-aware overlap (lookup)** — use MeSH tree numbers; parent/child/sibling
  get partial credit by tree distance. Biggest win on this axis, fully
  deterministic.
- **Synonym/entry-term normalization** — collapse lay/variant terms to canonical
  descriptors. **Reuse #1258** (lay-term→topic synonym anchors already build this).
- **LLM only where lookup fails** — extract MeSH-like concepts from messy NOFO
  text for opps lacking descriptors. One-time over the corpus (~237 opps) → cheap.

### 2.3 Segregate terms into facets (disease / population / method) `[lookup]`
MeSH tree categories *are* the buckets, free via lookup: **C** Diseases · **B**
Organisms · **D** Drugs/Chemicals · **E** Techniques/Methods · **M** Named Groups
(populations) · **G** Phenomena.
- Compute **per-facet overlap** instead of one flat Jaccard.
- **Require/boost disease-facet alignment** — strongest precision lever; a method
  match on a different disease is the classic false positive.
- **Facet weights by opportunity type** — a methods RFA weights method; a disease
  RFA weights disease.
- Doubles as the **"why is this rec weak"** diagnostic in the QA tab: "matched on
  disease ✓ method ✓ population ✗".

### 2.4 Fix the forward/reverse asymmetry `[lookup, high precision]`
The reverse matcher (`rankResearchers`) filters to **first/last author**; the
forward `scholarTopicVector` does **not**. Align them so middle-author cameos stop
inflating a scholar's footprint. Reuse the existing rule.

### 2.5 Semantic embedding axis `[heavy, highest recall]`
Both current axes are exact-ID / exact-string → semantically-related-but-
differently-labeled concepts score zero. Add a parallel axis: cosine of
scholar-corpus embedding vs opportunity-text embedding (Bedrock). One-time per
opp + cached per scholar. Do *after* the cheap lookups if they're not enough.

### 2.6 Award-mechanism ↔ career-stage fit `[moderate]`
`stageAppeal` is one scalar. Sharpen to award-type fit (a postdoc shouldn't see
R01s ranked high; boost ESI-eligible R01s for early faculty). ESI logic already
exists in the reverse matcher — extend it forward.

### 2.7 Feedback loop → learned weights `[data, multiplier]`
The blend weights (`1.0/0.5/0.25/0.1`) are hand-set. Capture superuser 👍/👎 per
rec in the QA tab; a labeled set lets you **fit** the weights (and the new facet
weights) instead of guessing. Compounds with everything above.

### 2.8 De-noise the opportunity topic vectors `[upstream, ReciterAI]`
Matching can't beat a bad opp representation. Audit how opp `topicVector` /
`meshDescriptorUi` are generated from NOFO text. This is the ceiling on
everything else.

**Where to start:** 2.4 + 2.1 (authorship/recency/IDF in the scholar vector) →
2.3 + 2.2 (facet bucketing + MeSH tree overlap, both lookups, both feed the QA
"why") → 2.7 (start logging now) → 2.5 only if gaps remain.

---

## 3. Evaluating recommendation accuracy (LLM-orchestrated)

A human ultimately judges relevance, but an LLM can get most of the way and pull
the human in only where it's uncertain. Two **complementary tracks**:

- **Track A — LLM-judge relevance eval** (forward-looking): are *today's* top-N
  recs any good?
- **Track B — grant backtest** (retrospective ground truth): would we have
  surfaced what scholars *actually won*?

They answer different questions. A measures precision of the live ranking; B
validates against real-world outcomes. Run both.

### 3.1 Track A — LLM judge panel

For a stratified sample of scholars (by department, career stage, productivity),
run the matcher → top-N opportunities, then:

1. **Per-(scholar, opportunity) rubric judgment.** An LLM judge reads the
   scholar's profile (topics + representative abstracts) and the opportunity
   (synopsis, eligibility, mechanism) and returns a **structured** verdict:
   - relevance 0–3 (irrelevant / tangential / plausible / strong fit)
   - per-facet verdict (disease ✓/✗, method, population, stage-appropriate)
   - one-line rationale
   - eligibility red flags
2. **Adversarial / multi-lens pass.** A second judge tries to **refute** every
   "strong fit"; or use diverse lenses (disease-fit, method-fit, eligibility).
   Agreement → trust the label; **disagreement → human review queue**. This is
   where the human's time goes — only the contested cases.
3. **Human calibration.** A human labels a sample (especially the disagreements)
   to (a) validate the LLM judge against human labels before trusting its
   aggregates, and (b) seed the gold set. Validate the judge *first*, then let it
   scale. (This is the "human gets pretty far" — the human validates the judge,
   the judge does the volume.)

**Metrics out of Track A:**
- **precision@N** — fraction of top-N rated ≥ plausible.
- **ranking quality (nDCG-style)** — do strong-fit opps rank above weak ones?
- **facet-failure histogram** — *where* false positives come from (e.g. "38% are
  disease-facet mismatch"). This is the payoff: it **prioritizes which §2 idea to
  build next.**

### 3.2 Track B — recent grants as ground truth

A scholar's **actually-awarded grants** are a real relevance signal. Indexed, they
let you backtest:

- **Held-out backtest** — take a scholar's recently-won grant; run the matcher on
  their **pre-award** publication record; does the matcher rank that grant (or its
  program/mechanism family) high? Won grant ranks high → matcher is good. A
  recall/ranking metric against ground truth, **no LLM needed for the core score.**
- **Topic-coverage check** — do the topics of a scholar's won grants overlap the
  topics the matcher emphasizes for them? Mismatch ⇒ the scholar/opp vectors are
  off.
- **Mechanism realism** — are recommended mechanisms (R01/K/F/U) consistent with
  what scholars at that stage actually win? Grants give empirical base rates.

**The LLM's role in Track B is indexing, not judging:** grants are messy
(free-text titles, sponsor codes, no clean topic vector). Use lookup + LLM
fallback to extract each grant's topic vector / MeSH / facets and map sponsor
program → mechanism — i.e. **project grants into the same representation as
opportunities** so they're directly comparable.

**Honest caveats (Track B):**
- **Selection/survivorship bias** — won grants ≠ all relevant grants; a scholar
  applies to a subset and rejections aren't recorded. So "did we recommend their
  won grant" measures recall on a *biased* sample, not precision. Still strongly
  directional.
- **Temporal leakage** — must use the scholar's publication record **as of before
  the award**, or the matcher "sees" work the grant funded. Needs point-in-time
  vectors.
- **Corpus coverage** — the won grant's NOFO must be indexable to be
  recommendable; many awards predate the current opportunity corpus. Backtest
  where the NOFO exists, else relax to "same program family."

### 3.3 Grant indexing requirement

What exists: reciterdb already holds grants (the reverse matcher reads
`scholar.grants` — endDate/role/mechanism; there's iCite RCR in
`analysis_nih`; the grant-history join landed in #1218). **What's missing is a
topic/MeSH/facet representation of each grant** comparable to opportunities.

Build (mirrors how opportunities get their `topicVector`):
1. Pull grant title + abstract (+ sponsor program code).
2. Map → ReciterAI topic vector + MeSH descriptors + facet buckets (lookup;
   LLM fallback for sparse text).
3. Normalize sponsor program → mechanism (R01/K/F/U/P…).
4. Store a `grant_index` keyed by grant id, point-in-time-safe (award date
   retained so backtests can exclude post-award pubs).

Bonus: an indexed grant corpus is reusable as a **richer scholar signal** (a
scholar's *funded* topics, not just published) and as base rates for §2.6.

### 3.4 Orchestration

Track A fans out naturally — pipeline scholars → (matcher top-N) → per-pair LLM
judge → adversarial refute → human queue for disagreements → synthesis report.
Track B is mostly deterministic once grants are indexed (compute won-grant rank;
no fan-out needed beyond the one-time indexing). Run them as two stages; the
synthesis combines Track A's facet-failure histogram with Track B's recall to
produce a single prioritized "fix these first" list that points back at §2.

---

## 4. The loop

Eval → failure modes → build the §2 idea that fixes the biggest failure mode →
re-eval. The QA tab (#1292) is where the human labels accrue; the facet-failure
histogram (3.1) and grant-recall (3.2) decide what to build, so effort goes to
the levers that move the metric, not the ones that feel sophisticated.
