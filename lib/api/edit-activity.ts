/**
 * Fleet-wide edit-activity aggregates over the B03 audit log
 * (`scholars_audit.manual_edit_audit`). The per-ENTITY slices live in
 * `scholar-audit.ts` / `center-audit.ts`; this is the cross-entity operator
 * view (edits/day, top editors, most-edited entities, recent activity) behind
 * the superuser-only `/edit/activity` page.
 *
 * SELECT-only, read role (`db.read` / `app_ro`). Like scholar-audit.ts the
 * window cutoff is computed in JS and BOUND, so the SQL carries no INTERVAL
 * literal and the whole query is parameterized. The audit DB lives in a
 * separate schema; if the read role lacks SELECT there the loader throws and
 * the page fails soft (the scholar-history pattern).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** Rolling window the summary spans. */
export const EDIT_ACTIVITY_WINDOW_DAYS = 30;

/** The one Prisma method this module needs — keeps the unit test client tiny. */
export type EditActivityClient = Pick<PrismaClient, "$queryRaw">;

export type PerDay = { day: string; edits: number };
export type TopEditor = { actorCwid: string; edits: number };
export type TopEntity = { entityType: string; entityId: string; edits: number };
export type RecentEdit = {
  id: string;
  ts: string;
  actorCwid: string;
  impersonatedCwid: string | null;
  action: string;
  entityType: string;
  entityId: string;
};
export type EditActivitySummary = {
  windowDays: number;
  totalEdits: number;
  perDay: PerDay[];
  topEditors: TopEditor[];
  topEntities: TopEntity[];
  recent: RecentEdit[];
};

// Raw row shapes as MySQL/Prisma returns them: COUNT(*) is a bigint, DATE()/
// DATETIME come back as a Date (some drivers as a string) — both handled.
type RawPerDay = { day: Date | string; edits: bigint | number };
type RawEditor = { actor_cwid: string; edits: bigint | number };
type RawEntity = {
  target_entity_type: string;
  target_entity_id: string;
  edits: bigint | number;
};
type RawRecent = {
  id: string;
  ts: Date | string;
  actor_cwid: string;
  impersonated_cwid: string | null;
  action: string;
  target_entity_type: string;
  target_entity_id: string;
};

/** A DATE column as YYYY-MM-DD, whether the driver hands back a Date or string. */
export function toDay(v: Date | string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** A DATETIME as an ISO instant, whether the driver hands back a Date or string. */
function toIso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/**
 * Pure row-shaper: raw query rows -> the view model. Split out from the DB call
 * so it is unit-testable without a database (mirrors queries.ts in cf-usage-rollup).
 */
export function shapeSummary(
  perDay: readonly RawPerDay[],
  editors: readonly RawEditor[],
  entities: readonly RawEntity[],
  recent: readonly RawRecent[],
): EditActivitySummary {
  const shapedPerDay = perDay.map((r) => ({ day: toDay(r.day), edits: Number(r.edits) }));
  return {
    windowDays: EDIT_ACTIVITY_WINDOW_DAYS,
    totalEdits: shapedPerDay.reduce((sum, r) => sum + r.edits, 0),
    perDay: shapedPerDay,
    topEditors: editors.map((r) => ({ actorCwid: r.actor_cwid, edits: Number(r.edits) })),
    topEntities: entities.map((r) => ({
      entityType: r.target_entity_type,
      entityId: r.target_entity_id,
      edits: Number(r.edits),
    })),
    recent: recent.map((r) => ({
      id: r.id,
      ts: toIso(r.ts),
      actorCwid: r.actor_cwid,
      impersonatedCwid: r.impersonated_cwid,
      action: r.action,
      entityType: r.target_entity_type,
      entityId: r.target_entity_id,
    })),
  };
}

/**
 * Load the fleet-wide edit-activity summary for the trailing
 * {@link EDIT_ACTIVITY_WINDOW_DAYS} days. Four aggregate reads run in parallel;
 * the cutoff is bound (no INTERVAL literal). Throws if the audit table is
 * unreadable — the caller renders an "unavailable" notice rather than 500ing.
 */
export async function loadEditActivitySummary(
  client: EditActivityClient,
  now: Date = new Date(),
): Promise<EditActivitySummary> {
  const cutoff = new Date(now.getTime() - EDIT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [perDay, editors, entities, recent] = await Promise.all([
    client.$queryRaw<RawPerDay[]>`
      SELECT DATE(ts) AS day, COUNT(*) AS edits
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       GROUP BY DATE(ts)
       ORDER BY day DESC`,
    client.$queryRaw<RawEditor[]>`
      SELECT actor_cwid, COUNT(*) AS edits
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       GROUP BY actor_cwid
       ORDER BY edits DESC
       LIMIT 20`,
    client.$queryRaw<RawEntity[]>`
      SELECT target_entity_type, target_entity_id, COUNT(*) AS edits
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       GROUP BY target_entity_type, target_entity_id
       ORDER BY edits DESC
       LIMIT 20`,
    client.$queryRaw<RawRecent[]>`
      SELECT id, ts, actor_cwid, impersonated_cwid, action,
             target_entity_type, target_entity_id
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       ORDER BY ts DESC, id DESC
       LIMIT 100`,
  ]);

  return shapeSummary(perDay, editors, entities, recent);
}
