# Contributing

## Schema migrations

Prisma migrations are forward-only and run before the new app version starts. Every migration must therefore be backwards-compatible with the currently-running app version, or the rollout window is an outage.

### Every migration is additive

No column is dropped, renamed, or retyped in the same migration as the code that depends on the change. Breaking changes ship as three separate deploys — **expand**, **backfill + dual-write**, **contract**. Full rules and rationale: [`docs/PRODUCTION_ADDENDUM.md` § Schema migration policy](./docs/PRODUCTION_ADDENDUM.md#schema-migration-policy).

### No rollback. Fix forward.

There is no migration rollback. If a new schema causes problems, fix forward with another expand migration. Do not run `prisma migrate resolve --rolled-back` against live traffic — that is a fast path to split-brain between `_prisma_migrations` and the actual schema.

App-code rollback after a successful migration is fine: the new schema is additive by rule, so rolling the ECS service back to the previous image works. The previous version reads the old shape; the new column is unused until the next deploy makes it active. See [`docs/DEPLOY-RUNBOOK.md` § Emergency procedures](docs/DEPLOY-RUNBOOK.md#emergency-procedures) for the operator steps.

### Where migrations run

Migrations run as a one-shot ECS task in the deploy pipeline, using the same image as the new app version, before the ECS service rolls. `prisma migrate dev` is never run anywhere above a developer laptop. `prisma db push` is never run against any environment.

### Backfills

Backfills are not migrations. Keep backfill scripts in [`scripts/backfills/`](./scripts/backfills/README.md), check them in, make them idempotent.

### PR checklist

Every PR that touches `prisma/schema.prisma` must complete the migration checklist in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).

## Documentation — what belongs in this public repo

This is a **public** repository. A doc belongs here only if it is one of:

- **How the live system works** — architecture, ADRs, ops/security runbooks, cost/performance, and specs for **shipped** features.
- **An integration spec** — one living document per upstream source system, under [`docs/integrations/`](./docs/integrations/). See below.
- **A dated audit or snapshot** — goes under [`docs/audits/`](./docs/audits/) with an `as-of YYYY-MM-DD — not maintained` header; never cited as current state.

Everything else stays **out** of this repo and lives in the private working area (`~/Dropbox/Projects/Scholars-Profile-System/`):

- transient working notes — handoffs, debriefs, `NEXT-STEPS`, session notes;
- build-time R&D — plans, analyses, findings, eval/pilot runs, prompt-version dumps;
- specs for features that have **not shipped yet** — promote the spec into this repo when the feature goes live.

Keep host IPs, campus CIDRs (#461), internal hostnames, and DB / service-account names out of committed docs. Secrets Manager holds the values; docs reference names/ARNs only. The curated index is [`docs/DOCUMENTATION-REGISTRY.md`](./docs/DOCUMENTATION-REGISTRY.md).

### Integration specs

One living document per upstream source system, in [`docs/integrations/`](./docs/integrations/). What
we learn from a source owner is mostly not a decision — it is **facts and constraints about their
system**: how the feed behaves, what the fields mean, when it runs, what is excluded, what breaks.
Facts have no alternatives and no consequences to accept, so an ADR is the wrong container, and a
registry entry is one line, not a home for a hundred details.

The three artifact classes divide cleanly:

| Artifact | Answers | For |
|---|---|---|
| [`DOCUMENTATION-REGISTRY.md`](./docs/DOCUMENTATION-REGISTRY.md) | *Where does this field come from?* — one line each | all systems |
| `docs/integrations/<system>.md` | *How does this actually work, and what do I do when it breaks?* | one system, in depth |
| `docs/ADR-NNN-*.md` | *Why did we do it this way rather than the obvious way?* | the few choices with real alternatives |

An integration spec is the **opposite contract from an ADR**: always current, edited freely, no
status header, no immutability. That is precisely why it is a separate file rather than a long ADR
people start editing. Expect three to five ADRs behind a source system, not fifty.

It holds: ownership and contacts (who to call, how to escalate — the first thing a maintainer needs
and the thing least likely to be written down anywhere); mechanics (transport, auth, schedule,
latency, volume, where credentials live); field mapping, with semantics where the two sides differ;
identity resolution at the boundary, and what happens when identifiers do not reconcile; inclusion
and exclusion rules, with the **why** for each — the why is the part that gets lost; known quirks,
their system's actual behavior versus its documentation; failure modes and recovery; and links to
the ADRs for the handful of choices that genuinely were choices.

Two working rules. **Known quirks grows by write-on-surprise** — it will be the highest-value section
within a year, and only if surprises get written down when they happen. And the emails from source
owners are raw material: paste them into the spec's source-correspondence section verbatim as they
arrive rather than leaving them in a mailbox, then extract the durable claims up into the structured
sections periodically. The extraction is cheap; the loss from deferring it is total.

Carry a measurement date inline with every count (`18,113 of 62,474, measured 2026-08-03`). A count
without a date is a lie within a month.
