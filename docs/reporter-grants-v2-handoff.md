# RePORTER grants v2 (lateral-recruit matcher) — handoff (2026-06-26)

How to continue the v2 matcher work. Design is in `docs/reporter-grants-v2-matcher-spec.md` (approved); this is orientation + next steps. v1 background: `docs/reporter-grants-handoff.md`.

## Why this exists

v1 (#1305/#1306/#1307/#1309, all merged + staging-verified) materializes RePORTER grants only for scholars **already in `person_nih_profile`** — i.e. people with a WCM (InfoEd) NIH grant. It does **not** serve the headline case: a **pure lateral recruit** (dean-from-Stanford, no WCM grant yet → no `person_nih_profile` row → zero backfill). v2 resolves those by **name → candidate `profile_id`s → PMID overlap** against the scholar's trusted PubMed set, then materializes the winner's grants through the identical v1 path.

## Shipped this session

| Item | State |
|---|---|
| Per-row "via NIH RePORTER" provenance marker | #1309 MERGED `bd4b54d6` |
| v1 **live staging verify** | PASSED — 1584 rows / 654 scholars + 271 recency-suppr, rollups exclude, idempotent |
| v2 **SPEC** | approved — `docs/reporter-grants-v2-matcher-spec.md` |
| v2 **PR-1 (ETL + model)** | MERGED `8268d7976` (#1312), CI-green, **flag-gated OFF** |

## Decisions locked (don't relitigate)

| Topic | Decision |
|---|---|
| Confidence | K≥3 **auto-lock** (silent materialize); K=2 → `/edit` "Is this you?" confirm. (`K_AUTOLOCK=3`, `K_SUGGEST=2`, `SEPARATION=2` in `lib/edit/reporter-grants.ts`.) |
| A — auto-lock | **ON**, but always a **revocable** `confirmed` row (`reviewedBy="system-autolock"`). Rollout lever: demote all to `pending` if prod shows a wrong lock. |
| B — reject reasons | **enum only**: `not_me` / `name_only` / `cant_tell`. No free-text. |
| C — confirmed history | **show auto-locks** (labeled "matched automatically"), self-revocable. |
| Card copy | MUST state the **CV purpose** ("Confirming adds these grants to your profile and CV"). The CV export (#1308, `EDIT_CV_EXPORT`) is the primary driver. |
| Governance | **Projection-starved** — never surface the numeric K/overlap to the user (per COI-gap pattern + `PublicationTopic.score` rule). `overlapK` is persisted internal-only. |
| Reuse base | `/edit` card reuses the **COI-gap** advisory machinery + **core-claim** soft-revoke. |

## What's left, in priority order

1. **Flag wiring + RUNTIME GUARD (do FIRST — blocks staging verify).**
   - Wire `REPORTER_MATCH_V2` into the ETL task env: `cdk/lib/etl-stack.ts` **line ~620**, in the `environment:` block (line 595). Mirror `SCHOLAR_TOOL_SOURCE`: `REPORTER_MATCH_V2: env === "staging" ? "on" : "off"` (staging-first). Apply via `cdk deploy --exclusively Sps-Etl-<env>` (NOT a CD image roll — same as the SCHOLAR_TOOL_SOURCE comment). Also add to `.env.local` for local runs (flag-parity). **Regenerate the cdk snapshot** (`cd cdk && npm ci && npm test -- -u`, commit only the `.snap`) or the `cdk` gate fails.
   - **Runtime guard (required before flipping on).** The v2 cohort = active scholars − the ~654 profiled. At 1 req/s × ~3 RePORTER calls/scholar (name search + per-candidate publications + winner detail), a full pass is **many hours** — too long for the nightly. Options (pick one, small follow-up to PR-1): cap per-run (process N/run, resume next night via a cursor), and/or restrict the cohort to scholars with **≥N trusted PMIDs** (higher match-yield, the matcher needs PMIDs anyway). Size the cohort first (`SELECT COUNT(*)` active − profiled on staging) to know how bad it is.

2. **Staging verify (after #1).** Flip `REPORTER_MATCH_V2=on` on staging, deploy Sps-Etl-staging, run `etl:reporter-grants` via one-off `run-task` (recipe below). Confirm: cohort scanned, auto-locks wrote `person_nih_profile` (`resolution_source='pmid-overlap-auto'`) + grants materialized same-run, K=2 wrote `pending` `reporter_profile_candidate` rows (no grants), idempotent re-run, runtime acceptable. Spot-check a known recruit. Use the §12 audit SQL in the spec.

3. **PR-2 — `/edit` "Is this you?" card** (stacks on master, PR-1 landed). Per spec §6/§7: `EditContext.reporterProfileCandidates` (pending) + `reporterProfileConfirmed` (history); `loadEditContext` gate (flag + genuine-self); `ATTRIBUTES` entry `{key:"reporter-profile", label:"Is this you?"}` + `renderPanel` case; `reporter-profile-card.tsx`; `POST /api/edit/reporter-profile/[id]/confirm|reject|revoke` (genuine-self-or-superuser, audit, `$transaction`: status + on-confirm upsert `person_nih_profile` / on-revoke delete it). Confirm → grants appear **next nightly** (document the lag). Reuse `coi-gap-card.tsx` + `coi-gap/[id]/feedback` route shapes; soft-revoke from `core-claim`.

4. **CV-generator integration** — the CV export reads materialized grants; coordinate with `docs/scholar-cv-generator-spec.md`.

5. **Deferred org-label** — "via NIH RePORTER · {org}" / "prior institution" needs `orgName` persisted on `Grant` (a column + #1307 transform write); the v1 transform already computes `orgName` but drops it. Separate from v2.

## Key facts (don't re-derive)

- **PR-1 components** (all merged): model `ReporterProfileCandidate` (`prisma/schema.prisma`; states pending|confirmed|rejected|revoked; `@@unique([cwid, externalProfileId])`); migration `20260626130000_add_reporter_profile_candidate`; fetcher `fetchPublicationsByCoreProjectNums` (`etl/nih-profile/fetcher.ts`, RePORTER `POST /v2/publications/search`, batched 50, 1 req/s); pure logic `etl/reporter-grants/v2.ts`; flag-gated branch = **step 0 of `main()`** in `etl/reporter-grants/index.ts`; 19 tests `tests/unit/reporter-grants-v2.test.ts`.
- **Matcher signatures** (`lib/edit/reporter-grants.ts`, from v1): `rankByPmidOverlap(personPmids: Set<number>, candidates: Candidate[]) → { autoLock, suggestions, ranked }`; `Candidate = { profileId, fullName, orgs, grantPmids: Set<number> }`; `RankedCandidate.overlap` is the K. `dedupeAgainstInfoEd` reused for the card summary.
- **Inputs**: trusted PMIDs = `publicationAuthor.findMany({where:{cwid, isConfirmed:true}, select:{pmid:true}})`. Name search = `searchProjectsByPiName({firstName,lastName})` (RePORTER `/v2/projects/search`, `pi_names`). `namesMatch`/`reporterPiName` from `etl/nih-profile/resolver.ts`. NONE of v2 needs reciterdb (SPS Aurora + public RePORTER API only) → not blocked like the nightly's WCM-network steps.
- **Staging run-task recipe** (verified this session): cluster `sps-cluster-staging`, task-def `sps-etl-staging`, container `etl`, subnets `subnet-019afebef588ee4b3,subnet-03de6e3dfe190288b`, SG `sg-09b494047547ea148`, `assignPublicIp=DISABLED`, FARGATE. Logs `/aws/ecs/sps-etl-staging` stream `etl/etl/<taskId>`. Run: `--overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","etl:reporter-grants"]}]}'`. Read-probe: `npx tsx -e "import{db}from'./lib/db';(async()=>{…db.write…})()"` (CJS → async IIFE, NOT top-level await). Image `:latest` is master-current (tagged with the head commit).

## Landmines

- **Runtime is the real risk** — see #1. Don't flip the flag on without the guard; an unbounded nightly pass will blow the window.
- **Flag is an ETL flag, not an app flag** — wire in `cdk/lib/etl-stack.ts` `environment:` (NOT `app-stack.ts`); apply via `cdk deploy --exclusively Sps-Etl-<env>` (CD only rolls the image, never deploys infra). Regenerate the etl-stack snapshot.
- **Schema-change worktree:** PR-2 has no migration, so it can symlink `lib/generated`. PR-1 needed a REAL `lib/generated` via `npx prisma generate` in the worktree (symlinked `node_modules` provides the engine; output path is worktree-relative so canonical is untouched). Never `prisma generate` through a *symlinked* `lib/generated`.
- **Worktree hygiene (SPS Dropbox):** symlink `node_modules`; commit explicit paths only (never the symlinks); `git worktree remove --force` + `pkill -f 'vitest|esbuild|tinypool'` when done. Branch off fresh `origin/master`. Push new branches with an explicit refspec (`git push -u origin <branch>`) — the worktree branch tracks `origin/master`, so a bare push goes to master.
- **CI:** stacked PRs get `build`/`cdk` only on a master base; trigger via `gh pr update-branch` after retarget. Run `next lint` locally (not just tsc+vitest) — a raw `<a>` cost a round-trip on #1309. After `update-branch` pulls master in, run a FULL `tsc` — a master-merged fixture (cv-export `source`) cost another.
- **Subagents must not merge/push** — main loop only.
- **Branch drift:** this doc + the spec sit on a behind-master branch; re-ground merged code via `git show origin/master:<path>`.
- **Projection-starving:** the card must never render `overlapK`/score — only grant titles for the human to recognize.

## Pointers

- Spec: `docs/reporter-grants-v2-matcher-spec.md` (§4 ETL, §5 model, §6 card, §7 routes, §11 test table, §12 audit SQL, §14 decisions).
- v1 handoff: `docs/reporter-grants-handoff.md`. Memory: `project_reporter_grants_backfill`.
- Merged: #1312 `8268d7976` (PR-1). Branch `feat/reporter-grants-v2-etl` (worktree removed).
