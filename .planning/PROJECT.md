# Scholars Profile System

## What This Is

The Scholars Profile System is Weill Cornell Medicine's modern, AWS-native replacement for VIVO — a public scholar profile platform at `scholars.weill.cornell.edu` showcasing WCM faculty to patients, prospective collaborators, funders, students, journalists, and the broader research community. A working local prototype is live (8,943 active faculty rendered against real WCM source systems); this milestone completes the public-launch surface area: headshot integration, four design-spec page types, the algorithmic surfaces locked under design spec v1.7.1, SEO/URL machinery, analytics, OpenAPI artifact, and authenticated self-edit.

## Core Value

WCM faculty profiles, search, and algorithmic surfaces serve as a usable VIVO replacement for the WCM scholar community — and Mohammad's production team can consume the prototype as reference implementation for the AWS-native production build.

## Requirements

### Validated

<!-- Shipped in Milestone 1 (BUILD-PLAN Phases 0–4) and confirmed working per HANDOFF-2026-04-30. -->

- ✓ **PROFILE-01**: Profile pages render header, overview, contact, appointments, education, areas of interest, publications, grants, disclosures — Milestone 1 / BUILD-PLAN Phase 2
- ✓ **PROFILE-02**: Sidebar two-column layout with sticky positioning, action buttons, status pill (absence-as-default) — Milestone 1 / BUILD-PLAN Phase 2
- ✓ **PROFILE-03**: Publication ranking on profile (Variant B multiplicative formula, Selected highlights top 3 + year-grouped feed, hard-excluded letter/editorial/erratum) — Milestone 1 / BUILD-PLAN Phases 2–4
- ✓ **PROFILE-04**: WCM coauthor chips, large author list truncation (Vancouver-style) — Milestone 1 / BUILD-PLAN Phase 2
- ✓ **PROFILE-05**: Empty-state and sparse-profile graceful degradation — Milestone 1 / BUILD-PLAN Phase 2
- ✓ **SEARCH-01**: OpenSearch-backed people + publications indices with per-field boost (Name 10× / AOI 6× / Title 4× / Dept 3× / Overview 2× / Pub titles 1× / MeSH 0.5×) — Milestone 1 / BUILD-PLAN Phase 3
- ✓ **SEARCH-02**: Authorship-weighted contributions (×1.0 / ×0.4 / ×0.1) at index time via term repetition — Milestone 1 / BUILD-PLAN Phase 3
- ✓ **SEARCH-03**: Minimum-evidence threshold for topical-term inclusion (≥2 pubs OR ≥1 first/last-author pub) — Milestone 1 / BUILD-PLAN Phase 3
- ✓ **SEARCH-04**: People/Publications tabs, faceted filters, autocomplete on 2 chars, numbered pagination 20/page — Milestone 1 / BUILD-PLAN Phase 3
- ✓ **SEARCH-05**: `/api/search` proxy keeping OpenSearch credentials server-side — Milestone 1 / BUILD-PLAN Phase 3
- ✓ **IDENTITY-01**: CWID-canonical primary key with `cwid_aliases` table sourced from ED `replacement_cwid` — Milestone 1 / BUILD-PLAN Phase 1
- ✓ **IDENTITY-02**: Slug-primary HTML URLs with collision suffixing and `slug_history` 301 redirects — Milestone 1 / BUILD-PLAN Phase 1
- ✓ **IDENTITY-03**: CWID-keyed API URLs (`/api/scholars/:cwid`) and `/scholars/by-cwid/:cwid` 301 fallback — Milestone 1 / BUILD-PLAN Phase 1
- ✓ **IDENTITY-04**: URL middleware resolves `slug → slug_history → cwid_aliases → 404` — Milestone 1 / BUILD-PLAN Phase 1
- ✓ **LIFECYCLE-01**: Strict delete on appointment loss with 60-day soft-delete retention (`scholar.deleted_at`) — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **LIFECYCLE-02**: All public read paths filter `WHERE deleted_at IS NULL`; nightly hard-delete cleanup job — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **LIFECYCLE-03**: Daily ETL detecting reactivation auto-clears `deleted_at` — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-01**: Daily chain order ED → ASMS → InfoEd → ReCiter (+ DynamoDB minimal projection) → COI with ED-first abort cascade — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-02**: Per-source staging-then-atomic-swap with row-count and required-field validation — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-03**: Per-source `last_successful_refresh_at` timestamp tracking — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-04**: ED via LDAP (`ldaps://ed.weill.cornell.edu:636`) populating 8,943 active WCM faculty — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-05**: ReciterDB via `vivo_publications_prd.analysis_summary_*` tables — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-06**: ASMS via `asms.dbo.*` with `wcmc_person_school` join — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-07**: InfoEd via `wc_infoedprod.dbo.*` 3-step CTE-consolidated query — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-08**: COI via `v_coi_vivo_activity_group` (MySQL, not MSSQL) — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-09**: DynamoDB minimal-projection ETL (`publication_score` + `topic_assignments` only) — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **ETL-10**: `/api/revalidate` webhook unifying ETL + future self-edit write paths — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **HEALTH-01**: `/api/health/refresh-status` endpoint (auth gate stubbed at 401, full wiring deferred to Phase 7) — Milestone 1 / BUILD-PLAN Phase 4
- ✓ **HOME-01**: Hero with H1, subtitle, big search input + autocomplete, suggestion chips, stats strip — Milestone 1 / BUILD-PLAN Phase 2 (verify against Variant B richer composition during Milestone 2)
- ✓ **RENDER-01**: ISR with on-demand revalidation for profile pages; CSR for search via `/api/search` — Milestone 1 / BUILD-PLAN Phases 2–3
- ✓ **RESPONSIVE-01**: Mobile-responsive single-column collapse on profile and search results — Milestone 1 / BUILD-PLAN Phase 2

### Active

<!-- Milestone 2 scope. Building toward these. -->

- [ ] **HEADSHOT-01**: Server-side scholar API responses include `identityImageEndpoint` populated from WCM directory syntax template
- [ ] **HEADSHOT-02**: Browser renderers across all six surfaces fall back to local generic-headshot asset when endpoint is empty
- [ ] **RANKING-01**: Home page Recent contributions surface (6 cards, scholar-attributed, eligibility-carved)
- [ ] **RANKING-02**: Topic page Recent highlights surface (3 papers, no citations, publication-centric)
- [ ] **RANKING-03**: Topic page Top scholars chip row (7 faculty chips, eligibility-carved, no authorship-position filter)
- [ ] **HOME-02**: Selected research subtopic carousel (8 subtopics, weekly refresh, scroll-snap)
- [ ] **HOME-03**: Browse all research areas topic grid (67 parent topics + counts, 4-column)
- [ ] **TOPIC-01**: Topic detail page at `/topics/{slug}` with hero, top scholars row, recent highlights, layout B (subtopic rail + publication feed)
- [ ] **TOPIC-02**: Topic publication feed sorts (Newest default, Most cited, By impact, Curated by ReCiterAI) with "Curated" tag when AI sort active
- [ ] **DEPT-01**: Department detail page at `/departments/{slug}` with chair card, top research areas, divisions rail, role chip row
- [ ] **DEPT-02**: Division URL pre-selection (division URL → parent department page with division pre-selected)
- [ ] **BROWSE-01**: Browse hub page at `/browse` with departments grid, centers & institutes grid, A-Z directory
- [ ] **ABOUT-01**: About / methodology page at `/about` explaining ranking formulas, eligibility carves, refresh cadence, role model — must exist before launch
- [ ] **SEO-01**: `sitemap.xml` enumerating all canonical slug URLs of active scholars
- [ ] **SEO-02**: `robots.txt` allowing public pages, disallowing internal/authenticated paths
- [ ] **SEO-03**: Per-page `<title>`, `<meta description>`, `<link rel="canonical">` auto-generated across all page types
- [ ] **SEO-04**: VIVO URL pattern audit and bulk 301 mapping (active scholars → canonical slug; departed → `/search?q=<name>`)
- [ ] **ANALYTICS-01**: Page views per profile per day instrumented
- [ ] **ANALYTICS-02**: Search query logging (raw text, result count, result-set type, filters applied, CTR by position)
- [ ] **ANALYTICS-03**: Profile completeness metric (% meeting completeness threshold, weighted by faculty seniority, weekly)
- [ ] **ANALYTICS-04**: Redirect 404 rate telemetry for incoming legacy VIVO URLs
- [ ] **DOCS-01**: `openapi.yaml` artifact covering all `/api/*` read endpoints
- [ ] **DOCS-02**: `docs/ADR-001-runtime-dal-vs-etl-transform.md` (the deferred Q6 ADR documenting DAL = ETL transform)
- [ ] **AUTH-01**: SAML wiring with WCM IdP federation (NextAuth credentials provider stub for local dev)
- [ ] **AUTH-02**: Authenticated owner can edit own overview via WYSIWYG; cannot edit others
- [ ] **AUTH-03**: Admin role can paste overview on faculty member's behalf and exercise suppress action
- [ ] **EDIT-01**: `/api/edit` writes MySQL → fires `revalidatePath` → upserts OpenSearch atomically; public profile reflects edit within seconds
- [ ] **EDIT-02**: WYSIWYG enforces ~3,000 char / ~450 word limit with live counter and limited formatting allowlist
- [ ] **EDIT-03**: "What's missing" checklist wired up for authenticated owners on own profile
- [ ] **EDIT-04**: Every save logged to monitoring channel (target TBD — Slack / email digest)
- [ ] **EDIT-05**: Self-edit completion rate analytics (% of authenticated owners saving ≥1 overview edit, weekly)
- [ ] **HEALTH-02**: `/api/health/refresh-status` admin SAML auth gate fully wired (replaces Phase 4 401 stub)
- [ ] **DOCS-03**: `openapi.yaml` extended to cover write endpoints once self-edit lands

### Out of Scope

<!-- Explicit boundaries with reasoning. -->

- Production AWS infrastructure (Aurora MySQL on RDS, Fargate, OpenSearch Service managed, CloudFront, EventBridge + Lambda for ETL, Route 53, ACM, ElastiCache Redis) — owned by Mohammad's team; this milestone hands off the prototype as reference implementation.
- CAB / AAC approval artifacts and production security review — owned by Mohammad's team.
- Data privacy / FERPA / HIPAA review for COI display — Mohammad's team's lane.
- Schema.org `Person` JSON-LD — deferred to Phase 2 until refresh pipeline runs cleanly for 4–6 weeks post-launch.
- Doctoral student profile inclusion criterion — Phase 2+ extension; ED has the signal but Phase 1 ships faculty-only.
- Abstract full-text search — explicitly out of scope per functional spec; abstracts not indexed in Phase 1.
- Saved searches, advanced search builder UI, cross-result-type relevance blending, subject-area filter on publications — Phase 2+.
- Embeddings-based hybrid retrieval (BM25 + dense biomedical embedding) — Phase 2; ReCiter-lead consultation on biomedical embedding model selection is a hard prerequisite.
- Leaf-level role filter (Voluntary as separate checkbox) — Phase 2 candidate; Phase 1 ships flat 5-category checkboxes.
- Division detail pages — Phase 2; Phase 1 surfaces division information through department detail page rail.
- Center / institute detail pages — Phase 2; Phase 1 ships thin placeholder route at `/centers/{slug}` so browse-hub links don't break.
- Delegate / proxy editing by assistants, DAs, DivAs — Phase 3 per functional spec; Phase 1 ships owner-only editing plus admin paste-on-behalf.
- Editing of structured data sourced from authoritative systems — out of scope entirely; sources stay read-only.
- Preview / staging / approval workflow / multi-version history / suppress own profile (self-edit) — out of scope.
- Clinical trials, CV/biosketch export, achievement badges, altmetric badges, news mentions, activity stream, network/geographic/timeline visualizations, honors & awards, abstracts on profile, "highly influenced" articles, scholar-curated featured pubs — out of scope per design-spec carve-outs.
- Charter-promised "AWS-native, microservices architecture" as immediate constraint — superseded by ADR-001 (provisional single Next.js deploy for prototype; production topology deferred to Mohammad's design kickoff).
- Service-desk ticketing target on Support page (ServiceNow form vs email) — open item; resolved before launch by stakeholder, not by this build.

## Context

**Current state (as of 2026-04-30):** working local prototype at `~/Dropbox/GitHub/Scholars-Profile-System/`, public repo `wcmc-its/Scholars-Profile-System`. Phase 0–4 of the BUILD-PLAN are SHIPPED end-to-end against real WCM data. 8,943 active faculty rendered. All six source systems wired and producing real data. ETL chain runs cleanly with abort cascade. Search and profile rendering both live.

**Stack:** Next.js 15 App Router + TypeScript strict, MySQL 8 (Docker locally → Aurora MySQL in production), OpenSearch 2.x (Docker locally → OpenSearch Service in production), Prisma 7 with `@prisma/adapter-mariadb` driver adapter, Tailwind 4 + shadcn/ui, Vitest + Playwright, GitHub Actions CI.

**Audience for the prototype:** Mahender, Mohammad's team, AAC, CAB. Use to react to architectural decisions before production build kickoff, validate UX / feature-scope / coverage assumptions, and borrow code / schemas / ETL queries (or skip everything and start fresh — handoff lane is reference implementation, not contractual).

**Open stakeholder items (carry forward):**
- Confirm ED `preferred_name` field as slug source (currently using `givenName + sn`)
- AOI threshold + 6× search boost calibration against real search behavior
- Publication ranking weight calibration against ~20 real WCM profiles spanning seniority
- Citation refresh cadence in reciterdb-prod (spec target ≥ weekly)
- Edit-event logging target (Slack? email digest?)
- Specific completeness threshold for "being populated" affordance and default-search filtering
- Methodology page owner naming (circulation blocker per design spec v1.2 changelog)
- ReCiter lead consultation on text relevance algorithm (target 2 weeks before search-build kickoff)
- Editorial copy ownership for top-300 division/subtopic descriptions (ITS + editor seconded from Comms / contractor; two-week window for May 2026)
- COI office conversation: integration pattern, refresh cadence, category vocabulary

**Conversations in flight:** four active (data team for `appointment_status_updated_at`; ReCiter lead; editorial copy; COI office) per design spec v1.7.1.

**Key prior-art lessons from Milestone 1:**
- Prisma 7 broke embedded engine; `@prisma/adapter-mariadb` works for both MySQL 8 and Aurora MariaDB
- ReciterDB `personIdentifier` is plain CWID, no `cwid_` prefix (DynamoDB-only convention)
- COI is MySQL not MSSQL (hostname pattern `*-mysql-db.*`)
- InfoEd full institutional grant query is a 30-table cross-DB join running ~6 minutes; `requestTimeout` ≥ 10 minutes locally, batch/cache/materialized-view in production
- Several password formats required unwinding (K8s Secret YAML base64, `$` triggering shell expansion); production uses AWS Secrets Manager / SSM Parameter Store
- Single-quote env values containing `$`, `` ` ``, `!`, or `\` in `~/.zshenv`

**Spec-precedence stack (project-internal):** ADR > SPEC (design spec v1.7.1 wins on UI/UX over functional spec) > PRD (charter intentionally downplayed) > DOC. ADR-006 explicitly departs from spec verbatim language; this is a deliberate, documented exception.

## Constraints

- **Tech stack**: Next.js 15 App Router + TypeScript strict, Node 22+, MySQL 8 / Aurora MySQL, OpenSearch 2.x, Prisma 7 with `@prisma/adapter-mariadb`, Tailwind 4 + shadcn/ui — locked by ADR-001 (provisional), ADR-006 (LOCKED runtime), ADR-007 (LOCKED), ADR-008 (LOCKED) and HANDOFF
- **Schema**: CWID is primary key on `scholar`; all FKs reference `scholar.cwid` directly; `scholar.deleted_at TIMESTAMP NULL` indexed; `cwid_aliases` and `slug_history` are URL-resolution tables (alias-as-redirect, not alias-as-join-resolver) — locked by ADR-002, ADR-003, ADR-004
- **API contract**: API URLs are CWID-keyed (`/api/scholars/:cwid`); browser-facing search proxies through `/api/search`; `openapi.yaml` is the durable artifact regardless of deployment topology — locked by ADR-001 (artifact requirement) and ADR-007
- **Runtime data store**: Scholars application reads only MySQL at runtime; no runtime DynamoDB read path; ReCiterAI consumed via minimal-projection ETL (`publication_score` + `topic_assignments` only) — locked by ADR-006
- **Render strategy**: Profile pages are ISR with on-demand revalidation; search and directory pages are CSR via `/api/search`; the `/api/edit` self-edit pipeline atomically writes MySQL + revalidates path + upserts OpenSearch — locked by ADR-008
- **Refresh cadence**: Daily refresh for ED, ASMS, InfoEd, ReCiter, COI (with ED-first abort cascade); weekly cadence for ReCiterAI scores and topic assignments; self-edits bypass and write through immediately — locked by ADR-005
- **Source systems consumed read-only**: No write-back, no functional duplication of upstream systems — charter constraint
- **Mobile-responsive**: All Phase 1 pages must render usably on phones (single-column collapse on profile and search results) — locked by functional spec line 270
- **Pagination**: Numbered, 20 per page (locked by functional spec line 197); design spec adds rendering pattern (≤6 pages numbered prev/next; ≥7 pages ellipsis pattern)
- **Search per-field boosts**: Name 10× / AOI 6× / Title 4× / Department 3× / Overview 2× / Pub titles 1× / MeSH 0.5× — locked by functional spec line 156
- **Authorship weighting**: First/last ×1.0 / second/penultimate ×0.4 / middle ×0.1 — locked by functional spec lines 165–171
- **Minimum-evidence threshold**: A topical term contributes to a scholar's index only if (a) it appears in ≥2 of their publications OR (b) it appears in ≥1 first/last-author publication — locked by functional spec line 173
- **Algorithmic-surface guidelines**: Rule visible on page in plain English; "How this works" / methodology link points to a real page (must exist before launch); citation counts NOT displayed on "recent" surfaces — locked by design spec v1.7.1
- **Letters / Editorials / Errata**: Hard-excluded (weight = 0) from highlight surfaces — locked by design spec v1.7.1
- **Publication ranking**: Multiplicative formula (Variant B), surface-keyed recency curves; scholar-attributed surfaces (profile Selected highlights, home Recent contributions) restricted to first-or-senior author; publication-centric surfaces (Topic Recent highlights, Top scholars chip row) do NOT apply this filter — locked by design spec v1.7.1
- **Algorithmic-surface eligibility carve**: Recent contributions, Top scholars in this area restricted to Full-time faculty + Postdoc + Fellow + Doctoral student — locked by design spec v1.7.1 role model
- **Codes are stable join keys**: Always join on `weillCornellEduOrgUnitCode`, `weillCornellEduDepartmentCode`, `weillCornellEduProgramCode`; never on display names — locked by design spec v1.7.1
- **Schema-change protocol**: 30-day advance notice from upstream + contract tests in CI validating expected response shapes — locked by design spec v1.7.1
- **Component-render logging**: Application emits component-render logs for every profile rendered (which rendered, which absent-by-default, which absent-because-data-missing); operational debugging surface, not user-facing in Phase 1 — locked by design spec v1.7.1
- **Status pill, AOI pills, External relationships, Mentor/Advisor card, Clinical profile link**: All use absence-as-default pattern — locked by design spec v1.7.1
- **Citation format**: Phase 1 supports Vancouver and BibTeX only; AMA, APA, RIS deferred to Phase 2 — locked by design spec v1.7.1
- **Design tokens**: Cornell Big Red (`#B31B1B`) reserved for high-prominence moments; Slate (`#2c4f6e`) is working accent for everything else; CSS variable structure stays even when WCM brand standards land — locked by design spec v1.7.1
- **Typography**: Inter for body / UI / lists; Charter (with Tiempos / Georgia fallback) for brand mark, page H1s, hero titles — locked by design spec v1.7.1
- **Header**: Full-bleed Cornell red band, sticky, 60px tall — locked by design spec v1.7.1
- **Brand mark**: Two-line typographic lockup, no square monogram, no W icon — locked by design spec v1.7.1
- **Public repo discipline**: Code committed to public `wcmc-its/Scholars-Profile-System`; real data, credentials, and identifiers stay local; `.gitignore` `.env*`, `data/`, `*.dump`, `*.sql.gz`; pre-commit hook scanning for CWID-shaped strings — locked by BUILD-PLAN
- **Credentials**: Live in `~/.zshenv` (not `.zshrc`) so they propagate to non-interactive shells; project-namespaced as `SCHOLARS_*`; never commit `.env` files; never hardcode credentials; production uses AWS Secrets Manager / SSM Parameter Store
- **No AI attribution**: In commits, code comments, or PR text — author the work as the user (BUILD-PLAN working agreement; reinforces global guideline)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| **ADR-001** — API architecture: single Next.js deploy + `/api/*` routes (PROVISIONAL) | Charter promises "reusable Scholar API" but only one near-term consumer (Scholars site itself); single-deploy satisfies contract without standing up second service. Mohammad's preliminary lean is separate API service in production; deferred to his design kickoff. Implementation discipline: route handlers as pure functions in `lib/api/*` so lift-to-standalone is copy-paste. | — Pending (provisional; Mohammad's design kickoff resolves) |
| **ADR-002** — Identity: CWID-canonical with `cwid_aliases` (LOCKED) | CWID is the institution's stable identifier; aliases handle ED `replacement_cwid` edge cases. Alias-as-redirect, not alias-as-join-resolver: daily ETL performs FK rewrite, aliases table is for URL redirect / historical lookup only. | ✓ Good (shipped, working at 8,943 active faculty) |
| **ADR-003** — URL strategy: slug-primary HTML, CWID-keyed API (LOCKED) | Slugs are presentation; CWID is contract. `slug_history` handles name changes via 301; `/scholars/by-cwid/:cwid` is the CWID-anchored fallback. Sitemap lists canonical slug URLs only. | ✓ Good (shipped, slug-history 301 chain working) |
| **ADR-004** — Departed faculty: strict delete + 60-day soft-delete retention (LOCKED) | Active academic appointment in ED is the inclusion criterion; loss flips `deleted_at`, returns 410 Gone, removes from sitemap, removes from OpenSearch. No tombstone UX, no memorial banner. VIVO URLs for departed → 301 to `/search?q=<name>` (contextually relevant, never soft-404). | ✓ Good (shipped, 60-day cleanup job in place) |
| **ADR-005** — Daily refresh failure modes: per-source independent + ED-first abort cascade (LOCKED) | Each upstream source runs its own daily ETL, commits independently. ED failure aborts the chain (the appointment-loss check that triggers `deleted_at` runs only against successful ED refreshes). Per-source `last_successful_refresh_at` + `/api/health/refresh-status` admin endpoint + CloudWatch alarm at >26h. No user-visible staleness signals. | ✓ Good (shipped, abort cascade working in orchestrator) |
| **ADR-006** — DynamoDB integration: minimal-projection ETL into MySQL (LOCKED) | Runtime reads only MySQL — no runtime DynamoDB read path. Two fields flow (`publication_score`, `topic_assignments`) via separate Lambda triggered by ReCiterAI weekly run. Operational simplicity, simpler local dev, contract tests run against MySQL with no DynamoDB credentials in CI. Explicit departure from spec language; documented in pending Q6 ADR (DOCS-02). | ✓ Good (shipped); DOCS-02 pending |
| **ADR-007** — Search engine: OpenSearch (LOCKED, embeddings deferred to Phase 2) | Algolia rejected (data-residency at AMC); pgvector rejected (`tsvector setweight()` only 4 levels, spec needs 7); Typesense / Meilisearch rejected (no AWS-managed); Elasticsearch rejected (SSPL). OpenSearch's k-NN plugin sits dormant until Phase 2. Browser proxies through `/api/search`. | ✓ Good (shipped, BM25 + per-field boost + authorship weighting + faculty-status boost) |
| **ADR-008** — Render strategy: ISR with on-demand revalidation; CSR for search (LOCKED) | Profile pages cached, revalidated on TTL or self-edit webhook. The `/api/edit` pipeline (MySQL + revalidatePath + OpenSearch upsert) unifies ADR-001, ADR-004, ADR-007, ADR-008. CDN: Next.js cache + CloudFront in production. | ✓ Good (ISR shipped); self-edit pipeline pending Phase 7 |
| **ADR-009** — Headshot integration: mirror ReCiter-Publication-Manager pattern (LOCKED 2026-04-30) | Endpoint syntax `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false`; scholar API includes `identityImageEndpoint` field; 404 handled server-side (empty string); browser falls back to local generic-headshot asset; no server-side proxy / ETL pre-fetch / caching layer in Phase 1. Future: optional `/api/headshot/:cwid` proxy if perf or availability becomes an issue post-launch. | — Pending (Active scope this milestone) |
| **REQ-publications-ranking variant resolution** — Variant B (multiplicative, surface-keyed recency curves) | Functional spec arithmetic superseded by design spec v1.7.1 multiplicative formula; resolved 2026-04-30 by user. Hard-excludes letters / editorials / errata; scholar-attributed surfaces apply first-or-senior author filter, publication-centric surfaces do not. | — Pending (profile shipped per Variant B; new algorithmic surfaces in Active scope) |

---
*Last updated: 2026-04-30 after Milestone 1 (BUILD-PLAN Phases 0–4) shipped and Milestone 2 scope captured from intel + ADDENDUM*
