# Production deployment & operations — addendum

Companion to [`PRODUCTION.md`](./PRODUCTION.md). Three sections that close the largest gaps in the parent document: how the writer endpoints authenticate and where their secrets come from, how the ETL pipeline is orchestrated and recovers from failure, and how schema changes ship without taking the site down. Each subsection here corresponds to one or more issues in [`PRODUCTION_BACKLOG.md`](./PRODUCTION_BACKLOG.md); resolved subsections will be merged inline into `PRODUCTION.md` and removed from here once the work ships.

## Auth, secrets, and the writer endpoints

`/api/edit` and `/api/revalidate` are the only request paths that mutate state. They sit behind the same CloudFront distribution that's caching the read-only routes for 24 hours, and the entire production posture depends on getting their auth and cache behavior right.

### `/api/edit`

The endpoint must not be cached. CloudFront behavior for `/api/edit*` and `/edit/*`: `CachingDisabled`, `AllViewer` origin request policy (forwards cookies, headers, query string).

Authentication uses WCM SSO via **Shibboleth SAML** — confirmed 2026-05-17 as the IdP `myAccount` and the other internal apps use; this app integrates as a SAML 2.0 service provider rather than introducing a new IdP. The session cookie is HttpOnly, Secure, SameSite=Lax, scoped to `scholars.weill.cornell.edu`. The session is validated server-side on every `/api/edit*` request; there is no token in the URL, ever.

Authorization is two-tier:

- **Self-edit**: `session.cwid == scholar.cwid`. The common case.
- **Admin-edit**: membership in an Enterprise Directory group (`ITS:Library:Scholars/superuser-role`), resolved by an LDAPS lookup of the group's `member` list keyed on the session CWID. The lookup runs **on every `/edit/*` request — each GET page load and each `/api/edit*` POST** — and is never cached in the session: the superuser GET pages (`/edit/scholar/[cwid]`, `/edit/publication/[pmid]`) read their target with the suppression filter off, so a stale admin claim would expose suppressed data, and a suppression's `reason`, for up to the 8-hour session. A user removed from `scholars-admins` therefore loses admin on their **next `/edit/*` request** — GET or POST. The check is fail-closed: a directory error denies, never grants. (B02 #101; the per-action rules are in `self-edit-spec.md` § Authorization. This supersedes an earlier "POST only, not on every page render" phrasing — written before the superuser GET pages were specified.)

Anything else returns 403. Every 403 emits one structured log line — `event: "edit_authz_denied"` with `{ actor_cwid, target_cwid, path, reason }` (B02 #101) — a signal of either a bug in the predicate or actual probing. A CloudWatch metric filter on the app log group (pattern `{ $.event = "edit_authz_denied" }`) feeds an `EditAuthzDenied` count metric; an alarm fires when the rate exceeds N per minute (N tuned in staging) and notifies the same SNS channel as the `etl-failures` alarm. The metric filter and alarm are CDK resources, B07-adjacent; B02 emits the event and owns this spec.

Every successful edit writes an append-only audit row: `{actor_cwid, target_entity_type, target_entity_id, action, fields_changed, before_values, after_values, row_hash, ts, request_id}` — #102's shape, generalized by #354 so it records suppression events and publication targets, not only scholar field-diffs. `before_values` and `after_values` are JSON capturing the actual values of the changed fields — that's the artefact a reviewer needs ("what did the dean's office change about Smith's appointment last March?"). `row_hash` is a hash over the row's payload for tamper-evidence on the row itself, not a substitute for the values. The audit table lives in a separate database (`scholars_audit`) on the same Aurora cluster, with an `INSERT`-only grant for the app role and no `UPDATE` / `DELETE`. Schema and write contract: [`docs/b03-audit-log.md`](./b03-audit-log.md). This is the artefact any future review will ask for; building it after the fact is materially harder.

### `/api/revalidate`

This endpoint exists to invalidate CDN entries after an ETL run. It must be reachable only from the ETL Lambdas.

Two layers:

1. **Network**: an internal-only ALB listener (separate from the public listener) routes `/api/revalidate*` to the same ECS service. ETL Lambdas run in a dedicated security group; the internal listener's security group allows ingress only from the ETL security group, by SG ID. No IP allowlist (NAT egress is shared with anything else in the subnet), no API Gateway, no PrivateLink — just SG-to-SG. CloudFront and the public listener never reach `/api/revalidate*`.
2. **Shared secret**: the request carries `Authorization: Bearer <token>` where the token lives in `scholars/revalidate-token` in Secrets Manager. The handler reads the expected token at cold start and compares constant-time. Rotate quarterly. Lambdas cache the token at cold start, so a rotation requires either publishing a new Lambda version after the secret update (forces a cold start) or accepting that old tokens keep working until the runtime recycles. The handler accepts both the current and previous token during a rotation window. The step-by-step rotation procedure is [`docs/revalidate-token-rotation.md`](./revalidate-token-rotation.md).

Either layer alone is enough for correctness; both removes the endpoint from any external attack-surface scan.

### Secrets

All credentials live in AWS Secrets Manager. The ECS task definition references each by ARN under `secrets:`, never `environment:`.

| Secret | Consumer |
|---|---|
| `scholars/db/app-rw` | App writer DSN (used by `/api/edit` and migrations only) |
| `scholars/db/app-ro` | App reader DSN |
| `scholars/db/etl` | ETL writer DSN |
| `scholars/opensearch/app` | App user (read + suggest only) |
| `scholars/opensearch/etl` | ETL user (read + write) |
| `scholars/revalidate-token` | Shared bearer for `/api/revalidate` |
| `scholars/etl/{source}` | One per ETL source (LDAP, InfoEd, COI, etc.) |

The task **execution role** gets `secretsmanager:GetSecretValue` on these ARNs and nothing else. The task **role** (the runtime identity for application code) has no secret access — code only sees secrets as env vars injected at task start. This split matters: a compromised app process cannot enumerate or rotate secrets.

DB credentials rotate via the Secrets Manager rotation Lambda for RDS. OpenSearch and the revalidate token rotate quarterly on a calendar; both are low-volume and rotation is a two-line config update on the ETL side, not worth the Lambda overhead.

### Reader/writer split

Two DSN secrets (`db/app-rw`, `db/app-ro`) imply a reader/writer split that a single `DATABASE_URL` does not deliver. Prisma needs to be told.

The implementation: two `PrismaClient` instances at module scope — one bound to `app-ro` (Aurora reader endpoint), one to `app-rw` (writer endpoint). A small `db.ts` exports `db.read` and `db.write`; route handlers and server components default to `db.read`, the writer endpoints (`/api/edit*`) and the migration task use `db.write`. `@prisma/extension-read-replicas` is the lighter alternative and acceptable; pick one and don't mix the two patterns in the same codebase.

RDS Proxy with read-write splitting is the heavier path. It adds a hop on every query and the only thing it buys at this scale is connection-pool sharing across tasks, which is already solved by `connection_limit=15` per task. Skip it.

It is also legitimate to launch with one client on the writer endpoint and split as a P1, since launch traffic is well within writer capacity. If that's the chosen path, record the decision explicitly and remove the `app-ro` secret until the split actually ships — having an unused secret around invites someone to wire it in halfway.

**Status (#115):** implemented — the explicit two-client path. `lib/db.ts` exports `db.read` / `db.write`; ETL, seed, and scripts write through `db.write`, and `npm run audit:db-writes` (CI-gated) proves no write hits the read client. `db.read` falls back to the writer until `DATABASE_URL_RO` is set, so the reader endpoint activates by configuration with no code change.

### Cookies and the cache key

Cacheable routes (`/`, `/scholars/*`, `/topics/*`, `/departments/*`, `/centers/*`, `/sitemap.xml`): forward **no cookies**, do not include cookies in the cache key. These pages don't read session state and any forwarded cookie fragments the cache per user.

Uncacheable routes (`/api/edit*`, `/edit/*`, `/api/revalidate*`): forward all cookies, `CachingDisabled`.

`/search` is `force-dynamic` but session-agnostic — forward no cookies. Revisit only when personalization is added, not preemptively.

## ETL orchestration

The original doc identifies the `reciter → dynamodb` ordering constraint but leaves the orchestration choice open between EventBridge sequential rules and Step Functions. Pick Step Functions.

### Why Step Functions

Sequential EventBridge rules ("schedule `dynamodb` 30 min after `reciter`") drift the first time `reciter` runs long. The `dynamodb` rule fires on its schedule whether or not `reciter` succeeded — worse, whether or not it finished. EventBridge has no clean way to express "wait for the previous step's success."

Step Functions makes the dependency explicit, gives per-step retries-with-backoff, short-circuits dependents on a failure, and produces a single execution-history view per nightly or weekly run. Cost at this volume is rounding error.

### State machines

One state machine per cadence:

- **`nightly`**: `ed` → `asms` → `infoed` → `coi` → `search-index` → `completeness` → `revalidate`.
- **`weekly`**: `reciter` → `dynamodb` → `spotlight` → `search-index` → `revalidate`.
- **`annual`**: `hierarchy` → manual approval gate → `revalidate`.

Each step is a `Task` invoking the corresponding Lambda. Retries: 2 attempts with exponential backoff for transient errors (network, throttling). No retries for data errors — those should fail loud and page.

`Catch` blocks publish to an `etl-failures` SNS topic that PagerDuty (or whatever the on-call routing is) subscribes to. State machine type is `Standard`, not `Express` — full execution history and runs are minute-scale, not millisecond-scale.

### The reciter → dynamodb consistency window

The cascade is the real risk: `reciter` `deleteMany`s `Publication`, which cascades `PublicationTopic`. Until `dynamodb` finishes, the site is missing topic edges for every publication that was just rewritten. User-visible symptom: "publication exists, has no topics."

The default answer is to **accept the window and mask the UI**. A small `etl_state` table holds `last_topic_rebuild_at`. The topic strip in the profile UI renders a "topics updating" placeholder when `now - last_topic_rebuild_at < 30 min` (the typical reciter → dynamodb gap). Crude but honest; doesn't require transactional coupling between two ETLs.

The alternative — **stage the rebuild and swap atomically** — is materially more work and not a like-for-like alternative. It requires shadow tables (`publication_staging`, `publication_topic_staging`) modeled in `prisma/schema.prisma`, a `RENAME TABLE` step in the ETL that takes a brief metadata lock on Aurora, two ETLs that both know about staging-vs-live, and 2× transient storage on weekly runs. It also doesn't actually eliminate the window — only shrinks it to the rename's metadata-lock duration. Treat it as a separate scoped project to take on only if the placeholder is rejected by stakeholders, not a one-line config switch.

### search-index rebuild via alias swap

The nightly `search-index` rebuild must never blank the live index. Pattern:

1. Index name: `scholars_v{timestamp}`. Read alias `scholars` points to exactly one versioned index at any time.
2. The ETL writes to a fresh `scholars_v{N+1}`.
3. On success, atomically swap the alias: `POST /_aliases` with `add` and `remove` actions in one request body.
4. Retain the previous versioned index for one cycle as a fast rollback path. Delete two cycles old.

The app always queries `scholars`, never a versioned name.

### Alerting, idempotency, and resumability

- Failures are caught by the state machine's per-step `Catch` blocks, which publish to the `etl-failures` SNS topic (described above). Step Functions invokes Lambdas synchronously via `Task` states, so Lambda DLQs do not fire — `Catch` is the only relevant error path.
- Each ETL is idempotent at the run level: re-running the same input produces the same output. The pattern is upsert-with-delete-of-missing, not append.
- ETLs are **not resumable mid-run**. If `reciter` fails at minute 4 of 5, the next run restarts from minute 0; the ≤5 min restart cost is the accepted operating model. Idempotency makes restart safe; it doesn't make it cheap. If a single ETL grows past ~15 min and partial-progress restarts become painful, that's the trigger to add a checkpoint table — not before.
- Each ETL writes a checkpoint row to `etl_run` (`source, started_at, finished_at, status, source_revision, rows_written, error`). This is a run-level audit, not mid-run state. The data dashboard queries this table. CloudWatch alarms fire when `status != 'success'` or when `started_at` is older than the expected cadence — the second catches a state machine that failed to start at all, which the first wouldn't.

### Manual / out-of-band runs

To trigger a run:

```
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:...:stateMachine:scholars-weekly \
  --input '{}'
```

…from a bastion or via a small internal CLI. There is no "run one ETL by itself" button — the dependencies make per-step manual invocations error-prone.

To re-run from a specific step rather than the start, the state machine must explicitly route on input. Add a `Choice` state at the top:

```jsonc
// abbreviated ASL
"StartAt": "Router",
"States": {
  "Router": {
    "Type": "Choice",
    "Choices": [
      { "Variable": "$.startFrom", "StringEquals": "dynamodb",  "Next": "dynamodb" },
      { "Variable": "$.startFrom", "StringEquals": "spotlight", "Next": "spotlight" }
    ],
    "Default": "reciter"
  },
  "reciter":      { "Type": "Task", /* ... */ "Next": "dynamodb" },
  "dynamodb":     { "Type": "Task", /* ... */ "Next": "spotlight" },
  "spotlight":    { "Type": "Task", /* ... */ "Next": "search-index" },
  "search-index": { "Type": "Task", /* ... */ "Next": "revalidate" },
  "revalidate":   { "Type": "Task", /* ... */ "End": true }
}
```

With the router in place, `--input '{"startFrom": "dynamodb"}'` actually skips reciter. Without it, the input is silently ignored and the state machine starts from the beginning anyway. Operators do not invoke individual Lambdas directly under any circumstances.

## Schema migration policy

Prisma migrations are forward-only and run before the new app version starts. Every migration must therefore be backwards-compatible with the currently-running app version, or the rollout window is an outage.

### The rule

**Every migration is additive.** No column is dropped, renamed, or retyped in the same migration as the code that depends on the change. Breaking changes ship as three deploys:

1. **Expand**: add the new column / table / index. App still reads the old shape; the new column is nullable or defaulted.
2. **Backfill + dual-write**: app writes both old and new; a one-shot job backfills existing rows; reads still come from the old column.
3. **Contract**: app reads from the new column; the old column is dropped in a later migration once the new shape has been live for at least one full backup retention window.

This is the only reliable zero-downtime path with Prisma + ECS rolling deploys + Aurora. There is no shortcut.

### Where migrations run

Migrations run as a one-shot ECS task in the deploy pipeline. Not from the app at startup, not from a developer's laptop:

```
deploy pipeline:
  1. build image
  2. push to ECR
  3. run migration task
     image:   same image as the new app version
     command: prisma migrate deploy
     secret:  scholars/db/app-rw
     exit 0 → continue; non-zero → fail the deploy, do not roll the service
  4. update ECS service → rolling deploy of the new image
```

`prisma migrate dev` is never run anywhere above a developer laptop. `prisma db push` is never run against any environment.

### Rollback

There is no migration rollback. If a new schema causes problems, fix forward with another expand. Trying `migrate resolve --rolled-back` against live traffic is a fast path to split-brain between `_prisma_migrations` and the actual schema.

App code rollback after a successful migration: the new schema is already backwards-compatible by rule, so rolling the ECS service back to the previous image works. The previous version reads the old shape; the new column is unused until the next deploy makes it active.

### Backfills

Backfills are not migrations. A backfill is a one-shot ECS task or Lambda that reads and writes data, parameterized so it can be re-run safely. Keep backfill scripts in `scripts/backfills/{YYYY-MM-DD}-{description}.ts` and check them in, even though they only run once — the audit trail matters.

A backfill never blocks a deploy. It runs after the expand migration is in place and before the corresponding contract migration.

### PR review checklist

Add to the PR template for every PR touching `prisma/schema.prisma`:

- [ ] Migration is additive only (no `DROP COLUMN`, no `ALTER COLUMN` changing type).
- [ ] Previous app version still works against the new schema.
- [ ] New app version still works against the old schema until the migration runs.
- [ ] If a backfill is needed, script is in `scripts/backfills/`.
- [ ] If this is the contract step of an expand-contract, the expand has been live for at least the backup retention window.

## AppStack

The compute and ingress plane. Provisioned by `cdk/lib/app-stack.ts` (ADR-008 stack 3 of 6, row `B05+B06+B09+B17`).

### Two-ALB topology

The application sits behind two Application Load Balancers, not one ALB with two listeners. Both forward to the same target group; the ECS service registers tasks once.

- **Public ALB** (`sps-public-${env}`, scheme=`internet-facing`, public subnets) — serves end-user traffic from CloudFront once `B07+B14` (EdgeStack) ships. Until then it serves HTTP-only on :80 from any internet client that resolves the AWS-allocated DNS name. The DNS name is not published; the SAML cookie's `Secure` attribute prevents it transmitting over plain HTTP. Tolerable for one PR cycle.
- **Internal ALB** (`sps-internal-${env}`, scheme=`internal`, private-with-egress subnets) — backs the intra-VPC `/api/revalidate` path. The listener exists with no SG ingress; once EtlStack ships the ETL Lambda SG, EtlStack adds the SG-to-SG ingress on the internal ALB SG that makes it reachable. Until then the listener is provisioned but unreachable.

The two-ALB split keeps the SG semantics clean: the internal ALB SG can be scoped tightly to the ETL Lambda SG, never accidentally widened by an unrelated listener edit. Trading one extra ALB's monthly cost (~$16) for that boundary is correct for SPS's threat model.

### Role split (B06)

The ECS service uses two distinct IAM roles, each with the minimum permissions for its part of the task lifecycle:

- **Task-execution role** (`sps-task-exec-${env}`) — assumed by ECS itself to pull the image, inject secret values into the container's env, and write CloudWatch log streams. Permissions: `ecr:GetAuthorizationToken` (account-level), ECR `BatchCheckLayerAvailability`/`GetDownloadUrlForLayer`/`BatchGetImage` on the SPS repo ARN only, `secretsmanager:GetSecretValue` on **exactly the five consumer ARNs**, `logs:CreateLogStream`+`PutLogEvents` on the two log groups only. No `*` resource on any non-auth statement.
- **Task role** (`sps-task-${env}`) — assumed by the application code at runtime. Today: **zero attached permissions**. The Next.js + Prisma + OpenSearch client code calls no AWS API; secrets are injected by ECS via the *execution* role before the container starts, never assumed by the running app. Any future addition to this role goes through review — the test suite asserts the policy contains zero `secretsmanager:*` actions.

The split matters: an RCE in the running app surfaces the *task* role's permissions, not the execution role's. With zero on the task role, an attacker who lands code execution gets nothing they can't already get from the container's already-injected env vars.

### Migration task (B09, CDK half)

`cdk deploy` provisions a one-shot `sps-migrate-${env}` Fargate task definition that runs `npx prisma migrate deploy` with `DATABASE_URL` set to the writer DSN secret. The CDK ships the task family; *invocation* lives in the (deferred) GitHub Actions deploy workflow that B09/B12 follow-on will ship. Issue #108 stays open after this PR merges; it's closed by the workflow PR.

Migration log streams go to `/aws/ecs/sps-migrate-${env}` (separate log group from the app) so a failed migration's traceback is easy to find.

### GitHub Actions OIDC role (provisioned, unused until B09/B12)

`sps-deploy-${env}` is the IAM role the deploy workflow assumes via OIDC. The role exists after this PR but no workflow invokes it yet. Trust policy:

- Audience: `sts.amazonaws.com`.
- Subject (prod): `repo:wcmc-its/Scholars-Profile-System:ref:refs/heads/master` — only deploys originating from `master` branch.
- Subject (staging): `repo:wcmc-its/Scholars-Profile-System:*` — feature branches can deploy to staging.

Permissions are tightly scoped to AppStack-owned resources: ECR push on this repo, `ecs:RunTask` on the migration task family ARN, `ecs:UpdateService`+`DescribeServices` on the SPS service ARN, `ecs:DescribeTasks`+`ListTasks` on `cluster/sps-cluster-${env}/*`, and `iam:PassRole` on the two task-side roles (conditioned to `iam:PassedToService=ecs-tasks.amazonaws.com`). The test suite asserts no `*` Resource on any non-`GetAuthorizationToken` statement.

The OIDC provider itself (`token.actions.githubusercontent.com`) is account-scoped — only one can exist per AWS account. The single-account staging+prod deviation means the first AppStack to deploy creates the provider; the second must reuse it by ARN. Pass `-c githubOidcProviderArn=arn:aws:iam::665083158573:oidc-provider/token.actions.githubusercontent.com` on the second deploy to reuse the first's provider.

### Bootstrap two-step (first deploy)

On the first deploy of `Sps-App-${env}`, ECR is empty. The ECS service can't pull an image, so it would loop on failed tasks for ~15 minutes before the deploy times out. The recipe is:

1. `cdk deploy --exclusively Sps-App-${env} -c env=${env} -c appDesiredCount=0` — ECS service ramps to 0 tasks.
2. Build + push the bootstrap image manually (`docker push ${account}.dkr.ecr.us-east-1.amazonaws.com/scholars-app-${env}:bootstrap`).
3. Optionally run the migration task once (`aws ecs run-task --task-definition sps-migrate-${env} ...`) — empty migrations directory at minimum proves the wiring.
4. `cdk deploy --exclusively Sps-App-${env} -c env=${env}` — drops the override; desiredCount returns to the env-config value (1 staging / 2 prod).

Every deploy uses `--exclusively` until the `fix/infra-network-az-literal` row ships (Footgun #1 — NetworkStack would otherwise hit mass subnet replacement on the AZ-literal vs `Fn::Select` drift). The bootstrap recipe will move into the deploy runbook (B12) verbatim.

### VPC endpoints (B17) — placement deviation from ADR-008 Table 4

ADR-008 Table 4 and the NetworkStack header comment both put VPC endpoints in `NetworkStack`. The `B05+B06+B09+B17` row's `OWNS` column placed them in `AppStack`. The decision was to honor the row's `OWNS` column rather than touch the locked NetworkStack for a single comment-only edit; the structural shape (new SG owned here, referencing NetworkStack's VPC + app/ETL SGs) is identical to DataStack's Aurora and OpenSearch SGs and is a structurally valid home.

Provisioned:

- **Secrets Manager interface endpoint** — keeps task-execution-role secret pulls off the NAT.
- **OpenSearch (`es`) interface endpoint** — keeps app + ETL query traffic on the AWS backbone.
- **S3 gateway endpoint** — keeps ECR image-layer pulls (S3-backed) off the NAT; route-table associations only, no SG.

The interface endpoint SG admits :443 from the app SG and the ETL SG only. CDK's default `:443 from VPC CIDR` ingress is suppressed via `open: false` so the surface is the two SG-to-SG rules and nothing else. The ETL SG ingress is included now, even though ETL Lambdas don't exist yet, so EtlStack doesn't have to re-touch this stack's endpoint SG when it ships.

The NetworkStack header comment still reads "VPC endpoints (B17) are added to this stack in Phase 4." That's stale relative to where they actually landed. Recording the deviation here is the cheaper path than a hot-fix workstream against a locked stack to update a comment.

### Outputs surfaced for downstream stacks

| Output | Consumer | What it carries |
|---|---|---|
| `EcrRepoUri` | B09/B12 workflow | `docker push` destination |
| `EcsClusterName` | EtlStack, B09/B12 workflow | `aws ecs run-task` cluster arg |
| `EcsServiceName` | EtlStack, B09/B12 workflow | `aws ecs update-service` target |
| `EcsAppTaskFamily` | EtlStack | Task-family ARN scope |
| `EcsMigrationTaskFamily` | B09/B12 workflow | `aws ecs run-task --task-definition` |
| `PublicAlbDns` | EdgeStack (B07+B14) | CloudFront origin domain |
| `InternalAlbDns` | EtlStack (B08+B20) | `/api/revalidate` host |
| `DeployRoleArn` | B09/B12 workflow | `aws-actions/configure-aws-credentials` |

## Phase 3 — EtlStack (B08 + B20)

Stack 4 of six in ADR-008. Provisions the nightly / weekly / annual Step Functions state machines, the EventBridge schedules that fire them, the SNS topic + six CloudWatch alarms that detect failures, the SG-to-SG ingress that finally makes the internal ALB reachable from the ETL workload, and a single Fargate task family that runs `npm run etl:<source>` against the AppStack ECR image.

### Task integration — ECS RunTask `.sync`, not Lambda (D1 deviation)

The pre-AppStack PRODUCTION_ADDENDUM text and the B08 issue described "Lambda" tasks. The ETL scripts shipped in `etl/*` are Node entrypoints invoked via `npm run etl:<source>` — they read `DATABASE_URL` / `OPENSEARCH_*` / `REVALIDATE_TOKEN` / `ETL_<SOURCE>_SECRET` from env vars exactly as they do locally. Packaging each as a Lambda would multiply the build/CI/maintenance surface and run into the Lambda 15-minute execution cap (`reciter` already runs past 5 minutes today). Instead, every state-machine step is a Step Functions task using the AWS-managed `arn:aws:states:::ecs:runTask.sync` integration against the single `sps-etl-${env}` Fargate task family, with per-step container `command` overrides selecting the source. The image, ECR repo, ECS cluster, and ETL SG are all reused from AppStack — no second image to maintain, and the VPC / endpoint / SG wiring already set up for AppStack's app SG and the ETL SG covers the ETL workload identically.

### Manual-approval gate — `SnsPublish.waitForTaskToken` (D3)

The annual hierarchy state machine ends with a manual-approval gate. Implemented as a single `SnsPublish` task with `integrationPattern: WAIT_FOR_TASK_TOKEN` directly — no bespoke Lambda. The task publishes a message to `etl-failures-${env}` containing the task token; an operator runs:

```
aws stepfunctions send-task-success --task-token <token> --task-output '{}'
```

from this runbook to release the execution. A 7-day cap on the approval window auto-fails the execution if no one approves in time. The gate's catch path publishes a follow-up notification before the `Fail` state. Until B23 wires PagerDuty, subscribe an email to `etl-failures-${env}` manually for the first annual run.

### Cadence + status alarms — native Step Functions metrics (D4)

Six CloudWatch alarms total, two per state machine, all targeting the `etl-failures-${env}` SNS topic:

- **Status alarm** (`sps-etl-<cadence>-status-${env}`) — `AWS/States.ExecutionsFailed` `Sum > 0` per state machine over a 1-hour evaluation period. Catches every failed execution including ones that crash before the per-step `Catch` block runs.
- **Cadence alarm** (`sps-etl-<cadence>-cadence-${env}`) — `AWS/States.ExecutionsStarted` `Sum < 1` over a period slightly longer than the cadence (30 hours / 9 days / 380 days). `treatMissingData: BREACHING` so a total absence of metric data alarms instead of the default of staying NotBreaching, which would silently miss a disabled rule.

The Aurora-derived cadence check the original spec mentioned (Lambda polls `SELECT MAX(started_at) ...`) is intentionally not built in this row — the Step Functions metric covers the same failure mode with fewer moving parts. If a future incident shows a class of failure that slips through Step Functions metrics but is visible in `etl_run`, add it then.

### EventBridge cadences (D7)

| Cadence | Cron (UTC) | Local (US Eastern) | Rationale |
|---|---|---|---|
| Nightly | `cron(0 7 * * ? *)` | 02:00–03:00 ET (DST-dependent) | After WCM nightly source feeds settle |
| Weekly | `cron(0 8 ? * SUN *)` | Sun 03:00–04:00 ET | After the Saturday nightly completes |
| Annual | `cron(0 9 1 7 ? *)` | 1 Jul 04:00–05:00 ET | Post-academic-year rollover; hierarchy gates on manual approval anyway |

`config.ts.etlSchedulesEnabled` controls whether the EventBridge rules ship enabled on first deploy:

- **Staging:** `true` — rules ramp up immediately so the cadence runs the moment the first deploy lands.
- **Production:** `false` — first deploy ships rules disabled. Flip them on after the first operator-driven run via:
  ```
  aws events enable-rule --name sps-etl-nightly-prod
  aws events enable-rule --name sps-etl-weekly-prod
  aws events enable-rule --name sps-etl-annual-prod
  ```

### Operator runbook — start, skip ahead, re-run from a step

Each state machine begins with a `Choice` state on `$.startFrom`. Operators pass a step id to skip ahead — falls through to the first step when the input is empty:

```
# Run the nightly chain from the beginning.
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:<acct>:stateMachine:scholars-nightly-${env} \
  --input '{}'

# Re-run nightly starting from Reciter (skipping the Ed source).
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-east-1:<acct>:stateMachine:scholars-nightly-${env} \
  --input '{"startFrom":"Reciter"}'
```

Valid `startFrom` step ids per state machine:

- **Nightly:** `Ed`, `Reciter`, `Asms`, `Infoed`, `Coi`, `SearchIndexNightly`, `RevalidateNightly`.
- **Weekly:** `Dynamodb`, `Completeness`, `Spotlight`, `SearchIndexWeekly`, `RevalidateWeekly`.
- **Annual:** `Hierarchy` (followed by the manual-approval gate).

### Per-source secret stubs (D6)

SecretsStack appends eight `scholars/${env}/etl/<source>` stubs in this row. Each is injected into the ETL task as a single env var named `ETL_<SOURCE>_SECRET` so the script reads its credential the same way locally and in prod (`process.env.ETL_ED_SECRET`, etc.). Values are populated out-of-band per the ADR-008 hard rule.

The shared secrets the ETL task family also consumes — `db/etl` (DSN), `opensearch/etl` (user), `revalidate-token` (bearer) — are existing stubs from Phase 1 SecretsStack; the new task-execution role's `secretsmanager:GetSecretValue` resource list enumerates all eleven ARNs exactly, with no `*`.

### Cross-stack handoff

EtlStack receives `vpc`, `etlSecurityGroup`, `ecsCluster`, and `ecrRepository` from AppStack via constructor props (CDK auto-generates the cross-stack export). The internal ALB security group id, which is not exposed as a public field on AppStack, is consumed via `Fn::ImportValue` on AppStack's `Sps-App-${env}-InternalAlbSecurityGroupId` export — one additive `CfnOutput` on AppStack (the only AppStack touch in this row). The SG-to-SG ingress that admits `:80` from the ETL SG to the internal ALB SG lives in EtlStack via `CfnSecurityGroupIngress` so the rule sits in this stack regardless of which SG it modifies (same cycle-break pattern AppStack uses for its own SG ingress).

### `etl_run` write-coverage audit (B20 acceptance)

`prisma.etlRun.create` exists today in every source named in the state machines that performs an external pull (`ed`, `reciter`, `asms`, `infoed`, `coi`, `dynamodb`, `spotlight`, `hierarchy`). The internal post-processing steps reused at the close of nightly + weekly cadences (`mesh-coverage`, `vivo-redirect`, `completeness`) do **not** write `etl_run` today. Filed as follow-on tickets (see the PR description), not blocked here per the plan's B20 acceptance criterion.

### Deploy strategy

```
cdk deploy --exclusively Sps-Etl-${env} -c env=${env}
```

1. **Staging first.** Rules ramp up enabled. Smoke test with the smallest external step (`Asms` is good — short run, real external call):
   ```
   aws stepfunctions start-execution \
     --state-machine-arn arn:aws:states:us-east-1:<acct>:stateMachine:scholars-nightly-staging \
     --input '{"startFrom":"Asms"}'
   ```
   Verify the EcsRunTask resolves, the container runs, the SNS topic doesn't fire, and the state machine reaches `Succeeded`.
2. **Force a failure** for the alarm verification: start the state machine with an obviously broken `startFrom` value or temporarily push an image that exits non-zero. Verify the failure SNS message lands; subscribe an email to `etl-failures-staging` temporarily.
3. **Production** after staging signoff. Same `--exclusively` deploy. The EventBridge rules ship `Enabled=false` in prod (`etlSchedulesEnabled=false`). Run the first execution manually, then enable each rule via `aws events enable-rule`.

## ObservabilityStack

The alarms and cost guardrails. Provisioned by `cdk/lib/observability-stack.ts` (ADR-008 stack 5 of 6, row `B22`). Per-env (`Sps-Observability-${env}`); receives `appStack` and `dataStack` instances as constructor props and reads the L2 ALB / target group / Aurora / OpenSearch constructs directly rather than via `Fn::ImportValue` strings -- the same cross-stack-via-props pattern AppStack uses for NetworkStack's VPC + SGs.

The full policy half (SLO targets, error-budget burn policy, alarm threshold rationale, log retention convention, review cadence) lives in [`docs/SLOs.md`](./SLOs.md). This section is the operator-facing resource catalog.

### Eight CloudWatch alarms per env

Every alarm publishes to `sps-alarms-${env}` SNS topic, which carries one email subscription (`paa2013@med.cornell.edu`) until B23 (#122) swaps in PagerDuty/Opsgenie. Names + thresholds: see `docs/SLOs.md § Alarm catalog`. Surface coverage: public ALB x3 (5xx rate, unhealthy hosts, latency p99), ECS service x1 (task shortfall vs desired), Aurora x2 (CPU, connections), OpenSearch x2 (JVM memory pressure, cluster red).

The 5xx-rate alarm uses a CloudWatch math expression (`(5xx / IF(reqs > 0, reqs, 1)) * 100`) rather than a raw count so a zero-RPS quiet period does not false-fire on a single error response. The unhealthy-hosts alarm uses 5-of-5 consecutive 1-minute datapoints to absorb the natural ECS rolling-replace window (a new task is briefly unhealthy while the load balancer attaches it) without paging.

### SNS topic + email subscription confirmation

`sps-alarms-${env}` is the integration point B23 re-targets. First deploy of each env's stack sends a SubscriptionConfirmation email to `paa2013@med.cornell.edu`; AWS rejects messages to an unconfirmed subscription, so confirm within 3 days of first deploy or the subscription expires.

The topic ARN is exported as the `AlarmTopicArn` CFN output. B23 reads it via cross-stack props (preferred) or `Fn::ImportValue` (fallback).

### Account-wide cost guardrail (prod stack only)

Budgets and Cost Anomaly Detection are account-scoped AWS resources. Both stacks creating them would collide on the AWS-side name on the second deploy. ObservabilityStack guards their creation behind `if (envConfig.envName === "prod")`; staging synth contains zero `AWS::Budgets::Budget` and zero `AWS::CE::*` resources (asserted in `cdk/test/observability-stack.test.ts`).

| Resource | Threshold | Notification destination |
|---|---|---|
| `sps-monthly-budget` (CfnBudget) | $600 USD/mo | SNS to `sps-alarms-prod` at 50% forecast / 80% forecast / 100% actual |
| `sps-anomaly-monitor` (CfnAnomalyMonitor, dimension=SERVICE) + `sps-anomaly-subscription` (CfnAnomalySubscription, frequency=DAILY) | $50 USD daily impact | SNS to `sps-alarms-prod` |

The budget + anomaly subscriber configurations require the SNS topic's resource policy to grant `Publish` to `budgets.amazonaws.com` and `costalerts.amazonaws.com` respectively. ObservabilityStack does this via `alarmTopic.grantPublish(new iam.ServicePrincipal(...))` in the prod-only branch; without those grants the notifications silently no-op.

### Touched-but-not-modified-behaviorally: AppStack public-readonly addition

ObservabilityStack reads the public-ALB target group via `appStack.publicTargetGroup`. That property is new in AppStack as of this row; the constructor was already creating the construct (`const appTargetGroup = new elbv2.ApplicationTargetGroup(...)`) and the only addition is `this.publicTargetGroup = appTargetGroup;` plus the field declaration. Zero behavior change to AppStack synth output, but it does cross the locked-stack boundary -- recorded here so the next operator touching AppStack knows it's a sanctioned, observability-driven exposure and not drift.

### Outputs surfaced for downstream stacks

| Output | Consumer | What it carries |
|---|---|---|
| `AlarmTopicArn` | B23 (on-call routing) | SNS topic that B23 re-targets at PagerDuty/Opsgenie |

## Phase 4 — EdgeStack (B07 + B14)

CloudFront distribution fronting the `sps-public-${env}` ALB. Eight cache behaviors implementing `docs/cloudfront-cache-spec.md` (one cacheable default + seven uncacheable carve-outs for writer routes, SSO, mutating endpoints, the health probe, telemetry, and on-demand exports), plus the B14 legacy-VIVO redirect layer in `middleware.ts`. WAF (B26 #125) and security headers beyond HSTS (B21 #120) attach to the same distribution / response-headers policy in follow-on rows without restructuring it.

### Cache policy choices (D5)

| Behavior class | Cache policy | Origin request policy | Cookie forwarding |
|---|---|---|---|
| Default (`*`) | `Managed-CachingOptimized` | **none** | none -- the single most important knob in the spec |
| All other (writer / SSO / mutating / etc.) | `Managed-CachingDisabled` | `Managed-AllViewer` | full (cookies, query strings, all viewer headers) |

The spec's documented header allowlist for the default cache key is `Accept, Accept-Language, Accept-Encoding`. `Managed-CachingOptimized` includes only `Accept-Encoding`, but no route in the current app `Vary`s on `Accept` or `Accept-Language` (no content negotiation, no i18n). Swapping to a custom cache policy is a follow-on the first time a route is added that needs them.

### Origin protection: shared-secret custom header (D3)

The public ALB has no TLS today (B05+B06+B09+B17 documented exposure: HTTP-only :80, "one PR cycle"). Without protection, the public ALB DNS becomes a back-door bypass of every cache-behavior decision and any future WAF, since the DNS name is published nowhere but is trivially discoverable.

Mitigation: every CloudFront-originated request carries an `X-Origin-Verify` header injected via `Origin.customHeaders`. The public ALB listener's default action is `fixed-response 403`; a priority-1 listener rule forwards to the app target group only when `X-Origin-Verify` matches the expected value. The secret value lives in SecretsStack at `scholars/${env}/edge/origin-shared-secret` and is referenced by both stacks via the CloudFormation dynamic reference `{{resolve:secretsmanager:...}}` so it never appears in the synthesized template.

**Rotation runbook.** Generate a fresh secret and put it into Secrets Manager, then redeploy AppStack so the listener rule picks up the new value:

```
aws secretsmanager put-secret-value \
  --secret-id scholars/${ENV}/edge/origin-shared-secret \
  --secret-string $(openssl rand -hex 32)
npx cdk deploy --exclusively Sps-Edge-${ENV} -c env=${ENV}
npx cdk deploy --exclusively Sps-App-${ENV}  -c env=${ENV}
```

Order matters: deploy EdgeStack first so CloudFront starts injecting the new header value, then deploy AppStack so the listener admits it. The reverse order produces a brief 403 window because the listener rule rejects the old header while CloudFront is still sending the old value.

### Custom domain bootstrap two-step (D2)

The distribution ships with the `*.cloudfront.net` domain by default. WCM ITS owns the `weill.cornell.edu` zone and the ACM certificate for `scholars.weill.cornell.edu` is provisioned and rotated by them, not by CDK. Two optional context flags attach the alias + viewer cert once the cert ARN is in hand:

```
npx cdk deploy --exclusively Sps-Edge-${ENV} \
  -c env=${ENV} \
  -c edgeCustomDomain=scholars.weill.cornell.edu \
  -c edgeCertArn=arn:aws:acm:us-east-1:<acct>:certificate/<id>
```

Both flags must be present for the alias to attach; supplying just one is treated as "still on `*.cloudfront.net`". Route 53 / DNS CNAME / hosted-zone management stays outside this stack -- ITS handles it through their existing change-management process.

### Response-headers policy (D6, B21 follow-on)

`sps-security-headers-${env}` ships with HSTS (`max-age=63072000; includeSubDomains`) and nothing else. The policy is referenced by every behavior on day one so B21 (#120) only has to fill in CSP, X-Frame-Options, Referrer-Policy, and Permissions-Policy -- no plumbing change to the distribution.

### B14: legacy VIVO URL redirect set (#113)

After WCM ITS CNAMEs the legacy VIVO host onto the new CloudFront, legacy URLs of the form `http://vivo.med.cornell.edu/display/cwid-{cwid}` (and the well-known sibling shapes `/individual/cwid-*` and `/profile/cwid-*`) land at `scholars.weill.cornell.edu/<legacy-path>`. The B14 middleware layer rewrites them to the canonical CWID entry point with a single 301:

```
GET /display/cwid-abc1234     -> 301 -> /scholars/by-cwid/abc1234
GET /individual/cwid-abc1234  -> 301 -> /scholars/by-cwid/abc1234
GET /profile/cwid-abc1234     -> 301 -> /scholars/by-cwid/abc1234
```

The `/scholars/by-cwid/[cwid]` page then chains a second 301 to the current canonical slug via `resolveByCwidOrAlias` (`lib/url-resolver.ts`). The chained pattern keeps slug currency / aliasing in one place rather than baking a slug snapshot into the redirect map.

**Redirect set provenance.** The CWID corpus is generated from WCM Enterprise Directory:

```
filter: (&(objectClass=weillCornellEduPerson)(weillCornellEduPersonTypeCode=academic-faculty))
attrs:  ["uid", "labeledURI;vivo"]   # minimal -- never include DOB or other PII
```

The generator script `scripts/etl/generate-vivo-redirect-set.ts` parses each `labeledURI;vivo` value (e.g. `http://vivo.med.cornell.edu/display/cwid-abc1234`), de-dupes, sorts, and writes `data/vivo-redirects.json`. Run locally before each prod deploy; the JSON is checked in and consumed by middleware as a static import (Set-backed O(1) lookup). CI builds consume the committed JSON -- the script never runs in CI.

```
npx tsx scripts/etl/generate-vivo-redirect-set.ts
# Add --filter-loose if the resulting count is suspiciously low
# (broadens to weillCornellEduPersonTypeCode=academic-faculty*).
```

**Why middleware, not CloudFront Function.** Three reasons: (a) the CF Function code limit is 10 KB; a 3-4 k entry CWID -> slug object is ~100 KB. (b) Middleware already gates `/edit/*` and `/api/edit/*`; adding three matcher prefixes is a one-line diff. (c) The chained-301 design keeps the redirect map a flat CWID list with no slug snapshot to drift.

**Out of corpus -> 404, not 410.** Retired academics whose CWID is no longer in the academic-faculty set fall through to the existing 404 handler. The spec allows 410 "where no equivalent exists" but Google treats 404 and 410 equivalently after a few crawls. An explicit 410 list lives in a future `data/vivo-retired.json` if signal-from-crawlers demands it; out of scope for B14 v1.

### Verification (acceptance #15 + B14-6)

Two post-deploy spot checks live here so the manual runbook for the cutover lands in one place:

1. **Cache-key smoke test (B07 acceptance #15).** From the CloudFront console: Distribution -> Behaviors -> Default -> Cache Policy -> "Test cache policy." Submit the same path with two different `Cookie:` header values; the inspector must produce the same cache key. The header is excluded from the key by design -- a fragmented cache here means a configuration drift and silently leaks one user's cached HTML to another.

2. **Legacy URL crawler check (B14-6).** After the WCM ITS CNAME cutover, sample 20 CWIDs from `data/vivo-redirects.json`:

   ```
   shuf -n 20 <(jq -r '.[]' data/vivo-redirects.json) | while read cwid; do
     curl -sIL "https://scholars.weill.cornell.edu/display/cwid-${cwid}" | \
       awk 'BEGIN{c=0} /^HTTP/{c++; print c": "$0}'
   done
   ```

   Each sampled CWID should produce two `HTTP/2 301` (legacy -> by-cwid, by-cwid -> slug) followed by `HTTP/2 200`. If the chain stops at a single 301 with `Location: /scholars/by-cwid/*` and then a 404, the CWID is in the redirect set but no longer has an active scholar row -- expected for retirees, treat as out-of-corpus signal rather than a regression.

### Outputs surfaced for downstream stacks

| Output | Consumer | What it carries |
|---|---|---|
| `DistributionDomainName` | DNS cutover runbook (WCM ITS) | `*.cloudfront.net` domain to CNAME `scholars.weill.cornell.edu` against once the cert is staged |
| `DistributionId` | manual invalidation runbook | distribution id for `aws cloudfront create-invalidation` |
| `LogsBucketName` | follow-on analytics / B26 (WAF tuning) | S3 bucket receiving CloudFront standard access logs (`cf/${env}/`, 90-day lifecycle) |

### Deploy strategy

`cdk deploy --exclusively Sps-Edge-${env}` on first deploy. Order matters at first cutover so the public ALB does not start rejecting CloudFront mid-deploy:

1. Seed the shared secret out-of-band:
   ```
   aws secretsmanager put-secret-value \
     --secret-id scholars/${ENV}/edge/origin-shared-secret \
     --secret-string $(openssl rand -hex 32)
   ```
2. `cdk deploy --exclusively Sps-Edge-${ENV}` -- CloudFront begins injecting `X-Origin-Verify`. (CloudFront propagation is up to 15 min; do not roll back on first 5 min of "this looks hung.")
3. `cdk deploy --exclusively Sps-App-${ENV}` -- public ALB listener flips to deny-by-default plus the header-verified forward rule.
4. Smoke-test:
   ```
   curl -H "X-Origin-Verify: $(aws secretsmanager get-secret-value \
     --secret-id scholars/${ENV}/edge/origin-shared-secret \
     --query SecretString --output text)" \
     http://<public-alb-dns>/api/health      # expect 200
   curl http://<public-alb-dns>/api/health   # expect 403
   ```

Cutover from `*.cloudfront.net` to `scholars.weill.cornell.edu` is a separate deploy after WCM ITS issues the cert (see § Custom domain bootstrap two-step). Staging deploys first; prod follows after the staging cert + DNS lifecycle is exercised end-to-end.

