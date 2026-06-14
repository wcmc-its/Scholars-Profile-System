# Overview Generator — Panel Redesign Spec

**Surface:** Scholars Profile Console → My Profile → Overview
**Component:** AI bio generator ("Generator" tab, currently Beta)
**Status:** Implemented — shipped #875/#885 (single editor + draft-review safety net) on the #742 overview generator. (Spec reconciled to shipped code 2026-06-14, #990.)
**Last updated:** 2026-06-11
**Revision:** +§7 source-ranking & enrichment boundary (the "confidence layer"). Flow, draft-review card, editor model, footer, and states table are unchanged — confidence is carried entirely by per-source rule statements (text in headers we were already editing) plus the already-specced frictionless override.

> **Terminology note:** This spec uses "bio" throughout, but shipped UI copy says "overview" (e.g. the section header, the "Save overview" action). Read "bio" as "overview" wherever it appears below.

---

## 1. Problem

The current panel works but has four structural issues that create friction and one real trust risk:

1. **Flow reads backwards.** The Regenerate/Generate button sits *above* Generation options and Sources — the two inputs that control its output. Users tweak settings, then scroll back up to act.
2. **No safety net between generation and the editor.** If a generated draft drops straight into the editor, a user with a hand-written bio can clobber it with one click. This is the highest-risk interaction in the feature.
3. **"Existing | Generator" is a confusing pair.** They aren't peer views — one is saved content, one is a tool. The segmented control implies switching loses state, and on a hand-written bio the button mislabels as "Regenerate" (implying the bio was AI-generated when it wasn't).
4. **Invisible contradictions and limits.** Selected sources can silently conflict with emphasis toggles (e.g. 9 awards selected while "Grants & funding" is off); the sources budget ("up to 25") has no live counter; the `/20,000` character denominator undercuts "a short bio."

## 2. Goals

- The generator never overwrites saved content without an explicit user choice.
- The panel reads top-to-bottom as a form that culminates in its action.
- One editor is the single source of truth; the generator is an assist, not a parallel state.
- Source selection and emphasis settings communicate their consequences before generation.

---

## 3. Layout & ordering

Replace the `Existing | Generator` segmented control with a single persistent editor and a collapsible **Draft with AI** block stacked above it. Top-to-bottom order:

1. **Section header** — "Overview", "Yours to edit" badge, helper text.
2. **Draft with AI block** (collapsible) — contains, in this internal order:
   1. Settings (Voice, Tone, Length, Include & emphasize)
   2. Sources summary row (with Edit → drawer)
   3. Conflict/sparse-source hints (conditional)
   4. **Generate a draft** button + consequence microcopy
3. **Draft review card** (conditional — only after a draft exists)
4. **Editor** (always present, single source of truth)
5. **Footer** — character count, publish warning, Save bio

The button always sits below every input that feeds it. The block can collapse to a single row that summarizes current settings (e.g. "Third person · Formal · Standard · 4 emphases").

---

## 4. Component specs

### 4.1 Draft with AI block

- Self-contained card, `border-radius-lg`, `0.5px` border.
- Header: sparkles icon + "Draft with AI" + Beta pill + collapse/expand affordance.
- Label is fixed as **"Generate a draft"** regardless of whether a saved bio exists. Drop the conditional "Regenerate" label — generation produces a reviewable draft, it does not act on the editor, so "regenerate" is never the right verb for the primary action. (Re-running after a first draft is handled by the same button; draft history lives in the review card — see 4.3.)

### 4.2 Settings

Replace radio rows with compact segmented pills to halve vertical height.

| Setting | Options | Default |
|---|---|---|
| Voice | Third person · First person | Third person |
| Tone | Formal · Neutral · Conversational | Formal |
| Length | Short · Standard · Extended | Standard |

**Include & emphasize** — render as a single wrapped row of checkbox chips (no two-column grid; the columns carried no semantic grouping). Selected chips use the coral fill (`#FAECE7` bg / `#712B13` text / `#F0997B` border); unselected are outline-only.

Default-on: **Research focus · Key findings & significance · Recent work · Methods**
Default-off: Clinical applications · Grants & funding · Education & training

> **Change from current:** Methods is now default-on. Methods are a first-class source (10 in the picker, tied to the Methods & Tools taxonomy) and belong in a default bio for a research profile. Clinical applications, grants, and education stay opt-in because they're audience- or role-specific.

**Additional instructions** — free-text, 0/500, placeholder retained.

> **Boundary (see §7).** The emphasis chips steer *what the draft covers* — they are not evidence. The objective per-item evidence (counts, authorship roles, recency, impact numbers) lives in the Sources drawer under the §7.2 whitelist. Model justification prose (`context`, `impactJustification`) never renders in either place.

### 4.3 Draft review card (the safety net)

Generation **never writes to the editor directly.** The draft renders in a visually distinct card (coral-tinted to read as "AI output, not yet yours") between the generator block and the editor.

- Header: "Draft · {relative time}" and a draft-history affordance: "Draft N of M · view previous". Re-running Generate appends a new draft and keeps prior ones, so iteration is cheap and the saved bio is never at stake.
- Body: the generated text.
- Actions:
  - **Replace current bio** — overwrites editor contents with the draft.
  - **Insert below** — appends the draft to existing editor contents.
  - **Discard** — dismisses this draft (tertiary, no border).
- The editor and saved bio are untouched until the user picks Replace or Insert.

### 4.4 Editor

- Single persistent rich-text editor (bold, italic, lists, link — unchanged).
- **Empty state** quotes the user's actual source counts as an on-ramp:
  *"No bio yet. Generate a draft from your 16 publications and 9 awards above, or start writing here."*
  Pull live counts from the sources selection.

### 4.5 Footer

- Character count shows the raw number only — **drop the `/20,000` denominator.** Surface a denominator/warning only above ~80% of the ceiling. (If the product wants a true editorial limit, set it to 2,000–3,000 and show it; otherwise treat 20k as a backend ceiling the user shouldn't think about.)
- Publish consequence sits adjacent to Save with a globe icon: "Publishes to your public profile immediately."
- Save bio disabled until content exists / changes are pending.

---

## 5. Sources drawer

Right-side drawer, opened from the Sources row's **Edit**. Sections: Publications, Funding/Awards, Methods.

- **Live budget counter** near Done, mirroring the footer copy: "14 of 25 papers + awards · 9 of 10 methods". Disable further checks at the cap rather than failing silently.
- **Per-section quick actions:** All · None · Top 10 by score.
- **Selected-first ordering.** Checked items pin to the top of each section (or provide a "Selected first" sort toggle). The current score-only interleaving makes reviewing a selection a scavenger hunt — see the funding screenshot where checked and unchecked items alternate.
- **Replace insider microcopy with a sort control *and* a rule line.** The header's "scored · impact desc" becomes two distinct things: (a) a labeled sort dropdown (e.g. "Sort: Impact (high→low)") — the *mechanic*; and (b) the plain-language ranking rule from §7.1 — the *reassurance*. They coexist: Publications shows both the sort control and "Ranked by citation impact and recency, weighted toward senior-author work." Methods carries "Inferred from methods named in your publications · ranked by how often each appears" (§7.4).
- **Define the Done contract explicitly.** Decide one model and remove the ambiguity:
  - If Done is the only commit → add an explicit Cancel/X that discards drawer changes.
  - If clicking outside commits → remove the Done button (it's redundant).

---

## 6. Conditional hints

Surface these inline, only when the condition holds:

- **Emphasis/sources conflict:** when sources of a type are selected but the matching emphasis is off —
  *"9 awards are selected as sources but won't be mentioned directly — turn on Grants & funding to include them in the bio."* (info style)
- **Sparse sources:** when generating from very few sources (e.g. 1 publication, 0 awards) —
  *"Limited sources may produce a generic draft."* (warning style, shown before generation)

---

## 7. Source ranking & the enrichment boundary (the confidence layer)

The generator selects and ranks sources before drafting. Each source type is ranked by a **different** signal, and the panel states that signal in plain language so the selection never reads as a black box. This is a confidence layer carried by *text in headers* (and the already-specced override) — it adds no new interaction or UI surface.

**Non-goal:** there is **no unified "confidence score" across source types.** Do not add a single "AI confidence" badge spanning publications, awards, and methods — the signals are incommensurable (see §7.4) and one badge would have to misdescribe at least one of them.

### 7.1 Per-source ranking rules

Each drawer section header carries a one-line rule that is **aggregate and factual — never a per-item justification.** Each source states its own rule in its own terms:

| Source | Ranking signal | Section-header rule (verbatim) |
|---|---|---|
| Publications | impact + recency, weighted to senior-author work | "Ranked by citation impact and recency, weighted toward senior-author work." |
| Funding / Awards | role + recency | "Ranked by your role and recency." |
| Methods | frequency across your publications | "Inferred from methods named in your publications · ranked by how often each appears." |

The sort dropdown (§5) is the *mechanic*; the rule statement is the *reassurance*. They coexist in the same header.

### 7.2 Per-item signals — the visible whitelist

Inside the drawer, each item shows **only** these objective signals, and nothing else:

- **Publications:** authorship role · year · impact *number*.
- **Awards:** role · year.
- **Methods:** publication *count* (the summative figure — e.g. the `16 / 14 / 10 / 7 / 7 / 5` in the public Methods & tools panel).

These are the only per-item signals shown. No model prose renders next to an item.

### 7.3 The enrichment boundary — one rule, all fields

Per-source enrichment is internal-only, with one narrow exception. This single rule covers all three fields:

- `context` and `impactJustification` — **never render.** They are model prose and invite relitigation ("why does it think *this* paper matters?").
- Numeric ranking signals — `impactScore` (publications) and publication-`count` (method families) — **may surface only as a number and a sort key. Never as prose, and never normalized across source types into a single confidence figure.**

Each section owns its own scale, its own rule line, and its own "Top N by score" definition: by `impactScore` for publications, by `count` for methods, by role + recency for awards. The count grounds *selection*, not *claims* — a family **label** may appear in a generated bio; a competence assertion derived from its count ("expert in X because the count is 10") may not.

### 7.4 The summative-data note (the wedge)

Publication scores and method-family counts are **different kinds of number** and are deliberately not unified:

- A publication **impact score** is a **model-derived value over a known item** — we know exactly which paper; the *number* is the estimate. The uncertainty lives in the value.
- A method-family **count** is an **exact tally over an inferred set** — the arithmetic is precise, but the family grouping and the "this publication *used* this method" attribution are inferred. The uncertainty lives in the membership, not the number.

A single confidence statement cannot be honest about both: it would have to adopt one uncertainty frame and would misdescribe the other. The per-source-rule approach (§7.1) is the resolution — N honest stories in N units, not one story stretched across incommensurable signals. The **"Inferred from … methods named in your publications"** framing is load-bearing: it hedges *both* inference layers (extraction + grouping) behind the count without a disclaimer. Reuse it verbatim from the public Methods & tools panel.

**Coupling to defaults (#765 §2).** The Methods rule ("ranked by how often each appears") is honest **only if the default selection actually reflects frequency.** Most method families have `pmid_count = 1`; a top-N-by-count default that surfaces single-paper long-tail families contradicts the rule line. The Methods rule statement (§7.1) and the #765 §2 `pmid_count ≥ 2` default floor are the **same decision and must ship together.**

---

## 8. States summary

| State | Generator block | Review card | Editor | Save |
|---|---|---|---|---|
| New profile, no bio | Expanded, "Generate a draft" | hidden | empty-state prompt | disabled |
| Draft generated | Expanded/collapsible | visible w/ actions | unchanged | disabled until choice |
| Draft accepted (Replace/Insert) | collapsible | dismissed | populated | enabled if changed |
| Existing hand-written bio | collapsed by default | hidden | populated | disabled until edited |

---

## 9. Open questions

1. Draft history persistence — session-only, or stored across visits? Session-only is simpler and probably sufficient. RESOLVED: shipped **persisted across visits** (overview version history, #759) — not session-only.
2. Does "Insert below" need cursor-aware placement, or is append-to-end fine for v1? (Append is fine.)
3. Should the collapsed generator summary be clickable per-setting (deep-link to expand on that control), or expand-all only? Expand-all for v1.
4. Does the publication impact *number* (§7.2) need a scale/legend, or is it self-evidently a sort key? Lean **no legend** — it's a relative sort signal, not an absolute metric, and a legend would re-import the "what does this number mean" relitigation that §7.3 is built to avoid.
