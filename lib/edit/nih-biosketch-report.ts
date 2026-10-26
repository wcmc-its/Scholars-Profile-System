/**
 * Report 15 — NIH biosketches: loader + params. Reads `infoed_biosketch`
 * (etl/infoed-biosketch), one row per (scholar, InfoEd document version), grouped
 * per scholar newest first. Superusers only (the registry's "superuser" gate).
 *
 * Flags, per scholar:
 *  - `orcidConflict` — two or more different iDs across their biosketches.
 *  - `orcidDiffers` — an iD is on file (`scholar.orcid`) and no biosketch lists it.
 *
 * Read-only.
 */
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import {
  loadSelectedDivisionRosterCwids,
  parsePersonFilter,
  personFilterWhere,
  type PersonFilter,
} from "@/lib/edit/person-filter";

type Client = Pick<PrismaClient, "infoedBiosketch" | "scholar" | "division" | "divisionMembership">;

/** Scholars listed at most; the totals always count everyone. */
export const NIH_BIOSKETCH_LIST_CAP = 300;

export const NIH_BIOSKETCH_SHOW = ["all", "orcid", "myncbi", "flagged"] as const;
export type NihBiosketchShow = (typeof NIH_BIOSKETCH_SHOW)[number];
export const NIH_BIOSKETCH_SHOW_LABEL: Record<NihBiosketchShow, string> = {
  all: "Everyone with a biosketch",
  orcid: "Has an ORCID iD",
  myncbi: "Has a MyNCBI bibliography",
  flagged: "ORCID flagged",
};

export type NihBiosketchParams = PersonFilter & { q: string; show: NihBiosketchShow };

export function parseNihBiosketchParams(
  sp: Record<string, string | string[] | undefined>,
): NihBiosketchParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const show = one("show");
  return {
    ...parsePersonFilter(sp),
    q: one("q").slice(0, 100),
    show: (NIH_BIOSKETCH_SHOW as readonly string[]).includes(show) ? (show as NihBiosketchShow) : "all",
  };
}

export type NihBiosketchRow = {
  docVersionId: string;
  propNo: string;
  uploadedAt: string;
  format: string;
  attributedBy: string;
  orcid: string | null;
  myncbiUrl: string | null;
  personalStatement: string | null;
  contributions: string | null;
  honors: string | null;
};

export type NihBiosketchScholar = {
  cwid: string;
  name: string;
  department: string | null;
  orcidOnFile: string | null;
  orcids: string[];
  myncbiUrls: string[];
  orcidConflict: boolean;
  orcidDiffers: boolean;
  biosketches: NihBiosketchRow[];
};

export type NihBiosketchReport = {
  totals: { scholars: number; biosketches: number; withOrcid: number; withMyncbi: number; flagged: number };
  scholars: NihBiosketchScholar[];
  /** Matching scholars before the list cap. */
  matched: number;
};

/** Pure: fold one scholar's rows (newest first) into the report's per-scholar shape. */
export function foldScholar(
  s: { cwid: string; preferredName: string; primaryDepartment: string | null; orcid: string | null },
  rows: readonly NihBiosketchRow[],
): NihBiosketchScholar {
  const orcids = [...new Set(rows.map((r) => r.orcid).filter((o): o is string => !!o))];
  const myncbiUrls = [...new Set(rows.map((r) => r.myncbiUrl).filter((u): u is string => !!u))];
  return {
    cwid: s.cwid,
    name: s.preferredName,
    department: s.primaryDepartment,
    orcidOnFile: s.orcid,
    orcids,
    myncbiUrls,
    orcidConflict: orcids.length > 1,
    orcidDiffers: !!s.orcid && orcids.length > 0 && !orcids.includes(s.orcid),
    biosketches: [...rows],
  };
}

export const isFlagged = (s: NihBiosketchScholar) => s.orcidConflict || s.orcidDiffers;

export async function loadNihBiosketchReport(
  client: Client,
  p: NihBiosketchParams,
): Promise<NihBiosketchReport> {
  const roster = await loadSelectedDivisionRosterCwids(client, p.unitValues);
  const w = personFilterWhere({ types: p.types, unitValues: p.unitValues }, [], roster);
  const and: Prisma.ScholarWhereInput[] = [{ deletedAt: null }];
  if (w.roleCategory) and.push({ roleCategory: w.roleCategory });
  if (w.unit) and.push(w.unit);
  if (p.q) and.push({ OR: [{ preferredName: { contains: p.q } }, { cwid: { startsWith: p.q } }] });

  const rows = await client.infoedBiosketch.findMany({
    where: { scholar: { AND: and } },
    orderBy: { uploadedAt: "desc" },
    select: {
      cwid: true,
      docVersionId: true,
      propNo: true,
      uploadedAt: true,
      format: true,
      attributedBy: true,
      orcid: true,
      myncbiUrl: true,
      personalStatement: true,
      contributions: true,
      honors: true,
      scholar: { select: { cwid: true, preferredName: true, primaryDepartment: true, orcid: true } },
    },
  });

  const byCwid = new Map<string, { s: (typeof rows)[number]["scholar"]; rows: NihBiosketchRow[] }>();
  for (const { scholar, cwid, uploadedAt, ...r } of rows) {
    const g = byCwid.get(cwid) ?? byCwid.set(cwid, { s: scholar, rows: [] }).get(cwid)!;
    g.rows.push({ ...r, uploadedAt: uploadedAt.toISOString() });
  }
  const all = [...byCwid.values()]
    .map((g) => foldScholar(g.s, g.rows))
    .sort((a, b) => a.name.localeCompare(b.name));

  const keep = (s: NihBiosketchScholar) =>
    p.show === "orcid"
      ? s.orcids.length > 0
      : p.show === "myncbi"
        ? s.myncbiUrls.length > 0
        : p.show === "flagged"
          ? isFlagged(s)
          : true;
  const matching = all.filter(keep);
  return {
    totals: {
      scholars: all.length,
      biosketches: rows.length,
      withOrcid: all.filter((s) => s.orcids.length > 0).length,
      withMyncbi: all.filter((s) => s.myncbiUrls.length > 0).length,
      flagged: all.filter(isFlagged).length,
    },
    scholars: matching.slice(0, NIH_BIOSKETCH_LIST_CAP),
    matched: matching.length,
  };
}
