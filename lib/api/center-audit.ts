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
 * The disease-assignment plan (`2026-08-12-cancer-center-disease-assignment-
 * edit-ui-plan.md` §5) widens this to also surface `action=
 * 'disease_assignment_decision'` rows — a curator's confirm/reject/clear call
 * on one `CancerCenterDiseaseAssignment` row
 * (`/api/edit/center/[code]/disease-assignments`). Those rows are NOT keyed by
 * this center at all: `CancerCenterDiseaseAssignment`/`Decision` carry no
 * center column of their own (a scholar's disease profile isn't center-scoped
 * data — the route's own docblock), so `appendAuditRow` there targets
 * `target_entity_type='scholar'`, `target_entity_id`=the decided scholar's
 * cwid, exactly like `/edit/scholar/[cwid]/history` reads them
 * (`scholar-audit.ts`). To scope them to THIS center anyway,
 * `loadCenterAuditHistory` first loads the center's CURRENT
 * `CenterMembership` cwids and binds an `IN (...)` list — the same
 * "assignments/decisions for this center's roster members, not a center-FK'd
 * query" posture `loadUnitEditContext` already uses for the same tables
 * (`unit-edit-context.ts` §4b).
 *
 * `manual_edit_audit` is deliberately NOT a Prisma model (the ORM cannot express
 * an UPDATE/DELETE against an append-only row — see `lib/edit/audit.ts`), so the
 * read is a parameterized `$queryRaw` tagged template against the
 * fully-qualified table. The `idx_target (target_entity_type, target_entity_id,
 * ts)` index covers both OR'd branches below (`target_entity_type='center'`
 * for roster rows, `='scholar'` for disease-decision rows).
 *
 * The 90-day window cutoff is computed in JS and bound as a parameter (the
 * `rate-limit.ts` convention), so the SQL carries no `INTERVAL` literal and the
 * query stays fully parameterized + unit-testable.
 *
 * Scope is enforced two ways, defense-in-depth: the SQL is bound to the single
 * `centerCode` (roster rows) / this center's roster cwids (disease rows), and
 * the calling page only reaches this after `loadUnitEditContext` has
 * authorized the actor as Owner / Curator / Superuser of THAT center.
 */
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";

/** A roster/disease-decision change is an add, a remove, or a modify (both
 *  snapshots present). */
export type RosterChangeKind = "add" | "remove" | "modify";

/** One human-readable field transition for the diff summary (modify rows).
 *  `disease` is the disease-assignment-decision row (plan §5) — `from`/`to`
 *  are the disease code and the decision value, not a true before/after pair
 *  (the code itself never changes), so it renders as "Disease: BREAST →
 *  confirmed" through the same `FIELD_LABEL`-keyed template roster fields use. */
export type RosterFieldChange = {
  field: "type" | "program" | "start" | "end" | "disease" | "role" | "leadership" | "interim";
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
  /** #2542 — the stored role key `membershipType` is derived from. */
  membershipRoleKey?: string | null;
  /** #2542 — the leadership role held at this center, or null. */
  leadershipRoleKey?: string | null;
  leadershipInterim?: boolean | null;
  programCode?: string | null;
  startDate?: string | null;
  endDate?: string | null;
};

/** The disease-decision snapshot shape stored in before/after (disease-
 *  assignment plan §4, `/api/edit/center/[code]/disease-assignments`). Unlike
 *  {@link RosterSnapshot} it carries no `cwid` — the target scholar comes from
 *  the raw row's `target_entity_id` instead (see {@link deriveDiseaseChange}). */
type DiseaseSnapshot = {
  diseaseCode?: string | null;
  decision?: string | null;
  scoreAtDecision?: number | null;
  confidenceAtDecision?: string | null;
};

/** The narrow Prisma surface this reader needs — `db.read` satisfies it.
 *  `centerMembership` is the disease-decision roster-cwid lookup (see the
 *  module docblock); it plays no part in the roster-row query itself. */
export type CenterAuditClient = Pick<PrismaClient, "$queryRaw" | "centerMembership">;

/** The raw row the SQL projects back (JSON columns arrive parsed by the driver).
 *  `action`/`target_entity_id` are only needed to route a disease-decision row
 *  through {@link deriveDiseaseChange} instead of {@link deriveChange} — every
 *  row the WHERE clause returns is already scoped to this center, one way or
 *  the other, so no `target_entity_type` column is projected. */
type RawAuditRow = {
  id: bigint | number | string;
  ts: Date | string;
  actor_cwid: string;
  impersonated_cwid: string | null;
  action: string;
  target_entity_id: string;
  before_values: unknown;
  after_values: unknown;
};

/** How many days of history the view shows (spec § 5 — last 90 days). */
export const CENTER_AUDIT_WINDOW_DAYS = 90;

/** Parse a JSON column value that may arrive as a string or an already-parsed
 *  object. Untyped on purpose — {@link RosterSnapshot} and
 *  {@link DiseaseSnapshot} share this one parser; callers cast to whichever
 *  shape their row's `action` implies. */
function asSnapshot(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>;
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
    // #2542 — without these three a leadership assignment renders in the history
    // table as a `modify` with an EMPTY diff: a change that says nothing.
    cmp("role", "membershipRoleKey");
    cmp("leadership", "leadershipRoleKey");
    cmp("interim", "leadershipInterim");
    cmp("program", "programCode");
    cmp("start", "startDate");
    cmp("end", "endDate");
  }

  return { changeKind, targetCwid, fieldChanges };
}

/**
 * Derive the change kind + a one-line diff for a `disease_assignment_decision`
 * row (plan §5). The disease code never changes across before/after (it's the
 * pair's own identity, `CancerCenterDiseaseDecision`'s composite key) so —
 * unlike {@link deriveChange}'s per-field diff — this always yields exactly
 * ONE `fieldChanges` entry, on every kind, not only `modify`: `from` is the
 * code, `to` is the decision that's now in effect (`null` once cleared). That
 * renders as "Disease: BREAST → confirmed" through the same
 * `FIELD_LABEL`-keyed template roster fields use.
 *
 * `targetCwid` is NOT read off the snapshot (unlike a roster row's own `cwid`)
 * — a disease-decision snapshot carries no cwid of its own — it's the raw
 * row's `target_entity_id`, passed in by {@link shapeAuditRows}.
 */
export function deriveDiseaseChange(
  before: DiseaseSnapshot | null,
  after: DiseaseSnapshot | null,
  targetEntityId: string,
): { changeKind: RosterChangeKind; targetCwid: string; fieldChanges: RosterFieldChange[] } {
  const changeKind: RosterChangeKind =
    before === null ? "add" : after === null ? "remove" : "modify";

  const diseaseCode = after?.diseaseCode ?? before?.diseaseCode ?? null;
  const decision = after?.decision ?? null; // null once cleared (after === null)

  return {
    changeKind,
    targetCwid: targetEntityId,
    fieldChanges: [{ field: "disease", from: diseaseCode, to: decision }],
  };
}

/** Map a list of raw audit rows to the view-shaped history entries. Routes a
 *  `disease_assignment_decision` row through {@link deriveDiseaseChange}
 *  instead of {@link deriveChange} — the two actions store differently-shaped
 *  snapshots (see the module docblock). */
export function shapeAuditRows(rows: ReadonlyArray<RawAuditRow>): CenterAuditEntry[] {
  return rows.map((r): CenterAuditEntry => {
    const before = asSnapshot(r.before_values);
    const after = asSnapshot(r.after_values);
    const { changeKind, targetCwid, fieldChanges } =
      r.action === "disease_assignment_decision"
        ? deriveDiseaseChange(
            before as DiseaseSnapshot | null,
            after as DiseaseSnapshot | null,
            r.target_entity_id,
          )
        : deriveChange(before as RosterSnapshot | null, after as RosterSnapshot | null);
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
 * Load the last {@link CENTER_AUDIT_WINDOW_DAYS} days of `roster_change` +
 * `disease_assignment_decision` rows for one center, newest first. Returns
 * `[]` when the center has no recorded activity of either kind. The caller
 * MUST have already authorized the actor on this center.
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

  // Disease-decision rows aren't keyed by this center (module docblock) — scope
  // them to this center's CURRENT roster cwids instead, the same lookup
  // `loadUnitEditContext` already does for the same tables (`unit-edit-
  // context.ts` §4b). No roster members → skip that branch entirely rather
  // than bind an empty `IN ()` list.
  const rosterCwids = [
    ...new Set(
      (
        await client.centerMembership.findMany({
          where: { centerCode },
          select: { cwid: true },
        })
      ).map((m) => m.cwid),
    ),
  ];
  const diseaseBranch =
    rosterCwids.length > 0
      ? Prisma.sql`OR (action = 'disease_assignment_decision'
                        AND target_entity_type = 'scholar'
                        AND target_entity_id IN (${Prisma.join(rosterCwids)}))`
      : Prisma.empty;

  const rows = await client.$queryRaw<RawAuditRow[]>`
    SELECT id, ts, actor_cwid, impersonated_cwid, action, target_entity_id,
           before_values, after_values
      FROM scholars_audit.manual_edit_audit
     WHERE (
             (action = 'roster_change' AND target_entity_type = 'center' AND target_entity_id = ${centerCode})
             ${diseaseBranch}
           )
       AND ts >= ${cutoff}
     ORDER BY ts DESC, id DESC`;

  return shapeAuditRows(rows);
}
