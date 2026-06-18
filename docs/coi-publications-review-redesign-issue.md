# Issue — Redesign COI "From your publications": Paper grouping + per-statement decisions with subject attribution

**Labels (suggested):** `enhancement`, `area:ui`, `area:self-edit`
**Surface:** Scholars Profile Console → Conflicts of Interest → *From your publications* (`/edit?attr=coi` → COI-gap sub-view)
**Component:** `components/edit/coi-gap-card.tsx` · `lib/api/edit-context.ts` · `lib/coi-gap/*`
**Flag:** `SELF_EDIT_COI_GAP_HINT` — **off in both staging and prod** today; this work ships dark and does not change the rollout gate (Faculty Affairs / Compliance / General Counsel sign-off + a ratified High-tier precision number — `docs/coi-pubmed-HANDOFF.md` §C).
**Spec:** `docs/coi-publications-review-redesign-spec.md` · **Prototype:** `docs/mockups/coi-publications-review-redesign.html`

---

## Problem

The COI-gap surface today (`coi-gap-card.tsx`, `EditContextCoiGapCandidate`) presents **one deduped row per normalized entity** — e.g. "AstraZeneca" is a single row that cites every paper naming it, and a decision fans out to all of that entity's source candidate-ids. That model has two structural failures the redesign targets:

1. **Cross-row duplication.** A single competing-interests statement names many organizations, so the same verbatim sentence is reprinted under every entity it mentions (PMID 41679681's sentence appears under AstraZeneca, Janssen, Roche/Genentech, Regeneron). The reviewer re-reads the same text and hunts for the one relevant company each pass. The sentence is rendered verbatim, in full, with **no highlighting** of which org or which subject is the reason that row exists.

2. **Mixed attribution under one decision.** An entity card silently mixes the *scholar's own* relationships with *co-authors'* disclosures that surfaced only because they sit in a co-authored paper (e.g. AstraZeneca collects "Altorki reports grant funding from AstraZeneca", "A Saxena receives research funding from AstraZeneca", and "SR declared serving on advisory boards of … AstraZeneca"). Today co-author leakage is handled by **suppression** — the byline cross-check (`buildAuthorRoster` / `matchesCoAuthor`, PR #966) drops co-author-*name* entities, and pure-Medium matches are tucked behind a "lower-confidence" expander described as "often a co-author's disclosure." But the disclosure *clause's grammatical subject* is never attributed or surfaced, so a co-author's relationship can still ride under the scholar's entity row, and a single decision cannot be correct for it.

## The load-bearing change

Move the **unit of decision from the entity to the statement** — `(pmid, subjectId)` — and make **subject attribution a first-class, surfaced field** rather than an implicit suppression heuristic. Both grouping views (Organization and a new Paper view) then become projections of the same underlying *mentions*, and a decision in one view persists across the other because both roll up the same atoms.

This is additive to, not a replacement of, the existing 3-way feedback model (#944 / #953). The three actions map **1:1** to the current `FeedbackReason` and keep their downstream semantics:

| Spec label | Existing `FeedbackReason` | Status / effect (unchanged) |
|---|---|---|
| I intend to update my COI statement | `will_disclose` | `acknowledged`; leaves queue |
| Historically true but not currently valid | `historical` | `dismissed`; no re-nag |
| Not a valid suggestion | `not_valid` → `invalid` | `dismissed`; negative training signal |

## Current vs. proposed

| | Today (origin/master) | Proposed |
|---|---|---|
| Decision atom | Normalized **entity** (deduped across papers); fan-out across all source ids | **`(pmid, subjectId)`** statement; fan-out across all orgs that subject names in that paper |
| Grouping | Entity only | **Organization** *and* **Paper** toggle (segmented control, sticky per user) |
| Subject attribution | Implicit (co-author *names* suppressed); not surfaced | **Explicit** `self` / `coauthor` / `unknown` per mention; surfaced + marked |
| Sentence rendering | Full verbatim italic blockquote, no marks | **Highlighted**: amber org chip + subject mark (self = bold+underline, co-author = purple chip, unknown = dashed "unclear" tag). Org view = **trimmed clause** (full text on expand); Paper view = full text verbatim |
| Counter | "N worth reviewing" (High active count) | "Showing {X} of {Y} papers · {N} reviewed" (papers-based) |
| Per-row badge | "Worth reviewing" / "Likely covered" tier chip on every row | Removed (section header already says it) |
| Resolve UX | In-place flip to "{reason} — Undo" | Item leaves active list + **5s Undo toast reporting orgs cleared** ("cleared 4 organizations · Undo"); reversible via Reviewed |
| Lower-confidence | Collapsed expander (exists) | Same, but re-homed into the two-view structure; excluded from the primary counter |

## Scope

**1. Data / pipeline (highest risk — the prerequisite).** Produce reliable **subject attribution** per extracted mention.
- Extend the statement extractor (`lib/coi-gap/pipeline.ts` `analyzeStatement`) to emit, per mention, `subjectType: "self" | "coauthor" | "unknown"` and `subjectMention` (the exact token: "Dr Altorki", "A Saxena", "SR"). Key off the **parsed grammatical subject** of the clause, not proximity. When unresolved, emit `"unknown"` — never guess `"self"` (a wrong self-attribution is worse than an honest "unclear").
- Surface matched `organization` (already normalized today), `relationshipKinds[]`, and a trimmed `clause` (smallest span around subject + matched org + ~6 words, `…` for elisions) per mention.
- Persist subject on the candidate so fan-out can target `(pmid, subject)`: add `subject_type` / `subject_mention` to `coi_gap_candidate` (migration), keeping the existing per-id `status` + `feedback_reason` lifecycle intact.

**2. Types / context.** Reshape `EditContextCoiGapCandidate` (or add a mention-level projection) to carry `subjectType`, `subjectMention`, `organization`, `clause`, `relationshipKinds`. Partition active vs. reviewed by `(pmid, subjectId)` in `loadEditContext` (preserve "any new source ⇒ active, never in Reviewed").

**3. API.** Keep the idempotent per-id `/api/edit/coi-gap/[id]/{feedback,restore}` routes. Only the **client fan-out set** changes: a decision on `(pmid, subjectId)` POSTs to every candidate-id for that paper+subject (all orgs), not every id for an entity. No new route required; genuine-self-or-superuser guard unchanged.

**4. UI (`coi-gap-card.tsx`).** Group-by segmented control (sticky); papers-based counter; the shared highlighting system (§4 of spec, light+dark tokens, `aria-label` on every chip); Organization view (per-row actions, trimmed clauses, summary line with attribution split + year range + relationship kinds); Paper view (per-statement footer actions, full text, multi-subject split into per-`SubjectGroup` blocks); resolve toast with org-count breadth + `aria-live`; Reviewed filter (reuse existing change-of-mind + Undo); lower-confidence expander re-homed.

**5. Tests.** Extend `tests/unit/coi-gap-card.test.tsx` (+ pipeline/compute) for: subject marking in both views; only matched-org(s) + the single subject highlighted (never other names); `(pmid, subjectId)` resolution clearing the item in both views and incrementing reviewed by exactly one; toast org count; lower-confidence excluded from the counter; multi-subject split independently decidable.

## Preserve (governance — non-negotiable)

- Gateway remains source of truth; **no in-app COI editing**. "Review in Gateway ↗" routes to WRG. Keep the three guardrail chips: *Visible to administrators and the scholar* · *Not a compliance judgement* · *Managed in the Gateway, never here*.
- **Suggest, never accuse** — the forbidden vocabulary (undisclosed / failed to disclose / missing / violation / gap) appears nowhere.
- Qualitative tier only — never a percentage, never the numeric score crossing to the client.
- Superuser confirmation "nag" before acting on a scholar's private suggestion stays.
- Ships **dark behind `SELF_EDIT_COI_GAP_HINT`**; this is not a staging-first rollout and does not move the compliance gate.

## Acceptance criteria

(From spec §10 — abbreviated.)
1. Default load = Organization view, Needs-review filter; grouping choice persists per user across sessions.
2. In any clause/statement, only the matched organization(s) and the single subject are marked; no other names highlighted.
3. Subject marks render per §4 in both views (self = bold+underline, co-author = purple chip, unknown = dashed tag) with accessible labels.
4. Org-view rows show trimmed clauses with a working "full statement" expand; Paper view shows full text verbatim.
5. Resolving a statement in one view removes it from the other view's Needs-review list and increments reviewed by exactly one.
6. Resolve toast reports orgs cleared and offers Undo ~5s; Undo restores in both views.
7. `not_valid` emitted as negative training signal; resolved items don't resurface (except genuinely new mentions).
8. Lower-confidence matches expand into the same two-view structure, are visibly marked, and are excluded from the primary counter.
9. Multi-subject statements split into per-subject blocks, each independently decidable.

## Out of scope / open

- Writing to the Gateway (external).
- Bulk actions (e.g. "dismiss all co-author statements") — plausible follow-up once per-statement flow ships.
- Final wording of the three actions — semantics fixed; labels subject to compliance review.
- **Risk:** subject attribution (§3.1) is the hard part. If extraction precision on `subjectType` is too low, the Paper view's one-click co-author dismissal misleads. Gate the redesign's launch on the same precision posture as the flag, and consider measuring subject-attribution precision as part of the ratified number.
