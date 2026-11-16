/**
 * People's profile edits per hour for `/edit/usage`'s "Traffic by hour" card:
 * a count of B03 audit-log rows (`scholars_audit.manual_edit_audit`) per UTC
 * hour over the usage range, shaped to Eastern by
 * {@link shapeEditsByHour}.
 *
 * Automated edits are left out, by the same rules as `/edit/activity`
 * (lib/api/edit-activity.ts): a `system-` actor or the `etl` actor
 * (`isSystemActor`), and a backend bulk job's rows, which carry the CWID of the
 * person who ran the job but a `bulk-` request id (`isBulkJobRequest`). The SQL
 * literals must track those rules (pinned by a unit test).
 *
 * SELECT-only, read role (`db.read`). The range bounds are bound parameters
 * (strict YYYY-MM-DD, checked first), never interpolated. Cached per range like
 * the Athena loader; a DB error throws out of the uncached loader (never
 * cached) and the page hides the edits line on its own, leaving the traffic
 * bars alone.
 */
import { unstable_cache } from "next/cache";

import { type EditHour, type RawEditHour, shapeEditsByHour } from "@/lib/api/usage-hourly";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** Same TTL as the usage summary: the range ends yesterday, so its edits are settled. */
const EDITS_CACHE_TTL_SECONDS = 43_200;
const ISO_DT = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type UsageEditsClient = Pick<PrismaClient, "$queryRaw">;

/** People's edits per hour in the inclusive UTC-day range `[since, until]`. */
export async function loadEditsByHourUncached(
  client: UsageEditsClient,
  since: string,
  until: string,
): Promise<EditHour[]> {
  const from = Date.parse(`${since}T00:00:00Z`);
  const to = Date.parse(`${until}T00:00:00Z`);
  if (
    !ISO_DT.test(since) ||
    !ISO_DT.test(until) ||
    !Number.isFinite(from) ||
    !Number.isFinite(to)
  ) {
    throw new Error(`usage edits: bad range ${since}..${until}`);
  }
  const rows = await client.$queryRaw<RawEditHour[]>`
    SELECT DATE_FORMAT(ts, '%Y-%m-%d %H') AS hour, COUNT(*) AS edits
      FROM scholars_audit.manual_edit_audit
     WHERE ts >= ${new Date(from)}
       AND ts < ${new Date(to + DAY_MS)}
       AND actor_cwid NOT LIKE 'system-%'
       AND LOWER(actor_cwid) <> 'etl'
       AND (request_id IS NULL OR request_id NOT LIKE 'bulk-%')
     GROUP BY hour`;
  return shapeEditsByHour(rows);
}

/**
 * Cached loader, one entry per range. A thrown DB error propagates (never
 * cached) so the page can drop the edits line and say so.
 */
export function loadEditsByHour(
  client: UsageEditsClient,
  window: { since: string; until: string },
): Promise<EditHour[]> {
  return unstable_cache(
    () => loadEditsByHourUncached(client, window.since, window.until),
    ["usage-edits-by-hour", "v1", window.since, window.until],
    { revalidate: EDITS_CACHE_TTL_SECONDS, tags: ["usage-summary"] },
  )();
}
