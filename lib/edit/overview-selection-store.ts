/**
 * Durable read/write for the overview generator's three-state source-selection
 * deltas (#742 spec §2.5). One row per scholar in `overview_source_selection`,
 * holding the `OverviewSelectionDeltas` JSON. The deltas survive across generate
 * runs and toggle changes; the auto-set is recomputed each run and the deltas
 * re-applied on top (`assembleOverviewFacts`).
 *
 * Both helpers run the stored JSON back through `normalizeOverviewSelectionDeltas`
 * — the durable store is treated as untrusted on the way out as well as in, so a
 * schema drift or a hand-edited row can never feed a malformed delta into the
 * resolver.
 */
import { db } from "@/lib/db";

import {
  DEFAULT_OVERVIEW_SELECTION_DELTAS,
  normalizeOverviewSelectionDeltas,
  type OverviewSelectionDeltas,
} from "@/lib/edit/overview-params";

/** The scholar's saved deltas, or the default (pure auto-set) when none exist. */
export async function loadOverviewSelectionDeltas(cwid: string): Promise<OverviewSelectionDeltas> {
  const row = await db.read.overviewSourceSelection.findUnique({
    where: { cwid },
    select: { deltas: true },
  });
  if (!row) return DEFAULT_OVERVIEW_SELECTION_DELTAS;
  return normalizeOverviewSelectionDeltas(row.deltas);
}

/**
 * Upsert the scholar's deltas, recording the acting cwid (self / proxy / admin).
 * The value is normalized before storage so a forged/bloated body can't persist.
 * Returns the normalized deltas actually written.
 */
export async function saveOverviewSelectionDeltas(
  cwid: string,
  actorCwid: string,
  rawDeltas: unknown,
): Promise<OverviewSelectionDeltas> {
  const deltas = normalizeOverviewSelectionDeltas(rawDeltas);
  await db.write.overviewSourceSelection.upsert({
    where: { cwid },
    create: { cwid, deltas, updatedByCwid: actorCwid },
    update: { deltas, updatedByCwid: actorCwid },
  });
  return deltas;
}
