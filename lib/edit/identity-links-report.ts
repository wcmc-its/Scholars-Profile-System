/**
 * Report 22 — Cross-campus duplicates: loader + params. Reads
 * `scholar_identity_link` (etl/identity-links, weekly): WCM scholars that are
 * probably also a Cornell (Ithaca) person under a NetID. View-only, superusers
 * only, no download (a list of people falls under SCHOLAR_EXPORT_CAP).
 */
import type { PrismaClient } from "@/lib/generated/prisma/client";

type Client = Pick<PrismaClient, "scholarIdentityLink">;

export const IDENTITY_LINK_BANDS = ["known", "strong", "possible"] as const;
export type IdentityLinkBand = (typeof IDENTITY_LINK_BANDS)[number];
export const IDENTITY_LINK_BAND_LABEL: Record<IdentityLinkBand, string> = {
  known: "Known: in the directory",
  strong: "Strong: shared ORCID or email",
  possible: "Possible: same name only",
};
/** Pairs listed at most; the band counts always cover everyone. */
export const IDENTITY_LINK_LIST_CAP = 500;

export type IdentityLinkParams = { q: string; band: IdentityLinkBand | "all" };

export function parseIdentityLinkParams(
  sp: Record<string, string | string[] | undefined>,
): IdentityLinkParams {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  };
  const band = one("band");
  return {
    q: one("q").slice(0, 100),
    band: (IDENTITY_LINK_BANDS as readonly string[]).includes(band)
      ? (band as IdentityLinkBand)
      : "all",
  };
}

export type IdentityLinkSignals = {
  ed?: boolean;
  cornell?: boolean;
  orcid?: string;
  email?: string;
  name?: boolean;
};

export type IdentityLinkRow = {
  cwid: string;
  wcmName: string;
  wcmDepartment: string | null;
  leftWcm: boolean;
  netid: string;
  cornellName: string | null;
  cornellDepartment: string | null;
  cornellTitle: string | null;
  band: IdentityLinkBand;
  signals: IdentityLinkSignals;
};

export async function loadIdentityLinkReport(client: Client, p: IdentityLinkParams) {
  const q = p.q.toLowerCase();
  const where = {
    ...(p.band !== "all" ? { band: p.band } : {}),
    ...(q
      ? {
          OR: [
            { cwid: { contains: q } },
            { netid: { contains: q } },
            { cornellName: { contains: q } },
            { scholar: { fullName: { contains: q } } },
          ],
        }
      : {}),
  };
  const [counts, matched, rows, computed] = await Promise.all([
    client.scholarIdentityLink.groupBy({ by: ["band"], _count: { _all: true } }),
    client.scholarIdentityLink.count({ where }),
    client.scholarIdentityLink.findMany({
      where,
      // etl/identity-links inserts in band order (known, strong, possible), so id
      // order is band order and the cap trims the weakest pairs first.
      orderBy: { id: "asc" },
      take: IDENTITY_LINK_LIST_CAP,
      select: {
        cwid: true,
        netid: true,
        band: true,
        signals: true,
        cornellName: true,
        cornellDepartment: true,
        cornellTitle: true,
        scholar: { select: { preferredName: true, primaryDepartment: true, deletedAt: true } },
      },
    }),
    client.scholarIdentityLink.aggregate({ _max: { computedAt: true } }),
  ]);
  const byBand = Object.fromEntries(IDENTITY_LINK_BANDS.map((b) => [b, 0])) as Record<
    IdentityLinkBand,
    number
  >;
  for (const c of counts) if (c.band in byBand) byBand[c.band as IdentityLinkBand] = c._count._all;
  return {
    byBand,
    total: IDENTITY_LINK_BANDS.reduce((n, b) => n + byBand[b], 0),
    matched,
    computedAt: computed._max.computedAt,
    rows: rows.map((r): IdentityLinkRow => ({
      cwid: r.cwid,
      wcmName: r.scholar.preferredName,
      wcmDepartment: r.scholar.primaryDepartment,
      leftWcm: r.scholar.deletedAt !== null,
      netid: r.netid,
      cornellName: r.cornellName,
      cornellDepartment: r.cornellDepartment,
      cornellTitle: r.cornellTitle,
      band: r.band as IdentityLinkBand,
      signals: (r.signals ?? {}) as IdentityLinkSignals,
    })),
  };
}
