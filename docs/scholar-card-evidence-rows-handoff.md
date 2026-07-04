# Handoff — Generalized evidence rows on the scholar search card (incl. Funding)

For a fresh session. Design is **done and decisions are resolved**; **no code written yet**. This is the
pick-up point for implementation.

## Source of truth
- **Spec:** `docs/scholar-card-evidence-rows-spec.md` — read it first. §7 lists the six RESOLVED decisions; §4 the design; §3 the data reality that shaped it.
- **Visual mocks** (the design as agreed): `…/scratchpad/*.html` from the design session —
  `grants-funding-badge.html`, `grants-stacked-vs-inline.html`, `evidence-catalog.html`,
  `generalized-evidence.html`, `row-order.html`. They were served on `http://127.0.0.1:8814/` (server now stopped; re-serve with `python3 -m http.server` from the scratchpad dir).

## What this is, in one paragraph
Generalize the existing "key papers" disclosure into one component — **every "why this scholar matched" row is `[type badge] claim ⌄ → key records`**, where records are papers / grants / trials by axis. The new asks: surface a scholar's topic-matching **grants** (new Funding axis) and fold **clinical trials** in as the Clinical axis's records. Funding stops being special — it's just an axis whose records are grants.

## Resolved decisions (from spec §7)
1. Row order: **Publications → Method → Clinical → Funding** (Publications first).
2. Keep **"of Y"** denominator — Publications only.
3. **No row cap** (hide-when-empty bounds it).
4. Funding badge = **green `#eef6ef`/`#2f6b3a` + Banknote** (WCAG-AA at 10px is a build gate).
5. Clinical row: **chevron only when trial-count ≥ 1**.
6. Pub-row badge **scoped to the Scholars result card only** (opt-in prop), not app-wide.

## Grounded code map (all on `origin/master`)
- `components/search/match-reason.tsx` — `MatchBadge` (method/clinical/area kinds, literal hex), `DisclosureRow` (the chevron toggle to reuse), `MatchReasonKind`. **Add `funding` kind here.**
- `lib/api/result-evidence.ts` — `ResultEvidence` union + `selectEvidence()` (picks ONE today; precedence drives §4.4/§4.5).
- `lib/api/search-funding.ts` — `searchFunding`; field boosts `title^4·sponsorText^2·peopleNames^1·abstract^1·keywordsText^1` (text match, not MeSH).
- `lib/search.ts` — `fundingIndexMapping`; per-scholar key = **`wcmInvestigatorCwids`** (keyword array). `grantCount`/`hasActiveGrants` already on the people hit — mirror this for the new trial-count field.
- `app/api/scholar/[cwid]/method-exemplar/route.ts` — **template** for the new `/grants` and `/trials` lazy fetchers.
- `etl/clinical-trials/{export,import}.ts` — clinical-trials ETL is built → `clinical_trial` + `person_clinical_trial`. Per-scholar trials live there; not yet on any read API.
- `app/api/search/route.ts` — `type=funding` branch; `GET /api/search?q=…&type=funding`.
- `components/ui/entity-badge.tsx` + `app/globals.css` — the broader 7-hue entity palette (context for the badge family; the funding hue is added in `match-reason.tsx`, not here).

## Build plan (smallest-diff order)
1. **Funding badge kind** in `MatchBadge` (green + Banknote). Run the WCAG-AA contrast check at 10px; darken ink if needed.
2. **`/api/scholar/[cwid]/grants?q=…`** lazy fetcher — `searchFunding` + `term wcmInvestigatorCwids=cwid`, return top N. Mirror `method-exemplar`.
3. **`EvidenceRow`** generalization — `{kind, flavor, claim, fetchRecords}`, always-expandable `DisclosureRow`, hide-when-empty. Wire the Scholars card to render rows in the §4.4 order.
4. **Pub-row flavor badge** (area/concept/keyword) behind an opt-in `badged` prop — Scholars card only. Keyword/concept text treatment per §4.5 (literal in quotes; expanded MeSH indigo + dotted underline).
5. **Clinical trials**: add cheap per-scholar **trial-count** to the people hit projection (like `grantCount`); `/api/scholar/[cwid]/trials` fetcher over `person_clinical_trial`; chevron gated on count ≥ 1.
6. Consider a **feature flag** for staged rollout (repo pattern: `SEARCH_*` flags; wire in `cdk/app-stack.ts` per-env, not just `.env.local` — see flag-parity gotcha).

## Verification gates (don't claim done without these)
- WCAG-AA on the funding hue.
- `vitest` for `EvidenceRow`, both new fetchers, and flavor-precedence selection (tsc won't catch rendered-order/mock-factory regressions — run the suite before push, `--maxWorkers=4`).
- Confirm `person_clinical_trial` is populated in the target env before shipping the Clinical→trials row.
- Funding precision spot-check on 2–3 more topics across p50/p10 scholars (cardiology already passed: 10/11 on-topic).

## Gotchas
- **Branch drift:** this checkout was ~342 commits behind `origin/master`. Re-ground every symbol/line via `git show origin/master:<path>` (or branch a fresh worktree off `origin/master`) before trusting it. **Base the implementation branch on fresh `origin/master`, not this branch.**
- **Staging search API is public** (no SSO) — re-verify any data figure cheaply, e.g.
  `curl -s "https://scholars-staging.weill.cornell.edu/api/search?q=cardiology&type=funding&page=0"`.
- **Data reality (don't re-litigate):** per-scholar matching grants are sparse — **p50 = 1 across all topics**, ~78% of cards show no grant row. This is why: always-dropdown, hide-when-empty, no eager "X of Y" count.
- **Relevance sort: leave alone.** Grants already feed `PEOPLE_PROMINENCE_GRANT_WEIGHT` (`0.5·log1p(grantCount)`). Out of scope.
- **Research Area is not a row** — it's a Publications flavor badge.

## Cleanup TODO (session artifacts I left behind)
File-deletion is blocked for me in this env — please remove these stray files (e.g. `! rm <path>`):
- Screenshots in repo root: `grants-mock.png`, `grants-mock2.png`, `grants-recommended.png`, `grants-funding-badge.png`, `grants-stacked-vs-inline.png`, `evidence-catalog.png`, `generalized-evidence.png`, `generalized-evidence2.png`, `row-order.png`, `row-order2.png`, `live-comppath.png`
- `.playwright-mcp/` (Playwright snapshot dumps)
- The HTML mocks live in the session scratchpad (outside the repo) and don't need cleanup.
