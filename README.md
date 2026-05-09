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
npm run db:migrate   # Apply Prisma migrations (dev)
npm run db:reset     # Drop + recreate local DB and re-run migrations
npm run seed         # Load synthetic seed data
```

## ETL & indexing

ETL pipelines live in `etl/` and run in-process via `tsx`. Connection details for source systems (ReciterDB, ASMS, InfoEd, etc.) come from `SCHOLARS_*` env vars in `.env.local`; the local app DB uses `DATABASE_URL` from `.env`. See `.env.example` for the full list with naming conventions.

**Source-system env var practice:**

- All credentials live in `~/.zshrc` under generic names (e.g. `DB_HOST`, `DB_PASSWORD`). Never hardcode in `.env*` files committed to git.
- `.env.local` re-exports them under the `SCHOLARS_*` namespace the code actually reads (e.g. `SCHOLARS_RECITERDB_HOST="$DB_HOST"`). The namespace prevents collisions with other tools that grab generic `DB_*` vars.
- We do not maintain separate dev instances of source systems (ReciterDB, ASMS, InfoEd). Local ETL development reads from production. The `etl/reciter/*` scripts in particular only `SELECT`; treat the connection as read-only by convention even when the credentials permit writes.
- The Next.js web app at runtime does not connect to source systems — only the local app DB and OpenSearch. ETL scripts are the sole readers.

### Orchestrated daily run

```bash
npm run etl:daily             # Full chain: ED → all sources → search reindex → completeness → ISR revalidate
```

ED runs first as the chain head (failure aborts the rest). Other sources run sequentially with isolated failures. The search reindex always runs at the end against whatever succeeded.

### Per-source ETLs

```bash
npm run etl:ed                # Enterprise Directory (people, appointments) — chain head
npm run etl:reciter           # Publications + WCM authorships from ReciterDB
npm run etl:asms              # Academic & Scientific Memberships
npm run etl:infoed            # Grants and awards from InfoEd
npm run etl:coi               # Conflict-of-interest disclosures
npm run etl:hierarchy         # ReCiterAI subtopic catalog (writes `subtopic` from S3 hierarchy artifact)
npm run etl:spotlight         # Spotlight research signals
npm run etl:dynamodb          # ReCiterAI topic projections (writes `topic`, `publication_topic`, `topic_assignment` from DynamoDB)
```

### Probes (read-only diagnostics)

```bash
npm run etl:reciter:probe         # Inspect ReciterDB table layout
npm run etl:ed:probe-chiefs       # ED division chiefs probe
npm run etl:ed:probe-divisions    # ED divisions probe
npm run etl:asms:probe            # ASMS source probe
npm run etl:infoed:probe          # InfoEd source probe
```

### Search index

```bash
npm run search:index          # Rebuild OpenSearch indices from the local DB
```

### Other

```bash
npm run etl:completeness      # Completeness/coverage snapshot (best-effort, non-fatal in chain)
npm run etl:vivo-redirect     # Generate the legacy VIVO → Scholars redirect map
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
