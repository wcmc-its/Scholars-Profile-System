# Spec — COI "From the scholar's publications" review redesign

Scholars Profile Console → Conflicts of Interest → *From the scholar's publications*

## 1. Summary

Today the screen groups unmatched competing-interests mentions by **organization**. One card per company lists every paper that named it, and the action buttons sit at the card footer. This produces two structural problems:

1. **Cross-card duplication.** A single COI statement names many organizations, so the same full sentence is reprinted verbatim under every company it mentions (e.g. PMID 41679681's sentence appears identically on five cards). The reviewer re-reads the same text repeatedly and hunts for the one relevant company each time.
2. **Mixed attribution under one decision.** A company card mixes the scholar's genuine relationships with co-authors' disclosures that were surfaced only because they sit in a paper the scholar co-authored (e.g. "A Saxena receives research funding from AstraZeneca…", "SR declared serving on advisory boards of…"). A single card-level decision cannot be correct for a card that contains both.

The redesign keeps Organization grouping but adds a **Paper** grouping, a shared **highlighting system**, and — the load-bearing change — moves the **unit of decision to the statement (paper + subject)**, not the organization. Decisions then persist across both views because both are projections of the same underlying mentions.

This screen does **not** write to the Weill Research Gateway. Gateway remains source of truth ("Managed in the Gateway, never here"). The actions here are scholar attestations + queue management + a feedback signal to matching, nothing more. Preserve the existing guardrail copy: *Visible to administrators and the scholar* · *Not a compliance judgement* · *Managed in the Gateway, never here*.

## 2. Sensible defaults (decisions made)

| Decision point | Default | Rationale |
|---|---|---|
| Default grouping | **Organization** | Matches current screen + the scholar's "do I disclose X?" model; least disruptive. |
| Grouping persistence | **Sticky per user** (persist last choice) | Most reviewers live in one view; don't re-impose the default each visit. |
| Default filter | **Needs review** | Resolved items are removed from the working list; available under Reviewed. |
| On resolve | Item **leaves the active list immediately**; 5s inline "Undo" toast; reversible anytime via Reviewed. | Scales to the 135-item backlog; toast keeps quick undo without a context switch. |
| Decision unit | **(pmid, subjectId)** | A statement is one author's relationships; that's the only coherent thing to judge. Single-subject papers collapse to per-paper. |
| Action placement | **Per-row** in Organization view; **per-statement footer** in Paper view | Org cards mix subjects, so card-level actions are wrong there; paper cards are one statement. |
| Subject highlight | self = calm; co-author = flagged; unknown = explicit "unclear" | Most subjects are the scholar; reserve saturation for the co-author exceptions that need catching. |
| Org highlight | amber chip, always | Answers "why is this paper under this card?" at a glance. |
| "Worth reviewing" badge | **Removed** | The section header already says it; per-card repetition is noise. |
| Low-confidence (135) | Collapsed; expands into the same two-view structure with a low-confidence marker; **excluded from the primary counter** | Keep the working set high-signal. |
| Counter scope | High-confidence, needs-review statements only | Reflects real remaining work. |

## 3. Data model

Atomic unit is the **Mention** (one paper × one organization). Paper- and organization-level views are rollups of the same mentions.

```ts
// One (paper, organization) pairing extracted from a competing-interests statement
interface Mention {
  pmid: string;
  year: number;
  organization: string;        // canonical, normalized + deduped
  organizationRaw: string;     // as printed, e.g. "Roche/Genentech"
  subjectType: "self" | "coauthor" | "unknown";
  subjectMention: string | null; // exact token: "Dr Altorki", "A Saxena", "SR"; null if unknown
  clause: string;              // trimmed clause naming this org (subject + org marked — see §4)
  relationshipKinds: RelationshipKind[]; // ["advisory_board", "grant", ...]
  confidence: "high" | "low";
}

type RelationshipKind =
  | "advisory_board" | "consulting" | "honoraria" | "grant"
  | "speaker_fees" | "royalties" | "ownership" | "dsmb"
  | "steering_committee" | "lecture_fees" | "other";

// Paper rollup (one per pmid), derived
interface Statement {
  pmid: string;
  year: number;
  fullText: string;            // entire competing-interests statement
  subjects: SubjectGroup[];    // usually length 1; >1 only for multi-subject statements
}

interface SubjectGroup {
  subjectId: string;           // stable key: "self" or normalized subjectMention
  subjectType: "self" | "coauthor" | "unknown";
  subjectMention: string | null;
  organizations: string[];     // orgs this subject discloses in this paper
  decision: Decision | null;
}

interface Decision {
  pmid: string;
  subjectId: string;           // decision unit = (pmid, subjectId)
  value: "will_update" | "historically_true" | "not_valid";
  decidedBy: string;
  decidedAt: string;           // ISO 8601
}
```

Notes:
- `subjectType` / `subjectMention` is the hard part and the highest-value field. Key it off the parsed grammatical subject of the clause, not mere proximity. When the subject cannot be resolved, emit `"unknown"` rather than guessing `"self"` — a wrong self-attribution is worse than an honest "unclear."
- Organization normalization should fold obvious variants (`Roche`, `Roche/Genentech`, `F Hoffman-La Roche`) per existing entity-resolution rules, but keep `organizationRaw` for display fidelity inside clauses.

## 4. Highlighting rules

Mark **exactly two things** in any rendered clause or statement: the matched organization(s), and the single disclosure subject. **Never** mark other author names, unmatched organizations, or generic text. This is the rule that keeps a sentence naming a dozen people and firms legible.

Severity is encoded in visual weight:

| Role | Treatment | Meaning |
|---|---|---|
| Organization (matched) | **amber chip** (filled) | "Why this paper is under this card." |
| Subject = self | **bold + 1px underline**, no fill | "This is the scholar's relationship" — calm, because it's expected. |
| Subject = co-author | **purple chip** (filled) | "Different subject — check this." The exception to catch. |
| Subject = unknown | no inline mark; **"Subject unclear" dashed tag** at row/card level | Honest about an unresolved parse. |

> Note vs. the prototype: the prototype used a filled gray chip for `self`. The spec downgrades `self` to bold+underline because most subjects are the scholar, and filled chips on every row become noise. If usability testing shows self-anchoring is too weak, promote it back to the gray chip.

Color tokens (self-contained chips; provide both modes):

| Role | light bg | light text | dark bg | dark text |
|---|---|---|---|---|
| org (amber) | `#FAEEDA` | `#633806` | `#412402` | `#FAC775` |
| co-author (purple) | `#EEEDFE` | `#3C3489` | `#26215C` | `#CECBF6` |
| self underline | — | bold, `border-bottom: 1px solid var(--color-border-secondary)` | — | same |
| unclear tag | `transparent`, `1px dashed var(--color-border-secondary)` | `var(--color-text-tertiary)` | same | same |

Accessibility: hue is never the only signal. Each chip/mark carries an `aria-label` / title (`organization`, `you`, `co-author: A Saxena`), and attribution is restated in text (the summary line and subject tag). Colorblind and screen-reader users get the same information without relying on color.

**Trimming (Organization view only):** `clause` is the smallest span containing the subject token (when present) and the matched org, plus ~6 words of connective context, with `…` for elided text. If the subject is far from the org clause, render `subject … org-clause`. The full statement is available on expand. **Paper view uses `fullText` verbatim** — no trimming, because the statement appears exactly once there.

## 5. Organization view

Layout per organization card:

- **Header row:** organization name (17px / 500) · muted "{N} papers" · right-aligned "Review in Gateway ↗".
- **Summary line** (muted, 13px), built from the card's mentions:
  `{minYear}–{maxYear} · {selfCount} attributed to {scholarLastName}, {coauthorCount} to co-authors[, {unknownCount} unclear] · {relationshipKinds, humanized, joined}`
  Example: `2018–2026 · 9 attributed to Altorki, 2 to co-authors, 2 unclear · advisory / consulting · honoraria · grants · speaker fees`
- **Mention rows**, sorted newest-first:
  - left: `{year}` over `PMID {pmid}` (muted; PMID links to PubMed).
  - right: the **trimmed clause** (org chip + subject mark per §4), then a compact action set OR, if resolved, the resolved chip.
  - `full statement` toggle reveals `fullText` inline.
- **No card footer actions** (they move per-row).

Compact action labels (per-row): `Update COI` · `No longer current` · `Not valid` (see §7 mapping).

## 6. Paper view

Layout per statement card:

- **Header row:** `{year} · PMID {pmid}` · right-aligned subject tag (`you` / `co-author · {name}` / `Subject unclear`).
- **Statement:** `fullText` verbatim, with org chips + subject mark.
- **Multi-subject statements:** split the card body into one sub-block per `SubjectGroup`, each with its own subject tag, its own org chips, and its **own footer actions**. (Common case is a single subject → single block → single footer.)
- **Footer actions** (full labels) with the hint `One decision clears all {orgCount} organizations`.

Paper view is the fast-triage path: purple (co-author) statements can be dismissed in one click, clearing every organization they contributed to the queue.

## 7. Shared behaviors

**Controls (top bar):**
- `Group by: [Organization] [Paper]` segmented control (sticky per user).
- `Show: [Needs review (N)] [Reviewed (M)] [All]` filter; default Needs review.
- Counter text: `Showing {shownPapers} of {totalPapers} papers · {reviewedCount} reviewed`.

**Decision outcomes** (what each action does downstream):

| Action | value | Effect |
|---|---|---|
| I intend to update my COI statement | `will_update` | Scholar attests the relationship is real and current; remove from queue; optionally create a Gateway-update task/reminder. Does **not** write to Gateway. |
| Historically true but not currently valid | `historically_true` | Records an expired relationship; remove from queue; suppress resurfacing. |
| Not a valid suggestion | `not_valid` | False positive (co-author, mis-parse, wrong entity); remove from queue; **feed back as a negative training signal** to the matcher. |

**Propagation:** resolving `(pmid, subjectId)` removes **all** of that subject's mentions for that paper from the Needs-review list, in **both** views simultaneously. The counter increments by **one** (statements reviewed), regardless of how many organizations were cleared. Surface the breadth in the toast: `Marked not valid · cleared 4 organizations · Undo`.

**Undo / reversibility:** the toast offers Undo for ~5s. After it dismisses, the decision lives under the Reviewed filter, where each item shows its decision label, who/when, and an Undo control. Undo returns the statement to Needs review across both views.

**Resurfacing rules:** `not_valid` and `historically_true` do not reappear for the same `(pmid, subjectId)`. A later enrichment run that introduces **new** mentions (new paper, or a newly-named org for an existing subject) may add new Needs-review items, but must not revive resolved ones.

**Low-confidence matches:** a collapsed `▸ Show {k} lower-confidence matches` at the bottom. Expanding renders them in the same two views with a `low confidence` marker (e.g. a small muted flag on each card/row) and a thinner border. They are excluded from the primary counter and the Needs-review count until promoted.

**Empty state:** when Needs review reaches zero, show `All caught up — {reviewedCount} statements reviewed` with a link into the Reviewed filter.

## 8. Removed / changed vs. current screen

- **Removed:** per-card "Worth reviewing" badge.
- **Moved:** action buttons → per-row in Organization view (kept at footer in Paper view).
- **Changed:** Organization-view clauses are now **trimmed + highlighted** instead of full italic blockquotes; full text on demand.
- **Added:** Paper grouping, the Group-by + filter controls, the per-card summary line, the highlighting system, the Reviewed filter, and the resolve toast.
- **Preserved:** the three guardrail pills, the Sort control, the "Review in Gateway ↗" affordance, the lower-confidence disclosure, the three action semantics.

## 9. States, performance, accessibility

- **Loading:** skeleton cards in the active view; controls render immediately.
- **Error:** if mentions fail to load, show a retry affordance; never silently empty.
- **Performance:** both views derive from one fetched mention set; toggling and filtering are client-side re-pivots, not refetches. Decisions POST individually and update local state optimistically (roll back on failure).
- **Keyboard:** controls and actions are focusable; the segmented control is a radio group; Undo in the toast is reachable before dismissal.
- **Screen readers:** chips/marks expose role via `aria-label`; the summary line states the attribution split in text; on resolve, announce the toast via an `aria-live="polite"` region.

## 10. Acceptance criteria

1. Default load is Organization view, Needs-review filter; the grouping choice persists across sessions per user.
2. In any clause/statement, only the matched organization(s) and the single subject are marked; no other names are highlighted.
3. Subject marks render per §4 (self = bold+underline, co-author = purple chip, unknown = dashed tag) in both modes, with accessible labels.
4. Organization-view rows show trimmed clauses with a working "full statement" expand; Paper view shows full text verbatim.
5. Each organization card shows the summary line with correct counts, year range, and relationship kinds.
6. Resolving a statement in one view removes it from the other view's Needs-review list and increments the reviewed count by exactly one.
7. The resolve toast reports the number of organizations cleared and offers Undo for ~5s; Undo restores the item in both views.
8. `not_valid` decisions are emitted as negative training signal; resolved items do not resurface (except as genuinely new mentions).
9. Lower-confidence matches expand into the same two-view structure, are visibly marked, and are excluded from the primary counter.
10. Multi-subject statements split into per-subject blocks, each independently decidable.

## 11. Out of scope / open

- Writing to the Gateway (remains external; out of scope here).
- Bulk actions (e.g. "dismiss all co-author statements") — plausible follow-up once per-statement flow ships.
- Final wording of the three actions: semantics are fixed; the short/full label registers below are the proposal, subject to compliance review.

Label register mapping:

| Canonical (Paper footer) | Compact (Org rows) | value |
|---|---|---|
| I intend to update my COI statement | Update COI | `will_update` |
| Historically true but not currently valid | No longer current | `historically_true` |
| Not a valid suggestion | Not valid | `not_valid` |
