# Cores (core-facility usage)

How the "core facilities" feature works end to end — from candidate generation in
ReciterAI, through the SPS ETL, to the public pages and the owner review queue.

A **core** is a WCM shared research facility (Biomedical Imaging, Genomics
Resources, Flow Cytometry, …). The feature surfaces, per core, the **publications
that used it** — inferred by the ReciterAI engine and confirmed by core owners.

---

## Surfaces

| Surface | Route | Audience | Flag |
|---|---|---|---|
| Core index | `/cores` | public | `CORE_PAGES` |
| Per-core page | `/cores/[coreId]` | public | `CORE_PAGES` |
| "Core facilities" section in a publication modal | (per pmid) | public | `CORE_PUB_MODAL` |
| Cores review index | `/edit/core` | superuser | `CORE_PAGES` (the toolbar tab) |
| Owner review queue | `/edit/core/[coreId]` | superuser / core owner / core curator | auth-gated (no flag) |
| "Cores" tab in the admin sub-nav toolbar | — | superuser | `CORE_PAGES` |

Public surfaces show **confirmed** publications only. The review queue shows the
open **candidates** awaiting a confirm/reject decision.

Cores are keyed by the dictionary **`coreId`** (a string like `"5"`), not a slug —
the route, the canonical link, and the DynamoDB SK all agree on it (`lib/core-url.ts`).

---

## Data pipeline (end to end)

```
ReciterAI batch_screen ──▶ reciterai DynamoDB ──▶ SPS etl:dynamodb ──▶ SPS RDS ──▶ Prisma reads ──▶ surfaces
   (candidate gen)          (PUB#/CORE# rows)        (Block 6)         (core,            (lib/api/
                                                                    publication_core)   cores.ts)
```

1. **ReciterAI `batch_screen`** (the engine) scores `(publication, core)` pairs and
   writes `PUB#/CORE#` rows — `status = candidate | confirmed | below_threshold` — to
   the shared **`reciterai` DynamoDB table** (account `665083158573`, `us-east-1`).
   Writes are idempotent and never downgrade a human decision.

2. **SPS `etl:dynamodb`** (`etl/dynamodb/index.ts`, **Block 6**) seeds the `core`
   table from the version-controlled `CORE_CATALOG` constant, then scans the
   `reciterai` table for `CORE#` records and upserts `publication_core` into the
   SPS **RDS** (MySQL, via Prisma). Despite the name, this ETL *ingests from*
   DynamoDB and *writes to* RDS.

3. The app reads `core` / `publication_core` from RDS via Prisma
   (`lib/api/cores.ts` for the public pages, `lib/api/core-queue.ts` for the review
   queue).

### The catalog (FK guard)

`CORE_CATALOG` in `etl/dynamodb/core-catalog.ts` is a thin, version-controlled
mirror of ReciterAI's `config/core_dictionary.yaml` (`{id, name, facility}` per
core). Block 6 upserts the `core` table from it, then **FK-guards**
`publication_core.coreId` against it: a `CORE#` row whose `coreId` has no catalog
entry is silently skipped. **A core must be in `CORE_CATALOG` or its publications
never render.** Keep it in sync with the dictionary as cores are resolved.

---

## Status model

Two layers, read-merged in `lib/api/core-merge.ts`:

- **Engine status** (`publication_core.status`): `candidate` · `confirmed` · `below_threshold`.
- **Human override** (`CoreClaim`): `claimed` · `rejected`, set via `POST /api/edit/core-claim`.

**Effective status** = engine `confirmed` **OR** human `claimed`, minus any active
`rejected` claim.

- Public pages (`/cores/[coreId]`) render **effective-confirmed** publications.
- The review queue (`/edit/core/[coreId]`) shows **open candidates** (engine
  `candidate` with no active claim) as the review work, plus the effective-confirmed
  set for reference.

---

## Feature flags

All default **off**; staging-on / prod-off until a per-env rollout. Set the env var
in **both** `.env.local` and the per-env `environment:` block in
`cdk/lib/app-stack.ts`, then `cdk deploy Sps-App-<env>` (the flag-parity rule).

| Flag | Gates |
|---|---|
| `CORE_PAGES` | public `/cores` + `/cores/[coreId]`, and the "Cores" admin tab |
| `CORE_PUB_MODAL` | the "Core facilities" section in the publication modal |
| `CORE_CLAIM_WRITEBACK` | writing confirm/reject claims back to the `reciterai` table |

The `/edit/core/[coreId]` owner queue and `/edit/core` index are **auth-gated, not
flag-gated** — they exist wherever there is cores data; the flag only controls
whether the feature is *advertised* (the toolbar tab) in a given env.

---

## Running the engine (candidate generation)

In ReciterAI (`pipeline_cores`), the recall-safe production run:

```bash
python3 -m pipeline_cores.batch_screen --with-llm --write --drop-threshold 0.1
```

- **Model:** Sonnet, one-core title screen (`signals.batched_one_core_screen`).
- **Pre-filter (`--drop-threshold 0.1`):** drops only **zero-signal** pairs — a pub
  with no co-author overlap *and* no core-method MeSH. Keeps everything with author
  or MeSH signal, so confirmed-set recall is preserved (every confirmed pub has
  author signal). This cuts the LLM workload ~98% (972K → ~17K scorings).
- **Cost:** ~**$5** for the full corpus. (A no-filter run is ~$280 for the same
  recall on every verifiable publication — the pre-filter is the recall-safe cheap
  path, not a recall trade-off. A MeSH-*only* drop gate is **not** safe — it covers
  only 1–21% of confirmed pubs; the author signal is what carries the pre-filter.)
- **Bands** (calibrated): `candidate-min = 5` (auto-surface), `curator-min = 2`
  (drop floor; ≥2 holds 91–100% recall). Below the floor is dropped, not written.
- Writes `PUB#/CORE#` rows to the `reciterai` table (idempotent, never-downgrade).

Cores with no tracked staff **and** no MeSH branch (6 Institutional Biorepository,
7 Metabolic Phenotyping, 8 Microbiome, 10 Human Immune Monitoring) generate **zero**
candidates — an upstream ReCiter target-feed gap, not a cost or config issue.

---

## Projecting to SPS (the ETL) — and the manual workaround

Block 6 of `etl:dynamodb` does the projection. It runs as part of the nightly
orchestrator (`etl/orchestrate.ts` = `etl:daily`, driven by the
`scholars-nightly-<env>` Step Functions state machine on `cron(0 7 * * ? *)` UTC).

> ⚠️ **The nightly does not currently reach the DynamoDB step on staging.**
> `etl/orchestrate.ts` makes **ED the chain head and aborts the whole cascade if
> `etl:ed` fails** ("Q5' chain-head abort"). `etl:ed` needs on-prem LDAP, which is
> unreachable from the Sps ETL VPC until the TGW attach lands (#443). So the nightly
> dies at step 1 and never reaches `etl:dynamodb` (step ~98) — cores never project
> on their own. Fixing this means making ED non-fatal (no-op-safe like the other
> on-prem sources) so the rest of the projection self-heals.

**Manual workaround** — run `etl:dynamodb` standalone, in-VPC, bypassing the dead
ED chain head. It only reads SPS RDS + the `reciterai` table (both AWS-internal, no
on-prem dependency), so it succeeds where the full chain can't start:

```bash
# Resolve $ETL_SUBNETS/$ETL_SG live (never hardcode -- the VPC cutover moved both;
# stale ids launch into the dead VPC and time out). Same resolver as
# data-population-runbook.md §3 -- run that snippet first with ENV=staging.
aws ecs run-task \
  --cluster sps-cluster-staging \
  --task-definition sps-etl-staging \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$ETL_SUBNETS],securityGroups=[$ETL_SG],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"etl","command":["npm","run","etl:dynamodb"]}]}' \
  --started-by "manual-cores-render"
```

- Creds: the `reciter` IAM user (account `665083158573`, the staging account).
- Logs: CloudWatch group `/aws/ecs/sps-etl-staging`, stream `etl/etl/<taskId>`.
- The ETL image (`scholars-etl-staging:latest`) is rolled by CD on every master
  push, so the `CORE_CATALOG` change must be **merged first** for the run to use it.
- The same pattern force-runs any single ETL step (swap the `command`).

A healthy run logs, e.g.:

```
core catalog upserts complete: 13 rows
publication_core candidates: 12616 (skipped: 0 missing core, 3940 missing publication, 0 below threshold)
publication_core upserts complete: 12616 rows.
```

`0 missing core` confirms the catalog covers every core. `missing publication` skips
are expected — those pubs aren't loaded as SPS publications.

---

## Verifying

- `GET /cores` → 200, lists cores that have confirmed publications.
- `GET /cores/<id>` → heading reads `Publications (N)` (or "No confirmed publications
  yet." when empty).
- `/edit/core` → lists every core, each linking to its review queue.
- `/edit/core/<id>` → the candidate review queue for that core.
- "Cores" tab appears in the admin sub-nav toolbar (requires SSO to see).

---

## Per-env rollout

Staging is live. To roll a new env (e.g. prod):

1. Run `batch_screen --write` against that env's `reciterai` table (own ~$5 run).
2. Ensure `CORE_CATALOG` covers the cores you expect to render (it already lists all 13).
3. Run `etl:dynamodb` for that env (nightly, or the manual `run-task` above with the
   prod cluster/task-def/subnets).
4. Flip `CORE_PAGES` / `CORE_PUB_MODAL` / `CORE_CLAIM_WRITEBACK` on in
   `cdk/lib/app-stack.ts` for that env, then `cdk deploy Sps-App-<env>`.

---

## Key files

| Area | Path |
|---|---|
| Public per-core page | `app/(public)/cores/[coreId]/page.tsx`, `components/cores/core-page.tsx` |
| Public index | `app/(public)/cores/page.tsx`, `components/cores/cores-index.tsx` |
| Review queue | `app/edit/core/[coreId]/page.tsx`, `components/edit/core-claim-queue.tsx` |
| Review index | `app/edit/core/page.tsx` |
| Admin toolbar tab | `components/edit/admin-subnav.tsx` |
| Public data | `lib/api/cores.ts` |
| Queue data | `lib/api/core-queue.ts` |
| Status merge | `lib/api/core-merge.ts` |
| Claim authz | `lib/edit/authz.ts` (`getCoreOwnerRole`, `authorizeCoreClaim`) |
| Catalog seed | `etl/dynamodb/core-catalog.ts` |
| Projection | `etl/dynamodb/index.ts` (Block 6), `etl/dynamodb/publication-core-mapper.ts` |
| Flags | `lib/profile/cores-flags.ts` |
| Engine | ReciterAI `pipeline_cores/` (`batch_screen.py`, `prefilter.py`, `signals.py`) |
