# Search-result snippets — handoff & durable-design brief

**Status:** match-aware People snippet is **live on staging** (flag `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET=on`, prod off). Two real regressions/issues remain, plus a request to replace the accreted ad-hoc snippet logic with one coherent model. This doc hands that work off.

**Scope:** the per-result "snippet / why-this-matched" line under each result on `/search` (People tab today; Publications/Funding tabs share the same `MatchReason` component). Ranking is **out of scope** (that's `methodFamily`/#824 §4c, already live).

---

## 1. What shipped this round

| PR | What | State |
|----|------|-------|
| #1047 (`43150179`) | Match-aware "why" line: rust **Method** badge (family + ≤3 exemplar tools), blue **Topic** badge, humanized-areas fallback | merged, staging-live |
| #1048 (`4867cae2`) | flag `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET` staging-on/prod-off | merged + `cdk deploy` (td `sps-app-staging:57`) |
| #1051 (`23f12c70`) | **fix**: stop highlighting `areasOfInterest` when the flag is on, so the humanized fallback actually renders (raw slug dump was winning) | merged, staging-live |

- **Mockup (visual contract):** `docs/mockups/search-snippet/match-aware-snippet.html` (toggle Today ↔ Proposed).
- **Verified live** on `scholars-staging…/search?q=single-cell RNA sequencing`: method badges + bio sentences + humanized areas, no raw slug dumps.
- **App-only, no reindex** — derives from `scholar_family` + the topic taxonomy at query time.

---

## 2. The snippet system *today* (the problem)

The per-row line is chosen by a **layered priority chain** that has accreted across ~7 issues. There is no single model — each issue bolted on a new `PeopleHit` field + a new branch in the card.

**Render priority** (`components/search/people-result-card.tsx`, ~L164–212):

| # | Source | Field on `PeopleHit` | Produced by | Origin |
|---|--------|----------------------|-------------|--------|
| 1 | **Method** badge | `matchReason: {kind:"method", family, tools}` | `searchPeople` batched `scholar_family` derive (overlay-gated) | #824 |
| 2 | **Topic** badge | `matchReason: {kind:"topic", label}` | matched topic slug ∈ `areasOfInterest` | #824 |
| 3 | Legacy reason | `matchReason: {icon, text}` / `{pub}` | `reasonCounts` pub agg / representative-pub `top_hits` | #310, #688, #967 |
| 4 | Bio highlight | `highlight[0]` | OpenSearch highlight of `overview` (and, flag-off, `areasOfInterest`) | #20, #259 |
| 5 | Humanized areas | `humanizedAreas: {labels, matchedIndex}` | `buildHumanizedAreas` (Topic slug→label map) | #824 |

Key files:
- `lib/api/search.ts` — `searchPeople` (the per-hit `resolveHitMatchReason`, the highlight request, `buildHumanizedAreas`, `cleanExemplarTools`).
- `lib/api/search-taxonomy.ts` — `matchQueryToTaxonomy` → `methodMatches`/`areas`; `buildMatchAwareContext`.
- `lib/api/methods-overlay.ts` — `loadFamilyOverlayGate({forceSensitive})` (public-surface gate).
- `components/search/match-reason.tsx` — renders kinds `method`/`topic` (badges) + legacy `concept`/`publications`/`area`.
- `components/search/people-result-card.tsx` — the priority chain above.

**Why this is fragile:**
- Five sources, three different data paths (Aurora derive, OpenSearch agg, OpenSearch highlight), one flag toggling a subset.
- Adding a sixth surface means another `PeopleHit` field + another card branch + another flag interaction. The #1051 bug (raw highlight silently outranking the humanized fallback) is exactly the failure mode this invites.
- People/Publications/Funding nominally "share" `MatchReason` but the People tab has diverged the most; there is no shared contract for *what* a snippet is.

---

## 3. Known issues to resolve

### 3a. REGRESSION — humanized areas dumps the full topic list
`buildHumanizedAreas` (`lib/api/search.ts`) returns **every** topic label with **no cap**:
```ts
const labels = slugs.map((s) => labelBySlug.get(s) ?? humanizeAreaSlug(s)); // all of them
```
On staging, Elemento/Suhre/etc. render ~10 areas wrapping several lines. The *old* behavior showed an OpenSearch **highlight fragment** (bounded ~100 chars). So we traded an ugly-but-bounded fragment for a clean-but-unbounded dump — a net regression in density.
- `areasOfInterest` is already **score-ordered** (`buildPeopleDoc` selects `topicAssignments orderBy score desc`), so the cap is just "top-N by score, + N more".
- **The cap fix itself:** cap to **N=4** labels, append "+N more". **NOT "matched-area first"** — `matchedIndex` is `-1` here *by construction* (a matched area would have been promoted to a topic badge before reaching this fallback; verified — see §6 Case E / §5.0). Score-desc, `·` separator (labels contain commas). Small change in `buildHumanizedAreas` + the card's `HumanizedAreas` render.
- **DECISION (2026-06-16):** *hold* the standalone cap fix and fold it into the §4 redesign rather than shipping a separate fast-follow. Rationale: the cap value and ordering are entangled with the open §5 question of whether self-reported areas should be a snippet at all (a yes/no that may delete this line entirely) — fixing the legacy branch now risks doing the work twice. **Accepted tradeoff:** the unbounded areas dump stays live on the staging soak until the redesign lands. The well-liked Method badges are unaffected.
- **Open question:** should self-reported areas be a *snippet* at all, or only a last-resort? See §4 / §5.

### 3b. Cosmetic items (observed on live staging — confirm desired form before changing)
- Tool separator renders tight: `·single-cell transcriptomics` should be `· single-cell transcriptomics` (space after the middot), or use a styled separator.
- Method tool list + humanized-areas list both want a consistent max-width / truncation treatment so rows stay 1–2 lines.
- ~~Matched-area emphasis~~ — **struck: structurally dead.** `matchedIndex` is `-1` in the areas fallback *by construction* (verified — §6 Case E / §5.0), so there is never a matched area to bold or float here. Don't build or test it on the areas line.
- Badge label wording / icon: currently "Method" (FlaskConical) / "Topic" (Tag). Confirm copy + glyph against the mockup.
- *(These are deliberately listed as open, not pre-decided — per the UI-change rule, confirm exact spacing/sizing/wording before editing.)*

### 3c. Architectural debt — see §4.

---

## 4. Proposed durable, coherent approach

Replace the layered chain with **one snippet abstraction** selected by **one documented precedence function**, server-side, with a **bounded representative payload**, rendered by **one component**, shared across tabs.

**Design principles:**
1. **One typed "evidence" object per result.** `ResultEvidence = { kind, payload }` where `kind ∈ {name, method, topic, publications (strength: tagged|mention), selfDescription, affiliation, areas|none}`. The server selects exactly one (or a small ranked set) per result — the card never re-derives priority. Notes: `concept` is **not** its own kind (text variant of `publications` — §6 Case F); the old generic `highlight` is **split by source field** into `name` (highlight on `preferredName`) and `affiliation` (highlight on `deptName`) so each ranks by its true strength (§5.0C); the `areas` payload **drops `matchedIndex`** (provably always `-1` — §5.0A). **Enumerate Publications/Funding kinds now as stubs** (§5#3): e.g. Funding `co-investigator`, `award-amount`.
2. **Strongest-evidence-for-this-query precedence**, defined once and tested:
   `name` → `method` → `topic` → `publications:tagged` (+`concept` text variant) → `selfDescription` (bio) → `publications:mention` → `affiliation` → `areas` / honest-empty (§5#1).
   Two tiers split out of round-1's flat order, each to fix a strong/weak bimodality (§5.0C): **name** floats to the top (strongest signal) while **affiliation** sinks near the bottom (weak/organizational); **tagged-pub** sits above `bio` while **mention-pub** sits below it. **Note (§5.0/Case E):** because `topic` outranks `areas` and both consume the same `matchedTopicSlugs`, areas only ever render when nothing matched — so areas is "who is this," never "why this matched." Fixing query→topic *resolution* (not the areas list) is the keystone.
3. **Always bounded / representative, never a dump.** Every payload has an explicit cap (tools ≤3, areas ≤N, one pub, one sentence). "Show everything" is never a snippet.
4. **Cross-tab consistency.** People/Publications/Funding consume the same `ResultEvidence` contract + one renderer; differences are payload kinds, not parallel code paths.
5. **Invariant tests.** Golden test per kind + two guardrails that would have caught #1051: "never render a raw `under_score` slug" and "never render an unbounded list".
6. **One flag → remove the flag.** Ship behind a flag, then once stable, fold it in and delete the legacy branches (the half-on/half-off state is where #1051 hid).

**Migration sketch (incremental, low-risk):**
- Phase 0: ~~standalone §3a cap + §3b cosmetics fast-follow~~ — **deferred 2026-06-16** (see §3a). The §3a cap and §3b cosmetics are now done *inside* Phase 1 as part of the `selectEvidence` `areas` payload, not as a separate patch to the legacy branch. The unbounded dump remains live on staging in the interim.
- Phase 1: **start with the keystone (§5.0A) — get query→topic resolution right** (it gates §3b/§5#2 and sharpens Case B). Then introduce `ResultEvidence` + a single `selectEvidence(hit, context)` in `lib/api/search.ts`; map the current sources into it (`areas` payload lands capped at **N=4, score-desc, no matched-first** — resolving §3a; `cleanExemplarTools` gets the Case A cleaning rule); render via one `<ResultEvidence>` component (absorbing §3b cosmetics). People tab first; stub the Publications/Funding kinds (§5#3).
- Phase 2: extend to Publications/Funding; retire `MatchReason`'s ad-hoc kinds + the parallel `highlight`/`humanizedAreas`/`matchReason` fields on the hit types.
- Phase 3: remove `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET` (fold in), delete dead branches.

---

## 5. Decisions — settle these two first, they reframe the rest

*Each decision is shown on a real row in **§6 Examples** — decide against the concrete rendering, not the abstraction. Most round-1 "open decisions" are now settled on engineering grounds (below); **only §5#1 (areas in/out) and Case C (pub title in/out) genuinely need product.***

**Net genuinely-open items** (everything else here is settled or cosmetic): **(1)** run the fall-through count and **fix its threshold in advance** (§5#1); **(2)** the **name-vs-affiliation precedence split** + type `affiliation` as its own weak kind (§5.0C) — and the parallel **tagged → bio → mention** reorder; **(3)** **confirm Case H's supercategory path actually occurs** before building the derive (§5#5 — probe says it doesn't, yet).

### 5.0 — Keystone (do before the case-by-case calls; it gates them)

**A. Fix topic-match resolution — it's the highest-leverage single change, and the `matchedIndex:-1` finding is the tell.** `matchedIndex` is `-1` on every live areas row **by construction** (verified: `buildHumanizedAreas` reads the same `matchedTopicSlugs` as the topic-badge path, and topic outranks areas — so a matched area is always promoted to a Case B badge before it reaches the fallback; see Case E). The lever isn't "fix the areas list" — there's nothing to fix there. It's that the **same resolution feeds the topic-badge precedence**: if you can't reliably resolve query→topic, you can't tell *matched* from *merely present*, which degrades Case B accuracy. Get resolution right → §3b matched emphasis and §5#2 ordering become moot (nothing to emphasize in the fallback) and topic selection gets more accurate.
- **Follow-through — delete `matchedIndex` from the areas payload.** Don't carry a field that's provably always `-1` in the only context areas render — a dead `-1` constant is an invitation for a future dev to "fix" it and re-add the matched-first logic the construction already ruled out. Encode the invariant as the **field's absence + a comment**, not as a constant.
- **Caveat — this couples §5#1 to §5#4.** The invariant holds *only* because topic-match and the areas fallback draw from the **same parent-keyed `areasOfInterest`**. The moment §5#4 gives topic-match a subtopic index field while areas stays parent-keyed, the spaces diverge: you could match a subtopic whose *parent* is in `areasOfInterest`, fail the parent-slug ∈ check, fall to areas, and find the parent label sitting in the list — `matchedIndex` becomes meaningful again and E2's simplification breaks. So if you go subtopic-keyed for topic-match, **either re-key areas to match, or knowingly reintroduce matched-area logic.** These are not independent decisions; they share this seam.

**B. The areas fallback is masking a "we don't know why this matched" gap, not adding value.** Because areas only render when *nothing* matched, areas-in-the-match-slot answers "who is this person broadly" in a slot reserved for "why did this hit my query." So §5#1 is really: *when areas is the only thing firing, did `selectEvidence` fail to surface a real pub/bio reason that's being out-prioritized?* **That's measurable** (see §5#1 gate) and it decides §5#1 — not which mock looks cleaner. **The construction claim (A) does *not* retire this count — they answer different questions:** A says "can a matched area ever be bolded" (no); the count says "how often is the match line blank under E2." Orthogonal. The proof's elegance can manufacture false confidence in E2 — you still need the number.

**C. Audit every precedence tier for hidden strength-bimodality — this is the generalizing pattern, not an areas quirk.** The §5#1 reframe ("areas was one tier hiding a strong case and a noise case") repeats in two more tiers, and the new staging data exposes both:
- **`highlight` conflates name-match (strongest signal in the system) with affiliation-match (weak, often spurious).** Case G's "Brain Health Imaging Institute" matching `imaging` is *organizational*, not semantic — that person may do no imaging research — yet an exact name hit ("searched van Herten, got van Herten") is the single strongest reason there is. Burying both in one second-to-last "highlight" tier is the areas mistake again. **Split them:** `name` near the *top* of precedence; `affiliation` near the *bottom* (above empty, below all content evidence) — and **type `affiliation` as its own kind** so its weakness is legible, not masquerading as a generic highlight.
- **`publications` conflates tagged (strong) with mention (weak).** C′'s "1 of 133 mention" must not outrank a good bio sentence, yet the flat `publications` tier sits above `bio`. **Order: tagged-pub → bio → mention-pub**, not `(tagged|mention) → bio`. (Same point as C′'s min-count threshold, expressed as precedence.)
- **One pass over the whole list** asking "does this tier contain a strong and a weak case that deserve different ranks." Done for areas; now name/affiliation and tagged/mention.

### The decisions

1. **§5#1 — areas in/out of the match slot? (PRODUCT, gated on a measurement.)** It's a **three-way**, not E1-vs-E2: (E1) bounded areas as a match reason; (E2-lean ✅) **empty match line + a separate, clearly-labeled "Areas" affordance** *not* styled as a match reason — separating "why this matched" from "who is this" (People search legitimately needs both); or fabricated-why (status quo). **Ship gate = the fall-through count:** run today's areas-only rows through the proposed precedence and count how many land on *empty* vs surface a real pub/bio/affiliation reason. **Set the threshold before you look** — e.g. **>15–20% blank ⇒ a retrieval-explanation gap to close before E2 ships** (a fifth of People rows with an empty "why" is worse than today's ugly dump). The construction proof (§5.0A) removed E1's *rationale*, but **not** this gate — they're orthogonal. *Preliminary signal (biased sample, not the gate): across 8 broad taxonomy-aligned queries the topic tier caught most rows (genomics 19/20, microscopy 11/20) so fall-through looked ~0% — but those queries map cleanly to topics; the real number needs off-topic/eponym/niche queries and the **new** precedence.*
2. **§5#2 — areas cap = N=4** (✅ settled). Not 5/6: labels run ~40 chars with internal commas, so more guarantees a 2-line wrap and defeats density. **Score-desc, `·` separator, no "matched-first"** (structurally impossible — §5.0/Case E).
3. **§5#3 — People-first to *ship*, all-three to *design the type*** (✅ settled). Validate the contract on the most-diverged surface, but **enumerate Publications/Funding payload kinds now, even as stubs** (e.g. Funding: co-investigator, award amount — kinds People doesn't have), so Phase 1 doesn't freeze a People-shaped `ResultEvidence` that Phase 2 must break. "Differences are payload kinds, not parallel paths" only holds if the other tabs' kinds are listed before freezing.
4. **§5#4 — keep parent label v1, but probe a cheaper win first** (PROBE). Before committing to "needs a new index field": check whether `matchQueryToTaxonomy` **already knows which subtopic matched** — if so, echo it as a *payload* field (no reindex). Instrument how often subtopic queries land on a topic badge; build the index field only if that's common. **⚠ Shares a seam with §5#1** (§5.0A caveat): going subtopic-keyed for topic-match while areas stays parent-keyed reintroduces a meaningful `matchedIndex` and breaks E2's simplification — re-key areas in the same change or decide it knowingly.
5. **§5#5 — defer the supercategory derive until a live case forces it (apply the Case F bar).** **Probe result (2026-06-16):** across 8 broad/method-supercategory terms (microscopy, sequencing, genomics, proteomics, spectroscopy, machine learning, cardiology, imaging) **none reach the areas fallback as a family-spanning supercategory** — they resolve to a *topic badge*, tagged-pubs, or a method; "imaging" is the 2-person affiliation match (Case G). So there is **no confirmed query** that hits this path. We refused to reserve a `kind` for `concept`/F on the same grounds — and the derive is a *bigger* build than a reserved kind with *less* evidence of firing. The derive is still the right answer **if** the case is real; **first produce a real supercategory-reaches-areas query.** If you can't, H is design intent for a path that may not exist — defer.

---

## 6. Examples — every case, with real staging data

> **Provenance.** Every row below is **real data**, labelled by source:
> **`[LIVE]`** = captured from the `scholars-staging.weill.cornell.edu` RSC payload on **2026-06-16** (the `matchReason` / `humanizedAreas` objects are quoted verbatim from the wire); **`[MOCKUP]`** = the attested-real values in `match-aware-snippet.html` (footer: "names/families/tools are real staging data; bio + tool lists abbreviated for layout"); **`[CODE-SHAPE]`** = the exact object shape from `buildMatchReason` in `lib/api/search.ts`, with a note that it was **not observed** in this sweep (no counts invented). Renderings are shown as ASCII; `[Method]`/`[Topic]` are the rust/blue badges.
>
> "**Options**" under each case = the §5 open decisions made concrete on that real row, so they can be decided against something you can see rather than in the abstract.

**Visual companion:** `docs/mockups/search-snippet/snippet-cases.html` — one rendered mockup per case below (real data, the established WCM tokens, Lucide badge icons), showing Today vs the proposed treatment(s)/options.

**Precedence reminder** (`selectEvidence`, strongest-first): `name` → `method` → `topic` → `publications:tagged` (+`concept` text variant — Case F) → `selfDescription` (bio) → `publications:mention` → `affiliation` → `areas`/empty (Case E/G). *Two tiers split out for strong/weak bimodality (§5.0C): name↑ vs affiliation↓, tagged↑ vs mention↓. And because `topic` outranks `areas` (same `matchedTopicSlugs`), a matched area is always promoted to a topic badge — Case E.*

---

### Case A — `method` (strongest signal)  ·  query: *single-cell RNA sequencing*  `[LIVE]` + `[MOCKUP]`

Two real hits, same family, different exemplar tools (verbatim from the wire):

```
matchReason = {kind:"method", family:"Single-cell RNA sequencing",
  tools:["Single-cell RNA sequencing (scRNA-seq)","single-cell transcriptomics",
         "10x single-cell transcriptome analysis"]}                       // Olivier Elemento, PhD — 538 pubs / 132 grants
matchReason = {kind:"method", family:"Single-cell RNA sequencing",
  tools:["single-cell RNA isoform analysis","single-nuclei RNA sequencing",
         "single-nuclei isoform RNA sequencing (SnISOr-Seq)"]}             // 2nd hit — long tool names
```

| | render |
|---|---|
| **Today** | `pulmonary_critical_care gi_cancer single_cell_spatial_biology cell_molecular_biology lung_cancer …` (raw slug dump) |
| **Live now** (flag on — what actually ships) | `[Method] `**`Single-cell RNA sequencing`**` · Single-cell RNA sequencing (scRNA-seq) · single-cell transcriptomics · 10x single-cell transcriptome analysis` |
| **Target** (needs the new cleaning rule below) | `[Method] `**`Single-cell RNA sequencing`**` · scRNA-seq · single-cell transcriptomics · 10x` |

- **Confirmed (read `cleanExemplarTools` on `origin/master:lib/api/search.ts:374`):** it is **dedupe (case-insensitive) + cap-to-3 only** — no name-cleaning, no paren handling, no lead-vs-tool dedupe. So the long verbatim strings in "Live now" **are** what renders today; the mockup's "scRNA-seq · 10x" was hand-curated, **not** code output. The cleaning is therefore **net-new work, not half-built.**
- `selectEvidence` → **method**. The rule to add to `cleanExemplarTools` (reproduces the mockup's density *algorithmically*, no hand-maintained alias map across ~942 families):
  1. **Dedupe the lead family against `tool[0]`** — kills "Single-cell RNA sequencing" / "…(scRNA-seq)".
  2. **Prefer the parenthetical** when present — "…(SnISOr-Seq)" → `SnISOr-Seq` (the paren is usually the canonical short form).
  3. **Prefer a leading distinctive platform token** (`10x`, `Visium`, `Slide-seq`, `Smart-seq`, …) when present — "10x single-cell transcriptome analysis" → `10x`. *Without this clause, clause 4 alone yields "10x single-cell transcriptome", **not** the "10x" the mockup shows — the rule would under-deliver the target and ship looking inconsistent.*
  4. Otherwise **strip parens + cap ~3–4 words.**
- Plus the §3b cosmetics this exposes: space-after-middot (`· scRNA-seq`, not `·scRNA-seq`) and a max-width/ellipsis so long tools keep the row to 1–2 lines.

### Case B — `topic` (curated area match, no method family for this scholar)  ·  query: *single-cell RNA sequencing*  `[MOCKUP]`

```
matchReason = {kind:"topic", label:"Single-cell & spatial biology"}        // Dan A. Landau, MD, PhD — 103 pubs / 63 grants
```

| | render |
|---|---|
| **Today** | `single_cell_spatial_biology neuro_oncology hematology stem_cell_regenerative_medicine …` (slug dump, `single_cell` bolded mid-word) |
| **Proposed** | `[Topic] `**`Single-cell & spatial biology`** |

- `selectEvidence` → **topic**. **Option (§5#4 — subtopic granularity):** the label here is the *parent* topic. For a subtopic query (e.g. "spatial transcriptomics") this same row would still read "Single-cell & spatial biology" because `areasOfInterest` is keyed on parent-topic ids. Keep the parent label (no index change), **or** add a subtopic-specific label (new index field). Recommend keep-parent for v1.

### Case C — `representativePub` / `publications` (publication-count evidence, #967)  ·  query: *melanoma*  `[LIVE]`

The live `matchReason` already carries the representative pub (#967's `top_hits`), verbatim:

```
{icon:"publications", text:"25 of 373 publications tagged Melanoma",
 pub:{pmid:"25491880", year:2014,
      title:"Melanoma expression of matrix metalloproteinase-23 is associated with
             blunted tumor immunity and poor responses to immunotherapy."}}   // Paul J Christos, DrPH — 373 pubs / 32 grants
{icon:"publications", text:"25 of 690 publications tagged Melanoma",
 pub:{pmid:"40023404", year:2025,
      title:"Evaluation and diagnosis of longitudinal melanonychia: A clinical review
             by a nail expert group."}}                                       // Shari Lipner, MD, PhD — 690 pubs / 2 grants
```

| Option | render (Christos) | hinges on |
|---|---|---|
| **C1 — count only (DEFAULT)** | 📄 `25 of 373 publications tagged Melanoma` | the count *is* the match evidence |
| **C2 — count + representative pub** (#967, current always-on) | 📄 `25 of 373 publications tagged Melanoma`<br>↳ e.g. *"Melanoma expression of matrix metalloproteinase-23…"* (2014) | title answers "which paper," not "why this person" |

- **Decision — C1 default; the representative pub goes on hover/expand, never always-on** (reuse the existing MeSH hover-card pattern). Three reasons: (1) the second line's vertical cost compounds down the whole list — halving results-per-screen is a steep price for a per-row detail; (2) the title answers *which paper*, not *why this person*; (3) `top_hits` picks weak representatives — the two real examples above are a **2014 paper** and a **"nail expert group" review** that don't represent the melanoma work.
- **Pick the exemplar by quantitative signals, not `top_hits[0]`.** The payload already carries them: **`publicationType`** (original research > review — *the 2025 example is literally "A clinical review", so this signal alone downranks it*), **`citationCount`** (impact), **`year`** (recency), author position (**`isFirst`/`isSenior`** — ownership), and the query **`_score`** (relevance). A weighted pick over these *is* the "relevance bar" — and it's the **single best exemplar** the hover should show. **This generalizes:** the same signal-ranked "best exemplar publication" is what Case A's (method) and Case B's (topic) hovers reveal — i.e., extend #967's representative-pub derive from the tagged-pub path to the method/topic match paths, selecting by the same signals. One mechanism, three kinds. **Full prod logic (ranking key, candidate sets, the kind-dependent relevance line, and the verified index reality) = §7.**
- `selectEvidence` → **representativePub** when `tagged > 0`; the `pub` payload is the bounded representative (one pub, never the list).
- **Sibling — `mention`** `[LIVE]` (now confirmed, query *optogenetics*): `{icon:"publications", text:"1 of 133 publications mention "optogenetics""}` (and `1 of 25`, `1 of 193`). The `1 of N` counts make the point: a free-text mention is **much weaker** than a subject tag.
- **Precedence, not just a threshold (§5.0C):** `tagged` and `mention` are a strong/weak bimodality inside one tier. Split the rank — **`tagged` above `bio`, `mention` below `bio`** — so "1 of 133 mention" never outranks a real overview sentence. Raising a min-count and/or visually distinguishing "mention" from "tagged" still applies on top.

### Case D — `selfDescription` (a real sentence from the scholar's overview)  ·  query: *single-cell RNA sequencing*  `[MOCKUP]`

```
highlight[0] = "The Jaffrey lab is interested in identifying <b>RNA</b> regulatory
                pathways that control protein expression"                  // Samie R. Jaffrey, MD, PhD — 193 pubs / 43 grants
```

| | render |
|---|---|
| **Today** | same sentence (bio happens to win because no method/topic reason and the highlight outranks the areas dump) |
| **Proposed** | same sentence, matched term bold, **capped to one matching sentence** (~1 line) |

- `selectEvidence` → **selfDescription** when there's a genuine overview highlight and no stronger signal. **Decision — first-matching-sentence (agreed); the substance is the implementation:** OpenSearch returns char-bounded *fragments*, not sentences, which is why "Today" cuts mid-word. Request a larger `fragment_size`, then trim to the first sentence containing the `<b>` match, with a hard max-length guard for run-ons. Keep the matched term bold.

### Case E — `areas` (humanized fallback) — **the decision case** (§5#1/#2)  ·  query: *single-cell RNA sequencing*  `[LIVE]`

Live `humanizedAreas`, **uncapped — 10 labels, `matchedIndex: -1`** (verbatim):

```
// Karsten Suhre, PhD — 319 pubs / 10 grants
{labels:["Metabolic & Endocrine Disease","Mental Health & Psychiatry","Single-Cell & Spatial Biology",
  "Genetics, Genomics & Precision Medicine","Transplantation Medicine","Neurodegenerative Disease",
  "Nephrology & Renal Disease","Cell & Molecular Biology","Systems Biology","Pulmonary & Critical Care Medicine"],
 matchedIndex:-1}
// Olivier Elemento, PhD (when shown as areas rather than the method badge) — also 10 labels, matchedIndex:-1
{labels:["Pulmonary & Critical Care Medicine","Gastrointestinal Cancer","Single-Cell & Spatial Biology",
  "Cell & Molecular Biology","Lung Cancer","Women's Health & Reproductive Medicine","Gynecologic Oncology",
  "Genetics, Genomics & Precision Medicine","Immunology & Inflammation","Pathology & Laboratory Medicine"],
 matchedIndex:-1}
```

| Option | render (Suhre) | notes |
|---|---|---|
| **E0 — current live (§3a regression)** | `Metabolic & Endocrine Disease, Mental Health & Psychiatry, Single-Cell & Spatial Biology, Genetics, Genomics & Precision Medicine, Transplantation Medicine, Neurodegenerative Disease, Nephrology & Renal Disease, Cell & Molecular Biology, Systems Biology, Pulmonary & Critical Care Medicine` | all 10, wraps ~2 lines, **no emphasis** |
| **E1 — cap N=4, score-desc, `·` sep** (in the match slot) | `Metabolic & Endocrine Disease · Mental Health & Psychiatry · Single-Cell & Spatial Biology · Genetics, Genomics & Precision Medicine `**`+6 more`** | N=4 (not 5/6 — labels run ~40 chars, more guarantees a 2-line wrap); **no "matched-first"** — see below |
| **E2 — empty match line + separate "Areas" affordance** | match slot: *(empty)* &nbsp;·&nbsp; below it, visually distinct: `Areas: Metabolic & Endocrine Disease · Mental Health & Psychiatry · …` | separates "why this matched" (empty — honest) from "who is this" (labeled, *not* styled as a match reason) |

- **VERIFIED, and it's the keystone (not a "bonus finding"):** `matchedIndex` is **`-1` by construction** in this slot, not by bug. `buildHumanizedAreas` is fed the **same** `matchedTopicSlugs` that the topic-badge path uses (`origin/master:lib/api/search.ts` — `resolveHitMatchReason` L2142 vs the `buildHumanizedAreas` call L2203), and **topic outranks areas**. So if a scholar's area had matched the query, they'd render a **topic badge (Case B)** — they'd never reach the areas fallback with a matched area. Areas only render when *nothing* matched ⇒ there is no matched area to bold or float, **ever**. Therefore:
  - "Matched-area bold" (§3b) and "float matched-first" (§3a/old-E1) are **structurally impossible here**, not dead-pending-a-fix. **Drop them.** E1 is plain score-desc, N=4.
  - This **proves** the deeper point: in the match slot, areas is **always** "who is this person broadly," **never** "why this hit my query" (Suhre's "Single-Cell & Spatial Biology" sits at index 2, *unmatched*, for a "single-cell RNA sequencing" query). The real keystone is **topic-resolution accuracy in the Case B path** — the same `matchedTopicSlugs` feeds it, so improving it promotes genuinely-matching topics to badges and shrinks this fallback.
  - **Encode the invariant by deleting `matchedIndex` from the redesigned `areas` payload** (§5.0A) — keep the wire shape above only as the *legacy* record; carrying a constant `-1` invites a future "fix" that re-adds the ruled-out matched-first logic. *(Couples to §5#4 — if topic-match goes subtopic-keyed while areas stays parent-keyed, `matchedIndex` becomes meaningful again; §5.0A caveat.)*
- **§5#1 is a three-way, and the ship gate is a measurement — orthogonal to the construction proof.** The proof above answers "can a matched area be bolded" (no); it says **nothing** about "how often is the match line blank under E2." Don't let the proof's elegance manufacture confidence in E2. Take the current **areas-only rows**, run them through the proposed precedence, **count how many fall through to empty** vs surface a real pub/bio/affiliation reason — and **fix the threshold before looking** (e.g. **>15–20% blank ⇒ close the retrieval-explanation gap before E2 ships**; a fifth of rows with an empty "why" is worse than today's dump). Lean **E2** ("honest-empty + a separate identity hint" vs "fabricated why"), gated on that number.

### Case F — `concept` (MeSH-expansion fallback)  ·  `[CODE-SHAPE]` — **not observed live**

```
{icon:"concept", text:"via related concept <parentTerm>"}                  // shape from buildMatchReason()
```

- **Real finding:** this branch did **not fire** across a 6-query sweep (CRISPR, immunotherapy, tau protein, obesity, sepsis, machine learning). It only triggers when a query MeSH-expands to a parent term *with* provenance but the scholar has **zero** tagged/mention pubs — rare.
- **Decision — don't reserve a `kind` for a path that didn't fire in six queries; fold it into `publications` as a text variant** (same icon family). **Keep the capability** (render "via related concept X" if it ever fires) but **lose the dedicated branch + golden test.** Revisit only if telemetry shows it firing — and given the MeSH concept-expansion investment it might, so don't delete the capability outright.

> **Correction (my earlier claim was wrong).** I previously reported that *imaging* "returned no server-rendered payload" and flagged a possible client-side-streaming blind spot. **Both were a grep artifact** — the RSC stream escapes quotes (`\"matchReason\"`), and my probe grepped for unescaped quotes, so it counted 0 on *every* query (melanoma included, which I'd already parsed 20 results from). **Re-checked escaping-agnostically: there is no streaming blind-spot — every query, imaging included, server-renders its People results. The whole §6 sweep is valid.**

### Edge G — `name` (strong) vs `affiliation` (weak) — the bimodality in `highlight`  ·  query: *imaging*  `[LIVE]`

*imaging* matches **only 2 people** (`total: 2`), and both are **affiliation** matches — the `- … Imaging …` suffix is the embedded org unit, not the person's name:

```
preferredName:"Roel van Herten - AI In Medical Imaging, PhD"   matchReason: $undefined
  highlight:["Roel van Herten - AI In Medical <mark>Imaging</mark>"]          // affiliation match (weak)
preferredName:"Tom Maloney - Brain Health Imaging Institute, PhD"  matchReason: $undefined
  highlight:["Tom Maloney - Brain Health <mark>Imaging</mark> Institute"]     // affiliation match (weak)
```

- These are **organizational, not semantic** — a member of "Brain Health Imaging Institute" may do no imaging research. This is exactly why **`affiliation` must rank low** (§5.0C), just above areas/empty.
- Its strong counterpart is a true **`name`** match (query a surname → highlight on `preferredName` itself, e.g. *van Herten* → **van Herten**) — the single strongest signal in the system, which must rank at the **top**. Round-1's flat `highlight` tier buried both together; split them into two kinds.
- A **truly empty** line (no reason, no highlight, no areas) was **not observed** — it requires a scholar matched by something with nothing renderable, which is rare. Under §5#1's E2 that residual is the blank match line + (optional) separate Areas affordance.

### Edge H — broad supercategory query (§5#5)  ·  `[no live example — design intent only]`

- **Probe result (2026-06-16) — the path does not reproduce.** Across 8 broad/method-supercategory terms (microscopy, sequencing, genomics, proteomics, spectroscopy, machine learning, cardiology, imaging) **none reach the areas fallback as a family-spanning supercategory** — they resolve to a **topic badge** (genomics 19/20, microscopy 11/20), tagged-pubs, or a method; "imaging" is the 2-person affiliation match (Edge G). So there is **no confirmed query** that hits this path.
- **Decision — defer the derive (apply the Case F bar).** We refused to reserve a `kind` for `concept`/F because it didn't fire in six queries; the best-family-under-supercategory derive is a *bigger* build with *less* evidence of firing. It's still the right answer **if** the case is real — likely a **filter on the existing #824 family derive** (restrict families to those rolling up under the matched supercategory, top by score), not a new path. But **first produce a real supercategory-reaches-areas query.** If you can't, H is design intent for a path that may not exist — defer until a live case forces it. (Entangled with §5#1: the areas-as-supercategory fallback dies the moment areas are demoted.)

### Summary — case → kind → render → decision it hinges on

Precedence (strongest→weakest): **`name` → `method` → `topic` → `pub:tagged` → `bio` → `pub:mention` → `affiliation` → `areas`/empty.**

| Case | Evidence kind | Rank | Settled render | Still open? |
|------|---------------|------|----------------|-------------|
| G(name) | `name` | **1 (top)** | name highlight | split out (§5.0C) — eng |
| A | `method` | 2 | badge + family + ≤3 tools, **new cleaning rule** (4 clauses) | engineering only |
| B | `topic` | 3 | badge + parent label (v1) | §5#4 — cheap subtopic echo? (probe) |
| C | `publications:tagged` | 4 | **count only**; pub on hover | **product call** — pub title in/out |
| D | `selfDescription` | 5 | 1 matched bio sentence (`fragment_size`+trim) | engineering only |
| C′ | `publications:mention` | 6 | count line, **demoted below bio** + raised threshold | engineering only |
| G(affil) | `affiliation` | 7 (low) | affiliation highlight (weak/organizational) | split out (§5.0C) — eng |
| E | `areas` | 8 (last) | **E2** lean: empty match line + separate "Areas" hint; N=4, no matched-first, **drop `matchedIndex`** | **product call** — gated on fall-through count |
| F | `concept` | — | text variant of `publications`; keep capability, drop kind | engineering only |
| H | supercategory | — | derive best-family-under-supercategory **— deferred** (no live case) | confirm the path exists first |

---

## 7. Hover exemplar selection — implementation spec (for the next session)

The hover (C2/A2/B2 in §6) reveals **one** publication — the scholar's most representative paper for the matched thing. This is the prod logic for *which* pub. It is **C1-default**: count/badge inline, the exemplar on hover/expand, **never always-on** (§5#1 / Case C).

**One function, three callers.** `selectExemplarPub(scholar, query, candidateSet)` feeds the `method` (#2), `topic` (#3), and `publications:tagged`/`mention` (#4/#6) hovers identically. This is the extension of #967's representative-pub derive — today it fires **only** on the tagged-pub path — to the method and topic paths.

**The candidate set (= the `#` behind the count):**
- `publications:tagged` → the scholar's pubs carrying the matched MeSH subject (the `reasonCounts` distinct-pmid set; the *N* in "*N* of *M* tagged X").
- `publications:mention` → the scholar's pubs whose title/abstract mention the query, untagged.
- `method` → the scholar's pubs on the matched family (family/tool membership).
- `topic` → the scholar's pubs whose `reciterParentTopicId` includes the matched parent topic (membership filter).

Rank the set and show **top 1** (bounded top-3 only if a list is ever wanted). **Never render the whole set.**

**Ranking key — `argmax`, lexicographic** (each line breaks ties of the line above):

```
1. isOriginalResearch   true ▸ false   HARD GATE — publicationType ∉ {Review, Comment, Editorial, Letter, Preprint}
                                        (this is what stops the "nail expert group review" / bioRxiv preprint winning)
2. isFirstOrSenior      true ▸ false   wcmAuthors[].isFirst || .isSenior (ownership, not middle-of-200 author)
3. impact               higher         impactScore (doc-level, indexed) and/or citationsPerYear =
                                        citationCount / max(1, thisYear − pubYear + 1)   (age-normalized)
4. year                 newer          recency tiebreak
5. matchRelevance       KIND-DEPENDENT (see below) — NOT a blanket _score
```

**Line 5 is kind-dependent — this is the subtle part:**
- `mention` → OpenSearch **`_score`**. The **only** place raw `_score` belongs (the match really is "query string appears in the text").
- `tagged` → MeSH **major-topic** flag (major ▸ minor) — *[VERIFY indexed]*.
- `method` / `topic` → **omit.** There is **no per-(sub)topic relevance signal in the index** (see below). Rank on lines 1–4 only.

**The #967 fix this encodes:** today the hover pub is `top_hits` sorted by **`_score` alone** → the most *lexically* relevant pub wins → that surfaced Lipner's *clinical review* for "melanoma". Re-rank the candidate `top_hits` by lines 1–4 (+ line 5 only for `mention`) and take top 1.

**Index reality — VERIFIED 2026-06-16 in `lib/search-index-docs.ts` (do not re-assume):**
- `reciterParentTopicId` (`buildReciterParentTopicIdField`, L168) = parent-topic **membership** only (deduped IDs). No weight.
- `buildPubImpactFields` (L202) → doc-level **`impactScore`** (`Publication.impactScore`) + `topicImpacts[]` which is **uniform** — every per-topic value equals the global (L184–185).
- The per-pub-per-topic score (`publication_topic.impact_score`) was **dropped** (L183) — it was redundant with the global.
- The pub doc selects **only `parentTopicId`** (L286) — **no subtopic** reaches the search doc.
- ⇒ The index has topic **membership** + a **global** impact, but **no per-pub per-(sub)topic relevance** to rank by. That's why line 5 is omitted for `method`/`topic`.

**Subtopic-specific exemplars (§5#4) — gated, NOT free:** before promising them, answer the upstream question — **does ReciterAI emit a per-pub-per-subtopic relevance weight, or only membership?** The "uniform" history above is a yellow flag that it may be membership-only. If so, re-adding a per-(sub)topic score buys nothing. Either way this is real ETL + index work (carry subtopic + a weight on the pub doc), not a config change.

**Verify before/while implementing:**
- `publicationType` values actually present, to build the original-research vs review/preprint gate.
- `wcmAuthors` carries `isFirst`/`isSenior` on the pub doc the search reads.
- MeSH major-topic flag availability for the `tagged` tier (line 5).
- `impactScore` semantics (ReciterAI-derived vs citation-derived) — pick the line-3 impact signal accordingly (don't double-count if it's already citation-based).

---

## 8. Rollout / ops state (so the next person isn't surprised)

- Flag `SEARCH_PEOPLE_MATCH_AWARE_SNIPPET`: **staging on** (`cdk/lib/app-stack.ts`, td rev 57), **prod off**. App-only; CD rolls app code, but the flag env needs a manual `cdk deploy --exclusively Sps-App-staging -c env=staging` (no `-c stagingAccount=` — keep it env-agnostic to avoid `${AWS::AccountId}` IAM churn).
- No reindex involved (query-time derive).
- `reciter` shell creds **can** deploy staging; you *can* reach `scholars-staging` from a dev box (no WAF block) — **verify UI changes by rendering the page** (Playwright), not just by infra checks. (Two "live+verified" claims this round were made on infra alone and missed the #1051 render bug.)
- Prod go-live for snippets = flip the flag in app-stack per env + `cdk deploy Sps-App-prod`, *after* the §3a/§3b fixes + a staging soak.

---

## 9. References
- Issues/PRs: #824 (§4c + this follow-up), PRs #1047 / #1048 / #1051.
- Mockups: `docs/mockups/search-snippet/match-aware-snippet.html` (+ `.png`, the original Today↔Proposed toggle) and `docs/mockups/search-snippet/snippet-cases.html` (per-case gallery, §6).
- Code: `lib/api/search.ts`, `lib/api/search-taxonomy.ts`, `lib/api/methods-overlay.ts`, `components/search/{match-reason,people-result-card}.tsx`.
- Tests: `tests/unit/search-people-match-aware-snippet.test.ts`, `tests/unit/people-result-card-match-aware.test.tsx`.
- Related accretion (context for §2): #20, #259, #310, #688, #702, #707, #967.
