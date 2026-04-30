# Requirements: Scholars Profile System

**Defined:** 2026-04-30
**Core Value:** WCM faculty profiles, search, and algorithmic surfaces serve as a usable VIVO replacement for the WCM scholar community — and Mohammad's production team can consume the prototype as reference implementation for the AWS-native production build.

## Milestone 1 (Validated — SHIPPED)

Requirements that shipped in BUILD-PLAN Phases 0–4 per HANDOFF-2026-04-30. Locked.

### Profile

- ✓ **PROFILE-01**: Profile pages render header, overview, contact, appointments, education, areas of interest, publications, grants, disclosures (BUILD-PLAN Phase 2)
- ✓ **PROFILE-02**: Sidebar two-column layout with sticky positioning, action buttons (Copy citations, Print), status pill (absence-as-default) (BUILD-PLAN Phase 2)
- ✓ **PROFILE-03**: Publication ranking on profile (Variant B multiplicative formula, Selected highlights top 3 + year-grouped feed; letters / editorials / errata hard-excluded) (BUILD-PLAN Phases 2–4)
- ✓ **PROFILE-04**: WCM coauthor chips, large author list truncation (Vancouver-style, first 3 + ellipsis + last 2, with self-highlight) (BUILD-PLAN Phase 2)
- ✓ **PROFILE-05**: Empty-state and sparse-profile graceful degradation (hide section if zero items; "being populated" affordance when overview AND <3 publications AND no active grants) (BUILD-PLAN Phase 2)

### Search

- ✓ **SEARCH-01**: OpenSearch-backed people + publications indices with per-field boost (Name 10× / AOI 6× / Title 4× / Dept 3× / Overview 2× / Pub titles 1× / MeSH 0.5×) (BUILD-PLAN Phase 3)
- ✓ **SEARCH-02**: Authorship-weighted contributions at index time via term repetition (×1.0 first/last, ×0.4 second/penultimate, ×0.1 middle) (BUILD-PLAN Phase 3)
- ✓ **SEARCH-03**: Minimum-evidence threshold for topical-term inclusion (≥2 pubs OR ≥1 first/last-author pub) (BUILD-PLAN Phase 3)
- ✓ **SEARCH-04**: People/Publications tabs with faceted filters, autocomplete on 2 chars, numbered pagination 20/page with ellipsis pattern for ≥7 pages (BUILD-PLAN Phase 3)
- ✓ **SEARCH-05**: `/api/search` proxy keeps OpenSearch credentials server-side (BUILD-PLAN Phase 3)

### Identity & URLs

- ✓ **IDENTITY-01**: CWID-canonical primary key with `cwid_aliases` table sourced from ED `replacement_cwid` (BUILD-PLAN Phase 1)
- ✓ **IDENTITY-02**: Slug-primary HTML URLs with collision suffixing in CWID-creation order and `slug_history` 301 redirects on name change (BUILD-PLAN Phase 1)
- ✓ **IDENTITY-03**: CWID-keyed API URLs (`/api/scholars/:cwid`) and `/scholars/by-cwid/:cwid` 301 fallback to current canonical slug (BUILD-PLAN Phase 1)
- ✓ **IDENTITY-04**: URL middleware resolves `slug → slug_history → cwid_aliases → 404` (BUILD-PLAN Phase 1)

### Lifecycle

- ✓ **LIFECYCLE-01**: Strict delete on appointment loss with 60-day soft-delete retention (`scholar.deleted_at TIMESTAMP NULL` indexed) (BUILD-PLAN Phase 4)
- ✓ **LIFECYCLE-02**: All public read paths filter `WHERE deleted_at IS NULL`; nightly hard-delete cleanup job (`WHERE deleted_at < now() - INTERVAL 60 DAY`) (BUILD-PLAN Phase 4)
- ✓ **LIFECYCLE-03**: Daily ETL detecting reactivation auto-clears `deleted_at` (BUILD-PLAN Phase 4)

### ETL

- ✓ **ETL-01**: Daily chain order ED → ASMS → InfoEd → ReCiter (+ DynamoDB minimal projection) → COI with ED-first abort cascade (BUILD-PLAN Phase 4)
- ✓ **ETL-02**: Per-source staging-then-atomic-swap with row-count and required-field-null validation (BUILD-PLAN Phase 4)
- ✓ **ETL-03**: Per-source `last_successful_refresh_at` timestamp tracking (BUILD-PLAN Phase 4)
- ✓ **ETL-04**: ED via LDAP `ldaps://ed.weill.cornell.edu:636` populating 8,943 active WCM faculty (BUILD-PLAN Phase 4)
- ✓ **ETL-05**: ReciterDB via `vivo_publications_prd.analysis_summary_*` tables (modern path, not legacy `wcmc_*`) (BUILD-PLAN Phase 4)
- ✓ **ETL-06**: ASMS via `asms.dbo.*` with `wcmc_person_school` join (BUILD-PLAN Phase 4)
- ✓ **ETL-07**: InfoEd via `wc_infoedprod.dbo.*` 3-step CTE-consolidated query (BUILD-PLAN Phase 4)
- ✓ **ETL-08**: COI via `v_coi_vivo_activity_group` (MySQL not MSSQL) (BUILD-PLAN Phase 4)
- ✓ **ETL-09**: DynamoDB minimal-projection ETL — exactly two fields (`publication_score`, `topic_assignments`) flow into MySQL (BUILD-PLAN Phase 4)
- ✓ **ETL-10**: `/api/revalidate` webhook fires `revalidatePath` + OpenSearch upsert; ETL writes and future self-edit writes both reuse it (BUILD-PLAN Phase 4)

### Health

- ✓ **HEALTH-01**: `/api/health/refresh-status` endpoint returns per-source `last_successful_refresh_at` (auth gate stubbed at 401, full SAML wiring deferred to Phase 7 / AUTH-04 in Milestone 2) (BUILD-PLAN Phase 4)

### Home

- ✓ **HOME-01**: Hero with H1 "Scholars at Weill Cornell Medicine", subtitle, big search input + autocomplete, suggestion chips, stats strip (BUILD-PLAN Phase 2; richer Variant B composition completes in Milestone 2 via HOME-02 / HOME-03 / RANKING-01)

### Render & responsiveness

- ✓ **RENDER-01**: ISR with on-demand revalidation for profile pages; CSR for search via `/api/search` (BUILD-PLAN Phases 2–3)
- ✓ **RESPONSIVE-01**: Mobile-responsive single-column collapse on profile and search results (BUILD-PLAN Phase 2)

---

## Milestone 2 v1 Requirements (Active)

Requirements for the next public-launch-readiness milestone. Each maps to a phase below.

### Headshots

- [ ] **HEADSHOT-01**: Server-side scholar API responses include `identityImageEndpoint` field populated from WCM directory syntax template `https://directory.weill.cornell.edu/api/v1/person/profile/{cwid}.png?returnGenericOn404=false`; if cwid resolves to 404, the field is set to empty string
- [ ] **HEADSHOT-02**: Client-side renderers across all six surfaces (profile header, search result rows, home Recent contributions cards, topic Top scholars chip row, topic Recent highlights, department faculty grid) check `identityImageEndpoint.length > 0` before using; otherwise load local `/static/generic-headshot.png` asset

### Algorithmic surfaces (completes Variant B ranking buildout)

- [ ] **RANKING-01**: Home page Recent contributions surface (6 scholar cards in 3×2 grid; scholar-attributed first-or-senior author filter applies; eligibility carve = Full-time faculty + Postdoc + Fellow + Doctoral student; no citation counts; methodology link visible)
- [ ] **RANKING-02**: Topic page Recent highlights surface (3 paper cards; publication-centric — no authorship-position filter; no citation counts; methodology link visible)
- [ ] **RANKING-03**: Topic page Top scholars in this area chip row (7 faculty chips; eligibility carve applies; publication-centric — no authorship-position filter; methodology link visible)

### Home (Variant B richer composition)

- [ ] **HOME-02**: Selected research subtopic carousel — 8 subtopic cards in horizontal scroll-snap carousel; refreshed weekly; copy "Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly"
- [ ] **HOME-03**: Browse all research areas topic grid — 67 parent topic names + counts in 4-column layout

### New page types (design spec v1.7.1 additions)

- [ ] **TOPIC-01**: Topic detail page at `/topics/{slug}` with hero (topic name + description), top scholars row (RANKING-03), "View all N scholars in this area →" affordance, recent highlights (RANKING-02), Layout B (subtopic rail sorted by pub count desc with "Less common" divider for n≤10 + main publication feed)
- [ ] **TOPIC-02**: Topic publication feed sort options — Newest (default for reproducibility), Most cited, By impact (ReCiterAI), Curated by ReCiterAI; "Curated" tag appears next to section title only when AI sort is active
- [ ] **DEPT-01**: Department detail page at `/departments/{slug}` with chair card (photo + endowed-chair title + role + name linking to profile), top research areas pill row, stats line, divisions rail + main with section header per division (chief name + link), role chip row defaulting to "All", person rows
- [ ] **DEPT-02**: Division URL pre-selection — users landing on a division URL get redirected to parent department page with corresponding division pre-selected
- [ ] **BROWSE-01**: Browse hub page at `/browse` with departments grid (3-col, 29 WCM departments — name + scholar count + chair name), centers & institutes grid (2-col, name + scope sentence + director + scholar count), A-Z directory (flat letter strip, active letter expands to 2-col list capped at 10 with "view all in {letter}" link), cross-link to research areas via small link in anchor strip
- [ ] **ABOUT-01**: About / methodology page at `/about` explaining ReCiterAI scoring scope, eligibility carve for scholar-centric algorithmic surfaces, why Voluntary / Adjunct / Courtesy / Instructor / Lecturer / Emeritus do not appear on Recent contributions / Top scholars surfaces, weekly cadence, highlight selection formula and surface-specific recency curves, authorship-position filter behavior, letters / editorials / errata hard-exclusion — must exist before launch (every algorithmic surface links to it)

### SEO + URL machinery

- [ ] **SEO-01**: `sitemap.xml` route handler enumerates all active scholars by canonical slug URL, refreshed on daily ETL completion
- [ ] **SEO-02**: `robots.txt` allowing indexing of profile + search pages, disallowing internal/authenticated paths
- [ ] **SEO-03**: Per-page `<title>`, `<meta description>`, `<link rel="canonical">` auto-generated from name + primary title + department across all page types
- [ ] **SEO-04**: VIVO URL pattern audit and bulk 301 mapping table — active scholars 301 → current canonical Scholars slug URL; deleted scholars 301 → `/search?q=<name-extracted-from-vivo-url-slug>`; redirect 404 rate within acceptable bound during first weeks post-launch

### Analytics

- [ ] **ANALYTICS-01**: Page views per profile per day instrumented
- [ ] **ANALYTICS-02**: Search query logging — raw text, result count, result-set type, filters applied; CTR by position
- [ ] **ANALYTICS-03**: Profile completeness metric — % of profiles meeting completeness threshold, weighted by faculty seniority, reported weekly; escalated if <70% sustained
- [ ] **ANALYTICS-04**: Redirect 404 rate telemetry — incoming requests to old VIVO URLs that don't match a 301

### Documentation

- [ ] **DOCS-01**: `openapi.yaml` artifact covering all `/api/*` read endpoints (`/api/scholars/:cwid`, `/api/search`, `/api/health/refresh-status`)
- [ ] **DOCS-02**: `docs/ADR-001-runtime-dal-vs-etl-transform.md` — the Q6 ADR documenting "DAL = ETL transform" architectural decision (referenced by ADR-006)
- [ ] **DOCS-03**: `openapi.yaml` extended to cover write endpoints (`/api/edit`, `/api/revalidate`) once self-edit lands

### Authentication & self-edit

- [ ] **AUTH-01**: SAML wiring with WCM IdP federation (NextAuth credentials provider stub for local dev; production target AWS-managed SAML or Cognito)
- [ ] **AUTH-02**: Authenticated owner can edit own overview (and only own); non-owners see no edit affordance
- [ ] **AUTH-03**: Admin role can paste overview text on a faculty member's behalf for legitimate proxy-edit requests; admin suppress action available (sets `deleted_at` regardless of appointment status; same 60-day window)
- [ ] **AUTH-04**: `/api/health/refresh-status` admin SAML auth gate fully wired (replaces Phase 4 401 stub)
- [ ] **EDIT-01**: `/api/edit` writes MySQL → fires `revalidatePath` → upserts OpenSearch atomically; public profile reflects edit within seconds
- [ ] **EDIT-02**: WYSIWYG editor (TipTap or similar) enforces ~3,000 char / ~450 word hard limit with live counter; allows bold, italic, paragraph breaks, lists, links; no headings, no images
- [ ] **EDIT-03**: "What's missing" checklist (stubbed in BUILD-PLAN Phase 2) wired up on profile pages for authenticated owners viewing their own profile
- [ ] **EDIT-04**: Every save logged to monitoring channel — Slack channel or email digest (target TBD per spec open item)
- [ ] **EDIT-05**: Self-edit completion rate analytics — % of authenticated owners saving ≥1 overview edit, weekly

---

## v2 Requirements (Deferred)

Tracked but not in current roadmap. Several explicitly deferred per design spec v1.7.1, ADR-007, and functional-spec phase mapping (Mohammad's slides 16–19).

### Phase 2 — Data Enhancement

- **PHASE2-01**: Abstracts display on profile
- **PHASE2-02**: Schema.org `Person` JSON-LD (after refresh pipeline runs cleanly 4–6 weeks post-launch)
- **PHASE2-03**: HTML browse / sitemap page (in addition to `sitemap.xml`)
- **PHASE2-04**: Embeddings-based hybrid retrieval (BM25 + dense biomedical embedding + faculty-status boost); ReCiter-lead consultation on PubMedBERT vs BioBERT vs SapBERT vs MedCPT is a hard prerequisite
- **PHASE2-05**: Doctoral student profile inclusion (active doctoral program enrollment as inclusion criterion)
- **PHASE2-06**: Leaf-level role filter (Voluntary as separate checkbox; "More" expander pattern carve-out)
- **PHASE2-07**: Division detail pages (Phase 1 surfaces division information through department detail rail)
- **PHASE2-08**: Center / institute detail pages (Phase 1 ships thin placeholder route at `/centers/{slug}`)
- **PHASE2-09**: Citation formats AMA, APA, RIS (Phase 1 ships Vancouver and BibTeX only)
- **PHASE2-10**: OFA-facing coverage dashboard (% of profiles with each component populated, weighted by role)

### Phase 3 — Self-Edit Expanded

- **PHASE3-01**: Suppress appointments / grants / education / publications (owner-controlled)
- **PHASE3-02**: Feature / pin top publications
- **PHASE3-03**: Delegate editing — faculty designate one or two named WCM accounts as proxies for overview self-edit

### Phase 4 — ASMS Central Faculty Profile

- **PHASE4-01**: ASMS faculty profile launch
- **PHASE4-02**: "Scholar Profile" exposed via micro-service

---

## Out of Scope

Explicit exclusions documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Production AWS infrastructure (Aurora, Fargate, OpenSearch Service, CloudFront, Route 53, ACM, EventBridge + Lambda for ETL, ElastiCache Redis) | Owned by Mohammad's team; Milestone 2 hands off prototype as reference implementation |
| CAB / AAC approval artifacts and production security review | Owned by Mohammad's team |
| Data privacy / FERPA / HIPAA review for COI display | Mohammad's team's lane |
| Abstract full-text search | Functional spec excludes Phase 1; abstracts not indexed |
| Saved searches | Functional spec excludes Phase 1 |
| Advanced search builder UI | Functional spec excludes Phase 1 |
| Cross-result-type relevance blending | Functional spec excludes Phase 1 |
| Subject-area filter on publications | Functional spec excludes Phase 1 |
| Clinical trials | Out of scope per design spec |
| CV / biosketch export | Out of scope per design spec |
| Achievement / altmetric badges | Out of scope per design spec |
| News mentions, activity stream, network/geographic/timeline visualizations | Out of scope per design spec |
| Honors & awards | Out of scope per design spec |
| "Highly influenced" articles | Out of scope per design spec |
| Scholar-curated featured publications | Out of scope per design spec |
| Editing of structured data sourced from authoritative systems | Out of scope entirely; sources stay read-only |
| Preview / staging / approval workflow / multi-version edit history | Out of scope per design spec |
| Suppress own profile (via self-edit) | Out of scope; admin suppress action exists separately |
| News carousel / featured scholars / recent-publications feed (un-eligibility-carved) on home | Out of scope; design spec v1.7.1 Recent contributions IS the carved variant |
| Charter "AWS-native, microservices architecture is required" as immediate constraint | Superseded by ADR-001 (provisional single Next.js deploy for prototype; production topology deferred to Mohammad's design kickoff) |
| `/api/headshot/:cwid` proxy with cache headers | Future enhancement deferred per ADR-009; only added if browser-direct hits become a perf or availability issue post-launch |
| Service-desk ticketing target on Support page (ServiceNow form vs email) | Open item resolved by stakeholder before launch, not by build |
| WCM institutional UI / branding standards finalization | Tracked at charter level; placeholder palette + CSS variable structure ships now, swap values when standards land |

---

## Traceability

Maps Milestone 2 v1 requirements to phases. Milestone 1 requirements are SHIPPED (BUILD-PLAN Phases 0–4) and marked Complete.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PROFILE-01 | Milestone 1 (BUILD-PLAN Phase 2) | Complete |
| PROFILE-02 | Milestone 1 (BUILD-PLAN Phase 2) | Complete |
| PROFILE-03 | Milestone 1 (BUILD-PLAN Phases 2–4) | Complete |
| PROFILE-04 | Milestone 1 (BUILD-PLAN Phase 2) | Complete |
| PROFILE-05 | Milestone 1 (BUILD-PLAN Phase 2) | Complete |
| SEARCH-01 | Milestone 1 (BUILD-PLAN Phase 3) | Complete |
| SEARCH-02 | Milestone 1 (BUILD-PLAN Phase 3) | Complete |
| SEARCH-03 | Milestone 1 (BUILD-PLAN Phase 3) | Complete |
| SEARCH-04 | Milestone 1 (BUILD-PLAN Phase 3) | Complete |
| SEARCH-05 | Milestone 1 (BUILD-PLAN Phase 3) | Complete |
| IDENTITY-01 | Milestone 1 (BUILD-PLAN Phase 1) | Complete |
| IDENTITY-02 | Milestone 1 (BUILD-PLAN Phase 1) | Complete |
| IDENTITY-03 | Milestone 1 (BUILD-PLAN Phase 1) | Complete |
| IDENTITY-04 | Milestone 1 (BUILD-PLAN Phase 1) | Complete |
| LIFECYCLE-01 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| LIFECYCLE-02 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| LIFECYCLE-03 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-01 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-02 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-03 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-04 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-05 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-06 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-07 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-08 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-09 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| ETL-10 | Milestone 1 (BUILD-PLAN Phase 4) | Complete |
| HEALTH-01 | Milestone 1 (BUILD-PLAN Phase 4) | Complete (auth gate wiring tracked under AUTH-04) |
| HOME-01 | Milestone 1 (BUILD-PLAN Phase 2) | Complete (richer Variant B composition tracked under HOME-02 / HOME-03 / RANKING-01) |
| RENDER-01 | Milestone 1 (BUILD-PLAN Phases 2–3) | Complete |
| RESPONSIVE-01 | Milestone 1 (BUILD-PLAN Phase 2) | Complete |
| HEADSHOT-01 | Phase 1 | Pending |
| HEADSHOT-02 | Phase 1 | Pending |
| RANKING-01 | Phase 2 | Pending |
| RANKING-02 | Phase 2 | Pending |
| RANKING-03 | Phase 2 | Pending |
| HOME-02 | Phase 2 | Pending |
| HOME-03 | Phase 2 | Pending |
| TOPIC-01 | Phase 3 | Pending |
| TOPIC-02 | Phase 3 | Pending |
| DEPT-01 | Phase 3 | Pending |
| DEPT-02 | Phase 3 | Pending |
| BROWSE-01 | Phase 4 | Pending |
| ABOUT-01 | Phase 4 | Pending |
| SEO-01 | Phase 5 | Pending |
| SEO-02 | Phase 5 | Pending |
| SEO-03 | Phase 5 | Pending |
| SEO-04 | Phase 5 | Pending |
| ANALYTICS-01 | Phase 6 | Pending |
| ANALYTICS-02 | Phase 6 | Pending |
| ANALYTICS-03 | Phase 6 | Pending |
| ANALYTICS-04 | Phase 6 | Pending |
| DOCS-01 | Phase 6 | Pending |
| DOCS-02 | Phase 6 | Pending |
| AUTH-01 | Phase 7 | Pending |
| AUTH-02 | Phase 7 | Pending |
| AUTH-03 | Phase 7 | Pending |
| AUTH-04 | Phase 7 | Pending |
| EDIT-01 | Phase 7 | Pending |
| EDIT-02 | Phase 7 | Pending |
| EDIT-03 | Phase 7 | Pending |
| EDIT-04 | Phase 7 | Pending |
| EDIT-05 | Phase 7 | Pending |
| DOCS-03 | Phase 7 | Pending |

**Coverage:**
- Milestone 2 v1 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-30*
*Last updated: 2026-04-30 after Milestone 1 ship and Milestone 2 scope ingest*
