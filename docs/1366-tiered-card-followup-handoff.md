# Handoff — #1366 follow-up: tiered card + de-dup/empty-disclosure fixes

**Date:** 2026-06-30 · **Branch:** `feat/1366-evidence-reason-counts` · **PR:** #1368 (open, staging-verified)
**Worktree:** `~/worktrees/sps-1366` · **Flag:** `SEARCH_EVIDENCE_REASON_COUNTS` (staging-on/prod-off)

## Where things stand

The **flat-stack** version of #1366 is implemented, full-vitest-green (6343), CI-green, and **verified live on staging**: every People hit emits `evidenceLines` (method / tagged-concept / research-area as co-equal first-class lines, each "N of M publications"; keyword fallback; clinical label-only), counts populate from precomputed `methodFamilyCounts`/`areaCounts` + existing `reasonCounts`, exemplar de-dup wired, `osRoundTrips=4` (no per-card fan-out). See `docs/1366-evidence-reason-counts-spec.md` for the full mechanism and `project_1366_evidence_reason_counts` memory for the staging-deploy runbook.

This handoff is the **next iteration**, agreed with the user after reviewing the flat version on staging. Two parts: (1) a tiered-card render redesign, (2) two real bugs to fix. **Part 2 is the substantive work.**

---

## Part 1 — Tiered card (render-only; backend untouched)

**Mockup:** `~/Downloads/tiered_card_expand_lesser_signals.html` (+ two screenshots on the user's Desktop, 2026-06-30 12:00).

**Model:** one **prominent primary** signal + a compact **"Also matched"** group, instead of N co-equal badge rows.
- **Primary = `evidenceLines[0]`** — render as today (badge chip + label + "· N of M publications" + chevron → KEY PAPERS).
- **"Also matched" = `evidenceLines[1..]`** — under a dashed divider + muted "Also matched" header; each row = a small colored **dot** (not a badge) + muted label + abbreviated count ("· 2 of 44") + small chevron → its own KEY PAPERS inline.
- **Dot styling encodes signal strength:** filled dot = curated tag (concept/area), **hollow dot = literal mention (keyword)**, plus an italic note on a mention panel: *"text mention in the abstract, not a curated tag."* (This is the honesty win the flat version lacks.)

**Decisions locked with the user:**
- This is a deliberate **reversal of "all three are co-equal first-class."** Going to **one lead + the rest demoted to "Also matched"** (still shown, with counts + disclosures — just visually subordinate). The user agreed; the height/noise of the co-equal stack was the problem this fixes.
- **Funding does NOT go into "Also matched."** Keep the existing separate Funding row (`MatchAwareReason kind="funding"` + `KeyFunding`) exactly as-is, below the evidence block.
- **Edge cases:** single matched signal → render only the primary, **no divider / no "Also matched"**. Keyword-only → the keyword line IS the primary. Clinical → an "Also matched" dot (label-only, no count).

**Implementation:** render-only. `evidenceLines` is already precedence-ordered, so `[0]`=primary and `[1..]`=lesser maps 1:1 with **zero backend change**. Reuse `<EvidenceLine>` with a `variant: "primary" | "lesser"` prop (or a small sibling `<LesserEvidenceLine>` for the dot/compact style). Counts, per-line disclosure, lazy fetch, de-dup all carry over. Touch points: `components/search/people-result-card.tsx` (split `lines[0]` vs `lines.slice(1)`, add the "Also matched" wrapper), `components/search/evidence-line.tsx` (variant styling), maybe `match-reason.tsx` (a compact dot row vs the badge row). Styling tokens are in the mockup HTML.

---

## Part 2 — Two bugs (same root cause)

### The root cause
Exemplar de-dup currently **filters AFTER the top-N fetch**: each line's lazy route (`method-exemplar`, `key-paper`) fetches its top papers, then the route drops pmids already claimed by a sibling (`&exclude=`). So a line can fetch 3 papers, have all 3 claimed by a higher-priority sibling, and render an **empty** KEY PAPERS panel — **while its count still reads "2 of 44."** That is simultaneously:
- **Bug A (empty disclosure):** "I expand the chips and there are no results — that shouldn't be a thing."
- **Bug B (de-dup vs undercount):** "don't show duplicates, yet don't undercount matches / give the viewer the wrong idea" — count says 2, panel shows 0.

Current de-dup impl: a card-shared `claimedPmids` ref in `evidence-line.tsx`; each lazy fetch sends `&exclude=<claimed>`; routes (`app/api/scholar/[cwid]/method-exemplar/route.ts`, `app/api/search/key-paper/route.ts`) `.filter()` excluded pmids out of the **already-fetched** list (post-load). `canExpand` for method/area is `isLazyExemplar` = **always true** (optimistic), so the chevron shows even before the fetch resolves empty.

### The fix (recommended — satisfies all three user constraints with NO duplicates)
1. **Counts stay TRUE** — they already are (precompute/agg, never reduced by de-dup). Don't touch them. This is "don't undercount."
2. **Move `exclude` from post-filter INTO the loader query** — `loadMethodExemplar` / `loadTopicExemplar` (in `lib/api/search.ts`) and `fetchKeyPaper` add a `must_not: { terms: { pmid: <exclude> } }` so each line pulls its top-N from the **non-claimed pool**. Now each line gets distinct papers up to availability (not under-filled by claimed top picks). This is "no duplicates" without gratuitous emptying.
3. **Drop the chevron when a disclosure genuinely resolves empty** — for a line whose papers are ALL legitimately shown under a higher-priority sibling (count ≤ overlap), don't offer an empty panel. Keep the counted line; drop `canExpand` (or show a "view in profile" affordance). Fix `canExpand` for method/area so it isn't unconditionally `true` — gate on "fetch resolved with ≥1 paper OR not yet fetched," same as the key-paper path already does (`!(status === "done" && papers.length === 0)`).

This yields: every counted line keeps its true count; no paper appears under two disclosures; **no empty panels** (a line with no distinct papers left just has no chevron — its evidence is honestly shown under the stronger signal).

### Open decision for the user (confirm before building Part 2)
The recommended fix means a lesser line can show a count but **no expandable papers** (because its papers are surfaced under the primary). If the user would rather **every line stay expandable**, the alternative is to **allow a shared paper** when a line would otherwise be empty (relax strict de-dup) — counts stay true, but a paper may appear under two disclosures. This contradicts the earlier "no duplicate exemplars" rule; the user's new "don't mislead/undercount" framing suggests they may now prefer honesty-over-strict-dedup. **Ask which wins when the two genuinely conflict:** (a) drop the chevron (recommended, no dups), or (b) allow the duplicate paper (every line expandable).

### Also verify while here
- Reproduce Bug A on staging (expand the research-area / lesser chips on a `crispr` card — e.g. Elisa ten Hacken — and confirm whether the empty panel is the exclude-emptying case or a separate fallback-link rendering issue). The method/area `RepresentativePapers` is *supposed* to degrade to a profile-section link when empty (`fallback` prop) — check that link actually renders for the lesser lines, or whether it reads as "no results."

---

## Technical reference (so you don't re-discover)

**Files:** `lib/api/result-evidence.ts` (`selectEvidenceLines`, the union + `count` fields), `lib/api/search.ts` (`buildHitEvidenceInput`, emits `evidenceLines`; `loadMethodExemplar`/`loadTopicExemplar`/`fetchKeyPaper` live here for the query-level exclude), `lib/search-index-docs.ts` (`methodFamilyCounts`/`areaCounts` precompute + `PEOPLE_INDEX_SELECT.publicationTopics`), `components/search/evidence-line.tsx` (per-line disclosure + `claimedPmids` + `&exclude=`), `components/search/people-result-card.tsx` (renders the list + funding row), `components/search/result-evidence.tsx` (count suffix), `components/search/match-reason.tsx` (`MatchAwareReason` `prefix`/`suffix`), `components/search/people-result-card-streamed.tsx` (threads `evidenceLines`), the two routes, `cdk/lib/app-stack.ts` + `lib/api/search-flags.ts` (flag).

**Staging deploy runbook (verified):**
- Roll branch image (app+ETL): `gh workflow run deploy.yml --ref feat/1366-evidence-reason-counts -f env=staging` (~13 min; rolls BOTH images).
- Flag is already deployed on staging (additive cdk deploy done). ⚠️ If you re-`cdk deploy Sps-App-staging`: it will try to **strip `SEARCH_PEOPLE_CONCENTRATION=on`** (the live `exp/concentration-exponent` experiment) — do an **additive** deploy: temporarily add that flag to `app-stack.ts` (uncommitted), deploy, revert. Verify additivity with a python **set-diff** of synth-template env names vs `aws ecs describe-task-definition` (the positional `cdk diff` array output is misleading).
- People reindex (needed only if ETL doc fields change): one-off `aws ecs run-task --cluster sps-cluster-staging --task-definition sps-etl-staging:<rev>` where `<rev>` is registered from `sps-etl-staging:15` JSON with the image pinned to your **FULL 40-char `git rev-parse HEAD` SHA** (deploy.yml tags `${{ github.sha }}`; the **short SHA does NOT exist** → `CannotPullContainerError`). Network: `subnets=[subnet-019afebef588ee4b3,subnet-03de6e3dfe190288b],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED`. Override: `containerOverrides=[{name:etl,command:["npm","run","search:index:people"]}]`. Part-2 render-only work needs **no reindex** (data already on `scholars-people-v13`).

**Gotchas:** push-to-master **auto-deploys staging** (a `#1369` docs merge clobbered the image roll mid-session) → shared staging is contended; re-roll and verify quickly, but the reindexed **data persists**. Eval without a browser: the staging search API is public-from-WCM — `curl -4 -s 'https://scholars-staging.weill.cornell.edu/api/search?type=people&q=crispr&_cb=<rand>' | jq '.hits[]...'`. Perf gate: `osRoundTrips` on the `search_query` SLI must stay flat (it's `4` for a 20-hit page; a per-card fetch would balloon it).

**Verify before push:** FULL `npx vitest run --maxWorkers=4` (not targeted), `npm run typecheck`, eslint touched files; if a flag/app-stack change, regen cdk snapshot (`cd cdk && npm ci && npm test -- -u`). Extend `tests/unit/result-evidence-select.test.ts` + `tests/unit/result-evidence-card.test.tsx`.
