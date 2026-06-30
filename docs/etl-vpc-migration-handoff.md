# Handoff: migrate the ETL compute into a TGW-attached VPC

> **⚠️ SUPERSEDED (2026-06-30) — the relocation TARGET changed. Read the current plan first: [`docs/etl-shared-vpc-migration-plan.md`](./etl-shared-vpc-migration-plan.md).**
> This doc describes the original approach: relocate the ETL into the **per-env scholars-dev / scholars-prod** VPCs and peer back, with a CIDR allowlist for datastore ingress. At the 2026-06-30 networking meeting Fabrice directed using the **single shared `lts-reciter-vpc01`** (same account `665083158573`, us-east-1) for **both** environments instead, with staging/prod isolation by **per-env security groups** (cross-VPC SG-reference, not CIDR). The current plan carries the up-to-date CDK change-list, pre-flight gates, and rollout/probe runbook.
> Retained below for history — the merged #1229 wiring, the source-reach probe matrix, and the recorded decisions still inform the new plan, but the **scholars-dev/prod target and the CIDR-ingress mechanism are no longer the design**.

**Status:** Steps 2–4 + the InfoEd exclusion are **DONE and on master** — PR **#1229** (squash `832fcc93`), CI green, merged 2026-06-22. Shipped **flag-off** (`etlCadenceVpcRelocated=false` both envs), so nothing changes at runtime until an operator flips it. **The remaining gate is step 1 (VPC peering)** — coordination-gated, not yet started. See "Progress" below.

Confirmed direction from networking (Fabrice, 2026-06-22): the existing `Sps-Network-staging/prod` VPCs **cannot** be attached to the Transit Gateway (their 10.20/10.10 space conflicts), so anything that needs on-prem / cross-VPC reach must run in a TGW-attached VPC. He asked us to migrate the ETL there.

## Progress (2026-06-22)

| Step | State |
|---|---|
| 1. VPC peering scholars-dev ↔ Sps-Network-staging | **OUR SIDE DONE in PR #1310** (`8f354425`, open) — new flag `etlVpcPeeringEnabled` (separate from relocation, so peer+probe happen before tasks move); creates the `CfnVPCPeeringConnection` (same account+region → auto-accepted) + the Sps-side return route (`etlPeerCidr → pcx`) per private subnet RT; `resolveEnvConfig` enforces relocated ⇒ peered. **Still gated on Fabrice:** the scholars-dev-**side** route `10.20/16 → pcx` (his VPC; decision #2 = route ownership / auto-revert). |
| 2. New ETL egress SG in scholars-dev | **DONE** (#1229) — `EtlCadenceSg`, gated on `etlCadenceVpcRelocated`. |
| 3. Datastore SG ingress (Aurora 3306 / OpenSearch 443 / internal ALB 80) | **DONE** (#1229) — **CIDR allowlist** chosen (decision #4): `10.46.231.0/24` staging, `10.46.230.0/24` prod, via new `etlPeerCidr`. Additive; Sps-SG rules stay. |
| 4. Relocate cadence task placement | **DONE** (#1229) — `buildStep` uses the shared scholars-dev subnets + SG when relocated. Reconcilers (#393/#353) + curated backup **stay** in the Sps VPC (decision #5). |
| InfoEd exclusion (staging) | **DONE** (#1229) — `etl:infoed` dropped from the staging nightly; prod keeps it. |
| 5. Collapse the email-visibility bridge | NOT DONE — left dormant (redundant only after the migration activates). |
| 6. Prod replication | NOT STARTED — after staging proves out. |

**Activation sequence (two flags, peer-then-move):**
1. Confirm decision #2 with Fabrice (scholars-dev route ownership / auto-revert).
2. Flip `etlVpcPeeringEnabled` → `true` (staging) in `config.ts` → `cdk deploy --exclusively Sps-Network-staging` + `Sps-Data-staging` + `Sps-Etl-staging` (ALB ingress). Creates the peering connection (auto-accepted), the Sps-side return route, and the datastore CIDR ingress — but no task moves yet.
3. Add the scholars-dev-side route `10.20/16 → pcx` out-of-band in that VPC.
4. Re-run the source-reach probe from scholars-dev — confirm the Aurora writer + OpenSearch endpoints connect **via the peer**.
5. Flip `etlCadenceVpcRelocated` → `true` (staging) → `cdk deploy --exclusively Sps-Etl-staging`. (`resolveEnvConfig` blocks this if peering isn't on.)
6. Run one source-touching step (`etl:reciter`), then the full staging cadence (InfoEd already excluded) end to end.

**Raw topology (VPC/subnet/SG/role IDs, source IPs):** `docs/sps-infra-discovery.local.md` (gitignored). This handoff is the plan; that file is the reference.

## The problem in one line

The ETL is a two-sided workload: it **reads** from sources in `10.46.x` + on-prem (reachable only via the TGW) and **writes** to Aurora + OpenSearch in the Sps VPC. Today it runs in the Sps VPC, so it can write but not read (every source times out; the nightly has failed at step 1 `etl:ed` for 8+ days). Moving it to a TGW-attached VPC (`scholars-dev` / `scholars-prod`) fixes the read side but breaks the write side. The migration has to restore the write side.

## Recommended architecture (tactical — do this now)

Move only the **ETL compute** into `scholars-dev` (staging) / `scholars-prod` (prod), and **VPC-peer** the new VPC back to the Sps VPC so the ETL still reaches Aurora / OpenSearch / the internal ALB. Keep the datastores where they are.

```
scholars-dev (10.46.231.0/24, TGW-attached)        Sps-Network-staging (10.20.0.0/16)
  ETL Fargate tasks (pri-*-app subnets) ── TGW ──>  on-prem LDAP + 10.46.x source RDS (reads)
                                        └── pcx ──>  Aurora + OpenSearch + internal ALB (writes)
```

Why this and not the alternatives:
- **Attach the Sps VPC to the TGW** — ruled out by networking (the whole reason for this handoff).
- **Move the datastores (Aurora/OpenSearch) into the new VPCs** — large data migration; unnecessary for ETL connectivity. (See "Strategic option" below for when this is worth it.)
- **Per-source S3 bridges** (like the email-visibility one we shipped) — doesn't scale to ~7 sources, and heavy sources (reciter) don't fit an NDJSON bridge.

We already proved the read side works: from `scholars-dev`, ReciterDB / ASMS / COI / ED-LDAP all connect in <10ms (probe matrix in the discovery doc). The peering restores the write side.

## Target cadence (staging)

Staging should run a **daily** full refresh: every ETL source **except InfoEd**, ending with `search:index` (the OpenSearch rebuild) and `etl:revalidate`. Today the grant-enrichment sources (reporter / nsf / jenzabar / gates / nih-profile), spotlight, completeness, and headshot run *weekly*; on staging, fold them into the daily cadence (or run the weekly machine on a daily schedule for staging) so every source is fresh daily for QA. Indexing is already the last step of the cadence, so daily indexing comes for free. `etl:infoed` is excluded until the overlap is resolved (see below). Prod can keep its existing nightly/weekly split — separate decision — and stays gated (`etlSchedulesEnabled: false`).

## Work breakdown

### 1. VPC peering scholars-dev ↔ Sps-Network-staging (intra-account) — **OUR SIDE in PR #1310; scholars-dev route still Fabrice-gated**
Both VPCs are in account 665083158573, so we can create + accept the peering ourselves.
- Create the peering connection; accept it.
- Routes:
  - scholars-dev app/db route tables: add `10.20.0.0/16 → pcx` (more specific than the existing `10.0.0.0/8 → TGW`, so longest-prefix sends Sps-VPC traffic to the peer; 10.46.x sources still go via the TGW — unaffected).
  - Sps-Network-staging private route tables: add `10.46.231.0/24 → pcx`.
- **scholars-dev-side route:** we add it ourselves (intra-account — no permission needed). The only coordination with Fabrice is a revert-protection flag: confirm those scholars-dev route tables aren't under his team's automation, else our `10.20/16 → pcx` route could be reverted and silently break ETL→Aurora. The Sps-side route (`10.46.231.0/24 → pcx`) is ours (NetworkStack / a peering construct).

### 2. New ETL security group in scholars-dev — **DONE (#1229)**
Mirror the `EdExportSg` we already added in `cdk/lib/etl-stack.ts` (PR #1100): a dedicated egress-only SG in the imported VPC, `allowAllOutbound: true`, no ingress. allowAllOutbound covers on-prem (TGW), Aurora/OpenSearch (pcx), and S3/SecretsManager/Logs/DynamoDB/public APIs (NAT).

### 3. Datastore SG rules (allow the ETL in from scholars-dev) — **DONE (#1229, CIDR chosen)**
On the Sps-VPC side, allow the scholars-dev ETL SG (cross-VPC SG reference works for same-region peering) **or** the CIDR `10.46.231.0/24` — **decision #4: CIDR**, wired as `etlPeerCidr`:
- Aurora cluster SG: ingress 3306 from the ETL SG.
- OpenSearch domain SG: ingress 443 from the ETL SG.
- Internal ALB SG: ingress 80 from the ETL SG (the `etl:revalidate` step POSTs to `/api/revalidate`). Alternative: point the revalidate step at the public app URL via NAT instead.

### 4. CDK: relocate ETL task placement (`cdk/lib/etl-stack.ts`) — **DONE (#1229)**
The EcsRunTask steps currently use `subnets: {subnetType: PRIVATE_WITH_EGRESS}` + `etlSecurityGroup` (Sps VPC). Generalize the `EdExportSg` pattern from PR #1100 (`ec2.Vpc.fromVpcAttributes` + `ec2.Subnet.fromSubnetId` + the new SG) and point the ETL steps at the scholars-dev app subnets + new SG. Parameterize per env via the existing `envConfig.edExportVpc` (already holds vpcId / AZs / appSubnetIds for both envs).
- Move the whole cadence task family (nightly/weekly/annual). They all then have source reach (TGW) + datastore reach (pcx).
- The reconcilers (#393 search-reconcile, #353 cdn-reconcile) only touch Aurora/OpenSearch, not on-prem — they can stay in the Sps VPC to minimize change, or move too (harmless once peered). Decide.
- DynamoDB from scholars-dev: works via NAT; optionally add a DynamoDB gateway endpoint to scholars-dev to avoid NAT egress for the DDB scans.
- Cross-VPC ENI placement on the existing `sps-cluster-staging` is already proven (the bridge + probes did exactly this); no new ECS cluster needed.

### 5. Collapse the email-visibility bridge (cleanup)
Once the full `etl:ed` runs in scholars-dev with DB access via the peer, the export→S3→import bridge (PR #1100) is redundant — `etl:ed` can read LDAP and write Aurora in one task again. Remove the bridge state machine + flag, or leave it dormant. Not urgent.

### 6. Prod (after staging proves out)
Replicate 1–4 for `scholars-prod` ↔ `Sps-Network-prod` (10.10.0.0/16, vpc-0d0209cbfd298c892); routes use `10.10.0.0/16 ↔ 10.46.230.0/24`. Prod ETL schedules are off (`etlSchedulesEnabled: false`), so flip them on only after the prod path verifies.

## InfoEd: excluded from the cadence (decided)

InfoEd is at `10.20.91.8`, which overlaps the Sps VPC's own `10.20/16` CIDR. After peering, scholars-dev routes `10.20.91.8 → pcx → Sps VPC`, where InfoEd does not live (it's on-prem) → blackhole. So it stays unreachable even after this migration, and because every cadence step has a `Catch → Fail` that aborts the chain, leaving it in would make `etl:infoed` the new step that fails the nightly once `etl:ed` is fixed.

**Decision (Paul, 2026-06-22): exclude `etl:infoed` from the staging cadence** so the rest of the ETL + indexing runs daily. Implement by omitting the Infoed step from the staging step list (or gating it off per env) so the chain never aborts on it. Re-add it once the overlap is fixed.

The overlap fix is **WCM-side** (Fabrice's team), not something we can do in AWS — any proxy/NAT must live on-prem where `10.20.91.8` still means the real InfoEd; an AWS-side proxy hits the same overlap. Cleanest options for WCM: re-IP InfoEd off 10.20, or a 1:1 NAT mapping a clean 10.46.x address to 10.20.91.8 (transparent, the standard fix for a CIDR overlap). Asked in the Fabrice thread.

## Strategic option (separate decision — don't block on it)

The new VPCs were built with tiered `app` / `db` / `dmz` subnets across two AZs — the shape of a full application VPC, not just an ETL landing zone. That suggests networking may intend the **whole SPS app** (app + Aurora + OpenSearch + ALB) to live there eventually. If so, the end state is migrating everything into scholars-dev/prod, which removes the peering and makes the ETL natively local. That's a large project (re-provision RDS/OpenSearch/ECS/ALB, migrate data, cut DNS). Recommend the tactical peer-and-move now to unblock daily ETL, and treat the full migration as its own initiative. Worth confirming intent with Fabrice.

## Verification plan

1. After peering: re-run the source-reach probe **from scholars-dev**, this time including the Aurora writer endpoint and the OpenSearch endpoint (10.20.x) — confirm they connect via the peer.
2. Run one source-touching step in scholars-dev, e.g. `etl:reciter` (reads ReciterDB, writes Aurora) — confirm both halves.
3. Run the full staging cadence with `etl:infoed` excluded — confirm it completes end to end (through `search:index` + `etl:revalidate`), not just past `etl:ed`.
4. Confirm `search:index` (OpenSearch) and `etl:revalidate` (internal ALB) work from the peer.

## Reusable from the 2026-06-18/22 session

- The `EdExportSg` + `fromVpcAttributes` + `Subnet.fromSubnetId` + dedicated-SG pattern in `cdk/lib/etl-stack.ts` (PR #1100) is the exact mechanic to generalize for step 4.
- `envConfig.edExportVpc` already carries the scholars-dev/prod vpcId / AZs / appSubnetIds per env.
- The throwaway Fargate probe recipe (node:20-alpine, reuse `sps-etl-task-exec-staging`, run-task with overridden network config; **use the etl SG, not the default SG**, or the logs endpoint init fails) — for the verification probes.
- `reciter` shell creds CAN `cdk deploy --exclusively Sps-Etl-staging` (proven 2026-06-18). Always `--exclusively` (the live stack lags master).

## Open decisions (for whoever picks this up)

1. Tactical peer-and-move (recommended) vs. wait for a strategic full-app migration? → recommend tactical now.
2. Who owns the scholars-dev-side peering route — us (intra-account) or Fabrice's team?
3. InfoEd: DECIDED — excluded from the staging cadence; WCM to re-IP or NAT (asked in the Fabrice thread).
4. Datastore SG ingress: cross-VPC SG reference vs CIDR allowlist (`10.46.231.0/24`)? → **DECIDED: CIDR** (#1229).
5. Move the reconcilers too, or leave them in the Sps VPC? → **DECIDED: leave them** (+ curated backup) in the Sps VPC (#1229).

## First action

Reply to Fabrice confirming the approach: we'll move the ETL Fargate tasks into scholars-dev/prod and peer those VPCs back to Sps-Network-staging/prod so the ETL can still reach Aurora/OpenSearch. Ask (a) whether his team or we add the scholars-dev-side peering route, and (b) about re-IPing InfoEd off the 10.20 range.
