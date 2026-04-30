# Scholars Profile System — Local Prototype Build Plan

_Last updated: 2026-04-29_

## Goal

Build a maximally mature local prototype of Scholars Profile System that demonstrates the eight design decisions in working code. Target audience for the demo: Mahender and Mohammad. AWS deployment deferred until the prototype is reviewed and approved.

## Scope shape

- **Local-first.** Docker Compose for MySQL 8 and OpenSearch 2.x. Next.js dev server. No AWS dependencies during build.
- **Real data, not fixtures.** User has access to all five source systems. ETL pulls real records from ED, ASMS, InfoEd, ReCiter (DynamoDB), COI into the local MySQL.
- **Public repo discipline.** Code committed to `wcmc-its/Scholars-Profile-System` (public). Real data, credentials, and identifiers stay local. Seed/test fixtures are synthetic or anonymized.
- **Implements all eight ratified decisions.** No hand-waving placeholders for the architectural choices made in the design-decisions doc.
- **What's not in scope for the prototype:** SAML production integration (use mock SSO locally), CloudFront / Fargate / RDS provisioning, EventBridge wiring, full VIVO 301 mapping (synthetic test cases only), CAB / AAC approval artifacts.

## Stack

**Managed-services-first design philosophy.** Where AWS offers a managed service that fits the use case, the production target is the managed variant. Local prototype uses Docker equivalents that are wire-compatible with the managed services so deployment is a config change, not a rewrite.

| Layer | Local prototype | AWS production target | Rationale |
|---|---|---|---|
| Framework | Next.js 15, App Router | Same | ISR maturity in App Router (decision #8); React Server Components reduce client JS |
| Language | TypeScript (strict) | Same | Catches schema drift between Prisma and route handlers |
| Database | MySQL 8 (Docker) | **Aurora MySQL** (Aurora Serverless v2 worth evaluating for cost) | Wire-compatible with local MySQL 8; auto-scaling storage, fast failover, read replicas, PITR. Schema and queries are identical to local. |
| Search | OpenSearch 2.x (Docker) | **OpenSearch Service** (managed) | Decision #7 |
| Compute | Next.js dev server | **Fargate** (UI + API single deploy) | Decision #1; managed container runtime |
| ETL compute | TypeScript scripts via `tsx` | **Lambda + EventBridge** for DynamoDB-projection (decision #6); orchestrator triggers via EventBridge cron | Same language as the app; one toolchain. Lambda is managed by default. |
| CDN | None locally | **CloudFront** | Charter line 44 |
| Cache | None locally | **ElastiCache Redis** if needed | Charter line 44; defer until profiling shows need |
| Object storage | Local filesystem | **S3** | Headshots and future assets |
| DNS | localhost | **Route 53** | Charter line 44 |
| Auth | NextAuth credentials provider (mocked) | **AWS-managed SAML** with WCM IdP federation, or Cognito | Production wiring deferred to Phase 7 |
| Styling | Tailwind CSS + shadcn/ui | Same | Fast iteration, consistent components, mobile responsive by default |
| Testing | Vitest (unit), Playwright (E2E) | Same | Vitest is faster than Jest; Playwright matches existing workflow |
| CI | GitHub Actions | Same | Lint, type-check, build, unit tests on every PR |
| Lint / format | ESLint + Prettier | Same | Standard |

## Repo layout

```
Scholars-Profile-System/
├── app/                          # Next.js App Router
│   ├── (public)/
│   │   ├── page.tsx              # Home (decision #8 ISR + CSR search box)
│   │   ├── scholars/
│   │   │   ├── [slug]/page.tsx   # Profile page (ISR)
│   │   │   └── by-cwid/[cwid]/route.ts  # CWID-fallback redirect (decision #3)
│   │   ├── search/page.tsx       # Search results (CSR)
│   │   ├── support/page.tsx      # Static support page
│   │   └── sitemap.xml/route.ts  # Sitemap generator
│   ├── (authenticated)/
│   │   └── edit/[cwid]/page.tsx  # Self-edit UI
│   └── api/
│       ├── scholars/[cwid]/route.ts
│       ├── search/route.ts        # OpenSearch proxy (decision #7, #8)
│       ├── edit/route.ts          # Write path: MySQL + revalidate + OpenSearch (decision #1, #4, #7, #8)
│       ├── revalidate/route.ts    # On-demand revalidation webhook
│       └── health/refresh-status/route.ts  # Decision #5 admin endpoint
├── components/                    # UI components (shadcn/ui-derived)
├── lib/
│   ├── db.ts                      # Prisma client singleton
│   ├── search.ts                  # OpenSearch client + query builders
│   ├── slug.ts                    # Slug derivation (decision #3)
│   ├── auth.ts                    # NextAuth config
│   └── url-resolver.ts            # cwid_aliases + slug_history middleware (decisions #2, #3)
├── prisma/
│   ├── schema.prisma              # Single source of schema truth
│   └── migrations/
├── etl/
│   ├── ed/                        # Enterprise Directory ETL
│   ├── asms/
│   ├── infoed/
│   ├── reciter/                   # MySQL portion + DynamoDB minimal projection
│   ├── coi/
│   ├── search-index/              # OpenSearch reindexer
│   └── orchestrator.ts            # Daily run orchestrator (decision #5)
├── docker-compose.yml             # MySQL + OpenSearch
├── openapi.yaml                   # API contract (decision #1 refinement)
├── seed/                          # Synthetic seed data for tests / demos
├── tests/
│   ├── unit/
│   └── e2e/
├── docs/
│   ├── BUILD.md                   # How to run locally
│   ├── ETL.md                     # Source-system mappings
│   └── ADR-001-runtime-dal-vs-etl-transform.md  # Q6 ADR (open item)
├── .env.example                   # Documents required env vars; never commit real .env
├── .github/workflows/ci.yml
├── README.md
└── package.json
```

## Phases

The build is structured so each phase produces a runnable, committable, demo-able deliverable. Stop after any phase = working subset.

### Phase 0 — Foundation (1 session)

**Goal:** repo cloned, dev environment runs, hello-world page renders.

- Clone `wcmc-its/Scholars-Profile-System` to `~/Dropbox/GitHub/Scholars-Profile-System/`
- Initialize Next.js 15 + TypeScript + Tailwind + shadcn/ui
- Add ESLint, Prettier, Vitest, Playwright skeletons
- `docker-compose.yml` with MySQL 8 and OpenSearch 2.x
- `.env.example` listing required env vars (DB connection, OpenSearch endpoint, ED credentials placeholder, etc.)
- `README.md` with run instructions
- `.github/workflows/ci.yml` with lint + typecheck + build
- First commit, push to `master`

**Deliverable:** `npm run dev` boots; visiting `/` shows a placeholder home page; CI green.

### Phase 1 — Schema and identity layer (1 session)

**Goal:** Prisma schema reflects all decisions; identity layer (CWID, aliases, slug, slug_history) works end-to-end with synthetic data.

- Prisma schema for: `scholar`, `appointment`, `education`, `grant`, `publication`, `publication_author`, `topic_assignment`, `publication_score`, `cwid_aliases`, `slug_history`
- All FKs reference `scholar.cwid` directly (decision #2)
- `scholar.deleted_at TIMESTAMP NULL` with index (decision #4)
- Per-source `last_successful_refresh_at` tracking (decision #5)
- `lib/slug.ts`: NFKD normalize, ASCII-fold, collision suffix, history-write helpers (decision #3)
- `lib/url-resolver.ts`: middleware that resolves `cwid_aliases` → `slug_history` → 404
- Synthetic seed: ~20 fictional scholars covering edge cases (CJK names, hyphens, collisions, name-change history, soft-deleted, departed-with-vivo-redirect)
- Unit tests for slug derivation, URL resolution, alias chain handling

**Deliverable:** `npx prisma migrate dev` succeeds; `npm run seed` populates synthetic data; visiting `/scholars/jane-smith` returns a JSON dump of the scholar record (UI comes in Phase 2).

### Phase 2 — Profile rendering (2 sessions)

**Goal:** profile pages render to spec, ISR works, mobile responsive.

- Profile page UI for all sections in spec lines 24–142:
  - Header (headshot, name, primary title, primary department)
  - Overview statement
  - Contact (email only)
  - Appointments (active default, "Show past" expander, AppointmentsFetchFromED.java logic)
  - Education and training (reverse chronological)
  - Areas of Interest (filtered list)
  - Publications (Selected highlights top-3 + Recent with "Show all", both ranking formulas)
  - Grants (active first, "Show all", GrantsFetchFromED.java logic)
- Empty-state and sparse-profile behavior (spec lines 134–139)
- "What's missing" checklist for authenticated owners — **stubbed in this phase, wired up in Phase 7 when auth lands**
- ISR with `revalidate: 86400` (24h TTL fallback)
- `<link rel="canonical">`, meta description, title tag (spec line 261)
- Mobile responsive (spec line 270)
- shadcn/ui components: Card, Tabs, Badge, etc.

**Deliverable:** seeded scholars render as polished profile pages. Mobile-responsive. SEO essentials in place. No edit affordance (Phase 7).

### Phase 3 — Search (2 sessions)

**Goal:** OpenSearch wired up, per-field boosting works, autocomplete fires on 2 chars.

- OpenSearch index mappings: people index + publications index
- Indexer script: read MySQL → emit OpenSearch documents with all per-field weights from spec lines 156, 165
- Authorship-weighted contributions implemented as term-repetition at index time (×1.0, ×0.4, ×0.1)
- Minimum-evidence threshold logic (spec line 173)
- Sparse-profile filter on default search results (spec line 196)
- `/api/search` proxy route: query builder enforces per-field boosts, faceting, year-range filter
- Autocomplete via completion suggester (spec line 184)
- Search results page UI: People tab + Publications tab, faceted sidebar, numbered pagination 20/page
- WCM coauthor name chips on publication results (spec line 200)
- "Active at WCM" filter is implicit (decision #4 — only active scholars indexed)

**Deliverable:** searching "cardiology" returns weighted results; autocomplete works; faceted filters narrow results; publication results link out to DOI/PubMed.

### Phase 4 — ETL pipelines (3 sessions)

**Goal:** real data flows from all five source systems into the local MySQL on a runnable orchestrator. Establishes the ETL→revalidation→OpenSearch unified write path that Phase 7 self-edit will reuse.

This phase is the most variable in scope depending on what each source system looks like locally. Plan:

**Session 4a — ED ETL.**
- Connect to ED (real credentials in `.env`)
- Pull active scholars (CWID, name, title, primary department, email)
- Pull appointments with active/historical/interim filtering
- Detect `replacement_cwid` → write to `cwid_aliases`, FK migration, drop old row (decision #2)
- Detect departures → soft-delete (decision #4)
- Per-source staging-then-swap atomicity (decision #5)
- ED-first chain order

**Session 4b — ReCiter + DynamoDB minimal projection.**
- Connect to reciter-db-prod (publications, citation counts)
- Connect to ReCiterAI's DynamoDB (publication_score, topic_assignments only — minimal-projection from decision #6)
- C2 architecture: standalone projection script triggered after ReCiter ETL (locally just a sequenced step; AWS Lambda + EventBridge later)

**Session 4c — ASMS, InfoEd, COI + orchestrator.**
- ASMS: education and training records
- InfoEd: grants with the GrantsFetchFromED.java filter logic
- COI: whatever COI fields surface in profile (TBD — confirm with spec/charter what COI contributes to Phase 1)
- Orchestrator: runs all five in chain order with abort-cascade on ED failure (decision #5)
- `/api/health/refresh-status` endpoint (admin-gated; auth wiring in Phase 7, route returns 401 stub until then)
- `/api/revalidate` webhook route (called by ETL writes to fire `revalidatePath` and OpenSearch upsert — same handler self-edit will reuse in Phase 7)
- Search-index reindexer runs after orchestrator completes
- Cleanup job: hard-delete `WHERE deleted_at < now() - INTERVAL 60 DAY` (decision #4)

**Deliverable:** running `npm run etl:daily` populates the local DB with real WCM data; profile pages render real scholars; ETL writes trigger ISR revalidation and OpenSearch upsert through the unifying webhook.

### Phase 5 — SEO + URL machinery (1 session)

**Goal:** sitemap, redirects, canonicals all production-quality.

- `sitemap.xml` route handler enumerates all active scholars by canonical slug
- `robots.txt` (static asset)
- `/scholars/by-cwid/:cwid` 301 → current slug (decision #3)
- Slug-history 301 chain
- VIVO 301 simulation: middleware that handles `/vivo/*` paths (mock VIVO URLs) and routes through the resolver to current canonical or to `/search?q=<name>` for departed scholars (decision #4)
- Canonical tag verification across all page types

**Deliverable:** sitemap.xml validates; all redirect chains work; mock VIVO paths route correctly.

### Phase 6 — Polish, analytics, docs (1–2 sessions)

**Goal:** read-side demo-ready. Auth/edit still pending in Phase 7.

- Analytics instrumentation (spec lines 277–283): page views, search queries, CTR by position, redirect 404 rate, profile completeness metric. Self-edit completion rate is stubbed until Phase 7. Tooling target TBD per spec, so use a structured-log approach for the prototype.
- `docs/BUILD.md` end-to-end run guide
- `docs/ETL.md` source-system mapping reference
- `docs/ADR-001-runtime-dal-vs-etl-transform.md` (the Q6 ADR called out in the decisions doc)
- `openapi.yaml` written and validated (read endpoints; write endpoints get added in Phase 7)
- Demo script: walkthrough of read-side decisions in action (#1 API routes, #2 identity, #3 URLs, #4 departures, #5 ETL, #6 DynamoDB projection, #7 search, #8 ISR — minus the human-edit entry point)
- README polish: screenshots, architecture diagram, build instructions

**Deliverable:** a Mahender/Mohammad walkthrough of the read side and ETL.

### Phase 7 — Self-edit + auth (1–2 sessions)

**Goal:** authenticated overview edit, write-through to MySQL + OpenSearch + ISR revalidation. Closes the loop on the unifying webhook (decisions #1, #7, #8).

- NextAuth.js with credentials provider stub (mock SAML for local dev; production wiring is AWS-managed SAML or Cognito with WCM IdP federation)
- `/api/edit` route: validate session, validate edit (3000 char limit, allowed formatting per spec line 234), write MySQL, fire `revalidatePath`, upsert OpenSearch doc — reuses the `/api/revalidate` webhook plumbing established in Phase 4
- WYSIWYG editor (TipTap or similar) with the limited formatting allowlist
- Edit-event log to a local file (placeholder for Slack/email digest target — TBD per spec open item)
- Admin override actions (suppress) — minimal admin UI
- Wire up the "What's missing" checklist on profile pages (stubbed in Phase 2) for authenticated owners viewing their own profile
- Wire `/api/health/refresh-status` admin auth gate (route was stubbed in Phase 4 with a 401)
- Self-edit completion rate analytics (stubbed in Phase 6)
- `openapi.yaml` extended to cover write endpoints
- Playwright E2E test: log in → edit overview → save → verify public page updates within seconds

**Deliverable:** end-to-end self-edit flow works; all eight decisions demonstrated; demo is fully complete for Mahender/Mohammad.

## Working agreements during the build

- **One commit per logical step**, atomic and reviewable. No "WIP" commits.
- **No real data in commits.** `.env` is gitignored from the start; every fixture is synthetic.
- **No AI attribution** in commits, code comments, or PR text — author the work as the user.
- **Confirm before destructive operations.** No `git push --force`, no `prisma migrate reset` against a populated dev DB without asking.
- **Test before reporting done.** UI changes get a Playwright snapshot or browser verification; ETL changes get a synthetic-fixture round-trip; type-check + lint must pass before any commit.
- **Pause points.** End of each phase is a natural pause; don't start the next phase without checking in.

## Risk register

| Risk | Mitigation |
|---|---|
| Source-system credentials not actually accessible from local machine | Phase 4 surfaces this; fall back to anonymized fixtures of small scholar set if blocked |
| OpenSearch local resource consumption (Docker memory) | Allocate 4GB to Docker; document the requirement; Meilisearch fallback if user's machine struggles |
| Real WCM data accidentally committed | `.gitignore` `.env*`, `data/`, `*.dump`, `*.sql.gz`; pre-commit hook scanning for CWID-shaped strings (4 letters + 4 digits regex) |
| Spec ambiguity emerges during build (e.g., COI contribution unclear) | Flag on encounter, decide in chat, update decisions doc |
| Decision change required after build starts | Track in a `BUILD-DEVIATIONS.md` next to this file; update decisions doc at the end |

## Estimated effort

10–14 sessions assuming Phase 4 (ETLs) goes cleanly. ETL phase has the most variance — could double if source-system shapes are messy. Phase 7 (auth/self-edit) is deliberately last so the bulk of the demo lands without auth complexity in the way.

## Open items to resolve before Phase 0

1. **Confirm repo clone target.** Default is `~/Dropbox/GitHub/Scholars-Profile-System/`. Override?
2. **Confirm stack.** Tailwind + shadcn/ui acceptable, or different design system preferred?
3. **Confirm GitHub Actions vs alternative CI.** GHA assumes the public repo continues to be the single source — that's standard but worth confirming.
4. **Confirm "real data, locally" plan.** ETL credentials in `~/.zshrc` per global security policy. Source-system endpoints reachable from your machine (VPN, etc.)? Any source not reachable will need a fallback.
5. ~~Mock SAML approach.~~ Deferred to Phase 7.

Once items 1–4 are resolved, Phase 0 begins.
