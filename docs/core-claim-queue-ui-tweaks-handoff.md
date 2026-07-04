# Core-claim queue — UI tweaks handoff

**Status:** PR #1235 **MERGED to master** (squash, 2026-06-23). Follow-ups tracked in **issue #1239** (segmented tabs + populated Rejected list, true bulk-confirm endpoint, MeSH chips, ED name-enrichment).

This handoff is for the **UI polish pass** next session — the functional redesign is done and live on master.

## What shipped in #1235
- Card restyle: combined-likelihood bar + "Why this surfaced · N of 4 signals fired" + per-signal evidence rows.
- Evidence meter: **fixed tier per signal type** (ack=Direct/4, co-author=Strong/3, LLM=Moderate/2 regardless of score, repeat-user=Weak/1), raw value (8/10, 45%) as a secondary readout. Fixed-width, vertically-centered meter column.
- Mechanics: **uncertain-first** default sort (+ Likelihood / Strongest signal / LLM options); **Confirm N high-confidence** bulk (≥0.90 band, client-side fan-out of the single-claim endpoint behind a `window.confirm` guard); per-row **Revoke** on the Confirmed list (human claim → `revoked`, engine-confirmed → `rejected`, via the loader's new `claimed` flag).
- PMIDs surfaced on every card (as the PubMed link) + Confirmed rows + CSV.
- **Download CSV** citation list (client-side `toCsv`, no route): PMID/Title/Authors/Journal/Year/DOI/Status/Likelihood/Citation.
- **Co-author name resolution fix**: case-insensitive + byline-backed (was showing bare CWIDs for resolvable people). A CWID shows only when no name exists anywhere.

## Files
- `components/edit/core-claim-queue.tsx` — the client component (all UI lives here: `CandidateCard`, `SignalRow`, `StrengthDots`, `Byline`, `CoauthorLead`, `ConfirmedRow`, `QueueControls`, pure `buildSignals`/`compareBySort`).
- `lib/api/core-queue.ts` — loader (`CoreQueueRow`, `partitionCoreQueue`, name resolution, RCR select).
- `app/edit/core/[coreId]/page.tsx` — the real authed route (superuser/owner/curator of the core).
- Tests: `tests/unit/core-claim-queue.test.tsx` (33), `tests/unit/core-queue.test.ts` (12).

## ⚠️ Not yet eyeballed on the real page — do this FIRST
All verification was via a throwaway dev-preview route + curl + 51 unit tests; Playwright's browser was locked, and the real route needs SSO + seeded cores data. **The real `/edit/core/[coreId]` page has not had human/visual eyes on it.** Start the next session by rendering it (staging via SSO superuser-impersonate, or locally if the `scholars` DB has cores rows) and comparing against the mockup before tweaking. Mockup was treated as *direction, not pixel-exact*, so expect small deltas.

The dev-preview (`app/dev/core-queue-preview/page.tsx`) was **uncommitted and removed with the worktree** — recreate it if useful: a server page rendering `<CoreClaimQueue>` with two sample `CoreQueueRow`s (it imports only the `CoreQueueRow` *type*, so it needs no DB/auth). It's the fastest way to iterate on visuals without SSO.

## UI tweak candidates (the actual ask)
- [ ] **Spacing / density vs mockup** on the real page — card padding is `px-5 py-4`, bar `my-4`, signal rows `pt-3`. Tune after eyeballing.
- [ ] **Strength meter** — dots `size-1.5` (6px), `gap-1`, column `w-20`; tier on its own line + raw value beneath. Adjust dot size/gaps/width if cramped or loose.
- [ ] **Typography** — body 13px / meta 12–13px / meter labels 11px. User has historically wanted to eyeball exact font sizes; confirm.
- [ ] **Byline chip** — currently shows the *published* short form (`Okafor M`) as a tinted link + full name in the hover tooltip. DECIDED to keep as-is (don't rewrite the real byline), but flagged as a possible change to the full name inline. Revisit only if requested.
- [ ] **Co-author name form** — uses `preferredName` (consistent with the app). Offered `fullName` (more verbose); user kept `preferredName`. One-line loader switch if reconsidered.
- [ ] **Bulk-confirm dialog** — uses native `window.confirm()`. Consider a styled inline confirmation / count summary instead.
- [ ] **MeSH chips** in the Details expander (mockup showed them) — needs a `mesh` field threaded through the loader (also in #1239).

## Build/verify recipe (next session)
- Branch off **fresh `origin/master`** (now includes #1235). The canonical checkout sits on the drifted `docs/spotlight-pipeline` (272+ behind) which **lacks the cores feature** — don't work there.
- If using a worktree (Dropbox repo): symlink `node_modules` + `lib/generated/prisma`, copy `.env*`, OR `npm ci` + `npx prisma generate`. **Prisma client must be generated from master's schema** (the drifted branch's client lacks `core`/`coreClaim`).
- Dev server: **`npx next dev` (webpack), NOT `--turbopack`** — Turbopack rejects symlinked `node_modules`. Long-lived: `nohup … & disown`, skip dev-server-track (Stop hook reaps tracked PIDs). Port 3002.
- Tests: `npx vitest run tests/unit/core-claim-queue.test.tsx tests/unit/core-queue.test.ts --maxWorkers=4`.
- Gotchas: CWIDs compared **case-insensitively** (lowercase) everywhere; `vis-network`/`vis-data` may be absent from a symlinked `node_modules` → 5 unrelated `tsc` errors in `center-collaboration-tab.tsx` (env-only, ignore).
