# Requirements (intel)

Synthesized from PRD-class sources during ingest. Charter (precedence 9, lowest) supplies the business-case baseline; per orchestrator instruction, charter scope claims do NOT veto more ambitious requirements derived from HANDOFF or design spec. Where charter and design-spec disagree on UI/UX scope, design-spec wins.

Per-source attribution is preserved for every requirement so that downstream synthesis can reason about precedence.

---

## REQ-platform-replace-vivo

- **source:** `.planning/source-docs/charter.md` (Goal, Objectives)
- **scope:** product-level
- **description:** Replace VIVO with a custom, modular, AWS-native scholar profile platform aligned with WCM's existing development stack and operational model. Decommission VIVO within ~2 months of Scholars launch.
- **acceptance criteria (charter-stated):**
  - All active WCM faculty with public release codes have profiles in Scholars
  - VIVO is decommissioned within ~2 months of Scholars launch
  - Daily data refresh from all source systems operates reliably
  - Uptime materially exceeds VIVO's recent record
  - Google indexing preserves or improves SEO position post-migration
  - Faculty self-edit (overview statement) is functional and adopted by faculty
  - Sign-off secured from VIVO/ASMS Steering Committee, AAC, CAB

---

## REQ-public-scholars-site

- **source:** `.planning/source-docs/charter.md` (Objectives 1)
- **scope:** product surface
- **description:** Stand up a public Scholars @ WCM site at `scholars.weill.cornell.edu` to replace VIVO. Phase 1 covers seven page types per design spec v1.7.1: Profile, Search, Topic detail, Department detail, Browse hub, Home / Landing, About.
- **acceptance criteria:**
  - Public, anonymous browsing of all seven page types
  - SAML-protected self-edit on owner's own profile (Phase 1 = overview only)
  - Mobile-responsive across all page types

---

## REQ-scholar-api

- **source:** `.planning/source-docs/charter.md` (Objectives 2)
- **scope:** API tier
- **description:** Build a reusable Scholar API as the backend for current and future researcher-facing applications. Phase 1 implementation per ADR-001 (provisional): exposed via Next.js `/api/*` route handlers within the same deploy. OpenAPI specification artifact (`openapi.yaml`) documents the contract independently from the implementation. Production architecture deferred to Mohammad's design kickoff.
- **acceptance criteria:**
  - Documented API contract in `openapi.yaml`
  - HTTP-accessible at `scholars.weill.cornell.edu/api/scholars/:cwid`
  - Implementation discipline: route handlers as pure functions in `lib/api/*` with route files as thin delegators (so future migration to standalone service is copy-paste, not rewrite)
- **status:** API itself is built (HANDOFF current state); `openapi.yaml` is Phase 6 deferred work (not yet written).

---

## REQ-source-system-integrations

- **source:** `.planning/source-docs/charter.md` (Objectives 3) + `.planning/source-docs/design-spec-v1.7.1.md` "Data sources" + `.planning/source-docs/HANDOFF-2026-04-30.md` "Source-system integrations"
- **scope:** ETL / data ingestion
- **description:** Integrate authoritative data from Enterprise Directory (LDAP), ASMS (MS SQL), InfoEd (MS SQL), ReCiter (MySQL `analysis_summary_*`), ReCiterAI (DynamoDB), and COI (MySQL — note: COI is MySQL not MS SQL despite charter language) as read-only source systems with daily refresh.
- **acceptance criteria (per HANDOFF current state):**
  - All six source systems wired and producing real data (8,943 active WCM faculty populated)
  - ED via LDAP (`ldaps://ed.weill.cornell.edu:636`)
  - ReciterDB via `vivo_publications_prd` `analysis_summary_*` tables
  - ASMS via `asms.dbo.*` with `wcmc_person_school` join
  - InfoEd via `wc_infoedprod.dbo.*` 3-step query (consolidated to CTE)
  - COI via `v_coi_vivo_activity_group`
  - DynamoDB via `reciterai-chatbot` table, `FACULTY#cwid_*` partition scan
  - Daily ETL chain with ED-first abort cascade per ADR-005
  - `/api/health/refresh-status` admin endpoint
- **status:** SHIPPED (Phases 0–4 done).

---

## REQ-self-edit-overview

- **source:** `.planning/source-docs/charter.md` (Objectives 4) + `.planning/source-docs/functional-spec-phase-1.md` "Self-edit" + `.planning/source-docs/phase-1-design-decisions.md` ADR-008 self-edit pipeline
- **scope:** authenticated edit flow
- **description:** Provide minimal faculty self-edit (overview statement only) as an interim service. SAML via WCM IdP; authenticated visitors see inline edit affordances on their own profile only. Simple WYSIWYG with limited formatting (bold, italic, paragraph breaks, lists, links — no headings, no images). Hard character limit ~3,000 chars / ~450 words with live counter. Explicit Save button, immediate publish, no approval workflow. **Self-edits bypass the daily refresh pipeline and write through immediately** (`/api/edit` writes MySQL → `revalidatePath` → OpenSearch upsert atomically).
- **acceptance criteria:**
  - Authenticated owner can edit own overview, no-one else's
  - Save fires unifying webhook (MySQL + revalidate + OpenSearch upsert)
  - Public profile reflects edit within seconds
  - Every save is logged to a low-volume monitoring channel (target TBD — Slack/email digest)
  - Admin role can paste in overview text on a faculty member's behalf for legitimate proxy-edit requests; suppress action available for damaging edits and in-flight sensitive cases
- **status:** NOT YET DONE (Phase 7 deferred).
- **deferred to later phases:** delegate / proxy editing by assistants, DAs, DivAs (Phase 3 per functional spec); editing of structured data (out of scope entirely); preview/staging; approval workflow; multi-version history; suppress own profile.

---

## REQ-vivo-decommission

- **source:** `.planning/source-docs/charter.md` (Objectives 5) + `.planning/source-docs/phase-1-design-decisions.md` ADR-003, ADR-004
- **scope:** decommissioning
- **description:** Decommission VIVO within ~2 months of Scholars launch. Keep VIVO domain alive as redirect-only host. Produce VIVO URL audit mapping `vivo_url → cwid`. Active scholars: 301 → current canonical Scholars slug URL. Deleted scholars: 301 → `/search?q=<name-extracted-from-vivo-url-slug>` (contextually relevant for SEO, never soft-404).
- **acceptance criteria:**
  - VIVO URL pattern audit complete
  - Redirect mapping table populated
  - All known VIVO URL forms produce a 301 to either canonical Scholars URL or `/search?q=<name>`
  - Redirect 404 rate (telemetry) within acceptable bound during first weeks post-launch
- **status:** Phase 5 deferred — middleware exists but sitemap and bulk VIVO 301 audit not wired.

---

## REQ-profile-page

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Scholar profile page" + `.planning/source-docs/design-spec-v1.7.1.md` §3 (Profile spec) — design spec v1.7.1 supersedes any earlier UI hints in the functional spec on UI/UX layout
- **scope:** profile page surface
- **description:** Per-scholar landing. Two-column layout with sticky left sidebar (faculty case). Renders identity, research narrative, publications, grants, external relationships.
- **sections (per design spec v1.7.1):**
  - **Sidebar:** photo, name, title, primary appointment, status pill (only when non-default and ED data fresh), Contact card (email + Clinical profile link when ED has `webpage` attribute pointing to `weillcornell.org/{cwid}`), Appointments card ("Show all N →" if more than 3), Education card, action buttons (Copy citations, Print). For postdocs / doctoral students: Mentor / Advisor card.
  - **Main column:** dismissible "what's missing" checklist (owner-only); Overview prose with "Show more ↓"; Areas of interest pills (3+ pubs threshold); Selected highlights (top 3 via Highlight selection formula); Publications (year-collapsed; toolbar filter chips All/Articles/Reviews/Editorials + search; most recent 2 years expanded; older years half-decade-grouped); Grants (split Active inline with role pills, Completed collapsed); External relationships (only when ≥1 disclosure exists).
- **graceful degradation for non-faculty:**
  - Hide Grants if zero
  - Hide Selected highlights if fewer than 3
  - Hide External relationships if no disclosures
  - Don't year-collapse Publications below 20 entries
  - Hide "Show all N →" when count is small
- **empty-state behavior:**
  - Hide section entirely if zero items (no "No grants" placeholder)
  - "This profile is being populated" affordance shown when overview AND <3 publications AND no active grants (threshold tunable post-launch)
  - Sparse profiles filtered out of default search results
- **status:** SHIPPED (Phase 2 done) — but several details (year-collapse, External relationships, Mentor/Advisor card, Clinical profile link) need verification against current-state code.
- **calibration TODOs (open):** AOI threshold, publication ranking weight calibration against ~20 real WCM profiles, completeness threshold for "being populated" affordance.

---

## REQ-publications-ranking

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Highlight selection formula" component (resolved 2026-04-30 by user — Variant B wins; functional spec arithmetic superseded)
- **scope:** publications surface ranking algorithm — all surfaces
- **description:** Rank publications on profile and algorithmic surfaces (Selected highlights, Recent publications, Recent contributions on home, Topic page Recent highlights, Top scholars chip row) using a multiplicative formula with surface-specific recency curves.
- **shared formula:** `score = reciterai_impact × authorship_weight × pub_type_weight × recency_weight`
- **publication-type weights:** Academic Article 1.0 · Review 0.7 · Case Report 0.5 · Letter / Editorial / Erratum **0** (hard-excluded — "a 10× score gap can no longer rescue an erratum onto the home page contributions surface")
- **recency curves (two-stage, surface-keyed):**
  - "Recent" surfaces (home Recent contributions, topic-page Recent highlights): peak at 3–18 months, penalize papers under 3 months
  - "Selected highlights" (profile): peak 18 months–10 years, exclude papers under 6 months entirely (avoids duplication with the most-recent-papers view immediately below)
- **authorship-position filter (scholar-attributed surfaces only):** Profile Selected highlights and home page Recent contributions restricted to first-or-senior author. Publication-centric surfaces (Topic Recent highlights, Top scholars chip row) do NOT apply this filter.
- **calibration owner:** ReCiter lead, in concert with the methodology page owner. Six-month post-launch review trigger committed.
- **status:** SHIPPED on profile per HANDOFF; new algorithmic surfaces (home Recent contributions, topic page Recent highlights, Top scholars chip row) require build-out.
- **superseded variants (do not implement):** Functional spec arithmetic (`authorship_points + type_points + impact_points` with integer points; single `8 × exp(-age/5)` recency curve) is captured here as historical context. Variant B replaces it on all surfaces.

---

## REQ-search

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Search" + `.planning/source-docs/design-spec-v1.7.1.md` §4 (Search results) + `.planning/source-docs/phase-1-design-decisions.md` ADR-007
- **scope:** search surface and engine
- **description:** Single search box, persistent in site header and prominent on home page. Two indices: People and Publications. OpenSearch as the engine (ADR-007). Browser-facing search proxies through `/api/search`.
- **people index field weights:** Name 10× / Areas of interest 6× / Primary title 4× / Department 3× / Overview 2× / Publication titles 1× / MeSH 0.5×.
- **authorship-weighted contributions:** First/last author ×1.0, Second/penultimate ×0.4, Middle ×0.1.
- **minimum-evidence threshold:** A topical term contributes to a scholar's index only if EITHER (a) it appears in ≥2 of their publications OR (b) it appears in ≥1 first/last-author publication.
- **publications index fields:** publication title, MeSH terms, journal name, author names. Abstracts NOT indexed in Phase 1.
- **autocomplete:** Fires after 2 characters; suggests scholar name + primary title (Stanford-style).
- **results page:**
  - Two tabs: People (N) / Publications (N), default People
  - Per-row: headshot, name, primary title, primary department, snippet, role tag (per design spec v1.7.1)
  - Sort options (people): Relevance default, Last name A–Z, Most recent publication
  - Sort options (publications): Relevance default, Year (newest), Citation count
  - Filters (people): Person type (5 chip categories — see role model below), Department/division (adaptive flat list with em-dash disambiguation), Activity ("has active grants" boolean), Research area
  - Filters (publications): year-range
  - Active filter chips (mandatory) + "Clear all"
  - Match highlights: bold-only (no background colors)
  - **Pagination: numbered, 20 per page** (LOCKED per functional spec line 197). Design spec adds rendering pattern: small (≤6 pages) numbered prev/next; large (≥7 pages) ellipsis pattern `‹ Prev | 1 2 3 4 5 … 84 85 | Next ›`.
- **default-result filtering:** profiles below completeness threshold do not appear in default browse-style results, only in name-anchored searches and at canonical URLs.
- **leaf-level role filter:** Phase 2 candidate; Phase 1 ships flat 5-category checkboxes only.
- **status:** SHIPPED (Phase 3 done per HANDOFF).
- **out of scope (Phase 1):** abstract full-text search, saved searches, advanced search builder UI, cross-result-type relevance blending, subject-area filter on publications.
- **calibration TODOs (open):** AOI threshold + 6× boost calibration (joint item with profile AOI threshold), Relevance sort algorithm definition (lexical match vs embedding similarity vs faculty-status boost — pending ReCiter lead consultation per design spec).

---

## REQ-role-model

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Scholar role model" (locked UI/UX contract per orchestrator instruction; supersedes any earlier UI hints in functional spec)
- **scope:** UI taxonomy for all list-of-people surfaces
- **description:** Five chip-row categories derived from ED's 12-leaf person-type taxonomy. Per-row role tags show the actual ED type. Search filter uses the same five categories as flat checkboxes (no two-tier hierarchy).
- **chip categories:**
  - Full-time faculty: `Full-Time WCMC Faculty` AND `weillCornellEduFTE = 100` (~2,211)
  - Affiliated faculty: any faculty class not meeting the Full-time rule. Includes Part-Time, Voluntary, Adjunct, Courtesy, Faculty Emeritus, Instructor, Lecturer (~5,000)
  - Postdocs & non-faculty: Postdoc, Fellow, Non-Faculty Academic, Non-Academic (~1,731)
  - Doctoral students: under `ou=students`, identified via `weillCornellEduDegreeCode = PHD` (~500, pending registrar confirmation)
  - All (chip row only)
- **algorithmic-surface eligibility carve:** Recent contributions, Top scholars in this area restricted to Full-time faculty + Postdoc + Fellow + Doctoral student. Voluntary / Adjunct / Courtesy / Instructor / Lecturer / Emeritus never appear on these surfaces.

---

## REQ-home-page

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Home page" + `.planning/source-docs/design-spec-v1.7.1.md` §1 (Home / Landing)
- **scope:** home / landing page
- **description:** Front door with hero search, stats strip, Selected research carousel, Recent contributions faculty grid, Browse all research areas topic grid, footer.
- **acceptance (design spec v1.7.1):**
  - Hero: large H1 "Scholars at Weill Cornell Medicine", subtitle, big search input with autocomplete + suggestion chips
  - Stats strip: `N scholars · N publications · N research areas` (single-line, muted, centered)
  - Selected research: 8 subtopic cards in horizontal scroll-snap carousel ("Eight subtopics with the strongest recent activity at WCM, one per parent area, refreshed weekly")
  - Recent contributions: 6 scholar cards in 3×2 grid (responsive 2×3 tablet, 1-col mobile). Photo, name, title, contribution paper title, journal · year · authorship role. **No citation counts.** Eligibility = scholar-centric carve (Full-time faculty + Postdoc + Fellow + Doctoral student)
  - Browse all research areas: 67 parent topic names + counts in 4 columns
  - Both algorithmic surfaces link to a methodology page (must exist before launch)
- **note:** The functional spec describes a leaner home page with just hero + stats strip + 4–6 browse entry tiles + footer; design spec v1.7.1 supersedes with the richer carousel + Recent contributions + topic grid composition.

---

## REQ-topic-detail-page

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` §2 (Topic detail) — NOT in functional spec
- **scope:** new page type
- **description:** Per-topic landing at `/topics/{slug}`. Hero with topic name, description, "Top scholars in this area" chip row (7 faculty chips, eligibility carve applies), "View all N scholars in this area →" affordance leading to a directory listing scoped to the topic. Recent highlights (3 papers, no citations). Layout B (rail + main): subtopic rail sorted by pub count desc with "Less common" divider for n≤10, single feed header in main with publication feed.
- **sort options:** Newest (default for reproducibility), Most cited, By impact (ReCiterAI), Curated by ReCiterAI. "Curated" tag appears next to section title only when AI sort is active.
- **status:** charter does not enumerate this page, but design spec v1.7.1 (locked UI/UX contract) requires it. Implementation status not enumerated in HANDOFF current-state list — verify against code; likely deferred work for ambitious-scope expansion.

---

## REQ-department-detail-page

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` §6 (Department detail) — NOT in functional spec
- **scope:** new page type
- **description:** Per-department landing at `/departments/{slug}`. Hero with chair card (photo + role + name + endowed-chair title, links to chair's profile), top research areas pill row, stats line. Layout: divisions rail + main with section header per division (chief name + link), role chip row defaulting to "All" (deliberate inclusivity choice), person rows.
- **division URL pre-selection:** users who land on a division URL get redirected to parent department page with corresponding division pre-selected (acceptance criterion #19 per design spec v1.7.1 changelog).
- **status:** new scope from design spec v1.7.1; implementation status to verify.

---

## REQ-browse-hub-page

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` §5 (Browse hub) — NOT in functional spec
- **scope:** new page type
- **description:** `/browse` page. Departments grid (3-col, 29 WCM departments, name + scholar count + chair name); Centers & institutes grid (2-col, name + scope sentence + director + scholar count); A-Z directory (flat letter strip, active letter expands to 2-col list capped at 10 with "view all in {letter}" link). Cross-link to research areas via small link in anchor strip.
- **status:** new scope from design spec v1.7.1; implementation status to verify.

---

## REQ-about-page

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` §7 / sketch 008 — NOT in functional spec
- **scope:** new page type
- **description:** About page (sketch 008 demonstrates structure; spec confirms it as required Phase 1 deliverable, not optional).
- **status:** new scope from design spec v1.7.1; implementation status to verify.

---

## REQ-support-page

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Support page"
- **scope:** static informational page
- **description:** Three short sections: (1) How to update your profile (overview self-edit; for everything else, point to source-of-record systems — ED for name/title/email/appointments; ASMS for educational background; InfoEd for grants; ReCiter / Publication Manager for publications; covers proxy-edit-via-service-desk path), (2) Reporting an issue (link to chosen service-desk target), (3) FAQs (5–10 Q&As, drafted near launch).
- **open item (must close before build per spec):** Service-desk ticketing target — ServiceNow form vs email. Form, if chosen, must exist before launch.

---

## REQ-sitemap-and-seo

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Sitemap and SEO" + `.planning/source-docs/phase-1-design-decisions.md` ADR-003 + ADR-004
- **scope:** SEO machinery
- **description:**
  - `sitemap.xml` listing all public profile URLs (canonical slug URLs only); refreshed on daily ETL
  - `robots.txt` allowing indexing of profile + search pages, disallowing internal/authenticated paths
  - Per-page `<title>`, `<meta description>`, `<link rel="canonical">` (auto-generated from name + primary title + department)
  - 301 redirects from old VIVO profile URLs (per ADR-003 + ADR-004 redirect chain)
- **deferred:** schema.org `Person` JSON-LD deferred to Phase 2 (until data refresh has run cleanly for 4–6 weeks post-launch).
- **status:** Phase 5 deferred per HANDOFF (sitemap + bulk VIVO 301 audit not yet wired).

---

## REQ-analytics-instrumentation

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Analytics"
- **scope:** measurement
- **description:** Phase 1 must instrument:
  - Page views per profile per day
  - Search queries (raw text, result count, result-set type, filters applied)
  - Search-result CTR by position
  - Self-edit completion rate (% of authenticated owners saving ≥1 overview edit, weekly)
  - Redirect 404 rate (incoming requests to old VIVO URLs that don't match a 301)
  - Profile completeness metric (% of profiles meeting completeness threshold, weighted by faculty seniority; reported weekly; escalated if <70% sustained)
- **open item:** Tooling target TBD (Google Analytics vs Plausible vs custom log pipeline) — align with WCM analytics standards.
- **status:** Phase 6 deferred per HANDOFF.

---

## REQ-cross-cutting

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Cross-cutting requirements" + `.planning/source-docs/charter.md` Constraints
- **scope:** cross-cutting
- **description:**
  - **Mobile responsive.** All Phase 1 pages must render usably on phones (single-column collapse for profile and search results).
  - **Daily data refresh** is the assumed cadence for source-system data. Self-edits are the documented exception (write through immediately).
  - **WCM branding standards** apply once published; until then, follow design spec v1.7.1 placeholder palette + Mohammad's existing mockups. The CSS variable structure stays even when real standards land.
  - **Source systems consumed read-only.** No write-back to upstream systems (charter constraint).
  - **AWS-native deployment.** Production target stack: Aurora MySQL on RDS, Fargate, OpenSearch Service (managed), CloudFront, EventBridge + Lambda for ETL, Route 53, ACM, optional ElastiCache Redis.

---

## Out-of-scope (consolidated, Phase 1)

Per functional spec, charter, and design spec v1.7.1 (does NOT include items the user has flagged as new scope to add later):

- **Profile:** clinical trials; CV / biosketch export; achievement badges; altmetric badges; news mentions; activity stream; collaboration / network / geographic / timeline visualizations; honors & awards; abstracts on profile; "highly influenced" articles; scholar-curated featured pubs.
- **Search:** abstract full-text search; saved searches; advanced search builder; cross-result-type relevance blending; subject-area filter on publications.
- **Home:** news carousel; featured scholars; recent-publications feed (note: design spec v1.7.1 DOES include Recent contributions which is similar but eligibility-carved); activity feed; visualizations.
- **Self-edit:** suppress appointments / grants / education / publications; feature / pin pubs; **delegate / proxy editing** (Phase 3); preview / staging; approval workflow; multi-version history; suppress own profile.
- **Sitemap / SEO:** schema.org `Person` JSON-LD (Phase 2); HTML browse / sitemap page.
- **Charter-level out of scope:** full CRIS/RIM platform features; linked data / RDF / SPARQL endpoints; editing of structured data sourced from authoritative systems; long-term ownership of faculty self-edit; functional duplication of upstream systems.

---

## Calibration TODOs (open requirements)

These surfaced as "calibrate against feedback" / "refine post-launch" items in the functional spec; design spec v1.7.1 carries them forward. They are NOT locked decisions and require closure during build or post-launch.

| Item | Source | Notes |
|---|---|---|
| AOI relevance threshold | Functional spec line 313 | Joint with 6× search boost — calibrate together against Publication Manager + sample real searches |
| Publication ranking weight calibration (highlight + recent formulas) | Functional spec line 314 | Calibrate against ~20 real WCM profiles spanning seniority — junior, mid-career, named-chair (200+ papers). Chair-level is where ranking errors generate angry emails. |
| Specific completeness threshold | Functional spec line 315 | For "being populated" affordance and default-search filtering |
| Edit-event logging target | Functional spec line 316 | Slack channel? Email digest? Decided by end of design phase per spec; Phase 7 work |
| Analytics tooling target | Functional spec line 317 | GA vs Plausible vs custom log pipeline |
| Source-system field-name confirmation for filters | Functional spec line 318 | E.g., person-type values from ED |
| Citation-count refresh cadence in reciterdb-prod | Functional spec line 319 | Spec target: ≥ weekly. Confirm current cadence with Mohammad's team; add a refresh job if slower. |
| Service-desk ticketing target on Support page | Functional spec line 307 | ServiceNow form vs email |
| VIVO URL-pattern audit | Functional spec line 308 | Enumerate existing VIVO URL forms in production; produce redirect mapping table |
| WCM institutional UI / branding standards | Charter dependency | Tracked at charter level |
| Search Relevance sort algorithm | Design spec §4 "Open: Relevance sort" | Lexical match? Embedding similarity? Boost for high-citation senior authors? Pending ReCiter lead consultation |
| Methodology page content | Design spec Open Q #1 | Plain-English explanation of scoring scope, eligibility carves, weekly cadence; **must exist before launch** — dead methodology link is the most credibility-damaging element on AI surfaces |
| Subtopic descriptions (top ~300 of ~2,010) | Design spec changelog v1.7.1 | "ITS plus an editor seconded from Comms (or contractor)"; two-week window committed for May 2026 |
| Doctoral student count | Design spec changelog v1.7.1 | Working assumption (~500) pending registrar confirmation |
| Component-render logging implementation | Design spec changelog v1.7.1 | Application logs for launch-day debugging of absence-as-default surfaces |
