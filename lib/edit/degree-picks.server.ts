/**
 * Degree picker — database side. Server-only: never import from a
 * `"use client"` file (it would drag the mariadb driver into the browser, the
 * `lib/edit/manageable-units.ts` trap in CLAUDE.md). The pure rules live in
 * `lib/degree-picker.ts`.
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  DEGREE_OVERRIDE_FIELD,
  defaultPostnominal,
  degreeOptions,
  resolveDegreeOverride,
} from "@/lib/degree-picker";

type Client = Pick<PrismaClient, "education" | "fieldOverride">;

/** One scholar's selectable degrees, from every ASMS row (hidden ones too: a
 *  hidden education entry is still a degree the scholar holds). */
export async function loadDegreeOptions(client: Client, cwid: string): Promise<string[]> {
  const rows = await client.education.findMany({
    where: { cwid, source: "ASMS" },
    select: { degree: true, year: true },
  });
  return degreeOptions(rows);
}

/**
 * Every scholar's degree pick, resolved against their CURRENT ASMS rows.
 * `resolved` maps cwid → display string; `stale` lists cwids whose stored
 * pick no longer validates (a picked degree left ASMS) — those fall back to
 * the ED value until the scholar picks again.
 */
export async function loadResolvedDegreePicks(
  client: Client,
): Promise<{ resolved: Map<string, string>; stale: string[] }> {
  const picks = await client.fieldOverride.findMany({
    where: { entityType: "scholar", fieldName: DEGREE_OVERRIDE_FIELD },
    select: { entityId: true, value: true },
  });
  const resolved = new Map<string, string>();
  const stale: string[] = [];
  if (picks.length === 0) return { resolved, stale };

  const rows = await client.education.findMany({
    where: { cwid: { in: picks.map((p) => p.entityId) }, source: "ASMS" },
    select: { cwid: true, degree: true, year: true },
  });
  const byCwid = new Map<string, { degree: string; year: number | null }[]>();
  for (const r of rows) {
    const list = byCwid.get(r.cwid) ?? [];
    list.push(r);
    byCwid.set(r.cwid, list);
  }
  for (const p of picks) {
    const display = resolveDegreeOverride(p.value, degreeOptions(byCwid.get(p.entityId) ?? []));
    if (display) resolved.set(p.entityId, display);
    else stale.push(p.entityId);
  }
  return { resolved, stale };
}

/** cwid → ASMS-derived default postnominal (`defaultPostnominal`), for every
 *  scholar with at least one selectable ASMS degree. The ED ETL uses it when
 *  the directory has no degree for that scholar. */
export async function loadAsmsDefaultPostnominals(
  client: Pick<PrismaClient, "education">,
): Promise<Map<string, string>> {
  const rows = await client.education.findMany({
    where: { source: "ASMS" },
    select: { cwid: true, degree: true, year: true },
  });
  const byCwid = new Map<string, { degree: string; year: number | null }[]>();
  for (const r of rows) {
    const list = byCwid.get(r.cwid) ?? [];
    list.push(r);
    byCwid.set(r.cwid, list);
  }
  const out = new Map<string, string>();
  for (const [cwid, list] of byCwid) {
    const display = defaultPostnominal(degreeOptions(list));
    if (display) out.set(cwid, display);
  }
  return out;
}

/** What the /edit Degrees row needs. `selected` null ⇒ showing the ED value. */
export type DegreePickerState = {
  options: string[];
  selected: string[] | null;
  directory: string | null;
};

export async function loadDegreePickerState(
  client: Client,
  cwid: string,
  directory: string | null,
): Promise<DegreePickerState> {
  const [options, pick] = await Promise.all([
    loadDegreeOptions(client, cwid),
    client.fieldOverride.findUnique({
      where: {
        entityType_entityId_fieldName: {
          entityType: "scholar",
          entityId: cwid,
          fieldName: DEGREE_OVERRIDE_FIELD,
        },
      },
      select: { value: true },
    }),
  ]);
  const display = pick ? resolveDegreeOverride(pick.value, options) : null;
  return { options, selected: display ? display.split(", ") : null, directory };
}
