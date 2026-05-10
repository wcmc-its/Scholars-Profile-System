## Summary

<!-- 1–3 bullets on what this PR changes and why. -->

## Test plan

<!-- Bulleted checklist of what was verified locally / in staging. -->

## Schema migration checklist

Required when this PR touches `prisma/schema.prisma`. Delete this section if no schema change. See [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](../docs/PRODUCTION_ADDENDUM.md#schema-migration-policy).

- [ ] Migration is additive only (no `DROP COLUMN`, no `ALTER COLUMN` changing type).
- [ ] Previous app version still works against the new schema.
- [ ] New app version still works against the old schema until the migration runs.
- [ ] If a backfill is needed, script is in `scripts/backfills/`.
- [ ] If this is the contract step of an expand-contract, the expand has been live for at least the backup retention window.
