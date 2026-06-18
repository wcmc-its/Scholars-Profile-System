/**
 * Scholar profile audit-history read (#955 finding #11). Backs
 * `/edit/scholar/[cwid]/history` — the read-only sibling of the scholar editor,
 * mirroring `/edit/center/[code]/history` (`lib/api/center-audit.ts`).
 *
 * Every `/api/edit/*` write appends one B03 row to
 * `scholars_audit.manual_edit_audit` (`lib/edit/audit.ts`). This module reads
 * back the rows whose target IS the scholar entity — `target_entity_type =
 * 'scholar' AND target_entity_id = <cwid>` — i.e. the edits made to the profile
 * record itself: field overrides (overview, titles, …), proxy-editor
 * grants/revokes, "request a change" routes, profile-URL (slug) requests, and
 * "View as" session start/end keyed on this profile.
 *
 * SCOPE — by-design boundary. Publication / grant / education / appointment
 * suppressions and the COI-gap / mentee actions land under THEIR own
 * `target_entity_type` (keyed by pmid / grant-id / candidate-id, not the cwid),
 * so they are audited on their own surfaces, not here. This page is the profile
 * record's history, exactly as the center page is the center's roster history.
 *
 * `manual_edit_audit` is deliberately NOT a Prisma model (the ORM cannot express
 * an UPDATE/DELETE against an append-only row — see `lib/edit/audit.ts`), so the
 * read is a parameterized `$queryRaw` tagged template against the
 * fully-qualified table. The `idx_target (target_entity_type, target_entity_id,
 * ts)` index covers the `WHERE target_entity_type='scholar' AND
 * target_entity_id=? AND ts >= …` predicate with the `ORDER BY ts DESC`.
 *
 * The window cutoff is computed in JS and bound as a parameter (the
 * `center-audit.ts` / `rate-limit.ts` convention), so the SQL carries no
 * `INTERVAL` literal and the query stays fully parameterized + unit-testable.
 *
 * Scope is enforced two ways, defense-in-depth: the SQL is bound to the single
 * `cwid`, and the calling page only reaches this after the same five-mode
 * authorization gate as the editor has authorized the actor on THIS scholar.
 */
import type { AuditAction } from "@/lib/edit/audit";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** One row of the scholar history table — already shaped for the view. */
export type ScholarAuditEntry = {
  /** the `manual_edit_audit.id` — stable React key. */
  id: string;
  /** ISO-8601 timestamp (UTC) the write was recorded. */
  ts: string;
  /** the real human actor (never the impersonated subject). */
  actorCwid: string;
  /** the impersonated subject when the write was made under "View as", else null. */
  impersonatedCwid: string | null;
  /** the raw action discriminator (`data-action` hook + exhaustive labelling). */
  action: AuditAction;
  /** the human-readable action label (e.g. "Updated profile"). */
  actionLabel: string;
  /** humanized field labels for a `field_override` / `_clear`; `[]` otherwise. */
  fields: string[];
  /** a compact extra detail (e.g. the proxy cwid, the requested slug), else null. */
  detail: string | null;
};

/** The narrow Prisma surface this reader needs — `db.read` satisfies it. */
export type ScholarAuditClient = Pick<PrismaClient, "$queryRaw">;

/** The raw row the SQL projects back (JSON columns arrive parsed by the driver). */
type RawScholarAuditRow = {
  id: bigint | number | string;
  ts: Date | string;
  actor_cwid: string;
  impersonated_cwid: string | null;
  action: string;
  fields_changed: unknown;
  before_values: unknown;
  after_values: unknown;
};

/** How many days of history the view shows (matches the center surface — 90). */
export const SCHOLAR_AUDIT_WINDOW_DAYS = 90;

/** Human label per action; falls back to a humanized form for any unmapped value. */
const ACTION_LABEL: Partial<Record<AuditAction, string>> = {
  field_override: "Updated profile",
  field_override_clear: "Cleared field",
  request_change: "Requested a change",
  slug_request: "Requested profile URL",
  slug_request_approved: "Profile URL approved",
  slug_request_rejected: "Profile URL rejected",
  slug_request_withdrawn: "Profile URL request withdrawn",
  proxy_grant: "Granted proxy editor",
  proxy_revoke: "Revoked proxy editor",
  impersonation_start: "Started View-as session",
  impersonation_end: "Ended View-as session",
};

/** A few field keys that don't humanize cleanly from camelCase alone. */
const FIELD_LABEL_OVERRIDE: Record<string, string> = {
  overview: "Overview",
  primaryTitle: "Primary title",
  orcid: "ORCID",
  url: "URL",
};

/** "primaryTitle" / "primary_title" → "Primary title"; known keys get a nicer label. */
export function humanizeField(key: string): string {
  if (FIELD_LABEL_OVERRIDE[key]) return FIELD_LABEL_OVERRIDE[key];
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Map an action discriminator to its display label (humanized fallback). */
export function labelForAction(action: string): string {
  return ACTION_LABEL[action as AuditAction] ?? humanizeField(action);
}

/** Parse a JSON column value that may arrive as a string or an already-parsed value. */
function asJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/** The `fields_changed` JSON column → an array of humanized field labels. */
export function fieldLabels(fieldsChanged: unknown): string[] {
  const parsed = asJson(fieldsChanged);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f): f is string => typeof f === "string" && f.length > 0).map(humanizeField);
}

/** A read of one string property off a parsed JSON object, else null. */
function readStr(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A compact extra detail for the row, where one is meaningful: the proxy cwid
 * for a grant/revoke, the requested slug for a slug request. Field-override
 * rows surface their changed fields via {@link fieldLabels}, not here — the
 * before/after blobs (e.g. a full overview) are intentionally NOT rendered.
 */
export function detailForAction(action: string, before: unknown, after: unknown): string | null {
  switch (action) {
    case "proxy_grant":
      return readStr(after, "proxy_cwid");
    case "proxy_revoke":
      return readStr(before, "proxy_cwid");
    case "slug_request":
    case "slug_request_approved":
      return readStr(after, "slug") ?? readStr(after, "requestedSlug");
    default:
      return null;
  }
}

/** Normalize a stored ts (Date or DATETIME string) to an ISO-8601 UTC string. */
function tsIso(ts: Date | string): string {
  if (ts instanceof Date) return ts.toISOString();
  // DATETIME(3) round-trips as "YYYY-MM-DD HH:MM:SS.SSS" (UTC wall-clock).
  const d = new Date(ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? new Date(ts).toISOString() : d.toISOString();
}

/** Map a list of raw audit rows to the view-shaped history entries. */
export function shapeScholarAuditRows(
  rows: ReadonlyArray<RawScholarAuditRow>,
): ScholarAuditEntry[] {
  return rows.map((r): ScholarAuditEntry => {
    const before = asJson(r.before_values);
    const after = asJson(r.after_values);
    return {
      id: String(r.id),
      ts: tsIso(r.ts),
      actorCwid: r.actor_cwid,
      impersonatedCwid: r.impersonated_cwid,
      action: r.action as AuditAction,
      actionLabel: labelForAction(r.action),
      fields: fieldLabels(r.fields_changed),
      detail: detailForAction(r.action, before, after),
    };
  });
}

/**
 * Load the last {@link SCHOLAR_AUDIT_WINDOW_DAYS} days of profile-entity audit
 * rows for one scholar, newest first. Returns `[]` when the scholar has no
 * recorded profile activity. The caller MUST have already authorized the actor
 * on this scholar (the editor's five-mode gate).
 *
 * `now` is injectable so the window cutoff is deterministic under test.
 */
export async function loadScholarAuditHistory(
  cwid: string,
  client: ScholarAuditClient,
  now: Date = new Date(),
): Promise<ScholarAuditEntry[]> {
  if (!cwid) return [];

  // Window cutoff computed in JS and bound (the center-audit.ts pattern) — the
  // SQL carries no INTERVAL literal, so the whole query is parameterized.
  const cutoff = new Date(now.getTime() - SCHOLAR_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await client.$queryRaw<RawScholarAuditRow[]>`
    SELECT id, ts, actor_cwid, impersonated_cwid, action,
           fields_changed, before_values, after_values
      FROM scholars_audit.manual_edit_audit
     WHERE target_entity_type = 'scholar'
       AND target_entity_id   = ${cwid}
       AND ts >= ${cutoff}
     ORDER BY ts DESC, id DESC`;

  return shapeScholarAuditRows(rows);
}
