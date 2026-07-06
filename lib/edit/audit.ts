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
 * `row_hash` is row-level tamper-evidence (#102): a SHA-256 over a **canonical**
 * JSON serialization of the row (`docs/b03-audit-log.md` § row_hash) — a
 * positional array whose nested objects have their keys sorted recursively, so
 * the digest is independent of object-key order. That matters because MySQL
 * `JSON` columns re-sort object keys on storage: hashing insertion-order JSON
 * would leave a row un-verifiable from its own stored columns. `id` is excluded
 * — the DB assigns it after the hash.
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@/lib/generated/prisma/client";

/** The action discriminator (#354). */
export type AuditAction =
  | "field_override"
  | "field_override_clear"
  | "suppression_create"
  | "suppression_revoke"
  /** a "Request a change" email routed to the owning office (#160 Phase 2) */
  | "request_change"
  /** a scholar filed a slug request (#497 PR-3) */
  | "slug_request"
  /** a superuser approved a slug request — writes the override + reconciles (#497 PR-3) */
  | "slug_request_approved"
  /** a superuser rejected a slug request (#497 PR-3) */
  | "slug_request_rejected"
  /** a scholar withdrew their own pending slug request (#497 PR-3) */
  | "slug_request_withdrawn"
  /** a manually-owned center or manually-created division was created (#540 Phase 1) */
  | "unit_create"
  /** a CenterMembership / DivisionMembership row was added or removed (#540 Phase 1) */
  | "roster_change"
  /** a UnitAdmin row was inserted or hard-deleted (#540 Phase 1) */
  | "grant_change"
  /** a superuser began a "View as" impersonation session (#637 R5 — enter) */
  | "impersonation_start"
  /** a superuser ended (or expired out of) a "View as" session (#637 R5 — exit) */
  | "impersonation_end"
  /** a scholar rejected a publication as not theirs via /edit → ReCiter gold
   *  standard (#746); `targetEntityId` is the pmid, `afterValues` carries the
   *  suppression + pending-refresh ids and the rejected contributor cwid */
  | "publication_reject"
  /** a scholar dismissed ("Not relevant") a publication-derived COI-gap
   *  candidate on the self-only "From your publications" panel
   *  (`SELF_EDIT_COI_GAP_HINT`); `targetEntityId` is the candidate id,
   *  before/after carry the status transition. Self-scoped, never a
   *  compliance trail — the only thing logged is the scholar's own action. */
  | "coi_gap_dismiss"
  /** a scholar UNDID COI-gap feedback ("Undo") — the inverse of
   *  `coi_gap_feedback`/`coi_gap_dismiss`, restoring the suggestion to their
   *  advisory view and clearing the recorded reason. Same self-scoped,
   *  non-compliance posture. */
  | "coi_gap_restore"
  /** a scholar (or a superuser on their behalf) recorded a 3-way response on a
   *  publication-derived COI-gap suggestion — `will_disclose` (→ status
   *  acknowledged) | `historical` | `invalid` (→ dismissed). Supersedes the
   *  binary `coi_gap_dismiss`; `targetEntityId` is the candidate id, before/after
   *  carry the status+feedbackReason transition. Self-scoped, never a compliance
   *  trail — see `docs/coi-gap-feedback-spec.md`. */
  | "coi_gap_feedback"
  /** a scholar (or a superuser on their behalf) assigned a proxy editor
   *  (scholar-proxy-spec.md / #779). `targetEntityType='scholar'`,
   *  `targetEntityId` is the granted scholar's cwid; `afterValues` carries the
   *  `{ proxy_cwid, granted_by }` of the new grant. Never an impersonated action
   *  (`impersonatedCwid` is always null — the grant endpoint blocks while
   *  impersonating). */
  | "proxy_grant"
  /** a scholar (or a superuser on their behalf) revoked a proxy editor
   *  (scholar-proxy-spec.md / #779). `beforeValues` carries the revoked grant's
   *  `{ proxy_cwid, granted_by }`. */
  | "proxy_revoke"
  /** a comms-steward set a Method-Family's tier (public/suppressed/sensitive)
   *  via the /edit/methods surface (`docs/comms-steward-methods-visibility-spec.md`
   *  §5/§7). `targetEntityType='method_family'`, `targetEntityId` is the
   *  `supercategory:familyLabel` pair; before/after carry the tier transition. */
  | "family_tier_set"
  /** a comms-steward cleared a Method-Family's review nag without changing its
   *  tier (sets `reviewedAt`/`reviewedByCwid` on `family_review_flag`).
   *  `targetEntityType='method_family'`. */
  | "family_review"
  /** a core owner claimed/rejected a (publication, core) usage candidate (cores
   *  inference); `targetEntityType='core'`, `targetEntityId` is the
   *  `"{coreId}:{pmid}"` pair, before/after carry the claim status transition. */
  | "core_claim"
  /** a scholar (or a genuine superuser on their behalf) confirmed a RePORTER
   *  PMID-overlap "Is this you?" match (`REPORTER_MATCH_V2`); writes the
   *  `person_nih_profile` row whose grants materialize next nightly.
   *  `targetEntityType='reporter_profile_candidate'`, `targetEntityId` is the
   *  candidate id; before/after carry the status transition. */
  | "reporter_profile_confirm"
  /** a scholar (or a genuine superuser) declined a RePORTER match with an
   *  enum reason (`not_me`/`name_only`/`cant_tell`) — terminal, feeds matcher QA;
   *  `afterValues` carries the status + rejectReason. */
  | "reporter_profile_reject"
  /** a scholar (or a genuine superuser) revoked a confirmed RePORTER match —
   *  deletes the `person_nih_profile` row (grants reconcile out next run);
   *  before/after carry the status transition. */
  | "reporter_profile_revoke"
  /** a development-role member (or superuser) queued a funding-opportunity URL
   *  for the ReciterAI pipeline (`docs/opportunity-url-intake-spec.md`);
   *  `targetEntityType='opportunity_submission'`, `targetEntityId` the queue
   *  item's sort key, `afterValues` carries `{ url, note }`. */
  | "opportunity_submission";

/** The target type — mirrors the table ENUM. */
export type AuditEntityType =
  | "scholar"
  | "publication"
  | "grant"
  | "education"
  | "appointment"
  /** org-unit targets (#540 Phase 1); `targetEntityId` is the unit `code` */
  | "department"
  | "division"
  | "center"
  /** a derived mentee a mentor hid (#160 follow-up); `targetEntityId` is
   *  `"{mentorCwid}:{menteeCwid}"` */
  | "mentee"
  /** a publication-derived COI-gap candidate the scholar dismissed
   *  (`SELF_EDIT_COI_GAP_HINT`); `targetEntityId` is the `coi_gap_candidate.id` */
  | "coi_gap_candidate"
  /** a method family targeted by a comms-steward tier/review action
   *  (`COMMS_STEWARD_ENABLED`); `targetEntityId` is the
   *  `supercategory:familyLabel` pair. */
  | "method_family"
  /** a (publication, core-facility) usage claim/rejection by a core owner
   *  (cores inference); `targetEntityId` is the `"{coreId}:{pmid}"` pair. */
  | "core"
  /** a RePORTER PMID-overlap match candidate confirmed/rejected/revoked in /edit
   *  (`REPORTER_MATCH_V2`); `targetEntityId` is the
   *  `reporter_profile_candidate.id`. */
  | "reporter_profile_candidate"
  /** a funding-opportunity URL submission queue item in the shared `reciterai`
   *  DynamoDB table (`OPPORTUNITY_URL_INTAKE`); `targetEntityId` is the item's
   *  time-ordered sort key (`<ISO ts>#<uuid8>`). */
  | "opportunity_submission";

/** One audit row, before the DB assigns its `id`. */
export interface AuditRow {
  /** the signed-in actor (B01 SSO session subject) */
  actorCwid: string;
  targetEntityType: AuditEntityType;
  /** `scholar.cwid`, `publication.pmid`, or unit `code` (department/division/center) */
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
  /**
   * The target CWID this write happened *on behalf of*, when the actor was in a
   * "View as" impersonation session (#637 §3/R3); `null` for an ordinary,
   * non-impersonated write. `actorCwid` is **always** the real human — never the
   * target — so `actorCwid` + `impersonatedCwid` together make an impersonated
   * edit non-repudiable and unforgeable as the target (#637 T2). REQUIRED so
   * tsc forces every call site to decide a value (no silent attribution gaps);
   * inside `row_hash` recipe v2 so the attribution is tamper-evident.
   */
  impersonatedCwid: string | null;
}

/**
 * Recursively sort object keys so a JSON serialization is independent of key
 * order. MySQL `JSON` columns normalize (re-sort) object keys on storage, so a
 * digest taken over insertion-order JSON could not be reproduced from the
 * stored row; canonicalizing the value on both the write-time hash and the
 * verify-time recompute keeps `row_hash` storage-engine-independent. Array
 * element order is preserved.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The B03 `row_hash` (`docs/b03-audit-log.md` § row_hash recipe): SHA-256 hex
 * over a canonical JSON serialization of the row — a positional array with all
 * nested object keys sorted recursively (`canonicalize`), so the digest does
 * not depend on key order. `ts` enters the hash as its ISO-8601 string with
 * milliseconds. To verify a stored row, rebuild the array from its columns (the
 * `ts` column reconstructed as ISO-8601) and recompute with `canonicalize`.
 *
 * RECIPE VERSIONS (#637 §10).
 *   v1 — 9 elements, ending at `requestId`; rows written **before** the
 *        `impersonated_cwid` migration (`scripts/sql/impersonation-audit-migration.sql`).
 *   v2 — 10 elements; appends `impersonatedCwid` as the **last** positional
 *        element, after `requestId`; rows written **on or after** the migration.
 * A verifier recomputes with the recipe in effect **at write time**, delimited
 * by the migration timestamp (`ts <` migration ⇒ v1, else v2): a v2 recompute
 * of a v1 row, or vice versa, will not match. This function emits v2; the v1
 * variant is `[…, requestId]` with the final element dropped.
 */
export function computeRowHash(row: AuditRow): string {
  const canonical = JSON.stringify(
    canonicalize([
      row.actorCwid,
      row.targetEntityType,
      row.targetEntityId,
      row.action,
      row.fieldsChanged,
      row.beforeValues,
      row.afterValues,
      row.ts.toISOString(),
      row.requestId,
      // recipe v2 (#637): the impersonation target, or null for a normal write.
      row.impersonatedCwid,
    ]),
  );
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

  // Bound-value order matches the `computeRowHash` v2 positional array (#637 §10):
  // actor_cwid, target_entity_type, target_entity_id, action, fields_changed,
  // before_values, after_values, row_hash, ts, request_id, impersonated_cwid —
  // `impersonated_cwid` appended LAST, mirroring the v2 hash recipe (it is the
  // physical column placed AFTER actor_cwid by the migration, but the INSERT
  // column list is explicit, so the bound order need not match the table layout).
  const inserted = await tx.$executeRaw`
    INSERT INTO scholars_audit.manual_edit_audit
      (actor_cwid, target_entity_type, target_entity_id, action,
       fields_changed, before_values, after_values, row_hash, ts, request_id,
       impersonated_cwid)
    VALUES (
      ${row.actorCwid}, ${row.targetEntityType}, ${row.targetEntityId}, ${row.action},
      ${jsonOrNull(row.fieldsChanged)}, ${jsonOrNull(row.beforeValues)},
      ${jsonOrNull(row.afterValues)}, ${rowHash}, ${tsUtc}, ${row.requestId},
      ${row.impersonatedCwid}
    )`;

  // A single-row INSERT affects exactly one row or throws; anything else is a
  // corrupt state — fail the transaction rather than commit a doubtful audit.
  if (inserted !== 1) {
    throw new Error(`audit insert affected ${inserted} rows, expected 1`);
  }
}
