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

## Search ranking / evidence checklist

Required when this PR changes what people search **admits**, **orders**, or **displays as evidence** — a `function_score` term, a field boost, a resolution rule, or an evidence line. Delete this section otherwise. See [`docs/search-relevance-contract.md`](../docs/search-relevance-contract.md) for the rules and the register of open violations; [`docs/search-people-relevance.md`](../docs/search-people-relevance.md) describes the pipeline itself.

- [ ] `hits.total` and every facet bucket count are byte-identical before/after, on every probe query (rule R1). A moved total means the change escaped its layer — diagnose, do not adjudicate the ordering.
- [ ] Flag off produces a byte-identical request body, guaranteed by omitting the key rather than setting it to its identity value (rule R3). This is the rollback story.
- [ ] Any new query-independent prior states a ceiling (rule O3), and no `max_boost` was added to the outer `function_score` to get one (rule O4).
- [ ] If a lexical lever changed: two surface forms of the same concept were probed as a pair and converge (rule O1).
- [ ] Any number newly rendered as query evidence changes when the query changes, and any "N of M" takes both sides from one population (rules E1, E2).
- [ ] The violation register in the contract is updated — a row closed, added, or left deliberately.
- [ ] Effect sizes are reported with the state of every interacting flag attached, and staging numbers are not quoted as prod numbers (rule O5).

## Schema migration checklist

Required when this PR touches `prisma/schema.prisma`. Delete this section if no schema change. See [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](../docs/PRODUCTION_ADDENDUM.md#schema-migration-policy) for the policy and [`docs/DEPLOY-RUNBOOK.md`](../docs/DEPLOY-RUNBOOK.md) for how the migration task runs in the deploy pipeline.

- [ ] Migration is additive only (no `DROP COLUMN`, no `ALTER COLUMN` changing type).
- [ ] Previous app version still works against the new schema.
- [ ] New app version still works against the old schema until the migration runs.
- [ ] If a backfill is needed, script is in `scripts/backfills/`.
- [ ] If this is the contract step of an expand-contract, the expand has been live for at least the backup retention window.
- [ ] No ETL scholar `create`/`update` payload writes `Scholar.status` — the manual-only invariant ([ADR-005](../docs/ADR-005-manual-override-layer.md)).
