# Scholars Profile System

A profile system for researchers at Weill Cornell Medicine. Phase 1 replacement for VIVO.

## Status

Local prototype under active development. See the planning artifacts in `~/Dropbox/Index/Scholars Profile System : VIVO Replacement/` (functional spec, charter, design decisions, build plan) for context.

## Stack

| Layer | Local | Production target |
|---|---|---|
| Framework | Next.js 15 (App Router) | Same, on Fargate |
| Language | TypeScript (strict) | Same |
| Database | MySQL 8 (Docker) | Aurora MySQL on RDS |
| Search | OpenSearch 2.x (Docker) | OpenSearch Service (managed) |
| ETL | TypeScript via `tsx` | Lambda + EventBridge |
| Styling | Tailwind 4 + shadcn/ui | Same |
| Testing | Vitest + Playwright | Same |
| CI | GitHub Actions | Same |

For the production deployment shape, caching strategy, and the runbook for "pages are slow," see [`docs/PRODUCTION.md`](docs/PRODUCTION.md).

## Prerequisites

- Node.js 22+
- Docker (with at least 4GB allocated for OpenSearch)
- npm 10+

## Local setup

```bash
# 1. Clone
git clone https://github.com/wcmc-its/Scholars-Profile-System.git
cd Scholars-Profile-System

# 2. Install
npm install

# 3. Copy env template (real credentials live in ~/.zshrc, never committed)
cp .env.example .env.local

# 4. Start MySQL + OpenSearch
npm run db:up

# 5. Run dev server
npm run dev
```

Open <http://localhost:3000>.

## Useful commands

```bash
npm run dev          # Next.js dev server (Turbopack)
npm run build        # Production build
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run test         # Vitest unit tests
npm run test:e2e     # Playwright E2E (requires dev server)
npm run format       # Prettier
npm run db:up        # Start MySQL + OpenSearch via docker compose
npm run db:down      # Stop the local containers
```

## Project layout

```
app/                  # Next.js App Router
  (public)/           # Unauthenticated routes (Phase 2+)
  (authenticated)/    # SAML-gated routes (Phase 7)
  api/                # API route handlers (decision #1: API-first via Next.js)
components/           # UI components (shadcn/ui-derived)
lib/                  # Shared utilities (slug, db, search, url-resolver)
prisma/               # Schema and migrations (Phase 1)
etl/                  # Source-system pipelines (Phase 4)
seed/                 # Synthetic seed data
tests/
  unit/               # Vitest
  e2e/                # Playwright
docs/                 # ADRs and reference docs
```

## Security

- Credentials live in `~/.zshrc` as env vars and are referenced via `process.env.*`. Never hardcoded.
- `.env*` files are gitignored. The `.env.example` documents required variables but contains no real values.
- Real WCM faculty data and CWIDs must never be committed to this public repo.

## Contributing

Work happens in phases per the build plan. One commit per logical step; commits never include AI attribution. CI must be green before merge to `master`.
