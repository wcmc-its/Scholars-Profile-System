# ETL hardening PR-6 + PR-7 — implementation handoff

**Date:** 2026-07-02 · **Decisions below are USER-APPROVED — implement, don't relitigate.**
**Parent:** `docs/etl-reliability-audit-2026-07-02.md` (full audit: 23 confirmed findings + plan).

## Context: what already landed (all merged to master 2026-07-02)

| PR | Merge | What |
|---|---|---|
| #1422 | `a49dae93` | `lib/etl-guard.ts` (`assertSourceVolume`/`assertPruneVolume`, `ETL_GUARD_BYPASS` escape) + guards on the 4 critical paths (ED soft-delete, Reciter orphan-prune, COI wipe) |
| #1425 | `135644fe` | `rebuildAliasedIndex` `preSwapCheck` — doc-count delta + smoke assertions BEFORE the alias swap |
| #1426 | `749fa008` | `lib/etl-run.ts` `withEtlRun(source, fn)`; 9 previously-unrecorded steps wrapped; freshness `TRACKED` synced to cadences, env-scoped via new `SCHOLARS_ENV` EtlStack container var |
| #1429 | `aa1c4658` | `etl:integrity` terminal step on BOTH machines (rowsProcessed >50%-drop, floors, attribution canary, OS-vs-Aurora) |
| #1432 | `78f51ef5` | Guards on all remaining destructive writers (~20 modules) |
| OPS-0 | deployed | `Sps-Observability-prod` current: `etl-failures-prod` → `sps-oncall-relay-prod` → Teams |

Remaining work = **PR-6 then PR-7, strictly in that order** (PR-6's transactions are what make PR-7's continue-on-failure safe — see the Coi→CoiGap hazard below).

## Process requirements (non-negotiable)

- Branch off **freshly fetched `origin/master`** into a worktree OUTSIDE Dropbox (`~/worktrees/...`); budget `npm ci` + `npx prisma generate` (+ separate `cd cdk && npm ci` for PR-7). Remove the worktree at task end.
- Verify: `tsc --noEmit`, `eslint` on changed files, **full** `vitest run --maxWorkers=4` before every push. PR-7 also needs `cd cdk && npm test -- -u` and the regenerated `.snap` committed (etl-stack snapshots WILL change).
- Merge protocol: `gh pr checks --watch` until build+cdk green, then `gh pr merge --squash` (auto-merge unavailable). No AI attribution anywhere.
- **Do NOT deploy `Sps-Etl-<env>` or `Sps-Network-staging`.** Staging is mid-VPC-cutover (Phase F soak; Phase G pending). All machine-definition changes ship dark until the post-soak `cdk deploy --exclusively Sps-Etl-<env> -c env=<env>` — which will activate, in one deploy: `SCHOLARS_ENV`, the Integrity steps, and everything in PR-7. Flag that accumulation in the PR body.

---

## PR-6 — transactional delete-rebuilds (small tables only)

**Problem:** guards stop *bad-source* wipes but not *mid-write kills* (OOM/SIGKILL between delete and re-insert). Step Functions retries re-run the WHOLE step, widening the window. The concrete downstream hazard: `Coi` dying between its `deleteMany` and re-insert, then `CoiGap` (next step) fabricating false compliance gaps from the half-empty table.

**Scope — wrap delete→repopulate in ONE transaction per module:**

| Module | Site (post-`78f51ef5` line refs approximate) | Tables |
|---|---|---|
| `etl/coi/index.ts` | guard → `coiActivity.deleteMany()` → batched `createMany` | `coi_activity` (~thousands of rows) |
| `etl/tools/index.ts` | two wipe sites (`scholarTool.deleteMany` ~:578, `scholarFamily.deleteMany` ~:610) | one tx per table pair is fine; entity-layer wipe (~:640) may join the second tx |
| `etl/clinical-trials/shared.ts` `replaceAll()` | `personClinicalTrial` + `clinicalTrial` delete → insert | both tables in one tx (children-first delete, parents-first insert preserved) |
| `etl/jenzabar/index.ts` | `phdMentorRelationship.deleteMany()` → batched `createMany` | small |
| `etl/ed/student-programs.ts` | `studentPhdProgram.deleteMany()` → batched `createMany` | small |

**Explicitly SKIP:** the Reciter `PublicationAuthor` per-PMID delete/reinsert (~500k rows — oversized tx; Reciter stays in the abort tier so its partial state never gets published) and the ED scholar upsert loop.

**Prisma mechanics (the gotchas that will bite):**
- Use the **interactive** form: `await db.write.$transaction(async (tx) => { ... }, { timeout: 120_000, maxWait: 10_000 })`. The default interactive-tx timeout is **5 s** — batched createMany of a few thousand rows will blow it; raise per call site.
- Inside the callback, every op must go through `tx.…`, not `db.write.…` (a stray `db.write` silently escapes the transaction).
- Keep the PR-1/PR-3 **guards OUTSIDE/BEFORE the tx** (they read counts; no reason to hold the tx open during source reads). Order per module: fetch → guard → tx(delete+insert).
- `createMany({ skipDuplicates: true })` is tx-safe; keep existing batch sizes.
- Aurora MySQL: no DDL in these paths, so no implicit-commit hazards.

**Tests:** the modules aren't unit-test-structured; don't force it. One new test is enough: mock `db.write.$transaction` in an existing pattern (see `tests/unit/etl-run.test.ts` for the `vi.hoisted` db-mock shape) for ONE representative module (suggest `clinical-trials/shared.ts` `replaceAll` — it's a pure exported function) asserting delete+insert run through the tx client. Full vitest green is the real gate.

---

## PR-7 — state-machine tiering + hygiene (`cdk/lib/etl-stack.ts`)

### Approved tier classification

| Tier | Steps | Failure behavior |
|---|---|---|
| **abort + P1 page** | `Ed`, `Reciter`, `Dynamodb`, `SearchIndexNightly`/`Weekly` | Catch → SNS **`etl-page-<env>`** → `Fail` (chain stops — stale-but-coherent site is the goal) |
| **continue + P2 warn** | `ReciterCoiStatements`, `Asms`, `Infoed`, `Coi`, `CoiGap`, `JenzabarNightly`, `Identity`, `Tools`, `MeshCoverageNightly`, `MeshAnchorNightly`, `PubMedRetractions`, `RevalidateNightly`/`Weekly`, and all weekly enrichers | Catch → SNS **`etl-failures-<env>`** (existing topic) → **`.next(<next step>)`** (chain continues) |
| **always-runs validator** | `IntegrityNightly`/`Weekly` | stays terminal; its failure → `etl-page-<env>` + Fail (a violation IS the P1) |

### Paging-path facts (verified 2026-07-02 — do not rediscover)

- `cdk/lambda/oncall-relay/index.ts` `severityForRecord()` maps topic→tier: `sps-warn-*` and **`etl-failures-*` are ALREADY "warn"**; any other topic defaults to **"page"**. So:
  - Continue-tier failures publishing to the existing `etl-failures-<env>` need **zero relay/routing changes**.
  - Abort-tier needs a **new `etl-page-<env>` SNS topic in EtlStack** — the relay will route it to the page channel with no lambda change.
- Subscription wiring for the new topic goes in **ObservabilityStack, not EtlStack** — copy the `EtlFailuresRelaySubscription` + `AllowEtlFailuresTopicInvoke` pattern verbatim (the comment there explains the stack-dependency cycle you'd create doing it any other way). Export the new topic from EtlStack the same way `failureTopic` is.
- Ops note (not code): prod's warn webhook secret (`scholars/prod/oncall/teams-webhook-url-warn`) does **not exist**, so P2 currently falls back to the page channel in prod (relay's documented degrade). Provisioning that secret is what actually quiets the prod pager — no redeploy needed, relay picks it up on cold start.

### Mechanics in `buildStep` / `buildStateMachine`

- Add `tier: "abort" | "continue"` to `StepSpec`. `buildStep` currently does `task.addCatch(notify.next(Fail))`; for continue steps the catch chain becomes `notify.next(<successor task>)` — which means `buildStep` needs the successor, so build the catch wiring in `buildStateMachine`'s chaining loop (where `stepTasks[i].next(stepTasks[i+1])` already lives) rather than inside `buildStep`.
- Keep `resultPath: "$.error"` on the Catch; steps don't read state input (commands are static container overrides), so the error payload flowing into the successor is harmless — but note the `startFrom` Choice only inspects the ORIGINAL execution input, so no interaction.
- Last-step-continue edge case: a continue step that is last before the Integrity tail just `.next(Integrity)`.
- Construct-id churn: renaming/re-parenting the `Notify${id}`/`Fail${id}` constructs will churn the snapshot heavily — fine, but keep ids stable where possible to keep the diff reviewable.

### Also in PR-7 (approved)

1. **Strict `startFrom`**: the Choice currently falls through `otherwise → step[0]`, so a TYPO silently runs the full chain. Add, after the per-step matches, a `Condition.isPresent("$.startFrom")` branch → `new sfn.Fail(..., { cause: "unknown startFrom step id" })`; keep `otherwise → step[0]` for the absent-key (scheduled `{}`) case. Order matters — Choice conditions evaluate in insertion order.
2. **Sunday overlap**: move the weekly cron `cron(0 8 ? * SUN *)` → `cron(0 12 ? * SUN *)` AND cut the per-attempt `taskTimeout` from 24 h to **4 h** (longest observed step ~12 min; search:index worst case well under 1 h). Together these make a nightly-weekly collision impossible without a wait-loop Lambda. Leave both machine-level 24 h timeouts.
3. **Schedule the three ready uncadenced sources** — append to `weeklySteps` before `SearchIndexWeekly`:
   - `{ id: "PopsWeekly", npmScript: "etl:pops", external: false }` (public-directory-style fetch via `lib/edit/pops`, no per-source ETL secret — verify nothing in `credentialedSources` is needed; it isn't today).
   - `{ id: "ReporterGrantsWeekly", npmScript: "etl:reporter-grants", external: true }` (reads ReciterDB + public RePORTER; REPORTER_MATCH_V2 env already wired staging-on/prod-off).
   - `{ id: "ClinicalTrialsWeekly", npmScript: "etl:clinical-trials", external: true }` (reads ReciterDB).
   **Prerequisite code (same PR):** `etl/reporter-grants/index.ts` writes **no `etl_run` row** (verified) — wrap its entry `main()` → `withEtlRun("ReporterGrants", main)` (match the `etl/reporter/index.ts` pattern from #1426). Same for the `etl/clinical-trials/index.ts` direct entrypoint → `withEtlRun("ClinicalTrials", main)` (its `import.ts` sibling records `ClinicalTrials-Import`; keep names distinct). POPS already records `"POPS"`.
   Then add all three to `etl/freshness/index.ts` `TRACKED` as `{ cadence: "weekly" }` (source strings: `POPS`, `ReporterGrants`, `ClinicalTrials`) and optionally `Integrity: { cadence: "nightly" }` (it self-records via `withEtlRun("Integrity", ...)`).
   **Leave manual (approved):** `ED-Student-Programs`, `ED-Admins` (fail-closed behind `SELF_EDIT_ED_ADMINS_IMPORT`, pending OQ-4 — scheduling them now schedules a no-op).

### PR-7 verification

- `cd cdk && npm test -- -u` — expect etl-stack (and possibly observability-stack) snapshot updates; eyeball the snapshot diff for: new topic, per-tier catch targets, new weekly steps, cron change, timeout change. Commit only intended `.snap` churn.
- Root `tsc`/`eslint`/full vitest for the `withEtlRun` wraps + freshness additions.
- `npx cdk synth --quiet` both envs (`-c env=staging`, `-c env=prod`) as a sanity pass; **no deploys** (see Process requirements).

---

## Rollout sequencing (after both PRs merge — mostly NOT this session's job)

1. Wait for VPC-cutover Phase F soak → Phase G to settle (other workstream owns this).
2. `cdk diff` then `deploy --exclusively Sps-Etl-staging -c env=staging` from detached `origin/master` — activates SCHOLARS_ENV + Integrity + tiering + weekly additions at once; watch the next two staging nightlies (an `[etl-guard:...]` abort is the system working — investigate the source, don't reflex-bypass).
3. `Sps-Observability-staging` deploy for the new `etl-page` subscription (diff first).
4. Prod: same pair, after the prod cadence-enablement decision (#475 gate applies; prod EventBridge schedules still ship disabled).
5. Provision `scholars/prod/oncall/teams-webhook-url-warn` to actually split P1/P2 channels in prod.

## Pointers

- Audit report: `docs/etl-reliability-audit-2026-07-02.md` (finding details + severity rationale).
- Memory topic: `project_etl_reliability_audit` (session-persistent status).
- The tier design rationale (why abort for spine, continue for enrichment, PR-6-first): user-approved recommendation, recorded here so a fresh session doesn't re-derive or second-guess it.
