# Backfills

One-shot data migrations that read and write rows. Not Prisma migrations.

A backfill never blocks a deploy. It runs after the expand migration is in place and before the corresponding contract migration. See [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](../../docs/PRODUCTION_ADDENDUM.md#schema-migration-policy).

## Convention

- File name: `{YYYY-MM-DD}-{kebab-description}.ts` (e.g. `2026-05-10-populate-author-orcid.ts`).
- Idempotent and re-runnable: every run must be safe to repeat. Use `WHERE` predicates to skip already-processed rows; never assume the script runs to completion on the first try.
- Parameterized: accept a `--dry-run` flag and a row-limit flag where practical, so the script can be sampled in staging before it touches prod.
- Logs progress: print row counts and a final summary so the operator can confirm completion.
- Checked in even though it runs once. The audit trail (who ran what, against which schema state) matters.

## Lifecycle

1. PR adds the expand migration and the backfill script in the same change set.
2. After the expand migration ships, the backfill is run as a one-shot ECS task or local invocation against prod (operator-driven, not pipeline-driven).
3. Once the backfill is verified complete, a follow-up PR adds the contract migration.

The backfill stays in the directory after it has run. Do not delete it.

## What does not belong here

- Schema changes — those are Prisma migrations under `prisma/migrations/`.
- Recurring jobs — those belong in the ETL pipeline, not here.
- Ad-hoc investigation scripts — keep those in `scripts/` (or delete them when done).
