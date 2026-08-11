# Key documentation registry

**Purpose.** This is the index to reach for *after* launch, when someone — often an ITS
colleague — asks a question about how the Scholars Profile System (SPS) behaves in
production: *"Why is this page slow?"*, *"How is it deployed?"*, *"Where does this data
come from?"*, *"Is it down, or just degraded?"*, *"How do you authenticate edits?"*

This is a **curated** list, not a complete file inventory. A doc earns a row only if it
answers a question an operator or ITS colleague would actually ask once the system is
live. It deliberately does **not** index the build-time specs and drafts (`unit-curation-*`,
`center-management-spec.md`, `feedback-badge-spec.md`, etc.). Those describe *what we are building*;
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
>
> **What belongs in this public repo:** the live system's docs (architecture, ADRs, ops,
> security, cost) and specs for **shipped** features. **Not here:** transient working notes
> (handoffs, debriefs), build-time R&D (plans, analyses, findings), and specs for
> **unshipped** features — those go to the private working area (`~/Dropbox/Projects/…`).
> Dated audits/snapshots worth keeping go under [`audits/`](./audits/) (§9a) with an
> `as-of` label — never as a current-state reference. See `CONTRIBUTING.md`.
>
> **Integration specs** ([`integrations/`](./integrations/)) are a third class, alongside the
> registry and the ADRs: one living document per upstream source system, answering *how does this
> actually work and what do I do when it breaks* — the depth a one-line registry row cannot hold,
> on the opposite contract from an ADR (always current, edited freely, no status header, no
> immutability). An ADR answers *why this rather than the obvious alternative*; expect several
> ADRs behind one source system, not fifty. Full contract in `CONTRIBUTING.md` § Integration specs.

---

## 0. Fast triage — "Someone from ITS asks…"

| The question | Go to |
|---|---|
| **How do I run / manage the app day-to-day?** (start, stop, deploy, monitor, common fixes) | [`OPERATIONS-RUNBOOK.md`](./OPERATIONS-RUNBOOK.md) — the single consolidated operator runbook; links out to the deep docs below |
| Show me how this hangs together (the diagram) | [`architecture/`](./architecture/index.html) — 5 visual diagrams; or [`architecture-overview.md`](./architecture-overview.md) (prose + mermaid) |
| What is this system, end to end? | [`architecture-overview.md`](./architecture-overview.md) → [`PRODUCTION.md`](./PRODUCTION.md) → [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) |
| Why is a page slow? / What's cached where? | [`performance-baseline.md`](./performance-baseline.md), [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md), [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) |
| Is it healthy? What are the SLOs/alarms? | [`SLOs.md`](./SLOs.md), [`oncall.md`](./oncall.md) |
| What does a user see when something breaks — an error page, a 404, degraded search? Why is a 404 cached for 60s? | [`error-handling-spec.md`](./error-handling-spec.md) |
| Did the data refresh? How would I know if an ETL broke or went stale? | [`etl-monitoring.md`](./etl-monitoring.md) |
| How do I trace one slow request? | [`tracing.md`](./tracing.md) |
| Where are the logs / how do I search them? | [`logging-reference.md`](./logging-reference.md) |
| How is it deployed / how do I roll back? | [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md), [`rollback-runbook.md`](./rollback-runbook.md), [`ADR-004`](./ADR-004-deploy-strategy.md) |
| Which feature flags are live where / what would a prod deploy actually ship? | [`flag-inventory.md`](./flag-inventory.md), [`scripts/release/whats-shipping.sh`](../scripts/release/whats-shipping.sh) |
| How does login / edit auth work? | [`saml-sp.md`](./saml-sp.md), [`ADR-005`](./ADR-005-manual-override-layer.md) |
| **Who can edit what? (RBAC) / who can deploy?** | [`access-control-rbac.md`](./access-control-rbac.md) |
| Who changed this profile field, and when? | [`b03-audit-log.md`](./b03-audit-log.md) |
| If X is down, what breaks? | [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) |
| Where does the data come from / how is it refreshed? | [`dependency-outage-matrix.md`](./dependency-outage-matrix.md), [`data-population-runbook.md`](./data-population-runbook.md) |
| Where do the **Methods & tools** come from? Is the tools taxonomy in DynamoDB? | [`scholar-tools-taxonomy.md`](./scholar-tools-taxonomy.md) (no — it's a ReciterAI S3 artifact) |
| What does this field mean / where is it from? | [`data-dictionary.md`](./data-dictionary.md) |
| What's the VPC / network / security picture? | [`network-security-topology.md`](./network-security-topology.md) — **staging cut over to the shared `its-reciter-vpc01` 2026-07-02 (#1419)** |
| What does it cost to run? | [`cost-model.md`](./cost-model.md) |
| Why does search rank things this way? | [`search.md`](./search.md) for the mechanics; **[`search-relevance-contract.md`](./search-relevance-contract.md) for the rules it must obey and the open-violation register** |
| Why is *this scholar* above *that* one on a People search? | [`search-people-relevance.md`](./search-people-relevance.md) (layer-by-layer walkthrough), then [`search-relevance-contract.md`](./search-relevance-contract.md) §Register |
| Why doesn't searching `covid19` or `tylenol` find the obvious people? | [`search-recall.md`](./search-recall.md) |
| What are the match-reason line and the KEY PAPERS/METHODS/FUNDING rows under a result? | [`search-evidence-rows.md`](./search-evidence-rows.md) |
| Why doesn't this (retracted) paper show up? | [`retracted-publications.md`](./retracted-publications.md) |
| Can a scholar hide a publication / grant / their whole profile / a **method**? What can be hidden? | [`what-can-be-hidden.md`](./what-can-be-hidden.md) (the catalog — by section and by record) |
| What is the WAF / firewall posture? | [`network-security-topology.md`](./network-security-topology.md) |
| Can we restore from backup? | [`restore-drill-runbook.md`](./restore-drill-runbook.md) (whole-cluster Aurora PITR), [`curation-backup-runbook.md`](./curation-backup-runbook.md) (curated-tables logical backup) |

---

## 1. Start here — system overview

| Doc | Answers |
|---|---|
| [`architecture-overview.md`](./architecture-overview.md) | **The one-page map** — request path, write path, ETL pipeline (with diagrams), the nine CDK stacks, environments, and a "which doc for which concern" index. **Read this first.** |
| [`architecture/index.html`](./architecture/index.html) | **Five presentation-grade diagrams** — system context, app & AWS topology, app internals (C4 component), network topology, and the edge-topology decision (#502). Open in a browser or export to slides; `.svg`/`.png` per view sit alongside. Regenerate with `npm run diagrams` (source: [`scripts/diagrams/`](../scripts/diagrams/)). |
| [`PRODUCTION.md`](./PRODUCTION.md) | The operational counterpart to the dev README: the shape of production, why each piece exists, and how it runs. (Predates a couple of decisions — see the corrections note in `architecture-overview.md`.) |
| [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) | Closes the biggest gaps in `PRODUCTION.md`: how writer endpoints authenticate and where their secrets come from, ETL orchestration/recovery, and schema-migration policy. || [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) | Every external system SPS depends on and exactly what breaks (vs stays up) if each is unavailable. |
| [`cost-model.md`](./cost-model.md) | What it costs to run, the deployed budget/anomaly guardrails, and the cost drivers. |
| [`STAGING.md`](./STAGING.md) | What staging is. **Diverged from prod since the 2026-07-02 shared-VPC cutover (#1419):** staging datastores now live in the shared `its-reciter-vpc01` while prod stays per-env pending its own cutover, so it is no longer a full structural mirror. Otherwise the same CDK stacks, Aurora/OpenSearch engine + version, secret layout, and backups. || [`proposal-fidelity.md`](./proposal-fidelity.md) | How faithful the built system is to the original proposal — useful for stakeholder/leadership questions. |

## 2. Performance, caching & rendering

| Doc | Answers |
|---|---|
| [`performance-baseline.md`](./performance-baseline.md) | The measured side of latency: per-surface baseline, alarm thresholds, and how to (re)measure. The counterpart to the SLO *targets* in `SLOs.md`. |
| [`scripts/perf/`](../scripts/perf/) | Committed load-test tooling: `sps-loadtest.sh` (concurrency C-ramp, ttfb+total percentiles) and `sps-satcheck.sh` (node-saturation isolator) for the `/search` origin path. |
| [`search-people-concurrency-performance.md`](./search-people-concurrency-performance.md) | Why broad-concept People searches saturated under concurrency, and where the ceiling is now — the per-request publications aggregation taken off the search path (`SEARCH_PEOPLE_REASON_FROM_DOC`, on in both envs), the measured staging C-ramp, the Aurora-side `matchQueryToTaxonomy` bottleneck and its cross-request cache, and why the remaining lever is OpenSearch cluster size (staging 1× `t3.medium` vs prod 2× `m6g.large`), not app code. The deep-dive behind `performance-baseline.md` and `scripts/perf/`. |
| [`cloudfront-cache-spec.md`](./cloudfront-cache-spec.md) | The authoritative CloudFront cache-behavior spec: every behavior, cache policy, and TTL in front of `scholars.weill.cornell.edu`. **The first stop for "why is this slow / stale / not updating?"** |
| [`1503-shared-cachehandler-spec.md`](./1503-shared-cachehandler-spec.md) | **Why an edit or an ETL revalidation now lands on every app task, not just the one that got the POST** — the shared S3-backed Next.js `cacheHandler`, its per-deploy key namespace, what happens when S3 is slow or the bucket is missing, and the two rollback levers. On in both envs. |
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
| [`edit-auth-200-vs-403.md`](./edit-auth-200-vs-403.md) | Why an authenticated-but-unauthorized `/edit/*` page returns **200, not 403** — and what to alarm on instead: the `edit_authz_denied` structured event and its `EditAuthzDeniedMetricFilter`, never a 4xx count. |
| [`etl-monitoring.md`](./etl-monitoring.md) | **How ETL failures and stale data reach you** (#595) — the four signals (per-step failure, status alarm, cadence alarm, freshness heartbeat), tiered across two SNS topics since PR #1438 — `etl-page-<env>` (P1 abort-tier page) and `etl-failures-<env>` (P2 warn) → the on-call relay → Teams, plus the "an alert fired, now what?" SOP. The ETL/data-plane counterpart to `SLOs.md`/`oncall.md`. |

## 4. Operations & runbooks — "how do I…?"

| Doc | Answers |
|---|---|
| [`OPERATIONS-RUNBOOK.md`](./OPERATIONS-RUNBOOK.md) | **The consolidated operator entry point** — services used, start/stop/deploy/rollback, what to monitor, a Symptom→Cause→Fix troubleshooting table, and host/contacts/access, all in one place. Pulls the essentials from the docs below and links out for detail. Start here, then drill down. |
| [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) | How to ship a build to staging or prod; pairs with `.github/workflows/deploy.yml`. |
| [`flag-inventory.md`](./flag-inventory.md) | The living feature-flag inventory + pre-prod-deploy discipline — which flags are on in which env, their owner/exit-criterion, and the mandatory `scripts/release/whats-shipping.sh` + `cdk diff` check before any prod deploy. |
| [`rollback-runbook.md`](./rollback-runbook.md) | How to roll the prod ECS service back to the previous task-definition revision. |
| [`restore-drill-runbook.md`](./restore-drill-runbook.md) | How to verify the Aurora cluster can actually be restored from backup. |
| [`curation-backup-runbook.md`](./curation-backup-runbook.md) | The daily logical backup of the human-curated tables — the one dataset SPS is system-of-record for — and how to restore them (distinct from the whole-cluster Aurora PITR in `restore-drill-runbook.md`). |
| [`data-population-runbook.md`](./data-population-runbook.md) | How to bring an environment from "serves empty" to "serves real data + search index." || [`spotlight-runbook.md`](./spotlight-runbook.md) | How the home-page "Selected research" section gets its data, how to re-publish, and where to look when it breaks. |
| [`qa/launch-data-qa.md`](./qa/launch-data-qa.md) | **Is the content actually presentable before an environment is flipped public?** (#576) — the repeatable, sample-based content smoke pass over a populated corpus: per-profile render correctness, suppression round-trips, retraction exclusion, doctoral-student hiding, Impact globality, search quality and spotlight attribution, plus the flag state to record and the queries that actually measure the residual. |
| [`scholar-proxy-runbook.md`](./scholar-proxy-runbook.md) | How to validate — and audit — who can edit a given scholar's profile: the deployed smoke test for both editor axes (the #779 designee grant and the ADR-005 Amendment 4 org-unit-administrator path), the standing SQL (active grants, proxy fan-out, grant/revoke trail), and which DB credential each query needs. |
| [`revalidate-token-rotation.md`](./revalidate-token-rotation.md) | Rotating the `/api/revalidate` webhook bearer token. |

## 5. Security, auth & compliance

| Doc | Answers |
|---|---|
| [`access-control-rbac.md`](./access-control-rbac.md) | **Who can do what** — the three authorization layers (application RBAC: self / superuser / unit Owner / Curator; AWS IAM; database roles — see [`ADR-009`](./ADR-009-database-role-separation.md) for the `app_rw` DML / `sps_migrate` DDL split) plus the deploy gate and break-glass procedures. |
| [`impersonation-spec.md`](./impersonation-spec.md) | Who can "View as" another user, what they may do while impersonating, and how it is attributed — the effective-identity seam, the down-only escalation guard, the non-dismissible banner, and the `impersonated_cwid` audit column. |
| [`scholar-proxy-spec.md`](./scholar-proxy-spec.md) | How a scholar delegates profile editing to someone else, and exactly what that delegate can do — ADR-005 Amendment 3: the `ScholarProxy` grant/revoke endpoint, the realCwid-keyed predicates (never the impersonated CWID), the positive allowlist (overview + own-publication hide only), and the threat model. |
| [`scholar-proxy-unit-admin-amendment.md`](./scholar-proxy-unit-admin-amendment.md) | Why a department / division / center administrator can edit a member's bio without anyone granting them anything — the rationale behind ADR-005 Amendment 4: the role-derived member-of relation (`deptCode` / `divCode` / `DivisionMembership`, owner→division cascade), the deliberately accepted roster-self-add escalation, and the `UNIT_ADMIN_CENTER_PROXY` center extension. |
| [`ed-admin-org-unit-roles-spec.md`](./ed-admin-org-unit-roles-spec.md) | Where the ED-sourced unit-curator grants on `/edit/administrators` come from and why they are read-only (`ed_locked`) — the nightly `EdAdmins` LDAP importer, the four option-tagged ED populations, the N-code join, and the skip-and-log rule for unmapped units. (Part 3 — superuser-only org-unit creation — is still dark: `SELF_EDIT_ORG_UNIT_CREATE_SUPERUSER_ONLY` off in both envs.) |
| [`comms-steward-profile-editing-spec.md`](./comms-steward-profile-editing-spec.md) | What a comms steward may edit on someone else's profile and what the route denies — superuser parity minus slug, admin grants and unit create/delete; curator parity on existing org units; and the ED-name bridge that puts a name, not a CWID, in the "View as" banner. |
| [`comms-steward-methods-visibility-spec.md`](./comms-steward-methods-visibility-spec.md) | What the `comms_steward` role is and how External Affairs moves a method family between the three visibility tiers (Public / Suppressed / Sensitive) at `/edit/methods`, plus the deterministic animal-model review queue. Sensitive = hidden from the public but visible to the scholar/admin — `METHODS_LENS_SENSITIVE_GATE` has been on in **both** envs since 2026-07-05. |
| [`role-aware-navigation-entry-points-spec.md`](./role-aware-navigation-entry-points-spec.md) | Why a privileged non-superuser (comms steward, unit Owner/Curator) could see no way into the `/edit` console, and what each role now gets in the account menu — the server-built `consoleLinks` on `/api/auth/session`, the role × dropdown matrix, and the view-as / `/edit`-landing behavior for a profile-less steward. |
| [`network-security-topology.md`](./network-security-topology.md) | The review-ready VPC / subnet / security-group / egress / edge picture, with diagram and threat-model summary. |
| [`saml-sp.md`](./saml-sp.md) | Operator runbook for the SAML service provider that terminates WCM SSO in front of `/api/edit*` and `/edit/*`. || [`b03-audit-log.md`](./b03-audit-log.md) | The manual-edit audit log: schema and how every `/api/edit` write is recorded (who/what/when). The answer to "who changed this?" |
| [`ADR-005`](./ADR-005-manual-override-layer.md) | The manual-override layer — the design behind self-edit, slugs, and suppression, including authz. |
| [`ADR-007`](./ADR-007-csp-script-src-strategy.md) | Content-Security-Policy posture. || [`ses-sender-verification.md`](./ses-sender-verification.md) | Out-of-band SES sender-verification steps for the "Request a change" mailer. |
| [`student-profile-visibility.md`](./student-profile-visibility.md) | **Why doctoral students have no public profile, and why no flag turns them on** — the #536 FERPA carve: no profile page, no people-index or autocomplete presence, enforced by hardcoded query filters (`publicRoleWhere()` plus a fail-closed `isPubliclyDisplayed` on the raw `role_category`), not a toggle. Carries the #2202 correction that staging and prod hide students by *different* mechanisms, so a staging pass proves nothing. |
| [`email-visibility-spec.md`](./email-visibility-spec.md) | **Can a scholar's email be shown to the public, and what decides it** — the Web Directory `weillCornellEduReleaseCode;mail` release code imported to `Scholar.emailVisibility`, the fail-closed display gate, and the export row-filter + ≤50 cohort cap. Still **prod-dark** (`PROFILE_EMAIL_RELEASE_GATE` staging-on / prod-off) pending the prod backfill — until then prod fails open and shows every email. |
| [`faculty-review-grants-api.md`](./faculty-review-grants-api.md) | How the WCM Faculty Review Tool reads one scholar's complete grant history out of SPS — the internal-ALB-only bearer endpoint `GET /api/faculty-review/{cwid}/grants`, its response contract (including why `Co-PI` means MPI), and how its token rotates. |
| [`grants-bulk-export.md`](./grants-bulk-export.md) | How the Research Informatics cross-account consumer reads **every** scholar's grant history out of SPS — the nightly `grants.ndjson` S3 export (replacing a rejected live bulk API), the NDJSON schema, the cross-account read grant, and staging-first rollout status. |

## 6. Data sources & ETL — where does the data come from?

| Doc | Answers |
|---|---|
| [`dependency-outage-matrix.md`](./dependency-outage-matrix.md) | The full upstream inventory (ED, InfoEd, COI, ASMS, Jenzabar, ReciterDB, ReciterAI, NIH/NSF/NLM) — connector, cadence, and outage impact for each. |
| [`integrations/grants.md`](./integrations/grants.md) | **How the grants feed actually works, and what to do when it breaks at 4pm on a Friday** — the InfoEd (WRG) integration spec end to end: ownership and escalation, transport/auth/schedule/credentials, the field mapping and the three role renames, `employer_id`→CWID and account→`externalId` identity resolution (and the two `externalId` formats, only one of which parses), the admission/date rules with the *why* for each, NIH RePORTER as the second writer to the same `Grant` table, known quirks, and the failure-mode decision tree. The decisions behind it live in [`ADR-012`](./ADR-012-infoed-grant-import-policy.md). |
| [`reporter-grants-matcher-spec.md`](./reporter-grants-matcher-spec.md) | Where the non-InfoEd (NIH RePORTER) grants on a profile come from, and why they are excluded from department/center rollups — `profile_id` resolution, the family+org dedup against InfoEd, the 25-year default-hide via a system `Suppression`, and the `source='RePORTER'` carve. **Shipped as v1** (#1305–#1309); the doc's own "NOT built" status header is stale. v2 is still dark — see §9. |
| [`cdk/lib/etl-stack.ts`](../cdk/lib/etl-stack.ts) | **Source of truth for the ETL cadence** — the `nightlySteps` / `weeklySteps` / `annualSteps` arrays + EventBridge crons. The cadence prose in `dependency-outage-matrix.md`, `PRODUCTION_ADDENDUM.md § State machines`, and `architecture-overview.md` must be reconciled against this file whenever the schedule changes. |
| [`data-dictionary.md`](./data-dictionary.md) | The public data model: every table grouped by domain, with its source of record and what its fields mean. |
| [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) | The runtime/ETL relationship — the backbone of how data lands and is read. |
| [`ADR-002`](./ADR-002-division-chiefs.md) | How `Division.chiefCwid` is populated. |
| [`ADR-003`](./ADR-003-center-membership.md) | How `CenterMembership` was populated (historical record; methodology shipped under #12). || [`data-population-runbook.md`](./data-population-runbook.md) | The operational procedure to load/refresh that data and the search index. || [`scholar-tools-taxonomy.md`](./scholar-tools-taxonomy.md) | Where the **Methods & tools** (method-family) taxonomy comes from — the ReciterAI A2 artifact on S3 (**not** DynamoDB; the legacy `reciterai` `TOOL#` rows are per-PMID activity, not the canonical registry), the published `tools[]`/`families[]` schema, the `etl:scholar-tool` loader + reversible `SCHOLAR_TOOL_SOURCE` (ddb→s3) switch (#794), the `scholar_tool` field mapping, and the offline consolidation-export script. |
| [`coi-pubmed-suggestion-approach.md`](./coi-pubmed-suggestion-approach.md) | Where the "From your publications" COI suggestions come from — the nightly `etl:coi-gap` source, the extract→attribute→diff→tier pipeline, and **the 2026 hardening**: why the rendered surface is **`High` tier only** (#909; Medium is ~92% co-author leakage), the count chip (#910), junk-word suppression and why two-word person-name suppression was rejected as unsafe (#907), the production-scale distribution (585 scholars with ≥1 High, ~3.5k relationships), worked cases (Drilon vs Tamimi), governance, and the next lever (the `A.Ashworth`/`C Lehman` initial-surname co-author leak that still escapes #903). |
| [`pops-clinical-search-spec.md`](./pops-clinical-search-spec.md) | Where board certifications, clinical specialties, and clinical expertise come from — the weekly POPS ETL job and its `pops_*` columns — and why a People search says "Board certified in Cardiology": the `function_score` clinical weight and the count-gated precedence against a tagged-publication match. |
| [`clinical-trials-source-spec.md`](./clinical-trials-source-spec.md) | Where a scholar's **Clinical trials** section comes from — the two reciterdb sources (`clinical_trials`, the pre-linked CWID spine, joined to `clinical_trials_enriched` from the ClinicalTrials.gov v2 API on the nullable `nctNumber`), why `protocolNumber` and not NCT is the natural key, the heuristic PI-vs-Investigator role derivation, the Active/Completed display rule (Withdrawn hidden, no year cut), and the weekly `etl:clinical-trials` refresh. |
| [`ctl-technologies.md`](./ctl-technologies.md) | Where a profile's **Available technologies** come from, and what to do when the weekly CTL scrape shrinks — the CWID-only join (never name, never PMID), the `TechnologyWeekly` step, the `TECHNOLOGIES_MIN_RETAIN` volume guard, and the no-op short-circuit. |
| [`2026-07-18-news-mentions-plan.md`](./2026-07-18-news-mentions-plan.md) | Where a profile's **News mentions** come from and how an article gets attached to a scholar — the `news_mention` model, the weekly `etl:news` ingest (repointed under #2200 to the WCM Newsroom `feed.json`; the research site is a *syndication target*, not a source), the trusted VIVO `cwid-` link → published vs prose name-match → pending rule, the upsert that never reverts a human decision, and the `/edit/news-queue` approval surface (superusers + `comms_steward`). Prod-on 2026-07-27. |
| [`spotlight-pipeline.md`](./spotlight-pipeline.md) | **Why *this* Spotlight card and not that one** — the pipeline end to end across two repos: ReciterAI's monthly 6-stage generation (rank → select → lede → critic → sensitive gate → publish to S3), the impact / relevance / article-score blend that picks a card's lead paper, this app's SHA256-gated weekly `etl:spotlight` full-replacement ingest into `Spotlight`, and the per-surface inclusion criteria (impact ≥ 40, year ≥ 2020, first/last author; faculty-only on topic/unit pages vs faculty + postdocs + fellows on the home carousel). The companion to the operator-facing [`spotlight-runbook.md`](./spotlight-runbook.md). |

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
| [`ADR-008`](./ADR-008-infrastructure-as-code.md) | Infrastructure-as-Code: AWS CDK, TypeScript, in-repo, six stacks (count superseded — nine stacks today) |
| [`ADR-009`](./ADR-009-database-role-separation.md) | Database role separation: `app_rw` DML-only, `sps_migrate` for DDL (accepted 2026-05-30) |
| [`ADR-010`](./ADR-010-topic-anchor-relation-semantics.md) | Topic anchors: the unvetted second hop — curated lay-term→descriptor mappings are vetted, but descriptor→research-area is not, so a wide anchor (e.g. `Radiology`) injects a whole area at full weight. **Proposed**, undecided — recommends F+B (store the lay term, add a graded `applied_weight`) plus a tier-gate fix, but adopting nothing is also legitimate per the doc |
| [`ADR-011`](./ADR-011-concept-magnitude-ceiling.md) | Concept magnitude in People ranking: raise the ceiling on the magnitude the system already computes rather than index a new one — **partially accepted**, parts already in production (see the doc's Status header) |
| [`ADR-012`](./ADR-012-infoed-grant-import-policy.md) | InfoEd grant import policy: which records are admitted, what may be published as a project period (awarded only — never the proposed period), and which sources a date may come from (InfoEd and NIH RePORTER; not the `reciterdb` mirror). Also records what a `grant_date_gap` row actually means, why the `pgm_type` INNER JOIN is left in place deliberately, why `PMAward` is refuted as a fallback, and the investigator-role contract (D11) — the `dd_role` values that mean PD/PI, and why a non-NIH award may under-report additional PD/PIs at source. **Partially accepted, nothing yet in production** — see the doc's Status header |

## 8. How key features behave (for "why does it do that?")

| Doc | Answers |
|---|---|
| [`search.md`](./search.md) | How unified `/search` ranks people, publications, and grants, and what signal backs each rank. |
| [`search-recall.md`](./search-recall.md) | **Why some obvious queries return too few people** (`covid19`→9 vs `covid-19`→1,425; `tylenol`→0). The *recall* counterpart to `search.md` (ranking): the two independent admission gaps — alphanumeric tokenization (#725/PR #727) and MeSH concept-resolution being ranking-only (#726) — with root causes, the fixes, validation, deploy sequencing, and limits. |
| [`search-publications.md`](./search-publications.md) | Example-driven explainer for the Publications tab of `/search`. |
| [`browse-vs-search.md`](./browse-vs-search.md) | The distinct jobs of the browse pages vs search. |
| [`suggested-search-chips.md`](./suggested-search-chips.md) | Where the homepage "Try:" suggestion chips come from and **how to refresh them** — the curated lay-term master (`data/suggested-searches.json`), the runtime pool + sampler, and the repeatable method (mine the taxonomy → verify WCM depth → keep the lay-term↔MeSH gap). Reach for this when a chip looks stale or thin, or when it's time to regenerate the list. || [`taxonomy-aware-search.md`](./taxonomy-aware-search.md) | Taxonomy/MeSH-aware relevance re-weighting (v2.2). |
| [`search-relevance-contract.md`](./search-relevance-contract.md) | 🔴 **The governing document for search relevance** — the numbered rules (O1–O9, E-series) every ranking term must obey, plus the **open-violation register** naming which are currently broken and where. Read this before proposing, reviewing or judging any ranking change; a change that moves ordering without a register row is unreviewable. |
| [`search-people-relevance.md`](./search-people-relevance.md) | The descriptive layer-by-layer walkthrough of how a People result gets its score — admission, the relevance query, the prominence `function_score`, the concept/area arms, and the tiers. The "what it does" to the contract's "what it must do". |
| [`search-research-area-relevance-spec.md`](./search-research-area-relevance-spec.md) | How research-area (topic) pages rank their scholars, and the eligibility carve behind the listing. |
| [`search-recency-relevance-spec.md`](./search-recency-relevance-spec.md) | Recency in relevance — the spec for how (and whether) publication age influences ordering. |
| [`search-mesh-resolution-fallback-spec.md`](./search-mesh-resolution-fallback-spec.md) | How a query string resolves to a MeSH descriptor, and the fallback chain when it doesn't resolve cleanly. Upstream of every concept-based ranking term. |
| [`scholar-card-evidence-rows-spec.md`](./scholar-card-evidence-rows-spec.md) | The scholar-card evidence rows — what the card is allowed to assert about *why* a scholar matched. The display counterpart to `search-evidence-rows.md`. |
| [`1366-evidence-reason-counts-spec.md`](./1366-evidence-reason-counts-spec.md) | Why a scholar card shows up to three stacked reason lines, and where "5 of 41 publications tagged Obesity" comes from — the counted, stacked evidence model (method / tagged-concept / research-area as first-class lines, keyword fallback, clinical label-only), the per-line count sources, and the claimed-PMID de-dup that keeps representative papers disjoint across lines. Live in both envs. |
| [`search-card-snippet-decision.md`](./search-card-snippet-decision.md) | Why a People card shows *this* one "why it matched" line, and which papers appear when it is expanded — the `selectEvidence` priority ladder (query-literal evidence over who-they-are hints; the name is never surfaced) and the key-paper 0.6-relevance / 0.4-recency blend vs the impact-led method/topic exemplar rank. |
| [`feedback-handling-matrix.md`](./feedback-handling-matrix.md) | How user feedback is routed (and the planned ServiceNow intake). |
| [`retracted-publications.md`](./retracted-publications.md) | Why retracted papers don't display — the two-record problem (notice vs original), ReCiter's re-fetch lag, and the nightly PubMed-retraction stamp (#604) that closes the gap via the existing `NEVER_DISPLAY_TYPES` filter. |
| [`what-can-be-hidden.md`](./what-can-be-hidden.md) | **The catalog of everything that can be removed from a public profile and search**, by section and by record — the four mechanisms (`suppression` rows, the `overview` `field_override`, the two Methods-lens overlays, and `deleted_at` soft-delete), the `EntityType` reach (scholar / publication / grant / education / appointment / mentee / org-unit), per-author hide vs whole-pub takedown vs derived-dark, the non-suppressible leadership guard, who can hide what, and the new **Methods & tools** case (no per-scholar control — families are hidden editorially/globally via `family_suppression_overlay`, or public-gated via `family_sensitivity_overlay` + `METHODS_LENS_SENSITIVE_GATE`). The deliberate-hiding counterpart to `retracted-publications.md`; operational view over `ADR-005`. |
| [`section-visibility-spec.md`](./section-visibility-spec.md) | Whether a scholar can hide a whole profile **section** (Mentoring, Funding, Education, Centers, Clinical trials, Methods & tools, Technologies, News) — the booleans stored as `field_override` rows, written through the existing `POST /api/edit/field` with one B03 audit row per toggle and filtered out server-side in `lib/api/profile.ts` so nothing leaks to the client. Display-only: a hidden section stays fully searchable. The middle tier between record-level suppression and whole-profile hide — read with `what-can-be-hidden.md`. |
| [`vivo-incident-analysis.md`](./vivo-incident-analysis.md) | VIVO incident history — what the predecessor system's support load looked like. |
| [`faculty-coverage-metric.md`](./faculty-coverage-metric.md) | **What share of full-time faculty the algorithmic surfaces actually reach** — Spotlight, Methods & tools, and research-area expert rankings — with the precise per-signal definitions, the measured staging numbers (~56%), the honesty caveats (methods dominates and isn't additive; "expert" = top-7 not the 50% subtopic rail; methods-lens is staging-only), and a one-command recompute (`scripts/run-staging-probe.sh`). For About-page / stakeholder coverage claims. |
| [`methods-cellline-redesign-spec.md`](./methods-cellline-redesign-spec.md) | Why a Method page and the profile **Methods & tools** panel behave the way they do — the verbatim-provenance model (rail, highlighted matched term, source link), the master-detail cell-line rail and `?entity=` feed filter, the "How it was used" vs "Where it appears" snippet label, and why HEK293 and HEK293T are never merged. |
| [`methods-facet-org-units-spec.md`](./methods-facet-org-units-spec.md) | How the department/division roster **Methods & tools** facet filters across a whole unit, and why `?method=` is a client fetch to an uncacheable API rather than a URL param — the server-side aggregation, the `/api/units/[kind]/[code]/members` route, and the CloudFront query-allow-list constraint behind the design. |
| [`cancer-center-collaboration-network-spec.md`](./cancer-center-collaboration-network-spec.md) | What the Cancer Center **Collaboration** tab is and who is allowed to appear on it — the program-colored co-authorship graph plus the #1137 Phase 2 grant co-investigator axis (prod-on 2026-07-22), the public gate applied *before* any edge is built (a hidden or soft-deleted scholar is in no node and no edge), why the tab appears only for centers with a `CenterProgram` taxonomy (today only Meyer), the Newman 1/(k−1) weighting + 25-author cap that stops consortium papers dominating, and the standalone HTML/PNG slide export. |
| [`self-edit-spec.md`](./self-edit-spec.md), [`self-edit-ui-spec.md`](./self-edit-ui-spec.md), [`self-edit-launch-spec.md`](./self-edit-launch-spec.md) | **How a scholar edits their own profile** — the self-edit flow, its UI, and launch behavior (live in prod behind WCM SAML since the 2026-07-01 cutover). |
| [`slug-personalization-spec.md`](./slug-personalization-spec.md), [`slug-personalization-ui-spec.md`](./slug-personalization-ui-spec.md) | **How a scholar gets a custom profile URL and who approves it** — the vanity-slug override, write-time reconciliation, and the `/edit/slug-requests` superuser approval queue (`SELF_EDIT_SLUG_REQUEST` on in both envs). |
| [`overview-statement-generator-spec.md`](./overview-statement-generator-spec.md) | **Where AI-generated overview drafts come from, what grounds them, and the live model/prompt version** — the Amazon Bedrock generator (`SELF_EDIT_OVERVIEW_GENERATE` on in both envs; `OVERVIEW_PROMPT_VERSION_DEFAULT` v4), provenance/version history, and grounding hardening. |
| [`overview-generator-panel-spec.md`](./overview-generator-panel-spec.md) | What the AI overview generator's `/edit` panel actually does, and whether a generated draft can clobber a scholar's saved overview — the "Draft with AI" block, the Replace / Insert below / Discard review net, the sources drawer, and the per-source ranking rules shown to the scholar. |
| [`overview-generator-selection-spec.md`](./overview-generator-selection-spec.md) | What the AI overview generator feeds the model, what is deliberately withheld from the prose *and* from the drawer, and how a scholar's pin/exclude choices survive a re-run — the three-state delta selection model, the numbers/tiers rule, the per-type visibility ledger, and the `sample_context` grounding projection. |
| [`coi-publications-review-redesign-spec.md`](./coi-publications-review-redesign-spec.md) | Why the COI "From your publications" panel groups by paper as well as organization, and why one click can clear four companies at once — the `(pmid, subjectId)` statement decision unit, self/co-author subject attribution, and the two-marks-only highlighting rule. |
| [`coi-gap-feedback-spec.md`](./coi-gap-feedback-spec.md) | What happens when a scholar answers a "From your publications" COI suggestion — the three reason-coded choices (`will_disclose` / `historical` / `invalid`), the active / lower-confidence / **Reviewed** partition and its invariant, Undo and change-of-mind, the rail-item and badge rules, and the governance boundary on what may reach the browser (never the entity score, attribution, category, or lifecycle status). |
| [`data-quality-dashboard-spec.md`](./data-quality-dashboard-spec.md) | Who appears on `/edit/data-quality` and in what order — the three gap signals (headshot, overview, pending COI), the prominence formula, steward-vs-unit scoping, and the 5,000-row CSV export cap. |
| [`scholar-cv-generator-spec.md`](./scholar-cv-generator-spec.md) | What the `/edit` "CV (WCM format)" download produces, and where each section's data comes from — the 23-section WCM template fill, the per-section Scholars / POPS / LLM / N-A coverage matrix, the zero-persist POPS clinical enrichment (`is_hidden` honored), and the suppression / FERPA-mentee / email-visibility carves the export must obey. |

## 9. Build-time specs & drafts (not operational)

These describe features under construction. They are **not** the place to answer a
post-launch operational question; consult them only when working on the feature itself.
Listed here for completeness so §1–§8 stay focused.

- Self-edit "Request a change" mailer (still dark — `SELF_EDIT_REQUEST_CHANGE_SEND` off in
  both envs, falls back to `mailto:`): `self-edit-request-change-modal.md`
  (mailer paired with `ses-sender-verification.md`, §5), `feedback-badge-spec.md`
- Unit curation: `unit-curation-spec.md`, `org-unit-curation-spec.md`,
  `center-management-spec.md`
- RePORTER grants v2 — the PMID-overlap matcher and the `/edit` "Is this you?" confirm card for
  scholars with no `person_nih_profile` row: `reporter-grants-v2-matcher-spec.md`. Merged and
  staging-soaked but **dark in prod** — `REPORTER_MATCH_V2` is `env === "staging" ? "on" : "off"`
  in both the app and ETL task-defs, so `reporter_profile_candidate` stays empty in prod until ops
  flip it. (v1 shipped and is indexed in §6.)
- Cancer taxonomy generator — the two-axis (`cancer_relevant`/`topics`) MeSH-descriptor
  closure replacing the hand-picked `docs/cancer-center-disease-taxonomy.csv`; the
  admit-exclude-readmit algorithm, the paired-hash versioning, the rot-detection design, and
  the "size before deciding" content-review discipline: `cancer-taxonomy-generator.md`. The
  generator/table/ETL step are merged and have run for real against staging (#2356); content
  refinements are in review (#2358). **Not wired to any reader** — the Reports tab, CSV
  export, and modal still read the old taxonomy pending a person-level cutover diff. Promote
  to §6 once that cutover ships.
- Outreach (launch-window, #506 D5): `outreach/_skeleton.md` (shared 5-part template) + per-audience
  drafts `outreach/wave1-center-admins.md`, `outreach/wave1-superusers-library.md`,
  `outreach/wave2-scholars.md`,
  `outreach/wave3-doctoral-students.md`, `outreach/wave4-public-launch.md`
- ServiceNow KB (launch support, #506 D3): `kb/01-scholars.md` (Scholars) and `kb/02-dept-admins.md`
  (dept/division/center Owners+Curators) — task-based, one screenshot per action, captured live
  2026-08-01, published to ServiceNow 2026-08-04; index in `kb/README.md`. Routing destinations are
  owned by `feedback-handling-matrix.md` (§8), not restated in the articles.
- Snapshots/fixtures: `spec-snapshots/`

---

## 9a. Audits & snapshots (point-in-time)

Dated, point-in-time artifacts under [`audits/`](./audits/) — audits, A/B tests, and validation
runs. Each is **accurate as of the date in its filename and is not maintained**; kept for
provenance and to show engineering rigor, not as a current-state reference. Don't cite one as the
live state without re-checking the source.

| Doc | What it captured |
|---|---|
| [`audits/a11y-audit-2026-05-29.md`](./audits/a11y-audit-2026-05-29.md) | Accessibility audit. |
| [`audits/etl-reliability-audit-2026-07-02.md`](./audits/etl-reliability-audit-2026-07-02.md) | ETL reliability / failure-mode audit. |
| [`audits/search-facet-perf-audit-2026-07-02.md`](./audits/search-facet-perf-audit-2026-07-02.md) | Search facet performance audit. |
| [`audits/search-area-boost-ab-2026-07-02.md`](./audits/search-area-boost-ab-2026-07-02.md) | Search research-area boost A/B. |
| [`audits/search-boost-tuning-ab-2026-07-03.md`](./audits/search-boost-tuning-ab-2026-07-03.md) | Search boost-tuning A/B. |
| [`audits/overview-generator-validation-2026-06-08.md`](./audits/overview-generator-validation-2026-06-08.md) | Overview-generator output validation. |
| [`audits/methods-lens-prod-golive-2026-06-14.md`](./audits/methods-lens-prod-golive-2026-06-14.md) | The methods-lens prod go-live cutover — the operator package (two code changes + a data load, not a flag flip). **Executed 2026-07-05** (#962/#1481); read it as the plan of record, never as current state. |
| [`audits/matcha-extract-model-ab-2026-07-14.md`](./audits/matcha-extract-model-ab-2026-07-14.md) | Matcha concept-extraction model bake-off, Opus 4.8 vs Sonnet 4.5 — no win (+0.010, inside Opus's own 0.0215 spread), so **Sonnet stayed** and is the live config today. The durable number is the eval's **~0.0074 nDCG noise floor even at `temperature: 0`**: any single-run gain under ~0.01 is unproven. |
| [`audits/matcha-gloss-query-ab-2026-07-19.md`](./audits/matcha-gloss-query-ab-2026-07-19.md) | Matcha gloss-query A/B — MeSH concept canonicalization vs the sponsor's literal phrasing. The gloss arm lost on every metric (it *substitutes* the gloss rather than adding it); the retrieval half was deleted. |

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
| Post-Edge/Etl cost baseline (current `$425/mo` predates CloudFront + ETL) and per-service `est.` → actuals from Cost Explorer | [`cost-model.md`](./cost-model.md) | **Trigger fired 2026-07-01** — EdgeStack + EtlStack now active in prod; re-audit due (add the #1430 WAF managed-rules line item). |
| Production WAF topology — **decided 2026-06-03 (#502):** CloudFront + AWS-native WebACL (managed rules + rate rule, count mode via #1430) → NetScaler → ALB | [`network-security-topology.md`](./network-security-topology.md) | Residual: count→block promotion after false-positive review (#1434). |
| WCM-internal ETL routing — **superseded by the shared-VPC consolidation (#1419); prod Tier-1 population executed 2026-07-01** ([`prod-etl-tier1-runbook.md`](./prod-etl-tier1-runbook.md)) | [`network-security-topology.md`](./network-security-topology.md) | Residual (SPS-owned): prod's own shared-VPC cutover + Tier-2 nightly sources. |
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
| 2 | **Production WAF topology** — ✅ **answered 2026-06-03 (#502):** CloudFront stays in the path; an on-prem NetScaler sits between CloudFront and the public ALB (no EdgeStack unwind); the AWS-native WAFv2 WebACL is now layered with AWS managed rule groups + a rate rule in **count mode** (#1430). | Residual: promote the managed rules count→block after false-positive review (#1434), then the NetScaler operational re-point; reconcile [`network-security-topology.md`](./network-security-topology.md). | ITSOPS / security (RITM0792011, #502) |
| 3 | **Revised monthly cost budget** — `$600/mo` predates EdgeStack + EtlStack. What should `sps-monthly-budget` be at launch? | Sets the guardrail in [`cost-model.md`](./cost-model.md). | Operator / budget owner |
| 4 | **Reader/writer split at launch** — set `DATABASE_URL_RO` to activate the Aurora reader endpoint, or launch writer-only and split as a P1? | Affects DB capacity headroom + the read path in [`architecture-overview.md`](./architecture-overview.md). | Operator |
| 5 | **DR posture sign-off** — is PITR-only (restore Variant A) acceptable for go-live, or must the us-west-2 DR restore (Variant B) be exercised first? | Confirms the RTO/RPO claim in [`PRODUCTION.md`](./PRODUCTION.md) is signed off, not just asserted. | Operator + business owner |
| 6 | **Access recertification cadence** — who reviews superuser-group + `unit_admin` grant membership, and how often? Is a recert required for launch? | Closes the governance gap noted in [`access-control-rbac.md`](./access-control-rbac.md). | Faculty Affairs + ITS |
| 7 | **Break-glass policy** — is directory-dependent emergency superuser elevation acceptable, or is a standing break-glass account required? | Confirms the emergency-access posture in [`access-control-rbac.md`](./access-control-rbac.md). | Security |
| 8 | **ETL→WCM connectivity** — ✅ **superseded:** the TGW-attach ask was mooted by consolidating the estate into the already-attached shared `its-reciter-vpc01` (#1419), and prod Tier-1 data population was executed 2026-07-01 ([`prod-etl-tier1-runbook.md`](./prod-etl-tier1-runbook.md)). | Residual: prod's own shared-VPC cutover + Tier-2 nightly/WCM-path sources. | SPS-owned |
| 9 | **SAML cert rollover** — CWID-as-attribute is confirmed ([`saml-sp.md`](./saml-sp.md) §1, against a live WCM assertion); remaining: verify the **deployed** `SAML_IDP_CERT` secret carries both the 2016 and 2036 IdP certs before the **2026-08-19** expiry. | A dated operational deadline ([`saml-sp.md`](./saml-sp.md) §2). | SAML / IdP contact |
| 10 | **Post-launch operations ownership** — who is the named operator / on-call after launch (today: `paa2013@med.cornell.edu` / `paulalbert1`)? Is there a team handoff? | Determines who [`oncall.md`](./oncall.md) and the alarm fan-out actually page. | ITS management |

---

*Last updated: 2026-08-07 — docs-tree reconciliation: 57 unindexed docs triaged, 34 of them verified
as documenting live, shipped behavior and given rows — §2 `search-people-concurrency-performance.md`
+ `1503-shared-cachehandler-spec.md`; §3 `edit-auth-200-vs-403.md`; §4 `qa/launch-data-qa.md` +
`scholar-proxy-runbook.md`; §5 the impersonation / scholar-proxy / ED-admin / comms-steward /
role-aware-navigation specs plus the two visibility carves (`student-profile-visibility.md`,
`email-visibility-spec.md`) and the Faculty Review grants API; §6 POPS clinical, clinical trials,
CTL technologies, news mentions, the Spotlight pipeline and the RePORTER v1 matcher; §8 twelve
feature-behavior specs (evidence counts, search-card snippet, section visibility, the two methods
surfaces, the Cancer Center collaboration network, both overview-generator specs, the two COI
panels, the data-quality dashboard, the CV generator). 20 transient handoffs and build-time plans
left the repo for the private working area; 3 dated artifacts moved under `audits/` and are now
listed in §9a (`matcha-extract-model-ab-2026-07-14`, `matcha-gloss-query-ab-2026-07-19`,
`methods-lens-prod-golive-2026-06-14`). §9 gained the prod-dark RePORTER v2 matcher. §6 added the
first integration spec, [`integrations/grants.md`](./integrations/grants.md), and the preamble now
names that class and points at `CONTRIBUTING.md` § Integration specs for the contract; the preamble's
§9 examples were repointed off `self-edit-*`/`slug-personalization-*` (promoted to §8 on 2026-07-03).
Every relative link in §0–§11 was re-checked against disk — all resolve, no repoints needed. Two
corrections found while indexing: `METHODS_LENS_SENSITIVE_GATE` has been on in **both** envs since
2026-07-05 (not off), and `reporter-grants-matcher-spec.md` still carries a stale "NOT built" status
header although v1 shipped under #1305–#1309. 2026-07-03 — drift-audit reconciliation: §1 architecture-overview "six CDK stacks" → nine (+ ADR-008 count-superseded note); §3 etl-monitoring row → the two-topic P1/P2 tiered model (`etl-page-<env>` page / `etl-failures-<env>` warn, #1438); §1 STAGING row + §0/§5 network rows now flag the 2026-07-02 staging shared-VPC cutover (#1419); §7 added the ADR-009 (database role separation) row; §0 + §4 added `flag-inventory.md`; §4 added `curation-backup-runbook.md` and the §0 restore row now cites it; §9 fixed the dead `unit-curation-edit-ui-spec.md` reference (→ `org-unit-curation-spec.md`) and promoted shipped work out of §9 (error-handling → §0 triage; slug-personalization, overview-statement-generator, and self-edit spec/ui/launch → §8); §10/§11 marked the WAF topology (#502/#1430) and ETL→WCM (#1419 + prod Tier-1) questions answered and narrowed to their residuals, narrowed the SAML Q9 to the cert-rollover deadline, and annotated the cost-baseline trigger as fired 2026-07-01. 2026-06-10 — §0/§8 added [`what-can-be-hidden.md`](./what-can-be-hidden.md):
the catalog of everything that can be removed from a public profile and search, by section and by
record — the four mechanisms (`suppression`, the `overview` `field_override`, the two Methods-lens
overlays, `deleted_at` soft-delete), per-author hide vs whole-pub takedown vs derived-dark, the
non-suppressible leadership guard, the who-can-hide-what matrix, and the new **Methods & tools**
case (no per-scholar control — families are hidden editorially via `family_suppression_overlay` or
public-gated via `family_sensitivity_overlay` + `METHODS_LENS_SENSITIVE_GATE`). 2026-06-09 — §0/§6 added [`scholar-tools-taxonomy.md`](./scholar-tools-taxonomy.md):
where the Methods & tools (method-family) taxonomy lives — the ReciterAI A2 artifact set on S3
(`tools/latest/{tools,families}.json`), **not** DynamoDB (the legacy `reciterai` `TOOL#` rows are
per-PMID activity, not the canonical registry) — plus the published `tools[]`/`families[]` schema,
the `etl:scholar-tool` loader, the reversible `SCHOLAR_TOOL_SOURCE` (ddb→s3) cutover switch (#794),
the `scholar_tool` field mapping, and the offline consolidation-export script. 2026-06-03 — §0/§3 added [`etl-monitoring.md`](./etl-monitoring.md) (#595):
how ETL failures and stale data surface to Teams (per-step failure + status/cadence alarms +
the new daily freshness heartbeat, all via `etl-failures-<env>` → on-call relay), prompted by
an 8-night-silent nightly-cadence failure whose alarm topic had no subscriber. Earlier 2026-06-03 — §0/§8 added [`search-recall.md`](./search-recall.md): why `covid19`/`tylenol`
return too few people — the alphanumeric-tokenization gap (#725/PR #727) and the MeSH concept-resolution-is-ranking-only
gap (#726), with root causes, fixes, validation, deploy sequencing, and limits. Earlier 2026-06-03 — §8 added [`suggested-search-chips.md`](./suggested-search-chips.md):
the homepage "Try:" chips were swapped from generic department/topic names to a curated 169-term
lay-term master (`data/suggested-searches.json`), sampled broadly per page load; the doc captures
the repeatable refresh method. 2026-06-01 — added [`retracted-publications.md`](./retracted-publications.md)
(§0 triage + §8): why retracted papers don't display and why the nightly PubMed-retraction
step (#604, PR #625) is required to close the ReCiter re-fetch gap. 2026-05-29 — §10 app-tier autoscaling resolved: `AppStack` now ships a
target-tracking policy (#596) and the docs are reconciled; the row is narrowed to
threshold-tuning pending #554. Earlier 2026-05-29 — §10 added the app-tier autoscaling doc/infra mismatch (#596);
added §9 launch-window outreach drafts (Waves 1–4 + skeleton, #506 D5) and the ServiceNow KB
article drafts (#506 D3); fixed the footer "Help & support" link to point at `/about` (the public
help surface). 2026-05-28 — eight operational gap docs added; §10 tracks residual data-collection
follow-ons; §11 tracks open questions (see issue #560).*
