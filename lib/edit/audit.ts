/**
 * Self-edit v1 / B03 — the append-only audit write (#102, #354;
 * `docs/b03-audit-log.md`).
 *
 * Every successful `/api/edit/*` write — a field override, a suppression
 * create, or a suppression revoke — appends exactly one row to
 * `scholars_audit.manual_edit_audit`, inside the **same transaction** as the
 * manual-layer write it audits. The table is deliberately not a Prisma model:
 * keeping it out of the ORM means `UPDATE` / `DELETE` against an audit row are
 * not expressible in application code at all. The insert is a parameterized
 * `$executeRaw` against the fully-qualified name; the application role is
 * granted `INSERT` and nothing else (`scripts/sql/audit-log.sql`).
 *
 * `row_hash` is row-level tamper-evidence (#102): a SHA-256 over the row's
 * canonical content. The recipe (`docs/b03-audit-log.md` § row_hash) is a
 * **JSON array — positional, fixed order** — so object-key ordering cannot
 * change the digest. Callers MUST build the `before`/`after` JSON values
 * deterministically; `id` is excluded — the DB assigns it after the hash.
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The action discriminator (#354). */
export type AuditAction = "field_override" | "suppression_create" | "suppression_revoke";

/** The target type — mirrors the table ENUM; v1 emits only `scholar` / `publication`. */
export type AuditEntityType =
  | "scholar"
  | "publication"
  | "grant"
  | "education"
  | "appointment";

/** One audit row, before the DB assigns its `id`. */
export interface AuditRow {
  /** the signed-in actor (B01 SSO session subject) */
  actorCwid: string;
  targetEntityType: AuditEntityType;
  /** `scholar.cwid` or `publication.pmid` */
  targetEntityId: string;
  action: AuditAction;
  /** field names for a `field_override` (e.g. `["overview"]`); `null` for a suppression */
  fieldsChanged: string[] | null;
  /** pre-state — `null` where there is none (a `suppression_create` `before`) */
  beforeValues: Record<string, unknown> | null;
  /** post-state */
  afterValues: Record<string, unknown> | null;
  /** write-path-set; it is hashed, so it is fixed before the INSERT */
  ts: Date;
  /** request-correlation id; ties the row to its `edit_authz_denied` / `self_suppression` lines */
  requestId: string | null;
}

/**
 * The B03 `row_hash` (`docs/b03-audit-log.md` § row_hash recipe): SHA-256 hex
 * over a fixed-order JSON array of the row's content. `ts` enters the hash as
 * its ISO-8601 string with milliseconds. To verify a stored row, recompute
 * over its columns (the `ts` column reconstructed as ISO-8601) and compare.
 */
export function computeRowHash(row: AuditRow): string {
  const canonical = JSON.stringify([
    row.actorCwid,
    row.targetEntityType,
    row.targetEntityId,
    row.action,
    row.fieldsChanged,
    row.beforeValues,
    row.afterValues,
    row.ts.toISOString(),
    row.requestId,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** A `JSON` column receives a `JSON.stringify`'d string, or SQL `NULL`. */
function jsonOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

/**
 * Append exactly one audit row.
 *
 * `tx` MUST be the interactive-transaction client of the **same** `$transaction`
 * as the manual-layer write, so the two commit atomically
 * (`docs/b03-audit-log.md` § write contract): if this INSERT throws, the whole
 * transaction rolls back — no manual-layer row, no `Scholar.status` change, and
 * no orphan audit row (`self-edit-spec.md` edge case 14).
 */
export async function appendAuditRow(
  tx: Pick<PrismaClient, "$executeRaw">,
  row: AuditRow,
): Promise<void> {
  const rowHash = computeRowHash(row);
  // `manual_edit_audit.ts` is DATETIME(3) — no timezone. Store the UTC
  // wall-clock so a verifier can reconstruct the exact ISO-8601 string
  // `row_hash` was computed over (`computeRowHash` hashes `ts.toISOString()`).
  const tsUtc = row.ts.toISOString().replace("T", " ").replace("Z", "");

  const inserted = await tx.$executeRaw`
    INSERT INTO scholars_audit.manual_edit_audit
      (actor_cwid, target_entity_type, target_entity_id, action,
       fields_changed, before_values, after_values, row_hash, ts, request_id)
    VALUES (
      ${row.actorCwid}, ${row.targetEntityType}, ${row.targetEntityId}, ${row.action},
      ${jsonOrNull(row.fieldsChanged)}, ${jsonOrNull(row.beforeValues)},
      ${jsonOrNull(row.afterValues)}, ${rowHash}, ${tsUtc}, ${row.requestId}
    )`;

  // A single-row INSERT affects exactly one row or throws; anything else is a
  // corrupt state — fail the transaction rather than commit a doubtful audit.
  if (inserted !== 1) {
    throw new Error(`audit insert affected ${inserted} rows, expected 1`);
  }
}
