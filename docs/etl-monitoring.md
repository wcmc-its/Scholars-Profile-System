# ETL monitoring — how ETL failures and stale data reach you (#595)

**The question this answers:** *"How would I know if an ETL broke or the data went
stale — before a user notices a profile is missing publications?"*

This is the operational counterpart to [`SLOs.md`](./SLOs.md) (alarm policy) and
[`oncall.md`](./oncall.md) (paging path), scoped to the **ETL/data plane**: the Step
Functions cadences in [`cdk/lib/etl-stack.ts`](../cdk/lib/etl-stack.ts) and the data they
land. Read [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) for *which
source feeds what* and [`data-population-runbook.md`](./data-population-runbook.md) for
*how to (re)load* data.

---

## Why this exists — the incident

On 2026-06-03 a scholar (`yiwang`) showed **no publications** on staging. Root cause: the
deployed `etl:reciter` step could not reach the WCM-side ReciterDB, so its authorships
were never pulled. But the deeper finding was that **nobody had noticed for 8+ nights**:

- The `scholars-nightly-staging` Step Function had **FAILED every night since 2026-05-27**,
  aborting at its first step (`etl:ed` → `Connecting to ED LDAP… Error: Connection
  timeout`). Because the cadence is a sequential chain, a step-1 failure means
  `etl:reciter` and every downstream step **never ran** — the whole dataset froze.
- The failures **did** raise signals — a per-step SNS publish *and* a CloudWatch
  `ExecutionsFailed` alarm, both to the `etl-failures-<env>` SNS topic.
- **That topic had no subscriber.** Every alert published into the void.

So the gap was not missing alarms — it was an **unsubscribed alarm topic**. #595 wired the
topic to the on-call relay and added a freshness backstop for the one failure mode the
Step Functions metrics can't see.

---

## The four signals and where they go

All ETL alerting converges on one SNS topic, **`etl-failures-<env>`**, which (as of #595)
is subscribed by the on-call relay Lambda (`sps-oncall-relay-<env>`) → Microsoft Teams.
The relay renders both CloudWatch-alarm payloads and the ETL Step Functions' custom
payloads (`adaptive-card.ts`).

| Signal | Source | Catches | Routing |
|---|---|---|---|
| **Per-step failure** | `NotifyX` SnsPublish in each step's `Catch` (etl-stack `buildStep`) | A specific step that threw — names the step (`Ed`, `Reciter`, …) and the execution | → `etl-failures` (custom payload) |
| **Status alarm** | CloudWatch `ExecutionsFailed > 0` per state machine (`sps-etl-<cadence>-status-<env>`) | Any failed execution, *including* crashes before the per-step Catch runs | → `etl-failures` (alarm payload) |
| **Cadence alarm** | CloudWatch `ExecutionsStarted < 1` over the cadence window, `treatMissingData: BREACHING` (`sps-etl-<cadence>-cadence-<env>`; nightly + weekly + heartbeat) | The schedule **never fired** — EventBridge rule disabled, IAM gap, etc. | → `etl-failures` (alarm payload) |
| **Freshness heartbeat** | `etl:freshness` (daily `scholars-heartbeat-<env>` state machine) exits non-zero → its status alarm fires | **Green-but-stale**: an execution reported success while a source's data did not refresh; a source quietly dropped from the cadence; a partial run whose success row is now old | → `etl-failures` (alarm payload) |

Together these cover the three ways an ETL "fails" — **it threw**, **it never ran**, and
**it ran green but did nothing** — the last of which the first three cannot see, which is
why the heartbeat exists.

### The freshness heartbeat (`etl:freshness`)

[`etl/freshness/index.ts`](../etl/freshness/index.ts) reads the `etl_run` audit table and,
for each **tracked source**, compares the timestamp of its most recent `status='success'`
row against a per-cadence SLA:

| Cadence | SLA (max age of last success) | Tracked sources (write `etl_run`) |
|---|---|---|
| nightly | 30h (24h + 25% grace) | `ED`, `ReCiter`, `ASMS`, `InfoEd`, `COI`, `ReCiterAI-projection`, `MeshCoverage` |
| weekly | 8 days | `Spotlight`, `Jenzabar` |
| annual | ~400 days (backstop; annual run is operator-gated) | `Hierarchy` |

It logs a per-source report (`STALE`/`ok` + age), lists any *untracked* sources seen in
`etl_run` (so a newly-added cadence source can't go silently unmonitored), and **exits
non-zero if any tracked source is stale** — which trips the heartbeat's own status alarm.
It reads only the in-VPC Aurora (`DATABASE_URL`); it has **no WCM dependency**, so it stays
green and keeps reporting even when the WCM-dependent cadence steps cannot reach their
sources.

> It runs as the single step of `scholars-heartbeat-<env>`, scheduled daily at 13:00 UTC —
> ~6h after the nightly window (07:00) and after the Sunday weekly (08:00), so a failed or
> missed overnight cadence surfaces as staleness the same day.

---

## SOP — a Teams alert fired. Now what?

1. **Read the card.** A `sps-etl-<cadence>-status` alarm or an `Ed failed`-style card means
   a step failed; a `sps-etl-<cadence>-cadence` alarm means the schedule didn't fire; a
   `sps-etl-heartbeat-status` alarm means data is stale past SLA.
2. **Find the failing step.** Step Functions console → `scholars-<cadence>-<env>` → newest
   execution → the red state names the step (and its `cause`).
3. **Read the step's log.** Log group `/aws/ecs/sps-etl-<env>`, the stream from that run's
   window. ETL source errors (LDAP/DB timeouts, empty fetches) print here. For staleness,
   the heartbeat log lists exactly which sources are stale and how old.
4. **Confirm the data impact.**
   ```sql
   SELECT source, status, completed_at, rows_processed, error_message
   FROM etl_run WHERE source = '<Source>' ORDER BY started_at DESC LIMIT 5;
   ```
5. **Common causes → fixes:**
   - *WCM source unreachable* (ED LDAP / ReciterDB / Jenzabar timeout) → SPS-VPC↔WCM
     connectivity ([`network-security-topology.md`](./network-security-topology.md);
     gates on the TGW/firewall work, registry §11 #8). Not fixable from SPS alone.
   - *Schedule didn't fire* → check the EventBridge rule `sps-etl-<cadence>-<env>` is
     `ENABLED` (`etlSchedulesEnabled` in [`config.ts`](../cdk/lib/config.ts)).
   - *Green-but-stale* → the cadence "succeeded" but a source no-op'd; inspect that
     source's `rows_processed` and its step log.
6. **Re-run after the fix:** the cadences are idempotent — re-run via
   [`data-population-runbook.md`](./data-population-runbook.md) (or
   `aws stepfunctions start-execution … --input '{"startFrom":"<StepId>"}'` to resume
   mid-chain).

---

## Production caveat

Prod cadences ship **disabled** (`etlSchedulesEnabled=false`) until launch, and the
heartbeat schedule is gated on the **same flag** — where there is no expected data refresh
there is nothing to alarm on, so the heartbeat would only false-page. Both the cadences and
the heartbeat activate together when the flag flips at launch. (The `etl-failures → relay`
subscription itself is always active in both envs.)

---

## Coverage limits & follow-ups

- **Sources not tracked.** `revalidate`, `reporter`, `nsf`, `gates`, `nih-profile`, and
  `search:index` do **not** write an `etl_run` row, so the freshness check cannot see them.
  Their *failures* are still caught (per-step + status alarms); only their *staleness* is
  not. Follow-up: have these steps record an `etl_run` row, then add them to the SLA map in
  `etl/freshness/index.ts`.
- **Alert detail.** A staleness alert surfaces as `sps-etl-heartbeat-status ALARM`; the
  *which-source* detail is in the heartbeat log, not the card. Follow-up: have
  `etl:freshness` publish a per-source summary payload (the relay already renders custom
  ETL payloads).
- **`rows_processed = 0`.** The check keys on age-since-success, not row counts; a success
  that processed 0 rows is not yet flagged. Follow-up: add a rows-processed floor per source
  (careful: 0 is legitimate for delta-only ETLs).
- **Adding a new cadence source:** add its `etl_run.source` string → cadence to the
  `TRACKED` map in `etl/freshness/index.ts`. Until you do, the heartbeat lists it under
  "untracked sources" on every run as a reminder.

---

*Companion docs: [`SLOs.md`](./SLOs.md) (alarm policy), [`oncall.md`](./oncall.md) (paging
path + relay), [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) (source
inventory), [`data-population-runbook.md`](./data-population-runbook.md) (re-run procedure),
[`cdk/lib/etl-stack.ts`](../cdk/lib/etl-stack.ts) (cadence + alarm source of truth).*
