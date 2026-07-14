# Cost model

**Audience.** Operators, ITS colleagues, and budget owners answering *"what does Scholars
cost to run, what drives the bill, and how does it compare to VIVO?"*

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
| **Bedrock (LLM callers)** | Opus 4.8 + Sonnet 4.5, on-demand | same | per-token (in/out) per call | **Three** callers: overview + biosketch *generate* (Opus, `lib/edit/overview-generator.ts`, `lib/edit/biosketch-generator.ts`) and sponsor-match concept extraction (Sonnet, `lib/api/sponsor-match-extract.ts`). The two generators are rate-limited 10/hr/scholar with **no bulk path** and persist their output; **sponsor-match is not rate-limited** (30-min result cache only). ~$0.03–0.40/draft, ~$0.01/paste → **tens of $/mo** `est.` (see *Runtime LLM spend* below). |
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

## Runtime LLM (Bedrock) spend

The app calls Bedrock from **three** places, on two models.

Two are the self-service generators — the overview/research-summary and the NIH biosketch
(`lib/edit/overview-generator.ts`, `lib/edit/biosketch-generator.ts`), both on **Claude Opus
4.8**. On-demand, per-scholar, **rate-limited to 10 generations/hour per target** (`lib/edit/
rate-limit.ts`) with **no app-side bulk path**; drafts are persisted, so a re-render never
re-calls the model. The app computes its own per-draft estimate
(`lib/edit/overview-prompt-versions.ts`, surfaced to superusers) at the Opus $5/$25-per-Mtok
rate:

- **Overview** — 1 call (~5k in / 300 out) → **~$0.03/draft** `est.` (faithfulness pass off in prod).
- **Biosketch** — faithfulness pass on → up to ~18 calls/generation → **~$0.40/draft** `est.`,
  but **prod-dark today** (staging only), so it adds **$0 to the prod bill** until it rolls out.

The third is **sponsor-match concept extraction** (`lib/api/sponsor-match-extract.ts`) — one
**Claude Sonnet 4.5** call per pasted sponsor description, at the Sonnet $3/$15-per-Mtok rate.
`SPONSOR_MATCH_EXTRACT_MODEL` repoints it at runtime; the IAM policy scopes both the Opus 4.8
and Sonnet 4.x families, so an intra- or cross-family repoint needs no cdk change.

- **Sponsor match** — 1 call (~1.0–2.0k in / ≤1k out) → **~$0.01/paste** `est.` The ~815-token
  system prompt dominates, so a 40-word note and a 600-word FOA cost within ~40% of each other.
  The route caches on a sha256 of the input (30-min TTL), so a re-submitted paste costs **$0**.
  The post-extraction fan-out is OpenSearch only — no further LLM spend.

At realistic adoption this is **tens of dollars/month** `est.` — small next to Aurora/OpenSearch.
The two generators scale with *generate* volume, not page views, so a bulk backfill over the
faculty would be a one-time spike (~$0.10 × N overviews) to plan for.

**Sponsor match is the one uncapped Bedrock path.** It is not wired to `lib/edit/rate-limit.ts`,
so unlike the generators it has no per-user ceiling and no bulk-path block — the only brakes are
the 30-minute result cache and the account budget alarm. The per-call price makes this a slow
leak rather than a cliff (~100k pastes to reach $1k), but the guardrail here is the budget alarm,
not a rate limiter. Revisit if the console is ever opened past a handful of research-development
staff, or if a batch/scripted caller is ever put in front of it.

## Compared to VIVO (the system Scholars replaces)

VIVO has no published run-cost figure; the number below is **derived** `est.` from its provisioned
sizing in `VIVO Architecture Overview - 2025-10-07` (EC2 `t3.xlarge` load-balanced pair, RDS
`db.m5.xlarge` MySQL with 100 GB + 1,000 provisioned IOPS, ALB+WAF, CloudFront, NAT). On-demand
`us-east-1`:

| VIVO component | Monthly `est.` |
|---|---|
| EC2 2× `t3.xlarge` (24×7) | ~$243 |
| RDS `db.m5.xlarge` single-AZ + io1 100 GB / 1,000 IOPS | ~$362 |
| ALB + NAT + CloudFront/WAF + ECR/S3/CloudWatch | ~$100 |
| **VIVO total** | **≈ $700/mo** (range ~$500–1,000 by RDS Multi-AZ and reserved pricing) |

So Scholars (~$425/mo audited → $600/mo budget) **runs at roughly the same-or-lower infra cost than
the system it replaces**, while removing the VIVO support burden
([`vivo-incident-analysis.md`](./vivo-incident-analysis.md)). The build-vs-buy framing — building
Scholars in-house vs. licensing Elsevier Pure Portal at **$192K–$246K/yr** — lives in the ASMS
strategic-planning docs (*Updated Options Matrix — With Pure*), not in this repo.

## Upstream: ReciterAI pipeline (separate, near-zero standing cost)

ReciterAI (topic hierarchy, publication scoring, spotlight, methods entities) is an
**on-demand/scheduled batch** system that publishes to S3 + DynamoDB for SPS to read; it runs
**nothing 24/7**. Its **own** standing infra is essentially DynamoDB + S3 storage — **well under
$10/mo** (its own `docs/cost-model.md`); its Bedrock spend is ~$15/mo steady-state plus ~$210 per
annual full rebuild, tracked there too. **Don't fold it into the SPS budget:** SPS pays for
*reading* the `reciterai` table/buckets; ReciterAI pays for the compute and storage that produce
them. The two run in different accounts with separate cost models.

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
Explorer after EdgeStack + EtlStack are active in prod. Runtime-LLM, VIVO-comparison, and
ReciterAI sections added 2026-06-24 — all `est.`/derived, not billed; re-ground from Cost
Explorer (and the VIVO account) at the budget review.*
