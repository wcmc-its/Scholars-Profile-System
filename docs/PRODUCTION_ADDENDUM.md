# Production deployment & operations — addendum

Companion to [`PRODUCTION.md`](./PRODUCTION.md). Three sections that close the largest gaps in the parent document: how the writer endpoints authenticate and where their secrets come from, how the ETL pipeline is orchestrated and recovers from failure, and how schema changes ship without taking the site down. Each subsection here corresponds to one or more issues in [`PRODUCTION_BACKLOG.md`](./PRODUCTION_BACKLOG.md); resolved subsections will be merged inline into `PRODUCTION.md` and removed from here once the work ships.

## Auth, secrets, and the writer endpoints

`/api/edit` and `/api/revalidate` are the only request paths that mutate state. They sit behind the same CloudFront distribution that's caching the read-only routes for 24 hours, and the entire production posture depends on getting their auth and cache behavior right.

### `/api/edit`

The endpoint must not be cached. CloudFront behavior for `/api/edit*` and `/edit/*`: `CachingDisabled`, `AllViewer` origin request policy (forwards cookies, headers, query string).

Authentication uses WCM SSO — Shibboleth or Entra OIDC, matching whatever myAccount and the other internal apps use rather than introducing a new IdP for this app. The session cookie is HttpOnly, Secure, SameSite=Lax, scoped to `scholars.weill.cornell.edu`. The session is validated server-side on every `/api/edit*` request; there is no token in the URL, ever.

Authorization is two-tier:

- **Self-edit**: `session.cwid == scholar.cwid`. The common case.
- **Admin-edit**: membership in an AD/Entra group (e.g. `scholars-admins`). Group membership is read at session establishment and re-checked on every `/api/edit*` POST — not on every page render. Admins read pages with the same path as anyone else; the directory hit only happens on the action that requires the privilege. Trade-off: a user removed from `scholars-admins` retains admin until their next edit attempt rather than their next request, bounded by an 8-hour max session lifetime.

Anything else returns 403 with `event: "edit_authz_denied"` in the log line — alarmable as a signal of either a bug in the predicate or actual probing.

Every successful edit writes an append-only audit row: `{actor_cwid, scholar_cwid, fields_changed, before_values, after_values, row_hash, ts, request_id}`. `before_values` and `after_values` are JSON capturing the actual values of the changed fields — that's the artefact a reviewer needs ("what did the dean's office change about Smith's appointment last March?"). `row_hash` is a hash over the row's payload for tamper-evidence on the row itself, not a substitute for the values. The audit table lives in a separate schema with no `DELETE` or `UPDATE` grant for the app role. This is the artefact any future review will ask for; building it after the fact is materially harder.

### `/api/revalidate`

This endpoint exists to invalidate CDN entries after an ETL run. It must be reachable only from the ETL Lambdas.

Two layers:

1. **Network**: an internal-only ALB listener (separate from the public listener) routes `/api/revalidate*` to the same ECS service. ETL Lambdas run in a dedicated security group; the internal listener's security group allows ingress only from the ETL security group, by SG ID. No IP allowlist (NAT egress is shared with anything else in the subnet), no API Gateway, no PrivateLink — just SG-to-SG. CloudFront and the public listener never reach `/api/revalidate*`.
2. **Shared secret**: the request carries `Authorization: Bearer <token>` where the token lives in `scholars/revalidate-token` in Secrets Manager. The handler reads the expected token at cold start and compares constant-time. Rotate quarterly. Lambdas cache the token at cold start, so a rotation requires either publishing a new Lambda version after the secret update (forces a cold start) or accepting that old tokens keep working until the runtime recycles. The handler accepts both the current and previous token during a rotation window.

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
