# Handoff — #1366 follow-up #2: panel relabeling, relevance cues, filled-dot reconciliation

**Date:** 2026-06-30 · **Branch:** `feat/1366-evidence-reason-counts` · **PR:** #1368 (open, CI-green build/cdk/Orca, staging-deployed at `a2a0a632`)
**Worktree:** `~/worktrees/sps-1366` · **Flag:** `SEARCH_EVIDENCE_REASON_COUNTS` (staging-on/prod-off)
**Mockups:** `~/Downloads/scholars_results_proposed_changes_collapsed.html`, `~/Downloads/ten_hacken_expanded_relabeled_panels.html` (rendered screenshots on the user's Desktop, 2026-06-30 ~14:35).

## Where things stand

The tiered card + de-dup follow-up (`a2a0a632`) is committed, CI-green, and deployed to staging for review. The user reviewed it and proposed a refinement set; this handoff captures it. **Everything here is render-only and extends PR #1368, EXCEPT Part E (funding-mention abstract snippet), which is a separate backend PR.** No reindex needed for A–D (data already on `scholars-people-v13`).

The current tiered render lives in `components/search/people-result-card.tsx` (host: primary + "Also matched"), `components/search/result-evidence.tsx` (`tier="primary"|"lesser"` switch), `components/search/match-reason.tsx` (`LesserReason`, `MentionNote`, `MatchAwareReason`, `MatchReason`, `RepresentativePapers`, `KeyFunding`), `components/search/evidence-line.tsx` (per-line disclosure + `tier` threading).

## Decisions locked with the user (2026-06-30)

- **Dots are always FILLED** (category color). **Drop the hollow-for-mention dot** that shipped in `a2a0a632`. Mention/weakness is conveyed by **muted + italic text** ("mentions", "term match only"), never by dot fill. [user: "full dot"]
- **Keep existing icons.** Concept stays `Waypoints` (the #1073 search-mechanic glyph); do NOT adopt the mockup's atom glyph. [user: "use existing icon"]
- **No acronym hover-tooltip** (the mockup's dotted-underline `title=` CRISPR→"Clustered Regularly…"). Skip. [user]
- **Coverage-cue threshold = `primaryCount / pubCount < 0.02` (2%)**, tunable const. Separates Elemento (1/538 = 0.2%, fires) from Dow (4/98 = 4.1%) and ten Hacken (3/44 = 6.8%) which don't. `<2%` structurally only fires for high-output scholars (a 1-pub match needs >50 pubs), so it self-guards against tiny denominators. [my call, user deferred]

---

## Part A — Panel relabeling (the honesty fix; highest value)

**Problem in `a2a0a632`:** every expanded disclosure renders the header **"KEY PAPERS"**, including the research-area panel — but the area exemplars are the scholar's top papers *in that area*, NOT papers that matched the query. That overstates the match. Fix it by labeling the panel for what it actually is, per the EXPANDED line's kind:

| Expanded line kind | Panel header | Subtitle (italic, muted) |
|---|---|---|
| `method` | **MATCHING PUBLICATIONS** | — |
| `publications` (tagged / concept) | **MATCHING PUBLICATIONS** | — |
| `publications` (mention / keyword) | **MATCHING PUBLICATIONS** | — |
| `topic` (research area) | **REPRESENTATIVE PAPERS** | *top papers in this area — not matched to your search* |
| funding (KeyFunding panel) | unchanged ("Key funding" / "Key grant") | see Part E for the mention case |

**Implementation:** add `panelLabel?: string` + `panelSubtitle?: string` to `RepresentativePapers` (replacing the hard-coded "Key paper(s)" string; keep singular/plural where it still reads as a count). `EvidenceLine` sets them from `evidence.kind`: method/publications → `MATCHING PUBLICATIONS`; topic → `REPRESENTATIVE PAPERS` + the subtitle. The truncation count chip ("3 of 8") stays. Render-only.

> Note on `method`: its exemplars are family members, term-highlighted where present — "MATCHING PUBLICATIONS" is defensible (the family is the match) and matches the mockup. Keep it.

---

## Part B — Relevance cues on the primary lead

Two independent cues on the **primary** line, both also **faint** (render the lead label + count in muted, not primary, color). Compute in `ResultEvidence` (the `tier="primary"` path) and thread a `dim` flag + the cue suffix into `MatchAwareReason` / `MatchReason`.

1. **Coverage cue — "· X.X% of output".** When the primary has a count and `count / pubCount < 0.02`:
   - append `· {pct}% of output` (italic, muted) after the existing "N of M publications" suffix, where `pct = round(100 * count / pubCount, 1)` (display `<0.1%` if it rounds to 0.0).
   - faint the lead.
   - Applies to any counted primary kind (method/topic/publications). Funding-promoted and identity-fallback primaries have no pub-coverage → no cue.
2. **Type cue — "· term match only".** When the primary is `publications` with `strength === "mention"` (a keyword-only lead, i.e. no curated method/concept/area outranked it):
   - append `· term match only` (italic, muted).
   - faint the lead.
   - The mockup also gives this lead a distinct grey **KEYWORD** badge — we already render the "Keyword" flavor pill for `mention`; keep that, just add the cue + faint.

**Precedence when both could apply:** keyword-only → show "term match only" (the stronger weakness signal); else low-coverage → show "% of output". Don't stack both.

---

## Part C — Filled-dot reconciliation (changes `a2a0a632`)

Drop the hollow dot. In `result-evidence.tsx` (`tier="lesser"`) and the funding `LesserReason` in `people-result-card.tsx`:
- `publications` mention lesser: `dotClassName` `border-[1.5px] border-[#52525b]` → **`bg-[#52525b]`** (filled grey); keep `weak`.
- funding mention lesser: `border-[1.5px] border-[#2f6b3a]` → **`bg-[#2f6b3a]`** (filled green); keep `weak`; keep the italic "mentions" word.
- Keep the `MentionNote` ("text mention in the abstract, not a curated tag") in the expanded panel for mention rows — the mockup retains it (ten_hacken panel).

Net: dot = category color (always filled); strength is carried by `weak` muted text + the italic "mentions"/note. Update the lesser-tier tests that assert `border-[1.5px]` / `not.toMatch(/bg-\[#/)` accordingly (they currently encode the hollow convention).

---

## Part D — Drop "Also matched" header when there is a single secondary

Mockup `.solo`: when the "Also matched" group has exactly ONE row (one lesser line, or only the funding row), render the dashed divider + that row **without** the "Also matched" header. Two or more → keep the header. In `people-result-card.tsx`, gate the `<div className="mb-0.5 …">Also matched</div>` on `(lesserLines.length + (grants.length>0 ? 1 : 0)) >= 2`.

---

## Part E — Funding-mention abstract snippet (SEPARATE backend PR, not this branch)

For a **mention** funding row, the expanded panel should show the grant + an abstract snippet with the term highlighted (mockup: *"…will apply pooled **CRISPR** screens to identify genetic dependencies driving Richter transformation…"*). This is the proof-of-match for a keyword funding hit and the single most convincing honesty cue — but it needs data the render layer doesn't have.

- **Backend:** `app/api/scholar/[cwid]/grants/route.ts` (+ its loader) must return, for mention-matched grants, a highlighted abstract fragment (OpenSearch `highlight` on the grant abstract field, or a windowed substring around the matched term). Add e.g. `abstractSnippet?: string` (with `<mark>`s) to the `EvidenceGrant` shape.
- **Render:** `KeyFunding` renders the snippet under the grant title (reuse `highlightedTitleHtml` for the `<mark>` pill), below the existing `MentionNote`. Only for the mention case; tagged grants need no snippet.
- **Tagged vs mention:** tagged funding stays as-is (curated, no snippet).
- Spin this into its own PR after A–D land; it carries the only schema/route change and should be reviewed (and load-checked) independently.

---

## Touch points (A–D, this branch)

- `components/search/match-reason.tsx`
  - `RepresentativePapers`: `panelLabel` + `panelSubtitle` props (Part A).
  - `LesserReason`: no signature change (still `dotClassName`), but callers pass filled classes (Part C).
  - `MatchAwareReason` / `MatchReason`: a `dim?: boolean` that mutes the badge/label text (Part B faint), and accept the extended suffix (Part B cues).
- `components/search/result-evidence.tsx`
  - `tier="primary"`: compute coverage + keyword-only, build the cue suffix, pass `dim` (Part B). Lesser pub-mention dot → filled (Part C).
- `components/search/evidence-line.tsx`: derive `panelLabel`/`panelSubtitle` from `evidence.kind`, pass to `RepresentativePapers` (Part A).
- `components/search/people-result-card.tsx`: funding-mention dot → filled (Part C); solo "Also matched" header gate (Part D). The funding lead is not coverage-cued (grants, not pubs).

## Tests to extend

- `tests/unit/result-evidence-card.test.tsx`:
  - Part A: a topic lesser/primary expanded → "Representative papers" + the "not matched to your search" subtitle; a method/publications expanded → "Matching publications".
  - Part B: a primary with `count/pubCount < 0.02` → "% of output" cue + dim; a keyword-only primary → "term match only" + dim; a normal-coverage primary → neither, not dim.
  - Part C: pub-mention lesser dot is filled (`bg-[#52525b]`), not bordered.
- `tests/unit/people-result-card-funding.test.tsx`: funding-mention dot filled (`bg-[#2f6b3a]`); solo-header drop (single secondary → no "Also matched" text; two+ → header present).
- Keep the existing `MentionNote` assertions (Part C retains the note).

## Verify before push

FULL `npx vitest run --maxWorkers=4` (not targeted — catches render-order regressions), `npm run typecheck`, eslint touched files. No flag/app-stack change ⇒ no cdk snapshot regen, no reindex. Re-deploy the branch to staging to eyeball (`gh workflow run deploy.yml --ref feat/1366-evidence-reason-counts -f env=staging`; ~14 min; shared staging — a master push rolls it back, re-roll if needed). Part E ships + load-checks separately.

## Open items / not in scope

- Part E (funding snippet) — separate backend PR.
- Acronym tooltip — declined.
- The CONCEPT atom icon — declined (keep `Waypoints`).
- Prod rollout of `SEARCH_EVIDENCE_REASON_COUNTS` (still staging-on/prod-off) — unchanged, separate decision.
