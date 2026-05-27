# B03 — Manual-edit audit log

**Status:** Active — audit schema built (`scripts/sql/audit-log.sql`); the `/api/edit` write that inserts rows is delivered by [#356](https://github.com/wcmc-its/Scholars-Profile-System/issues/356).
**Date:** 2026-05-17
**Authors:** Scholars Profile System development team
**Implements:** [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) (B03 — append-only audit log), with the row shape generalized by [#354](https://github.com/wcmc-its/Scholars-Profile-System/issues/354)
**Builds on:** [ADR-005](./ADR-005-manual-override-layer.md) § Write-path failure model, § Relationship to the B03 audit log
**Consumed by:** [`self-edit-spec.md`](./self-edit-spec.md) § Write-path behavior — the write path that appends these rows

---

## What this is

Every successful `/api/edit/*` write — a field override, a suppression create, or a suppression revoke — appends exactly one row to an audit log: who did what to which entity, with before/after values, inside the **same MySQL transaction** as the data write. It is the artefact a compliance or curatorial review asks for ("what did the dean's office change about Smith's profile last March?"); ADR-005 and `PRODUCTION_ADDENDUM.md` both note it is materially harder to build after the fact.

This document records the audit log's storage design and the write contract the self-edit feature (#356) consumes. It does not design the write path itself — that is #356.

## Why a separate database

The audit table lives in its own MySQL database, **`scholars_audit`**, on the **same server / Aurora cluster** as the application database. Two properties drive that:

- **Same server** — one MySQL transaction can span the application database and `scholars_audit`, so the manual-layer row (`field_override` / `suppression`) and its audit row commit atomically (ADR-005 § Write-path failure model). A cross-database `INSERT` on a single connection is ordinary MySQL.
- **Separate database** — the application role is granted `INSERT` and *nothing else* on `scholars_audit`, while retaining full DML on the application database. That asymmetric grant is what makes the log append-only: an `UPDATE` or `DELETE` against an audit row fails at the database.

The table is deliberately **not** a Prisma model and not in `prisma/schema.prisma`. Prisma's datasource binds to a single database and Prisma has no MySQL multi-schema support, so it could not model a second database cleanly anyway — but the load-bearing reason is defensive: keeping the table out of the ORM means `prisma.manualEditAudit.update(...)` / `.delete(...)` do not exist as callable code. The write path inserts with `tx.$executeRaw` against the fully-qualified name. (Mechanism chosen 2026-05-17 over a same-database table guarded only by a table-level grant; the separate database honors ADR-005's "separate schema" literally and removes mutation from the application's type surface.)

## The table

`scholars_audit.manual_edit_audit` — full DDL in [`scripts/sql/audit-log.sql`](../scripts/sql/audit-log.sql). The row shape is #102's, generalized per #354 so it records a suppression event and a non-scholar target, not only a scholar field-diff.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | Monotonic, DB-assigned. A gap in the sequence is extra tamper-evidence. Not part of `row_hash`. |
| `actor_cwid` | `VARCHAR(32)` | The signed-in actor (B01 SSO session subject). |
| `target_entity_type` | `ENUM(scholar, publication, grant, education, appointment)` | #354 — mirrors ADR-005's `EntityType`. v1 emits only `scholar` / `publication`. |
| `target_entity_id` | `VARCHAR(64)` | `scholar.cwid` or `publication.pmid`. |
| `action` | `ENUM(field_override, field_override_clear, suppression_create, suppression_revoke)` | #354 discriminator. `field_override_clear` (#356 Phase 7) is the slug-card "Clear override" — deletes one `field_override` row. |
| `fields_changed` | `JSON` NULL | Array of field names for `field_override` (e.g. `["overview"]`); `NULL` for a suppression event. |
| `before_values` | `JSON` NULL | Field override: pre-edit value(s). Suppression: `reason` / `contributor_cwid` / revoke payload. |
| `after_values` | `JSON` NULL | As above, post-state. |
| `row_hash` | `CHAR(64)` | SHA-256 hex over the row's canonical content (recipe below). |
| `ts` | `DATETIME(3)` | Write-path-set — it is hashed, so it must precede the `INSERT`. No DB default. |
| `request_id` | `VARCHAR(64)` NULL | Correlation id to request logs (`edit_authz_denied`, `self_suppression`). |

Two indexes — `(target_entity_type, target_entity_id, ts)` and `(actor_cwid, ts)` — serve the #102 spot-check ("changes to scholar X by actor Y in range Z").

### How each action populates the row

| `action` | `target_*` | `fields_changed` | `before_values` / `after_values` |
|---|---|---|---|
| `field_override` | `scholar`, cwid | `["overview"]` or `["slug"]` | `{ "<field>": "<old>" }` / `{ "<field>": "<new>" }` — the sanitized values, matching what `field_override.value` stores |
| `field_override_clear` | `scholar`, cwid | `["slug"]` | `before`: `{ "slug": "<old>" }`. `after`: `{ "slug": null }`. v1 clears only `slug` — clearing `overview` is the existing `field_override` with `""`. |
| `suppression_create` | the suppressed entity | `NULL` | `before`: `null`. `after`: `{ suppression_id, contributor_cwid, reason }` |
| `suppression_revoke` | the suppressed entity | `NULL` | `before`: `{ suppression_id, … }`. `after`: `{ revoked_by, revoked_at }` |

## `row_hash` recipe

`row_hash` detects mutation of a single row (#102: "tamper-evidence on the row itself"). It is **not** a hash chain — chaining is a possible future hardening, not v1.

The write path computes it, before the `INSERT`, as a SHA-256 over a **canonical** JSON serialization — a positional array, with every nested object's keys sorted recursively so the digest never depends on key order:

```
row_hash = sha256_hex( canonicalJSON([
  actor_cwid,            // string
  target_entity_type,    // string
  target_entity_id,      // string
  action,                // string
  fields_changed,        // array | null   — element order preserved
  before_values,         // object | null  — keys sorted recursively
  after_values,          // object | null  — keys sorted recursively
  ts,                    // ISO-8601 with milliseconds, e.g. "2026-05-17T14:03:01.234Z"
  request_id             // string | null
]) )
```

`canonicalJSON` sorts object keys at every depth, then `JSON.stringify`s — it is `canonicalize` in `lib/edit/audit.ts`. The canonical form is **load-bearing**: MySQL `JSON` columns normalize (re-sort) object keys on storage, so a digest taken over insertion-order JSON could not be reproduced from the stored `before_values` / `after_values`. `id` is excluded — it is assigned by the DB after the hash is computed. To verify a row, rebuild the array from its stored columns and recompute with the *same* `canonicalJSON` (the `ts` column reconstructed as its ISO-8601 string), then compare (see the query below).

## INSERT-only grant and retention

The application role is granted `INSERT` on `scholars_audit.manual_edit_audit` and nothing else — grant template and `SHOW GRANTS` verification are at the foot of `scripts/sql/audit-log.sql`. This is a #102 acceptance criterion: the app role's grants must show no `UPDATE` / `DELETE` on the audit database.

**Retention.** #102 calls for a documented retention policy and recommends ≥ 7 years for faculty data. Recommendation: **retain 7 years, then purge** — pending confirmation from WCM compliance / records management, whose call the authoritative term for institutional faculty records is, not this document's.

Purging is a `DELETE`, which the application role cannot perform — by design. Retention enforcement therefore runs as a **separate privileged role** (a scheduled DBA job, or a dedicated retention task with `DELETE` scoped to `scholars_audit`), never the application role. Until that job exists the table only grows; at the expected `/api/edit` volume that is immaterial for years, so the purge job is a post-launch follow-up, not a launch blocker.

## The write contract (for #356)

The self-edit write path (#356, `lib/edit/*`) performs, inside one `prisma.$transaction`:

1. the manual-layer write (`field_override` upsert / `suppression` insert or revoke);
2. for a scholar suppression or revoke, the `Scholar.status` projection (ADR-005);
3. **exactly one** audit insert:

```ts
await tx.$executeRaw`
  INSERT INTO scholars_audit.manual_edit_audit
    (actor_cwid, target_entity_type, target_entity_id, action,
     fields_changed, before_values, after_values, row_hash, ts, request_id)
  VALUES (${actorCwid}, ${targetType}, ${targetId}, ${action},
          ${fieldsChangedJson}, ${beforeJson}, ${afterJson},
          ${rowHash}, ${ts}, ${requestId})`;
```

`$executeRaw` is parameterized — no string interpolation. The fully-qualified `scholars_audit.manual_edit_audit` resolves on the application connection regardless of its default database. The JSON columns receive `JSON.stringify`'d strings. If the audit insert throws, the whole transaction rolls back — no manual-layer row, no `Scholar.status` change, no orphan audit row (`self-edit-spec.md` edge case 14).

If B03 is ever relocated off-cluster (a separate audit store, CloudWatch), this atomicity breaks and the audit write must become a retried post-commit step — flagged by ADR-005, repeated here so the move is a conscious one.

## Applying the schema

`scripts/sql/audit-log.sql` is idempotent (`IF NOT EXISTS` throughout). Run it against the **same server** as the application database, with a privileged account:

```
mysql -h <host> -u <admin> -p < scripts/sql/audit-log.sql
```

then apply the `GRANT` template at the foot of that file with the real app user. The file is not a Prisma migration and is not picked up by `prisma migrate deploy`.

**Codified path ([#493](https://github.com/wcmc-its/Scholars-Profile-System/issues/493)).** Staging / prod no longer rely on a remembered manual step. `scripts/db-bootstrap.ts` runs as the one-shot `sps-db-bootstrap-${env}` Fargate task in the deploy pipeline **before** `sps-migrate`: it applies this DDL and the INSERT grant, and **verifies** the app role's `scholars_audit` privileges are INSERT-only before exiting. A non-zero exit halts the deploy (fails-closed) — so a missing or over-broad grant errors *loud and early* at deploy instead of silently breaking edits at runtime. It connects as the least-privilege `sps_bootstrap` user (`CREATE`/`ALTER` on `scholars_audit.*` + `INSERT` there `WITH GRANT OPTION`, nothing on `scholars`), never the Aurora master; the one-time master use that seeds `sps_bootstrap` is confined to a DataStack custom resource. Local dev: `npm run db:audit-setup` (see README § Audit log).

## #102 acceptance criteria

| #102 criterion | Status |
|---|---|
| Audit table in a separate schema | ✅ `scholars_audit.manual_edit_audit` via versioned SQL (`scripts/sql/audit-log.sql`) — a separate database, not a Prisma migration (see § Why a separate database) |
| App role `INSERT` only, verified | ✅ Applied + verified automatically by the `sps-db-bootstrap` deploy task (`scripts/db-bootstrap.ts`), which runs `SHOW GRANTS` and fails the deploy on any non-INSERT privilege on `scholars_audit` (#493); grant template + manual `SHOW GRANTS` also at the foot of `scripts/sql/audit-log.sql` |
| One audit row per successful `/api/edit*` POST, same transaction | Contract specified above; wired by #356 |
| Spot-check query returns readable before/after JSON | ✅ below |
| Documented retention policy | ✅ 7 years recommended, pending WCM compliance confirmation |

## Operational queries

```sql
-- Spot-check (#102 AC): every change to one scholar by one actor in a range.
SELECT id, action, target_entity_type, target_entity_id,
       fields_changed, before_values, after_values, ts, request_id
FROM scholars_audit.manual_edit_audit
WHERE target_entity_type = 'scholar'
  AND target_entity_id   = :scholar_cwid
  AND actor_cwid         = :actor_cwid
  AND ts >= :from AND ts < :to
ORDER BY ts;

-- Full edit history of one entity, any actor.
SELECT id, actor_cwid, action, fields_changed, before_values, after_values, ts
FROM scholars_audit.manual_edit_audit
WHERE target_entity_type = :entity_type AND target_entity_id = :entity_id
ORDER BY id;

-- Tamper check: rows over which to recompute row_hash and compare (see § recipe).
SELECT id, actor_cwid, target_entity_type, target_entity_id, action,
       fields_changed, before_values, after_values, ts, request_id, row_hash
FROM scholars_audit.manual_edit_audit
WHERE ts >= :from AND ts < :to
ORDER BY id;
```

## References

- [#102](https://github.com/wcmc-its/Scholars-Profile-System/issues/102) — B03 append-only audit log; [#354](https://github.com/wcmc-its/Scholars-Profile-System/issues/354) — generalized row shape.
- [ADR-005](./ADR-005-manual-override-layer.md) — § Write-path failure model, § Relationship to the B03 audit log.
- [`self-edit-spec.md`](./self-edit-spec.md) — § Write-path behavior, the write path that appends these rows.
- [`PRODUCTION_ADDENDUM.md`](./PRODUCTION_ADDENDUM.md) — § `/api/edit`, the original B03 sketch this document supersedes for the row shape.
