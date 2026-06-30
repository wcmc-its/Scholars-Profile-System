# Search Relevance Analysis — Scholar Ranking

**Date:** 2026-06-29
**Method:** Ranking math read from `origin/master` (working branch is behind; re-grounded).
Raw rankings/scores/evidence pulled live from the staging search API
(`https://scholars-staging.weill.cornell.edu/api/search`, public from WCM, no SSO).
All numbers below are observed from the live index, not estimated.

---

## 1. The ranking math (topic-shaped query)

A free-text concept query (e.g. `diabetes`) classifies as `topic_template`. The
score that sorts scholars is:

```
FINAL = BM25_text  ×  INNER_multiplier  ×  OUTER_sum
```

**BM25_text** — weighted token match over (topic-template field boosts):

| field | boost | contains the lay token "diabetes"? |
|---|---|---|
| publicationTitles | ^6 | yes (per-pub titles, authorship-weighted at index time) |
| publicationMesh | ^4 | yes (MeSH term *text* e.g. "Diabetes Mellitus") |
| areasOfInterest | ^3 | **no** — holds area *labels* like "Metabolic & Endocrine Disease" |
| primaryTitle | ^3 | rarely |
| overview | ^2 | sometimes |
| preferredName / fullName | ^1 | no |
| primaryDepartment | ^1 | no |

Plus soft scoring-only `should` clauses: `publicationAbstracts` (0.5), `methodContext` (0.8).
Admission floor: `minimum_should_match = "2<-34%"`.

**INNER_multiplier** (multiplicative, topic template):

```
1.0
× MeSH attribution  (exact 1.5 / anchored-entry 1.3 / entry 1.15 / partial 1.05)   ← gated on meshMapped
× method-family tag (2.0)                                                            ← gated on concept resolve
× productivity      (≥20 pubs 1.2 / 5–20 pubs 1.1 / <5 pubs 1.0)
× 0.7  if sparse profile (overview ≤200 chars AND <3 AOI terms AND 0 pubs)
```

**OUTER_sum** (additive prominence, wraps every template; `score_mode: sum`):

```
1.0 (base)
+ ln1p(pubCount)            (PUBCOUNT_FACTOR = 1 → ln1p(10)=2.4, ln1p(100)=4.6, ln1p(700)=6.6)
+ 1.0  if full_time_faculty
+ 0.5  if hasActiveGrants
+ areaConcentration boost  (Hi 8 / Mid 4 / Lo 1.5)                                   ← gated on area resolve
```

Source: `lib/search.ts` (boost constants), `lib/api/search.ts` (`searchPeople`,
`buildAreaBoostFunctions`, function_score assembly), all on `origin/master`.

---

## 2. Analysis A — query `diabetes`

**Interpretation returned:** `queryShape: topic_template`, `meshMapped: false`,
`attributionBoostFired: null`, `scope: expanded`, `total: 692`.

**Where the expected metabolism/weight cluster landed** (true rank = sorted by returned `relevanceScore`):

| rank | scholar | score | pubs | diabetes evidence | primary-area match |
|---|---|---|---|---|---|
| 1 | Monika Safford | 615 | 727 | self-desc mention | Cardiovascular Disease |
| 16 | **Louis Aronne** | 266 | 208 | 66/208 (32%) | Metabolic & Endocrine (idx 0) |
| 17 | **Alpana Shukla** | 265 | 80 | — | Metabolic & Endocrine (idx 0) |
| 19 | **James C. Lo** | 256 | 49 | — | — |
| 117 | **Beverly Tchang** | 194 | 34 | 14/34 (41%) | Metabolic & Endocrine (idx 0) |
| 250 | **Leon Igel** | 157 | 29 | 10/29 (34%) | **areas: null** |
| 486 | **Mohini Aras** | 102 | 10 | 2/10 (20%) | **areas: null** |

### Holes

**A1 — the lay term `diabetes` does not resolve to MeSH (root cause).**
Controlled probe:

| query | meshMapped | confidence | top result |
|---|---|---|---|
| `diabetes` | **false** | — | Safford (volume generalist) |
| `diabetic` | **false** | — | Malik |
| `diabetes mellitus` | true | exact | Malik |
| `type 2 diabetes` | true | entry-term | Malik |
| `obesity` | true | exact | **Shukla** ← the right cluster |

When mapping fires (`obesity`), the obesity-medicine cluster surfaces immediately.
When it doesn't (`diabetes`), the query falls to plain `expanded` BM25 and loses:
the 1.5× attribution boost, descendant-UI expansion (Diabetes Mellitus →
Type 1 / Type 2 / Gestational / MODY, whose indexed MeSH text may not contain the
bare token "diabetes"), and the concept/method path.

**A2 — volume is double-counted; topical centrality isn't counted.**
With the MeSH and area gates dark, rank ≈ `BM25(token "diabetes") × (1 + ln1p(pubCount) + faculty + grants)`.
`ln1p(pubCount)` is an unconditional productivity term, independent of how much of
that output is about diabetes (Safford 727→6.6, Aronne 208→5.3, Tchang 34→3.6).
Safford's matched area is *Cardiovascular Disease* and diabetes is one item in her
bio, yet she outranks Aronne 615→266. Aronne is more *central* to diabetes (32% of
pubs, Metabolic is his #1 area) but volume wins twice — once via BM25 term frequency
(more diabetes-mentioning pubs → more tokens in the concatenated field), once via the
prominence `ln1p(pubCount)`.

**A3 — `areasOfInterest^3` contributes ≈0 for this cluster.** The boosted field holds
the curated label "Metabolic & Endocrine Disease", which contains no token "diabetes".
The area signal only helps when a *topic node* resolves (gate A1), which it didn't —
so the advertised ^3 area boost does nothing here.

**A4 — Igel and Aras have `areas: null`.** No computed research areas → invisible to
any area-based ranking even after A1 is fixed. Data-completeness gap feeding ranking.

**A5 (secondary) — ~~displayed score ≠ paginated order~~ RETRACTED.** I originally read
Tchang as appearing far below her score-implied rank. That was an artifact of my own
analysis (an alphabetical `all_p*.json` glob that sorted `p10` before `p2`), **not** the
API. Probe P1 (§13) verified pagination is clean: across diabetes (692) and hypertension
(510) the page sequence is perfectly monotonic in `relevanceScore`, zero duplicates/gaps,
paginated position == score-sorted rank exactly, and stable on re-fetch. **No pagination
problem exists.** (Open questions Q3/Q8 are likewise resolved.)

---

## 3. Do MeSH descriptors ship entry terms? (yes — and we ingest them)

**Yes.** MeSH descriptors ship entry terms (synonyms) in the descriptor records, and
this pipeline ingests them: `etl/mesh-descriptors/synonyms.ts` builds an
equivalent-form synonym graph from each descriptor's `name` + `entryTerms`. Empirical
proof: `type 2 diabetes` resolves with confidence `entry-term` to D003924 — that match
can only come from an ingested entry-term list.

**So why does bare `diabetes` still miss?** Two compounding reasons:

1. **Collision drop.** `synonyms.ts` enforces a cross-descriptor collision rule: a
   surface form used by ≥2 descriptors is dropped to protect precision (the canonical
   "MS" → Multiple Sclerosis / Mass Spectrometry / Magnesium Sulfate problem). "diabetes"
   is shared across Diabetes Mellitus (D003920), Diabetes Insipidus (D003919), and the
   typed variants — so even where it appears as a surface form it is filtered out. NLM
   also lists entry terms as full phrases ("Diabetes Mellitus", inversions), not the bare
   lay word, so there is likely no single-descriptor surface form for it to begin with.

2. **The curated override was never promoted.** The fix mechanism already exists —
   `MeshCuratedAlias` (alias → descriptor) — and the alias was *drafted* under #1258:
   - `etl/mesh-aliases/curated.candidates.csv:17` → `"diabetes",D003920`
   - `etl/mesh-anchors/curated.candidates.csv:59` → `D003920,metabolic_endocrine_disease` (note: "Review.")
   - `docs/mesh-anchor-lay-term-candidates.csv:78` → `diabetes,…,Diabetes Mellitus`

   But the live `etl/mesh-aliases/curated.csv` and `etl/mesh-anchors/curated.csv` contain
   only the #642/#690 *department-name* aliases. The diabetes alias sits unmerged in
   `*.candidates.csv`. So it never reaches the resolver.

**Bottom line:** entry terms are present and working; the lay-term gap is a curation
backlog item (promote candidates), not a missing-data problem.

---

## 4. Recommendations (ranked by leverage)

1. **Promote the #1258 lay-term alias candidates to the live curated set.** Start with
   `"diabetes"→D003920` (and `diabetic`). This single change moves the query onto the
   attributed path that *already* ranks the right cluster for `obesity`. Low risk — same
   mechanism as the shipped department aliases. Audit the rest of
   `mesh-anchor-lay-term-candidates.csv` while in there (heart attack, stroke, etc.).

2. **Decide whether the collision rule needs a lay-term carve-out.** Promoting one alias
   at a time is curation toil. If the same gap recurs (it will — every common condition
   with a lay name + multiple typed descriptors), consider letting a curated alias *win*
   over the collision drop systematically, so lay terms route to their dominant descriptor.

3. **Make topical centrality a real signal, not just absolute volume.** Today
   `ln1p(pubCount)` rewards output regardless of focus, and BM25 term frequency rewards it
   again. Consider blending a *concentration* term (share of a scholar's work in the matched
   concept/area, e.g. `66/208`) so a focused specialist competes with a high-volume
   generalist. This is the deeper design call behind holes A2/A3.

4. **Backfill research areas for sparse profiles (areas: null).** Igel/Aras have no
   computed areas; any area-aware ranking is blind to them. Data fix upstream (ReciterAI
   rollups).

---

## 5. Open questions

- **Q1.** Is `diabetes` dropped by the collision rule, or simply absent from NLM entry
  terms for any single descriptor? Determines whether rec #2 (collision carve-out) is
  needed or rec #1 (alias promotion) alone suffices. *(Resolve by dumping the entry-term
  set for D003919/D003920/D003922/D003924 and checking the normalized surface forms.)*
- **Q2.** Why was the diabetes candidate marked "Review." and left unpromoted — a known
  concern (e.g. routing diabetes-insipidus pubs to the wrong descriptor) or just backlog?
- **Q3.** What is the API actually paginating on (hole A5)? If `relevanceScore` is a
  display-only recomputation, deep result pages are ordered differently than users expect.
- **Q4.** Should descendant expansion for `diabetes mellitus` be the default for the lay
  term too (it returns 429 vs 692 hits — narrower but attributed)? Trade-off: recall vs
  precision.

---

## 6. Further analyses

### Analysis B — lay-term mapping scan (how widespread is A1?)

Probed 20 common lay condition terms for `meshMapped`. **6 of 20 fail to map** — and
they include some of the highest-traffic consumer-health terms.

| query | mapped | confidence | label | top result |
|---|---|---|---|---|
| `diabetes` | **false** | — | — | Safford (generalist) |
| `diabetic` | **false** | — | — | Malik |
| `alzheimer` | **false** | — | — | Yi Li |
| `alzheimers` | **false** | — | — | Yi Li |
| `covid` | **false** | — | — | Abu-Raddad (generalist) |
| `lupus` | **false** | — | — | Pascual |
| `heart attack` | true | entry-term | Myocardial Infarction | Rong |
| `stroke` | true | exact | Stroke | Murthy |
| `cancer` | true | entry-term | Neoplasms | McGraw |
| `breast cancer` | true | entry-term | Breast Neoplasms | Tamimi |
| `depression` | true | exact | Depression | Prigerson |
| `hypertension` | true | exact | Hypertension | Safford |
| `high blood pressure` | true | entry-term | Hypertension | Safford |
| `asthma` | true | exact | Asthma | Worgall |
| `obesity` | true | exact | Obesity | Shukla |
| `kidney disease` | true | entry-term | Kidney Diseases | Wolf |
| `long covid` | true | entry-term | Post-Acute COVID-19 Syndrome | Long |
| `arthritis` | true | exact | Arthritis | Riew |
| `weight loss` | true | exact | Weight Loss | Malik |
| `aging` | true | exact | Aging | Ndhlovu |

**Three distinct failure classes (one fix each):**

1. **Morphological variants** — `diabetic` (vs `diabetes`/"Diabetes Mellitus"),
   `alzheimers` (vs `alzheimer` vs "Alzheimer Disease"). A stem/lemma normalization or
   the planned resolution fallback (`docs/search-mesh-resolution-fallback-spec.md`) would
   catch these without per-term curation.
2. **Abbreviation / numbered descriptor** — `covid` vs "COVID-19" (D000086382). Note
   `long covid` maps but the base term doesn't — a glaring miss on likely the #1 query.
   Needs an abbreviation alias.
3. **Collision + un-promoted curated alias** — `diabetes`, `lupus`. Both are already
   drafted as #1258 candidates; both are still in `*.candidates.csv`. Pure curation
   backlog.

**Implication for the recommendations:** per-term alias promotion (rec #1) clears class 3
but leaves classes 1–2, so it is whack-a-mole on its own. The systematic levers (rec #2 +
a normalization/fallback layer) matter more than first estimated — the gap hits `covid`,
`diabetes`, `alzheimer`, and `lupus`, four of the most-typed consumer terms. In every
unmapped case the top result is a high-volume generalist rather than the topical
specialist, consistent with hole A2.


### Analysis C — query `CRISPR`

**Interpretation returned:** `queryShape: topic_template`, `meshMapped: true`,
`meshConfidence: entry-term`, `conceptLabel: "Clustered Regularly Interspaced Short
Palindromic Repeats"` (D000067210), `total: 104`. Unlike a lay term, `CRISPR` *does*
resolve — but only as an **entry-term**, and it routes to the structural-repeats
descriptor rather than the method descriptor `CRISPR-Cas Systems` (D000067146), which is
far more heavily indexed (exact `CRISPR-Cas Systems` returns **267** hits vs 104).

**Where the expected CRISPR cluster landed** (true rank = deduped + sorted by returned `relevanceScore`; `pubs` = total indexed pubs):

| rank | scholar | score | pubs | CRISPR evidence (matchReason) | primary-area match |
|---|---|---|---|---|---|
| 1 | **Lukas Dow** | 1630 | 98 | method-family `CRISPR genome editing` (base editing, CRISPR BE) | area idx 7 |
| 32 | **Chun-Jun Guo** | 300 | 52 | method-family `CRISPR genome editing` (CRISPR, gene deletion) | idx −1 (no match) |
| 41 | **Santosha Vardhana** | 274 | 87 | `1 of 87 publications mention "CRISPR"` | **areas: null** |
| 45 | **Iliyan Iliev** | 265 | 71 | method-family `CRISPR genome editing` (CRISPR-Cas9 fungal editing) | idx −1 |
| 73 | **Sujit Sheth** | 197 | 79 | `2 of 79 publications mention "CRISPR"` (expert: 17) | idx −1 |
| 76 | **Li Gan** | 188 | 141 | `5 of 141 publications mention "CRISPR"` | idx −1 |
| 78 | **David Artis** | 178 | 122 | method-family `CRISPR genome editing` (ILC2 deletion) | idx −1 |
| — | **Christopher Mason** | — | **0** | not found — `pubCount=0` (empty pub profile) | not found |
| — | **David Lyden** | — | 157 | not found — single CRISPR pub never registers | not found |

**Top 5 (all method-family-tagged):**

| rank | scholar | score | pubs | reason |
|---|---|---|---|---|
| 1 | Lukas Edward Dow | 1630 | 98 | method `CRISPR genome editing` |
| 2 | Elisa ten Hacken | 1096 | 44 | method `CRISPR genome editing` |
| 3 | Yicheng Long | 935 | 18 | method `CRISPR genome editing` |
| 4 | Samie R Jaffrey | 802 | 193 | method `CRISPR genome editing` (one tool) |
| 5 | Duancheng Wen | 795 | 36 | method `CRISPR genome editing` |

### Holes

**C1 — `CRISPR` maps only as an entry-term, and to the *wrong* descriptor.** It resolves
`meshMapped: true` (good — the abbreviation alias works) but at confidence `entry-term`,
landing on D000067210 (*Clustered Regularly Interspaced Short Palindromic Repeats*), not
the method descriptor D000067146 (*CRISPR-Cas Systems*). Two costs: the MeSH-attribution
INNER multiplier is the weaker **1.15× (entry)** rather than **1.5× (exact)**; and
candidate recall is **104** vs the **267** that the exact `CRISPR-Cas Systems` descriptor
surfaces. The hyphenated form `CRISPR-Cas` fails to map at all (`meshMapped: false`) and
falls to plain expanded BM25.

**C2 — the 2.0× method-family tag is the dominant lever and fires inconsistently.** Every
one of rank 1–5 carries `matchReason.kind: "method"`, `family: "CRISPR genome editing"`.
That 2.0× INNER tag is gated on the *scholar's* methodContext containing the CRISPR
family (concept-resolve), which ReciterAI extraction populates for bench groups that
*build* CRISPR tools. Topical specialists whose CRISPR work is **therapeutic** rather than
method-tagged get only the weak `"N of M publications mention CRISPR"` reason
(`icon: publications`) and miss the 2.0× entirely — Vardhana (rank 41), Sheth (73), Li Gan
(76). The presence/absence of this single tag is what separates rank 1–5 from rank 40+,
not topical centrality.

**C3 — volume is double-counted; topical centrality isn't counted.** Once the method tag
fires, `OUTER_sum`'s `ln1p(pubCount)` re-rewards raw output. Jaffrey reaches **rank 4** on
a *single* extracted tool ("CRISPR/Cas9-based methods") carried by 193 pubs
(ln1p(193)≈5.3); ten Hacken (44 pubs) is rank 2. Both outrank Sheth's actual CRISPR-therapy
program (expert: 17 pubs) at rank 73. Share-of-work on CRISPR is not a ranking term — same
failure as hole A2.

**C4 — `areasOfInterest^3` contributes ≈0 for a technique query.** "CRISPR" is a method,
not a curated area label, so it cannot match the labels in the ^3 field. Every expected
scholar except Dow shows `humanizedAreas.matchedIndex: -1` (no area matched); Dow's
`matchedIndex: 7` is *Stem Cell & Regenerative Medicine* — an incidental label hit, not a
CRISPR area. The advertised ^3 area boost and the OUTER `areaConcentration` term (gated on
area resolve) both do nothing here. Same as hole A3.

**C5 — Vardhana has `areas: null`.** The `areaConcentration` OUTER term (Hi 8 / Mid 4 /
Lo 1.5) is gated on area resolve, so a null area set makes him invisible to area-aware
ranking even after C4 is addressed. Data-completeness gap feeding ranking — same as A4.

**C6 — recall misses from sparse / under-attributed pub profiles.** Christopher Mason
(expert: 5 CRISPR pubs) has `pubCount: 0` in the index → `ln1p(0)=0`, no MeSH/method
attribution, sparse-profile ×0.7; he never appears in the 104- *or* 267-hit set. David
Lyden (157 pubs, expert: 1 CRISPR pub) is also absent from both sets — his lone CRISPR pub
yields neither a "mention" hit nor a method tag, sitting below the surfacing threshold.
Sheth's `2/79` index attribution vs the expert's 17 is the same disease: CRISPR-therapeutics
pubs (hemoglobinopathies) are indexed under therapy/hematology MeSH **without the literal
"CRISPR" token**, so they never reach `publicationTitles^6`/`publicationMesh^4` nor trip
the method tag.

### Variant-mapping table

| query | mapped | confidence | label | total | top result |
|---|---|---|---|---|---|
| `CRISPR` | true | **entry-term** | Clustered Regularly Interspaced Short Palindromic Repeats | 104 | Lukas Dow |
| `CRISPR-Cas` | **false** | — | — | 70 | Lukas Dow (plain BM25) |
| `gene editing` | true | exact | Gene Editing | 149 | Inmaculada de Melo-Martin |
| `CRISPR-Cas Systems` | true | exact | CRISPR-Cas Systems | 267 | Lukas Dow |

The abbreviation alias for `CRISPR` exists and fires — but it routes to the *repeats*
descriptor (entry-term, 104) instead of the method descriptor *CRISPR-Cas Systems* (exact,
267). Promoting `CRISPR → D000067146 (CRISPR-Cas Systems)` as a curated alias (same
`MeshCuratedAlias` mechanism as #1258) would move the bare query onto the exact path
(1.5× attribution + the larger candidate pool), which is the single highest-leverage fix.
It would not, by itself, fix C2/C6 (method-tag and attribution gaps for therapeutic users
like Sheth) or C3 (volume double-count).

### Analysis D — query `fecal microbiota transplantation`

**Interpretation returned:** `queryShape: topic_template`, `meshMapped: true`,
`meshConfidence: exact`, `conceptLabel: "Fecal Microbiota Transplantation"`
(D000069467), `total: 115`. This is a **success case for mapping** — the full phrase
hits the MeSH descriptor exactly, so the attributed path lights up and the top of the
list is dominated by genuine FMT clinicians/scientists. The holes here are second-order
(attribution coverage + volume tail), not a dark mapping gate.

**Where the expected FMT cluster landed** (true rank = deduped by cwid, sorted by returned `relevanceScore`):

| rank | scholar | score | pubs | FMT evidence | note |
|---|---|---|---|---|---|
| 1 | **Randy Longman** | 1627 | 87 | 4/87 tagged | exact-tier ×1.5; active grants; FT faculty |
| 3 | **Carl Crawford** | 1427 | 47 | 4/47 tagged | active grants; FT faculty |
| 4 | **Ellen Scherl** | 1334 | 126 | 3/126 tagged | active grants; FT faculty |
| 8 | **Jonathan Peled** | 1043 | 27 | 3/27 tagged | domain expert's #1 (~13 FMT pubs); only 3 attributed → see D2 |
| 11 | **Vinita Jacob** | 877 | 11 | 2/11 tagged | no active grants |
| 14 | **Dana Lukin** | 810 | 78 | 1/78 tagged | outranked by mention-tier generalists → D4 |
| 26 | **Gregory Sonnenberg** | 594 | 87 | 1/87 tagged | single tagged pub sinks below high-volume mention generalists |
| — | **Robert Battat** | — | — | not in result set | no FMT-tagged or mention pub attributed → D3 |
| — | **Lasha Gogokhia** | — | — | not in result set | sparse/trainee profile, no attributed FMT pub → D3 |

**Top 5 returned:** 1 Randy Longman (1627, 87) · 2 Iliyan Iliev (1583, 71) ·
3 Carl Crawford (1427, 47) · 4 Ellen Scherl (1334, 126) · 5 Chun-Jun Guo (1169, 52).
All five are real microbiome/FMT investigators — the exact MeSH map did its job.

**Evidence-strength mix across the 115 hits:** 32 `tagged` (MeSH-attributed) · 28
`mention` (soft text only) · 55 with no evidence object. The tail (rank ≥12) is where
`mention`-only generalists begin interleaving with `tagged` specialists.

### Holes

**D1 — the abbreviation `FMT` does not map (the KEY KNOWN HOLE, applied to an acronym).**
Controlled probe:

| query | mapped | confidence | label | top result |
|---|---|---|---|---|
| `fecal microbiota transplantation` | **true** | exact | Fecal Microbiota Transplantation | Longman |
| `fecal microbiota transplant` | true | entry-term | Fecal Microbiota Transplantation | Longman |
| `fecal transplant` | true | entry-term | Fecal Microbiota Transplantation | Longman |
| `FMT` | **false** | — | — | Iliev |

The full phrase and both entry-term variants resolve to D000069467; only the acronym is
dark. When `FMT` misses it falls to plain `expanded` BM25 and loses the 1.5× MeSH
attribution INNER multiplier, descendant expansion, and the area boost — and recall
collapses from **115 → 4 hits**. Same mechanism as the `diabetes` lay-term gap, here on
an abbreviation. Fix is the existing `MeshCuratedAlias` route: `FMT → D000069467`.

**D2 — attribution coverage, not the math, caps the domain expert's #1 (Peled, rank 8).**
Peled is credited with ~13 FMT/HSCT publications but SPS attributes only **3 of 27** total
pubs to him. The MeSH gate fires identically (exact ×1.5) for every tagged scholar, so
rank inside the tagged set reduces to `BM25(publicationMesh TF) × (1 + ln1p(pubCount) +
grants + faculty)`. Peled's `ln1p(27)=3.33` OUTER and 3-tag mesh-field term frequency
cannot beat Longman (`ln1p(87)`, 4 tags → 1627) or Iliev (`ln1p(71)`, 1583). The defect
is upstream publication attribution (his MSKCC-era corpus is under-ingested — pubCount 27
is low for an established physician-scientist), but it surfaces *through* the unconditional
volume term.

**D3 — Battat and Gogokhia are absent from the candidate pool entirely.** Neither appears
in the 115 hits: neither has a single FMT-`tagged` or even soft-`mention` publication in
their attributed SPS corpus, so they never enter the text-match candidate set. In a small
literature, incomplete pub attribution (plus the ×0.7 sparse-profile multiplier for
trainees like Gogokhia) silently drops genuinely topical names below the floor — no
ranking math can rescue a scholar who isn't a candidate. Data-completeness gap feeding
ranking.

**D4 — volume still beats specificity in the tail, even with a clean exact map.**
`mention`-only high-volume generalists interleave above `tagged` specialists:
Dadhania (r12, 8/139 mention, `ln1p(139)=4.94`), Quigley (r16, 3/303), Satlin (r17,
5/130), Westblade (r18, 4/188), Suthanthiran (r21, 6/291) all outrank tagged specialists
Lukin (r14), Barker (r22, 1/169 tagged) and Sonnenberg (r26, 1/87 tagged). `mention`-tier
evidence does **not** earn the ×1.5 MeSH-attribution multiplier (that requires a tagged
pub), yet OUTER `ln1p(pubCount)` plus soft-field BM25 term frequency (many mention hits)
overpower a low-volume specialist's single ×1.5-boosted tagged pub. This is the same
structural defect as hole A2: `ln1p(pubCount)` rewards output regardless of focus, and
there is no concentration term (share of a scholar's work that is *about* FMT).

**D5 — mesh-tag count is not monotonic with rank; title/area BM25 + volume override it.**
Iliev (rank 2, only **2** tagged of 71) outranks Crawford (rank 3, **4** tagged of 47)
and Scherl (rank 4, **3** tagged of 126). Among scholars who all earn the same exact-tier
×1.5, the differentiator is `BM25_text` on `publicationTitles^6` / `areasOfInterest^3`
(Iliev is a mycobiome/microbiota PI whose titles and curated areas carry the concept) plus
OUTER volume — so raw `publicationMesh^4` tag frequency is only one of several competing
signals, not the dominant one. Useful when reasoning about why "more tagged pubs" doesn't
always win.

**D6 — the people endpoint exposes no `areas`/`humanizedAreas` field.** Hit keys are
`cwid, deptName, divisionName, evidence, grantCount, hasActiveGrants, matchReason,
preferredName, primaryDepartment, primaryTitle, pubCount, relevanceScore, roleCategory,
slug` — no area payload. The `areaConcentration` OUTER term (Hi 8 / Mid 4 / Lo 1.5, gated
on area resolve) therefore cannot be observed or audited from the API response; only its
net effect on `relevanceScore` is visible. Worth confirming the area gate actually fired
for this cluster rather than silently contributing 0.

### Variant-mapping table

| query | mapped | confidence | label | top result |
|---|---|---|---|---|
| `fecal microbiota transplantation` | **true** | exact | Fecal Microbiota Transplantation | Randy Longman |
| `fecal microbiota transplant` | true | entry-term | Fecal Microbiota Transplantation | Randy Longman |
| `fecal transplant` | true | entry-term | Fecal Microbiota Transplantation | Randy Longman |
| `FMT` | **false** | — | — | Iliyan Iliev (4 hits, generalist fallback) |

Three of four forms map (phrase exact, two entry-term); the acronym is the lone miss
(hole D1) and the only one that loses attribution and recall.

### Analysis E — query `single-cell RNA sequencing`

**Interpretation returned:** `queryShape: topic_template`, `meshMapped: true`,
`meshConfidence: entry-term`, `conceptLabel: "Single-Cell Gene Expression Analysis"`,
`scope: expanded`, `total: 708`. Unlike `diabetes` (Analysis A), this query *does* map —
and a method-family tag (`"Single-cell RNA sequencing"`) also resolves, so the INNER
method 2.0 and MeSH-attribution gates fire. The failure mode here is therefore *not* an
unmapped query; it is (a) volume dominance among method-tagged scholars, (b) a
scholar-side attribution gap that sinks the expert's #1, and (c) data/terminology holes.

**Where the expected scRNA-seq cluster landed** (true rank = deduped + sorted by returned `relevanceScore`):

| rank | scholar | score | pubs | scRNA-seq evidence | primary-area match |
|---|---|---|---|---|---|
| 1 | Ronald G Crystal | 1748 | 920 | method tag (scRNA-seq + 2 tools) | — (volume generalist, 65 grants) |
| 2 | Manikkam Suthanthiran | 1734 | 291 | method tag (multiplexed scRNA-seq) | — (transplant generalist) |
| 3 | Thangamani Muthukumar | 1715 | 117 | method tag (scRNA-seq) | — (transplant generalist) |
| 4 | Hagen Tilgner | 1587 | 53 | method tag (single-nuclei/isoform RNA-seq) | — |
| 5 | **Dan Landau** | 1555 | 103 | method tag (3 tools) | Single-Cell & Spatial Biology (idx 0) |
| 10 | **Doron Betel** | 1387 | 99 | method tag (scRNA-seq) | Single-Cell & Spatial Biology (idx 1) |
| 29 | **Olivier Elemento** | 941 | 538 | **22/538 pub-mention; NO method tag** | — (**no single-cell area**) |
| 88 | **Shahin Rafii** | 627 | 45 | method tag (scRNA-seq) | Single-Cell & Spatial Biology (idx 4) |
| 705 | **Christopher Mason** | 44 | **0** | **reason: null** | Single-Cell & Spatial Biology (idx 9) |

Landau (5) and Betel (10) rank where the expert expects. Elemento (expert #1, 538 pubs),
Rafii (88) and Mason (705) do not.

### Holes

**E1 — query maps to a MeSH concept + method family, but *not* a research-area node, so
the area boost is dark for everyone.** `matchedIndex` is `-1` on all hits: the concept
label `"Single-Cell Gene Expression Analysis"` (MeSH) is not the area-taxonomy label
`"Single-Cell & Spatial Biology"`, so the OUTER `areaConcentration` term (Hi 8 / Mid 4 /
Lo 1.5) never fires. Had it fired, it would have rewarded the specialists who carry
Single-Cell & Spatial Biology high in their areas (Landau idx 0, Betel idx 1, Rafii idx 4)
while giving Elemento — who has *no* single-cell area — nothing, narrowing the generalist
gap. Same class as A3: the advertised area boost contributes ≈0.

**E2 — volume dominance among method-tagged scholars (A2, amplified).** The INNER
method-family 2.0 is binary and undiscriminating, and it fires across a *broad* set — the
entire top 10 carries it, including transplant/nephrology generalists who merely *use*
scRNA-seq (Crystal 920 pubs / 65 grants, Suthanthiran 291, Muthukumar 117, Inghirami 344,
Loda 514). Once the 2.0 is shared, the only remaining differentiator is OUTER_sum's
`ln1p(pubCount)` + grants, so raw productivity decides the order: Crystal (`ln1p` 6.83) #1,
Suthanthiran (5.68) #2, Muthukumar (4.77) #3. The 2.0 cannot tell a methods developer from
someone who ran one scRNA-seq experiment in a kidney study — and because it *multiplies*
the already volume-heavy BM25, it makes volume win harder than in the unmapped `diabetes`
case.

**E3 — Elemento under-ranked at 29 by a scholar-side attribution gap.** His `matchReason`
is the publications-icon kind (`"22 of 538 publications mention 'single-cell RNA
sequencing'"`), *not* a method tag — so the 2.0 multiplier is dark *for him* even though
the concept resolves for the query. He has the highest matching-pub count on the list (22)
and the 2nd-highest output (538 pubs → OUTER `ln1p` 6.29, productivity 1.2), yet the missing
≈2× INNER method multiplier drops him below dozens of method-tagged peers to rank 29. The
2.0 is thus simultaneously *too generous* to tool-users (E2) and *absent* for a genuine
specialist — a binary, attribution-dependent multiplier produces both errors. Fix is
scholar-side: `methodContext` extraction missed Elemento's scRNA-seq work; query-side
aliasing won't help.

**E4 — Mason `pubCount = 0`, `matchReason: null` — a data/disambiguation hole, not a math
flaw.** His publications are not attributed to his cwid in the index, so he has no BM25
pub/MeSH signal at all; he hits INNER productivity 1.0 (<5 pubs) *and* the sparse-profile
×0.7 penalty, and OUTER volume is `1.0 + ln1p(0) = 1.0`. He surfaces at rank 705 *only*
via the `humanizedAreas` label "Single-Cell & Spatial Biology" (his idx 9). Expert expected
9 relevant pubs; the index holds 0 — the single most severe undercount on the list,
fixable only upstream (ReCiter identity/indexing), not by ranking changes.

**E5 — terminology fragmentation across surface forms (#1258).** All three RNA-specific
forms resolve to the *same* concept via entry-term, yet the candidate pools diverge wildly,
and dropping "RNA" breaks mapping entirely:

| variant | mapped | confidence | label | total | top result |
|---|---|---|---|---|---|
| `single-cell RNA sequencing` | true | entry-term | Single-Cell Gene Expression Analysis | 708 | Crystal (generalist) |
| `single cell RNA-seq` | true | entry-term | Single-Cell Gene Expression Analysis | 465 | **Landau** ← right cluster |
| `scRNA-seq` | true | entry-term | Single-Cell Gene Expression Analysis | **40** | Mallick |
| `single-cell sequencing` | **false** | — | — | 1445 | Cristofanilli (generalist) |

Mapping fires for the three RNA forms, so attribution is preserved — but the BM25 pool
collapses 17.7× from 708 to 40 for `scRNA-seq`, because the literal token rarely appears
verbatim in pub titles/MeSH and the descendant/anchor expansion is thin. The abbreviation a
bench scientist would actually type returns the *smallest* pool. Worse, dropping "RNA"
(`single-cell sequencing`) maps `meshMapped:false` → plain `expanded` BM25 with a volume
generalist (Cristofanilli) on top, losing attribution + the method path entirely. So the
user's surface form changes both the candidate pool and the winner — the terminology-drift
hole #1258 flags, here visible even on a query that nominally *maps*.

**Net:** unlike Analysis A, mapping is not the problem — the holes are (1) an
un-discriminating method 2.0 that lets high-volume tool-users outrank specialists (E2),
(2) inconsistent scholar-side method/area attribution that both omits the 2.0 from Elemento
(E3) and never lights the area boost for anyone (E1), (3) a zero-pub indexing gap for Mason
(E4), and (4) surface-form-dependent pool sizes (E5). The deeper design lever is the same as
A2/rec #3: blend a *concentration/centrality* term so a focused scRNA-seq specialist
competes with a 900-pub generalist who merely uses the method.

### Analysis F — query `alzheimer's`

**Interpretation returned (primary, the possessive a user actually types):**
`queryShape: topic_template`, `meshMapped: **false**`, `meshConfidence: null`,
`conceptLabel: null`, `total: 293`. (A topic anchor still resolves — `matchReason`
reports topic `Neurodegenerative Disease` via the #1258 curated-anchor path — but the
MeSH descriptor does **not** map.)

**Variant-mapping table (this is the key finding):** the gap is the possessive/lay form.

| query | mapped | confidence | label | top result |
|---|---|---|---|---|
| `alzheimer's` | **false** | — | — | Yi Li (imaging generalist) |
| `alzheimer` | **false** | — | — | Yi Li |
| `alzheimers` | **false** | — | — | Yi Li |
| `alzheimer's disease` | true | entry-term | Alzheimer Disease | Tracy A. Butler |
| `alzheimer disease` | true | exact | Alzheimer Disease | Gloria Chia-Yi Chiang |

Only the *full* phrase resolves to descriptor **Alzheimer Disease (D000544)**. The bare
disease word — in every spelling a layperson types — falls to plain expanded BM25.

**Top 5 under the unmapped primary form** (true rank = sorted by returned `relevanceScore`):

| rank | scholar | score | pubs | what matched |
|---|---|---|---|---|
| 1 | Yi Li | 880.8 | 113 | 69/113 pubs *mention* "alzheimer's" (imaging) |
| 2 | Hani Hojjati | 765.2 | 24 | 21/24 mention (imaging/EE) |
| 3 | Liangdong Zhou | 720.2 | 38 | 24/38 mention (imaging/BME) |
| 4 | Gloria Chia-Yi Chiang | 597.4 | 108 | clinical neuroradiology |
| 5 | Tracy A. Butler | 596.6 | 101 | clinical/imaging |

The unmapped top is dominated by Radiology AD-*imaging* faculty who name the disease in
their titles — not the AD *mechanism/clinical-program* leaders the domain expert expects.

**Where the expected scholars landed** — with an A/B column showing the rank under the
**mapped** form `alzheimer disease` (same 293-person set, only the ordering changes):

| expected scholar | unmapped rank | score | pubs | mapped rank (`alzheimer disease`) | evidence (unmapped → mapped) | area / role |
|---|---|---|---|---|---|---|
| **Li Gan** (Dir. Appel AD Inst.) | 11 | 435.7 | 141 | **4** | selfDescription bio → *35/141 tagged Alzheimer Disease* | NDD idx0 |
| **Costantino Iadecola** (Dir. Feil Brain & Mind) | 9 | 483.0 | 459 | 11 | selfDescription (Zenith award) → selfDescription | Neuro & Neurology idx0 |
| **Lidia Glodzik** | 19 | 352.6 | 108 | 24 | 72/108 *mention* | NDD idx0 |
| **Lisa Mosconi** (Dir. Women's Brain Initiative) | 31 | 316.8 | 135 | 46 | 103/135 *mention* (highest ratio!) | **areas: null**, affiliated_faculty |
| **Wenjie Luo** (nearest match to "Wai Wai Luo") | 39 | 302.6 | 56 | 32 | 32/56 *mention* | NDD idx0 |
| **Anna Orr** | **76** | 259.1 | 24 | **21** | 9/24 *mention* → *5/24 tagged Alzheimer Disease* | NDD idx0 |
| **Mony de Leon** | — (not indexed) | — | — | — | q='Mony' total=0 index-wide | — |
| **Ana Pereira** | — (not indexed) | — | — | — | q='Pereira' total=0 index-wide | — |

Mapping the query lifts Li Gan **r11→r4** and Anna Orr **r76→r21**, while dropping the
imaging generalist Yi Li **r1→r10** — the directors and molecular scientists are exactly
who the MeSH-attribution path rewards.

### Holes

**F1 — the possessive lay form does not resolve to MeSH (root cause).** `alzheimer's`,
`alzheimer`, and `alzheimers` all return `meshMapped:false`; only `alzheimer disease`
(exact) / `alzheimer's disease` (entry-term) map to D000544. The descriptor name and its
entry terms carry no bare-possessive surface form, and no #1258 curated alias was promoted
for it. Consequence: the INNER **MeSH-attribution multiplier** (exact 1.5 / anchored 1.3 /
entry 1.15) is **gated on `meshMapped`** and stays dark, and **descendant expansion never
runs**. Same failure class as the `diabetes`/`alzheimer` rows in Analysis B — but this
section pins it on the *possessive*, the single most natural way to type the term.

**F2 — with the MeSH gate dark, BM25 falls onto the literal token, which favors
imaging/clinical papers over mechanism papers (the rerank lever).** Under the unmapped
form the only thing that fires is `BM25(token "alzheimer's")` over `publicationTitles^6`
/ `publicationMesh^4`. That token is present mostly in *clinical/imaging* paper titles
("…in Alzheimer's disease"); the *mechanistic* AD scientists' titles say tau / amyloid /
microglia / FTD, so their token BM25 is near zero. Proof — the A/B on the **same 293
people**: mapping the query flips the evidence string from `selfDescription` /
"*N publications mention 'alzheimer's'*" to "*N publications **tagged** Alzheimer
Disease*", adds the 1.5× exact multiplier + descendant-expanded `publicationMesh`, and
reranks Li Gan r11→r4, Orr r76→r21 (Orr rises **despite fewer matched pubs** — 5 tagged
vs 9 literal — because the attribution path, not raw token frequency, now scores her). The
controlled-vocabulary attribution evidence is *structurally unavailable* under the
unmapped lay token.

**F3 — volume is double-counted; topical centrality isn't (same shape as A2).** Yi Li tops
the unmapped list on literal-token BM25 (69/113) × OUTER `ln1p(113)=4.7`. Iadecola is
floated to r9 almost entirely by `ln1p(459)=6.1` + 36 grants on a single bio mention.
`ln1p(pubCount)` rewards output regardless of AD focus while the discriminating
attribution term is the dark one.

**F4 — the area gate is actually LIT, and that's the tell.** Unlike a pure lay-term miss,
`alzheimer's` *does* resolve a topic anchor (`matchReason` topic `Neurodegenerative
Disease`, via #1258), so the whole AD-imaging cluster shares the area-concentration boost
(Hi=8). Because it is roughly uniform among them it cannot rescue the descriptor-central
scientists — confirming the failure is specifically the **MeSH-attribution / `publicationMesh`
BM25** path, not the area path.

**F5 — Mosconi is double-gated.** `humanizedAreas:null` (OUTER area-concentration boost
dark, cf. A4) **and** `roleCategory=affiliated_faculty` (misses the `+1.0`
full_time_faculty OUTER term); her `matchReason` is `icon:publications`, i.e. *no* area
resolved for her. She has the highest literal on-topic ratio of any expected scholar
(103/135 mention) yet lands only r31 — the area-null + non-faculty penalty stacks on top
of F1/F2.

**F6 — three expected directors are absent from the index.** Mony de Leon and Ana Pereira
return `total:0` index-wide; "Wai Wai Luo" has no exact match (nearest: Wenjie Luo r39).
No ranking change can surface an un-indexed scholar — upstream data-completeness gap
feeding the query.

**Fix:** promote a #1258 curated alias `alzheimer's / alzheimer / alzheimers → D000544`
(and apply the planned possessive/stem normalization, `docs/search-mesh-resolution-fallback-spec.md`),
which routes the query onto the attributed path that already ranks the directors correctly
for `alzheimer disease`. Then backfill areas for Mosconi (areas:null) and resolve the
missing-scholar gap (de Leon / Pereira).

---

## 7. Cross-query synthesis (Analyses A–F)

### Mapping outcome per query (primary form a user actually types)

| query | maps? | confidence | concept resolved | hits | worst-placed expected scholar |
|---|---|---|---|---|---|
| `diabetes` | **no** | — | — | 692 | Aras r486 |
| `CRISPR` | yes | entry-term (**wrong descriptor**) | CRISPR repeats (not CRISPR-Cas Systems) | 104 | Mason/Lyden not found; Artis r78 |
| `fecal microbiota transplantation` | yes | exact | Fecal Microbiota Transplantation | 115 | Battat/Gogokhia not found; Sonnenberg r26 |
| `single-cell RNA sequencing` | yes | entry-term | Single-Cell Gene Expression Analysis | 708 | Mason r705; Elemento r29 |
| `alzheimer's` | **no** | — | (topic anchor only, no MeSH) | 293 | de Leon/Pereira not indexed; Orr r76 |

Mapping is necessary but **not sufficient**: even the clean exact maps (FMT, and the
mapped form of Alzheimer's) still mis-rank specialists because of holes 2–5 below.

### Six recurring holes (each appears across multiple queries)

1. **Surface-form mapping gap** — lay terms (`diabetes`), possessives (`alzheimer's`),
   abbreviations (`FMT`, `CRISPR-Cas`, `scRNA-seq`→thin, `single-cell sequencing`→dark)
   fail or mis-route. Root: descriptor-name/entry-term matching with **no normalization
   layer** (stem/possessive/abbrev) + un-promoted #1258 candidates. *(A1, C1, D1, E5, F1)*
2. **Volume double-counted, centrality uncounted** — `OUTER ln1p(pubCount)` rewards raw
   output *and* BM25 term frequency rewards it again; there is **no concentration term**
   (share of a scholar's work that is about the concept). High-volume generalists beat
   focused specialists in every single query. *(A2, C3, D4, E2, F3)*
3. **The method-family 2.0× tag is binary, dominant, and attribution-dependent** — where
   it exists (CRISPR, scRNA-seq) it is *the* lever separating rank 1–5 from rank 40+, yet
   it fires for tool-users who ran one experiment (Jaffrey, Crystal, Suthanthiran) while
   missing genuine specialists whose `methodContext` wasn't extracted (Elemento, Sheth).
   Too generous and too absent at once. *(C2, E2, E3)*
4. **Area boost contributes ≈0 for concept/technique queries** — `areasOfInterest^3` and
   the OUTER `areaConcentration` (Hi 8 / Mid 4 / Lo 1.5) are gated on the query resolving
   to an *area-taxonomy* node, but MeSH concept labels ≠ area labels ("CRISPR" /
   "Single-Cell Gene Expression Analysis" never match "Single-Cell & Spatial Biology").
   And per-scholar `areas: null` kills it outright. *(A3/A4, C4/C5, E1, F4/F5)*
5. **Upstream data/attribution gaps no ranking change can fix** — zero-pub or un-indexed
   scholars (Mason pubCount 0; de Leon, Pereira, Battat, Gogokhia absent), and
   under-attribution that caps real experts (Peled 3 tagged vs ~13; Sheth 2 vs 17;
   Elemento's method tag missing). These are invisible to ranking *and* surface *through*
   the volume term. *(C6, D2/D3, E3/E4, F6)*
6. **Descriptor routing / confidence** — even when an abbreviation maps it can land on the
   weaker/wrong descriptor: `CRISPR` → *Clustered…Repeats* (entry-term, 104 hits, 1.15×)
   instead of *CRISPR-Cas Systems* (exact, 267, 1.5×). *(C1)*

### Refined recommendations (supersede / extend §4)

| # | fix | clears holes | effort |
|---|---|---|---|
| R1 | **Query normalization layer** (lowercase/possessive-strip/stem/abbrev) + **promote all #1258 lay-term/abbrev aliases** (`diabetes`, `diabetic`, `alzheimer's`, `FMT`, `lupus`, `covid`, …). Tie to `docs/search-mesh-resolution-fallback-spec.md`. | 1, 6 | med — mechanism exists |
| R2 | **Add a concentration/centrality term** to the score (e.g. share of a scholar's *tagged* pubs in the matched concept), to offset the unconditional `ln1p(pubCount)`. Single highest-precision lever; helps every query. | 2 | med-high — scoring change + index field |
| R3 | **Make the method-family signal graded, not binary** (scale by count/share of method-tagged pubs) and close the scholar-side `methodContext` extraction gap (Elemento). | 3 | med — ReciterAI + scoring |
| R4 | **Map MeSH concept labels ↔ area-taxonomy labels** so the area boost fires for technique/concept queries, not just exact area-name queries. | 4 | med |
| R5 | **Fix descriptor routing for ambiguous abbreviations** — prefer the dominant descriptor (`CRISPR → CRISPR-Cas Systems` exact). | 6 | low — curated alias |
| R6 | **Upstream data backfill** — identity/index gaps (Mason), missing scholars (de Leon, Pereira), under-attribution (Peled), `areas:null` (Mosconi, Vardhana, Igel, Aras). | 5 | high — ReCiter/ReciterAI |

R1 + R5 are the cheap, high-recall wins (curation + normalization). R2 is the deep
precision fix the volume double-count keeps demanding across every query. R3–R6 are the
long tail. Ordering for impact-per-effort: **R1 → R5 → R2 → R4 → R3 → R6**.

### Open questions (extends §5)

- **Q5.** Is the method-family 2.0× tag's broad firing on tool-users intended, or should it
  be graded by how much of a scholar's work *is* the method? *(holes 3)*
- **Q6.** Should the scRNA-seq surface forms be unified so pool size is stable
  (`scRNA-seq` 40 vs `single-cell RNA sequencing` 708 vs `single-cell sequencing` dark)? *(E5)*
- **Q7.** Does the area-concentration boost actually fire, or silently contribute 0? The
  people endpoint exposes no `areas` payload on hits (D6) — the gate is unauditable from the
  API. Confirm via OpenSearch `explain` or a debug field.
- **Q8.** What is the API paginating on (A5)? Deep pages are ordered differently than the
  displayed `relevanceScore`.

---

## 8. Curation strategy — does adding aliases make sense?

**Verdict: yes, for a bounded high-value class — and right now it's the *only* lever for
that class. It is not whack-a-mole, provided you let the three layers do different jobs.**

### Three levers, three jobs (don't make one do another's work)

| lever | fixes | does NOT fix | curation cost |
|---|---|---|---|
| **L1 — decompose-and-resolve fallback** (`SEARCH_MESH_RESOLUTION_FALLBACK`) | multi-concept strings that *contain* a descriptor sub-phrase (`liquid biopsy / ctDNA`, the chip labels) | bare single words (guard refuses them by design) | zero |
| **L2 — curated aliases** (`MeshCuratedAlias`) | bare lay / possessive / abbreviation terms with **no NLM surface form** (`diabetes`, `lupus`, `COVID`, `FMT`, `IVF`, `ALS`) | the long tail nobody curated | one human row each |
| **L3 — method-family taxonomy** | narrow method/instrument terms (`scRNA-seq`, CRISPR tools) | disease/concept topics | tag maintenance |

The spec (`docs/search-mesh-resolution-fallback-spec.md`, draft 2026-06-17) already
reached this two-layer conclusion: of 64 unmapped chips, decomposition auto-resolves 33
with **zero** curation; the remaining 31 have no NLM sub-phrase and need an alias. L3 is
the existing method-family path.

### Why curation is *unavoidable* for the bare-term class (measured)

The fallback's single-token guardrail (spec §3) **deliberately refuses** a bare word
unless it is an exact descriptor name ≥5 chars — because un-guarded it lands on homonym
traps (`Seahorse metabolic flux`→*Smegmamorpha*, the fish order; `Calcium imaging`→
*Calcium*). So the bare terms users actually type cannot be rescued by automation:

```
diabetes  lupus  COVID  ALS  IVF  MRI  ICU  SDOH  prenatal  diabetic  parkinson
  → all meshMapped:false on staging (fallback live), no 2-token window, not an exact name
```

Their MeSH targets are unambiguous and known (`diabetes`→D003920, `COVID`→D000086382,
`lupus`→D008180). The **only** mechanism that maps them is a curated alias. This is the
class that returns the volume-generalist results in Analyses A and F.

### The backlog is real, drafted, and 0% shipped (measured 2026-06-29)

| set | drafted (`*.candidates.csv`) | shipped (`curated.csv`) |
|---|---|---|
| mesh **aliases** | 34 | 10 (dept-name only, #642/#690) |
| mesh **anchors** | 114 | 8 |
| lay-term candidates (`docs/…lay-term-candidates.csv`) | 150 | — |

Probed all 34 drafted alias candidates against live staging: **30 fail outright, 4
resolve via the live fallback to the *wrong* generic descriptor, 0 resolve correctly.**

| candidate alias | intended target | live staging result |
|---|---|---|
| `AI in medicine` | Artificial Intelligence (D001185) | `partial` → **Medicine** ✗ |
| `blood disorders` | Hematologic Diseases (D006402) | `partial` → **Blood** ✗ |
| `gut bacteria` | Gastrointestinal Microbiome (D000069196) | `partial` → **Bacteria** ✗ |
| `disease surveillance` | Epidemiological Monitoring (D062665) | `partial` → **Disease** ✗ |
| `diabetes`, `lupus`, `COVID`, `IVF`, `ALS`, `MRI`, … (30) | (known UIs) | `meshMapped:false` ✗ |

So the deployed state is the worst of both: the fallback is on (and occasionally guesses
*wrong* — "AI in medicine" reads as the descriptor **Medicine** to users), while the
curated overrides that would fix those exact picks sit unshipped. **Promoting the alias
data is pure upside** — it both maps the 30 dark terms and corrects the 4 wrong guesses
(a curated alias always wins over the fallback, spec §3).

### Why this is bounded, not whack-a-mole

- The **head** is small and stable. A few hundred lay/abbrev/possessive terms cover the
  vast majority of real disease/concept searches; the candidate files already enumerate
  ~150. Curating the head once is an afternoon of review, not a treadmill.
- The **tail** is handled by automation (L1 decomposition) and L3 (method families), not
  by curation — that's what keeps it from being whack-a-mole.
- Curation is also the **safety valve** for L1: every wrong partial (`Medicine`, `Blood`)
  is correctable by one alias row.

### But curation has gaps and a ceiling — be honest about both

1. **Morphological variants aren't covered even by the candidates.** `diabetic`,
   `alzheimer` (no -s), `parkinson`, `parkinsons` all fail and are **not** in the
   candidate list (only `diabetes`, `Alzheimer's`, `Parkinson's` are). The normalizer
   strips the apostrophe (so `Alzheimer's`→`alzheimers` matches `alzheimers`) but does
   **not** stem, so `alzheimer`/`diabetic` still miss. Fix: a light stem/lemma in
   `normalizeForMatch` (covers all inflections for free) rather than an alias row per
   inflection. Curation + normalization, not curation alone.
2. **Each alias must pass a dominance check.** Routing a collision term to a single
   descriptor is safe only when one sense dominates. `diabetes`→Diabetes Mellitus is fine
   (Diabetes Insipidus is rare); this is why the #1258 candidate is flagged "Review." The
   review criterion is "does one descriptor own ≥~90% of the literal-token pubs?" — exactly
   the human judgment that makes it *curated*, and the reason it can't be fully automated.
3. **Curation cannot touch the ranking holes.** Even a perfectly mapped query still suffers
   the volume double-count (hole #2), the binary method tag (#3), the dark area boost (#4),
   and upstream data gaps (#5) — proven by FMT (Analysis D), which maps `exact` and *still*
   mis-ranks the expert's #1. Aliases fix *recall and which-concept*; they do not fix
   *who-ranks-first-within-the-concept*. That remains rec **R2** (a concentration term).

### Recommendation

1. **Ship L2 now.** Promote the 34 alias candidates (after the per-row dominance review)
   to `etl/mesh-aliases/curated.csv`. Highest ROI, lowest risk, corrects the live wrong
   guesses. Start with the head: `diabetes, COVID, lupus, ALS, IVF, IBD, CAR-T, MRI, ICU,
   SDOH, Alzheimer's, Parkinson's`.
2. **Add stem/lemma to `normalizeForMatch`** so inflections (`diabetic`, `alzheimer`,
   `parkinson`) resolve without an alias each. One change, covers the morphological tail.
3. **Keep / finish L1** (the fallback) but tighten the single-token guard that is emitting
   `Medicine`/`Blood`/`Bacteria`/`Disease` — or rely on L2 aliases to override them. Audit
   the live `partial` picks; some are net-negative vs `meshMapped:false`.
4. **Then R2** (concentration term) for the within-concept ranking — the ceiling curation
   can't reach.

Net: curating aliases makes sense and is currently the single cheapest correctness win
available, **for the bare-term head**. Pair it with normalization (inflections) and the
fallback (multi-concept tail) so curation stays bounded, and don't expect it to fix the
volume/centrality ranking defect.

---

## 9. R2 demonstrated — concentration vs volume (`hypertension`)

This isolates ranking hole #2 from the mapping holes. `hypertension` maps **exact**
(`conceptLabel: Hypertension`, 510 hits) and every hit is `publications`-kind, so the
index exposes `matched` (on-topic pub count) and `pubCount` for *all* 510 scholars —
mapping is not the confound here, only the within-concept ranking.

### The distortion (measured)

The live order tracks **total output**, not topical output:

- Live **top 60**: mean **189** total pubs but only **22** on-topic; mean concentration
  **9%**; **37 of 60 (62%)** have <5% of their work on hypertension.
- Live **top 25**: **11** have **<5** hypertension pubs — floated by `ln1p(pubCount)` +
  faculty + grants on a near-zero topical signal:

| live # | scholar | on-topic | total | focus |
|---|---|---|---|---|
| 10 | Quynh Truong | 2 | 173 | 1% |
| 14 | Robert Zhang | 1 | 70 | 1% |
| 16 | Jonathan Weinsaft | 2 | 245 | 0% |
| 22 | Robert Brown | 1 | 216 | 0% |
| 24 | Bjorn Redfors | 3 | 412 | 0% |

### The specialists it buries

Ranking by **absolute on-topic output** (`matched`) surfaces hypertension giants the live
order hides:

| scholar | on-topic HTN pubs | focus | **live rank** |
|---|---|---|---|
| Richard Devereux | 376 | 38% | #2 |
| **Michael Alderman** | 191 | 58% | **#46** |
| **Kristian Wachtell** | 137 | 54% | **#53** |
| **Peter Okin** | 91 | 31% | **#37** |
| **Robert Phillips** | 82 | 67% | **#82** |
| **Samuel Mann** | 51 | 70% | **#92** |
| Phyllis August | 47 | 40% | #15 |

People with 50–191 *actual hypertension publications* sit at #46–#92, while people with
1–3 hypertension pubs sit in the top 25. For a query that maps perfectly.

### What a concentration term would do (illustrative re-rank)

Re-ranking by a transparent topical score `matched × (0.5 + concentration)` — reward
on-topic output, scaled by focus:

| proposed # | scholar | on-topic | focus | was live # |
|---|---|---|---|---|
| 1 | Richard Devereux | 376 | 38% | #2 |
| 2 | Michael Alderman | 191 | 58% | #46 ↑ |
| 3 | Kristian Wachtell | 137 | 54% | #53 ↑ |
| 4 | Robert Phillips | 82 | 67% | #82 ↑ |
| 5 | Peter Okin | 91 | 31% | #37 ↑ |
| 6 | Evelyn Horn | 70 | 41% | #13 ↑ |
| 7 | Samuel Mann | 51 | 70% | #92 ↑ |
| … | | | | |

Drops out of the top 15 (all volume floats): Goyal (7 on-topic), Peterson (4), Wolf (9),
Truong (2), Zhang (1).

### Why this is the high-value fix

- **The signal already exists.** `matched` is the very number rendered in the UI
  ("*N of M publications tagged Hypertension*"). A concentration/topical-output term needs
  **no new data and no reindex** — it is a scoring change in `lib/api/search.ts`, replacing
  or supplementing the unconditional `ln1p(pubCount)` with `ln1p(matched)` (and optionally
  a focus factor).
- **It is mapping-independent.** It improves every query that resolves, which is why it sits
  *under* the curation work: aliases decide *which concept*; this decides *who leads it*.
- It directly fixes holes A2/C3/D4/E2/F3 — the one defect that recurs in **every** analysis.

### Honest caveats

1. The `matched × (0.5 + conc)` blend is an **illustration**, not a tuned formula. The real
   weight between absolute on-topic output and focus needs A/B tuning (pure concentration
   over-rewards a 70%-of-12-pubs junior over a 38%-of-975 field leader; pure `matched`
   re-introduces a volume bias). Devereux tops *both* the live and proposed orders — a good
   sign the target isn't "demote everyone productive," just "stop rewarding off-topic volume."
2. It inherits the **attribution gap** (hole #5): `matched` is only as good as the index's
   tagging. Peled (FMT) and Elemento (scRNA-seq) were under-attributed, so a concentration
   term helps them less than it should until upstream tagging improves.
3. Method-family-tagged scholars expose **no `matched` count** via the API (the tag is
   binary), so a concentration term must be computed from the underlying tagged-pub set at
   score time, not from the displayed evidence — confirm the count is available index-side
   for method-tagged hits too.

**Refined R2:** add a topical-output term (`ln1p(matched)` ± a focus factor) to
`OUTER_sum`, sourced from the already-indexed tagged-pub count, and down-weight the raw
`ln1p(pubCount)` volume term. Tune the blend on staging against expert-labeled queries
(the lists in Analyses A/C/D/E/F are a ready test set).

---

## 10. Audit — double-counting & the non-full-time-faculty penalty

Both run on the `hypertension` set (maps exact, 510 scholars, all `publications`-kind so
`matched`/`pubCount`/`roleCategory`/`hasActiveGrants` are observable for everyone). The
two defects compound: the same machinery floats off-topic full-time faculty *and* buries
on-topic non-faculty.

### 10.1 Double-counting (off-topic volume scored twice)

Volume enters the score twice: once *legitimately* via BM25 term frequency on the
concatenated `publicationTitles`/`publicationMesh` field (more on-topic pubs → more
tokens), and once *illegitimately* via `OUTER_sum`'s `ln1p(pubCount)`, which counts a
scholar's **total** output — including pubs with nothing to do with the query.

**Correlation across all 510 (the signature):**

| signal | corr. with score |
|---|---|
| total pubs | **+25%** |
| on-topic pubs (`matched`) | +35% |
| concentration (`matched/pubs`) | **−6%** (≈ none) |

If volume were counted only through on-topic BM25, total pubs would add nothing beyond
`matched`. It adds an independent +25%, and focus contributes essentially zero. The ranker
rewards *output*, not *relevance-density*.

**Held-constant test** — scholars with 1–3 on-topic pubs (≈ no hypertension focus),
bucketed by total output:

| total pubs | n | mean score | best rank |
|---|---|---|---|
| <60 | 217 | 165 | #48 |
| 60–150 | 94 | 241 | #14 |
| ≥150 | 85 | 233 | **#10** |

Same (negligible) topical output; mean score and best rank climb with off-topic volume.
Concretely, 11 of the live **top 30** have ≤3 on-topic pubs — e.g. Truong 2/173, Weinsaft
2/245, Brown 1/216, Redfors 3/412, RoyChoudhury 1/114 (a **biostatistician**) — all
full-time faculty floated by `ln1p(pubCount)` + the faculty/grant terms on a ~0% topical
signal.

**Fix:** this is the same lever as R2 — swap the `ln1p(pubCount)` volume term for
`ln1p(matched)` (on-topic output). That removes the off-topic double-count by construction
and makes concentration matter. No new data; `matched` is already indexed.

### 10.2 The non-full-time-faculty coverage penalty (a triple stack)

`OUTER_sum` adds `+1.0` for `personType == "full_time_faculty"` and `+0.5` for active
grants. `roleCategory` **is** personType. Across the 510:

| role | n | mean rank | mean on-topic | % w/ grants | % areas:null |
|---|---|---|---|---|---|
| full_time_faculty | 238 | 203 | 5 | 53% | **10%** |
| affiliated_faculty | 248 | 293 | 5 | 7% | **100%** |
| postdoc | 11 | 366 | 1 | 36% | 100% |
| non_faculty_academic | 8 | 405 | 1 | 37% | 100% |
| fellow | 5 | 406 | 1 | 0% | 100% |

Non-FT scholars are penalized on **three** independent axes, none of which is expertise:

1. **No `+1.0` faculty term** — by definition. On a typical multiplier of `1 + ln1p(pubs)
   (≈3–5) + …`, a flat +1.0 is a **~18–30% score swing**, awarded for an employment
   category.
2. **Grant term rarely fires** — only **7%** of affiliated faculty have active grants vs
   **53%** of FT, so they also miss the `+0.5` far more often (emeritus/voluntary/clinical
   faculty hold fewer active NIH grants regardless of stature).
3. **`areas: null` for ~100% of every non-FT category** vs 10% of FT — research-area
   rollups appear to be **computed only for full-time faculty**, so the entire area boost
   (Hi 8 / Mid 4 / Lo 1.5) is *categorically dark* for affiliated faculty, postdocs,
   fellows, and non-faculty academics, on **every** query.

**Controlled comparison** (hold expertise + volume constant — scholars with on-topic
output 5–25):

| role | n | mean on-topic | mean total pubs | mean score | mean rank | % grants |
|---|---|---|---|---|---|---|
| full_time_faculty | 35 | 9.4 | 142 | **368** | **114** | 74% |
| affiliated_faculty | 33 | 9.2 | 138 | 255 | 202 | 18% |

Essentially identical topical output (9.4 vs 9.2) and total volume (142 vs 138), yet FT
score **+44%** higher and rank **88 places** better — entirely from personType + grants +
area-boost eligibility.

**Who this buries** — every concentrated hypertension specialist in the set is affiliated
faculty without active grants:

| scholar | on-topic HTN pubs | focus | live rank | role | grants |
|---|---|---|---|---|---|
| Michael Alderman | 191 | 58% | #46 | affiliated | no |
| Kristian Wachtell | 137 | 54% | #53 | affiliated | no |
| Robert Phillips | 82 | 67% | #82 | affiliated | no |
| Samuel Mann | 51 | 70% | #92 | affiliated | no |
| Joseph Schwartz | 65 | 33% | #67 | affiliated | no |

Meanwhile the live top 2 (Safford 9% focus, Devereux 38%) are FT with grants. The system
is optimizing for *employment category + funding + volume* over *topical expertise*. The
two defects interlock: off-topic FT faculty rise (10.1) while on-topic non-faculty sink
(10.2).

### 10.3 Implications / recommendations (extend §7)

- **R2 (now doubly justified)** — replacing `ln1p(pubCount)` with `ln1p(matched)` fixes the
  double-count *and* removes the off-topic-volume advantage that compounds the FT bias.
- **R7 (new) — drop or shrink the `+1.0 full_time_faculty` identity term.** It encodes
  employment status, not expertise, and is the cleanest single contributor to the non-FT
  penalty. If a prominence prior is wanted, derive it from topical output, not personType.
  Re-evaluate the `+0.5` grant term on the same grounds (it proxies personType here).
- **R8 (new) — compute research areas for non-FT scholars.** The `areas:null`-for-everyone-
  but-FT pattern means the area boost can *never* reach an affiliated/clinical/voluntary
  faculty expert. Extend the ReciterAI rollup to any scholar with ≥N attributed pubs, not
  just full-time faculty. (Upstream; also resolves the per-scholar `areas:null` cases in
  Analyses A4/C5/F5.)
- **Caveat:** some FT-faculty weighting may be *intended* (the SPS is a faculty directory).
  If so, make it explicit and bounded — a small tiebreaker, not a flat +1.0 that
  out-weighs 50–190 on-topic publications. The data shows it currently overrides expertise,
  which is unlikely to be the design intent.

---

## 11. Audit — live `partial` fallback quality (169 curated chips)

Probed all 169 entries of `data/suggested-searches.json` against staging and compared each
resolved `conceptLabel` to the chip's intended `mesh` descriptor(s).

> **Correction to the §8 framing.** My initial pass flagged 34 partials as "wrong" — that
> was a normalization bug (it stripped spaces from the resolved label but not the intended
> name, so multi-word matches like `Maternal mortality & morbidity → Maternal Mortality`
> false-failed). Corrected below: the fallback is **good** on the chips.

### Result

| outcome | count | meaning |
|---|---|---|
| mapped exact | 52 | whole query = descriptor name |
| mapped entry-term | 77 | whole query = NLM entry term |
| **partial (fallback)** | **37** | **36 resolve to an intended descriptor; 1 (`Cardio-oncology → Cardio-Oncology`) is a valid alternative** |
| anchored/other | 1 | Neoantigen cancer vaccines |
| unmapped | 2 | Real-world evidence; Inflammasome / NLRP3 |

**167 of 169 resolve to a sensible descriptor; 0 genuine homonym/generic traps on the chip
set.** The decompose-and-resolve fallback does exactly what the spec designed it for —
multi-concept chip labels like `Liquid biopsy / circulating tumor DNA`, `CRISPR / gene
editing`, `Maternal mortality & morbidity` correctly resolve one valid descriptor of the
intended pair (single-descriptor-per-query is the accepted limit, OQ-1). The live fallback
is **net-positive** on well-formed queries.

### So where do the bad partials come from?

Not the chips — the **bare / short free-typed queries** from the §8 alias-candidate probe:

| query | fallback picks | should be |
|---|---|---|
| `AI in medicine` | **Medicine** | Artificial Intelligence |
| `blood disorders` | **Blood** | Hematologic Diseases |
| `gut bacteria` | **Bacteria** | Gastrointestinal Microbiome |
| `disease surveillance` | **Disease** | Epidemiological Monitoring |

The trap is a narrow, specific class: a multi-word query whose **only** resolvable window
is a *generic component word that happens to be an exact MeSH descriptor name* (`Medicine`,
`Blood`, `Bacteria`, `Disease`). The spec's guard ("single-token windows resolve only if
exact-name ≥5 chars, not a stopword") **admits** these because the word *is* an exact name —
the guard screens out homonyms (`Calcium`, `Mice`) but not generic-but-real descriptor
names. The fallback latches onto the generic tail word and drops the salient term (`AI`).

### Verdict & recommendation

- **Keep the fallback.** On the population it was built for (multi-concept topic queries),
  it is accurate (167/169) and low-risk (partial tier admits only under the sparse floor and
  renders tentative "interpreted from your search" UI — it cannot reorder a dense lexical
  ranking).
- **Tighten the guard for the generic-name class, OR let curation override it.** Two options,
  not exclusive:
  1. Add a small **generic-descriptor stoplist** (`Medicine`, `Disease`, `Blood`, `Bacteria`,
     `Patients`, …) that the single-token window may not resolve to even when exact-name; or
     require the matched window to cover ≥ ~50% of the query's content tokens (so `AI in
     medicine` won't resolve on `medicine` alone).
  2. Ship the §8 **curated aliases** — `AI in medicine → D001185`, `blood disorders →
     D006402`, etc. already exist as candidates and override the fallback (curation wins).
     This fixes the exact observed cases without touching the guard.
- The two unmapped chips (`Real-world evidence`, `Inflammasome / NLRP3`) are residual
  curated-alias targets — add them to `curated.csv`.

Net: the earlier worry that the live fallback is broadly mis-guessing is **not borne out**
on curated queries. Its only real failure mode is generic-exact-name single windows on
bare queries, which curation (§8) or a short stoplist resolves.

---

## 12. Audit — combining different evidence types

This is the defect underneath most of §6–§11: a scholar can match via four evidence
**kinds**, scored on **incommensurable scales** that combine with no normalization, so the
*kind* of evidence routinely overrides its *depth*.

| kind | how it scores | scale |
|---|---|---|
| `method` (method-family tag) | INNER **×2.0** multiplier, **binary** (fires the same for 1 tool or 50) | multiplicative tier |
| `tagged` (MeSH-attributed pub) | INNER **×1.5** + BM25 TF on `publicationMesh^4` | multiplicative + additive |
| `mention` (literal token in pub text) | BM25 only, **no** attribution multiplier | additive only |
| `selfDescription` (self-authored bio) | BM25 `overview^2` | additive only |

Layered on top: OUTER `1 + ln1p(pubCount) + faculty + grants + areaConcentration(8/4/1.5)`.
So the final score is `BM25 × (multiplicative tier) × (additive prominence)` — mixing
multiplicative tiers with additive volume, with each evidence kind on a different scale.

### 12.1 The kind leapfrogs the depth (obesity, maps exact)

| rank | scholar | score | kind | total pubs | on-topic depth |
|---|---|---|---|---|---|
| 1 | Alpana Shukla | 1519 | method | 80 | binary tag |
| 3 | Louis Aronne | 1075 | method | 208 | binary tag |
| 5 | Beverly Tchang | 913 | method | 34 | binary tag |
| 7 | Sarah Barenbaum | 584 | method | **12** | binary tag |
| 8 | Eugene Lucas | 577 | method | **9** | binary tag |
| **10** | **Sangeeta Kashyap** | 516 | publications | 179 | **65 tagged obesity pubs** |
| 11 | Richard Devereux | 504 | publications | 975 | 20 tagged |

**Kashyap has 65 obesity-tagged publications and ranks #10 — below Lucas (a method tag on a
9-publication profile, #8) and Barenbaum (method tag, 12 pubs, #7).** The ×2.0 method tier
beats 65 units of deep tagged evidence. Across the whole result set the tiers separate
cleanly: `method` median score **1075** (mean rank 4) vs `publications` **161** (mean rank
311) — a 6.7× gap from the evidence *kind* alone.

### 12.2 The method tag has no depth, and it's an upstream artifact (CRISPR)

The six top CRISPR scholars are all method-tagged on profiles of 18–193 pubs (Long **18**,
Wen 36, Gao 41), and they outrank publications-evidence scholars with substantial on-topic
work: Charles Rice (**11** CRISPR-mention pubs, #16), Charles Rudin (**13**, #35), Doron
Betel (6, #23). Whether the ×2.0 fires depends on ReciterAI's `methodContext` extraction,
not on how much CRISPR a scholar actually does (hole #3) — here seen as a *cross-type*
failure: a binary tag outranks 11–13 documented on-topic publications.

### 12.3 `tagged` vs `mention` is a tagging artifact, not an expertise difference

Obesity, publications-kind only:

| strength | n | mean rank | mean on-topic | mean pubs |
|---|---|---|---|---|
| tagged | 532 | 296 | 2.7 | 126 |
| mention | 78 | 412 | 2.0 | 80 |

`tagged` gets the ×1.5 MeSH-attribution multiplier; `mention` gets nothing. So the *same*
fact — "N of this scholar's publications are about obesity" — is scored ~1.5× higher when
ReciterAI MeSH-tagged the pub than when the term only appears in the title/abstract text.
Two scholars with identical topical footprints rank differently on an upstream tagging
coincidence. (This compounds the FMT/scRNA-seq under-attribution in §6.)

### 12.4 `selfDescription` is mostly a *display* artifact, not a ranking lever (corrected)

I initially framed `selfDescription` as a ranking wildcard ("Safford tops diabetes on a bio
mention"). Probe P2 (§13) corrected this and I verified it:

- `evidence.kind == "selfDescription"` is a **display-precedence** choice
  (`lib/api/result-evidence.ts`): the bio sentence is shown in the evidence *row* even when
  the scholar also has publication mentions. It does **not** mean the bio drove the rank.
- Safford *is* still #1 for diabetes (re-verified: score 615, `selfDescription` shown,
  `matchReason.kind: topic`) — but she is a 727-pub full-time-faculty scholar with diabetes
  signal across `publicationTitles`/`overview`; her rank is **volume + multi-field BM25**,
  not the bio. The bio is merely what's *displayed*.
- As a *ranking* input, `overview^2` is the **lowest** topic-field weight (vs
  `publicationTitles^6`/`publicationMesh^4`/`areasOfInterest^3`), and it cannot manufacture
  prominence: P2 found genuinely bio-only matches top out around rank ~33 and only when the
  scholar *also* has ~291 pubs + grants + FT status; a low-merit, no-pub gamer stays buried
  past rank 80 on every probed query (obesity/aging/longevity/nutrition had **zero** bio-only
  matches in the top 80).

**Net:** the gaming surface is real but weak (overview is scholar-editable and admits via
`overview^2`, but the OUTER prominence multiplier a gamer can't fake dominates). The genuine
defect is §12.5: the displayed reason can show a bio sentence while volume actually drove the
rank — a transparency problem, not a bio-gaming problem. The obesity #619 vs diabetes #1
contrast was a display-precedence pattern on top of prominence, not "bio decisive when
unmapped."

### 12.5 Displayed evidence ≠ what drove the rank

`matchReason` surfaces a single kind, but the score blends all of the above plus volume.
Safford appears for obesity at #9 as "19 of 727 publications" while her rank is really
`ln1p(727)`-driven volume; method-tagged scholars display "method: family" while their order
among themselves is set by `ln1p(pubCount)` + area + grants. The shown reason does not
explain — and sometimes actively misrepresents — the ranking.

### 12.6 Recommendation — collapse the tiers onto one commensurable axis

The root issue is four scales where there should be one. Fix direction (extends R2):

1. **Replace the multiplicative kind-tiers with a single additive topical-output term.**
   Count on-topic publications regardless of how they were detected, with a *modest* weight
   for evidence quality (e.g. tagged 1.0, mention 0.7, method-tagged pub 1.0 **per pub** —
   not a flat ×2.0), and feed `ln1p(weighted_on_topic_count)` into OUTER. This makes 65
   tagged pubs beat a 9-pub method profile, removes the tagged/mention multiplicative gulf,
   and gives the method tag *depth* (count of method-tagged pubs) instead of a binary lever.
2. **Cap `selfDescription` as a weak tiebreaker** that can never lead a ranking, and make its
   weight independent of mapping outcome (so it doesn't spike on unmapped queries).
3. **Don't mix multiplicative tiers with additive prominence.** Once topical evidence is one
   additive term, the only multipliers left should be deliberate, bounded ones.
4. **Make the displayed `matchReason` reflect the dominant score contributor** (transparency
   + auditability), or at least never show a topical reason when volume/faculty actually
   drove the rank.

This is the same lever as R2/§9/§10.1: one on-topic-output term, computed from the
already-indexed counts, replaces the tangle of incommensurable evidence tiers.

---

## 13. New-problem probes (P1–P6, adversarial)

Six independent hypotheses probed against live staging, each told to **refute** if the
evidence didn't hold. Result: **3 new real problems** (P4 high, P5/P6 medium) and **3
refuted** (P1, P2, P3) — including P1, which overturns my own §2 **A5**, and P2, which
corrects §12.4. Recording the refutations matters as much as the findings.

| probe | verdict | severity |
|---|---|---|
| P1 pagination / sort-key stability | **NOT REAL** (refutes A5) | none |
| P2 selfDescription gaming | **NOT REAL** (corrects §12.4; display artifact only) | low |
| P3 name-search quality | **NOT REAL** (works; only gap = no typo tolerance) | low |
| P4 multi-word precision / minimum_should_match | **REAL** | high |
| P5 department-query quality | **REAL (partial)** | medium |
| P6 acronym disambiguation | **REAL (partial)** | medium |

### P1 — Pagination & sort-key stability

**Verdict: NOT REAL — severity none.** The displayed `relevanceScore` *is* the API's pagination sort key; deep pages are correctly ordered, complete, dedup'd, and stable.

Probed live on `scholars-staging` (cache-busted, IPv4), two large topic queries:

| Check | diabetes (total 692, 35 pp) | hypertension (total 510, 26 pp) |
|---|---|---|
| Rows fetched vs total | 692 = 692 (exact) | 510 = 510 (exact) |
| Unique cwids / duplicates | 692 / **0** | 510 / **0** |
| Gaps (union < total) | **none** | **none** |
| Adjacent score increases (full seq) | **0** (615.38 → 0.0095) | **0** (811.24 → 0.94) |
| Cross-page boundary violations | **0 / 34 seams** | 0 |
| Paginated-pos vs score-rank: max divergence | **0** | **0** |
| Tie groups | 1 (2 rows at tail, 0.00952) | 0 |

- **(c) Repeatability:** diabetes page 5 fetched twice in separate requests → identical cwids, identical order, identical scores (198.25 → 192.50).
- **Time-stability:** diabetes pages 0 / 30 / 34 re-fetched ~10 min later → identical cwids, order, scores; total unchanged (692).

**Why it's clean:** behavior matches a standard OpenSearch `from/size` window over a single `_score`-desc sort — the rendered score is the sort key, so paginated position == score-sorted rank by construction. The single tail tie is deterministically ordered across refetches. The earlier A5 "out-of-order deep pages" observation does **not** reproduce. No fix needed.

### P2 — Self-description / overview as a ranking lever (gaming risk)

**Verdict: NOT REAL — severity low (latent surface only; the stated problem does not manifest).** The claim conflates the *display* field `evidence.kind="selfDescription"` with a *ranking* effect, and its headline example is false.

**Probe** (staging `/api/search?type=people`, 5 topic queries, top ~80 paged + deduped + sorted by relevanceScore):

| Query | Top-20 evidence mix | Bio-only matches (selfDescription + area MR + `pubHighlight:null`) |
|---|---|---|
| diabetes | 20/20 `publications` | best = **rank 33** (then 41/43/45/49/56) |
| obesity | 20/20 `publications` | **none in top 80** |
| aging | 20/20 `publications` | **none in top 80** |
| longevity | 20/20 `publications` | **none in top 80** |
| nutrition | 18 `publications` + 2 `selfDescription` | **none** (both selfDescription rows are pub-backed) |

- **Headline example is fabricated/stale:** Safford is **not in the diabetes top 80 at all**, let alone #1. Diabetes #1-20 are all `publications`/`mention` (pubs 25-500).
- **`selfDescription` ≠ bio-driven rank.** It's a *display* precedence (`lib/api/result-evidence.ts:477-505`: a full-query bio sentence outranks `pub.mention` for the evidence row). The only two selfDescription scholars in any top-20 (nutrition #3 Cunningham-Rundles, #13 Lieberman) both carry pub-mention matchReasons — *"6 of 128 publications mention nutrition"*, *"6 of 45…"* — i.e. publication-backed.
- **Pure bio-only ceiling is rank ~33, and only with max prominence.** The six diabetes bio-only hits (Suthanthiran #33, Mathad #41, Antal #43, Halama #45, Gudas #49, McGraw #56) are *all* `full_time_faculty` with 38-291 pubs and 1-21 grants — and they're genuinely diabetes-adjacent (Gudas: *"RETINOID PHARMACOLOGY…DIABETES"*; McGraw: GLUT4/type-2-diabetes). Their OUTER prominence, not the bio, carries them; the bio only adds recall. A no-pub / non-faculty / no-grant gamer has OUTER≈1 and only `overview^2` BM25 → buried below 80.

**Mechanism (why the surface exists but is harmless):** `overview` *is* attacker-controllable — scholar- or superuser-editable (`lib/edit/authz.ts:65-77`) — and `overview^2` is an admission+scoring field. But in `PEOPLE_TOPIC_HIGH_EVIDENCE_FIELD_BOOSTS` (`lib/search.ts:687-697`) `overview^2` is the *lowest* topic weight, dwarfed by `publicationTitles^6` / `publicationMesh^4` / `areasOfInterest^3` / `primaryTitle^3`, and FINAL = BM25 × INNER × OUTER is dominated by the pub/faculty/grant-driven OUTER a gamer can't fabricate.

**Fix direction (optional hardening, low priority):** if the latent surface is a concern, move `overview` to a scoring-only `should` clause (like `publicationAbstracts`) so a bio-only hit can't *admit* a scholar, or require co-occurrence with a publication-derived field — but empirically the lever caps at rank ~33 and currently only improves recall for legitimate researchers, so no action is warranted today.

### P3 — Name-search quality & common-name disambiguation

**Verdict: NOT REAL (core hypothesis refuted) — severity low** (one niche caveat: no typo tolerance). Name search returns the right person #1, surnames disambiguate within the surname set, and zero topic hits leak in. All probes on the *real* first page (page 0 / no param — the app is 0-indexed; see caveat).

| Probe | Query | queryShape | total | Result |
|---|---|---|---|---|
| (a) full name | `Louis Aronne` | name_template | 12 | **Louis J Aronne, MD #1** score 5747.8 vs next (Voigt) 431.8 — clean 12× gap |
| (a) full name | `Olivier Elemento` | name_template | 1 | **Olivier Elemento, PhD #1** score 10675 |
| (b) surname | `Lee` / `Cohen` / `Kim` / `Smith` | name_template | 80 / 18 / 55 / 18 | every hit matches surname (`allMatchSurname=true`); ordered by name-BM25×OUTER (Cohen 3903/3883/3874 — sensible) |
| (c) `Last, First` | `Aronne, Louis` | topic_template | 1 | Aronne #1 (comma → topic_template, cosmetic; still correct) |
| (c) `Last First` | `Aronne Louis` | name_template | 12 | Aronne #1 score 1972 |
| (d) misspelling | `Elemnto` / `Elemeto` / `Elementoo` | topic_template | **0 / 0 / 0** | empty — no fuzzy match |
| (d) one-token-exact | `Oliver Elemento` | name_template | 7 | Elemento #1 (Elemento exact ⇒ fine) |
| (e) name-as-word | `Brown` / `Gray` / `Berger` / `Rich` | name_template | 19 / 2 / 6 / 2 | only same-surname people (`nonMatch=[]`) — **no topic leakage** |

**Genuine (low) gap — no typo tolerance:** name matching is exact/BM25 with no fuzziness, so a single-character typo on a distinctive surname (`Elemnto`, `Aroone Louis`) returns **total=0** instead of suggesting the right person. Graceful (empty, no error) and rare, but unhelpful. *Fix direction:* add a `fuzziness:"AUTO"` clause (or a low-prefix-length match) on the `name` field for `name_template`, gated so it only fires when the exact pass is empty.

**Red herring — do NOT re-report:** the eye-catching "page 1 returns empty / `hitsLen ≈ max(0, total−20)`" pattern is **not a bug**. The API is 0-indexed by contract (`from = page*pageSize`): no-param default = `page:0` returns the correct top hits; `page=1` returns results 21-40 (empty when total≤20). Verified the real client matches end-to-end — `route.ts:70` `page=Math.max(0,rawPage)` (default 0); `search/page.tsx:182` same, `:1291` `position={page*pageSize+i}`; local `Pagination` (`page.tsx:3103`) iterates 0-based `n`, labels it `n+1`, and drops the `page` param for page 0. The probe spec's 1-indexed `page=<n>` is what produced the empty first page.

### P4 — Multi-word precision / minimum_should_match over-broadening

**Verdict: REAL — severity HIGH.** Specific multi-word queries admit scholars matching only a strict subset of salient tokens; adding precise words *broadens* the pool and can bury the canonical answer.

**Probe 1 — adding words does NOT narrow (live totals):**

| query | tokens | total hits | shape |
|---|---|---|---|
| cardiac surgery | 2 | 3,658 | hybrid |
| pediatric cardiac surgery | 3 | 4,458 | hybrid |
| pediatric congenital heart surgery | 4 | **4,558** | hybrid |
| drug discovery | 2 | 468 | topic |
| computational drug discovery | 3 | **859** | topic |
| health policy | 2 | 660 | topic |
| health policy economics | 3 | 176 (narrows) | topic |

The 4-word subspecialty query (4,558) matches **more scholars than the generic words "research" (1,772) or "human" (2,006)**, and ~2/3 of the ≥6,800 searchable population ("clinical" = 6,800). Hyper-specificity = no filtering power. (One counterexample — "health policy economics" narrows — so the effect is term-dependent, not universal.)

**Probe 2 — token-scatter, attributed:**
- **Cynthia Magro, MD** (dermatopathology; concepts all Skin/Melanoma/COVID) ranks **#1 for bare "pediatric"**, is **absent from page 1 of "cardiac"/"surgery"/"congenital"/"heart"**, yet ranks **#5 for "pediatric cardiac surgery"** (matchReason NULL) — 1 of 3 salient tokens.
- **Stavros Memtsoudis, MD** (concepts: Knee/Hip Arthroplasty, Spinal Fusion, Postop Pain) ranks **#8** — "surgery" axis only, no pediatric/cardiac.

**Probe 3 — precise query buries the right answer:** **Emile Bacha, MD** (the actual pediatric congenital-heart surgeon, "6 of 223 pubs tagged Thoracic Surgery", **#2** on the 3-word query) falls **below rank 200 of 4,558** when "congenital heart" is added (verified across 10 distinct pages: 200 unique cwids, scores 579.8→318.9, zero "Bacha"). Promoted instead into the 4-word top-10: **Zev Rosenwaks #7 (IVF — Fertilization in Vitro/Oocytes, zero overlap)**, Maria DeSancho #2 (hematology), Laura Pinheiro #3 / Bjorn Redfors #8 (pop-health, topic:Cardiovascular only). **Zero clean 4/4-concept matches in the top 15.**

**Mechanism (tied to ranking math):** `minimum_should_match "2<-34%"` is applied over the *expanded* should-clause set — each word fans out into MeSH terms/synonyms across 7+ weighted fields — so a scholar saturated on **one** concept (e.g. "pediatric" → pediatrics/child/infant across title^6/mesh^4/areas^3) clears the ~66%-of-clauses bar **without matching the other query words**. Adding a term that expands to a popular concept ("heart" → Cardiovascular Disease) then injects clauses that BM25 + OUTER (full-time +1.0, ln1p pubCount) amplify for the large FT cardiology population, sinking the narrow non-FT subspecialist. Distinct from the documented concept-broadening/volume items: the specific defect is that **one term's expansions satisfy the should-threshold alone**.

**Fix direction:** gate `minimum_should_match` on the count of **distinct query concept groups** (post-expansion), not raw clause count — require coverage of ≥N of the original tokens' concept groups (per-concept should-blocks / cross_fields), or add a proximity/phrase `must` for multi-word specific queries so all salient terms must co-occur.

### P5 — Department-query quality (dept template + chair/chief boost)

**Verdict: PARTIAL / REAL — severity MEDIUM.** Member precision for true department names is excellent (refutes "includes non-members"), but the marquee chair/chief leadership boost (#532) is silently inert on staging, and WCM's large clinical *divisions* get no department treatment at all.

**(a)+(b)+(d) True dept names → `department_template`, perfect member precision (0 false positives):**

| Query | queryShape | total | top-20 in queried dept |
|---|---|---|---|
| Dermatology | department_template | 176 | **20/20** |
| Pediatrics | department_template | 878 | **20/20** |
| Population Health Sciences | department_template | 1428 | **20/20** |
| Psychiatry | department_template | 854 | **20/20** |

The dept body is a dept/title/name ladder with no pub-evidence fan-out and no MeSH/topic expansion, so non-members can't leak in. The hypothesis's "surfaces non-members" concern does **not** hold for real dept names.

**(c) Chair/chief boost does NOT surface leaders — the boost is firing for nobody:**

- `lib/api/search.ts:1343-1358` adds a `function_score` term filter (`leadership.chairOf == query.toLowerCase()`, chair weight **3.0**, chief **1.5**); `lib/api/search-flags.ts:210` defaults it **ON**; the doc (search-flags.ts:197-201) claims the eval puts **Permar #1 on `pediatrics`** and **Kaushal #1 on `population health sciences`**.
- Staging contradicts this. Raw-text grep across **all 44 `Pediatrics` pages**: `Permar`/`Sallie` = **0**. Across **all 72 `Population Health Sciences` pages**: `Rainu`/`Kaushal, MD` = **0** (only namesake *Kaushal Shah*, Emergency Medicine, rank 739). The chairs are **entirely absent**, not merely un-boosted.
- No boost signature on any dept query: page-1 rank1/rank2 score ratios are ~1.0 (PHS 1753.2/1751.5 = 1.001; Peds 517.0/509.1 = 1.016) — a 3.0x boost would make rank1 ~3x rank2. Top hits are ordinary publishing faculty (Peds #1 Chou, PHS #1 Zhou), not the chair.
- Hybrid `permar pediatrics` (total 2044, 20 hits hydrated) returns **no Permar in top-20** — the surname anchor matched nobody → the chair scholars are absent from the searchable index, so `leadership.chairOf` carries on no doc and the boost is a no-op. *(Caveat: `name_template` separately returns 0 hits for everyone right now — Breitbart/Chou/Zhou all total>0/hits=0 — a name-path confound, deliberately NOT used as P5 evidence.)*

**Division names get neither clean membership nor a chief** (WCM clinical divisions have no dept-level entity → routed to `topic_template`, not `department_template`):

| Query | queryShape | top-20 in Dept of Medicine | outside |
|---|---|---|---|
| Cardiology | topic_template | 8/20 | 12 (CT-Surg 3, Radiology 3, PopHealth 2, EM 1, Peds 1, SysBio 1, none 1) — #1 is a PopHealth researcher |
| Hematology and Medical Oncology | topic_template | 12/20 | 8 (Anesth/Neuro/Path/Peds/PopHealth/Radiology/Urology) |
| Gastroenterology | topic_template | 10/20 | 10 (Surgery 3, Peds 2, …) |

The `chiefOf` boost is by-design dormant here — `search.ts:1338-1342`: *"today's classifier never routes division-name queries to dept-shape, so the chief filter is dormant."*

**Mechanism:** department_template precision is good by construction. The #532 boost is a correct `function_score` but inert because the chair scholars aren't present in the searchable people index (term filter matches nothing → no chair ever surfaces). Division names never reach the dept template, so the `chiefOf` half is structurally unreachable and ~half of a division's top-20 are out-of-department.

**Fix direction:** verify `Department.chairCwid`/`Division.chiefCwid` point to *indexed, non-deleted* scholars and re-run the leadership sidecar on a reindex (so the boost has data to act on); and route known *division* names to a divCode-scoped dept/division template that activates the existing `chiefOf` boost, so "Cardiology"/"Gastroenterology" return the division's members + chief instead of a topic-scattered cross-department list.

### P6 — Acronym / ambiguous-short-query disambiguation

**Verdict: PARTIAL / REAL — medium.** The six prompt cases (2-char) are SAFE (unmapped→BM25), refuting the stated mechanism; but probing ≥3-char acronyms found a NEW confident wrong-sense homonym bug: **CAR→"Automobiles", PET→"Pets"**.

**Prompt's 2-char cases — all safe (suppressed before resolution):**

| q | total | meshMapped | scope | conceptLabel | verdict |
|---|---|---|---|---|---|
| MS | 83 | false | expanded | null | →BM25 (noisy literal "MS") |
| CD | 666 | false | expanded | null | →BM25 |
| ER | 113 | false | expanded | null | →BM25 |
| AI | 135 | false | expanded | null | →BM25 |
| PD | 248 | false | expanded | null | →BM25 |
| RA | 203 | false | expanded | null | →BM25 |

Cause: `MIN_QUERY_LEN=3` (`lib/api/search-taxonomy.ts:72`); `matchQueryToTaxonomy()`:602 and `resolveMeshDescriptor()`:1301 early-return for `normalized.length<3`. No sense resolution is even attempted → no confident-wrong mapping. (The RA #1 surgeon 3/135 outranking rheumatologist Goodman 67/213 is the documented volume/no-concentration issue, not P6.)

**≥3-char acronyms — the real danger (live staging):**

| q | meshMapped | conf | conceptLabel | sense | judgment |
|---|---|---|---|---|---|
| **CAR** | true | entry-term | **Automobiles** | CAR-T meant | **DANGEROUS (confident wrong)** |
| **PET** | true | entry-term | **Pets** | PET imaging meant | **DANGEROUS (label wrong; ranking rescued by method-family)** |
| PCR | true | entry-term | Polymerase Chain Reaction | correct | safe |
| ADHD | true | entry-term | Attention Deficit Disorder w/ Hyperactivity | correct | safe |
| COPD | true | entry-term | Pulmonary Disease, Chronic Obstructive | correct | safe |
| ROS, CAD, EGFR, ALS, EHR, ICU, CNS, AKI, CKD, MRI, ML | false | — | null | unmapped→BM25 | safe |

**Damage, concrete:**
- Concept-narrow scope toggle collapses the wrong-sense queries: **CAR 128→1**, **PET 338→1** (the lone Automobiles-/Pets-tagged scholar) — while correct acronyms broaden: **PCR 161→163**, **COPD 77→141**.
- Wrong-sense INNER boost fires: CAR page-1 has Roger Yurt MD (burn surgeon) "1 of 88 publications **tagged Automobiles**", relevanceScore 340 (~#6), the entry-term ×1.15 MeSH-attribution multiplier injecting a car-accident researcher into the CAR-T list.
- PET default ranking is salvaged (15/20 ev=method PET-imaging radiologists) but the displayed interpretation label is still "Pets".

**Mechanism (ties to ranking math):** `resolveMeshDescriptor()` picks the single MeSH descriptor whose entry term matches the normalized query — `car`→Automobiles, `pet`→Pets. The biomedical sense (Receptors, Chimeric Antigen / Positron-Emission Tomography) has no bare-acronym entry term, so it never competes; with one candidate, `ambiguous=false` → stamped confident (entry-term). That gates the INNER MeSH-attribution boost (entry 1.15) onto the wrong descriptor and feeds the user-facing `conceptLabel` + concept-narrow result-set gate. The 2-char cases are spared only because `MIN_QUERY_LEN=3` short-circuits them first.

**Fix direction:** add a short-acronym guard in `resolveMeshDescriptor` — for ≤4-char (esp. all-caps) queries, suppress *entry-term* resolution against lay-homonym descriptors (Automobiles/Pets) or treat a single short-token entry-term hit as `ambiguous` (fall to expanded BM25) rather than confident, so CAR/PET don't mis-resolve.
