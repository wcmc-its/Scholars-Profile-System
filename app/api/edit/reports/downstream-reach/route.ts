/**
 * GET /api/edit/reports/downstream-reach — report 27 (Downstream reach) as an
 * `.xlsx`: Publications (the first `REACH_LIST_CAP` in the chosen order),
 * Citing documents (the first `REACH_DOCS_CAP`; a note and no rows when the
 * selection is wider than `REACH_DOCS_PAPER_CEILING` cited papers, in which
 * case the grouped query is not run), People, Criteria. Same query
 * string as the page (`parseReachParams`), same narrowing: `resolveReachParams`
 * pins the viewer's units from the session, so a `unit` in the URL can only
 * narrow within them. `DOWNSTREAM_REACH_REPORT` off → 404, before the session
 * or any query is read · no session → 401 · no unit to see → 403. `no-store`.
 *
 * The People sheet lists every matching person, and the Connections sheet
 * (below) every colleague. This is a NAMED EXCEPTION to the 50-scholar export
 * cap (`SCHOLAR_EXPORT_CAP`, `lib/api/export-scholars.ts`), covering the
 * People and Connections sheets of this route only; the shared cap stays as
 * it is for every other export. It is report 24's exception (the report
 * owner, 2026-11-24: "I'm fine with breaking our per person rule. The report
 * is kind of pointless otherwise."), extended to this report's People view by
 * the same owner on 2026-11-26 (downstream reach plan, decision 3) and to its
 * Connections sheet on 2026-11-28 (decision 9). Both sheets carry name, CWID,
 * org unit, person type, primary institution and counts, and no contact
 * details.
 *
 * Taken from the Connections view with one scholar (`view=connections`), the
 * workbook adds a Connections sheet (`connectionsSheet`): both lists, every
 * row, one row per pair of scholars, with no contact details; the Criteria
 * sheet records the scholar and the rule. From any other view, or without one
 * scholar the view opens for, there is no such sheet and no Connections query
 * runs.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { connectionsSheet, loadReachConnections } from "@/lib/edit/downstream-reach-connections";
import {
  buildReachWorkbook,
  isDownstreamReachReportEnabled,
  loadReach,
  loadReachAreas,
  parseReachParams,
  REACH_DOCS_CAP,
  REACH_LIST_CAP,
  resolveReachParams,
  withReachDocDetails,
  withReachPublicationDetails,
} from "@/lib/edit/downstream-reach-report";
import { unitLabels } from "@/lib/edit/person-filter";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isDownstreamReachReportEnabled()) return new NextResponse("Not found", { status: 404 });
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const parsed = parseReachParams(new URL(request.url).searchParams);
  // The sheets are the three listings; `show=all` is a page view only.
  const params = await resolveReachParams({ ...parsed, showAll: false }, session);
  if (params.scope !== null && params.scope.length === 0) return new NextResponse("Forbidden", { status: 403 });

  const generatedAt = new Date();
  const data = await loadReach(params, {
    views: ["publications", "documents", "people"],
    limit: REACH_LIST_CAP,
    docLimit: REACH_DOCS_CAP,
  });
  const [pubs, docs, labels, areas, connections] = await Promise.all([
    withReachPublicationDetails(params, data.pubs),
    withReachDocDetails(data.docs),
    params.units.length > 0 || params.scope !== null ? loadDataQualityFacets(db.read).then(unitLabels) : undefined,
    params.area ? loadReachAreas() : [],
    params.view === "connections" ? loadReachConnections(params) : null,
  ]);
  const buffer = await buildReachWorkbook(
    params,
    {
      pubs,
      pubTotal: data.pubMatched,
      docs,
      docTotal: data.docTotal ?? 0,
      docsWithheld: data.docsWithheld,
      people: data.people ?? [],
    },
    generatedAt,
    labels,
    new Map(areas.map((a) => [a.id, a.label])),
    connections?.status === "ok" ? connectionsSheet(connections) : undefined,
  );
  const filename = `Downstream reach ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
