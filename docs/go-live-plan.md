# Scholars Profile System: Go-Live Plan

**Audience:** CIO / IT leadership
**Purpose:** One-page summary of how we move to production. Operational detail lives in the
referenced runbooks; this document is for the go/no-go decision.
**Status:** DRAFT for review · **Owner:** Paul · **Target window:** [TBD]



## Status tracker · _updated 2026-06-15_

**Current phase:** 0 — Readiness (pre-launch) · **Overall:** on track, not yet "go"
**Sign-offs recorded:** 0 / 12 (detail in §5) · **Target launch window:** [TBD]

| Date | Key event / milestone | Status |
|------|-----------------------|--------|
| Jun 15, 2026 | Go-live plan drafted for review | Draft complete |
| Jul 9, 2026 | Research leadership presentation (invited) | Scheduled |
| [TBD] | General Faculty Council — "coming soon" teaser (CIO) | Planned |
| [TBD] | Readiness sign-off / go-no-go review | Pending |
| [TBD] | Soft launch (internal / on-network) | Pending |
| [TBD] | Public GA | Pending |
| [TBD] | Stabilize / decommission legacy | Pending |

**Open / blocking items**
- Target launch window not set — all milestone dates after Jul 9 are [TBD].
- All §5 sign-offs outstanding (0 / 12); some owners still TBD.
- No adoption/business dashboard — only operational reliability (§8); decide build-before-GA vs defer.
- DR plan artifact (owner: Mark R.) to be located and linked (§7).
- Readiness ledger (§4a) now tracks built-vs-owed per category; launch-blocking *owed* items: load test (#554), penetration test, region-DR drill, ETL-enable + #443, named on-call owner.

## 1. What we are launching

The Scholars Profile System (SPS) — the public faculty profile and search platform — moves from
its current state (fully live on staging, soaking) to general availability in production. The
platform is built and operating; go-live is a controlled cut-over and ramp, not new development.

## 2. Guiding principle: low-risk, reversible ramp

We do not flip a switch. Every capability ships behind a feature flag, is exercised on staging
first, then is enabled in production incrementally. Any step is reversible in minutes without a
code deploy. This is the core of the plan and the main message for review.

## 3. Phased approach

| Phase | What happens | Exit gate |
|-------|--------------|-----------|
| **0 — Readiness** | Final data load, backups verified, monitoring/alerting confirmed, restore drill passed | Go/no-go checklist signed |
| **1 — Soft launch** | Production enabled for internal / on-network audience; core profiles + search only | 48–72h clean; no P1/P2 |
| **2 — Public GA** | Public access opened; remaining capabilities ramped flag-by-flag | Each flag soaks before the next |
| **3 — Stabilize** | Legacy redirects, decommission of prior system, hand to steady-state ops | Adoption + error budgets healthy |

## 4. Go / no-go gates (decision criteria)

- **Data:** production data loaded and spot-verified; nightly ETL green.
- **Resilience:** backups current, restore drill passed, rollback rehearsed, disaster-recovery plan in place (RTO/RPO defined).
- **Observability:** dashboards live; P1/P2 alerting routed to on-call (Teams).
- **Security/Access:** access controls, authentication, and data-visibility rules verified.
- **Sign-offs:** every party in §5 records a go; the executive sponsor holds the final decision.

## 4a. Readiness ledger — built vs. owed

The §4 gates are *criteria*; this ledger is the *evidence* behind them. The recurring shape
across the platform: the **capability is built**, and what remains is the **validation, owner,
or policy that proves it**. **Built ✅** = deployed and in the architecture today. **Owed ⬜** =
the test, sign-off, or policy still required before that gate is truly green; ticket refs in
parentheses, and most *owed* items map to a §5 sign-off owner.

### 4a.1 · Performance & load
- **Built ✅** CloudFront CDN (24 h scholar-HTML cache, static → 1 y); ECS autoscale (CPU 60% / 1000 req-target, prod 2–6); Aurora v2 1–8 ACU + reader; p99 < 1.5 s SLO + alarm; X-Ray + New Relic APM.
- **Owed ⬜** **Load + spike test (#554)** — autoscale thresholds are placeholders until then; validate p99 at projected GA traffic.

### 4a.2 · Resilience / DR
- **Built ✅** Multi-AZ (Aurora writer+reader, ≥2 tasks across 2 AZs); ECS circuit-breaker auto-rollback; AWS Backup daily + us-west-2 copy; Aurora PITR (35 d prod); backup/restore drill done; task-def rollback + kill switch.
- **Owed ⬜** **Timed region-loss DR drill** (no auto-failover; full procedure TBD; DR plan doc to be located) proving RTO ≤ 4 h / RPO ≤ 24 h; one observed rollback rehearsal → `restore-drill-runbook.md`.

### 4a.3 · Business continuity / graceful degradation
- **Built ✅** `dependency-outage-matrix.md`; "stale-not-down" design (serves last-good snapshot); ETL freshness heartbeat surfaces staleness.
- **Owed ⬜** Drill an upstream-outage per source to prove degraded-mode across all 9 feeds; user-facing staleness-messaging policy.

### 4a.4 · Security
- **Built ✅** WAF (rate-limit + AWS Managed Rules + WCM-only CIDR); SAML fail-closed; LDAPS authz re-checked every request; 3-layer RBAC; least-priv IAM; Secrets Manager + DB auto-rotation; edit-authz-denied alarm.
- **Owed ⬜** **Penetration test** + dependency/CVE scan; InfoSec sign-off (Sumanth); accept the single-account staging/prod deviation; **SAML cert rollover before 2026-08-19**.

### 4a.5 · Privacy / FERPA / data governance
- **Built ✅** Visibility gates default-closed; FERPA carve (doctoral-student + directory-release gating); per-field suppression / override; COI + email controls; self-service hide.
- **Owed ⬜** FERPA sign-off (Doug); field-level **data classification**; privacy / DPIA-style review; documented takedown / subject-rights SLA; confirm no restricted data via any feed.

### 4a.6 · Code, build & deploy
- **Built ✅** CI on `master`; gated prod deploy (GitHub Env + OIDC + required reviewer); fail-closed deploy gates (bootstrap → verify-grants → migrate); additive-only migrations; zero-downtime rolling deploy.
- **Owed ⬜** Pre-launch **code / security audit** (esp. `/edit` authz + AI-generation paths); resolve single prod-approver bus factor.

### 4a.7 · Operations & observability
- **Built ✅** Reliability dashboard per env; 9 alarms + SLOs; tiered alerting → Teams + email; ETL freshness signals; documented paging-path self-test; `OPERATIONS-RUNBOOK.md` + deep runbooks.
- **Owed ⬜** **Named post-launch owner + on-call rotation** (today: 1 person); ServiceNow CI / assignment group / OLA; off-hours paging (no SMS / ack); ops-team onboarding + live incident dry-run; fix Teams-workflow single-owner fragility.

### 4a.8 · Support model & ITSM (Tier-1)
- **Built ✅** Self-service editor + named correction loop; comms plan includes a service-desk FAQ + steward enablement.
- **Owed ⬜** Service-desk onboarding + FAQ + ticket routing; run steward enablement sessions; defined correction-response SLA.

### 4a.9 · Data & content quality
- **Built ✅** Step Functions ETL (nightly / weekly / annual) + heartbeat + idempotent jobs; launch data-QA runbook (#576); retraction read-filter.
- **Owed ⬜** Enable prod ETL schedules (disabled until launch) + **#443** network blocker; measure disambiguation accuracy; enable retraction ETL; Gate B (#506) sign-off.

### 4a.10 · AI governance / responsible AI
- **Built ✅** Faithfulness / grounding pass on overviews + biosketches; prompt versioning + CDK rollback lever; per-run generation audit; audience / tone controls; bibliometrics walled off from public overview; verifier gates.
- **Owed ⬜** **Human-approval gate before AI text is public**; written model-governance policy (provider retention / ZDR, version pinning, change control); accuracy / hallucination measurement at scale; AI-assist disclosure + opt-out.

### 4a.11 · Accessibility (508 / WCAG)
- **Built ✅** Partial (SR live-regions, accessible nav components).
- **Owed ⬜** Formal **508 / WCAG 2.1-AA audit** (public + `/edit`) + remediation tracking + VPAT; promote out of "optional" in §5.

### 4a.12 · Cost / FinOps
- **Built ✅** `cost-model.md` baseline (~$425/mo Phase 0+1); $600/mo budget + $50/day anomaly monitor (prod); right-sized autoscale; VPC endpoints + CDN cut NAT / origin cost.
- **Owed ⬜** Post-Edge/Etl **GA run-rate re-audit** (baseline predates both); Bedrock per-generation cost model + ceiling; cost-at-spike / abuse; post-launch bill ownership.

### 4a.13 · Discoverability / SEO & legacy cutover
- **Built ✅** Sitemaps; CDN; legacy-VIVO 301 redirects; `vivo-cutover-redirect-runbook.md`.
- **Owed ⬜** Redirect / SEO QA (inbound links, canonicals, indexing plan); legacy decommission plan (dependents, parallel-run window); post-GA re-index confirmation.

### 4a.14 · Third-party / vendor & supply-chain
- **Built ✅** AWS-native (no core SaaS vendor); secrets-by-ARN; cross-team reachability documented.
- **Owed ⬜** Acknowledge AWS / Bedrock lock-in; OLAs + contacts for cross-team upstreams (TGW / firewall = Central Services account); npm supply-chain scan; address New Relic + Power-Automate single points.

### 4a.15 · Adoption / business value
- **Built ✅** Glue + Athena `daily_usage` CDN-log rollup (raw traffic).
- **Owed ⬜** Define adoption KPIs (profile completeness, edit adoption, search usage, corrections, external traffic) + a 30/90-day value review (no adoption dashboard yet).

**Reading it for the go/no-go:** the *Built* column is the case that this is a well-engineered,
largely-complete platform. The *Owed* column is the actual punch-list — and it is dominated by
**validations, owners, and policies**, not missing features. The launch-blocking subset:
load test (#554), penetration test, region-DR drill, ETL-enable + #443, and a named on-call owner.

## 5. Sign-offs & approvals

Go-live requires a recorded **go** from each party below. Each owns one slice of the gate in §4;
no single team certifies the whole launch. The **executive sponsor** makes the final go/no-go call
once all are in.

| Party | Owner (name) | Attests that | Sign-off |
|-------|--------------|--------------|----------|
| **Executive sponsor** (CIO / IT leadership) | Vinay | Final go/no-go; all approvals are in | ☐ |
| **Office of Research Dean** | Florencia | Academic/business owner; content and scope fit for public release | ☐ |
| **Faculty Affairs** | Suzy | Appointment/title data accurate; faculty notification & review process meets faculty-relations expectations | ☐ |
| **Faculty Development** | Dr. McGinty | Faculty engagement and adoption supported; mentoring-related content appropriate | ☐ |
| **Engineering lead** | Mohammad & Chris | Build, deploy, rollback, and flags are ready and rehearsed | ☐ |
| **Data / ETL owner** | ? | Production data is loaded, accurate, and ETL is green | ☐ |
| **Information Security** | Sumanth | Access control, authentication, and infra hardening verified | ☐ |
| **FERPA Compliance ** | Doug | Data-visibility rules correct, incl. FERPA / directory-release gating | ☐ |
| **Institutional Communications** | Dan | Public messaging, announcements, and steward review | ☐ |
| **Data and Analytics** | Alex / Luz | Branding / visual identity approved | ☐ |
| **Operations / On-call** | Lidiya / Richard | Monitoring, alerting, and support coverage in place for the window | ☐ |
| **Disaster Recovery / Business Continuity** | Mark R. | DR plan in place — RTO/RPO defined, backups replicated, recovery tested | ☐ |

*Optional / as applicable:* Accessibility (WCAG/508 review for public pages) and Legal,
depending on org structure.

## 6. Key risks & mitigations (summary)

| Risk | Mitigation |
|------|------------|
| Upstream dependency outage (directory / publication feeds) | Documented outage matrix; system degrades gracefully, not down |
| Incorrect or sensitive data surfaced | Visibility gates default-closed; staged reveal; steward review |
| Traffic / performance at public open | CDN-fronted, cached; soak at internal scale first |
| A capability misbehaves in production | Per-feature flag — disable instantly, no deploy |

## 7. Rollback & recovery

- **Feature level:** turn the flag off — seconds, no deploy.
- **Release level:** redeploy prior known-good image (blue/green).
- **Data level:** restore from verified backup (drill completed).
- **Disaster recovery:** documented DR plan for region-loss / data-loss scenarios — defined RTO/RPO, replicated backups, periodic recovery test. Owner: **Mark R.**
- Full procedures: `rollback-runbook.md`, `restore-drill-runbook.md`.

## 8. Monitoring & support

- **Reliability dashboard** (`sps-reliability-<env>`, one per environment) — golden signals across the full serving path: CloudFront (error rate, requests, origin latency), ALB (p50/p90/p99 latency, request + 5xx/4xx volume), ECS (CPU/memory, running vs desired tasks), Aurora (CPU, connections, query latency).
- **SLO-backed alarms** (availability, p99 latency, OpenSearch/search health, edit-surface authz, cost anomaly) — tiered alerting (P1 = page, P2 = warn) routed to on-call via Teams; targets in `docs/SLOs.md`.
- **ETL signals** (run status, cadence, data-freshness heartbeat) relay to Teams; see `docs/etl-monitoring.md`.
- Defined on-call rotation and escalation path for the launch window and the week after.
- Daily health review during Phases 1–2.

## 9. Communications strategy

**Owner:** Institutional Communications (Dan), partnering with the Office of Research (Florencia),
Faculty Affairs, and Faculty Development for faculty-facing messaging and reach, and Data and
Analytics for branding / visual assets.

**Objectives:** (1) no faculty member is surprised — everyone is notified and given a review and
correction window *before* their profile is public; (2) position the platform as an institutional
asset; (3) make the support and correction path obvious from day one.

**Audiences · message type · message** — format is **email** unless noted below.

| Audience | Message type | Message | Lead |
|----------|--------------|---------|------|
| Senior leadership / governance | Briefing | Status, go decision, value | Exec sponsor (Vinay) / Office of Research |
| Research leadership | **Presentation — July 9 (invited)** | Go-live plan, value, timeline, what's coming | Office of Research (Florencia) |
| General Faculty Council | Presentation — "coming soon" teaser | What it is, faculty benefit, you'll preview before public | Exec sponsor (Vinay) |
| Faculty (profile subjects) | Email | "Your profile is going public — review, edit, or request changes by [date]" | Faculty Affairs + Office of Research + Institutional Comms |
| Dept / division administrators, chairs & comms stewards | Email + enablement session | How to help faculty review/correct profiles; steward tools; timeline; cascade to their faculty | Faculty Affairs + Institutional Comms |
| ITS liaisons | Teams (liaison network) | Readiness, local support routing, how to escalate dept issues | Operations + ITS |
| IT / service desk | Briefing + FAQ | Readiness, FAQ, escalation path | Operations |
| Public / external | Web announcement / news | The resource exists and is discoverable | Institutional Comms |

**Distribution model:** central messaging cascades through **ITS liaisons** and **department /
division administrators**, who are briefed one step ahead so they can support and reach their own
faculty. They are the local relay, not approvers — sign-off stays with the parties in §5.

**Sequencing (mapped to the phases in §3):**
- **Pre-launch (Phase 0):** leadership briefing; brief ITS liaisons and dept/division administrators *first* so they can field questions; then faculty notice opening the self-service review/correction window; steward + service-desk enablement.
- **Soft launch (Phase 1):** confirm "live internally" to stewards/admins; harvest early corrections before public open.
- **Public GA (Phase 2):** external announcement; legacy-site redirect banner; brand assets cleared by Data and Analytics.
- **Post-launch (Phase 3):** "it's live" confirmation; keep the correction/feedback path open with a defined response cadence in the first weeks.

**Feedback & correction loop:** faculty self-serve edits in the profile editor; anything unresolved
routes to comms stewards / Office of Research. This path is named in *every* faculty-facing message
so corrections always have a home.

## 10. Timeline (to be confirmed)

- Research leadership presentation (invited): **July 9**
- General Faculty Council "coming soon" teaser (CIO): **[TBD]**
- Readiness sign-off: **[TBD]**
- Soft launch (internal): **[TBD]**
- Public GA: **[TBD]**
- Stabilize / decommission legacy: **[TBD]**

## 11. Decision requested

Approval to proceed to **Phase 0 readiness sign-off** and to hold the go/no-go review at the
target window above.



### Backing detail (not required for this review)

`DEPLOY-RUNBOOK.md` · `OPERATIONS-RUNBOOK.md` · `rollback-runbook.md` ·
`restore-drill-runbook.md` · `dependency-outage-matrix.md` · `data-population-runbook.md` ·
`methods-lens-prod-golive-runbook.md` · `vivo-cutover-redirect-runbook.md` ·
`SLOs.md` · `etl-monitoring.md`
