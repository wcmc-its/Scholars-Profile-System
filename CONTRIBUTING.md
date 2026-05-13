# Contributing

## Schema migrations

Prisma migrations are forward-only and run before the new app version starts. Every migration must therefore be backwards-compatible with the currently-running app version, or the rollout window is an outage.

### Every migration is additive

No column is dropped, renamed, or retyped in the same migration as the code that depends on the change. Breaking changes ship as three separate deploys — **expand**, **backfill + dual-write**, **contract**. Full rules and rationale: [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](./docs/PRODUCTION_ADDENDUM.md#schema-migration-policy).

### No rollback. Fix forward.

There is no migration rollback. If a new schema causes problems, fix forward with another expand migration. Do not run `prisma migrate resolve --rolled-back` against live traffic — that is a fast path to split-brain between `_prisma_migrations` and the actual schema.

App-code rollback after a successful migration is fine: the new schema is additive by rule, so rolling the ECS service back to the previous image works. The previous version reads the old shape; the new column is unused until the next deploy makes it active.

### Where migrations run

Migrations run as a one-shot ECS task in the deploy pipeline, using the same image as the new app version, before the ECS service rolls. `prisma migrate dev` is never run anywhere above a developer laptop. `prisma db push` is never run against any environment.

### Backfills

Backfills are not migrations. Keep backfill scripts in [`scripts/backfills/`](./scripts/backfills/README.md), check them in, make them idempotent.

### PR checklist

Every PR that touches `prisma/schema.prisma` must complete the migration checklist in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).
