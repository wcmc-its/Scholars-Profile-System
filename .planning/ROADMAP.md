# Roadmap: Scholars Profile System

## Overview

The Scholars Profile System replaces VIVO with a modern, AWS-native scholar profile platform at `scholars.weill.cornell.edu`. Milestone 1 (BUILD-PLAN Phases 0–4) shipped a working local prototype: 8,943 active WCM faculty rendered against real data from six source systems, search with per-field boost weights and authorship weighting, slug-primary URLs with CWID-canonical identity, soft-delete with 60-day retention, and the daily ETL chain with ED-first abort cascade. Milestone 2 takes the prototype to public-launch readiness: headshot integration, the four design-spec page types not yet enumerated in the functional spec (Topic detail, Department detail, Browse hub, About / methodology), the algorithmic surfaces locked under design spec v1.7.1 (home Recent contributions, topic Recent highlights, Top scholars chip row), SEO + URL machinery (sitemap, robots, VIVO 301 bulk audit), analytics + OpenAPI artifact + the deferred Q6 ADR, and authenticated self-edit with SAML.

## Milestones

- ✅ **Milestone 1 — Working prototype** - BUILD-PLAN Phases 0–4 (shipped 2026-04-30)
- 🚧 **Milestone 2 — Public-launch readiness** - Phases 1–7 below (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED) via `/gsd-insert-phase`

Phases below are Milestone 2 phases, numbered 1–7 within this milestone.

- [ ] **Phase 1: Headshot integration** - Mirror PubMan pattern across all six surfaces
- [ ] **Phase 2: Algorithmic surfaces and home composition** - Recent contributions, Top scholars row, Topic Recent highlights; Selected research carousel; Browse all research areas grid
- [ ] **Phase 3: Topic and Department detail pages** - `/topics/{slug}` and `/departments/{slug}` with rail + main layouts
- [ ] **Phase 4: Browse hub and About / methodology** - `/browse` directory and `/about` (launch-blocker methodology page)
- [ ] **Phase 5: SEO and URL machinery** - sitemap.xml, robots.txt, canonical tags, VIVO 301 bulk mapping
- [ ] **Phase 6: Polish, analytics, documentation** - Page views, search logging, profile completeness, OpenAPI artifact, Q6 ADR
- [ ] **Phase 7: Self-edit and authentication** - SAML wiring, `/api/edit`, WYSIWYG, "What's missing" checklist, edit logging, admin role

## Phase Details

<details>
<summary>✅ Milestone 1 — Working prototype (BUILD-PLAN Phases 0–4) — SHIPPED 2026-04-30</summary>

### BUILD-PLAN Phase 0: Foundation
**Goal**: Repo cloned, dev environment runs, hello-world page renders
**Status**: SHIPPED

### BUILD-PLAN Phase 1: Schema and identity layer
**Goal**: Prisma schema reflects all decisions; identity layer (CWID, aliases, slug, slug_history) works end-to-end with synthetic data
**Requirements covered**: IDENTITY-01, IDENTITY-02, IDENTITY-03, IDENTITY-04
**Status**: SHIPPED

### BUILD-PLAN Phase 2: Profile rendering
**Goal**: Profile pages render to spec, ISR works, mobile responsive
**Requirements covered**: PROFILE-01, PROFILE-02, PROFILE-04, PROFILE-05, HOME-01 (initial composition), RENDER-01 (ISR portion), RESPONSIVE-01
**Status**: SHIPPED

### BUILD-PLAN Phase 3: Search
**Goal**: OpenSearch wired, per-field boosting, autocomplete
**Requirements covered**: SEARCH-01, SEARCH-02, SEARCH-03, SEARCH-04, SEARCH-05, RENDER-01 (CSR portion)
**Status**: SHIPPED

### BUILD-PLAN Phase 4: ETL pipelines
**Goal**: Real data flows from all six source systems into local MySQL via runnable orchestrator
**Requirements covered**: ETL-01 through ETL-10, LIFECYCLE-01, LIFECYCLE-02, LIFECYCLE-03, HEALTH-01, PROFILE-03 (ranking data feed)
**Status**: SHIPPED

</details>

### 🚧 Milestone 2 — Public-launch readiness (In Progress)

**Milestone Goal:** Take the prototype to public-launch-ready state. Add the surfaces design spec v1.7.1 enumerated but functional spec didn't (four new page types + algorithmic surfaces), wire SEO machinery for VIVO migration, instrument analytics, write the binding documentation artifacts (OpenAPI, Q6 ADR), and ship authenticated self-edit so faculty can author their own overview. Methodology page is the launch blocker — every algorithmic surface links to it and a dead link is the most credibility-damaging element on those pages.

### Phase 1: Headshot integration
**Goal**: Faculty headshots render on every surface that displays a scholar, sourced from WCM directory via the syntax-template pattern proven in ReCiter-Publication-Manager.
**Depends on**: Milestone 1 (CWID resolution, scholar API, all six rendering surfaces already exist)
**Requirements**: HEADSHOT-01, HEADSHOT-02
**Success Criteria** (what must be TRUE):
  1. A user viewing any profile page sees the scholar's WCM directory headshot in the sidebar (large) — or a generic-headshot placeholder when the directory returns 404
  2. A user viewing a search result row sees a small headshot next to the scholar's name and primary title
  3. A user viewing the home page sees headshots in every Recent contributions card and every Top scholars chip on a topic page
  4. The scholar API response (`/api/scholars/:cwid`) includes an `identityImageEndpoint` string field for every scholar, empty when the directory returns 404
  5. No server-side proxy or ETL pre-fetch exists in this phase — the browser hits `directory.weill.cornell.edu` directly
**Plans**: 4 plans
- [x] 01-01-PLAN.md — Wave 0: RED test skeletons + shared scholar fixture
- [x] 01-02-PLAN.md — Wave 1: lib/headshot.ts, initials extraction, HeadshotAvatar component, next.config.ts remotePatterns, surface mounts at profile sidebar + search row
- [x] 01-03-PLAN.md — Wave 2: identityImageEndpoint field on ScholarPayload, ProfilePayload, PeopleHit (three serializers)
- [x] 01-04-PLAN.md — Wave 3: full-suite gate + security/scope grep guards + human visual verification
**UI hint**: yes

### Phase 2: Algorithmic surfaces and home composition
**Goal**: Complete the Variant B publication-ranking buildout by shipping the three new algorithmic surfaces (home Recent contributions, topic Recent highlights, topic Top scholars chip row) and the design-spec v1.7.1 home page composition (Selected research carousel + Browse all research areas grid), all linked to the future methodology page.
**Depends on**: Phase 1 (Recent contributions cards, Top scholars chips both render headshots)
**Requirements**: RANKING-01, RANKING-02, RANKING-03, HOME-02, HOME-03
**Success Criteria** (what must be TRUE):
  1. A user visiting the home page sees a 3×2 grid of 6 scholar cards under "Recent contributions" — each shows headshot, name, title, contribution paper title, journal · year · authorship role; no citation counts; only Full-time faculty / Postdoc / Fellow / Doctoral students appear; first/senior-author papers only
  2. A user visiting the home page sees a horizontal scroll-snap carousel of 8 subtopic cards under "Selected research" with the visible plain-English rule "Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly" and a methodology link
  3. A user visiting the home page sees 67 parent topic names with counts in a 4-column grid under "Browse all research areas"
  4. A user visiting any topic page sees a 7-faculty chip row under "Top scholars in this area" (Full-time-faculty-only carve; per-scholar aggregation sums first-or-senior papers only; compressed recency curve per Phase 2 D-14; methodology link visible)
  5. A user visiting any topic page sees 3 paper cards under "Recent highlights" with no citation counts and a methodology link
**Plans**: 9 plans
- [x] 02-01-PLAN.md — Wave 0: Design tokens port + shadcn primitives (scroll-area, skeleton)
- [x] 02-02-PLAN.md — Wave 0: DynamoDB taxonomy probe + locked schema decision (D-02)
- [x] 02-03-PLAN.md — Wave 0: scholar.role_category Prisma migration + ED ETL extension (FTE + ou=students PHD branch) + search-index ETL fix + lib/eligibility.ts
- [x] 02-04-PLAN.md — Wave 1 (TDD): Variant B ranking rewrite + worked-example fixtures + profile retrofit (D-06/07/08/13/14/16)
- [x] 02-05-PLAN.md — Wave 2: Topic Prisma schema + DynamoDB taxonomy ETL extension + D-08 verification
- [x] 02-06-PLAN.md — Wave 3: methodology-anchors constants + /about/methodology page (D-04/14/15/16) + /about stub + e2e
- [x] 02-07-PLAN.md — Wave 3: lib/api/home.ts + 5 home components + app/page.tsx replacement (RANKING-01, HOME-02, HOME-03)
- [x] 02-08-PLAN.md — Wave 3: lib/api/topics.ts + 4 topic components + /topics/{slug} placeholder (RANKING-02, RANKING-03 with D-13/D-14)
- [x] 02-09-PLAN.md — Wave 4: /api/revalidate route + ETL revalidation hook + full e2e gate + visual checkpoint
**UI hint**: yes

### Phase 3: Topic and Department detail pages
**Goal**: Launch the two heavyweight new page types from design spec v1.7.1 — Topic detail (`/topics/{slug}`) and Department detail (`/departments/{slug}`) — that share the rail + main layout pattern and consume Phase 2's algorithmic surfaces.
**Depends on**: Phase 2 (Top scholars row and Recent highlights are sub-components of Topic detail; Department faculty grid uses the same headshot pattern)
**Requirements**: TOPIC-01, TOPIC-02, DEPT-01, DEPT-02
**Success Criteria** (what must be TRUE):
  1. A user visiting `/topics/{slug}` sees a hero with topic name and description, the 7-chip Top scholars row, a "View all N scholars in this area →" affordance, the 3-paper Recent highlights, and Layout B (subtopic rail sorted by pub count desc with "Less common" divider for n≤10 + main publication feed)
  2. A user on a topic page can switch publication-feed sort between Newest (default), Most cited, By impact, and Curated by ReCiterAI; a "Curated" tag appears next to the section title only when AI sort is active
  3. A user visiting `/departments/{slug}` sees a chair card (photo + endowed-chair title + role + name linking to the chair's profile), top research areas pill row, stats line, divisions rail, role chip row defaulting to "All", and person rows
  4. A user landing on a division URL is redirected to the parent department page with the corresponding division pre-selected in the rail
  5. Department faculty rows render headshots via the Phase 1 pattern; eligibility carve applies to faculty grid display
**Plans**: TBD
**UI hint**: yes

### Phase 4: Browse hub and About / methodology
**Goal**: Ship the two remaining new page types — Browse hub (`/browse`) as the directory navigation entry point and About (`/about`) as the launch-blocker methodology page that every algorithmic surface from Phase 2 already links to.
**Depends on**: Phase 3 (browse hub links to department detail and topic detail pages; methodology page describes the algorithmic surfaces shipped in Phase 2)
**Requirements**: BROWSE-01, ABOUT-01
**Success Criteria** (what must be TRUE):
  1. A user visiting `/browse` sees three sections: a 3-column departments grid (29 WCM departments — name + scholar count + chair name), a 2-column centers & institutes grid (name + scope sentence + director + scholar count), and an A-Z directory (flat letter strip; clicking a letter expands to a 2-col list capped at 10 with "view all in {letter}" link)
  2. A user clicking "How this works" / methodology from any algorithmic surface (home Recent contributions, home Selected research, topic Recent highlights, topic Top scholars) lands on `/about` and reads a plain-English explanation of scoring scope, eligibility carves, weekly cadence, the highlight selection formula, recency curves, the authorship-position filter, and the letter / editorial / erratum exclusion
  3. The About page exists in production before any algorithmic surface ships externally — no dead methodology links
  4. A user visiting `/browse` can cross-link to research areas via a small link in the anchor strip
**Plans**: TBD
**UI hint**: yes

### Phase 5: SEO and URL machinery
**Goal**: Wire production-quality SEO so Google indexes the new site and the VIVO migration preserves inbound links — sitemap, robots, canonical tags, and the bulk VIVO 301 mapping that the URL middleware (already shipped) is waiting to consume.
**Depends on**: Phase 4 (all seven page types now exist and need canonical tags + sitemap inclusion)
**Requirements**: SEO-01, SEO-02, SEO-03, SEO-04
**Success Criteria** (what must be TRUE):
  1. A request to `/sitemap.xml` returns valid XML enumerating every active scholar by canonical slug URL; sitemap refreshes after each daily ETL completion
  2. A request to `/robots.txt` returns valid robots directives allowing public pages and disallowing internal / authenticated paths
  3. Every page type (profile, search, topic detail, department detail, browse hub, about, home) emits correct `<title>`, `<meta description>`, and `<link rel="canonical">` tags
  4. A request to any documented legacy VIVO URL produces a 301 to either the current canonical Scholars slug URL (active scholars) or `/search?q=<name-extracted-from-vivo-url-slug>` (deleted scholars) — never a soft-404
  5. Post-launch redirect 404 telemetry shows the failure rate within an acceptable bound during the first weeks
**Plans**: TBD
**UI hint**: yes

### Phase 6: Polish, analytics, documentation
**Goal**: Instrument the analytics signals the functional spec calls for, write the durable documentation artifacts (`openapi.yaml` for the API contract, the Q6 ADR for the runtime-DAL-vs-ETL-transform decision), and polish the read-side demo for Mahender / Mohammad / AAC / CAB consumption.
**Depends on**: Phase 5 (SEO machinery in place to measure redirect 404 rate; all read endpoints stable for OpenAPI spec)
**Requirements**: ANALYTICS-01, ANALYTICS-02, ANALYTICS-03, ANALYTICS-04, DOCS-01, DOCS-02
**Success Criteria** (what must be TRUE):
  1. Page-view, search-query, search-CTR-by-position, and redirect-404-rate signals are captured in a structured-log pipeline (tooling target stays per spec open item — structured logs feed whatever is chosen)
  2. The profile completeness metric reports weekly (% of profiles meeting threshold, weighted by faculty seniority) and triggers escalation if <70% sustained
  3. `openapi.yaml` exists in the repo, documents all `/api/*` read endpoints (`/api/scholars/:cwid`, `/api/search`, `/api/health/refresh-status`), and validates against an OpenAPI parser
  4. `docs/ADR-001-runtime-dal-vs-etl-transform.md` exists and explains the deliberate departure from spec verbatim language that ADR-006 codified
  5. A Mahender / Mohammad walkthrough of the read side and ETL completes against the published artifacts without ad-hoc explanation needed
**Plans**: TBD
**UI hint**: no

### Phase 7: Self-edit and authentication
**Goal**: Close the loop on the unifying self-edit pipeline (ADR-001 / ADR-007 / ADR-008) so authenticated faculty can write their own overview and admins can paste on behalf or suppress, with edit events logged and the existing `/api/health/refresh-status` 401 stub replaced with a real SAML auth gate.
**Depends on**: Phase 6 (`openapi.yaml` extends to write endpoints; analytics infrastructure captures self-edit completion rate)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04, EDIT-01, EDIT-02, EDIT-03, EDIT-04, EDIT-05, DOCS-03
**Success Criteria** (what must be TRUE):
  1. An authenticated faculty member visiting their own profile sees an inline edit affordance on the overview section; visiting any other profile shows no edit affordance
  2. An authenticated owner clicking edit gets a WYSIWYG with a live ~3,000 char / ~450 word counter; allowed formatting is bold, italic, paragraph breaks, lists, and links — headings and images are not selectable
  3. An owner saving an overview edit sees the public profile reflect the change within seconds (atomic MySQL write + `revalidatePath` + OpenSearch upsert all fire from `/api/edit`)
  4. The "What's missing" checklist (stubbed in BUILD-PLAN Phase 2) renders for authenticated owners on their own profile and lists missing structured fields in plain English
  5. An admin can paste overview text on a faculty member's behalf and exercise the suppress action (sets `deleted_at` regardless of appointment status, same 60-day window); every save is logged to the chosen monitoring channel; `/api/health/refresh-status` returns scholar-data on admin SAML auth (no longer a 401 stub)
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| BUILD-PLAN 0. Foundation | Milestone 1 | — | Complete | 2026-04-30 |
| BUILD-PLAN 1. Schema and identity layer | Milestone 1 | — | Complete | 2026-04-30 |
| BUILD-PLAN 2. Profile rendering | Milestone 1 | — | Complete | 2026-04-30 |
| BUILD-PLAN 3. Search | Milestone 1 | — | Complete | 2026-04-30 |
| BUILD-PLAN 4. ETL pipelines | Milestone 1 | — | Complete | 2026-04-30 |
| 1. Headshot integration | Milestone 2 | 0/4 | Not started | - |
| 2. Algorithmic surfaces and home composition | Milestone 2 | 0/9 | Not started | - |
| 3. Topic and Department detail pages | Milestone 2 | 0/TBD | Not started | - |
| 4. Browse hub and About / methodology | Milestone 2 | 0/TBD | Not started | - |
| 5. SEO and URL machinery | Milestone 2 | 0/TBD | Not started | - |
| 6. Polish, analytics, documentation | Milestone 2 | 0/TBD | Not started | - |
| 7. Self-edit and authentication | Milestone 2 | 0/TBD | Not started | - |
