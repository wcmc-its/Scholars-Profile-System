# Context (intel)

Synthesized from DOC-class sources during ingest. These are running notes, factual ground truth, business-case background, and historical context — not contractual decisions or requirements.

---

## Project background and business case

- **source:** `.planning/source-docs/charter.md`
- **topic:** why Scholars exists

VIVO, the institution's current scholar profile system, has reached end of life. The platform has experienced repeated all-hands-on-deck outages lasting 8+ hours that persist despite tactical fixes. Its legacy Java/Tomcat, RDF triple-store, and Apache Solr architecture requires manual reindexing, suffers data synchronization drift with downstream tools, and demands operational expertise the team can no longer sustain.

WCM also lacks a modern, branded, performant public surface for showcasing its scholars to patients, prospective collaborators, funders, students, journalists, and the broader research community. Replacement is urgent and presents an opportunity to establish a reusable platform that can support current and future researcher-facing services.

**Stakeholders:** VIVO/ASMS Steering Committee (Chris Huang, Alex, Terrie, Vinay Varughese, Charlie, Sumanth); Office of Faculty Affairs (OFA); Application Architecture Committee (AAC); Change Advisory Board (CAB); ITS Development Team; Data & Analytics product team (prospective downstream owner of faculty self-edit).

**Roles:**
- Funding Sponsor: Terrie [last name TBD]
- Project Executive: Chris Huang
- Project Manager: TBD
- Project owner: Paul Albert (palbert1@gmail.com)

**High-impacting risks (from charter):**
- Institutional UI / branding standards delayed, blocking final design polish and launch
- VIVO suffers a catastrophic failure prior to Scholars launch, forcing premature decommissioning
- Data integration complexity across five source systems is underestimated
- Scope creep on faculty self-edit if D&A product timeline slips
- SEO degradation and loss of inbound links during URL migration from VIVO to Scholars
- Stakeholder sign-off (AAC, CAB, Steering Committee) delayed beyond planning assumptions

**Charter assumptions worth re-validating against current state (HANDOFF):**
- Charter states "AWS-native, microservices architecture is required" — ADR-001 chose single Next.js deploy for prototype; production architecture is provisional and deferred to Mohammad's design kickoff.
- Charter line 13 expects D&A product to absorb faculty self-edit. ADR-001 + ADR-008 build the unifying-webhook self-edit pipeline regardless.

---

## Current state — what exists today

- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md`
- **topic:** as-of 2026-04-30 ground truth

This is a **working local prototype** of the Phase 1 Scholars @ WCM system. Built end-to-end against real WCM data sources. Not a production deploy. AWS infrastructure, the production technical plan, and the official design decisions are owned by Mohammad's team.

**Repo:**
- GitHub: `https://github.com/wcmc-its/Scholars-Profile-System` (public, default branch `master`)
- Local: `~/Dropbox/GitHub/Scholars-Profile-System/`

**What works (as of 2026-04-30):**
- 8,943 active WCM faculty populated from live ED via LDAP
- Profile pages render: header, overview (currently empty for real scholars — overview is a self-edit field), contact (email), appointments, education, areas of interest, publications (with both ranking formulas + WCM coauthor chips), grants, disclosures
- Search with per-field boost weights (Name 10× / AOI 6× / Title 4× / Department 3× / Overview 2× / Pub titles 1× / MeSH 0.5×) and authorship-weighted contributions; faceted results page with people/publications tabs, year-range filter, autocomplete on 2 chars, numbered pagination 20/page
- Daily ETL chain with ED-first abort cascade, per-source independence, `/api/health/refresh-status` admin endpoint
- Slug-primary URLs with collision suffixing and slug-history 301 redirects
- CWID-canonical identity with `cwid_aliases` table for replacement-CWID handling
- Soft-delete of departed scholars with 60-day retention window

**Stack (local prototype → production target):**

| Layer | Local prototype | Production target (Mohammad's call) |
|---|---|---|
| Framework | Next.js 15 App Router + TypeScript strict | Same on Fargate |
| Database | MySQL 8 (Docker) | Aurora MySQL on RDS |
| Search | OpenSearch 2.x (Docker) | OpenSearch Service (managed) |
| ORM | Prisma 7 with MariaDB driver adapter | Same |
| ETL | TypeScript scripts via `tsx`, `npm run etl:daily` | Lambda + EventBridge |
| Auth | Deferred to Phase 7 | AWS-managed SAML or Cognito + WCM IdP |
| Styling | Tailwind 4 + shadcn/ui | Same |
| Tests | Vitest (44 unit tests passing) + Playwright | Same |
| CI | GitHub Actions | Same |

**Source-system integrations (all real, all working as of 2026-04-30):**

| Source | Type | Connection | Status |
|---|---|---|---|
| ED | LDAP / `ldaps://ed.weill.cornell.edu:636` | reciter or personal bind DN | ✅ |
| ReciterDB | MySQL / `vivo_publications_prd` | `analysis_summary_*` tables | ✅ |
| ASMS | MS SQL / `asms.dbo.*` | `wcmc_person_school` join | ✅ |
| InfoEd | MS SQL / `wc_infoedprod.dbo.*` | 3-step query (consolidated to CTE) | ✅ |
| COI | MySQL (not MSSQL!) | `v_coi_vivo_activity_group` | ✅ |
| DynamoDB | AWS / `reciterai-chatbot` | `FACULTY#cwid_*` partition scan | ✅ |

Each source's connection helper lives at `lib/sources/<source>.ts` and the corresponding ETL at `etl/<source>/index.ts`.

**Local-run prereqs:**
- Node 22+, Docker, npm 10+, VPN access for source systems, env vars in `~/.zshenv`
- Run flow: `npm install` → `npm run db:up` → `npx prisma migrate dev` → `npm run seed` (synthetic, 12 fictional scholars) OR `npm run etl:daily` (real, ~10 min, needs VPN) → `npm run search:index` → `npm run dev` → `http://localhost:3000`

---

## Build phase status

- **source:** `.planning/source-docs/BUILD-PLAN.md` (planned phases) + `.planning/source-docs/HANDOFF-2026-04-30.md` (actual state)

| Phase | Goal | Status |
|---|---|---|
| Phase 0 — Foundation | Repo cloned, dev env runs, hello-world page | SHIPPED |
| Phase 1 — Schema and identity layer | Prisma schema reflects all decisions; identity layer end-to-end with synthetic data | SHIPPED |
| Phase 2 — Profile rendering | Profile pages render to spec, ISR works, mobile responsive | SHIPPED |
| Phase 3 — Search | OpenSearch wired, per-field boosting, autocomplete | SHIPPED |
| Phase 4 — ETL pipelines | Real data flows from all five source systems, orchestrator runs | SHIPPED |
| Phase 5 — SEO + URL machinery | sitemap.xml, robots.txt, full VIVO 301 mapping | **NOT YET DONE** |
| Phase 6 — Polish, analytics, docs | Page-view tracking, search-query logging, OpenAPI artifact (`openapi.yaml`), Q6 ADR (`docs/ADR-001-runtime-dal-vs-etl-transform.md`), README polish | **NOT YET DONE** |
| Phase 7 — Self-edit + auth | SAML wiring, `/api/edit` route, WYSIWYG, "What's missing" checklist for owners, edit-event logging | **NOT YET DONE** |

The "What's missing" checklist for authenticated owners is **stubbed in Phase 2** and gets wired up in Phase 7.

`/api/health/refresh-status` is **stubbed with 401 in Phase 4** and gets the auth gate wired in Phase 7.

`openapi.yaml` is **planned for Phase 6** and not yet written. ADR-001 references it as a binding artifact requirement; it is presently a deferred deliverable.

---

## Spec amendment during build

- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md`
- **topic:** scope deviation noted in handoff

The functional spec didn't enumerate a COI "Disclosures" section on profile pages, but VIVO surfaced this data and removing it would be a regression. **Spec amendment added during build:** COI Disclosures (now codified in design spec v1.7.1 §3 + v1.5 changelog as the "External relationships" section).

---

## Mohammad's preliminary lean (production architecture)

- **source:** `.planning/source-docs/phase-1-design-decisions.md` ADR-001 status note + `.planning/source-docs/HANDOFF-2026-04-30.md` Lessons #7
- **topic:** API service production architecture

In email correspondence following the brainstorm, Mohammad expressed a preliminary preference for a **separate Scholar API service** in production: *"I expect it would be a separate service so it can be consumed."* Hedged with: *"could change when we officially kick off the design."*

Production architecture for the Scholar API is therefore **deferred to Mohammad's official design kickoff.** The prototype implements ADR-001 option D (single Next.js deploy with `/api/*` routes) for build velocity but adopts an implementation discipline — API route handlers as pure functions in `lib/api/*` with route files as thin delegators — that makes lifting handlers into a standalone Node service a copy-paste, not a rewrite. The OpenAPI contract is the durable artifact regardless of implementation choice.

This is also why ADR-001 is treated as **PROVISIONAL** rather than LOCKED.

---

## Handoff target audience and recommendations

- **source:** `.planning/source-docs/HANDOFF-2026-04-30.md`
- **topic:** what to do with the prototype

**Audience:** Mahender, Mohammad's team, AAC, CAB.

**Use the prototype to:**
- React to the architectural decisions before the production build kicks off
- Validate UX / feature scope / coverage assumptions
- Borrow code, schemas, ETL queries, or skip everything and start fresh

**Recommendations from handoff:**
1. Read `Phase 1 Design Decisions - 2026-04-29.md` first — eight calls with rationale
2. The eight ETLs in `etl/<source>/` are the most reusable parts. Even if production uses a different framework, the SQL queries, MSSQL/LDAP connection patterns, and authorship-position classification logic are useful starting templates.
3. The `analysis_summary_*` join shape for ReciterDB is documented in `etl/reciter/index.ts`. The institutional client uses `wcmc_*` legacy tables which don't exist in current ReciterDB; this prototype uses the modern path.
4. The search index strategy (per-field boost at query time, authorship weighting at index time via term repetition) is a deliberate choice. If Mohammad's team picks a different search engine, the index-time term-repetition pattern can travel.
5. **NOT in scope for handoff:** AWS provisioning, CAB/AAC approval artifacts, production security review, data privacy / FERPA / HIPAA review for COI display.

---

## Open items requiring stakeholder input (from handoff)

- Confirm ED `preferred_name` field as the slug source (vs `cn` / `givenName + sn`). Currently slugs are derived from `givenName + sn`; if WCM has a separate preferred-name system, the slug source should switch.
- AOI threshold + 6× search boost calibration (also tracked under requirements/calibration TODOs).
- Publication ranking weight calibration against ~20 real WCM profiles spanning seniority (also tracked under requirements/calibration TODOs).
- Citation refresh cadence in reciterdb-prod (also tracked under constraints/calibration TODOs).
- Edit-event logging target (Slack? Email digest? Decided by end of design phase per spec; Phase 7 work).
- Specific completeness threshold for "being populated" affordance and default-search filtering.

---

## Methodology page (must-exist-before-launch)

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` Open Q #1 + "Algorithmic surface guidelines"

The methodology page explains in plain English:
- Per-publication ReCiterAI scoring scope (publication is scored if at least one WCM-attributed author holds Full-Time WCMC Faculty appointment; once scored, score propagates to all WCM-attributed authors)
- Eligibility carve for scholar-centric algorithmic surfaces (Full-time faculty + Postdoc + Fellow + Doctoral student)
- Why Voluntary / Adjunct / Courtesy / Instructor / Lecturer / Emeritus do not appear on Recent contributions / Top scholars surfaces even when they're co-authors on scored publications
- Weekly cadence (matches ReCiterAI's write-to-DynamoDB cadence)
- Highlight selection formula and surface-specific recency curves
- Authorship-position filter (first or senior author only on scholar-attributed surfaces; publication-centric surfaces don't apply this filter)
- Letters / Editorials / Errata hard-exclusion from highlight surfaces

**Owner:** TBD (named as a circulation blocker — design spec doesn't get circulated to Mohammad's team until methodology-page owner is named per v1.2 changelog).

---

## Conversations in flight (per design spec v1.7.1)

All four conversations have committed target dates (subject to other-team bandwidth):

1. Data team — `appointment_status_updated_at` availability (binary commit-by-date answer requested)
2. ReCiter lead — text relevance algorithm consultation (target: 2 weeks out, before search-build kickoff)
3. Editorial copy ownership — top-300 division/subtopic descriptions assigned to "ITS plus an editor seconded from Comms (or contractor)"; two-week window committed for May 2026
4. COI office — integration pattern, refresh cadence, category vocabulary for External relationships ingestion

---

## Component-render logging (operational debugging)

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` v1.7.1 changelog "Absence-as-default monitoring"

For operational debugging at launch and beyond, the application **emits component-render logs** for every profile rendered: which components rendered, which were absent-by-default, which were absent-because-data-missing. Logs are accessible to the Scholars dev team but not a user-facing surface in Phase 1. An OFA-facing coverage dashboard (showing "% of profiles with each component populated, weighted by role") is a Phase 2 candidate if usage warrants.

This is the operational answer to the absence-as-default tradeoff: status pill, mentor/advisor card, AOI pills, External relationships, clinical profile link all use absence-as-default — users cannot distinguish "this scholar legitimately has no advisor" from "the data is missing."

---

## Phase 2+ deferred features (per functional spec phase mapping)

- **source:** `.planning/source-docs/functional-spec-phase-1.md` "Phase mapping (per Mohammad's slides 16–19)"

- **Phase 2 — Data Enhancement:** abstracts display; selected pages (Person, Organizations, etc.); enhanced search; landing-page marketing/highlight content; **schema.org `Person` JSON-LD** once refresh pipeline has run clean for 4–6 weeks; HTML browse / sitemap page.
- **Phase 3 — Self-Edit Expanded:** suppress appointments / grants / education / publications; feature top publications; **delegate editing** (faculty designate one or two named WCM accounts as proxies for overview self-edit).
- **Phase 4 — ASMS Central Faculty Profile:** ASMS faculty profile launch; "Scholar Profile" exposed via micro-service.

Doctoral student profile-inclusion criterion (active doctoral program enrollment) is a **Phase 2+ extension** of ADR-004's strict-delete lifecycle. ED already has this signal; not consumed in Phase 1.

Leaf-level role filter (Voluntary Faculty as a separate checkbox) is a **Phase 2 candidate** — design spec v1.7.1 carves out a "More" expander pattern if the leaf-level filter use case proves common in practice.

Embeddings-based hybrid retrieval ("BM25 + dense biomedical embedding + faculty-status boost") is **deferred to Phase 2** per ADR-007. ReCiter lead consultation on biomedical embedding model selection (PubMedBERT vs BioBERT vs SapBERT vs MedCPT) is a hard prerequisite.

Division detail pages are a **Phase 2 deliverable** per design spec v1.5 changelog. Phase 1 surfaces division-level information through department detail page's divisions rail; users landing on a division URL get redirected to parent department page with division pre-selected.

Center / institute detail pages are **Phase 2** per design spec v1.1 changelog. Phase 1 ships a thin placeholder route at `/centers/{slug}` so browse-hub links don't break.

---

## Working agreements during build

- **source:** `.planning/source-docs/BUILD-PLAN.md` "Working agreements during the build"

- One commit per logical step, atomic and reviewable. No "WIP" commits.
- No real data in commits. `.env` gitignored from start; every fixture is synthetic.
- **No AI attribution** in commits, code comments, or PR text — author the work as the user.
- Confirm before destructive operations. No `git push --force`, no `prisma migrate reset` against populated dev DB without asking.
- Test before reporting done. UI changes get a Playwright snapshot or browser verification; ETL changes get a synthetic-fixture round-trip; type-check + lint must pass before any commit.
- Pause points. End of each phase is a natural pause; don't start the next phase without checking in.

---

## Spec-precedence stack (project-internal)

- **source:** `.planning/source-docs/design-spec-v1.7.1.md` "Status" section

The design spec itself declares:

> Coding agent's source-of-truth precedence (highest first):
> 1. This spec (decisions)
> 2. The HTML sketches under `.planning/sketches/` (visual ground truth for layout, spacing, transitions)
> 3. DESIGN-FORKS.md (background and rationale)
> 4. Functional Spec (data model and routes)

Note: this internal stack is for the design-spec UI/UX domain. The orchestrator-level precedence used during ingest is `ADR > SPEC > PRD > DOC` with charter explicitly downplayed. ADR-006's explicit acknowledgment that it departs from spec verbatim is a deliberate exception that the design-spec internal stack would not otherwise authorize — but the ingest precedence (ADR > SPEC) does authorize, and the design spec itself flags this as an open item via its DAL line.

When there's a conflict between the design spec and the sketches, file an issue rather than picking one — the spec should be updated to match the intended visual, or the sketch was mistaken.
