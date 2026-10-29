/**
 * Report 18 loader: the center's publications in the period, attributed by
 * the shared rules (`loadCenterPubAttribution`: members of the chosen type
 * active on the as-of date, their program on that date, publications only
 * from their WCM tenure), filtered on relevance and the review marker, each
 * with its `center_publication_relevance` reason and every confirmed WCM
 * author in byline order. The caller has passed the unit gate. Server-only
 * (reads `@/lib/db`).
 */
import { db } from "@/lib/db";
import type { AttributedPublication } from "@/lib/edit/center-pub-attribution";
import { loadCenterPubAttribution } from "@/lib/edit/center-pub-attribution.server";
import {
  investigatorLine,
  keepsRelevance,
  type PubCitationParams,
  type PubCitationRow,
} from "@/lib/edit/pub-citation-report";

export type PubCitationReport = {
  rows: PubCitationRow[];
  /** Rows credited ONLY through members of unknown WCM tenure (included on trust). */
  unknownTenure: number;
};

export async function loadPubCitationReport(
  centerCode: string,
  params: PubCitationParams,
): Promise<PubCitationReport> {
  const types =
    params.membership === "all" ? (["research", "clinical"] as const) : [params.membership];
  const attributions = await Promise.all(
    types.map((membershipType) =>
      loadCenterPubAttribution(centerCode, {
        from: params.start,
        to: params.end,
        asOf: params.asOf,
        membershipType,
      }),
    ),
  );
  // "All" = research ∪ clinical: one row per pmid, its credited members merged.
  const byPmid = new Map<string, AttributedPublication>();
  for (const a of attributions)
    for (const p of a.publications) {
      const prev = byPmid.get(p.pmid);
      byPmid.set(p.pmid, prev ? { ...prev, members: [...prev.members, ...p.members] } : p);
    }
  const kept = [...byPmid.values()]
    .filter((p) => keepsRelevance(params.relevance, p))
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.pmid) - Number(a.pmid));
  if (kept.length === 0) return { rows: [], unknownTenure: 0 };

  const pmids = kept.map((p) => p.pmid);
  const [details, reasons] = await Promise.all([
    db.read.publication.findMany({
      where: { pmid: { in: pmids } },
      select: {
        pmid: true,
        authors: {
          where: { isConfirmed: true, cwid: { not: null } },
          select: {
            cwid: true,
            position: true,
            isFirst: true,
            isLast: true,
            totalAuthors: true,
            scholar: { select: { fullName: true } },
          },
        },
      },
    }),
    db.read.centerPublicationRelevance.findMany({
      where: { centerCode, pmid: { in: pmids } },
      select: { pmid: true, reason: true },
    }),
  ]);
  const authorsOf = new Map(details.map((d) => [d.pmid, d.authors]));
  const reasonOf = new Map(reasons.map((r) => [r.pmid, r.reason]));

  const rows = kept.map((p): PubCitationRow => {
    const program = new Map(p.members.map((m) => [m.cwid, m.programCode]));
    const authors = (authorsOf.get(p.pmid) ?? []).map((a) => ({ ...a, cwid: a.cwid as string }));
    // Byline order. `position` 0 is "middle, rank unknown" (#2227), so it
    // sorts just before the last author rather than first.
    const rank = (a: (typeof authors)[number]) =>
      a.isFirst ? 0 : a.isLast ? Infinity : a.position || a.totalAuthors;
    return {
      pmid: p.pmid,
      title: p.title,
      journal: p.journal,
      date: p.date,
      relevant: p.relevant,
      reason: reasonOf.get(p.pmid) ?? null,
      // Names only, never a CWID: an author without a scholar row is left out.
      // The program is the credited member's on the as-of date.
      investigators: authors
        .filter((a) => a.scholar)
        .sort((a, b) => rank(a) - rank(b))
        .map((a) => ({
          cwid: a.cwid,
          line: investigatorLine(a.scholar!.fullName, program.get(a.cwid) ?? null),
        })),
    };
  });
  return {
    rows,
    unknownTenure: kept.filter((p) => p.members.every((m) => m.tenureUnknown)).length,
  };
}
