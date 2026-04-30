---
gsd_state_version: 1.0
milestone: v1.7.1
milestone_name: milestone
status: executing
stopped_at: Phase 2 UI-SPEC approved
last_updated: "2026-04-30T20:11:53.541Z"
last_activity: 2026-04-30 -- Phase 02 execution started
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 13
  completed_plans: 4
  percent: 31
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-30)

**Core value:** WCM faculty profiles, search, and algorithmic surfaces serve as a usable VIVO replacement — and Mohammad's production team can consume the prototype as reference implementation.
**Current focus:** Phase 02 — algorithmic-surfaces-and-home-composition

## Current Position

Milestone: 2 of 2 (Public-launch readiness)
Phase: 02 (algorithmic-surfaces-and-home-composition) — EXECUTING
Plan: 1 of 9
Status: Executing Phase 02
Last activity: 2026-04-30 -- Phase 02 execution started

Progress: [██░░░░░░░░] ~36% (Milestone 1 BUILD-PLAN Phases 0–4 shipped; Milestone 2 not started)

## Performance Metrics

**Velocity:**

- Total plans completed: — (Milestone 1 ran on BUILD-PLAN sessions, not GSD plans)
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| — | — | — | — |
| 01 | 4 | - | - |

**Recent Trend:** N/A — Milestone 2 not yet started

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table. Recent / relevant for Milestone 2:

- ADR-001 (PROVISIONAL): Single Next.js deploy + `/api/*` routes; route handlers as pure functions in `lib/api/*`; production topology deferred to Mohammad's design kickoff. `openapi.yaml` is the durable artifact (Phase 6 deliverable).
- ADR-006 (LOCKED): Runtime reads only MySQL — no runtime DynamoDB read path. The Q6 ADR (`docs/ADR-001-runtime-dal-vs-etl-transform.md`) is a Phase 6 documentation deliverable.
- ADR-008 (LOCKED): Profile pages ISR with on-demand revalidation; CSR for search via `/api/search`; the `/api/edit` pipeline (Phase 7) atomically writes MySQL + revalidates path + upserts OpenSearch.
- ADR-009 (LOCKED 2026-04-30): Headshot integration mirrors ReCiter-Publication-Manager — no server proxy, no ETL pre-fetch in Phase 1.
- REQ-publications-ranking: Variant B (multiplicative, surface-keyed recency curves) wins; functional spec arithmetic superseded.

### Pending Todos

None yet.

### Blockers/Concerns

- **Methodology page is a launch blocker.** Phase 2 ships algorithmic surfaces with "How this works" links; Phase 4 must land the About page before any of those surfaces go to external users. Roadmap orders Phase 4 before Phase 5 (SEO public exposure) for this reason.
- **Methodology page owner still TBD.** Design spec v1.2 changelog flags this as a circulation blocker; needs to resolve before or during Phase 4.
- **Edit-event logging target TBD** (Slack channel? email digest?). Affects Phase 7 / EDIT-04. Decided by end of design phase per spec.
- **Service-desk ticketing target TBD** (ServiceNow form vs email). Affects support page (out-of-scope for this milestone but flagged because it's a launch dependency).
- **VIVO URL pattern audit not done.** Phase 5 / SEO-04 depends on enumerating existing VIVO URL forms in production to produce the redirect mapping table.
- **Calibration items carried forward** from Milestone 1: AOI threshold + 6× search boost calibration; publication ranking weight calibration against ~20 real WCM profiles spanning seniority; specific completeness threshold; citation refresh cadence in reciterdb-prod.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Architecture | Production AWS topology (Aurora, Fargate, OpenSearch Service, EventBridge + Lambda for ETL, CloudFront, ElastiCache Redis) | Owned by Mohammad's team | Milestone 1 (out of scope) |
| Architecture | Standalone Scholar API service (Mohammad's preliminary lean) | Pending design kickoff | ADR-001 PROVISIONAL |
| Search | Embeddings-based hybrid retrieval (BM25 + dense biomedical embedding) | Phase 2+ | ADR-007 |
| Profiles | Doctoral student inclusion (active doctoral program enrollment) | Phase 2+ | ADR-004 |
| Profiles | Abstracts on profile, schema.org Person JSON-LD | Phase 2+ | functional spec phase mapping |
| Search | Saved searches, advanced search builder, abstract full-text search | Phase 2+ | functional spec |
| Browse | Division detail pages, center / institute detail pages | Phase 2+ | design spec v1.5 / v1.1 |
| Self-edit | Suppress structured fields, feature top pubs, delegate editing | Phase 3+ | functional spec |
| Citations | AMA, APA, RIS formats | Phase 2+ | design spec v1.7.1 |
| Headshots | Server-side `/api/headshot/:cwid` proxy with cache headers | Future enhancement | ADR-009 |

## Session Continuity

Last session: 2026-04-30T16:53:40.386Z
Stopped at: Phase 2 UI-SPEC approved
Resume file: .planning/phases/02-algorithmic-surfaces-and-home-composition/02-UI-SPEC.md
