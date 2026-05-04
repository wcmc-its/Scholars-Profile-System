# docs/ADR-001 — Runtime Data Access Layer = ETL Transform

**Status:** Accepted
**Date:** 2026-05-04
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

> **Namespace note:** This is a *project-level* ADR living in `docs/`,
> distinct from the *planning-level* ADR series in
> `.planning/PROJECT.md` § Key Decisions. The upstream planning
> decision this document codifies is **planning ADR-006 (LOCKED)**:
> "Runtime reads only MySQL — no runtime DynamoDB read path." The
> `docs/ADR-001` numbering starts a fresh sequence in the project
> codebase ADR namespace and is unrelated to planning ADR-001
> (the provisional single-deploy vs. separate API service topology
> decision).

---

## Context

The WCM functional specification (ReCiter Scholars Profile Technical Specification v1.7.1)
describes a "Data Access Layer (DAL)" that reads from multiple upstream systems at runtime.
The spec language implies read paths to DynamoDB (for ReCiterAI taxonomy and scoring data),
the Enterprise Directory LDAP service, and several Spring Boot microservices (ReCiter,
PubMed/Scopus Retrieval Tool). This matches the production infrastructure topology —
Aurora MySQL, OpenSearch, DynamoDB, LDAP — that Mohammad's team manages.

The prototype implementation makes a deliberate architectural departure from this verbatim
language. The application reads only MySQL (and OpenSearch for the search endpoint) at
runtime. Every other upstream system is consumed via a scheduled ETL pipeline that projects
its data into MySQL before any API request is served.

This document explains the reasoning for that departure so that Mohammad's team understands
the intentional design choice when using the prototype as a reference implementation.

## Decision

The runtime data access layer is MySQL-only. Specifically:

- **Runtime reads: MySQL and OpenSearch only.** All five public read endpoints documented
  in `openapi.yaml` resolve their data from MySQL (for profile and publication data) or
  OpenSearch (for `/api/search` and `/api/search/suggest`). No API route makes a runtime
  call to DynamoDB, LDAP, or any upstream microservice.

- **No runtime DynamoDB read path.** ReCiterAI taxonomy labels (`topic_assignment`) and
  publication impact scores (`publication_score`) — the two fields stored in DynamoDB by
  the ReCiterAI pipeline — are copied into MySQL by a dedicated ETL step. Only these two
  fields cross the DynamoDB-to-MySQL boundary; full DynamoDB document shapes are not
  replicated. Planning ADR-006 calls this the "minimal projection."

- **The "DAL" is the ETL transform layer.** The spec's DAL language is reinterpreted as the
  ETL orchestration chain (`etl/orchestrate.ts`) that runs nightly for most sources (ED,
  ASMS, InfoEd, ReCiter, COI) and weekly for the ReCiterAI projection. The ETL chain is the
  "data access layer" in the sense that it fetches, validates, and loads upstream data — but
  it runs as a background job, not inline with API requests.

- **OpenSearch is read-only at runtime.** The search index is populated by the ETL chain
  (re-indexed after each successful ReCiter refresh). API routes do not write to OpenSearch
  at request time, with the sole exception of the `/api/edit` self-edit pipeline (Phase 7),
  which atomically upserts the OpenSearch document alongside the MySQL write.

## Consequences

**Positive outcomes:**

The principal benefit is bounded and predictable API latency. Every profile, search, and
health endpoint resolves from a single local MySQL instance (Docker locally; Aurora MySQL in
production). There is no runtime fan-out to DynamoDB or external services, so p99 latency
is determined by MySQL query performance, not by the slowest upstream system in the request
path.

Local development is significantly simpler. A developer with only Docker and MySQL credentials
can run the full application against a seeded database. There is no requirement for DynamoDB
Local, LDAP connectivity, or AWS credentials in the local development environment.

The ETL chain is also the natural place to enforce the schema-change protocol (30-day advance
notice from upstream). Schema changes in DynamoDB or ED affect only the ETL code, not the
API routes or the TypeScript types consumed by the frontend.

**Negative outcomes and mitigations:**

The application operates on data that is as stale as the last successful ETL run. The
staleness window is bounded by cadence: daily for ED, ASMS, InfoEd, ReCiter, and COI;
weekly for the ReCiterAI projection. The `/api/health/refresh-status` endpoint exposes the
`lastSuccessAt` timestamp for each source and raises `allFresh: false` (HTTP 503) when any
source has not run successfully within 26 hours. Mohammad's team can wire this to a
CloudWatch alarm for operational monitoring.

Schema drift in upstream DynamoDB or LDAP requires ETL code changes to remain current. This
is mitigated by the 30-day-advance schema-change protocol specified in design spec v1.7.1
and by contract tests in CI that validate expected response shapes from those sources.

**Operational implications:**

Production deployment requires a scheduled ETL pipeline. The current prototype uses
`npm run etl:daily` (a CLI script calling `etl/orchestrate.ts`) invoked manually during
development. In production, this script runs on a schedule — EventBridge + Lambda is the
expected pattern, but ownership of the scheduling infrastructure transfers to Mohammad's
team per planning ADR-001 (PROVISIONAL).

**Forward compatibility:**

This decision applies to the current Phase 1-7 read endpoints. If a future requirement
introduces a real-time data signal (for example, a live grant lookup or a live COI check),
adding a runtime read path for that signal does not invalidate this ADR. The MySQL-only rule
is a deliberate constraint for the prototype's scope, not a hard architectural boundary for
the production system.

## Alternatives Considered

**Real-time DynamoDB reads from API routes.** The spec's original DAL language points toward
this approach. It was rejected because it couples public API latency to DynamoDB throughput
and read-capacity provisioning, complicates local development (developers need DynamoDB Local
or AWS credentials for every request), and adds operational overhead for monitoring a second
data store in the request path. The minimal-projection ETL achieves the same data freshness
guarantees with none of those costs, given that ReCiterAI scores are themselves updated only
weekly.

**GraphQL federation across upstream microservices.** Rejected as disproportionate for a
prototype. It introduces a gateway layer to operate and still has the same latency and
availability coupling concerns as real-time DynamoDB reads. The ADR-001 PROVISIONAL decision
to use a single Next.js deploy is the correct trade-off at prototype scale.

**Cache-aside DynamoDB reads with a short TTL.** Rejected because it adds a cache layer to
operate (and invalidate correctly) while providing the same data freshness as the ETL
approach. The ETL is simpler to reason about and already runs for every other data source.

## References

- `.planning/PROJECT.md` § Key Decisions → **planning ADR-006 (LOCKED)**: "Runtime reads
  only MySQL — no runtime DynamoDB read path; ReCiterAI consumed via minimal-projection ETL."
  This is the upstream planning artifact that this document codifies at the code level.
- `.planning/PROJECT.md` § Key Decisions → **planning ADR-001 (PROVISIONAL)**: Single Next.js
  deploy vs. separate API service — distinct from this ADR; governs deployment topology.
- `.planning/PROJECT.md` § Key Decisions → **planning ADR-005 (LOCKED)**: Daily refresh
  failure modes and per-source independent refresh with ED-first abort cascade.
- `etl/orchestrate.ts` — entry point for the ETL pipeline that implements this decision.
- `openapi.yaml` — the API contract surface governed by this runtime architecture.
