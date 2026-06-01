# Key documentation registry

**Purpose.** This is the index to reach for *after* launch, when someone — often an ITS
colleague — asks a question about how the Scholars Profile System (SPS) behaves in
production: *"Why is this page slow?"*, *"How is it deployed?"*, *"Where does this data
come from?"*, *"Is it down, or just degraded?"*, *"How do you authenticate edits?"*

This is a **curated** list, not a complete file inventory. A doc earns a row only if it
answers a question an operator or ITS colleague would actually ask once the system is
live. It deliberately does **not** index the build-time specs and drafts (`self-edit-*`,
`slug-personalization-*`, `unit-curation-*`, etc.). Those describe *what we are building*;
they are listed once, collectively, at the bottom (§9) so they don't crowd out the docs
you need when answering an operational question. Each entry below is framed as the
**question it answers**, not just its title.

Curation has a second purpose: **finding gaps.** Walking the operational questions and
checking which have a doc behind them surfaced eight questions we couldn't answer in
writing; all eight now have a doc (written 2026-05-28). The **residual** follow-ons — data
that still needs to be *collected* into those docs, not docs that need writing — are tracked
in **§10**.

> Maintenance: when you add a doc that answers a *post-launch / operational* question,
> add a one-line row here. Promotion of a draft from §9 into §1–§8 happens when the
> feature ships and the doc starts answering an operational question. When you close a
> §10 item, note it or remove it.

---

## 0. Fast triage — "Someone from ITS asks…"

| The question | Go to |
|---|---|
| Show me how this hangs together (the diagram) | [`architecture/`](./architecture/index.html) — 5 visual diagrams; or [`architecture-overview.md`](./architecture-overview.md) (prose + mermaid) |
| What is this system, end to end? | [`architecture-overview.md`](./architecture-overview.md) → [`PRODUCTION.md`](./PRODUCTION.md) → [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) |
| Why is a page slow? / What's cached where? | [`performance-baseline.md`](./performance-baseline.md), [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md), [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) |
| Is it healthy? What are the SLOs/alarms? | [`SLOs.md`](./SLOs.md), [`oncall.md`](./oncall.md) |
| How do I trace one slow request? | [`tracing.md`](./tracing.md) |
| Where are the logs / how do I search them? | [`logging-reference.md`](./logging-reference.md) |
| How is it deployed / how do I roll back? | [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), [`rollback-runbook.md`](./rollback-runbook.md), [`ADR-004`](./ADR-004-deploy-strategy.md) |
| How does login / edit auth work? | [`saml-sp.md`](./saml-sp.md), [`ADR-005`](./ADR-005-manual-override-layer.md) |
| **Who can edit what? (RBAC) / who can deploy?** | [`access-control-rbac.md`](./access-control-rbac.md) |
| Who changed this profile field, and when? | [`b03-audit-log.md`](./b03-audit-log.md) |
| If X is down, what breaks? | [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) |
| Where does the data come from / how is it refreshed? | [`dependency-outage-matrix.md`](./dependency-outage-matrix.md), [`data-population-runbook.md`](./data-population-runbook.md) |
| What does this field mean / where is it from? | [`data-dictionary.md`](./data-dictionary.md) |
| What's the VPC / network / security picture? | [`network-security-topology.md`](./network-security-topology.md) |
| What does it cost to run? | [`cost-model.md`](./cost-model.md) |
| Why does search rank things this way? | [`search.md`](./search.md), [`people-relevance-baseline.md`](./people-relevance-baseline.md) |
| Why doesn't this (retracted) paper show up? | [`retracted-publications.md`](./retracted-publications.md) |
| What is the WAF / firewall posture? | [`network-security-topology.md`](./network-security-topology.md), [`waf-request-RITM0792011.md`](./waf-request-RITM0792011.md) |
| Can we restore from backup? | [`restore-drill-runbook.md`](./restore-drill-runbook.md) |

---

## 1. Start here — system overview

| Doc | Answers |
|---|---|
| [`architecture-overview.md`](./architecture-overview.md) | **The one-page map** — request path, write path, ETL pipeline (with diagrams), the six CDK stacks, environments, and a "which doc for which concern" index. **Read this first.** |
| [`architecture/index.html`](./architecture/index.html) | **Five presentation-grade diagrams** — system context, app & AWS topology, app internals (C4 component), network topology, and the edge-topology decision (#502). Open in a browser or export to slides; `.svg`/`.png` per view sit alongside. Regenerate with `npm run diagrams` (source: [`scripts/diagrams/`](../scripts/diagrams/)). |
| [`PRODUCTION.md`](./PRODUCTION.md) | The operational counterpart to the dev README: the shape of production, why each piece exists, and how it runs. (Predates a couple of decisions — see the corrections note in `architecture-overview.md`.) |
| [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) | Closes the biggest gaps in `PRODUCTION.md`: how writer endpoints authenticate, observability wiring, and other operational specifics. |
| [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) | Every external system SPS depends on and exactly what breaks (vs stays up) if each is unavailable. |
| [`cost-model.md`](./cost-model.md) | What it costs to run, the deployed budget/anomaly guardrails, and the cost drivers. |
| [`STAGING.md`](./STAGING.md) | What staging is — a structural mirror of prod (same CDK stacks, Aurora/OpenSearch engine + version, secret layout, backups). Use it to reason about "will this behave the same in prod?" |
| [`PRODUCTION_BACKLOG.md`](./PRODUCTION_BACKLOG.md) | What's still outstanding for production-readiness — the B-series backlog. Use it to answer "is X done yet?" |
| [`proposal-fidelity.md`](./proposal-fidelity.md) | How faithful the built system is to the original proposal — useful for stakeholder/leadership questions. |

## 2. Performance, caching & rendering

| Doc | Answers |
|---|---|
| [`performance-baseline.md`](./performance-baseline.md) | The measured side of latency: per-surface baseline, alarm thresholds, and how to (re)measure. The counterpart to the SLO *targets* in `SLOs.md`. |
| [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) | The authoritative CloudFront cache-behavior spec: every behavior, cache policy, and TTL in front of `scholars.weill.cornell.edu`. **The first stop for "why is this slow / stale / not updating?"** |
| [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) | Why the runtime data-access layer mirrors the ETL transform — the core read-path design that governs page latency. |
| [`ADR-006`](./ADR-006-image-optimization-strategy.md) | Why there is **no runtime image optimizer**, and what that means for image delivery and cost. |
| [`ADR-007`](./ADR-007-csp-script-src-strategy.md) | The CSP `script-src` strategy (`unsafe-inline` + `script-src-attr 'none'`, not a nonce) and its rationale. |
| [`revalidate-token-rotation.md`](./revalidate-token-rotation.md) | How `POST /api/revalidate` busts the cache after ETL, and how to rotate its bearer token. |

## 3. Observability — is it healthy?

| Doc | Answers |
|---|---|
| [`SLOs.md`](./SLOs.md) | The SLO policy and alarm catalog — what the system holds itself to and what fires when it doesn't. |
| [`oncall.md`](./oncall.md) | The alerting path and on-call routing. Companion to `SLOs.md` and the addendum's Observability section. |
| [`tracing.md`](./tracing.md) | Distributed tracing (CloudFront → ALB → ECS). How to follow a single request through the stack. |
| [`logging-reference.md`](./logging-reference.md) | Where the logs live (log groups + retention), the structured event vocabulary, and Logs Insights recipes. |

## 4. Operations & runbooks — "how do I…?"

| Doc | Answers |
|---|---|
| [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) | How to ship a build to staging or prod; pairs with `.github/workflows/deploy.yml`. |
| [`rollback-runbook.md`](./rollback-runbook.md) | How to roll the prod ECS service back to the previous task-definition revision. |
| [`restore-drill-runbook.md`](./restore-drill-runbook.md) | How to verify the Aurora cluster can actually be restored from backup. |
| [`data-population-runbook.md`](./data-population-runbook.md) | How to bring an environment from "serves empty" to "serves real data + search index." |
| [`staging-cutover.md`](./staging-cutover.md) | The first-ever `cdk deploy` of AppStack against a fresh account, plus rolled-back recovery. |
| [`spotlight-runbook.md`](./spotlight-runbook.md) | How the home-page "Selected research" section gets its data, how to re-publish, and where to look when it breaks. |
| [`revalidate-token-rotation.md`](./revalidate-token-rotation.md) | Rotating the `/api/revalidate` webhook bearer token. |

## 5. Security, auth & compliance

| Doc | Answers |
|---|---|
| [`access-control-rbac.md`](./access-control-rbac.md) | **Who can do what** — the three authorization layers (application RBAC: self / superuser / unit Owner / Curator; AWS IAM; database roles) plus the deploy gate and break-glass procedures. |
| [`network-security-topology.md`](./network-security-topology.md) | The review-ready VPC / subnet / security-group / egress / edge picture, with diagram and threat-model summary. |
| [`saml-sp.md`](./saml-sp.md) | Operator runbook for the SAML service provider that terminates WCM SSO in front of `/api/edit*` and `/edit/*`. |
| [`466-saml-deploy-debrief.md`](./466-saml-deploy-debrief.md) | Debrief of the SAML SP wiring + staging/prod rollout — context for how the SSO integration was landed. |
| [`b03-audit-log.md`](./b03-audit-log.md) | The manual-edit audit log: schema and how every `/api/edit` write is recorded (who/what/when). The answer to "who changed this?" |
| [`ADR-005`](./ADR-005-manual-override-layer.md) | The manual-override layer — the design behind self-edit, slugs, and suppression, including authz. |
| [`ADR-007`](./ADR-007-csp-script-src-strategy.md) | Content-Security-Policy posture. |
| [`waf-request-RITM0792011.md`](./waf-request-RITM0792011.md) | The WAF / firewall request and posture (ServiceNow RITM0792011). |
| [`ses-sender-verification.md`](./ses-sender-verification.md) | Out-of-band SES sender-verification steps for the "Request a change" mailer. |

## 6. Data sources & ETL — where does the data come from?

| Doc | Answers |
|---|---|
| [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) | The full upstream inventory (ED, InfoEd, COI, ASMS, Jenzabar, ReciterDB, ReciterAI, NIH/NSF/NLM) — connector, cadence, and outage impact for each. |
| [`cdk/lib/etl-stack.ts`](../cdk/lib/etl-stack.ts) | **Source of truth for the ETL cadence** — the `nightlySteps` / `weeklySteps` / `annualSteps` arrays + EventBridge crons. The cadence prose in `dependency-outage-matrix.md`, `PRODUCTION_ADDENDUM.md § State machines`, and `architecture-overview.md` must be reconciled against this file whenever the schedule changes. |
| [`data-dictionary.md`](./data-dictionary.md) | The public data model: every table grouped by domain, with its source of record and what its fields mean. |
| [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) | The runtime/ETL relationship — the backbone of how data lands and is read. |
| [`ADR-002`](./ADR-002-division-chiefs.md) | How `Division.chiefCwid` is populated. |
| [`ADR-003`](./ADR-003-center-membership.md) | How `CenterMembership` was populated (historical record; methodology shipped under #12). |
| [`etl/jenzabar-gs-faculty-probe.md`](./etl/jenzabar-gs-faculty-probe.md) | The Jenzabar Graduate-School faculty appointments source — what the view exposes (#193). |
| [`data-population-runbook.md`](./data-population-runbook.md) | The operational procedure to load/refresh that data and the search index. |
| [`spotlight-integration-plan.md`](./spotlight-integration-plan.md) | How ReciterAI spotlight data integrates into the home page. |

## 7. Architecture Decision Records — why it's built this way

ADRs capture decisions and their rationale; reach for these when a colleague asks
*"why did you choose X over Y?"*

| ADR | Decision |
|---|---|
| [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) | Runtime data-access layer = ETL transform |
| [`ADR-002`](./ADR-002-division-chiefs.md) | Populating `Division.chiefCwid` |
| [`ADR-003`](./ADR-003-center-membership.md) | Populating `CenterMembership` (historical) |
| [`ADR-004`](./ADR-004-deploy-strategy.md) | Deploy strategy: ECS rolling |
| [`ADR-005`](./ADR-005-manual-override-layer.md) | Manual-override layer |
| [`ADR-006`](./ADR-006-image-optimization-strategy.md) | Image optimization: no runtime optimizer |
| [`ADR-007`](./ADR-007-csp-script-src-strategy.md) | CSP `script-src` strategy |
| [`ADR-008`](./ADR-008-infrastructure-as-code.md) | Infrastructure-as-Code: AWS CDK, TypeScript, in-repo, six stacks |

## 8. How key features behave (for "why does it do that?")

| Doc | Answers |
|---|---|
| [`search.md`](./search.md) | How unified `/search` ranks people, publications, and grants, and what signal backs each rank. |
| [`search-publications.md`](./search-publications.md) | Example-driven explainer for the Publications tab of `/search`. |
| [`browse-vs-search.md`](./browse-vs-search.md) | The distinct jobs of the browse pages vs search. |
| [`people-relevance-baseline.md`](./people-relevance-baseline.md) | The frozen baseline behind People-tab relevance (eval-owner signed off). |
| [`taxonomy-aware-search.md`](./taxonomy-aware-search.md) | Taxonomy/MeSH-aware relevance re-weighting (v2.2). |
| [`feedback-handling-matrix.md`](./feedback-handling-matrix.md) | How user feedback is routed (and the planned ServiceNow intake). |
| [`retracted-publications.md`](./retracted-publications.md) | Why retracted papers don't display — the two-record problem (notice vs original), ReCiter's re-fetch lag, and the nightly PubMed-retraction stamp (#604) that closes the gap via the existing `NEVER_DISPLAY_TYPES` filter. |
| [`vivo-incident-analysis.md`](./vivo-incident-analysis.md) | VIVO incident history — what the predecessor system's support load looked like. |

## 9. Build-time specs & drafts (not operational)

These describe features under construction. They are **not** the place to answer a
post-launch operational question; consult them only when working on the feature itself.
Listed here for completeness so §1–§8 stay focused.

- Self-edit: `self-edit-spec.md`, `self-edit-ui-spec.md`, `self-edit-launch-spec.md`,
  `self-edit-request-change-modal.md`, `self-edit-request-change-server-mailer-plan.md`,
  `feedback-badge-spec.md`
- Slug personalization: `slug-personalization-spec.md`, `slug-personalization-ui-spec.md`
- Unit curation: `unit-curation-spec.md`, `unit-curation-edit-ui-spec.md`,
  `center-management-spec.md`
- Outreach (launch-window, #506 D5): `outreach/_skeleton.md` (shared 5-part template) + per-audience
  drafts `outreach/wave1-center-admins.md`, `outreach/wave1-superusers-library.md`,
  `outreach/wave1-pilot-dept-admins.md`, `outreach/wave2-scholars.md`,
  `outreach/wave3-doctoral-students.md`, `outreach/wave4-public-launch.md`
- ServiceNow KB (launch support, #506 D3): `kb/01-scholars.md`, `kb/03-superusers.md`,
  `kb/04-itsops.md` drafted; `kb/02-dept-admins.md` deferred (gated on #540); index in `kb/README.md`.
  Routing destinations are owned by `feedback-handling-matrix.md` (§8), not restated in the articles.
- Snapshots/fixtures: `spec-snapshots/`

---

## 10. Residual follow-ons

The eight documentation gaps identified in the first pass were all written on 2026-05-28
(architecture overview, dependency/outage matrix, performance baseline, data dictionary,
logging reference, network/security topology, cost model, access-control/RBAC). What remains
is **data to collect**, not docs to write — each item below is an open `TODO`/`TBD` *inside*
an existing doc, mostly blocked on post-launch traffic or an external team.

| Residual item | Lives in | Blocked on / trigger |
|---|---|---|
| Per-surface latency p50/p95/p99 + load-test numbers (cells marked `TBD (measure)`) | [`performance-baseline.md`](./performance-baseline.md) | Post-launch traffic or a 1000-scholar synthetic crawl; the 30-day-post-EdgeStack SLO review. |
| **App-tier autoscaling thresholds are placeholders** — `AppStack` now ships a target-tracking policy (#596: avg CPU 60% + ALB request-count-per-target, min `appDesiredCount` / max `appMaxCount` = prod 2/6, staging 1/3), and the `PRODUCTION.md` + `performance-baseline.md` claims are reconciled to match. The max and the target values are conservative placeholders. | [`PRODUCTION.md`](./PRODUCTION.md), [`performance-baseline.md`](./performance-baseline.md), [`config.ts`](../cdk/lib/config.ts) | #554 load-test numbers (P0, Gate A) — tune the ceiling + thresholds once real RPS / CPU-per-task figures exist. |
| Post-Edge/Etl cost baseline (current `$425/mo` predates CloudFront + ETL) and per-service `est.` → actuals from Cost Explorer | [`cost-model.md`](./cost-model.md) | EdgeStack + EtlStack active in prod; re-audit at the budget-review trigger. |
| Production WAF topology (AWS-native WebACL vs on-prem NetScaler) | [`network-security-topology.md`](./network-security-topology.md), [`waf-request-RITM0792011.md`](./waf-request-RITM0792011.md) | ITSOPS decision on RITM0792011 (#502). |
| WCM-internal ETL routing (TGW attachment + WCM firewall for the VPC CIDR) | [`network-security-topology.md`](./network-security-topology.md), [`data-population-runbook.md`](./data-population-runbook.md) | Central Services / WCM network team (not SPS-owned). |
| Access recertification cadence (review who holds `unit_admin` / superuser-group membership) and standing emergency-access posture | [`access-control-rbac.md`](./access-control-rbac.md) | A governance decision — candidate follow-on. |
| Browser/client RUM tracing; ETL task tracing (X-Ray) | [`logging-reference.md`](./logging-reference.md), [`tracing.md`](./tracing.md) | Out of B24 scope; future workstreams. |

> Scope note: these are operational-audience items. Build-time / feature-design
> documentation is intentionally out of scope (see §9). When you fill one of these in, edit
> the host doc and strike the row here.

---

## 11. Open questions

Distinct from §10 (which is *data to collect*), these are **decisions and confirmations
that need a human/stakeholder answer** before the corresponding doc can state a definitive
position. Each is a real "we can't answer this yet because nobody has decided" — surfaced
while writing the §1–§8 docs. Tracked in **[issue #560](https://github.com/wcmc-its/Scholars-Profile-System/issues/560)**.

| # | Open question | Why it matters / what it blocks | Likely owner |
|---|---|---|---|
| 1 | **End-user latency SLO** — the current `p99 < 1.5 s` is the *origin* tail. What is the target for CloudFront-*edge*-perceived latency? | Finalizes [`performance-baseline.md`](./performance-baseline.md) + the [`SLOs.md`](./SLOs.md) latency target. | SLO review (post-EdgeStack traffic) |
| 2 | **Production WAF topology** — AWS-native WAFv2 WebACL, or fronted/replaced by an on-prem NetScaler? Does CloudFront stay in the path? | Finalizes [`network-security-topology.md`](./network-security-topology.md); **gates launch**. Until resolved, don't lift the WCM-only access gate. | ITSOPS / security (RITM0792011, #502) |
| 3 | **Revised monthly cost budget** — `$600/mo` predates EdgeStack + EtlStack. What should `sps-monthly-budget` be at launch? | Sets the guardrail in [`cost-model.md`](./cost-model.md). | Operator / budget owner |
| 4 | **Reader/writer split at launch** — set `DATABASE_URL_RO` to activate the Aurora reader endpoint, or launch writer-only and split as a P1? | Affects DB capacity headroom + the read path in [`architecture-overview.md`](./architecture-overview.md). | Operator |
| 5 | **DR posture sign-off** — is PITR-only (restore Variant A) acceptable for go-live, or must the us-west-2 DR restore (Variant B) be exercised first? | Confirms the RTO/RPO claim in [`PRODUCTION.md`](./PRODUCTION.md) is signed off, not just asserted. | Operator + business owner |
| 6 | **Access recertification cadence** — who reviews superuser-group + `unit_admin` grant membership, and how often? Is a recert required for launch? | Closes the governance gap noted in [`access-control-rbac.md`](./access-control-rbac.md). | Faculty Affairs + ITS |
| 7 | **Break-glass policy** — is directory-dependent emergency superuser elevation acceptable, or is a standing break-glass account required? | Confirms the emergency-access posture in [`access-control-rbac.md`](./access-control-rbac.md). | Security |
| 8 | **ETL→WCM connectivity** — when will Central Services provision the TGW attachment + WCM firewall opening for the SPS VPC CIDR? | **Gates first prod data population** ([`data-population-runbook.md`](./data-population-runbook.md), [`network-security-topology.md`](./network-security-topology.md)). | Central Services / WCM network |
| 9 | **SAML CWID delivery + cert rollover** — confirm CWID is delivered as a SAML attribute vs NameID; confirm `SAML_IDP_CERT` handles the 2016→2036 IdP cert rollover before the **2026-08-19** expiry. | Auth correctness + a dated operational deadline ([`saml-sp.md`](./saml-sp.md)). | SAML / IdP contact |
| 10 | **Post-launch operations ownership** — who is the named operator / on-call after launch (today: `paa2013@med.cornell.edu` / `paulalbert1`)? Is there a team handoff? | Determines who [`oncall.md`](./oncall.md) and the alarm fan-out actually page. | ITS management |

---

*Last updated: 2026-06-01 — added [`retracted-publications.md`](./retracted-publications.md)
(§0 triage + §8): why retracted papers don't display and why the nightly PubMed-retraction
step (#604, PR #625) is required to close the ReCiter re-fetch gap. 2026-05-29 — §10 app-tier autoscaling resolved: `AppStack` now ships a
target-tracking policy (#596) and the docs are reconciled; the row is narrowed to
threshold-tuning pending #554. Earlier 2026-05-29 — §10 added the app-tier autoscaling doc/infra mismatch (#596);
added §9 launch-window outreach drafts (Waves 1–4 + skeleton, #506 D5) and the ServiceNow KB
article drafts (#506 D3); fixed the footer "Help & support" link to point at `/about` (the public
help surface). 2026-05-28 — eight operational gap docs added; §10 tracks residual data-collection
follow-ons; §11 tracks open questions (see issue #560).*
