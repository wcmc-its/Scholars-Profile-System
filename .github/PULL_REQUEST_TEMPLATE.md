## Summary

<!-- 1–3 bullets on what this PR changes and why. -->

## Linked issues

<!-- `Closes #N` when this PR fully satisfies the issue — GitHub auto-closes it on
     merge. Use `Refs #N` ONLY for partial work, and say what remains.
     A feature that ships dark (flag off in an env) is NOT done: use `Refs #N` and
     keep the issue open, narrowed to the rollout step (flip/deploy/backfill).
     Stale open-but-done issues cause duplicate work — when in doubt, `Closes`. -->

## Test plan

<!-- Bulleted checklist of what was verified locally / in staging. -->

## Schema migration checklist

Required when this PR touches `prisma/schema.prisma`. Delete this section if no schema change. See [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](../docs/PRODUCTION_ADDENDUM.md#schema-migration-policy) for the policy and [`docs/DEPLOY-RUNBOOK.md`](../docs/DEPLOY-RUNBOOK.md) for how the migration task runs in the deploy pipeline.

- [ ] Migration is additive only (no `DROP COLUMN`, no `ALTER COLUMN` changing type).
- [ ] Previous app version still works against the new schema.
- [ ] New app version still works against the old schema until the migration runs.
- [ ] If a backfill is needed, script is in `scripts/backfills/`.
- [ ] If this is the contract step of an expand-contract, the expand has been live for at least the backup retention window.
- [ ] No ETL scholar `create`/`update` payload writes `Scholar.status` — the manual-only invariant ([ADR-005](../docs/ADR-005-manual-override-layer.md)).
