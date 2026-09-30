/**
 * Fleet-wide edit-activity aggregates over the B03 audit log
 * (`scholars_audit.manual_edit_audit`). The per-ENTITY slices live in
 * `scholar-audit.ts` / `center-audit.ts`; this is the cross-entity operator
 * view (edits/day, top editors, most-edited entities, recent activity) behind
 * the superuser-only `/edit/activity` page, plus {@link loadOlderEdits}, the
 * `(ts, id)`-cursor read behind the feed's "Load older" button
 * (`GET /api/edit/activity/recent`).
 *
 * SELECT-only, read role (`db.read` / `app_ro`). Like scholar-audit.ts the
 * window cutoff is computed in JS and BOUND, so the SQL carries no INTERVAL
 * literal and the whole query is parameterized. The audit DB lives in a
 * separate schema; if the read role lacks SELECT there the loader throws and
 * the page fails soft (the scholar-history pattern).
 *
 * Recent-activity substance: unlike the per-entity history view (which
 * deliberately renders only changed field NAMES, not the before/after blobs),
 * this superuser-only surface surfaces the actual before -> after values per
 * changed field ({@link buildChanges}). Long values are collapsed in the UI
 * (`<details>`), so the length concern that motivated hiding them upstream does
 * not apply here.
 *
 * The audit table stores CWIDs only, so every person on the page — editors,
 * impersonated actors, and edited scholars — is resolved to a name + title
 * through one batched `Scholar` read into {@link EditActivitySummary.people}
 * (#2589). A map rather than per-row name fields because one editor appears in
 * dozens of rows, and because it keeps the pure `shapeSummary` untouched.
 */
import { detailForAction, humanizeField } from "@/lib/api/scholar-audit";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** Rolling window the summary spans. */
export const EDIT_ACTIVITY_WINDOW_DAYS = 30;
/** How many edits one feed page loads: the initial read's SQL `LIMIT 100`,
 *  and each "Load older" page (`LIMIT 101` = this + 1 look-ahead row). The
 *  SQL literals must track this constant (a bound LIMIT is driver-fragile). */
export const EDIT_ACTIVITY_RECENT_LIMIT = 100;

/** The Prisma surface this module needs — keeps the unit test client tiny.
 *  `center` / `core` only name those entities (fail-soft, like `scholar`). */
export type EditActivityClient = Pick<PrismaClient, "$queryRaw" | "scholar"> &
  Partial<Pick<PrismaClient, "center" | "core">>;

/** The one timezone the console reads dates in (WCM-local). */
export const EDIT_ACTIVITY_TZ = "America/New_York";

/**
 * Audit actors that are automation, not people. The audit log's only
 * convention for a machine actor is a `system-` prefix (e.g. the reporter
 * ETL's `system-autolock`); anything else is a CWID.
 */
export function isSystemActor(cwid: string): boolean {
  return cwid.startsWith("system-");
}

/** The Eastern UTC offset at `now` as a MySQL `CONVERT_TZ` offset ("-04:00").
 *  One offset for the whole window: a DST switch inside it shifts that side's
 *  day buckets by an hour, which a 30-day activity chart tolerates. */
export function easternOffset(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EDIT_ACTIVITY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const utc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
  );
  const mins = Math.round((wall - utc) / 60000);
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export type PerDay = { day: string; edits: number };
export type TopEditor = { actorCwid: string; edits: number };
export type TopEntity = { entityType: string; entityId: string; edits: number };
/** One changed field's before -> after, both already coerced to display strings. */
export type FieldChange = { field: string; before: string | null; after: string | null };
export type RecentEdit = {
  id: string;
  ts: string;
  actorCwid: string;
  impersonatedCwid: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** Per-field before -> after for field-mutating actions (may be empty). */
  changes: FieldChange[];
  /** A compact fallback detail for non-field actions (proxy cwid, slug), else null. */
  detail: string | null;
};
/** A person behind a CWID. `title` is null for scholars with no primary title. */
export type PersonRef = { name: string; title: string | null };
/** CWID -> person, for the CWIDs on this page that resolve to a Scholar. */
export type PeopleDirectory = Record<string, PersonRef>;
/** Window-wide editor counts (not capped like `topEditors`). */
export type EditorStats = {
  /** Distinct actors in the window. */
  editors: number;
  /** Distinct {@link isSystemActor} actors. */
  automatedEditors: number;
  /** Edits made by {@link isSystemActor} actors. */
  automatedEdits: number;
};
export type EditActivitySummary = {
  windowDays: number;
  /** When the summary was read (ISO) — anchors the chart's day axis. */
  generatedAt: string;
  totalEdits: number;
  editorStats: EditorStats;
  /** `${entityType}:${entityId}` -> display name, for centers and cores that
   *  resolve. Absent keys render the bare id. */
  entityNames: Record<string, string>;
  perDay: PerDay[];
  topEditors: TopEditor[];
  topEntities: TopEntity[];
  recent: RecentEdit[];
  /** Opaque cursor for the next-older feed page ({@link loadOlderEdits}), or
   *  null when `recent` already holds every edit in the window. */
  nextCursor: string | null;
  /** Names/titles for the CWIDs above. Absent keys render as the bare CWID —
   *  non-scholar admins and service accounts legitimately never resolve. */
  people: PeopleDirectory;
};

// Raw row shapes as MySQL/Prisma returns them: COUNT(*) is a bigint, DATE()/
// DATETIME come back as a Date (some drivers as a string), and the JSON columns
// as a string (queryRaw does not auto-parse) — all handled below.
type RawPerDay = { day: Date | string; edits: bigint | number };
type RawEditor = { actor_cwid: string; edits: bigint | number };
type RawEntity = {
  target_entity_type: string;
  target_entity_id: string;
  edits: bigint | number;
};
type RawEditorStats = {
  editors: bigint | number;
  automated_editors: bigint | number | null;
  automated_edits: bigint | number | string | null;
};
type RawRecent = {
  // BIGINT UNSIGNED: the driver may hand back a bigint; shaped to a string.
  id: string | number | bigint;
  ts: Date | string;
  actor_cwid: string;
  impersonated_cwid: string | null;
  action: string;
  target_entity_type: string;
  target_entity_id: string;
  fields_changed: unknown;
  before_values: unknown;
  after_values: unknown;
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

/** Parse a JSON column that may arrive as a string or an already-parsed value. */
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

/** Coerce a stored value to a display string: string as-is, else compact JSON; empty/null -> null. */
export function coerceValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 0 ? v : null;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * `fields_changed` (JSON array of keys) + the before/after JSON objects ->
 * one {@link FieldChange} per changed field, with the field key humanized and
 * each side coerced to a display string. Returns [] for non-field actions
 * (where `fields_changed` is absent/empty) — those fall back to `detail`.
 */
export function buildChanges(
  fieldsChanged: unknown,
  beforeVals: unknown,
  afterVals: unknown,
): FieldChange[] {
  const keys = asJson(fieldsChanged);
  if (!Array.isArray(keys)) return [];
  const rec = (o: unknown): Record<string, unknown> =>
    o !== null && typeof o === "object" ? (o as Record<string, unknown>) : {};
  const before = rec(asJson(beforeVals));
  const after = rec(asJson(afterVals));
  return keys
    .filter((k): k is string => typeof k === "string" && k.length > 0)
    .map((k) => ({
      field: humanizeField(k),
      before: coerceValue(before[k]),
      after: coerceValue(after[k]),
    }));
}

/** One raw audit row -> a {@link RecentEdit}. The id is stringified because a
 *  bigint does not survive `JSON.stringify` on the "Load older" API. */
function shapeRecent(r: RawRecent): RecentEdit {
  return {
    id: String(r.id),
    ts: toIso(r.ts),
    actorCwid: r.actor_cwid,
    impersonatedCwid: r.impersonated_cwid,
    action: r.action,
    entityType: r.target_entity_type,
    entityId: r.target_entity_id,
    changes: buildChanges(r.fields_changed, r.before_values, r.after_values),
    detail: detailForAction(r.action, asJson(r.before_values), asJson(r.after_values)),
  };
}

/**
 * Feed cursor: the (ts, id) of the OLDEST row already shown. The feed orders
 * `ts DESC, id DESC`, and `id` is the unique AUTO_INCREMENT key, so the pair is
 * a total order: the next page is exactly the rows strictly after it, with no
 * skips or repeats even when many rows share one millisecond. `ts` is
 * DATETIME(3), so the ISO instant round-trips exactly. Encoded as
 * `<iso>_<id>` (an ISO string contains no `_`).
 */
export type FeedCursor = { ts: Date; id: bigint };

export function encodeCursor(edit: Pick<RecentEdit, "ts" | "id">): string {
  return `${edit.ts}_${edit.id}`;
}

/** Parse {@link encodeCursor} output; null for anything malformed. */
export function decodeCursor(raw: string | null | undefined): FeedCursor | null {
  if (!raw || raw.length > 64) return null;
  const at = raw.lastIndexOf("_");
  if (at <= 0) return null;
  const tsPart = raw.slice(0, at);
  const idPart = raw.slice(at + 1);
  if (!/^\d{1,20}$/.test(idPart)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(tsPart)) return null;
  const ts = new Date(tsPart);
  if (Number.isNaN(ts.getTime())) return null;
  return { ts, id: BigInt(idPart) };
}

/**
 * Parse the `asOf` a "Load older" call carries: the summary's `generatedAt`,
 * so every page is cut off at the SAME window start as the KPIs, chart and day
 * counts it sits under (not a window recomputed from each request's own
 * time). Null for anything malformed. An `asOf` later than `now` is clamped to
 * `now`; an earlier one is honoured as-is.
 */
export function parseAsOf(raw: string | null | undefined, now: Date = new Date()): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(raw)) return null;
  const asOf = new Date(raw);
  if (Number.isNaN(asOf.getTime())) return null;
  return asOf.getTime() > now.getTime() ? now : asOf;
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
  stats: readonly RawEditorStats[] = [],
  now: Date = new Date(),
): EditActivitySummary {
  const shapedPerDay = perDay.map((r) => ({ day: toDay(r.day), edits: Number(r.edits) }));
  const s = stats[0];
  const shapedRecent = recent.map(shapeRecent);
  const totalEdits = shapedPerDay.reduce((sum, r) => sum + r.edits, 0);
  const oldest = shapedRecent[shapedRecent.length - 1];
  return {
    // Filled in by loadEditActivitySummary — this shaper stays pure/DB-free.
    people: {},
    entityNames: {},
    windowDays: EDIT_ACTIVITY_WINDOW_DAYS,
    generatedAt: now.toISOString(),
    totalEdits,
    editorStats: {
      // No stats row (an empty window) ⇒ fall back to what the capped list saw.
      editors: s ? Number(s.editors) : editors.length,
      automatedEditors: s
        ? Number(s.automated_editors ?? 0)
        : editors.filter((e) => isSystemActor(e.actor_cwid)).length,
      automatedEdits: s
        ? Number(s.automated_edits ?? 0)
        : editors
            .filter((e) => isSystemActor(e.actor_cwid))
            .reduce((sum, e) => sum + Number(e.edits), 0),
    },
    perDay: shapedPerDay,
    topEditors: editors.map((r) => ({ actorCwid: r.actor_cwid, edits: Number(r.edits) })),
    topEntities: entities.map((r) => ({
      entityType: r.target_entity_type,
      entityId: r.target_entity_id,
      edits: Number(r.edits),
    })),
    recent: shapedRecent,
    // Older rows exist only when the first page filled AND the window holds more.
    nextCursor:
      oldest &&
      shapedRecent.length >= EDIT_ACTIVITY_RECENT_LIMIT &&
      totalEdits > shapedRecent.length
        ? encodeCursor(oldest)
        : null,
  };
}

/** The parts of a summary (or a "Load older" page) that name people/entities. */
type NamedRows = Pick<EditActivitySummary, "topEditors" | "topEntities" | "recent">;

/**
 * Every CWID the summary refers to: editors (both tables), impersonated actors,
 * and scholar entity ids — `target_entity_id` IS a CWID when the entity type is
 * `scholar`, and a unit code otherwise, which is why the type is checked.
 */
export function collectCwids(summary: NamedRows): string[] {
  const cwids = new Set<string>();
  for (const e of summary.topEditors) cwids.add(e.actorCwid);
  for (const e of summary.topEntities) if (e.entityType === "scholar") cwids.add(e.entityId);
  for (const r of summary.recent) {
    cwids.add(r.actorCwid);
    if (r.impersonatedCwid) cwids.add(r.impersonatedCwid);
    if (r.entityType === "scholar") cwids.add(r.entityId);
  }
  cwids.delete("");
  return [...cwids];
}

/** One batched name/title read. Deleted scholars are NOT excluded — the audit
 *  log outlives the profile, and a name is better than a bare CWID either way. */
export async function resolvePeople(
  client: EditActivityClient,
  cwids: readonly string[],
): Promise<PeopleDirectory> {
  if (cwids.length === 0) return {};
  const rows = await client.scholar.findMany({
    where: { cwid: { in: [...cwids] } },
    select: { cwid: true, preferredName: true, primaryTitle: true },
  });
  return Object.fromEntries(
    rows.map((r) => [r.cwid, { name: r.preferredName, title: r.primaryTitle }]),
  );
}

/** Center + core names for the entities on the page (both tables are tiny;
 *  batched `in` reads). A client without those delegates resolves nothing. */
export async function resolveEntityNames(
  client: EditActivityClient,
  summary: NamedRows,
): Promise<Record<string, string>> {
  const ids = { center: new Set<string>(), core: new Set<string>() };
  const add = (type: string, id: string) => {
    if (type === "center" || type === "core") ids[type].add(id);
  };
  for (const e of summary.topEntities) add(e.entityType, e.entityId);
  for (const r of summary.recent) add(r.entityType, r.entityId);
  const out: Record<string, string> = {};
  const [centers, cores] = await Promise.all([
    ids.center.size && client.center
      ? client.center.findMany({
          where: { code: { in: [...ids.center] } },
          select: { code: true, name: true },
        })
      : Promise.resolve([]),
    ids.core.size && client.core
      ? client.core.findMany({
          where: { id: { in: [...ids.core] } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  for (const c of centers) out[`center:${c.code}`] = c.name;
  for (const c of cores) out[`core:${c.id}`] = c.name;
  return out;
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

  // Day buckets in WCM-local (Eastern) time, so they agree with the Eastern
  // timestamps the feed renders. A bound numeric offset needs no MySQL tz tables.
  const offset = easternOffset(now);

  const [perDay, editors, entities, recent, stats] = await Promise.all([
    client.$queryRaw<RawPerDay[]>`
      SELECT DATE(CONVERT_TZ(ts, '+00:00', ${offset})) AS day, COUNT(*) AS edits
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       GROUP BY day
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
             target_entity_type, target_entity_id,
             fields_changed, before_values, after_values
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}
       ORDER BY ts DESC, id DESC
       LIMIT 100`,
    client.$queryRaw<RawEditorStats[]>`
      SELECT COUNT(DISTINCT actor_cwid) AS editors,
             COUNT(DISTINCT CASE WHEN actor_cwid LIKE 'system-%' THEN actor_cwid END)
               AS automated_editors,
             CAST(COALESCE(SUM(CASE WHEN actor_cwid LIKE 'system-%' THEN 1 ELSE 0 END), 0)
               AS SIGNED) AS automated_edits
        FROM scholars_audit.manual_edit_audit
       WHERE ts >= ${cutoff}`,
  ]);

  const summary = shapeSummary(perDay, editors, entities, recent, stats, now);
  const named = await resolveNames(client, summary);
  summary.entityNames = named.entityNames;
  summary.people = named.people;
  return summary;
}

/** One "Load older" page of the feed: the rows plus the names they need. */
export type EditActivityPage = {
  recent: RecentEdit[];
  /** Cursor for the page after this one, or null at the window's start. */
  nextCursor: string | null;
  people: PeopleDirectory;
  entityNames: Record<string, string>;
};

/**
 * The next {@link EDIT_ACTIVITY_RECENT_LIMIT} edits strictly OLDER than
 * `cursor` (same `ts DESC, id DESC` order as the summary's first page), still
 * bounded to the trailing {@link EDIT_ACTIVITY_WINDOW_DAYS} days so the feed
 * never outruns the KPIs, chart and "N edits that day" counts it sits under.
 * `asOf` is the summary's `generatedAt` ({@link parseAsOf}), so the window
 * start is the one the page was rendered with, not one recomputed per request.
 * Reads one look-ahead row to know whether another page exists. Throws if the
 * audit table is unreadable (the route answers 503); name lookups fail soft.
 */
export async function loadOlderEdits(
  client: EditActivityClient,
  cursor: FeedCursor,
  asOf: Date = new Date(),
): Promise<EditActivityPage> {
  const cutoff = new Date(asOf.getTime() - EDIT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // LIMIT 101 = EDIT_ACTIVITY_RECENT_LIMIT + 1 look-ahead row (a literal, like
  // the first page's LIMIT 100: a bound LIMIT is driver-fragile).
  const rows = await client.$queryRaw<RawRecent[]>`
    SELECT id, ts, actor_cwid, impersonated_cwid, action,
           target_entity_type, target_entity_id,
           fields_changed, before_values, after_values
      FROM scholars_audit.manual_edit_audit
     WHERE ts >= ${cutoff}
       AND (ts < ${cursor.ts} OR (ts = ${cursor.ts} AND id < ${cursor.id}))
     ORDER BY ts DESC, id DESC
     LIMIT 101`;
  const more = rows.length > EDIT_ACTIVITY_RECENT_LIMIT;
  const recent = rows.slice(0, EDIT_ACTIVITY_RECENT_LIMIT).map(shapeRecent);
  const oldest = recent[recent.length - 1];
  const { people, entityNames } = await resolveNames(client, {
    topEditors: [],
    topEntities: [],
    recent,
  });
  return {
    recent,
    nextCursor: more && oldest ? encodeCursor(oldest) : null,
    people,
    entityNames,
  };
}

/** Center/core names + people for `rows`. Both lookups are decoration and fail
 *  SOFT (logged, empty) — see the comment on the people read below. */
async function resolveNames(
  client: EditActivityClient,
  rows: NamedRows,
): Promise<{ people: PeopleDirectory; entityNames: Record<string, string> }> {
  let entityNames: Record<string, string> = {};
  let people: PeopleDirectory = {};
  // Center / core display names, same fail-soft rule as the people below.
  try {
    entityNames = await resolveEntityNames(client, rows);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "edit_activity_entity_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  // Names are decoration; the audit rows are the page. A throw from THIS read
  // would surface as the "activity unavailable" notice — a cosmetic lookup must
  // never be able to take down a working page — so it is logged and swallowed,
  // leaving every person rendered as a bare CWID.
  try {
    people = await resolvePeople(client, collectCwids(rows));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "edit_activity_name_resolve_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { people, entityNames };
}
