# ETL cadence and per-step durations

How long each deployed ETL run takes, step by step, and what that means for "I changed X upstream, when does it show up?" (#554, Part 2).

Measured 2026-09-30 from read-only Step Functions execution history for the deployed state machines `scholars-nightly-<env>`, `scholars-weekly-<env>` and `scholars-annual-<env>`. The step list and schedules come from [`cdk/lib/etl-stack.ts`](../../cdk/lib/etl-stack.ts) (`nightlySteps` / `weeklySteps` / `annualSteps`). That file is the source of truth. This doc is a snapshot of how long those steps actually take.

## Schedules

All crons are UTC (EventBridge). The ET column assumes daylight time (UTC-4). Subtract one more hour in winter (UTC-5).

| Machine | Env | Cron (UTC) | ET (EDT) | Rule state (2026-09-30) |
|---|---|---|---|---|
| nightly | prod | `cron(0 7 * * ? *)` | 03:00 daily | enabled |
| nightly | staging | `cron(45 7 * * ? *)` | 03:45 daily | enabled |
| weekly | both | `cron(0 12 ? * SUN *)` | Sun 08:00 | enabled |
| annual | both | `cron(0 9 1 7 ? *)` | Jul 1 05:00 | enabled |
| heartbeat | both | `cron(0 13 * * ? *)` | 09:00 daily | enabled |

Staging's nightly starts 45 minutes after prod so the two envs' InfoEd steps never hit the InfoEd server at the same time (#2906, #2916). Until 2026-09-30 staging also started at 07:00 UTC. The weekly starts 5 hours after the prod nightly, so the two never overlap: both rebuild the same tables.

The heartbeat machine only checks freshness. It loads nothing and is not timed here.

## Whole-run wall clock

Wall clock covers execution start to execution stop. Runs resumed mid-machine with `{"startFrom": ...}` are left out of the totals because they skip steps.

| Machine | Env | Successful runs sampled | Window | Median | p90 | Min | Max | Latest full run |
|---|---|--:|---|--:|--:|--:|--:|--:|
| nightly | prod | 14 | 09-19 to 09-30 | 1h 06m | 1h 12m | 1h 02m | 1h 14m | 1h 12m (09-30) |
| nightly | staging | 14 | 09-17 to 09-30 | 1h 01m | 1h 04m | 57m 43s | 1h 11m | 1h 05m (09-30) |
| weekly | prod | 6 of 8 (2 resumed) | 07-06 to 09-27 | 1h 29m | 2h 05m | 1h 22m | 2h 38m | 2h 38m (09-27) |
| weekly | staging | 12 of 13 (1 resumed) | 07-12 to 09-27 | 2h 13m | 2h 42m | 1h 45m | 2h 45m | 2h 39m (09-27) |
| annual | prod | 1 | 07-07 | 6h 51m | | | | 6h 51m (07-07) |
| annual | staging | 0 | | | | | | |

Read the weekly totals with care. Steps were added to the weekly machine over the sampled window (for example `CoiGapWeekly`, `OrcidRegistryWeekly`, `FundingDigestWeekly`), so older runs did less work. Use the **latest full run (about 2h 40m in both envs)** as the current expectation, not the median. The same applies less strongly to the nightly: `CtscRoster`, `OrcidPush` and `ClipsNightly` joined partway through the window, and staging only ran `Infoed` in the last run of the window (09-30). The latest staging nightly (1h 05m) includes it.

The annual total is almost all `AnnualApprovalGate`, a human approval wait. The only real work, `TaskHierarchy`, takes about 1m 20s.

## Per-step durations

Each value is the time from `TaskStateEntered` to `TaskStateExited` for that state, taken as median and p90 over the successful executions sampled above. `n` is how many of those executions ran the step. A low `n` means the step is new or, for `Infoed` on staging, was only recently enabled there. Steps are listed in execution order.

Each step is its own ECS Fargate task. About **1m 10s is the floor** for every step, even ones that do almost no work, because it covers task provisioning, container start and teardown. Anything well above that floor is real work.

### Nightly

| Step | Prod median | Prod p90 | Prod n | Staging median | Staging p90 | Staging n |
|---|--:|--:|--:|--:|--:|--:|
| `TaskEd` | 3m 52s | 5m 17s | 14 | 4m 18s | 4m 44s | 14 |
| `TaskEdAdmins` | 1m 20s | 1m 22s | 14 | 1m 18s | 1m 25s | 14 |
| `TaskCtscRoster` | 1m 46s | 1m 51s | 6 | 1m 51s | 2m 00s | 6 |
| `TaskReciter` | 12m 40s | 13m 23s | 14 | 12m 40s | 13m 10s | 14 |
| `TaskReciterCoiStatements` | 3m 05s | 4m 36s | 14 | 4m 24s | 4m 44s | 14 |
| `TaskOrcidCandidates` | 1m 37s | 1m 44s | 13 | 1m 37s | 1m 39s | 11 |
| `TaskAsms` | 1m 37s | 1m 50s | 14 | 1m 41s | 1m 55s | 14 |
| `TaskInfoed` | 5m 54s | 7m 11s | 14 | 4m 32s | 4m 32s | 1 |
| `TaskCoi` | 1m 14s | 1m 23s | 14 | 1m 14s | 1m 18s | 14 |
| `TaskJenzabarNightly` | 1m 18s | 1m 22s | 14 | 1m 21s | 1m 24s | 14 |
| `TaskDynamodb` | 5m 07s | 5m 30s | 14 | 5m 22s | 5m 38s | 14 |
| `TaskOrcidPush` | 1m 14s | 1m 16s | 10 | 1m 13s | 1m 19s | 8 |
| `TaskIdentity` | 1m 17s | 1m 23s | 14 | 1m 15s | 1m 21s | 14 |
| `TaskTools` | 1m 14s | 1m 18s | 14 | 1m 19s | 1m 21s | 14 |
| `TaskFamilySensitivityNightly` | 1m 13s | 1m 16s | 14 | 1m 11s | 1m 15s | 14 |
| `TaskFamilySuppressionNightly` | 1m 12s | 1m 18s | 14 | 1m 13s | 1m 19s | 14 |
| `TaskMeshCoverageNightly` | 1m 15s | 1m 24s | 14 | 1m 13s | 1m 19s | 14 |
| `TaskMeshAnchorNightly` | 1m 19s | 1m 21s | 14 | 1m 16s | 1m 19s | 14 |
| `TaskMeshAliasNightly` | 1m 11s | 1m 16s | 14 | 1m 11s | 1m 15s | 14 |
| `TaskPubMedRetractions` | 1m 36s | 1m 39s | 14 | 1m 32s | 1m 41s | 14 |
| `TaskClipsNightly` | 1m 13s | 1m 24s | 7 | 1m 13s | 1m 19s | 7 |
| `TaskSearchIndexNightly` | 13m 42s | 14m 09s | 14 | 13m 22s | 13m 39s | 14 |
| `TaskRevalidateNightly` | 1m 11s | 1m 17s | 14 | 1m 11s | 1m 18s | 14 |
| `TaskIntegrityNightly` | 1m 15s | 1m 19s | 14 | 1m 11s | 1m 21s | 14 |

Where the nightly hour goes: `TaskSearchIndexNightly` (~14m) and `TaskReciter` (~13m) together are about 40% of the run. `TaskInfoed`, `TaskDynamodb`, `TaskEd` and `TaskReciterCoiStatements` add another ~18m. The remaining 18 steps sit at or near the 1m 10s floor, so together they cost about 24 minutes, most of it Fargate overhead.

### Weekly

| Step | Prod median | Prod p90 | Prod n | Staging median | Staging p90 | Staging n |
|---|--:|--:|--:|--:|--:|--:|
| `TaskCompleteness` | 1m 15s | 1m 36s | 6 | 1m 15s | 1m 22s | 12 |
| `TaskHeadshotPresence` | 1m 30s | 2m 41s | 6 | 1m 49s | 3m 17s | 12 |
| `TaskCancerCenterCollabReport` | 1m 27s | 1m 27s | 1 | 1m 38s | 1m 42s | 8 |
| `TaskCancerCenterDiseaseAssignmentsWeekly` | 1m 20s | 1m 20s | 1 | 1m 18s | 1m 20s | 7 |
| `TaskCoiGapWeekly` | 21m 38s | 21m 38s | 1 | 23m 49s | 28m 25s | 6 |
| `TaskSpotlight` | 1m 15s | 1m 19s | 6 | 1m 14s | 1m 30s | 12 |
| `TaskReporterWeekly` | 1m 48s | 7m 30s | 6 | 7m 39s | 9m 25s | 12 |
| `TaskNsfWeekly` | 1m 17s | 1m 42s | 6 | 1m 41s | 1m 46s | 12 |
| `TaskGatesWeekly` | 1m 16s | 1m 28s | 6 | 1m 16s | 1m 18s | 12 |
| `TaskNihProfileWeekly` | 14m 51s | 18m 02s | 6 | 20m 24s | 20m 47s | 12 |
| `TaskOrcidRegistryWeekly` | 6m 01s | 6m 01s | 1 | 6m 45s | 7m 16s | 2 |
| `TaskPopsWeekly` | 31m 04s | 32m 42s | 6 | 31m 28s | 34m 25s | 12 |
| `TaskReporterGrantsWeekly` | 14m 32s | 23m 23s | 6 | 29m 31s | 31m 41s | 12 |
| `TaskClinicalTrialsWeekly` | 1m 19s | 1m 22s | 6 | 1m 19s | 1m 24s | 12 |
| `TaskDataSharingWeekly` | 1m 18s | 1m 19s | 2 | 1m 15s | 1m 18s | 9 |
| `TaskJournalImpactFactorWeekly` | 1m 19s | 1m 21s | 2 | 1m 18s | 1m 22s | 7 |
| `TaskTechnologyWeekly` | 2m 49s | 3m 02s | 6 | 1m 53s | 3m 00s | 13 |
| `TaskNewsWeekly` | 1m 55s | 1m 56s | 3 | 1m 49s | 1m 55s | 11 |
| `TaskFundingDigestWeekly` | 1m 09s | 1m 09s | 1 | 1m 17s | 1m 17s | 1 |
| `TaskSearchIndexWeekly` | 13m 20s | 13m 33s | 8 | 13m 20s | 13m 54s | 13 |
| `TaskRevalidateWeekly` | 1m 17s | 1m 18s | 8 | 1m 14s | 1m 17s | 13 |
| `TaskIntegrityWeekly` | 1m 15s | 1m 21s | 8 | 1m 14s | 1m 17s | 13 |

The weekly's long poles are `TaskPopsWeekly` (~31m), `TaskReporterGrantsWeekly` and `TaskNihProfileWeekly` (15 to 30m each), `TaskCoiGapWeekly` (~22 to 24m) and `TaskSearchIndexWeekly` (~13m). The prod medians for the RePORTER steps sit below staging because the older prod runs in the sample predate the current step set. The p90s and the latest run are closer to staging.

### Annual

| Step | Prod | Staging |
|---|--:|--:|
| `TaskHierarchy` | 1m 19s (1 run) | no successful run yet |
| `AnnualApprovalGate` | 6h 50m (1 run; human approval wait, not work) | no successful run yet |

## When does a change show up?

The Help Desk and KB answer to "why hasn't my change shown up yet?" These times are for prod, in ET during daylight time. Allow the p90 run length, not the median.

| The change | Picked up by | Visible on the site by |
|---|---|---|
| Curator or self edit in `/edit` (overview, suppression, display fields) | Written directly to the app database. No ETL involved. | **Immediately** on the profile. The write revalidates the page cache and queues a CloudFront invalidation after the response (`lib/edit/revalidation.ts`). A suppression also reaches search right away, with a 5-minute reconciler as the backstop (`scholars-reconcile-<env>`). Other edited text shows in **search results** after the next nightly search-index rebuild. |
| Upstream nightly source (Enterprise Directory appointments/titles, ReCiter publications, InfoEd grants, COI, ASMS, Jenzabar, Identity) changed at 2pm | Next nightly, starting 03:00 ET | **About 04:15 ET the next morning.** The source step lands in the first ~30 minutes, but pages and search catch up only after `TaskSearchIndexNightly` and `TaskRevalidateNightly`, which finish near the end of the ~1h 06m (p90 1h 12m) run. |
| Change made after 03:00 ET | Missed tonight's run | The following night, about 04:15 ET (up to ~25h later). |
| Weekly source (POPS clinical data, NIH RePORTER grants and profiles, NSF, Gates, clinical trials, news, technologies, COI gap) | Next Sunday weekly, starting 08:00 ET | **About 10:45 ET that Sunday** (current full run ~2h 40m). Worst case is almost 8 days: a change landing just after Sunday 08:00 waits for the next Sunday. |
| Annual source (org hierarchy) | July 1 annual run | After a human approves the gate. |

Staging runs the nightly 45 minutes later (03:45 ET start), so staging catches up about 04:50 ET.

## How to refresh these numbers

Everything below is read-only. Replace `<name>` with a state machine name such as `scholars-nightly-prod`.

1. `aws stepfunctions list-state-machines` to find the ARN for `<name>`.
2. `aws stepfunctions list-executions --state-machine-arn <arn> --status-filter SUCCEEDED --max-results 20`, then keep the newest 14.
3. `aws stepfunctions get-execution-history --execution-arn <arn>` for each one. The CLI paginates this automatically.
4. Pair every `TaskStateEntered` with the next `TaskStateExited` of the same state name to get per-step durations. Execution `startDate` to `stopDate` gives the whole run. Leave a run out of the totals if its first task is not the machine's first step: that means it was resumed with `startFrom`.
5. Report the median and p90 for each step and each machine.

When the step list or a cron in `cdk/lib/etl-stack.ts` changes, update the schedule table here in the same PR. Re-measure the durations once there are a week or two of runs on the new shape.
