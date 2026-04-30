<!-- GSD:project-start source:PROJECT.md -->
## Project

**Scholars Profile System**

The Scholars Profile System is Weill Cornell Medicine's modern, AWS-native replacement for VIVO — a public scholar profile platform at `scholars.weill.cornell.edu` showcasing WCM faculty to patients, prospective collaborators, funders, students, journalists, and the broader research community. A working local prototype is live (8,943 active faculty rendered against real WCM source systems); this milestone completes the public-launch surface area: headshot integration, four design-spec page types, the algorithmic surfaces locked under design spec v1.7.1, SEO/URL machinery, analytics, OpenAPI artifact, and authenticated self-edit.

**Core Value:** WCM faculty profiles, search, and algorithmic surfaces serve as a usable VIVO replacement for the WCM scholar community — and Mohammad's production team can consume the prototype as reference implementation for the AWS-native production build.

### Constraints

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
- **Publication ranking**: Multiplicative formula (Variant B), surface-keyed recency curves; scholar-attributed surfaces (profile Selected highlights, home Recent contributions) restricted to first-or-senior author at pool selection; Topic Recent highlights does NOT apply the authorship-position filter (any author position contributes to the pool); Top scholars chip row applies the filter at the per-scholar aggregation step (publication-centric pool, but only the scholar's first-or-senior papers sum into their chip-row score) — locked by design spec v1.7.1 + Phase 2 D-13
- **Algorithmic-surface eligibility carve**: Recent contributions restricted to Full-time faculty + Postdoc + Fellow + Doctoral student; Top scholars chip row narrows further to Full-time faculty only (PI surface) per Phase 2 D-14 — locked by design spec v1.7.1 role model + Phase 2 overrides
- **ReCiterAI scoring data floor**: `publication_score` covers publications from 2020 onward only (ReCiterAI scoring start). Selected highlights surface is bound by this floor — pre-2020 landmark publications appear in the most-recent-papers feed but not on Selected highlights; documented on `/about/methodology#selected-highlights` — locked by Phase 2 D-15
- **Selected highlights / most-recent feed dedup**: Within a single profile-page render, papers that surface as Selected highlights are filtered out of the most-recent-papers feed (or vice versa) to avoid the structural overlap on the 6–24 month range — locked by Phase 2 D-16
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
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
