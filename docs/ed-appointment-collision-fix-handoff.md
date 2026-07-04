# ED appointment external_id collision — fix + follow-up handoff

**Date:** 2026-07-03 · **Fix MERGED:** PR #1448 `641b0143` (`etl/ed/index.ts`).

## What happened

The staging nightly (`scholars-nightly-staging`) failed at its **first step `Ed`** every
night since ≥06-30. It fired on schedule (07:00 UTC) and — after the PR-6/PR-7 deploy —
the new **abort tier worked correctly**: Ed failed → paged (`etl-page-staging` → Teams) →
`FailEd` stopped the chain. So the tiering is sound; Ed itself is the problem.

Root cause (from the 07-03 execution logs):

```
prisma.appointment.createMany() → Unique constraint failed: appointment_external_id_key (P2002)
  at refreshEdAppointments (etl/ed/index.ts:233)
```

`refreshEdAppointments` reconciles **per-cwid** (`existing = findMany({ where: { cwid,
source:"ED" } })`) but `appointment.external_id` is **globally unique**. When an
`ED-FACULTY-{SORID}` external_id is owned by a *different* cwid — a SORID **shared across
two people** or **migrated between them** — `classifyByExternalId` (which only sees this
cwid's rows) puts it in `toCreate`, and the batch `createMany` throws P2002. Since Ed is the
first cadence step, that aborts the **entire** nightly.

Not caused by PR-6/PR-7. Pre-existing; the tiering just made it page instead of fail quietly,
and the soak surfaced it.

## The fix (shipped)

`etl/ed/index.ts` `refreshEdAppointments`: keep the fast batch `createMany`, but on **P2002
only** fall back to per-row `upsert` by `external_id` so the row is **reassigned to the
current cwid** instead of crashing (`createMany` is one atomic InnoDB statement → nothing was
partially inserted; non-P2002 errors re-throw). Adds logging:
- `external_id X reassigned cwid A -> B` per cross-cwid reassignment
- the previously-swallowed within-cwid `duplicateExternalIds`

NYP appointments were never affected (external_id embeds the cwid + global reconcile).

Verified: `tsc` + `eslint` clean, full `vitest` 520 files / 6400 passed. Not unit-tested at
the function level (`refreshEdAppointments` is unexported/un-mocked, per the module's
convention) — real validation is the staging rerun below.

## Subsequent steps

### 1. Validate on staging (do first)
- CD rebuilds `scholars-etl-staging:latest` on the #1448 merge. Confirm the image updated
  (ECR push time, or the deploy workflow run) **before** rerunning.
- Re-run just the ED step (no need to wait for 07:00):
  `aws stepfunctions start-execution --state-machine-arn <scholars-nightly-staging> --input '{"startFrom":"Ed"}'`
  (the new strict-startFrom accepts exact step ids; a typo now Fails instead of running the
  whole chain).
- Confirm Ed now **succeeds** and the chain proceeds. Read `/aws/ecs/sps-etl-staging` for the
  new `[ED appointments] external_id … reassigned` / `duplicate SORID` warnings and capture
  the specific SORIDs.
- **Watch for the next failing step.** The chain may still hit other mid-cutover issues
  downstream; with tiering, a spine failure (Reciter/Dynamodb/SearchIndex) pages + stops,
  an enricher failure warns + continues. An `[etl-guard:…]` abort is the system working —
  investigate the source, don't reflex-bypass.

### 2. Escalate a genuinely-shared SORID (if logged)
A `reassigned` log where the same `ED-FACULTY-{SORID}` appears under **two different people in
one run** is an **ED source data anomaly** (a SORID should identify one appointment/person) —
escalate to the enterprise-directory / ED source owner to fix upstream. A cwid **migration**
(same person, cwid changed) is benign; no action.

### 3. Audit of the same bug pattern elsewhere — DONE, clean
All 5 `classifyByExternalId` callers were checked for the same "partial `existing` view vs
global-unique key" gap. **Only ED-faculty had it.** The others load `existing` globally (the
scope the primitive expects) and/or embed the scoping key in the external_id:

| Caller | `existing` scope | external_id | Verdict |
|---|---|---|---|
| `etl/ed` faculty | per-cwid `{cwid,source:"ED"}` | `ED-FACULTY-{sorId}` (global) | **fixed (#1448)** |
| `etl/ed` NYP | global `{source:NYP}` | `ED-NYP-{cwid}-{title}` | safe |
| `etl/asms` education | global `{source:"ASMS"}` | `ASMS-{schoolId}` | safe |
| `etl/infoed` grants | global `{source:"InfoEd"}` | `INFOED-{acct}-{cwid}` | safe |
| `etl/jenzabar` gs-faculty | global `{source}` | `{source}-{jid}` | safe |

**Rule for new callers:** `classifyByExternalId`'s `existing` must cover the SAME scope as the
external_id's uniqueness. Global-unique external_id ⇒ load `existing` globally (as NYP / ASMS /
InfoEd / Jenzabar do), or embed the partitioning key in the external_id.

### 4. Optional cleanup (deferred, not required)
The cleaner long-term shape for ED-faculty is to hoist it to a **global** reconcile like the
other four (collect all incoming across scholars, one `classifyByExternalId` against all
`{source:"ED"}` existing). Deferred because it changes the **stale-delete semantics** — today
a scholar absent from this run keeps their ED appointments (per-cwid stale scope); a global
reconcile would tombstone them, which intersects the departed-scholar handling (`etl/ed`
~line 903). The shipped upsert-fallback fixes the crash without touching those semantics.

## Context
- Fix is ETL **code** (ships via the CD-rebuilt image), **not** cdk — no `Sps-Etl` deploy needed.
- Deployed staging infra is the new tiered def (PR-7, `816e417f`); prod still fully gated (#475).
- Parent status: `[[project_etl_reliability_audit]]` (memory), `[[project_etl_cadence_vpc_relocation]]` (soak).
