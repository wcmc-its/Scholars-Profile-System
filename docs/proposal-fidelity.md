# Fidelity to the Original Proposal

_How faithful is what we built to what we pitched?_

**Compared against:** `WCM_Scholar_Proposal-v2.pptx` (AAC Ad-Hoc Subcommittee on Citizen
Development; phased-rollout and schedule slides dated October 19, 2022; cost slides c. 2024).
**As of:** 2026-05-22 — the proposal's Phase 1 development window (Feb 1 – May 20, 2026)
has just closed.

This document scores the delivered Scholars Profile System against the commitments in the
proposal deck. It is deliberately candid: it credits where we held the line, names where we
deviated and why, flags where we over-delivered, and is honest about what has slipped.

---

## Verdict in one paragraph

We kept the **strategic thesis** of the proposal almost perfectly — build custom and modular,
separate the curation system-of-record from a dedicated presentation layer, run AWS-native,
avoid legacy frameworks — and we delivered the **Phase 1 feature set** in full and then some.
Where we broke from the deck, we broke from its *implementation specifics* (microservices,
SSIS replication, a Redis cache tier), not its goals — and each break is recorded in an ADR.
The one area genuinely behind the pitch is **infrastructure deployment**: application
development is on schedule, but there is still no running production environment, and two real
AWS-side blockers (ETL container packaging, VPC↔WCM connectivity) sit between us and a live
site. The proposal's July 21, 2026 deployment target is still the plan, not yet a fact.

**Legend:** ✅ Kept · ➕ Exceeded · 🔄 Deliberately deviated (ADR-backed) · ⏳ Deferred · ⚠️ Behind / at risk

---

## 1. Vision & strategic stance (slide 2, 6)

| Proposal commitment | Status | Evidence / note |
|---|---|---|
| Replacement system for VIVO.med | ✅ | README frames the system as the "Phase 1 replacement for VIVO"; `etl:vivo-redirect` generates the legacy VIVO → Scholars redirect map. |
| New public-facing researcher profiles | ✅ | `app/(public)/scholars/[slug]` and the full public surface. |
| Modern interface, WCM-branded | ✅ | Tailwind 4 + shadcn/ui design system; WCM branding throughout. |
| Expandable, modular design | ✅ | Modular `components/` and `etl/` organization; data sources added without core rewrites. |
| **Micro-services, API-based architecture** | 🔄 | Built as an **API-first modular monolith**, not separate microservices. API routes live in `app/api/` within one Next.js deploy; the proposal's standalone "Scholar API Service" was consolidated. See deviation **D1**. |
| Scalable, high-performance | ✅ | CloudFront 24h edge cache + Next.js ISR + OpenSearch; SLOs documented (`docs/SLOs.md`). |
| Cloud-hosted, modern dev stack | ✅ | AWS Fargate / Aurora / OpenSearch; Next.js 15, React 19, TypeScript strict. |

## 2. Build vs. buy (slides 3–6) — strongest fidelity

The proposal evaluated and **rejected** commercial CRIS/RIM platforms (Elsevier Pure,
Symplectic Elements, Clarivate Converis/Esploro — est. $130k–$350k+ year one) and the
open-source Profiles RNS, in favor of a custom modular build. The stated rationale was:
AWS-native microservices alignment, a **clear separation between the system of record for data
curation and a dedicated presentation layer**, reduced legacy-framework risk, and incremental
evolution over big rewrites.

This is the part of the proposal we honored most precisely. `docs/ADR-001` codifies exactly the
separation the deck promised: **runtime reads MySQL only**; every upstream system (ReCiter,
ReciterAI, ED/LDAP, ASMS, InfoEd) is consumed through scheduled ETL that projects into the
presentation database, never read live at request time. The curation systems remain the
authoritative source; the SPS is purely the presentation layer. ✅➕

## 3. Phased rollout (slides 16–19) — we compressed four phases into the pre-launch build

This is the most important finding. The proposal envisioned a **thin Phase 1 launch** followed
by three incremental post-launch phases over 6+ months. In practice we **pulled Phases 2 and 3
forward into the pre-launch build** — the launch candidate already contains the data-enhancement
and expanded-self-edit scope the deck deferred.

### Phase 1 — Scholar Site Launch (proposed ~4–6 months)

| Proposed deliverable | Status | Note |
|---|---|---|
| Home / landing page | ✅ | `components/home`, highlights, top-scholars. |
| Search, sorting, filtering | ➕ | Far beyond the brief — OpenSearch full-text, taxonomy-aware search, autocomplete, people-relevance ranking. |
| Profile page view | ✅ | Rich profile with topics, funding, mentoring, co-publications. |
| Researcher self-edit (overview statement **only**) | ➕ | We shipped the **entire manual-override layer** (`#356`): overview self-edit **plus** custom slugs, field suppression, featured publications, and superuser admin surfaces (`/edit/scholar`, `/edit/publication`). The deck scoped this much self-edit for **Phase 3**. |
| Support page | ✅ | `app/(public)/about`, methodology page. |
| Site map | ✅ | Present. |
| High-level UX | ✅ | — |
| Data integration services / automation | ➕ | Orchestrated daily ETL chain across far more sources than proposed (see §6). |
| Server stability & optimized page load | ✅ | Edge cache + ISR; documented cache spec. |
| System monitoring | ➕ | ObservabilityStack: CloudWatch alarms, X-Ray/OpenTelemetry tracing, SLOs, SNS→Teams on-call relay. |

### Phase 2 — Data Enhancement (proposed ~8–12 weeks) → **already in the build**

| Proposed | Status | Note |
|---|---|---|
| Abstracts display | ⏳ | Publication detail modal renders ReciterAI synopsis, but corpus coverage is ~3.4% — too sparse for list/search snippets (see `#387`). Genuinely partial. |
| Selected pages (Person, Organizations…) | ✅ | Department, division, and center pages all exist. |
| Enhanced search | ➕ | Already delivered in Phase 1 scope. |
| Landing-page marketing / highlight data | ✅ | Highlights, spotlights, top-scholars surfaces. |

### Phase 3 — Self-Edit Expanded (proposed ~8–12 weeks) → **already in the build**

| Proposed | Status |
|---|---|
| Expanded faculty self-edit data management | ✅ (`#356`) |
| Suppress appointments / grants / education | ✅ suppression in the override layer |
| Suppress publications | ✅ |
| Feature top publications / content | ✅ featured-publications |

### Phase 4 — ASMS Central Faculty Profile (proposed ~8–12 weeks)

| Proposed | Status | Note |
|---|---|---|
| ASMS data integration | ✅ | `etl:asms` ingests Academic & Scientific Memberships. |
| Launch ASMS Faculty Profile / embed "Scholar Profile" via microservice integration | ⏳ | The **cross-system embed** into the ASMS faculty system is not built. It depends on a live production deployment, which does not yet exist. Correctly deferred. |

## 4. Dev stack (slide 21)

| Proposed | Delivered | Status |
|---|---|---|
| React front-end | React 19, but as **Server Components + SSR + ISR**, not a client-rendered SPA | ✅🔄 — library kept; the front-end *architecture* the deck implied changed. See **D1**. |
| Next.js / Node.js for API services | Next.js 15 (App Router) | ✅ |
| Tailwind CSS | Tailwind 4 **+ shadcn/ui** | ✅➕ |
| MySQL database | Aurora MySQL (prod) / MariaDB 11 (local), via Prisma | ✅ |
| **MS SQL Mirror DB / SSIS for replication** | TypeScript ETL via `tsx` → Lambda + EventBridge / Step Functions | 🔄 **D2** — SSIS dropped entirely. `mssql` survives only as a read client for the ASMS source, not as a replication tier. |
| **Redis caching for performance** | CloudFront 24h edge cache + Next.js ISR + OpenSearch | 🔄 **D3** — no standalone Redis tier. There is no `redis`/`ioredis` dependency; ADR-004's "Redis-style caches" is the CDN/ISR layer, not a Redis instance. |
| S3 for images / documents | S3 (image-optimization strategy in ADR-006; OG image generation) | ✅ |

## 5. AWS services (slide 22)

| Proposed | Status | Note |
|---|---|---|
| CloudFront (content/image delivery) | ✅ | EdgeStack; `docs/cloudfront-cache-spec.md`. |
| SAML for authentication | ✅ | `@node-saml/node-saml`; SP↔IdP integration complete (`docs/saml-sp.md`). |
| Fargate for app hosting | ✅ | ECS Fargate, AppStack. |
| Docker (containerization) | ✅ | `Dockerfile` present. |
| Lambda for scheduled tasks | ✅ | EtlStack Lambdas + EventBridge schedules. |
| SMTP for email notifications | ⏳ | No SMTP email feature yet. Operational notifications go via SNS→Lambda→Teams (Adaptive Cards), per the WCM ops model — see deviation **D4**. |
| Route 53 (domain management) | ✅ | `scholars.weill.cornell.edu` DNS track in progress. |
| SSL certificate | ✅ | Both ACM certs ISSUED (us-east-1). |
| RDS (database storage) | ✅ | Aurora MySQL on RDS, DataStack (PITR, deletion-protected). |
| AWS Load Balancer | ✅ | ALB with public + internal-only listeners (B05). |

**Beyond the proposal** (services we added): OpenSearch, DynamoDB (ReciterAI consumption),
AWS WAF, Secrets Manager + RDS rotation, Step Functions, SNS, X-Ray, and a Teams relay.

## 6. Architecture & data-flow diagram (slide 23)

The proposal's diagram showed four front-ends (Public profiles, Researcher Portal, Conflict of
Interest, Admin Portal) reading from a Scholar API Service over a Scholar MySQL database, fed by
an SSIS Integration Database from four sources (Directory, ASMS, infoEd, ReCiter DB), with a
Redis cache and an ASMS MS SQL replica.

| Diagram element | Delivered as | Status |
|---|---|---|
| Public profiles | The entire `app/(public)` surface | ✅ |
| Conflict of Interest | COI disclosures ingested (`etl:coi`) and surfaced as PI/COI indicators on profiles | ✅ |
| Researcher Portal + Admin Portal | Folded into the self-edit + superuser surfaces (`/edit/scholar`, `/edit/publication`), not separate portal apps | 🔄 |
| Scholar API Service (separate tier) | API routes inside the Next.js app | 🔄 **D1** |
| Integration Database / SSIS | TypeScript ETL projecting into MySQL | 🔄 **D2** |
| Scholar Database (MySQL) | Aurora MySQL, Prisma RW-split (B16) | ✅ |
| Redis cache | CDN/ISR caching | 🔄 **D3** |
| Read/Write split | Runtime reads MySQL only; writes confined to `/api/edit*` and `/api/revalidate*` | ✅ |
| Sources: Directory, ASMS, infoEd, ReCiter DB | All four ingested | ✅ |
| _(added sources)_ | ReciterAI (topics/spotlights), RePORTER, NSF, Gates, Jenzabar, NIH profile, MeSH/NLM | ➕ |

## 7. Schedule (slide 24) vs. reality

| Phase 1 activity | Proposed window | Reality at 2026-05-22 |
|---|---|---|
| Development | Feb 1 – May 20, 2026 | ✅ On schedule — window just closed; the application is feature-complete locally / in staging. |
| Infrastructure build | Feb 20 – Apr 30, 2026 | ⚠️ **Behind.** CDK six-stack rollout (ADR-008) is mid-flight: AppStack + ObservabilityStack deployed at `appDesiredCount=0`; full cutover (image / ramp / DB / SAML) and the Etl/Edge stacks are still pending. |
| Build data integrations | Mar 1 – May 30, 2026 | ✅ On track and broader than scoped. |
| Functional testing | May 21 – Jun 30, 2026 | 🟡 Just beginning. |
| Load testing | Jul 1 – 14, 2026 | — pending |
| Deployment | Jul 21, 2026 | ⏳ Still the target. Not yet achievable — see open gaps. |

## 8. Where we deliberately broke from the deck (and why)

Each deviation is intentional and ADR-recorded — none is drift.

- **D1 — Microservices + SPA → API-first modular monolith with React Server Components.** The
  deck's headline "micro-services API-based architecture," its separate "Scholar API Service"
  box, and its "React Front-End" together implied a 2022-standard topology: a client-rendered
  React SPA fetching from a standalone API service over the network. We built none of that shape.
  It is a **single Next.js deploy** with `app/api/` route handlers, and the UI is **React Server
  Components + SSR + ISR**, not a browser SPA — `output: "standalone"` (not a static export),
  only ~51% of components are `use client`, and 11 public pages are statically regenerated and
  served from CloudFront. Rationale: at this scale a separate API tier and a client SPA add
  cross-service version coordination and deployment surface for no benefit; the modular boundary
  that matters (presentation vs. curation) is preserved by ADR-001's ETL projection model, not by
  a network boundary. React the library is kept; the SPA-plus-API *architecture* it implied is
  not. This shift is also what makes **D3** coherent — if most of the front-end renders on the
  server and is cached at the edge, there is no work left for a Redis tier.

- **D2 — SSIS / MS SQL mirror replication → TypeScript ETL.** The proposal's SSIS Integration
  Database and MS SQL mirror were replaced by ETL written in the application's own language
  (`tsx` locally; Lambda + Step Functions in production). Rationale: keeps one toolchain and one
  reviewer skill set, and avoids standing up SSIS/MS SQL infrastructure the team would otherwise
  have to operate. `mssql` remains only as a read client for the ASMS source.

- **D3 — Redis cache tier → CloudFront + ISR.** For a read-mostly public site, a 24-hour edge
  cache plus Next.js incremental static regeneration plus OpenSearch covers the performance goal
  without a Redis instance to provision and operate (ADR-004).

- **D4 — SMTP notifications → SNS → Teams.** Operational alerting matches the confirmed WCM ITS
  ops model (ServiceNow + Teams, no automated paging) rather than the deck's generic "SMTP for
  email notifications." End-user email notifications are simply not a current feature.

- **D5 — IaC rigor not in the deck.** The proposal listed AWS services but said nothing about how
  they'd be expressed as code. We added a full six-stack AWS CDK project in TypeScript, in-repo,
  split by blast radius (ADR-008) — materially more disciplined than the deck anticipated.

## 9. Open gaps and risk

- **No production environment yet.** The system has never been deployed to prod; "prod-readiness"
  is the open B-series backlog (`#99`). This is the central gap between the pitch and today.
- **ETL container can't run the pipeline.** The reused Next standalone image lacks `tsx` and the
  `etl/` source, so ETL Fargate tasks exit 127 — data population in the cloud is blocked pending
  an ETL image repackaging workstream.
- **SPS VPC ↔ WCM connectivity.** ETL can't reach WCM sources from the SPS VPC; the DNS half is
  fixed but routing still times out, and the Transit Gateway / firewall pieces are owned by
  other teams. This blocks `#443`.
- **Abstracts coverage.** Synopsis/abstract data is ~3.4% of the corpus — the deck's Phase 2
  "abstracts display" is technically present but too sparse to surface broadly.
- **ASMS profile embed.** The Phase 4 cross-system integration depends on a live deployment.

---

### Bottom line on fealty

On **strategy and product scope**, fidelity is high-to-over-delivered: we built the custom,
modular, curation-vs-presentation system the deck argued for, and the launch candidate already
contains what the proposal staged across Phases 1–3. On **implementation specifics**, we
substituted better-fit choices for three 2022-era stack assumptions (microservices, SSIS,
Redis), each documented. The honest shortfall is **getting it live**: application development
tracked the schedule, but production infrastructure is the lagging edge, with two real
AWS-side blockers still open against the July 21, 2026 target.
