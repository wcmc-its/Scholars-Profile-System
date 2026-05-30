# docs/ADR-009 — Separate the runtime writer (DML) from the migration runner (DDL)

**Status:** Accepted
**Date:** 2026-05-30
**Authors:** Scholars Profile System development team
**Supersedes:** —
**Superseded by:** —

## Context

SPS enforces least privilege at the database-connection layer with distinct DSN secrets ([`access-control-rbac.md` Layer 3](./access-control-rbac.md), `PRODUCTION_ADDENDUM.md § Secrets`):

| Role / secret | Used by | Privilege on `scholars` today |
|---|---|---|
| `app-ro` | app reads (`db.read`, server components, most routes) | `SELECT` (reader endpoint) |
| `app-rw` | `/api/edit*` writes **and** the migration task | `SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,REFERENCES,INDEX,ALTER,EXECUTE,TRIGGER` + `INSERT` on `scholars_audit.manual_edit_audit` |
| `etl` | the ETL task family | read/write on ETL-managed tables |
| `sps_bootstrap` | the `sps-db-bootstrap` task only (#493) | `CREATE,ALTER` on `scholars_audit.*` + `INSERT … WITH GRANT OPTION` there; nothing on `scholars` |
| `master` | the DataStack seeder + the RDS rotation Lambda only | Aurora admin (never CI-reachable, #493) |

The problem is the second row. **`app_rw` is dual-purpose:** it is the credential the *24/7 application process* uses for runtime writes, and it is *also* the credential the deploy-time `sps-migrate` task uses to run `prisma migrate deploy` ([`app-stack.ts`](../cdk/lib/app-stack.ts), `MigrationTaskDefinition` injects `DATABASE_URL = appRwSecret`). Because migrations create and alter tables, `app_rw` holds **DDL on all of `scholars.*`** — `CREATE`, `DROP`, `ALTER`, `INDEX`, `REFERENCES`, `TRIGGER`.

So the long-running, internet-adjacent application's database credential can **drop or alter the entire schema**. That is the one place in the system where a *runtime* credential holds *destructive schema authority* — and it contradicts the least-privilege posture applied everywhere else:

- **AWS IAM Layer 2** already splits the ECS execution role from the task role precisely "so an app-process compromise gains nothing extra" — the app's task role has **zero** AWS permissions ([`ADR-008` threat model](./ADR-008-infrastructure-as-code.md)).
- The **read/write split** (`app-ro` vs `app-rw`) keeps the read path from writing at all.
- The **audit role** is deliberately `INSERT`-only on a *separate* database so the app cannot `UPDATE`/`DELETE` its own audit trail (#102 / B03).

Per [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md), the runtime is read-only over the ETL-managed content tables; the *only* MySQL writes the application makes at runtime are to the **manual-override tables** (`field_override`, `suppression`, `unit_admin` — [`ADR-005`](./ADR-005-manual-override-layer.md)) plus the in-transaction `scholars_audit` `INSERT`. The runtime writer's *legitimate* footprint is therefore narrow DML — it never needs DDL.

Two findings on 2026-05-30 sharpened this. A grant-breadth audit found staging's `app_rw` at the blunt `ALL PRIVILEGES ON scholars.*` (since aligned to prod's explicit list). Investigating it confirmed that **`app_rw`, `app-ro`, and `etl` are provisioned by a manual DBA step — no repo code grants them** (only `sps_bootstrap` is codified, via the #493 seeder). That manual provisioning is *why* staging drifted. This ADR addresses both the privilege split and the provisioning model.

## Decision

**Introduce a dedicated deploy-time migration role and reduce the runtime writer to DML.** The completed role model on `scholars`:

| Role | Scope on `scholars.*` | Used by | When present |
|---|---|---|---|
| `app-ro` | `SELECT` | app reads | runtime (24/7) |
| `app-rw` | `SELECT,INSERT,UPDATE,DELETE` + `INSERT` on `scholars_audit.manual_edit_audit` | `/api/edit*` writes | runtime (24/7) |
| **`sps_migrate`** *(new)* | `SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,REFERENCES,INDEX,ALTER,EXECUTE,TRIGGER` | the `sps-migrate` task only | deploy-time (seconds) |
| `sps_bootstrap` | `CREATE,ALTER` on `scholars_audit.*` + `INSERT … WITH GRANT OPTION` | the `sps-db-bootstrap` task only | deploy-time (seconds) |

This yields a clean factoring of **DDL authority by domain and lifetime**: `sps_bootstrap` owns `scholars_audit` DDL; **`sps_migrate` owns `scholars` DDL**; `app_rw` owns `scholars` DML + the audit `INSERT`; `app_ro` is read-only. No 24/7 credential holds any DDL.

The following sub-decisions were ratified during review (2026-05-30):

1. **`sps_migrate` inherits `app_rw`'s proven set verbatim — neither extended nor pruned.** The migration privilege surface was settled empirically: a grep of all 25 migration files found **no** `CREATE VIEW`, stored routine, `EVENT`, or even `TRIGGER` usage — consistent with the fact that migrations run under `app_rw` today and would already fail on any privilege it lacks. So the set above is exactly sufficient. **Do not "tidy" `sps_migrate` down to only the privileges today's migrations use:** the exposure-window argument (below) makes its breadth low-stakes, and pruning manufactures a "a future migration needs the privilege we removed" failure for zero security gain.

2. **Runtime-writer DML scope — Option A.** Grant `app_rw` DML on `scholars.*`. A tighter Option B — DML on only the override tables plus `SELECT` elsewhere — is feasible but brittle (a grant edit per new override table) and does not change the headline (no DDL either way). Option B is recorded as a documented future tightening, not adopted.

3. **Provisioning — codify, *conditional on the equality verify shipping alongside it*.** Move the app DB-role grants into the DataStack seeder (which already runs as `master` and mints `sps_bootstrap`, #493), making the role model declarative and drift-proof. **This is the right call *if and only if* the grant-equality verify (below) ships with it.** The verify is load-bearing: *without* it, putting grant logic into the master-privileged seeder is genuinely riskier than the manual status quo — a bug now propagates declaratively, with admin authority. *With* it, codifying is strictly safer: the verify is the mechanism that kills the drift class that caused the staging `ALL PRIVILEGES` incident. **Build the verify first; do not codify without it; do not defer codification once you have it.**

### Threat model

**Asset.** The `scholars` schema and its data. ETL-managed tables are reproducible (a `DROP` costs an outage plus a multi-hour ETL rebuild — an *availability* hit). The manual-override tables and the audit log are **not** ETL-reproducible: a `DROP`/`TRUNCATE` is permanent *integrity* loss of user-authored suppressions, field overrides, unit-role grants, and the tamper-evident audit trail.

**Adversary / vector.** A principal acting with `app_rw`'s privileges via one of: (a) remote code execution in the long-running Next.js process; (b) a SQL-injection reaching a write transaction (i.e., past Prisma's parameterization); (c) exfiltration of the `app_rw` DSN, which is injected as `DATABASE_URL` into the app container for its entire lifetime.

**Blast radius — today.** Any of the above can `DROP`/`ALTER`/`TRUNCATE` (via `DROP`+recreate) any `scholars` table. Catastrophic on both availability (outage + rebuild) and integrity (override + audit data unrecoverable).

**Blast radius — after this ADR.** The runtime credential holds DML only. The worst case degrades from *schema destruction* to *row-level data tampering*, which is already bounded by three existing controls: the separate `INSERT`-only audit log records every override write; SSO + same-origin + unit RBAC gate the write endpoints; and ETL-managed rows are re-derivable. **Schema destruction leaves the runtime blast radius entirely.**

**Exposure-window argument.** The DDL-bearing credential (`sps_migrate`) lives *only* in the one-shot migrate task — present for the seconds of a deploy, never in the 24/7 app. The window in which a DDL-capable credential is exposed to the internet-adjacent surface drops from *always* to *during a migration*.

**Explicitly out of scope (honest limits).**
- **SQL injection itself.** Prisma parameterization is the control; this ADR is OWASP-A03 *defense-in-depth* for when that control fails — not a substitute for it.
- **DML-level tampering**, including forging or altering `unit_admin` privilege rows. A DML-only attacker can still corrupt override data; the audit log + the #393 reconciler are the controls there, not this split. This ADR does **not** claim to stop it.
- **DSN exfiltration is only partially addressed.** A raw stolen `app_rw` DSN still yields a working DML connection that neither the audit log nor endpoint RBAC binds. Reducing the privilege caps what that connection can do; it does not shrink the window the credential is usable. That vector is the subject of the next hardening (see Future work — IAM database authentication, ranked *above* Option B for exactly this reason).
- **Compromise of `sps_migrate` or the migrate task.** It legitimately holds DDL; this ADR shrinks its *exposure window*, not its power.
- **`master` compromise** and the **`etl` role's** scope — unchanged; not addressed here.

**Standards framing.** Least privilege and separation of duties (deploy-time DDL authority vs runtime DML authority); OWASP A03 (Injection) defense-in-depth. The decision mirrors two boundaries the system already enforces — the IAM Layer-2 task-role split and the #102 `INSERT`-only audit role — extending the same reasoning to the last 24/7 credential that violated it.

### Verification model — the equality diff (load-bearing)

The verify is **not** a `can-CREATE` / `cannot-CREATE` smoke test. The failure mode being guarded against is *excess* privilege — that is what drifted in the staging incident, and a capability probe cannot see a role quietly *retaining* a grant the revoke list missed.

**The verify is a `SHOW GRANTS` equality diff against a per-role golden list, failing closed on any delta in *either* direction (excess *or* missing).** For each managed role (`app-ro`, `app-rw`, `sps_migrate`, `sps_bootstrap`) it reads `SHOW GRANTS FOR CURRENT_USER()` (the #607 grantee-side technique — no `mysql.user` read needed), normalizes, and asserts set-equality with the golden list for that role. Any difference fails the deploy.

Two corollaries:

- **The verify is the precondition for codifying** (Decision 3). It must exist and pass against *current* state before any codified grant change runs — both to prove the check works and to pin the golden lists.
- **Honest limit:** the verify proves the *grant shape* equals the golden list; it cannot prove the golden list is itself correct (i.e., that no migration needs a privilege the list omits). That is mitigated by Decision 1 — `sps_migrate`'s list is the set prod has run every migration under to date — and by the rule that introducing a new privilege need is a conscious edit to the golden list, which fails loudly until made.

## Consequences

### Positive
- A runtime app-process compromise **can no longer destroy or alter the schema**; the blast radius is capped at DML.
- Completes the least-privilege DB role model; restores symmetry with the IAM Layer-2 split and the audit role.
- The codify-with-verify mechanism **eliminates the manual-drift class** — the staging `ALL PRIVILEGES` divergence cannot recur (the equality diff fails closed on excess).
- The DDL-bearing credential's exposure window shrinks to deploy-time.

### Negative / accepted
- A fifth DB role and secret to provision, rotate, and document — more moving parts.
- The migrate path depends on a distinct credential; a missing/mis-scoped `sps_migrate` grant fails the deploy. Accepted: fail-closed, mirroring #493.
- Codifying grants widens the (master-privileged) seeder's responsibility to the whole app role model. This is *only* accepted because the equality verify guards it (Decision 3); the two ship together.
- A DML-only `app_rw` can still tamper with override/ETL rows, and a stolen DSN still connects (see threat model). This ADR does not claim otherwise; IAM auth is the follow-on.

### Operational implications
- A new secret `scholars/{env}/db/migrate`, rotated on the existing DB-DSN cadence.
- [`access-control-rbac.md` Layer 3](./access-control-rbac.md) and [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) updated with the fourth role.
- Migration *authoring* is unaffected (`prisma migrate deploy` as before); only the credential it runs under changes.

## Alternatives Considered

1. **Do nothing** (keep `app_rw` dual-purpose with DDL). Rejected: leaves schema destruction in the 24/7 blast radius and is inconsistent with the system's own least-privilege boundaries.
2. **Option B — table-scoped runtime DML.** Tighter, but brittle (grant edits per new override table) and orthogonal to the headline. Recorded as a future tightening; not adopted. (Ranked *below* IAM database auth as a next step — see Future work.)
3. **One role, no DDL, migrate as `master`.** Rejected: putting `master` in the deploy pipeline is exactly what #493 engineered away. A strictly worse trade.
4. **Reuse `sps_bootstrap` as the migrator.** Rejected: it is deliberately scoped to `scholars_audit` only (#102); widening it to `scholars` DDL dissolves that boundary.
5. **Application-level enforcement** (deny DDL in code). Rejected: not a security boundary — a compromised process bypasses app code. The GRANT is the enforceable control.
6. **Manual DBA provisioning** (status quo). Rejected as the default: it is the drift source this ADR fixes. Codifying is adopted instead — gated on the equality verify (Decision 3).
7. **Capability-probe verify** (`can-CREATE`/`cannot-CREATE`). Rejected in favor of the equality diff: a probe cannot detect *retained excess* privilege, which is the actual drift failure mode.

## Implementation (phased, reversible — no window where migrate or writes break)

> **Implementation status (2026-05-30):** Phases 0–2 **landed** as code (the live effects are deploy-time events). Phase 3 pending; it is deploy-gated by Phase 2's cutover confirmation per the sequencing rule below.

- **Phase 0 — verify first. ✅ LANDED (code; live confirm pending first deploy).** Built as [`scripts/verify-db-grants.ts`](../scripts/verify-db-grants.ts) — pure canonicalize + set-equality diff, per-role golden lists (`app-ro` / `app-rw` / `sps_migrate` / `sps_bootstrap`), reading `SHOW GRANTS FOR CURRENT_USER()` as each role (the #607 grantee-side technique). Unit-tested in [`tests/unit/verify-db-grants.test.ts`](../tests/unit/verify-db-grants.test.ts), runnable via `npm run db:verify-grants`, and wired into the deploy pipeline as the `sps-verify-grants-${env}` ECS task ([`app-stack.ts`](../cdk/lib/app-stack.ts)) run **after db-bootstrap and before the service rolls** ([`deploy.yml`](../.github/workflows/deploy.yml), fails-closed). The golden lists are *pinned*; the first live run against current state is what *confirms* them. This phase gates the rest (Decision 3).
- **Phase 1 — additive. ✅ LANDED (code; runs on next DataStack deploy).** The #493 master-privileged seeder ([`db-bootstrap-seed`](../cdk/lambda/db-bootstrap-seed/)) now also mints `sps_migrate` and grants it the proven `scholars.*` set verbatim ([`statements.ts` `migrateSeedStatements`](../cdk/lambda/db-bootstrap-seed/statements.ts), [`seed.ts` `runMigrateSeed`](../cdk/lambda/db-bootstrap-seed/seed.ts)), reusing-or-generating the password into the new `scholars/{env}/db/migrate` secret ([`secrets-stack.ts`](../cdk/lib/secrets-stack.ts), wired in [`data-stack.ts`](../cdk/lib/data-stack.ts); custom-resource `Revision` bumped to force the re-assert). `app_rw` unchanged; the migrate task still runs under `app_rw` — so minting the role has **no effect on the running system**. The verify's `sps_migrate` golden list stays pinned-but-not-yet-live-verified until Phase 2 wires `MIGRATE_DSN` (see Downstream req 4 below — the migrate secret must stay out of the *app* task's exec role, which is the Phase 2 exec-role split).
- **Phase 2 — cutover. ✅ LANDED (code; live confirm pending the next deploy).** The `sps-migrate` task `DATABASE_URL` now resolves to the migrate secret ([`app-stack.ts`](../cdk/lib/app-stack.ts)), and the verify task covers `sps_migrate` (`MIGRATE_DSN` + `VERIFY_ROLES=app-ro,app-rw,sps_migrate,sps_bootstrap`). The exec-role split (Downstream req 4) is the load-bearing piece: a dedicated deploy-time execution role (`deployTaskExecutionRole`, `sps-deploy-exec-<env>`) carries the migrate DSN for the migrate / verify-grants / db-bootstrap tasks, and the 24/7 app task's execution role is held off it entirely — synth-guarded in both directions (the app role's GetSecretValue list excludes the migrate ARN; the deploy role's includes it). The app role is also tightened to its ten own secrets (`bootstrap` moved to the deploy role). `app_rw` still holds DDL, now unused by migrate. **Operator:** deploy `Sps-Secrets-<env>` + `Sps-Data-<env>` (Phase 1 mints `sps_migrate` + populates the secret) **before** the app deploy that switches the task, then run a no-op migration to confirm `sps_migrate` end-to-end. Do **not** start Phase 3 until that confirms.
- **Phase 3 — tighten.** `REVOKE CREATE, DROP, ALTER, INDEX, REFERENCES, EXECUTE, TRIGGER ON \`scholars\`.* FROM 'app_rw'@'<host>'` (surgical, zero-gap — the technique used in the 2026-05-30 `ALL PRIVILEGES` cleanup), leaving `SELECT,INSERT,UPDATE,DELETE` + the audit `INSERT`. Verify `app_rw`'s grant set **equals** the DML golden list exactly.

**Codify as the mechanism for Phases 1 and 3** (the seeder applies the grants as `master` at DataStack deploy), not as a separate later PR — that is the point of codifying. **Sequencing rule:** never tighten `app_rw` (Phase 3) before the migrate task is confirmed on `sps_migrate` (Phase 2), or a deploy's migration would lack DDL. Each phase is independently reversible.

## Downstream requirements (enforceable)

1. The `sps-migrate` task **MUST** inject the migrate DSN, never `app-rw`. A synth/CI guard asserts it.
2. Every managed DB role's live grants **MUST** equal its golden list exactly (no delta in either direction), asserted by the equality verify, fail-closed, before the service rolls.
3. The grant-equality verify **MUST** exist and pass against current state **before** any codified grant change runs (the codification precondition).
4. The migrate secret **MUST NOT** be injectable into the long-running app task — only the migrate task. The app container's execution-role secret enumeration **MUST NOT** list it.
5. The migrate credential **MUST** rotate on the same cadence as the other DB DSNs.
6. `sps_migrate`'s golden list **MUST** be the inherited proven set; extending or pruning it is a conscious, reviewed edit to the golden list, not an incidental change.

## Future work (out of scope here)

**Next hardening — IAM database authentication (short-lived tokens), ranked *above* Option B.** This ADR helps *least* against DSN exfiltration: a raw stolen `app_rw` DSN still connects, and neither the audit log nor endpoint RBAC binds that connection. Short-lived IAM-auth tokens attack that vector directly — they shrink the window the credential is *usable at all*, where Option B only narrows the DML *target*. More leverage, same spirit as this ADR. It warrants its own ADR (Aurora IAM auth, the connector/pooling implications of token refresh, the `rds-db:connect` task-role wiring, and retiring the static DSN secrets).

## Resolved at ratification (2026-05-30)

- Migration privilege surface — settled empirically (grep clean → inherit verbatim).
- Provisioning — codify, gated on the equality verify shipping with it.
- Runtime DML scope — Option A now; Option B deferred (and de-prioritized below IAM auth).

## References

- [`ADR-001`](./ADR-001-runtime-dal-vs-etl-transform.md) — runtime DAL is read-only over the ETL-managed tables; the manual-override layer is the runtime write exception.
- [`ADR-005`](./ADR-005-manual-override-layer.md) — the `field_override` / `suppression` / `unit_admin` tables `app_rw` writes at runtime; #102 / B03 audit role (the `INSERT`-only precedent).
- [`ADR-008`](./ADR-008-infrastructure-as-code.md) — the Layer-2 IAM task-role split this mirrors.
- [`access-control-rbac.md` Layer 3](./access-control-rbac.md), `PRODUCTION_ADDENDUM.md § Secrets / Role split` — the DB role model this amends.
- #493 — the `sps-db-bootstrap` seeder and its fail-loud, master-confined provisioning pattern; #607 — the grantee-side `SHOW GRANTS FOR CURRENT_USER()` technique the verify reuses.
- 2026-05-30 grant-breadth audit — staging `app_rw` `ALL PRIVILEGES` → prod-aligned; the manual-provisioning drift this codifies away.
