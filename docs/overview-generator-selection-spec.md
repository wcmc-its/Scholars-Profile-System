# Overview Generator — content selection & grounding spec

Status: **Approved 2026-06-18.** Defines how the AI overview generator selects feedstock, exposes control, handles numbers, and grounds method claims. Surface/UI behaviour is specified at the rule level; visual detail lives in the mocks (`docs/mockups/overview-generator/source_drawer_three_state_selection.html`). Implementation is tracked separately: the §4 prose/numbers grounding rules ship in PR #1132; the §2/§3 three-state source-drawer selection model is the remaining build.

---

## 0. Stance

Four principles, in priority order:

1. **Default hard, edit easy.** A good archetype-seeded default plus cheap correction beats any config form.
2. **Reactive beats proactive.** People judge a concrete draft far better than an abstract setting. Push decisions past the first draft.
3. **Selection beats configuration.** Where input is wanted, let people pick among concrete records, not set dials.
4. **Archetype-seeds the defaults**, so the one-button path is already good for a basic scientist, a clinician, and a policy/admin leader without anyone touching a control.

The shape this produces: **one button → a draft → control on the draft.**

---

## 1. Surfaces & flow

### 1.1 Entry (pre-generation) — minimal

- One primary action: **Generate overview.**
- Voice / tone / length collapse into three **pre-filled, tappable chips** (archetype-seeded). Visible, one tap to change, never required.
- **No "include & emphasize" multiselect** at entry — it forced blind choices and duplicated the source drawer. It becomes *Re-lead*, post-draft.
- **No pre-generation source accounting.** Sources are auto-selected; editing happens after the draft.
- Reassurance: nothing is saved until the user accepts.

### 1.2 Draft (post-generation) — where control lives

**Direct editing over regeneration.** The draft is editable. Anything the user can change by hand — emphasis, sentence order, a word — they edit directly; no regeneration. Regeneration is reserved for changes that genuinely need the model. **Re-lead is not included:** re-running the whole model to reorder sentences a cursor can drag is a waste of tokens for something the user does faster by editing.

- The draft, directly editable.
- **Provenance chips** (tappable): length, source summary (opens the drawer).
- **Length** toggle (shorter / longer) — a structural change, so a regeneration.
- **Try another** — a different take, same settings. Kept because a genuinely different draft is not something the user can produce by editing.
- **Accept / Edit / Discard.**
- **`existingBio` loop:** an accepted/edited overview is saved and **anchors the next run** — generation starts from the user's wording, not a blank slate.

---

## 2. Selection model

### 2.1 Two axes

There are not five per-type axes. There are two, and each content type expresses the first in its own vocabulary:

1. **Centrality** — work you *drove* vs work you were *part of*.
2. **Recency** — when.

The default on both is one sentence: **led work that is either recent or landmark, across your topics.** That sentence *is* the **Recommended** set ("most representative", internally).

### 2.2 Per-type defaults

| Type | Centrality default | Recency default | Toggle? | Record controls |
|---|---|---|---|---|
| Publications | Senior/first-author weighted | Whole career, recency-weighted; **landmark and recent both eligible** | **Led ⇄ all positions** (default: Led) | exclude; pin; add/pin on tail |
| Funding | PI / contact / multi-PI only | Active + recently completed; old grants fade | **Led ⇄ all roles** (default: Led) | exclude; pin; add/pin on tail |
| Titles & positions | Significant only — primary title, endowed/named chairs, chair / director / president / editor roles; routine + secondary tail dropped | Current always; notable past kept; secondary / interim / end-dated tail dropped | none | exclude; add/pin on tail |
| Methods & tools | Signature (recurring or named/built); commodity suppressed | Mild lean to currently used | none | show-more; exclude; pin; add/pin on tail |
| Education | Terminal + professional degrees; minor certs dropped | n/a (historical) | none | exclude; add/pin on tail |

**Record controls, precisely.** Every revealed **Available-tier** record gets **add/pin** — you must be able to act on what you reveal (§3.4). Every **featured** record gets **exclude**. Featured records *also* get **pin-to-protect**, but only for the *volatile* types whose representative set is recomputed run-to-run (publications, funding, methods); the *stable* types (titles & positions, education) keep their featured rows exclude-only because their auto-set doesn't shift between runs. This is what reconciles §2.2 with the §7 ledger (§7's "exclude only" was describing the featured case).

### 2.3 The two toggles — and why only two

Publications-position and funding-role are the **only** surfaced toggles. Rule:

> **Toggle for systematic disagreement; pin for individual exception.**

A biostatistician or core-facility director is *always* a middle author; "led only" returns almost nothing, and pinning ten papers one by one is the wrong tool. One "all positions" tap fixes a *category* miss. Admin / methods / education have no equivalent systematic failure — their edge cases are individual, so pin/exclude covers them and no toggle is warranted.

Default is **Led**. Archetype seeds may flip the default (e.g., a known methods-core scholar starts on "all positions").

### 2.4 Recency

Recency **cuts across applicability but not default value.** Funding wants *recent* (active grants are the story); pubs want *whole career* (stripping landmark work is wrong); education wants *none*.

- It is **never a single global setting applied uniformly.** It is one *intent*, translated per type.
- Translated toward "recent" it means funding is active-only and pubs weight toward the last decade — **but never deletes a landmark paper.**
- It is **a default-setting input only**, with no user-facing control. There is no recency dial and no "recent" re-lean (Re-lead is cut, §1.2). If the user wants a more present-tense overview, they edit the draft.

### 2.5 Three-state records — deltas, not a selection

Every record is in exactly one of three states:

- **default** — in or out per the auto-set.
- **pinned-in** — always featured. The centrality override (the middle-author paper that's secretly central; no ranking surfaces it).
- **excluded** — never used here. A persistent veto.

Rules:

- **Add merges into pin.** Reaching past the default to include something means you meant it — protect it. Clean three-state vocabulary, no "in-but-unprotected" fourth state.
- **Stored as deltas against a live auto-set**, not a snapshot of checked boxes.
- **Deltas persist; the auto-set is recomputed.** On a re-run or toggle change, re-derive the representative set from scratch, then **re-apply pins and excludes on top.** Pins and excludes are **durable deltas — they survive subsequent runs, not just the current session**, stored with the profile.
- **Status line counts divergences, not records.** "Using your recommended set · 1 pinned · 2 hidden" — never "9 of 25" (the user didn't select 9, they accepted a default). Zero deltas reads as "auto."
- **Per-type, not global.** A hidden grant ≠ a hidden paper. Exclude exists on every type, including education and titles & positions.
- **Exclude ≠ delete.** Hiding a record affects only this overview; it stays in Scholars data and the Publications tab. Say so in the UI.
- **Minimum-records guard.** If exclusions drop a type below threshold (e.g., < 3 papers), surface "this leaves N papers; the overview will be brief." Don't silently ship thin or pad.

---

## 3. Disclosure & tiers

### 3.1 Two kinds of hidden information

*"Grounding", used here and below, means feeding the model the actual evidence — the `sample_context` sentence from the paper — so it paraphrases something real instead of guessing.*

Hidden info splits in two. **The user is asked about neither** — the split decides what *governs inclusion*, not who decides it (the system does; see §3.3):

- **Evidence for something already in the bio (grounding).** Rides along automatically with its parent feature — if the method is in, its snippet is in. Exposed as evidence on reveal ("show evidence"), never as raw text in the bio. **Never make a user opt into accuracy.**
- **A new fact (addition).** A mentoring count, a landmark paper. Rides along only if it clears a threshold (§3.3). The system decides; the user removes it by editing if they don't want it.

> Evidence **feeds**; new facts are **decided** — neither is offered.

### 3.2 Two tiers

| Tier | Contents | Default | Exposure |
|---|---|---|---|
| **Feedstock** | Featured pubs/methods, grant basics, education, significant admin, topics, evidence, **+ any additional fact that clears §3.3** | In, silently | Evidence viewable via "why this?" (synopsis; `sample_context` snippet — §6) — a *view*, not a decision |
| **Available** | Long tail, commodity methods, marginal facts, withheld metrics, raw keywords | Hidden | "+ show N more" / expander / search; enters the bio **only if pinned** |

There is no middle "suggested" tier. A signal is either decided *in* (Feedstock) or decided *out* (Available, reachable in the drawer). **Seeing is cheap, pinning is a delta:** opening "8 more methods" persists nothing; only pinning commits.

### 3.3 Additional facts — system-decided inclusion

Beyond the core feedstock, some hidden signals are *additional facts* — a mentoring count, a distinctive subarea. The system decides whether each rides along. **The user is not asked.**

- **Threshold + archetype gate inclusion.** A mentoring count rides along only if it's substantial *and* the archetype warrants it (a senior mentor); a marginal count is omitted, not surfaced. The ranking is archetype-seeded — Crystal → postdocs trained; a methods-builder → a named tool or distinctive subarea; a policy leader → the landmark advisory — the **strongest archetype-relevant fact, not all of them**.
- **Inclusion budget is tiny (≈1).** Even when several additional facts clear the bar, cap how many enter the draft, so the bio doesn't become a stat-dump.
- **No prompt, no opt-in.** If the system includes a fact the scholar doesn't want, they remove it by **editing** (derived facts like a mentoring count, which aren't drawer records) or by **exclude** in the drawer (facts tied to a record). The landmark-paper case is handled upstream by representative selection (§5), not as a prompt.
- **Counts enter as words, never raw numbers** (§4.1) — "two dozen postdocs", not "24".

### 3.4 Findability backstop

Hiding requires findability, or it's burying. Anything decided *out* must still be **reachable** — drawer search and the position toggle are the backstops. Progressive disclosure is only safe with search behind it.

---

## 4. Numbers, scores, weights

### 4.1 Prose rule

> A number's job is to rank, never to render. Numbers are upstream of generation, never in the output.

But "no numbers in prose" splits:

- **Metrics about the work** ("h-index 19", "impact 57", "65 grants") → strip from prose entirely. Field-incomparable, gameable, read as boastful.
- **Counts that are intrinsically the fact** ("trained two dozen postdocs", "leads 3 active NIH trials", "author of 900+ publications") → survive, **in words, rounded.** "Two dozen", not "24".

**The strip test:** remove the number — does the sentence still carry the fact (*keep*: "an experienced mentor of postdoctoral fellows"), or *was* the number the fact (*drop*: "an h-index of 19")? Mentee count is borderline; let it through as prose ("two dozen"), not as "24".

### 4.2 The order-and-tier pipeline

A ranking number does two distinct jobs — keep them separate:

- **Order** — sorts which records are candidates. The model sees the resulting *order*, not necessarily the score. Pure plumbing.
- **Weight** — "this is central, these are minor." Conveys the *gap* that order alone doesn't (#1 and #2 may be neck-and-neck or a chasm). Reaches the model as **coarse tiers — core / supporting / minor — never the raw score.** A model handed a figure reasons about the figure ("with an impact of 57…"); a tier conveys the gap without a leakable number. Same treatment turns h-index into a behind-the-scenes seniority tier.

**Pipeline:** raw scores never leave the backend → they produce an **order** and a **3-tier weight** → the model receives ordered feedstock tagged core/supporting/minor → prose contains no metrics and no editorializing on the tiers.

### 4.3 What the model receives per record

- Feedstock content (title, venue, year, **synopsis**, topicRationale, method family + `sample_context`).
- Its **tier** (core/supporting/minor) — an instruction to the writer, **not** a thing the writer mentions.
- **Not** `impactJustification` (editorial value judgments; the negative ones especially are landmines). Feed the synopsis (grounding, safe) and the tier (weight, safe); withhold the justification.

**Tiers are backend-only.** Do not show core/supporting/minor as user-facing labels — that re-introduces the impact-score gaming problem. The user sees **reasons** + the featured/available structure + order, never the tier or the number.

---

## 5. Sort (publications only)

The sort control governs the **publications** list only. Funding (role + recency) and methods (frequency) have fixed orderings.

- **Recommended** (the *representative* blend) — *set-aware.* Blends impact, recency, and senior-author weight, **spreads across research areas**, and **merges near-duplicates.** Agrees with the featured set by construction. **User-facing label is "Recommended"** — the word *representative* describes the algorithm, not the control; the status line and reset use the same word ("Using your recommended set", "Reset to recommended"). It is deliberately the only editorial-sounding option in the menu (the others are descriptive: most cited / most recent / your role), which marks it as the default to trust. Subtitle carries the *what* so the label isn't a bare quality verdict: "your strongest led work · spread across your areas · landmarks kept regardless of age · duplicates merged."
- **Most cited** — raw citation order. Surfaces landmark work regardless of age/topic — the famous older paper "representative" demotes.
- **Most recent** — by year.
- **Your role** — senior/first-author first.

> **Sort ≠ selection.** Re-sorting reorders the list only. It does not re-pick the featured set and does not drop pins. You sort to *find* a record, pin it, and order stops mattering.

### 5.1 How "Recommended" is computed

Two stages: a per-paper **score** (the order) and a set-level **coverage pass** (the representativeness). The output *is* the featured set — "Recommended" the sort just shows the list in that order.

**Stage 1 — per-paper score.**

```
score = impact_tier × recency_weight(year) × author_position_weight
```

- **`impact_tier`** — the coarse 3-tier weight from §4.2 (core / supporting / minor), never the raw score. The magnitude of the work.
- **`recency_weight(year)`** — a *gentle* decay toward older work, with a **landmark floor**: any paper above a high impact threshold is pinned to weight `1.0` regardless of age, so a 2015 landmark never falls below a 2024 minor paper. Decay is mild because pubs are whole-career (§2.4) — it breaks ties, it doesn't dominate. (Contrast funding, where recency is a hard active-only filter.)
- **`author_position_weight`** — first/last author > middle (work you *drove*). A middle-author paper is admissible but down-weighted; archetype seeds may flip the default to "all positions" for a known methods-core scholar (§2.3).

**Stage 2 — coverage pass** (what makes it *representative* rather than *most cited*). Walk the score-ordered list greedily, building the set:

- **Topic spread.** Apply a diminishing return to a candidate whose research area is already represented in the set so far — so the set spans the scholar's areas instead of stacking the single hottest cluster. Soft, not a hard one-per-area cap: a dominant area can take two.
- **Dedup.** Skip a candidate that is a near-duplicate of one already chosen (same study / program — e.g. the AEGIS-II main + companion papers); one stands in for the cluster.
- **Landmark guarantee.** A landmark (the Stage-1 floor) is never dropped by the coverage pass — it's featured even if its area is already covered.

**Backend-only.** Raw scores and tiers never render (§4.3); the user sees the resulting order + reasons, never the number. The minimum-records guard (§2.5) still applies if exclusions thin a type below threshold.

---

## 6. Methods grounding — `sample_context`

### 6.1 Field selection — project, don't pass the row

The tool-enrichment table carries many columns per tool. Two are named "context":

- **`context`** — per-row model-generated gloss ("Device for free-breathing 3D whole-liver imaging"). **Not used.** It's a paraphrase, sometimes flagged `insufficient_specificity`, and sits one rung below the family level the drawer renders.
- **`sample_context`** — curated best-of-N exemplar snippet. **This is the only field consumed.**

Pull `sample_context` **by name.** Drop every other column at the boundary — `cost_setup_usd`, `cost_per_use_usd`, `confidence_tool`, `confidence_cost`, `dependencies`, `assumptions`, `flags`, `model`, and the per-row `context` gloss. None is shippable: a `cost_setup_usd: 3000000` or a `model: o3+gpt-4o-mini` string must never enter a scope that can reach a public profile. **Carrying the whole tuple "for now" is the failure mode** — select the one field and leave the row behind.

**This table is read by other systems** (confirmed), so its fat columns are live data, not a private staging artifact. That makes the projection load-bearing **now**, at the generator boundary — it can't be deferred to a future cleanup of the table, because the table isn't ours to clean and other readers keep the risky columns populated.

### 6.2 Family rollup

The drawer renders method **families** (`scholar_family`); `sample_context` may be keyed per-tool. If per-tool, **elect one snippet per family by best-of-N** (prefer the longest descriptive sentence; break ties by tool pub-count). If already family-level, use directly.

### 6.3 Boilerplate filter

Before display or grounding, drop non-sentences: bare URLs, "available at…", anything under ~6 words or lacking a finite verb. If a family's only snippet is boilerplate, show **no** evidence rather than junk.

### 6.4 Double duty — one field, two jobs

- **Drawer reveal:** `sample_context` is the verbatim receipt behind "show evidence" — lets the scholar confirm the method is theirs and correctly attributed.
- **Generator grounding:** the same snippet grounds that method in prose. Distilled by the model, **never surfaced raw** in the bio.

### 6.5 Pre-flight checks

Before wiring, confirm: (a) `sample_context` is **verbatim, not another gloss** (spot-check rows — a paraphrase fed to a paraphraser is a weaker reveal); (b) its **key** (tool vs family, which sets whether §6.2 applies); (c) the boilerplate filter actually catches the URL / "available" rows present.

### 6.6 Ingestion gap to close (Appendix 2)

Today the S3 loader (`etl/tools/index.ts`) fetches only `manifest.json` + `tools.json`, the scholar-tool mapper hard-sets `sampleContext = null`, and `scholar_family` has no context slot — so `sample_context` reaches neither the methods facts nor the generator. To consume it: loader fetches the snippet source, the mapper populates `sampleContext` from the projected field, and `scholar_family` carries `sampleContext` through to the methods facts.

---

## 7. Visibility ledger — per content type

"What shows where", organised by content type. If a signal isn't listed, it doesn't reach the user.

**Shared rules — apply to every type below; the table records only type-specific behaviour.**

1. No metrics in prose; counts that *are* the fact survive **as words, rounded** (§4.1).
2. Raw scores stay backend, producing an **order + a 3-tier weight**; tiers never render and never appear in the drawer (§4.2–4.3).
3. Drawer reveals show **reasons and evidence, never numbers** (§3.2, §6.4).
4. **Project, don't pass the row** — pull named fields, drop the rest at the boundary (§6.1).
5. Three states (default / pinned / excluded) and Available-tier hiding apply to **every** type (§2.5, §3.2).

Columns: **Feeds** = goes to the generator. **In drawer** = what the scholar sees/controls. **Dropped → Available** = out of feedstock by selection logic, still reachable. **Withheld** = in the data, kept out of *both* prose and drawer by policy.

| Type | Feeds (to generator) | In drawer | Dropped → Available | Withheld (never prose or drawer) |
|---|---|---|---|---|
| **Publications** | title, venue, year, synopsis\*, topicRationale, author-position weight | + position toggle, "why this?" reason | near-duplicates (merged), single-mention tail | impact score (→ order + tier); `impactJustification` (unused); raw citation count (→ order; shows only as reason words) |
| **Funding** | role, funder, mechanism, grant title | + role toggle, "why this?" reason | RePORTER abstract † (not fed); RePORTER keywords; old/completed grants fade | dollar amounts ‡ (not in data); RePORTER MeSH codes |
| **Education** | degree, field, institution | exclude only | minor / non-terminal credentials | — (no centrality, no recency) |
| **Titles & positions** | name, primary title, department (scaffolding); endowed/named chairs; significant leadership roles (chair / director / president / editor) | non-editable scaffolding line (name · title · dept); select / exclude among titles & roles; add/pin on the tail | secondary / interim / end-dated appointments; routine committee memberships | `role_category`, `slug`, `orcid`, `has_headshot`; `has_clinical_profile` (routing flag only) |
| **Methods & tools** | family name, `sample_context`\* | signature families; `sample_context` as "show evidence"; show-more for tail | commodity / single-paper methods | cost, dependencies, confidence, `model` string, per-row `context` gloss (dropped at boundary, §6.1) |

\* feeds distilled, never verbatim. † see funding-abstract note. ‡ see funding-dollars note.

**Type-specific notes**

- **Funding dollars (‡ — not in the data).** No dollar field is currently available, so there's nothing to surface. Were it added, the default would be to withhold it (same rule as the tool cost in §6.1 and h-index — a funded total reads as boastful and is field-incomparable, and the funder + mechanism already carry the credibility); if ever foregrounded, render only the **active** total as a count-in-words ("over $10M in active NIH funding"), never an exact or lifetime figure.
- **RePORTER abstract († — not fed).** The abstract is **verbose** where the rest of the feedstock (titles, synopses, snippets, grant titles) is terse. Feeding it creates an asymmetry — it would dominate the input and skew the draft toward the funded project's framing. So it is **not fed.** The grant title + funder + mechanism carry the funding signal compactly. If it is ever wanted, it must first be **compressed to a single synopsis-length line** so it matches the register of everything else; raw abstract text never goes in.
- **Education is the pure case.** No centrality, no recency — the only type that is feedstock plus a hide switch and nothing else. The uniform table shouldn't imply otherwise.
- **Titles & positions (merged type).** One drawer type covers both identity titles and leadership roles. The title/role boundary is fuzzy — "Chair of Genetic Medicine" is *both* a title and a role — and both draw from the same data (the `appointment` table + the unit-leadership FKs), so splitting them in the drawer only forces the user to hunt for a record in the "right" section. The drawer governs **inclusion only**; the **generator keeps the distinction internally** (identity scaffolding vs leadership narrative — they may land in different sentences). Specifics:
  - **Scaffolding (always shown, non-editable).** Name, primary title, and department feed because the bio must *state* them, not because they differentiate — required scaffolding with no narrative value of its own. Render as a fixed header line, not a togglable record. Endowed/named chairs are the exception worth featuring ("the Bruce Webster Professor").
  - **Significance threshold** (the analogue of methods' commodity suppression): chair / director / president / editor-in-chief feed; committee memberships and the secondary / interim / end-dated appointment tail drop to Available (revealable, add/pin).
  - **Dedup the overlap.** A leadership role whose title is already the scholar's primary / featured appointment is shown **once** — in the scaffolding line — never duplicated as a separate record. Admin surfaces only the leadership roles *not* already carried by a featured title (a directorship, an editorship, a society presidency).

---

## 8. Decisions

**Resolved this round**

- **Re-lead — cut.** A full regeneration to reorder sentences the user can edit by hand; not worth the tokens (§1.2). Emphasis/order changes are done by direct editing. Recency loses its only user control as a result and becomes a default-setting input (§2.4).
- **Pin / exclude persistence — durable across runs.** Stored with the profile, not just the session (§2.5).
- **Grounding "off" mode — dropped.** A niche question (could a scholar force the bio to use only what they can see) that isn't a real need. Grounding has no "off", only "show evidence."
- **Enrichment table is read elsewhere.** Confirmed. The §6.1 projection is therefore load-bearing now, at the generator boundary — the risky columns stay populated by other readers and can't be cleaned away.
- **Funding dollars — not in the data.** Nothing to surface; default-withhold rule applies if ever added (§7 note).
- **RePORTER abstract — not fed.** Verbose against an otherwise terse feedstock; the asymmetry would skew the draft. Compact grant fields carry the signal instead (§7 note).
- **Contextual-add — cut; the system decides.** "Should this extra fact ride along?" is a system decision (§3.3), not a user prompt. The "Suggested" tier collapses: a signal is either decided in or reachable in the drawer (§3.2). This removes the last regeneration-on-accept. Additional facts that clear the threshold land in the first draft; the scholar edits out anything unwanted.
- **Identity & Administrative — merged into one "Titles & positions" type.** The title/role boundary is fuzzy and both draw from the same data (the `appointment` table + leadership FKs), so two drawer sections would only force users to find a record in the "right" one. The drawer governs inclusion; the generator keeps the scaffolding-vs-leadership distinction internally. The chair-title/chair-role overlap is **deduped** — shown once in the scaffolding line (§2.2, §7).
- **Pin / exclude — resolved per tier.** Every revealed Available-tier record gets **add/pin** (you must be able to act on what you reveal, §3.4). Every featured record gets **exclude**, plus **pin-to-protect** only for the volatile types whose set re-derives run-to-run (publications, funding, methods); stable types (titles & positions, education) keep featured rows exclude-only. Resolves the §2.2↔§7 wording conflict.
- **`sample_context` verification — resolved; the wire-in shipped (#1119/#1122, suppression in #1131).** The §6.5/§6.6 pre-flight is answered by the merged ingestion: snippets are loaded from the `tool_context.json` artifact (`tool_context_kind: "tool_usage_snippet"`) — **verbatim extracted publication text, not the per-row `context` gloss** (`etl/tools/tool-context.ts`). They are keyed **per-tool** (`tool_id → { pmid → sentence }`), so the §6.2 family rollup applies and is implemented as a calibrated best-of-N (`selectBestSnippet`: junk filter §6.3 = `isUsableSnippet`, name-bias + early-position preference, longest-descriptive pick, 240-char clamp, plus an opaque-tool `pub_count ≤ 4` gate). The §6.1 projection holds structurally — only `{ context, pmid }` crosses the boundary into `scholar_family.exemplarContexts`; the fat cost/confidence/model columns are not in the snippet artifact. The generator consumes it as the `TOOL USAGE DESCRIPTIONS` grounding block; #1131 excludes suppressed-publication pmids from snippet selection (ADR-005). **Nothing remains open on the methods-grounding wire-in.**

**Still open**

- None. The remaining build is the §2/§3 three-state source-drawer selection model (not a decision — an implementation task).
