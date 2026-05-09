# Production-readiness backlog

Companion to [`PRODUCTION.md`](./PRODUCTION.md) and [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md). This file is the **work-tracking** artifact: a tiered list of self-contained issues, each ready to be cut into a GitHub issue with `gh issue create`. The reference docs describe what production looks like; this doc tracks what's left to build to get there.

## Conventions

- **Tracking issue:** one parent issue, "Production readiness," with a checklist linking every sub-issue. Body is in [§ Tracking issue body](#tracking-issue-body) below.
- **Milestones:**
  - `Production launch` — every P0 must close before milestone closes.
  - `Post-launch hardening` — P1 issues, scheduled in the first 8 weeks after launch.
  - P2 issues stay unmilestoned until something triggers them.
- **Labels:** `area:auth`, `area:etl`, `area:data`, `area:edge`, `area:ops`, `area:deploy` — for filtering across tiers. Plus one of `priority:P0`, `priority:P1`, `priority:P2`.
- **Issue IDs in this doc** (`B01`, `B02`, …) are local to this backlog. They map to GitHub issue numbers once cut.

## Tiering

Tiering reflects "what blocks flipping a domain at `scholars.weill.cornell.edu`," not "what would be nice." The line between P0 and P1: if the absence of this work would cause user-visible breakage, data loss, security exposure, or unrecoverable operational state on launch day, it's P0.

| Tier | Definition | Count |
|---|---|---:|
| P0 | Launch blocker | 15 |
| P1 | Launch and iterate within ~8 weeks | 9 |
| P2 | Address when triggered | 2 |

B14 (VIVO redirects) is conditionally P0: P0 if inbound `/vivo/*` traffic exists, otherwise drop or move to P2. Confirm before scoping.

---

## Tracking issue body

Paste this into the parent issue.

```markdown
# Production readiness

This issue tracks the work required to take Scholars Profile System from
`next build` runnable to a production deployment at
`scholars.weill.cornell.edu`. Reference docs:

- [`docs/PRODUCTION.md`](../blob/master/docs/PRODUCTION.md) — architecture,
  caching, load-shedding model.
- [`docs/PRODUCTION_ADDENDUM.md`](../blob/master/docs/PRODUCTION_ADDENDUM.md)
  — auth/secrets, ETL orchestration, schema-migration policy.
- [`docs/PRODUCTION_BACKLOG.md`](../blob/master/docs/PRODUCTION_BACKLOG.md)
  — this backlog with full scope per item.

## Rollout

- **Production launch (P0):** every checkbox below in this section must be
  closed before the domain flips. 15 items.
- **Post-launch hardening (P1):** scheduled in the first 8 weeks after
  launch. 9 items.
- **When-it-bites (P2):** address when the trigger actually fires. 2 items.

## P0 — launch blockers

- [ ] B01 — SSO on `/api/edit` (Shibboleth or Entra OIDC)
- [ ] B02 — `/api/edit` authorization predicate + 403 telemetry
- [ ] B03 — Append-only audit log with structured before/after diff
- [ ] B04 — `/api/revalidate` bearer auth + dual-token rotation
- [ ] B05 — `/api/revalidate` internal-only ALB listener + SG-to-SG ingress
- [ ] B06 — Secrets Manager + ECS task-execution-role / task-role split
- [ ] B07 — CloudFront cache-behavior split (cookies on writer routes only)
- [ ] B08 — Step Functions state machines for nightly / weekly / annual ETLs
- [ ] B09 — Migration pipeline (one-shot ECS task + PR checklist)
- [ ] B10 — Aurora PITR retention + manual snapshot + cross-region copy
- [ ] B11 — ALB `/healthz` shallow health check
- [ ] B12 — Deploy strategy + rollback runbook (rolling vs blue/green decision)
- [ ] B13 — Staging environment that mirrors prod
- [ ] B14 — VIVO legacy `/vivo/*` 301 redirect map *(only if inbound traffic exists)*
- [ ] B15 — `next/image` runtime cost decision (pre-resize at ETL vs unoptimized)

## P1 — launch and iterate

- [ ] B16 — Prisma reader/writer split (two clients or read-replicas extension)
- [ ] B17 — VPC endpoints for Secrets Manager / S3 / OpenSearch
- [ ] B18 — OpenSearch alias-swap pattern (`scholars_v{N}`)
- [ ] B19 — Reciter → DynamoDB consistency-window UI placeholder
- [ ] B20 — `etl_run` checkpoint table + cadence/status alarms
- [ ] B21 — Security headers at edge (HSTS, CSP, X-Frame-Options)
- [ ] B22 — SLOs + error budget; CloudWatch log retention; cost budget alarms
- [ ] B23 — On-call routing (SNS → PagerDuty/Opsgenie)
- [ ] B24 — Distributed tracing (X-Ray or OTel + Prisma instrumentation)

## P2 — when it bites

- [ ] B25 — Sitemap-index split (trigger: >40k URLs or >40 MB uncompressed)
- [ ] B26 — WAF verified-bot allowlist (trigger: legitimate Googlebot 429s in WAF logs)
```

---

## P0 — launch blockers

### B01 — SSO on `/api/edit` (Shibboleth or Entra OIDC)

**Area:** `auth` · **Refs:** ADDENDUM § `/api/edit`

**Scope.** Stand up WCM SSO in front of `/api/edit*` and `/edit/*`. Match whatever IdP myAccount uses; do not introduce a new one. Session cookie HttpOnly, Secure, SameSite=Lax, scoped to `scholars.weill.cornell.edu`. No tokens in URL ever.

**Acceptance criteria**
- [ ] Unauthenticated request to `/api/edit*` returns 401 with no body leakage.
- [ ] Successful auth produces an HttpOnly cookie with the four flags above.
- [ ] Session validated server-side on every `/api/edit*` request.
- [ ] Max session lifetime ≤ 8h.
- [ ] CloudFront behavior for `/api/edit*` is `CachingDisabled`, `AllViewer` origin request policy.
- [ ] Smoke test in staging: edit flow works end-to-end with a real SSO login.

**Depends on:** B13 (staging) for end-to-end test.

---

### B02 — `/api/edit` authorization predicate + 403 telemetry

**Area:** `auth` · **Refs:** ADDENDUM § `/api/edit`

**Scope.** Two-tier authorization. Self-edit when `session.cwid == scholar.cwid`. Admin-edit when the actor is in the `scholars-admins` AD/Entra group. Group claim is read at session establishment and re-checked on every `/api/edit*` POST (not on every page render).

**Acceptance criteria**
- [ ] Self-edit path covered by integration test (positive and negative).
- [ ] Admin-edit path covered by integration test against a test group.
- [ ] Group claim is re-fetched on every POST; verified by clearing group membership mid-session and confirming next POST is denied.
- [ ] 403 responses emit `event: "edit_authz_denied"` with `actor_cwid`, `target_cwid`, `path`, `reason`.
- [ ] CloudWatch alarm on `edit_authz_denied` rate > N/min (tune in staging).

**Depends on:** B01.

---

### B03 — Append-only audit log with structured before/after diff

**Area:** `auth`, `data` · **Refs:** ADDENDUM § `/api/edit`

**Scope.** Every successful edit writes one row to an audit table in a separate schema. Row contains `actor_cwid`, `scholar_cwid`, `fields_changed`, `before_values` (JSON), `after_values` (JSON), `row_hash`, `ts`, `request_id`. App role has `INSERT`-only; no `UPDATE` or `DELETE` grant. `row_hash` is for tamper-evidence only and is **not** a substitute for the values.

**Acceptance criteria**
- [ ] Schema migration creates the audit table in a separate schema.
- [ ] App role grants verified: `INSERT` only.
- [ ] Every successful `/api/edit*` POST writes exactly one audit row in the same transaction as the data write.
- [ ] Spot-check query: "show me all changes to scholar X by actor Y in date range Z" returns readable before/after JSON.
- [ ] Documented retention policy (recommend ≥ 7 years for faculty data; confirm with WCM compliance).

---

### B04 — `/api/revalidate` bearer auth + dual-token rotation

**Area:** `auth`, `etl` · **Refs:** ADDENDUM § `/api/revalidate`

**Scope.** `Authorization: Bearer <token>` required on every `/api/revalidate*` request. Token in `scholars/revalidate-token` Secrets Manager secret. Constant-time compare. During rotation, handler accepts both current and previous token for a configurable window so Lambda cold-start cache doesn't cause an outage.

**Acceptance criteria**
- [ ] Request without bearer returns 401.
- [ ] Request with wrong bearer returns 401, constant-time compared.
- [ ] Handler reads expected tokens at cold start; both `current` and `previous` are accepted.
- [ ] Documented rotation procedure: update secret → publish new Lambda version (forces cold start) → after 24h, drop `previous` from secret.
- [ ] Quarterly rotation calendar entry created.

---

### B05 — `/api/revalidate` internal-only ALB listener + SG-to-SG ingress

**Area:** `auth`, `edge` · **Refs:** ADDENDUM § `/api/revalidate`

**Scope.** Public CloudFront and the public ALB listener never serve `/api/revalidate*`. A separate internal ALB listener (or a dedicated internal ALB) routes `/api/revalidate*` to the same ECS service. ETL Lambdas have a dedicated security group; the internal listener's security group allows ingress only from the ETL SG by SG ID.

**Acceptance criteria**
- [ ] Public CloudFront request to `/api/revalidate` returns 404 or routes to the public ALB which returns 404.
- [ ] ETL Lambda invoking the internal listener succeeds.
- [ ] Curl from a non-ETL EC2 / Lambda in the same VPC fails (SG denies).
- [ ] No NAT-egress IP allowlist used.
- [ ] No API Gateway, no PrivateLink.

**Depends on:** B04 (defense-in-depth pair).

---

### B06 — Secrets Manager + ECS task-execution-role / task-role split

**Area:** `auth`, `deploy` · **Refs:** ADDENDUM § Secrets

**Scope.** All credentials in AWS Secrets Manager. ECS task definitions reference each by ARN under `secrets:`, never `environment:`. Task **execution role** has `secretsmanager:GetSecretValue` on the listed ARNs and nothing else. Task **role** (the runtime identity) has no secret access.

**Acceptance criteria**
- [ ] Secrets in place: `scholars/db/app-rw`, `scholars/db/app-ro` (or omit if launching one-client; see B16), `scholars/db/etl`, `scholars/opensearch/app`, `scholars/opensearch/etl`, `scholars/revalidate-token`, `scholars/etl/{source}` per ETL.
- [ ] Task execution role IAM policy reviewed; scoped to listed ARNs.
- [ ] Task role IAM policy reviewed; no `secretsmanager:*`.
- [ ] DB credentials use the Secrets Manager rotation Lambda for RDS.
- [ ] Quarterly rotation calendar entries for OpenSearch and revalidate token.
- [ ] No credential string appears in any committed file (`gh secret-scan` clean; `gitleaks` clean).

---

### B07 — CloudFront cache-behavior split (cookies on writer routes only)

**Area:** `edge` · **Refs:** ADDENDUM § Cookies and the cache key

**Scope.** Cacheable routes (`/`, `/scholars/*`, `/topics/*`, `/departments/*`, `/centers/*`, `/sitemap.xml`, `/search`) forward no cookies and do not include cookies in the cache key. Uncacheable routes (`/api/edit*`, `/edit/*`, `/api/revalidate*`) forward all cookies with `CachingDisabled`.

**Acceptance criteria**
- [ ] CloudFront distribution has at least two behaviors: cacheable (default) and uncacheable (writer paths).
- [ ] Cache-key inspector in CloudFront test page: cacheable URL with `Cookie: foo=1` and same URL with `Cookie: foo=2` produce the same cache key.
- [ ] Writer route forwards all cookies; verified by sending a request with a session cookie and confirming the origin sees it.
- [ ] Smoke test: edit flow works end-to-end through CloudFront.

**Depends on:** B01.

---

### B08 — Step Functions state machines for nightly / weekly / annual ETLs

**Area:** `etl` · **Refs:** ADDENDUM § ETL orchestration

**Scope.** Three state machines (Standard, not Express): `nightly` (`ed → asms → infoed → coi → search-index → completeness → revalidate`), `weekly` (`reciter → dynamodb → spotlight → search-index → revalidate`), `annual` (`hierarchy → manual approval → revalidate`). Per-step Task with 2 retries (exponential backoff) for transient errors, no retries for data errors. `Catch` blocks publish to `etl-failures` SNS topic. Top-level `Choice` state on `$.startFrom` for partial re-runs.

**Acceptance criteria**
- [ ] Three state machines deployed (IaC, not click-ops).
- [ ] Each Task invokes the existing `etl/*/index.ts` Lambda.
- [ ] `Choice` state at the top of each state machine branches on `$.startFrom`; `--input '{"startFrom": "dynamodb"}'` actually skips earlier steps.
- [ ] `Catch` blocks publish to SNS; alarm verified by deliberately failing a step in staging.
- [ ] Each ETL ends by calling `/api/revalidate` for the affected paths.
- [ ] EventBridge schedules trigger each state machine on the cadences in PRODUCTION.md.
- [ ] Operator runbook documents how to start a state machine manually and how to re-run from a step.

**Depends on:** B04, B05.

---

### B09 — Migration pipeline (one-shot ECS task + PR checklist)

**Area:** `deploy`, `data` · **Refs:** ADDENDUM § Schema migration policy

**Scope.** `prisma migrate deploy` runs as a one-shot ECS task in the deploy pipeline, using the same image as the new app version, before the ECS service rolls. Non-zero exit fails the deploy. `prisma migrate dev` and `prisma db push` are never run above a developer laptop. PR template gains the additive-migration checklist.

**Acceptance criteria**
- [ ] CI workflow runs the migration task before updating the ECS service.
- [ ] Migration failure aborts the deploy; verified by intentionally breaking a migration in staging.
- [ ] PR template updated with the five-item checklist from ADDENDUM § PR review checklist.
- [ ] `scripts/backfills/` directory created with a README explaining the convention.
- [ ] Documented "no migration rollback; fix forward" rule in CONTRIBUTING.

**Depends on:** B13 (staging).

---

### B10 — Aurora PITR retention + manual snapshot + cross-region copy

**Area:** `data`, `ops` · **Refs:** open gap (not in ADDENDUM)

**Scope.** Set Aurora PITR retention to 14 days (default 1 is too short). Daily automated snapshots retained 35 days. Manual snapshot before each weekly ETL run via Step Functions task. Cross-region snapshot copy to a second region for DR posture. Document RTO/RPO targets.

**Acceptance criteria**
- [ ] PITR retention = 14 days.
- [ ] Automated snapshot retention = 35 days.
- [ ] Pre-weekly-ETL snapshot step added to the `weekly` state machine (B08).
- [ ] Cross-region snapshot copy to a documented secondary region.
- [ ] Documented RTO/RPO numbers in PRODUCTION.md (recommend RPO ≤ 24h, RTO ≤ 4h for read-mostly site).
- [ ] Restore-drill runbook written; one drill executed against staging.

---

### B11 — ALB `/healthz` shallow health check

**Area:** `edge`, `deploy` · **Refs:** open gap (not in ADDENDUM)

**Scope.** App exposes `/healthz` returning 200 if the process is up. **Shallow** — no DB call. Deep checks (DB, OpenSearch reachability) are a separate `/readiness` endpoint not used by ALB. ALB health check uses `/healthz` with default thresholds.

**Acceptance criteria**
- [ ] `GET /healthz` returns 200 with no DB query.
- [ ] `GET /readiness` returns 200 only if DB and OpenSearch are reachable.
- [ ] ALB target group health check path = `/healthz`.
- [ ] Deliberate DB outage in staging does not cycle Fargate tasks.

---

### B12 — Deploy strategy + rollback runbook

**Area:** `deploy` · **Refs:** open gap

**Scope.** Decide rolling vs blue/green via CodeDeploy. Document the choice with rationale. Write the rollback runbook: how to identify a bad deploy (5xx > X%, p95 > Y), how to roll back (CodeDeploy `stop-deployment --auto-rollback-enabled` or ECS service update to previous task definition), and the expected blast radius.

**Acceptance criteria**
- [ ] Decision recorded as ADR.
- [ ] CI deploys via the chosen strategy.
- [ ] Runbook includes one paste-able command for emergency rollback.
- [ ] One full rollback drill executed against staging.

**Depends on:** B13.

---

### B13 — Staging environment that mirrors prod

**Area:** `deploy`, `ops` · **Refs:** open gap

**Scope.** A second environment (`scholars-staging.weill.cornell.edu` or similar) with its own CloudFront, ALB, ECS service, Aurora cluster, and OpenSearch domain. ETLs run against staging on a copy of prod data, refreshed via cross-account snapshot copy.

**Acceptance criteria**
- [ ] Separate AWS account or strictly-namespaced resources in the same account.
- [ ] DNS for staging behind WCM SSO so it isn't publicly indexable.
- [ ] Aurora staging restored from a recent prod snapshot (refresh procedure documented; recommend monthly or on-demand).
- [ ] ETLs run against staging on the same cadence as prod (or on demand).
- [ ] Documented as the target for B01/B07/B08/B09/B12 smoke tests.

---

### B14 — VIVO legacy `/vivo/*` 301 redirect map

**Area:** `edge` · **Refs:** open gap

**Scope.** Scholars replaces VIVO. If old `/vivo/...` URLs have inbound traffic (Google index, citations, faculty CVs), losing them costs PageRank and breaks links. Build a one-time inventory of indexed `/vivo/*` URLs, map each to its Scholars equivalent, and serve 301s at the edge or in middleware.

**Trigger:** confirm whether inbound `/vivo/*` traffic exists. If yes, this is P0. If no, drop to P2 or remove.

**Acceptance criteria**
- [ ] Inventory of `/vivo/*` URLs from Google Search Console (or VIVO logs).
- [ ] Mapping table from `/vivo/{path}` → `/scholars/{slug}` (or 410 Gone where no equivalent exists).
- [ ] 301 implemented in middleware or CloudFront Function.
- [ ] Validated via crawler: 100% of inventoried URLs return 301 to a non-404.

---

### B15 — `next/image` runtime cost decision

**Area:** `edge`, `ops` · **Refs:** open gap

**Scope.** `next/image` optimizes at request time using `sharp`, which is CPU-heavy. On a 1 vCPU Fargate task with `connection_limit=15`, image optimization will starve Prisma. Decide: (a) pre-resize at ETL time and serve from S3 + CloudFront, (b) `images.unoptimized: true` and let CDN serve origin images, or (c) run a separate image-optimization service.

**Acceptance criteria**
- [ ] Decision recorded as ADR.
- [ ] If (a): ETL writes resized variants to S3; `next/image` `loader` config points to a CloudFront S3 origin.
- [ ] If (b): `next.config.ts` sets `images.unoptimized: true`; document the trade-off (no responsive sizes generated).
- [ ] If (c): documented; not recommended at this scale.
- [ ] Load test in staging confirms image requests don't starve Prisma under 100 RPS.

**Depends on:** B13.

---

## P1 — launch and iterate

### B16 — Prisma reader/writer split

**Area:** `data` · **Refs:** ADDENDUM § Reader/writer split

**Scope.** Two `PrismaClient` instances: `db.read` (bound to Aurora reader endpoint) and `db.write` (writer). Route handlers and server components default to `db.read`; `/api/edit*` and migrations use `db.write`. Alternative: `@prisma/extension-read-replicas`. Skip RDS Proxy.

**Acceptance criteria**
- [ ] Single `db.ts` exports `db.read` and `db.write`.
- [ ] Audit: all writes go through `db.write`; verified by lint or grep.
- [ ] Reader endpoint receives traffic in CloudWatch.
- [ ] If launched with one-client (allowed), this issue tracks the upgrade and the unused `db/app-ro` secret is removed until the split ships.

---

### B17 — VPC endpoints for Secrets Manager / S3 / OpenSearch

**Area:** `auth`, `ops` · **Refs:** open gap

**Scope.** Add interface VPC endpoints for Secrets Manager and OpenSearch, and a gateway endpoint for S3, so Fargate and Lambdas don't need NAT egress for AWS service calls. Reduces NAT cost and removes a class of failure modes (NAT throughput, NAT outages).

**Acceptance criteria**
- [ ] Endpoints created in the app VPC.
- [ ] Route tables updated.
- [ ] Verified: NAT bytes drop materially in CloudWatch metrics after rollout.

---

### B18 — OpenSearch alias-swap pattern (`scholars_v{N}`)

**Area:** `etl`, `data` · **Refs:** ADDENDUM § search-index rebuild via alias swap

**Scope.** ETL writes to a fresh `scholars_v{timestamp}` index. On success, atomically swap the read alias `scholars` via `POST /_aliases`. Retain the previous versioned index for one cycle for rollback; delete two cycles old.

**Acceptance criteria**
- [ ] App always queries the `scholars` alias, never a versioned name.
- [ ] ETL writes to `scholars_v{N}` and only swaps on success.
- [ ] Manual rollback (alias-swap to previous version) tested in staging.
- [ ] Pre-reindex snapshot to S3 added to the nightly state machine.

**Depends on:** B08.

---

### B19 — Reciter → DynamoDB consistency-window UI placeholder

**Area:** `etl` · **Refs:** ADDENDUM § The reciter → dynamodb consistency window

**Scope.** `etl_state` table holds `last_topic_rebuild_at`. The topic strip in the profile UI renders a "topics updating" placeholder when `now - last_topic_rebuild_at < 30 min`.

**Acceptance criteria**
- [ ] `etl_state` table created; `reciter` writes `last_topic_rebuild_at` at start.
- [ ] `dynamodb` ETL clears the window on success.
- [ ] Profile UI shows the placeholder when the window is open.
- [ ] Window does not leak into other UI elements (only the topic strip).

**Depends on:** B08.

---

### B20 — `etl_run` checkpoint table + cadence/status alarms

**Area:** `etl`, `ops` · **Refs:** ADDENDUM § Alerting, idempotency, and resumability

**Scope.** Each ETL writes to `etl_run(source, started_at, finished_at, status, source_revision, rows_written, error)`. Two CloudWatch alarms: `status != 'success'` and `started_at older than expected cadence`. The second catches a state machine that failed to start at all.

**Acceptance criteria**
- [ ] Table created; every ETL writes one row per run.
- [ ] Both alarms wired to the on-call topic.
- [ ] Data dashboard panel reads from `etl_run`.

**Depends on:** B08, B23.

---

### B21 — Security headers at edge (HSTS, CSP, X-Frame-Options)

**Area:** `edge`, `auth` · **Refs:** open gap

**Scope.** Set HSTS (`max-age=31536000; includeSubDomains; preload`), CSP (start with report-only), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin. Either at CloudFront via response headers policy, or in `next.config.ts` `headers()`.

**Acceptance criteria**
- [ ] All five headers present on every response (verified via `curl -I`).
- [ ] CSP starts in `Content-Security-Policy-Report-Only` mode for at least 2 weeks before enforcement.
- [ ] `serverActions.allowedOrigins` in `next.config.ts` if server actions are used.

---

### B22 — SLOs + log retention + cost alarms

**Area:** `ops` · **Refs:** open gap

**Scope.** Three operational guardrails:
1. **SLOs.** p95 < 1500 ms, 5xx rate < 0.5%, availability > 99.5% measured monthly. Error budget = downtime allowance derived from those.
2. **CloudWatch log retention.** 30 days for app logs, 90 days for ALB/CloudFront, 1 year for audit logs (compliance).
3. **Cost alarms.** Per-service budget alarms at 50% / 80% / 100% of monthly forecast.

**Acceptance criteria**
- [ ] SLOs documented in PRODUCTION.md and surfaced on a dashboard.
- [ ] Retention policies set on every log group.
- [ ] Budget alarms wired to the on-call topic.

**Depends on:** B23.

---

### B23 — On-call routing (SNS → PagerDuty/Opsgenie)

**Area:** `ops` · **Refs:** open gap

**Scope.** Pick PagerDuty, Opsgenie, or a documented email-distribution-list with rotation. Wire CloudWatch alarms → SNS topic → on-call provider. Document escalation tiers and after-hours behavior.

**Acceptance criteria**
- [ ] Provider picked.
- [ ] One SNS topic per severity (page vs notify-only).
- [ ] Test alarm fires a real page in staging.
- [ ] Runbook entries reference the correct topics.

---

### B24 — Distributed tracing (X-Ray or OTel + Prisma instrumentation)

**Area:** `ops`, `data` · **Refs:** open gap

**Scope.** Auto-instrument the app with X-Ray or OpenTelemetry. Prisma queries appear as spans with query text (or query hash if redaction is needed). At minimum: trace from CloudFront → ALB → ECS → Aurora.

**Acceptance criteria**
- [ ] Trace shows the full request path.
- [ ] Slow `profile_view` requests are debuggable to the offending Prisma query.
- [ ] Sampling rate documented; default 5% with 100% on errors.

---

## P2 — when it bites

### B25 — Sitemap-index split

**Area:** `edge` · **Refs:** PRODUCTION.md sitemap discussion

**Scope.** At 8,919 scholar URLs, current sitemap is well under the 50,000-URL / 50 MB cap. When approaching the cap (or when adding topic / department pages would push past it), split into a sitemap-index pointing at multiple sub-sitemaps.

**Trigger:** sitemap exceeds 40k URLs or 40 MB uncompressed.

---

### B26 — WAF verified-bot allowlist

**Area:** `edge` · **Refs:** PRODUCTION.md WAF section

**Scope.** The 1000 req / 5 min WAF rate rule may rate-limit legitimate Googlebot during fresh-index crawls. AWS WAF Bot Control supports verified-bot allowlisting for major search engines. Either bypass the rate rule for verified bots, or raise the limit.

**Trigger:** legitimate Googlebot / Bingbot 429s observed in WAF logs, or Search Console reports crawl errors.

---

## Cutting issues from this doc

When ready to file the issues:

```bash
# 1. Create milestones
gh api repos/:owner/:repo/milestones -f title='Production launch' -f description='P0 blockers from PRODUCTION_BACKLOG.md'
gh api repos/:owner/:repo/milestones -f title='Post-launch hardening' -f description='P1 work scheduled within 8 weeks of launch'

# 2. Create the tracking issue from the body in this file (manual paste)
gh issue create --title 'Production readiness' --body-file <(sed -n '/^## Tracking issue body$/,/^---$/p' docs/PRODUCTION_BACKLOG.md | sed -n '/^```markdown$/,/^```$/p' | sed '1d;$d')

# 3. Cut each sub-issue. Recommended: do it in batches per area to keep
#    cross-references manageable. After each batch, update the tracking
#    issue checklist with the real GitHub issue numbers.
```

Once an issue is cut, replace its `B##` ID in this doc with the real issue link, e.g. `B01 → #123`. Once all P0 are filed, this section of the doc becomes redundant and can be archived.
