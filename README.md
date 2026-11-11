# Scholars Profile System

A profile system for researchers at Weill Cornell Medicine. Phase 1 replacement for VIVO.

## Status

In production at Weill Cornell Medicine.

**Running outside WCM:** the ETLs read WCM-internal source systems (Enterprise Directory, ReCiter, InfoEd, ASMS, …), which are not reachable from outside the WCM network. A local install runs on the synthetic fixtures from `npm run seed` (about a dozen scholars), which is enough to exercise profiles, search, and the UI.

## Stack

| Layer | Local | Production target |
|---|---|---|
| Framework | Next.js 16 (App Router) | Same, on Fargate |
| Language | TypeScript (strict) | Same |
| Database | MariaDB 11 on host (homebrew) | Aurora MySQL on RDS |
| Search | OpenSearch 2.x (Docker) | OpenSearch Service (managed) |
| ETL | TypeScript via `tsx` | ECS tasks orchestrated by Step Functions |
| Styling | Tailwind 4 + shadcn/ui | Same |
| Testing | Vitest + Playwright | Same |
| CI | GitHub Actions | Same |

For the production deployment shape, caching strategy, and the runbook for "pages are slow," see [`docs/PRODUCTION.md`](docs/PRODUCTION.md).

For a visual map of the system — context, app/AWS topology, network, and edge — see the architecture gallery ([`docs/architecture/index.html`](docs/architecture/index.html)) and the prose [`docs/architecture-overview.md`](docs/architecture-overview.md).

## Prerequisites

- Node.js 24+ (see `.nvmrc`; the production image runs Node 26)
- Docker with at least 6 GB of memory allocated (the OpenSearch container alone uses a 4 GB heap)
- MariaDB 11 on the host (homebrew on macOS; see "Database setup" below)
- npm 10+

## Database setup

The app talks to **host MariaDB on `127.0.0.1:3306`**, not a Dockerized MySQL. The Prisma adapter is `@prisma/adapter-mariadb` and the local DSN in `.env.example` resolves to the host service.

```bash
# macOS — install + start once
brew install mariadb
brew services start mariadb

# Create the scholars user and database (once). Homebrew MariaDB authenticates
# the local admin over the unix socket as your macOS user, so `mysql -uroot`
# is refused; connect as yourself (or `sudo mysql` on Linux).
mysql -u"$(whoami)" <<'SQL'
CREATE DATABASE IF NOT EXISTS scholars CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'scholars'@'localhost' IDENTIFIED BY 'scholars';
GRANT ALL PRIVILEGES ON scholars.* TO 'scholars'@'localhost';
FLUSH PRIVILEGES;
SQL
```

If you have an old `scholars-mysql` Docker container from a previous setup (it shadowed the host DB via a silently-failing `3306:3306` bind), remove it so audits and `docker exec` queries can't accidentally target a stale schema:

```bash
docker rm -f scholars-mysql 2>/dev/null
docker volume rm scholars-profile-system_mysql-data 2>/dev/null
```

After setup, confirm what your `DATABASE_URL` actually points at:

```bash
npm run db:check
```

It prints the host, port, database, server version (MySQL vs MariaDB), and the column count for the `grant` table as a schema sanity check.

### Audit log (`scholars_audit`)

`/api/edit` writes (Hide/Show, field overrides, "Request a change") append a B03
audit row to a **separate** `scholars_audit` database, and the app role needs an
`INSERT` grant there or every edit 500s (the audit INSERT is in-transaction —
#493). Provision it once locally:

```bash
# BOOTSTRAP_DSN = a privileged local login (root) that can CREATE DATABASE + GRANT.
#                 It must accept TCP logins; Homebrew's root is socket-only, so
#                 create a password-auth admin user first if you need one.
# APP_RW_DSN    = your app DSN (the grantee). GRANTEE_HOST=localhost because the
#                 local app user is 'scholars'@'localhost' (Aurora uses '%').
BOOTSTRAP_DSN='mysql://root@127.0.0.1:3306/' \
APP_RW_DSN="$DATABASE_URL" \
GRANTEE_HOST=localhost \
npm run db:audit-setup
```

This is the same runner (`scripts/db-bootstrap.ts`) the deploy pipeline runs as
the `sps-db-bootstrap` task; it applies `scripts/sql/audit-log.sql` and grants the
app role INSERT-only on the audit table, verifying the grant before it exits.

## Local setup

```bash
# 1. Clone
git clone https://github.com/wcmc-its/Scholars-Profile-System.git
cd Scholars-Profile-System

# 2. Install
npm install

# 3. Copy env template. It must be `.env` (not `.env.local`): Prisma and the
#    tsx scripts (db:check, seed, search:index) load `.env` only. Next.js
#    reads both. Never commit either file.
cp .env.example .env

# 4. Start OpenSearch (MariaDB runs on the host — see "Database setup")
npm run db:up

# 5. Verify DB target, then apply the committed migrations
npm run db:check
npx prisma migrate deploy

# 6. Load synthetic data and build the search indexes. The indexer's
#    pre-swap health checks expect the real corpus; SEARCH_INDEX_SKIP_HEALTH=1
#    skips them for seed data (ignored when NODE_ENV=production).
npm run seed
```

### Environment Variables

Set the following environment variable:

| Operating System | Command |
|---|---|
| macOS / Linux | `export SEARCH_INDEX_SKIP_HEALTH=1` |
| Windows PowerShell | `$env:SEARCH_INDEX_SKIP_HEALTH="1"` |
| Windows CMD | `set SEARCH_INDEX_SKIP_HEALTH=1` |
```
npm run search:index
# 7. Run dev server
npm run dev
```

Open <http://localhost:3000>.

`npm run db:migrate` (`prisma migrate dev`) is for **authoring** a new migration. It needs a shadow database, so the DB user must also be able to `CREATE DATABASE` (e.g. `GRANT ALL PRIVILEGES ON *.* TO 'scholars'@'localhost'`); the scoped grant above is enough for `migrate deploy`.

**`/edit` (the editing console) is not reachable on a fresh clone.** It sits behind WCM SAML SSO; outside a configured IdP, dev builds redirect to a local-only `/api/auth/dev-login` route that is not committed to this repo. Public pages (home, profiles, search, browse) work without it.

## Useful commands

```bash
npm run dev          # Next.js dev server (Turbopack)
npm run build        # Production build
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run test         # Vitest unit tests
npm run test:e2e     # Playwright E2E (requires dev server)
npm run format       # Prettier
npm run db:up        # Start OpenSearch via docker compose (MariaDB runs on the host)
npm run db:down      # Stop the local containers
npm run db:check     # Show which DB DATABASE_URL points at + grant schema sanity check
npm run db:migrate   # Author a new Prisma migration (needs CREATE DATABASE for the shadow DB)
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

### MeSH catalog

The MeSH descriptor catalog feeds the §1.5 concept resolver and the §1.6
OR-of-evidence pub search. Three scripts, each on its own cadence:

```bash
npm run etl:mesh              # Full-replace mesh_descriptor from NLM desc<year>.xml (yearly + on demand)
npm run etl:mesh-anchors      # Rebuild mesh_curated_topic_anchor from curated.csv + co-occurrence (on demand)
npm run etl:mesh-coverage     # Refresh mesh_descriptor.local_pub_coverage per descriptor (daily, in etl:daily chain)
```

- `etl:mesh` short-circuits when the upstream NLM file's sha256 matches the
  last successful run, so re-running is cheap. Fetches `desc<currentYear>.xml`
  with a fallback to `desc<currentYear-1>.xml` (covers Jan–Oct before NLM
  ships the new year).
- `etl:mesh-anchors` reads `etl/mesh-anchors/curated.csv` and layers derived
  anchors from a co-occurrence aggregation; tune `MESH_ANCHOR_THRESHOLD`
  and `MESH_ANCHOR_MIN_SUPPORT` env vars if the derived count drifts.
- `etl:mesh-coverage` is in the `etl:daily` chain; only run it standalone
  after a publication-side reload to refresh coverage without waiting for
  the next nightly tick.

Run `etl:mesh` if `mesh_descriptor.name` rows ever look misaligned with
their `descriptor_ui` (see #273 for the historical parser bug that
corrupted the catalog). A full replace is the fix; there is no incremental
repair path.

### Search index

```bash
npm run search:index                  # Rebuild all three OpenSearch indices (people, publications, funding)
npm run search:index:people           # Rebuild only the scholars-people index (~2 min)
npm run search:index:publications     # Rebuild only the scholars-publications index (slow; ~420k docs)
npm run search:index:funding          # Rebuild only the scholars-funding index
```

Each per-source script drops and recreates only its own index; the other two are left intact. Useful when one index drifts out of sync (e.g. after a partial seed) without paying the cost of re-indexing the publications corpus. Under the hood these pass `--people-only` / `--publications-only` / `--funding-only` to `etl/search-index/index.ts`; flags can be combined.

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
