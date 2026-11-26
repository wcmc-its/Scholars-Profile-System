/**
 * GET /api/edit/reports/patent-citations — report 25 (Patent citations) as an
 * `.xlsx`: Publications (the first `PATENT_LIST_CAP` in the chosen order),
 * Inventions (the first `PATENT_INVENTIONS_CAP`), People, Criteria. Same query
 * string as the page (`parsePatentCitationParams`), same narrowing:
 * `resolvePatentCitationParams` pins the viewer's units from the session, so a
 * `unit` in the URL can only narrow within them.
 * `PATENT_CITATIONS_REPORT` off → 404 · no session → 401 · no unit to see →
 * 403. `no-store`.
 *
 * The People sheet lists every matching person, under report 24's decided,
 * named exception to the 50-scholar export cap (`SCHOLAR_EXPORT_CAP`,
 * `lib/api/export-scholars.ts`), which stays as it is for every other export:
 * name, CWID, org unit, person type, primary institution and counts, no
 * contact details.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import {
  buildPatentCitationWorkbook,
  isPatentCitationsReportEnabled,
  loadPatentCitations,
  loadPersonInventions,
  parsePatentCitationParams,
  PATENT_INVENTIONS_CAP,
  PATENT_LIST_CAP,
  resolvePatentCitationParams,
  withInventionDetails,
  withPublicationDetails,
} from "@/lib/edit/patent-citations-report";
import { unitLabels } from "@/lib/edit/person-filter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isPatentCitationsReportEnabled()) return new NextResponse("Not found", { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const params = await resolvePatentCitationParams(
    parsePatentCitationParams(new URL(request.url).searchParams),
    session,
  );
  if (params.scope !== null && params.scope.length === 0) return new NextResponse("Forbidden", { status: 403 });

  const generatedAt = new Date();
  const data = await loadPatentCitations(params, { latest: true });
  const [pubs, inventions, personInventions, labels] = await Promise.all([
    withPublicationDetails(params, data.pubs.slice(0, PATENT_LIST_CAP), { inventions: false }),
    withInventionDetails(params, data.inventions.slice(0, PATENT_INVENTIONS_CAP), { papers: false }),
    data.people.length > 0 ? loadPersonInventions(params, null) : new Map<string, number>(),
    params.units.length > 0 || params.scope !== null
      ? loadDataQualityFacets(db.read).then(unitLabels)
      : undefined,
  ]);
  const buffer = await buildPatentCitationWorkbook(
    params,
    {
      pubs,
      pubTotal: data.pubs.length,
      inventions,
      inventionTotal: data.inventions.length,
      people: data.people.map((r) => ({ ...r, inventions: personInventions.get(r.cwid) ?? 0 })),
    },
    generatedAt,
    labels,
  );
  const filename = `Patent citations ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
}
