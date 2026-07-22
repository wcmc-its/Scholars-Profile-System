# MATCHA_GLOSS_RERANK λ-sweep — eval runbook

Turnkey steps to run the offline eval that gates `MATCHA_GLOSS_RERANK` (shipped dark in PR #1849,
master `84328e3d`). The flag is a **ranking change**, so it stays off in both envs until this eval
picks a λ or kills it. Vehicle: `scripts/search-eval/spine-eval-*` (the reusable in-VPC spine runner).

The steps split across two environments because neither has both dependencies: **extraction needs
Bedrock** (laptop; the `sps-etl` role has no Bedrock), **retrieval needs OpenSearch** (in-VPC only).

## Arms

One arm per process (the extractor memo key carries no arm identity). `spine-eval-run.ts` maps the
`ARM` value to the rescore flags via `glossArmEnv` (`spine-eval-arm.ts`):

| `ARM`        | `MATCHA_GLOSS_RERANK` | λ (`rescore_query_weight`) | meaning |
|--------------|-----------------------|----------------------------|---------|
| `base`       | (off)                 | —                          | ablation — today's ordering |
| `gloss-0.25` | on                    | 0.25                       | rescore, light |
| `gloss-0.5`  | on                    | 0.5                        | rescore, medium |
| `gloss-1.0`  | on                    | 1.0                        | rescore, full |

## Prerequisite — the in-VPC image must contain the rescore

The retrieval runs the **app spine** (`rankResearchersForDescriptionSpine`) inside the
`sps-etl-staging` task, so that task def's image must be built from master **at or after `84328e3d`**.
The flag env is supplied per-arm at run time, but the *code* has to be in the image — otherwise every
arm runs the base path and the sweep is a silent no-op. Confirm before spending an ECS task:

```bash
aws ecs describe-task-definition --task-definition sps-etl-staging \
  --query 'taskDefinition.containerDefinitions[0].image' --output text
# → the image tag/sha should trace to a master build ≥ 84328e3d
```

## Step 0 — self-check (laptop, no infra, no AWS)

Proves the seed key lands **and** the arm→env mapping is correct (a wrong mapping makes a base arm and
a gloss arm produce identical rankings — the sweep would read "λ had no effect", a false-negative kill).

```bash
npx tsx scripts/search-eval/spine-eval-selftest.ts   # asserts; non-zero exit on failure
```

## Step 1 — extract (laptop / Bedrock)

The 15 canonical fixtures live in the untracked `scripts/search-eval/sponsor-fixtures.json` under
`.prompts` (`{id, paste, topic, notes, ideal}`). Build the `[{id, paste}]` input and extract once
(shared by every arm, so the extractor's ~0.0074 nDCG noise cancels within each pair):

```bash
jq '[.prompts[] | {id, paste}]' scripts/search-eval/sponsor-fixtures.json > /tmp/pastes.json
AWS_REGION=us-east-1 npx tsx scripts/search-eval/spine-eval-extract.ts /tmp/pastes.json \
  > scripts/search-eval/extractions.json
# stderr logs "ok <id>: N concepts, M glossed" per fixture; the JSON goes to the file.
```

## Step 2 — dispatch all arms (in-VPC; operator runs the ECS task)

`aws ecs run-task` / `stop-task` are classifier-blocked for the agent — **operator runs this.** One
`run-task`, all four arms, each a separate node process inside the container:

```bash
ARMS="base gloss-0.25 gloss-0.5 gloss-1.0" \
  ./scripts/search-eval/spine-eval-dispatch.sh scripts/search-eval/extractions.json
# writes s3://<bucket>/<prefix>/{base,gloss-0.25,gloss-0.5,gloss-1.0}.json — each {id: [cwid, ...]}
```

Netcfg (sg/subnet) is resolved at runtime from `scholars-nightly-staging`; transport is presigned GET
inbound, `s3://` outbound. The six in-VPC environment traps are already paid for in the committed
scripts (see `docs/2026-07-20-matcha-retrieval-eval-handoff.md` §"Environment traps already paid for").

## Step 3 — score + decide

Pull the four arm files from S3 and score each against the `sponsor-fixtures.json` gold with
`sponsor-eval.sh`. **Read the eval-fair metric, not raw nDCG (#1839):**

- **nDCG over GRADED candidates only** (restrict ideal + actual to graded cwids). A rescore can lift a
  *retrieved-but-ungraded* candidate → an artificial gain-0 in a raw full-pool nDCG. Do **not** read a
  raw full-pool delta as the verdict.
- **Pairwise judged-relevant displacement** — did graded-relevant scholars move up vs down.
- Recall is **invariant across arms by construction** (identical pool; a rescore only re-orders), so
  the 07-20 "judged-relevant lost vs gained" is 0/0 here. That is the point.

Confirm `sponsor-eval.sh` is computing the graded-only restriction (or restrict manually) before
comparing — a raw full-pool number is not the gate.

**Decision:** pick the λ that wins on the graded-only metric; **kill if flat or negative.** If a bad
result traces to *gloss quality* (61% of glossed concepts share no token with their own term; some
glosses are context-only), that is the #1799 extractor-prompt problem, not this mechanism.

## If it wins

`MATCHA_GLOSS_RERANK` staging-on **and** wire `MATCHA_GLOSS_RERANK_LAMBDA` to the chosen λ in
`cdk/lib/app-stack.ts` (it is allowlisted eval-only today) → `cdk deploy --exclusively Sps-App-staging
-c env=staging` → re-eyeball Matcha (staging retrieval was degraded pre-#1814) → deliberate prod. It is
a live ranking change; verify on the graded-only metric, not raw nDCG.
