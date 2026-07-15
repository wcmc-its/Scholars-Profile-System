# Sponsor card — next steps + search-history strategy (post-#1737)

Grounded at `origin/master`, 2026-07-15. Companion to `docs/2026-07-14-sponsor-reskin-handoff.md`
and `docs/2026-07-15-funding-evidence-honesty-handoff.md` — read their hard-constraint sections
before building against this one. **Re-derive every table before trusting it**: this subsystem's
single documented hazard is confidently-worded notes that have gone stale.

## 0. What just shipped — #1737 (display-faithfulness, Option A)

The card stops laundering stale / contributing-only evidence into confidence, plus the mockup's
layout revisions. Display-only — the ranker was NOT touched (that is #1736).

- Grant investigator role (`PI/MPI/Co-I/…`) threaded per-cwid from the funding index →
  `EvidenceGrant.role` → grants route → `GrantRow`; `expired <year>` for ended awards.
- Stale (>10 yr) lead-artifact year in the warning tone; `middle author → contributing author`
  (sponsor console only — the label map is local, no public-card ripple).
- Three-register hierarchy: strongest concepts full, the rest demote to a one-line supporting row
  that fires no key-paper fetch.
- Bordered cards, rank in its own column, "No evidence" at the card foot, active-filter chips.

Code-verified (typecheck / eslint / vitest, 268 tests). **Not visually verified** — auth-gated.

## 1. IMMEDIATE — verify #1737 on staging

The console is `/edit`-gated, so this could not be seen locally. On staging, with a session cookie,
run a real paste and check the RENDERED card (the last several defects in this subsystem were
rendering defects that passed every test):

- [ ] A grant shows the scholar's role and `expired <year>` / `active to <year>` — and the role is
      THIS scholar's, not the lead PI's (drive a grant where they are Co-I).
- [ ] A decades-old lead paper's year is amber; a middle author reads "contributing author".
- [ ] A 3+-concept scholar shows 2 full blocks + a demoted one-liner. **Known deviation:** a
      2-concept scholar shows BOTH full (no demotion), because demotion is by position, not an
      absolute strength threshold. Decide if that matters.
- [ ] "No evidence …" sits at the card foot; the coverage strip caption no longer carries it.

### Decisions parked for your eye (all reversible)
- **Headshot kept** (rebuild omits it) — one line to drop for the lighter header.
- **Rank as a left column**, not inline — honoured the explicit nit over the rebuild's inline rank.
- **Stale cutoff = 10 yr** — arbitrary; tune once seen.

## 2. Search history — the strategy (a drawer, better titles, the original request)

Three asks, one surface. The history is `data-slot="sponsor-match-history"` in
`components/edit/sponsor-match-panel.tsx`, fed by `GET /api/edit/sponsor-match` (#6d, server-side,
shared, retained-with-notice).

### 2a. Move it into a drawer
- **Today:** an inline `<details>` "Recent searches (N)" between the form and the results, eating
  vertical height above the ranking (the original nit 2 — "giving up too much vertical space").
- **Target:** a right-side slide-out drawer, opened by a `Recent (N)` button beside "Rank
  researchers". The results reclaim the height.
- **Reuse, don't build:** check for an existing Sheet/Drawer primitive (`components/ui/sheet.tsx`
  or a Dialog) before hand-rolling an overlay — this app is shadcn-flavoured. A hand-rolled
  drawer with its own focus-trap/escape/scroll-lock is exactly the over-build to avoid.
- The retention notice (saved · everyone sees them · delete erases for good) moves into the drawer
  header — #6d requires it be said plainly WHERE the searches are listed, not buried.

### 2b. A good title per opportunity
- **Today:** `sponsorAskFrom` builds the title from the top-2 concepts + detected preferences
  ("antibody-drug conjugates, HER2-low breast cancer"). This was a DELIBERATE choice
  (`sponsor-match-contract.ts` ~L535): a title from an LLM would be a **2nd Sonnet call**, and SPS
  has no cheap Bedrock model (Haiku is IAM-excluded on purpose). Functional, but it is a concept
  list, not a name.
- **The missing piece is the SPONSOR.** "Northlake Therapeutics" sits in the paste signature and
  never surfaces. A good title reads "Northlake Therapeutics — antibody-drug conjugates".
- **How, without the 2nd call the contract rules out:** fold a `sponsorName` (and optionally a 3–5
  word focus) into the **existing extractor call** (`sponsor-match-extract.ts`). It already reads
  the whole paste to extract concepts, so returning the org is the SAME call with a richer output
  schema — not the separate call the contract objects to. Title = `{sponsorName} — {top concepts}`.
- **Guards:** absent org ⇒ fall back to today's concept-only title (never fabricate a sponsor —
  absent ≠ a guess). And re-validate that concept extraction does not regress when the schema
  grows: the extractor has a ~0.0074 nDCG noise floor, so measure with **N samples, restarting the
  server between them** (the route caches on `sha256(paste)`), not one run.

### 2c. See the original request, compacted by default
- **Today:** the raw paste is truncated in the history row (full only on `title=` hover) and echoed
  in the collapsed "What we read from the description" readback. Neither gives a readable preview of
  what was actually pasted.
- **Target:** in the drawer entry (and optionally the main view after a search), show the original
  request COMPACTED — first ~2 lines / ~200 chars — with a "Show full request" expander. The
  officer sees the gist without a 400-line forwarded email dominating.
- Reuse the readback's mark-aware rendering for the EXPANDED view if you want the concept
  highlights; the compact preview can be plain text. Keep the existing `break-words` guard — a
  sponsor email routinely carries a 300-char Outlook SafeLinks URL with no break opportunity.

## 3. Remaining loose ends, ranked

1. **#1737 staging verification** (§1) — blocks calling any of this "done".
2. **Search-history drawer + titles + compacted request** (§2) — the next build.
3. **Strip 3-state + "N yrs old" header** — the Option-A fast-follow. Needs per-artifact recency,
   which is lazily fetched per card, so it is either post-resolve client aggregation (a load-in
   flicker) or a per-page recency signal IF pagination lands. Decide only after §1.
4. **#1736 — the ranker.** Fold recency + authorship role into the fusion score so a stale /
   contributing-only scholar drops in RANK, not just reads flagged. The display flagged McGraw; it
   cannot move him off rank 30. This is the real fix; #1737 is the interim.
5. **§4a re-flip `SEARCH_FUNDING_CONCEPT_GRANTS` in prod** — needs a prod image carrying #1735 +
   `cdk deploy Sps-App-prod`. **§4b prod reindex** so #1722's authorship `role` renders in prod.
   (From `docs/2026-07-15-funding-evidence-honesty-handoff.md` §4a/§4b — still open.)
6. **Exemplar-by-composite.** The lead artifact per concept is chosen relevance-only today —
   McGraw's 1989 middle-author lead is the proof (a composite would have demoted it). Pick by
   `relevance × role × recency` in `searchPeople`/`selectEvidence`. It is **shared with the public
   People card**, so it is its own reviewed change, not a sponsor-only tweak.
7. **"via keyword / via MeSH X" provenance** on the artifact summary line — cheap
   (`keyPaperMentionOnly` already distinguishes them), skipped in #1737 to keep the diff tight.
8. **Artifact-level "also ranked".** Scholar-level today (`panel` coverage line). An artifact
   cross-tag ("this paper also supports X") is the larger piece funding-honesty §4e warns off.

## 4. The rules that keep biting (carry-over — do not relearn the hard way)

- A flag can activate correctly and the card still LIE — verify the CLAIM on the page, not that the
  mechanism fired. "Soaked with no complaint" is not a precision check.
- Declared-but-inert is this subsystem's #1 bug (`caveat`, `abstain`, `prefBoost` all shipped
  inert). Before rendering any field, grep who WRITES it and who READS it.
- No cheap Bedrock model. A "cheap LLM call" is a 2nd Sonnet call — fold new outputs into the
  EXISTING extractor call instead of adding one.
- Absent ≠ zero, ≠ "common", ≠ a default role. Every optional field.
- The console is auth-gated — visual-verify on STAGING, never claim it from a local check.
