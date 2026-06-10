/**
 * Center roster audit-history read (#552 Phase 7, `center-management-spec.md`
 * § 5 + § 6.3). Backs `/edit/center/[code]/history`.
 *
 * Every `POST /api/edit/roster` write appends one B03 row to
 * `scholars_audit.manual_edit_audit` with `action='roster_change'`, the unit
 * `code` in `target_entity_id`, and full before/after row snapshots
 * (`{ cwid, membershipType, programCode, startDate, endDate }` for a center;
 * `{ cwid }` for a manual division). This module reads that table back, scoped
 * to one center, and derives the per-row "change kind" (add / remove / modify)
 * and a field-diff summary the read-only history table renders.
 *
 * `manual_edit_audit` is deliberately NOT a Prisma model (the ORM cannot express
 * an UPDATE/DELETE against an append-only row — see `lib/edit/audit.ts`), so the
 * read is a parameterized `$queryRaw` tagged template against the
 * fully-qualified table. The `idx_target (target_entity_type, target_entity_id,
 * ts)` index covers the `WHERE target_entity_type='center' AND
 * target_entity_id=? AND ts >= …` predicate with the `ORDER BY ts DESC`.
 *
 * The 90-day window cutoff is computed in JS and bound as a parameter (the
 * `rate-limit.ts` convention), so the SQL carries no `INTERVAL` literal and the
 * query stays fully parameterized + unit-testable.
 *
 * Scope is enforced two ways, defense-in-depth: the SQL is bound to the single
 * `centerCode`, and the calling page only reaches this after
 * `loadUnitEditContext` has authorized the actor as Owner / Curator / Superuser
 * of THAT center.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** A roster change is an add, a remove, or a modify (both snapshots present). */
export type RosterChangeKind = "add" | "remove" | "modify";

/** One human-readable field transition for the diff summary (modify rows). */
export type RosterFieldChange = {
  field: "type" | "program" | "start" | "end";
  from: string | null;
  to: string | null;
};

/** One row of the center history table — already shaped for the view. */
export type CenterAuditEntry = {
  /** the `manual_edit_audit.id` — stable React key, and the gap-detection key. */
  id: string;
  /** ISO-8601 timestamp (UTC) the write was recorded. */
  ts: string;
  /** the real human actor (never the impersonated subject). */
  actorCwid: string;
  /** the impersonated subject when the write was made under "View as", else null. */
  impersonatedCwid: string | null;
  changeKind: RosterChangeKind;
  /** the membership cwid the row concerns (from after, else before). */
  targetCwid: string;
  /** field transitions for a `modify`; empty for add / remove. */
  fieldChanges: ReadonlyArray<RosterFieldChange>;
};

/** The center-membership snapshot shape stored in before/after (spec § 5). */
type RosterSnapshot = {
  cwid?: string | null;
  membershipType?: string | null;
  programCode?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

/** The narrow Prisma surface this reader needs — `db.read` satisfies it. */
export type CenterAuditClient = Pick<PrismaClient, "$queryRaw">;

/** The raw row the SQL projects back (JSON columns arrive parsed by the driver). */
type RawAuditRow = {
  id: bigint | number | string;
  ts: Date | string;
  actor_cwid: string;
  impersonated_cwid: string | null;
  before_values: unknown;
  after_values: unknown;
};

/** How many days of history the view shows (spec § 5 — last 90 days). */
export const CENTER_AUDIT_WINDOW_DAYS = 90;

/** Parse a JSON column value that may arrive as a string or an already-parsed object. */
function asSnapshot(value: unknown): RosterSnapshot | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" ? (parsed as RosterSnapshot) : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as RosterSnapshot;
  return null;
}

/** Normalize a stored ts (Date or DATETIME string) to an ISO-8601 UTC string. */
function tsIso(ts: Date | string): string {
  if (ts instanceof Date) return ts.toISOString();
  // DATETIME(3) round-trips as "YYYY-MM-DD HH:MM:SS.SSS" (UTC wall-clock).
  const d = new Date(ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? new Date(ts).toISOString() : d.toISOString();
}

/**
 * Derive the change kind + a field-diff summary from one row's before/after.
 *
 * A `roster_change` row is an `add` when `before` is null, a `remove` when
 * `after` is null, and a `modify` when both are present (the `set` action on an
 * existing row). The diff summary is only meaningful for a modify — for an
 * add/remove the whole row is the change, and the table shows the cwid alone.
 */
export function deriveChange(
  before: RosterSnapshot | null,
  after: RosterSnapshot | null,
): { changeKind: RosterChangeKind; targetCwid: string; fieldChanges: RosterFieldChange[] } {
  const changeKind: RosterChangeKind =
    before === null ? "add" : after === null ? "remove" : "modify";

  // The cwid is the membership identity — present on whichever side exists.
  const targetCwid = after?.cwid ?? before?.cwid ?? "";

  const fieldChanges: RosterFieldChange[] = [];
  if (changeKind === "modify" && before && after) {
    const cmp = (field: RosterFieldChange["field"], key: keyof RosterSnapshot) => {
      const from = before[key] ?? null;
      const to = after[key] ?? null;
      if (from !== to) {
        fieldChanges.push({ field, from: from as string | null, to: to as string | null });
      }
    };
    cmp("type", "membershipType");
    cmp("program", "programCode");
    cmp("start", "startDate");
    cmp("end", "endDate");
  }

  return { changeKind, targetCwid, fieldChanges };
}

/** Map a list of raw audit rows to the view-shaped history entries. */
export function shapeAuditRows(rows: ReadonlyArray<RawAuditRow>): CenterAuditEntry[] {
  return rows.map((r): CenterAuditEntry => {
    const before = asSnapshot(r.before_values);
    const after = asSnapshot(r.after_values);
    const { changeKind, targetCwid, fieldChanges } = deriveChange(before, after);
    return {
      id: String(r.id),
      ts: tsIso(r.ts),
      actorCwid: r.actor_cwid,
      impersonatedCwid: r.impersonated_cwid,
      changeKind,
      targetCwid,
      fieldChanges,
    };
  });
}

/**
 * Load the last {@link CENTER_AUDIT_WINDOW_DAYS} days of `roster_change` rows for
 * one center, newest first. Returns `[]` when the center has no recorded roster
 * activity. The caller MUST have already authorized the actor on this center.
 *
 * `now` is injectable so the window cutoff is deterministic under test.
 */
export async function loadCenterAuditHistory(
  centerCode: string,
  client: CenterAuditClient,
  now: Date = new Date(),
): Promise<CenterAuditEntry[]> {
  if (!centerCode) return [];

  // Window cutoff computed in JS and bound (the rate-limit.ts pattern) — the SQL
  // carries no INTERVAL literal, so the whole query is parameterized.
  const cutoff = new Date(now.getTime() - CENTER_AUDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await client.$queryRaw<RawAuditRow[]>`
    SELECT id, ts, actor_cwid, impersonated_cwid, before_values, after_values
      FROM scholars_audit.manual_edit_audit
     WHERE action             = 'roster_change'
       AND target_entity_type = 'center'
       AND target_entity_id   = ${centerCode}
       AND ts >= ${cutoff}
     ORDER BY ts DESC, id DESC`;

  return shapeAuditRows(rows);
}
