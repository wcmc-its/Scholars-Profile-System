# Logging reference

**Audience.** Operators and ITS colleagues answering *"where are the logs, how long are
they kept, and how do I find the line for one request / one user / one incident?"*

Companion to [`tracing.md`](./tracing.md) (distributed traces, which answer *"where did the
time go inside one request"*) and [`SLOs.md`](./SLOs.md) (alarms built on log/metric data).

---

## Where the logs live (CloudWatch Log Groups)

All SPS-owned log groups are in the env's AWS account, `us-east-1`. `${env}` is `staging`
or `prod`.

| Log group | Contents | Source |
|---|---|---|
| `/aws/ecs/sps-app-${env}` | **The main app log** — structured JSON from the Next.js runtime (all events below). | AppStack |
| `/aws/ecs/sps-migrate-${env}` | One-shot `prisma migrate deploy` task output (per deploy). Separate so a failed migration's traceback is easy to find. | AppStack |
| `/aws/ecs/sps-etl-${env}` *(see note)* | ETL task runs (`npm run etl:<source>`) launched by Step Functions. | EtlStack |
| `/aws/lambda/sps-oncall-relay-${env}` | On-call relay Lambda (SNS→Teams); `oncall_relay` events. 30-day retention. | ObservabilityStack |
| CloudFront standard access logs → S3 `cf/${env}/` | Edge request logs (RUM source until browser instrumentation exists). 90-day S3 lifecycle. | EdgeStack (`LogsBucketName` output) |
| AWS X-Ray (not a log group) | Distributed traces, 5% baseline + 100% errors/slow. | AppStack OTel sidecar — [`tracing.md`](./tracing.md) |

> The ETL log-group name is the ECS task family's default group; confirm the exact name in
> the EtlStack synth output / the Step Functions execution → task details if you can't find
> it by the pattern above.

## Retention policy

From [`SLOs.md § Log retention policy`](./SLOs.md) (`cdk/lib/app-stack.ts`):

| Environment | App + migration log groups | Rationale |
|---|---|---|
| **prod** | **3 months** | Long enough to bisect an incident reported as late as quarterly review. |
| **staging** | **1 month** | Current-deploy debugging, not historical forensics. |

The on-call relay Lambda group is 30 days. CloudFront access logs are 90 days (S3
lifecycle). **Any new SPS-owned log group MUST follow the 3-month-prod / 1-month-staging
convention.** Log groups owned by other systems (ReCiter, ReciterAI) are out of scope.

## Structured log events (the app's vocabulary)

The app emits single-line JSON: `{ event: "<name>", ... }`. These are the events to search
for, grouped by what they tell you. (Enumerated from `app/` + `lib/`.)

### Read path / usage

| Event | Meaning |
|---|---|
| `profile_view` | A scholar profile rendered at origin. Carries `duration_ms` — the per-route latency signal (alarm candidate: `duration_ms > 2000`). |
| `search_query` / `search_page_render` | A `/search` query executed / the results page rendered. |
| `autocomplete_shown` | Autocomplete suggestions returned. |
| `export_publications` | A Word/bibliography export was generated. |
| `sparse_state_hide` | A sparse profile section was hidden (completeness behavior). |

### Error handling / not-found (#668)

Server-side (these reach this log group):

| Event | Meaning |
|---|---|
| `not_found` | A 404 was served at the origin. Carries `{ path, pattern }` (`pattern` = `vivo` / `profile` / `other`). Generalizes `vivo_404` (which is kept, unchanged, for redirect-map-pruning continuity). Logs the path only — never query strings. |
| `search_degraded` | The `/search` backend (OpenSearch) failed; emitted server-side from the page's badge-count fetch before the throw reaches `search/error.tsx`. Carries `{ q_len, reason }` — query **length** only, never the text. Corroborates the AWS-side `ClusterStatus.red` alarm from the request side (alarm candidate: sustained `search_degraded` > N/min). |

Client-side (browser console → RUM via [#595](https://github.com/wcmc-its/Scholars-Profile-System/issues/595); **not** this log group): `error_boundary` (a segment `error.tsx` rendered — `{ digest, route?, kind }`, `kind` ∈ `db`/`search`/`unknown`) and `global_error` (the root `global-error.tsx` rendered — a root-layout failure, should be **rare**; `{ digest, kind }`; alarm candidate once RUM ingestion lands: rate > 0). The authoritative *server* record of a thrown render is Next.js's own error+`digest` log line; these two are the browser correlate, keyed by the same `digest`.

### Write path / auth

| Event | Meaning |
|---|---|
| `edit_authz_denied` | **A 403 on the edit surface.** Carries `{ actor_cwid, target_cwid, path, reason }` (+ unit-curation `target_entity_type`/`target_entity_id`/`role`). Feeds the `EditAuthzDenied` metric → `sps-edit-authz-denied-${env}` alarm (>10/5m, 2 windows). A burst signals a predicate regression or probing. See [`access-control-rbac.md`](./access-control-rbac.md). |
| `saml_callback_failed` | SAML assertion processing failed (login broken). |
| `superuser_check_failed` | The LDAPS superuser/role lookup errored — **note the authz is fail-closed**, so this denies the action. Spikes ⇒ ED reachability problem. |
| `edit_write_failed` | An `/api/edit` transaction failed (e.g. the #493 audit-grant class — the whole tx rolls back). |
| `self_suppression` | A scholar hid themselves / their own content. |

### Revalidation / CDN

| Event | Meaning |
|---|---|
| `edit_cdn_invalidation_failed` | Post-edit CloudFront invalidation failed (stale page until TTL). |
| `edit_revalidate_skipped` | Revalidation deliberately skipped. |
| `edit_search_reflect_failed` | An edit failed to reflect into the OpenSearch index. |

### Request-a-change / slug / feedback

| Event | Meaning |
|---|---|
| `request_change_rate_limited` / `request_change_audit_failed` / `request_change_receipt_failed` | "Request a change" flow: throttled / audit write failed / SES send failed. |
| `slug_request_rate_limited` / `slug_request_notify_failed` | Slug-request flow throttling / notification failure. |

### Taxonomy / ETL-adjacent

| Event | Meaning |
|---|---|
| `mesh_map_load_failed` / `mesh_map_load_warning` | MeSH resolver map load problem (see the sha-shortcut gotcha in [`taxonomy-aware-search.md`](./taxonomy-aware-search.md)). |
| `concept_expanded_invariant_violated` | A search concept-expansion invariant broke (data-shape bug signal). |

### On-call relay

| Event | Meaning |
|---|---|
| `oncall_relay` | The SNS→Teams relay Lambda fired; `outcome` = `delivered` / `upstream_error` / `parse_error` + HTTP status. **Never logs the webhook URL.** |

## Run-history audit (not a log, but the freshness oracle)

For *data freshness* ("when did source X last refresh, did it succeed?"), don't grep logs —
query the **`etl_run`** table (`source`, `startedAt`, `completedAt`, `status`,
`rowsProcessed`, `errorMessage`). See [`data-dictionary.md`](./data-dictionary.md). The
Step Functions execution history is the per-run orchestration view; `etl-failures-${env}`
SNS + the cadence/status alarms are the push signal ([`PRODUCTION_ADDENDUM.md § EtlStack`](./PRODUCTION_ADDENDUM.md)).

## Recipes

**Find a single user's edit 403s (Logs Insights, `/aws/ecs/sps-app-prod`):**
```
fields @timestamp, path, reason, target_cwid
| filter event = "edit_authz_denied" and actor_cwid = "abc1234"
| sort @timestamp desc
```

**Find slow profile renders:**
```
fields @timestamp, duration_ms, @message
| filter event = "profile_view" and duration_ms > 2000
| sort duration_ms desc | limit 50
```

**Confirm a deploy's migration succeeded:** read `/aws/ecs/sps-migrate-${env}` for the
deploy's timestamp; the deploy workflow asserts `exitCode == 0` ([`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md)).

**Trace one slow request end-to-end:** [`tracing.md § How to debug a slow request`](./tracing.md)
(X-Ray service map → longest span). Cross-reference the slow-query log / RDS Performance
Insights if the bottleneck is a Prisma span.

## PII / redaction posture

- **Application logs** are structured to carry identifiers like `cwid`/`pmid` as needed for
  triage (they are internal WCM identifiers, not secrets). They never carry credentials.
- **X-Ray traces redact by default** — `cwid`, `email`, `pmid`, `orcid`, Prisma parameter
  values, and dynamic route segments are hashed (`sha256:<first-12>`) before export. There
  is a per-span opt-out and a global kill switch (`SPS_TRACE_REDACT=off`) — **ask before
  flipping in prod**. See [`tracing.md § PII / redaction`](./tracing.md).
- **Secrets are never logged** — the on-call relay logs outcomes/status only, never the
  webhook URL; secret *values* never appear in logs or CDK output (ADR-008 hard rule).

## Known gaps

- **No browser/client-side logging** (no RUM beyond CloudFront access logs) — out of scope
  for B24 ([`tracing.md § What is NOT instrumented`](./tracing.md)).
- **ETL tasks are not yet traced** (Step Functions over Fargate tasks) — logs only, no
  X-Ray spans, today.
- **No central log aggregation beyond CloudWatch** (no OpenSearch/Splunk log sink); cross-
  log-group correlation is via Logs Insights + the request id / trace id.
