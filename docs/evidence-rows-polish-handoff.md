# People-card evidence rows — visual polish + collapse hybrid (handoff)

**Branch:** `ui/evidence-rows-polish` (worktree `~/worktrees/sps-evidence-polish`, based off `origin/master`)
**Flag:** these rows render under `SEARCH_EVIDENCE_REASON_COUNTS` (#1366, staging-on / prod-off). All changes here are presentational *within* that already-flagged feature — **no new flag needed**.
**Staging URL used for review:** `https://scholars-staging.weill.cornell.edu/search?type=people&q=crispr`

Triggered by feedback on the People search results: the evidence rows were "busy", the
category dots weren't bright enough, the entity text "blended into each other", and the
research-area panel subtitle was too wordy.

---

## Status

**DONE (committed on this branch, 84 unit tests green):** all the per-row styling below.
**LEFT (approved, not yet built):** collapse the "Also matched" group to a one-line summary
by default, expandable to the full rows. See **Remaining work** at the bottom — this is the
"ship it" target; build it, run the FULL suite, push, open a PR (review only).

Tests green: `result-evidence-card.test.tsx` (58), `people-result-card-funding.test.tsx` (19),
`people-result-card-match-aware.test.tsx` (7).

---

## Component map (where things live)

- **Primary lead row** = `MatchAwareReason` (method/topic/clinical/funding) and `MatchReason`
  (publications/concept), both in `components/search/match-reason.tsx`.
- **"Also matched" lesser rows** = `LesserReason` (`match-reason.tsx`), rendered via
  `ResultEvidence` with `tier="lesser"` (`components/search/result-evidence.tsx`).
- **The card + the "Also matched" group container + the funding lesser row** =
  `components/search/people-result-card.tsx`.
- **Rep-papers / subtitle** = `RepresentativePapers` (`match-reason.tsx`), subtitle string
  derived in `components/search/evidence-line.tsx`.

---

## DONE — changes landed (with exact tokens)

### 1. Brighter, distinct "Also matched" dots
`result-evidence.tsx` (LesserReason `dotClassName`) + `people-result-card.tsx` (funding dot):

| Category | old | new |
|---|---|---|
| Method | `#8a4a1f` | `#c2410c` |
| Research area | `#2c4f6e` | `#2563eb` |
| Concept | `#34408a` | `#7c3aed` |
| Clinical | `#1a5f7a` | `#0891b2` |
| Funding | `#2f6b3a` | `#16a34a` |
| Keyword (stays neutral) | `#52525b` | `#64748b` |

Dots are `aria-hidden` decoration with a text label beside each, so brightening is a11y-safe.

### 2. Category-colored lesser labels (the row's "Method"/"Concept"/… word)
`font-medium` + per-category dark-on-white tone (AA-safe for ~12px text):
Method `#9a3412` · Research area `#1d4ed8` · Concept `#6d28d9` · Clinical `#0e7490` ·
Funding `#166534` · Keyword `#475569`. (Note: these are the **darker** tones than the dots;
the dot is the bright tone, the label is the AA-safe dark tone — both "the category color".)

### 3. Lesser matched-entity weight + underline
The entity (family / area / specialty / concept term / funding-tagged concept) is
`font-[450] text-[#3a3a3a]`. The **dotted underline** (`underline decoration-[rgba(52,64,138,0.55)]
decoration-dotted decoration-1 underline-offset-[3px]`) is added ONLY on the expanded-MeSH-concept
flavors — the **Concept** lesser row and the **Funding · tagged** row. Method/Research area/
Clinical/Keyword/funding-mention get weight only, no underline. The weak `mentions "<q>"`
branch (funding + keyword) is left un-emphasised on purpose (lowest-confidence signal).

### 4. Lesser row density
`mt-1` between rows; `py-[1px]` vertical padding. The disclosure (chevron) lesser rows use a
new `compact` prop on `DisclosureRow` → `py-[1px]` (primary disclosures keep `py-[5px]`).

### 5. Primary row — lighter
`match-reason.tsx`:
- Label (`MatchAwareReason` `<strong>`): `font-semibold` → **`font-[450]`**, color stays `#1a1a1a`.
- Meta/count (`metaColor` in `MatchAwareReason`; the content span in `MatchReason`):
  `#3a3a3a` → **`#8c8c8c`**.
- The matched **term** in the publications-primary (`result-evidence.tsx`) keeps `font-semibold`
  and now carries an explicit `text-[#3a3a3a]` so it stays dark against the lightened meta.
- Chip→label gap is **7px** everywhere (disclosure already `gap-[7px]`; non-disclosure `gap-2` → `gap-[7px]`).
- **Primary chip kept light/pastel** — we tried filled-dark/white and chipless prominent-text
  variants; user chose to keep the existing soft pastel chip.

### 6. Subtitle reword (`evidence-line.tsx`)
`"top papers in this area — not matched to your search"` → **`"Papers mapped to area — not search"`**.

### 7. "Also matched" group separator (`people-result-card.tsx`)
Dropped the dashed divider: `mt-3 border-t border-dashed border-[#e3e2dd] pt-3`
→ **`mt-[9px] pt-[11px]`** (whitespace + the "Also matched" header now do the separating).

### Test updates
`result-evidence-card.test.tsx`: dot-hex matchers (`#c2410c`/`#2563eb`/`#64748b`/`#7c3aed`) and
subtitle (`Papers mapped to area`). `people-result-card-funding.test.tsx`: funding dot `#16a34a`.
Only `result-evidence-card.test.tsx:157` asserts `font-semibold` and that's the **primary** mention
term (unaffected — only lesser rows went to 450).

---

## REMAINING WORK — the collapse hybrid (the "ship it" target)

Approved design (user's `b_lead_umbrella_secondaries.html` mock): the **primary lead row stays
in full** (entity + honest fraction). The **"Also matched" group collapses by default to ONE line**:

```
Also matched   ● Concept   ● Research area   ● Funding            ⌄
```

— colored dots + colored category labels, **no counts, no entities**. A chevron expands it to the
full lesser rows already built (section 1–4 above).

**Why this shape (decided this session):** A "bare count" variant ("Concept (4) · Research area (8) ·
Funding (9)") was **rejected** — it mixes units (4/8 are *of 98 publications*, 9 is *of 29 grants*),
so un-denominated counts invert the real strength and mislead. The collapsed line shows **no counts**
for exactly this reason; the only count on the card is the primary's single-denominator fraction.

### Build notes
1. **State** — add `useState` collapsed (default `true`) to the "Also matched" group in
   `people-result-card.tsx`. Collapsed → render the summary line (header + colored dot+label per
   secondary + expand chevron). Expanded → render the existing `EvidenceLine` lesser rows.
2. **Two chevrons** — the card now has the primary's rep-papers chevron AND the also-matched
   expand chevron. Make them visually distinct so they don't read as one control; the also-matched
   chevron toggles only the secondary group.
3. **Overflow cap** — 3 fits cleanly; if a card has more secondaries, cap the inline labels
   (e.g. show 3 + "+N") so the line can't wrap. `log`/comment whatever cap you pick.
4. **Funding secondary** — remember the funding "Also matched" row is rendered separately in
   `people-result-card.tsx` (not in `result-evidence.tsx`'s lesser switch). Its dot/label must
   appear in the collapsed summary too.
5. **Tests** — add: collapsed-by-default (summary line shown, full entities hidden) + expand reveals
   them. The existing `Also matched` header tests in `people-result-card-funding.test.tsx`
   (presence when ≥2 secondaries, dropped for a lone secondary) still apply — keep that logic.
6. **Dark mode (flag, confirm scope first)** — the colored label hexes in section 2 are tuned for a
   **white** surface (AA there). The user's dark-mode mocks used **amber** for Method etc. The
   People search renders light on staging; if dark mode is genuinely in scope, the labels need
   brighter dark-surface variants (amber / light-green / light-blue / light-violet), contrast-tested
   separately. Do NOT just reuse the light hexes on dark.

### Ship
- Run the **FULL** suite (`npx vitest run --maxWorkers=4`), not just the touched files — repo lore:
  the full suite catches mock-factory / render-order regressions tsc+lint miss.
- Optionally rebase onto latest `origin/master` (advanced to `09ce498d`; no expected conflict —
  this is UI-only, that was cdk/VPC).
- Push; open a **PR (review only — never merge unless the user says "merge it")**, base `master`.
- Deploying this branch to **staging rolls the image that #1366 owns** — coordinate timing before
  `gh workflow run deploy.yml --ref ui/evidence-rows-polish -f env=staging`. No flag deploy needed
  (presentational only, under the existing `SEARCH_EVIDENCE_REASON_COUNTS`).

---

## Gotchas / environment

- **Worktree, not the canonical checkout.** Canonical (`~/Dropbox/GitHub/Scholars-Profile-System`)
  is on `docs/spotlight-pipeline`, ~364 commits behind master — its copies of these files are STALE
  (predate #1366). Always edit in the worktree (`~/worktrees/sps-evidence-polish`, off origin/master).
- `node_modules` and `lib/generated` in the worktree are **symlinks** to canonical; `.env`/`.env.local`
  are copies. **Never `git add -A`** (it commits the `lib/generated` symlink) — stage explicit paths.
- Tests pin exact hex tokens — update the matcher when you change a color.
- Visual review was mock-driven: `file:` is blocked in the Playwright MCP, so mocks were served via
  `python3 -m http.server 8799` from the scratchpad and screenshotted. Final light mock:
  `scratchpad/final.html`; collapse target: user's `~/Downloads/b_lead_umbrella_secondaries.html`.
