# Cost model

**Audience.** Operators, ITS colleagues, and budget owners answering *"what does Scholars
cost to run, and what drives the bill?"*

**What this doc is — and isn't.** It records the **audited baseline**, the **guardrails**
that are actually deployed, and the **cost drivers** (with their IaC-defined sizes) so you
can reason about where money goes and what a change will do to the bill. Per-line-item
dollar figures beyond the audited baseline are marked **`est.`** and are derived from the
provisioned sizes, **not** from a billing export. For authoritative actuals, read AWS Cost
Explorer for the account — this doc is the map, Cost Explorer is the meter.

> Tagging caveat (from [`SLOs.md § Cost guardrail`](./SLOs.md)): most line items (Aurora
> storage, OpenSearch instance-hours, ECR storage) don't tag-isolate cleanly between
> staging and prod, and each account is single-tenant for SPS — so the **account-wide
> budget is the SPS budget**. Don't expect clean per-env tag allocation.

---

## Audited baseline & guardrails (real, deployed)

| Figure | Value | Source |
|---|---|---|
| **Audited Phase 0+1 baseline** (both envs combined, pre-Edge/Etl) | **~$425 / mo** (~$14 / day) | [`SLOs.md § Cost guardrail`](./SLOs.md) |
| **Monthly budget** (`sps-monthly-budget`, account-wide, prod stack only) | **$600 / mo** | ObservabilityStack — alerts at 50% forecast / 80% forecast / 100% actual → `sps-notify-prod` |
| **Cost-anomaly monitor** (`sps-anomaly-monitor`, SERVICE dimension, DAILY) | **$50 / day impact** | catches ~4× spikes (runaway reshard, scale-out loop, NAT explosion) above ~$14/day baseline |

The $600 budget is ~40% headroom over the $425 baseline; it is **revised when EdgeStack and
EtlStack land** (both add cost) rather than pre-emptively loose-set. The budget and anomaly
notifications go to `paa2013@med.cornell.edu` via the notify topic — confirm that SNS email
subscription within 3 days of first deploy or the alerts fire into the void.

> ⚠️ The ~$425 baseline predates **EdgeStack** (CloudFront request/transfer pricing) and
> **EtlStack** (scheduled Fargate ETL runs + cross-AZ/NAT data). Expect the live bill to be
> **higher** than $425 once those are active. Re-audit against Cost Explorer post-launch and
> update this doc + the budget.

## Cost drivers (what the bill is made of)

Sizes are from [`cdk/lib/config.ts`](../cdk/lib/config.ts); dollar columns are `est.` from
those sizes at on-demand `us-east-1` rates and are **directional, not invoice-accurate**.

| Service | Prod size | Staging size | Cost shape | Notes |
|---|---|---|---|---|
| **Aurora MySQL Serverless v2** | 1–8 ACU, writer + 1 reader | 0.5–2 ACU, writer-only | ACU-hours (scales with load) + storage + I/O + backup | Usually the largest line item. Reader doubles compute when active. PITR 14 d; AWS Backup 35 d (prod) / 14 d (staging) + cross-region copy. |
| **OpenSearch Service** | 2 × `m6g.large.search` (multi-AZ) | 1 × `t3.small.search` | instance-hours (flat, 24×7) + EBS | Flat cost — sized for search, runs continuously. Prod's 2-node multi-AZ is the bigger driver. |
| **ECS Fargate (app)** | 2 × (1024 CPU / 2048 MiB), 24×7 + autoscale | 1 × (512 / 1024) | vCPU-sec + GB-sec per running task | Scales with task count; rolling deploys add a transient task. |
| **ECS Fargate (ETL)** | per-run 2048 CPU / 8192 MiB | same | vCPU-sec + GB-sec **only while running** | Nightly + weekly + annual runs; minutes-scale, not 24×7. Memory bumped to 8 GB for the `search:index` corpus build (#485). |
| **CloudFront + WAF** | 1 distribution | 1 distribution | per-request + data-transfer-out + WAF per-rule/per-request | New post-baseline. **Lowers** origin (Fargate/Aurora) cost by absorbing reads at the edge; adds its own request/transfer line. |
| **NAT gateway** | 1 | 1 | hourly + per-GB processed | Single NAT per env (EIP-cap trade-off). VPC endpoints (Secrets Mgr, S3) keep AWS-service traffic *off* the NAT to limit per-GB charges. |
| **ALBs** | 2 (public + internal) | 2 | LCU-hours (~$16/mo each `est.`) | Two-ALB split is a deliberate ~$16/mo cost for a clean SG boundary ([`PRODUCTION_ADDENDUM.md § Two-ALB topology`](./PRODUCTION_ADDENDUM.md)). |
| **X-Ray (tracing)** | 5% sample + 100% errors/slow | same | per-trace recorded ($5/1M) | **< $2/mo** `est.` ([`tracing.md`](./tracing.md)). Sidecar adds ~0.25 vCPU + 256 MB/task. |
| **On-call relay Lambda** | 256 MB, per-alarm | same | per-invocation | Negligible (one POST per alarm). |
| **Secrets Manager** | ~11 secrets/env | ~11 | per-secret-month + API calls | Small, flat. |
| **S3** | CloudFront logs (90 d), backups | logs | storage + requests | Small; access-log bucket has a 90-day lifecycle. |
| **ECR** | app + ETL images | same | storage per GB | Small; prune old tags to bound it. |
| **CloudWatch** | logs (3 mo prod / 1 mo staging) + alarms + dashboards | (1 mo) | log ingestion/storage + per-alarm + dashboards | Retention policy bounds storage ([`logging-reference.md`](./logging-reference.md)). |
| **Route 53 / ACM** | — | — | hosted zone is WCM-ITS-owned; ACM certs free | DNS/cert lifecycle owned by WCM ITS, not this account. |

## How CloudFront changes the cost shape

The CDN is both a cost *adder* (request + transfer pricing) and a cost *reducer*: a >85%
cache hit rate means the Fargate app and Aurora serve only the *first* request per URL per
TTL window (24 h for scholar pages). A bot crawling all ~9,000 profiles costs ~9,000 origin
renders/day at most, not 9,000 × (crawler concurrency). So edge spend trades against origin
compute — watch both lines together at the post-EdgeStack budget review.

## Levers (to reduce cost, in rough order of impact)

1. **OpenSearch instance class / node count** — flat 24×7 cost; the single biggest knob if
   search load is light. (Multi-AZ is the prod availability choice; don't drop it casually.)
2. **Aurora max ACU** — caps the auto-scale ceiling (prod 8). A runaway query that pins ACUs
   is exactly what the `sps-aurora-cpu` alarm + the anomaly monitor catch.
3. **App task count / size** — autoscaling already right-sizes; the floor is 2 (prod) for AZ
   resilience.
4. **NAT data processing** — keep AWS-service traffic on VPC endpoints; a "NAT-traffic
   explosion" is a named anomaly-monitor target.
5. **CloudWatch log retention** — already bounded (3 mo / 1 mo); don't extend without reason.

## How to get the real numbers

1. **AWS Cost Explorer** (per account) → group by Service, last 30/90 days → the
   authoritative per-service breakdown. Replace the `est.` columns here from this.
2. **The $600 budget + $50/day anomaly monitor** are already wired to `sps-notify-prod` —
   they *push* when something is off; you don't have to watch.
3. **Re-audit at the EdgeStack and EtlStack budget-review triggers** ([`SLOs.md § Review cadence`](./SLOs.md))
   and update both this doc's baseline and the `sps-monthly-budget` threshold.

## Known gaps

- **No per-env cost breakdown** — single-tenant accounts + poor tag isolation make the
  account-wide figure the working number.
- **`est.` figures are size-derived, not billed** — treat them as relative weights until
  replaced from Cost Explorer.
- **Post-Edge/Etl baseline is not yet audited** — the $425 figure is the Phase 0+1 number;
  the launch-time figure will be higher and must be re-measured.

---

*Baseline as audited 2026-05-28 (Phase 0+1, ~$425/mo combined). Re-audit against Cost
Explorer after EdgeStack + EtlStack are active in prod.*
