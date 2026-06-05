# Handoff — Unmatched PubMed COI on /edit

Pick-up doc. Written 2026-06-04. Read this first, then
`coi-pubmed-unmatched-feasibility.md` (design + verdict) and
`coi-pubmed-phase0-precision-study.md` (validation plan).

> **Status update (2026-06-04, this PR).** §A below — the self-only `/edit` panel
> + disavow API — is now **BUILT and ships DORMANT** behind `SELF_EDIT_COI_GAP_HINT`
> (`off` in both envs). The feature is fully integrated with master's #748 `/edit`
> console polish (clean rebase; `tsc` 0 errors · full `vitest` 3093/3093). It does
> **nothing** until the §C gates clear and the flag is flipped — see the
> pre-enable runbook added to §C. The original "UI is not built" wording below is
> superseded; everything else (constraints, blockers, open questions) still holds.

## TL;DR

The **backend data pipeline AND the self-only scholar UI are built, typechecked,
and tested end-to-end**; the feature is **intentionally gated** (flag `off`,
ETL unscheduled) until §C clears. The idea: surface relationships named in a
scholar's own PubMed competing-interest statements that aren't in their official
WCM disclosure, on the self-only `/edit` surface, with a match-confidence tier
and a durable disavow.

- Verdict: **BUILD-GATED**. Built; the remaining gating risk is institutional, not technical.
- Everything lives on branch **`explore/coi-pubmed-unmatched`** in worktree
  `~/worktrees/sps-coi-pubmed`.
- Verified: `tsc --noEmit` 0 errors · full `vitest` 3093/3093 · `prisma validate`/`generate`
  clean. (`next build` + `cdk synth` are verified by CI on the PR, not locally.)

## Non-negotiable constraints (carry these forward)

These came out of the adversarial governance review and must hold in every later stage:

1. **Self-only.** Surfaced ONLY to the scholar themselves, enforced server-side
   (`effectiveCwid === targetCwid`), never UI-hiding. Never curators, superusers,
   public, search index, or any compliance feed.
2. **Candidate, not verdict.** Persisted rows are a candidate + the scholar's own
   review status. No `undisclosed` boolean, no ranking, no "failed to disclose."
3. **Suggest, don't accuse.** Forbidden words: undisclosed / failed to disclose /
   missing / violation. Always show the **verbatim source sentence**. Confidence is
   a qualitative **tier (High/Medium/Low), never a percentage**.
4. **Recall-biased.** When in doubt, suppress (a false gap costs more than a missed one).
5. **SPS is not the COI system of record.** No in-app COI editing; the scholar's
   action routes to WRG / the Conflicts-Management-Office, never an auto-notification.

## What's built (and verified)

Commits on the branch (newest first):

| Commit | What |
|---|---|
| `d077a13` | Daily incremental COI-gap ETL + `CoiGapCandidate` (disavow-able persisted candidates) |
| `17437dc` | Phase 1 ingestion: `PublicationConflictStatement` model + backfill from `reporting_conflicts` |
| `8356617` | TS pipeline port `lib/coi-gap/pipeline.ts` + 27 vitest tests |
| `e45a564` | Track A offline precision harness (`scripts/coi-phase0/`) + results |
| `398ca29` | Phase 0 precision-study plan |
| `4a3967d` | Feasibility & design exploration (the BUILD-GATED verdict) |

### Data flow (all built)

```
PubMed <CoiStatement>  ──(ReCiter→DynamoDB→ReciterDB.reporting_conflicts; upstream, exists)
        │
        │  etl:reciter:coi-statements   (etl/reciter/backfill-coi-statements.ts)  ⟵ VPC-blocked to run
        ▼
publication_conflict_statement   (per-PMID verbatim COI text)
        │
        │  etl:coi-gap   (etl/coi-gap/index.ts) — daily, incremental, NOT VPC-blocked
        │     ├─ compute.ts: per scholar, load statements + disclosed Self (coi_activity) + name
        │     │              → lib/coi-gap/pipeline.analyzeStatement (canonicalizeSponsor injected)
        │     └─ lifecycle.ts: reconcile fresh gaps vs persisted (new/keep-dismissed/resolve/reopen)
        ▼
coi_gap_candidate   (cwid,pmid,entity, tier, source sentence, status, first/last-seen)
        │
        ▼  ⟵ NEXT STAGE: self-only /edit panel + disavow API (NOT built, gated)
```

### Key modules

- `lib/coi-gap/pipeline.ts` — **pure** validated core: `analyzeStatement(statement, scholar,
  disclosedEntities, opts?)` → `{candidates(High/Medium tier), suppressed, isNegation,
  unparsedStructured}`; `deriveScholar(first,last)`. Guards: author-ref-position + exact
  initials, ASCO multi-author blob slicing, co-author/home-inst/grant-id suppression,
  funder classification, recall-biased normalization with an injectable `canonicalize` hook.
- `lib/coi-gap/lifecycle.ts` — **pure** `reconcileCandidates(existing, fresh)` (the disavow/
  resolve/reopen rules). Unit-tested.
- `lib/coi-gap/compute.ts` — server helper; reads SPS-DB, injects `canonicalizeSponsor`.
- `etl/coi-gap/index.ts` — the daily job. Incremental via watermark = last successful
  `EtlRun(source="COI-Gap").completedAt`; `--full` recomputes all.
- `etl/reciter/backfill-coi-statements.ts` — statement ingestion (clone of `backfill-abstracts`).

### Validation already done

- **Track A** (`scripts/coi-phase0/`, run `bash scripts/coi-phase0/run.sh`): validated the
  extraction/attribution/diff core on the 2022 reference corpus — 324 faculty, gap rate
  ~44% (capstone band), High tier ~200 with the dominant co-author-bleed FP suppressed.
  Output (confidential) lands in `/tmp/coi-phase0/candidates.csv` = the human-labeling sheet.
- **Unit tests** (`tests/unit/coi-gap-pipeline.test.ts`, `coi-gap-lifecycle.test.ts`): 34 cases,
  real statement-shape fixtures, all green in the real vitest runner.

## Next stage — ordered work

### A. The scholar-facing /edit surface (the main build; GATED — see §C gate 1)
1. **Read model / loader** — extend `EditContext` (`lib/api/edit-context.ts`) with
   `unmatchedPubmedCoi`: load `coi_gap_candidate` where `cwid = targetCwid AND status IN
   ('new','acknowledged')`, **self-only server guard** (`effectiveCwid===targetCwid`),
   `no-store`. Mirror the existing `coiDisclosures` loader.
2. **Panel** — new read-only `coi-gap` attribute in the `/edit` rail registry
   (`components/edit/edit-page.tsx`): extend `AttrKey`, `ATTRIBUTES (readonly)`,
   `SELF_RAIL_ORDER`/`SELF_RAIL_KIND`, `renderPanel`. New `components/edit/coi-gap-card.tsx`
   reusing `EditPanel` + `LockedBadge` + a per-row tier chip + the verbatim source sentence.
   Place directly after the existing `coi` item; `mode: ['self']` only.
3. **Disavow API** — `POST /api/edit/coi-gap/[id]/dismiss` (and optional `/acknowledge`):
   self-guarded, sets `status='dismissed'`, `reviewedAt=now`. The daily ETL already respects
   `dismissed` (never re-nags). Optimistic UI on the card.
4. **Copy** — suggestion framing + neutral temporal wording (see feasibility doc §/edit UX
   for the exact suggested sentence); "Review in WRG" link to the Conflicts-Management-Office
   request-a-change flow (reuse the existing `coi` routing).
5. **Flag** — `SELF_EDIT_COI_GAP_HINT=off`; **wire per-env in `cdk/lib/app-stack.ts`**, not
   just `.env.local` (flag-parity — local-on/deployed-off is a silent ship bug).

### B. Make it run (data population)
6. **Statement ingestion** `npm run etl:reciter:coi-statements` — needs the SPS→WCM ReciterDB
   path (blocked: issue #443) AND `conflictsImport.py` enabled in the WCM nightly so
   `reporting_conflicts` is populated. The backfill warns loudly on 0 rows — heed it.
7. **Gap ETL** `npm run etl:coi-gap` — runs once statements exist (no VPC needed). Then wire
   it into `etl/orchestrate.ts` AFTER `etl:reciter:coi-statements` and `etl:coi`, and add to
   the nightly CDK Step Function cadence.
8. **Apply migrations** — `20260604120000_add_publication_conflict_statement` and
   `20260604130000_add_coi_gap_candidate` are not applied to any DB yet. This repo applies via
   the one-shot `prisma migrate deploy` task on `cdk deploy Sps-Data-<env>` (ADR-009 Phase 2) —
   App-before-Data ordering and the migrate DSN apply.

### C. Enablement status + the outstanding precision follow-up
> **DECISION (2026-06-04, operator):** productionize as a regular source —
> `etl:coi-gap` wired into the nightly cadence (both envs) and `SELF_EDIT_COI_GAP_HINT`
> set **`on`** in both envs in `cdk/lib/app-stack.ts`. The concept/copy gate is signed
> off. Staging takes effect on merge; prod on an approval-gated `cdk deploy Sps-App-prod`.
> The panel stays invisible until the nightly source seeds candidates in that env.

Still recommended (now a follow-up, not a blocker):
1. **Precision number** — run the Track A human-labeling pass on `candidates.csv` (rubric in
   the Phase 0 plan) to get a measured High-tier precision; ratify a threshold with Compliance.
   The v0 rules extractor carries a known ~1/196-High residual co-author-name leak. Track B
   (live data + ReCiter `targetAuthor`) sharpens attribution further.

**Enablement runbook** (do these, in order, when deploying the enabled flag):
- Apply the two Prisma migrations + the audit-ENUM ALTER. The dismiss route writes a
  `scholars_audit` row with `action='coi_gap_dismiss'` / `targetEntityType='coi_gap_candidate'`;
  both are NEW values added to `scripts/sql/audit-log.sql` (the audit table is not a Prisma
  model). Until `db-bootstrap` runs the ALTER, the dismiss INSERT 500s. Harmless while the flag
  is off (the route 503s before any write), but a hard prerequisite once enabled. Order:
  `cdk deploy Sps-App-<env>` then `cdk deploy Sps-Data-<env>` (App-before-Data, ADR-009).
- Wire `etl:reciter:coi-statements` + `etl:coi-gap` into `etl/orchestrate.ts` and the nightly
  Step Function (§B) — they are deliberately unscheduled today, so no candidates are produced.
- Flip `SELF_EDIT_COI_GAP_HINT` to `"on"` per env in `cdk/lib/app-stack.ts` and
  `cdk deploy Sps-App-<env>` (CD re-rolls the image; the flag needs the explicit cdk deploy).

## Blockers & open questions

- **Rebased onto current `origin/master`** (through #746/#747 reciter-reject and #748 `/edit`
  console polish). #748 rewrote the same `/edit` files §A touches; the rebase was clean (only
  `edit-page.tsx` + `edit-page.test.tsx` auto-merged) and the panel was re-verified green
  against the #748 base. Keep rebasing before each push — `/edit` is an active area.
- **ReciterDB VPC** (#443) blocks statement ingestion (Track B). The gap ETL itself is not blocked.
- **Open questions** (from feasibility doc §Open questions): does ReciterDB expose a numeric
  ReCiter article score (sharpens `paperMatch` beyond the boolean `targetAuthor`)? extraction
  approach (rules vs span-grounded LLM)? `coi_activity` refresh cadence? confirm family/
  threshold scope excluded from the diff.
- **v0 extractor residuals** (documented in Track A results): a few co-author-name leaks in
  prose employee-lists; institutional research-support via gazetteer; trial/consortium names.
  These define the v1 extractor / span-grounded-LLM scope.

## How to pick up

```bash
cd ~/worktrees/sps-coi-pubmed          # branch explore/coi-pubmed-unmatched (node_modules installed)
git fetch origin && git rebase origin/master   # clean per above; do before PR
npx tsc --noEmit
npx vitest run tests/unit/coi-gap-pipeline.test.ts tests/unit/coi-gap-lifecycle.test.ts
bash scripts/coi-phase0/run.sh         # re-run Track A → /tmp/coi-phase0/ (confidential, never commit)
```

PR decision: the work is a clean, self-contained, additive stack. It can be PR'd as the
**ungated backend** (model + ETL + pipeline, all dormant) independently of the gated panel —
recommended, so the foundation lands and reviews while the Compliance/copy gate proceeds.

## File index

- Docs: `docs/coi-pubmed-unmatched-feasibility.md`, `…-phase0-precision-study.md`,
  `…-phase0-trackA-results.md`, this handoff.
- Pipeline: `lib/coi-gap/{pipeline,lifecycle,compute,index}.ts`
- ETL: `etl/reciter/backfill-coi-statements.ts`, `etl/coi-gap/index.ts`
- Schema: `prisma/schema.prisma` (`PublicationConflictStatement`, `CoiGapCandidate`), migrations
  `20260604120000_*`, `20260604130000_*`
- Tests: `tests/unit/coi-gap-pipeline.test.ts`, `tests/unit/coi-gap-lifecycle.test.ts`
- Track A harness: `scripts/coi-phase0/{prep.py,analyze.mjs,run.sh,README.md}`
- Scripts: `package.json` → `etl:reciter:coi-statements`, `etl:coi-gap`
