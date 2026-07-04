# Funding Matcher redesign — handoff & next steps

**As of:** master tip `d720fb7b` (2026-06-22). **Tracker:** SPS #1218 (open). **Upstream:** ReciterAI #269 (open).

The UI redesign (your mockup) is **fully merged across 5 PRs**. What remains is verification, one structural data fix, the grant-history follow-up, and prod rollout. This doc is self-contained — a fresh session can execute from here.

---

## 1. What shipped (master)

| Layer | PR | Squash | What |
|---|---|---|---|
| Corpus | ReciterAI #269 / #244 | — | `pipeline_grants` engine + curated CSV → **653 `GRANT#` items in staging** `reciterai` table |
| Data + display | #1222 | `06248079` | matcher returns `careerStage` + per-topic pub evidence; pure `lib/match-display.ts` (`topicFitScores`, `stageFit`, `researcherBlurb`) |
| Card + rows | #1223 | `d9a871a3` | researchers route → one-fetch view-model; opportunity card + redesigned rows (avatar/title/dept/blurb/0–100 bar/stage badge) |
| Browse-first | #1230 | `fb1527e2` (+cdk `8a2f580e`) | `GET /api/opportunities` (curated-first, grants.gov off by default); browse list replaces the ID box |
| Filters + export | #1232 | `8b34616f` | dept + career-stage filters; multi-select CSV export (client-side `lib/csv`) |
| Nav relocation | #1233 | `d720fb7b` | "Researchers for funding" top-nav link (client-gated via session `canAccessFundingMatcher`) + staff banner |

**Key files:** `lib/api/match-researchers.ts` (ranking), `lib/match-display.ts` (display + CSV), `components/edit/find-researchers.tsx` (browse + matched view), `app/api/opportunities/route.ts` (browse list), `app/api/opportunities/[opportunityId]/researchers/route.ts` (view-model), `app/edit/find-researchers/page.tsx` (page + banner), `components/site/header-auth-slot.tsx` + `app/api/auth/session/route.ts` (top-nav link), `cdk/lib/edge-stack.ts` (CloudFront behavior for `/api/opportunities`).

**Flags:** `DEVELOPMENT_ENABLED` (master gate; staging on, **prod off**) → gates `isDeveloper`. `ACCOUNT_CONSOLE_NAV_RESTRUCTURE` → relabels the in-console tab.

---

## 2. NEXT STEPS (ordered)

### Step 1 — Staging visual verify  *(do first; this is the real QA gate)*
Nothing has been rendered yet — all merges were CI-only. Walk the whole flow on **`https://scholars-staging.weill.cornell.edu`** (SSO; you're a superuser):
1. Confirm **"Researchers for funding"** appears in the top nav.
2. Open it → the **browse list** defaults to ~199 curated awards (grants.gov off); search works; "Include Grants.gov" toggle.
3. Click a topical award (e.g. paste/search "Clowes" → `wcm_curated:aacr-g-h-a-clowes-award-...-f9d6e9`) → **opportunity card** (id chip · "Parsed from …" · mechanism·due·sponsor · matching-on chips) + **ranked rows** (avatar/title/dept/blurb/topic-fit 0–100/stage badge).
4. **Filters** (dept, career stage), **select-all + Export (N)** → CSV downloads.
5. **Banner** shows "Available to research-development staff. You're viewing as a superuser for testing."
6. **Judge quality:** are the ranked people sensible? Are topic-fit numbers believable? (See objection #3.) Eyeball the banner color (mockup is blue; current uses the neutral `info` Alert).

### Step 2 — Schedule the DynamoDB projection  *(structural; closes the lag bug)*
ReciterAI writes to DynamoDB continuously, but `etl:dynamodb` (DDB→MySQL `opportunity` table) only runs when fired by hand — so new opportunities **404 until re-projected** (the bug we hit with `grants_gov:356342`).
- **First: confirm** whether `etl:dynamodb` is part of the nightly cadence already, or standalone. The nightly ETL is reportedly blocked at `etl:ed` (#443, VPC TGW), so even if `etl:dynamodb` is in the chain it may not run.
- If unscheduled: add an EventBridge rule in the **Sps-Etl** cdk stack to run `etl:dynamodb` daily — model it on the existing scheduled-ETL pattern (`curationBackupScheduleEnabled`, PR #1039: rule + state machine + dedicated flag, gated on creation). Operator deploys (`cdk deploy Sps-Etl-staging`).
- **Manual re-projection recipe** (until scheduled) — in-VPC run-task (from `docs/OPERATIONS-RUNBOOK.md` §4 #9):
  ```
  aws ecs run-task --cluster sps-cluster-staging --task-definition sps-etl-staging \
    --launch-type FARGATE \
    --network-configuration 'awsvpcConfiguration={subnets=[subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3],securityGroups=[sg-09b494047547ea148],assignPublicIp=DISABLED}' \
    --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","etl:dynamodb"]}]}'
  ```
  Watch `/aws/ecs/sps-etl-staging`; success line: `opportunity upserts complete: N rows`.

### Step 3 — Grant-history join  *(the big follow-up — unlocks 3 mockup features at once)*
All deferred because they need one join: the scholar's grant/degree history.
- **Data already in the model:** `Scholar.grants` (Grant[]), `Scholar.nihProfiles` (PersonNihProfile), `Scholar.educations.year`. `lib/career-stage.ts` already has `yearsSinceTerminalDegree()` (the ESI window = `DEGREE_EARLY_MAX_YEARS = 10`).
- **Where:** extend the scholar query in `rankResearchersForOpportunity` (`lib/api/match-researchers.ts`) to load grants/educations; compute and attach `esiEligible` + `fundingStatus` to `RankedScholar` (post-ranking, like title/dept). **First check the `Grant` model** for active/award-date/mechanism fields to define "currently funded" + "no prior major R-grant."
- **Unlocks:**
  - **ESI clause** in the blurb — `researcherBlurb` in `lib/match-display.ts` has a TODO comment for this; add "ESI-eligible (N yrs since terminal degree)".
  - **Funding-status filter** — add the third dropdown in `find-researchers.tsx` `Results` (alongside dept/career), client-side like the others.
  - **"Also surfaced under their own 'Grants for me'"** — cross-ref the existing forward matcher (`lib/api/match-opportunities.ts`) per candidate. ⚠️ Running the forward matcher per researcher is **expensive** — decide: batch it, cache it, or compute a cheaper "is this opp in their top-N" signal. This is the one with a real design choice.

### Step 4 — Prod rollout  *(gated)*
1. **Prod corpus:** the 653 opportunities are in the **staging** `reciterai` table (acct 665083158573). Prod is a separate table — ReciterAI must publish `GRANT#` to prod, then run `etl:dynamodb` against **prod** (`sps-cluster-prod` / `sps-etl-prod`).
2. **Roll a fresh prod app image** carrying this code (prod image lags master; needs the reviewer-approved `Deploy` workflow_dispatch `env=prod`, not a flag-only deploy).
3. **Flip `DEVELOPMENT_ENABLED=on` on prod** (cdk app-stack) so dev-role staff (not just superusers) see the link + page.
4. Re-verify on prod.

---

## 3. Smaller follow-ups / accepted trade-offs (from the objections review)
- **Topic-fit calibration** (`topicFitScores`, `lib/match-display.ts`): currently relative-to-max so the top match is always 100. We now have real scores on staging — calibrate to an absolute curve if "everyone's a 90+" reads as inflated. Knob is isolated in that one function.
- **Filters run after the server limit** — a dept filter on "show 25" can read as "nobody" when matches exist past rank 25. Consider server-side filtering if this bites.
- **"Include Grants.gov" is half-functional** — browse caps at 200, curated-first, so grants.gov items are mostly invisible when toggled on (search still finds them). Fine given grants.gov is deprioritized.
- **Curated CSV rots** — `pipeline_grants/wcm_curated_opportunities_2026-04-22.csv` is a dated hand-maintained file with no refresh pipeline. Assign an owner / cadence.
- **Mockup gaps not yet built:** "Targets ESI" / "Clinical or basic" opportunity flags (derive from `eligibilityRaw`/`synopsis` in `grant-opportunity-mapper.ts`); "Parsed from NIH Guide" (we label the real source — needs a net-new NIH-Guide parser in ReciterAI, ~2–3 days, or relabel).
- **Page h1 vs nav label:** nav link is "Researchers for funding"; page `h1` is flag-gated "Funding matcher". Unify if desired (entangles `ACCOUNT_CONSOLE_NAV_RESTRUCTURE` + the admin-subnav tab).

---

## 4. Gotchas (carried from build)
- **Worktree off master MUST `npx prisma generate`** — the canonical checkout's client is on stale `docs/spotlight-pipeline` and lacks the `opportunity` model + recent schema. Symlink `node_modules`, copy `.env*`, generate the prisma client fresh.
- **Local full-suite shows 1 FAIL** = `edit-page.test.tsx` Radix-avatar mock artifact (`node_modules/@radix-ui/react-avatar`) — environment-only; CI is green. Ignore.
- **A NEW query-reading `route.ts` trips the edge-stack route-coverage guard** (`cdk/test/edge-stack.test.ts`; `KNOWN_UNCOVERED_QUERY_ROUTES` is empty by design). Add a CloudFront behavior in `cdk/lib/edge-stack.ts` + bump the count/order ratchet tests + `cd cdk && npx jest edge-stack -u`. (Client-side features like the CSV export avoid this.)
- **`gh pr checks --watch` can exit 0 on a network drop while a check is red** — always re-poll `gh pr checks <pr>` fresh before merging.
- **cdk tests need `cdk/node_modules`** (separate package) — symlink from canonical.
