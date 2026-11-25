/**
 * GET /api/edit/reports/policy-citations — report 24 (Guideline and policy
 * citations) as an `.xlsx`: Publications (the first `POLICY_LIST_CAP` in the
 * chosen order), People, Criteria. Same query string as the page
 * (`parsePolicyCitationParams`), same narrowing: `resolvePolicyCitationParams`
 * pins the viewer's units from the session, so a `unit` in the URL can only
 * narrow within them. No session → 401 · no unit to see → 403. `no-store`.
 *
 * The People sheet lists every matching person: this report is a decided,
 * named exception to the 50-scholar export cap (`SCHOLAR_EXPORT_CAP`,
 * `lib/api/export-scholars.ts`), which stays as it is for every other export.
 * The report owner, 2026-11-24: "I'm fine with breaking our per person rule.
 * The report is kind of pointless otherwise." The sheet carries name, CWID,
 * org unit, person type, primary institution and counts, no contact details.
 */
import { NextResponse } from "next/server";

import { loadDataQualityFacets } from "@/lib/api/data-quality";
import { getEffectiveEditSession } from "@/lib/auth/effective-identity";
import { db } from "@/lib/db";
import { unitLabels } from "@/lib/edit/person-filter";
import {
  buildPolicyCitationWorkbook,
  loadPolicyCitations,
  parsePolicyCitationParams,
  POLICY_LIST_CAP,
  resolvePolicyCitationParams,
} from "@/lib/edit/policy-citations-report";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getEffectiveEditSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });
  const params = await resolvePolicyCitationParams(
    parsePolicyCitationParams(new URL(request.url).searchParams),
    session,
  );
  if (params.scope !== null && params.scope.length === 0) return new NextResponse("Forbidden", { status: 403 });

  const generatedAt = new Date();
  const data = await loadPolicyCitations(params, POLICY_LIST_CAP);
  const labels =
    params.units.length > 0 || params.scope !== null ? unitLabels(await loadDataQualityFacets(db.read)) : undefined;
  const buffer = await buildPolicyCitationWorkbook(params, data, generatedAt, labels);
  const filename = `Guideline and policy citations ${generatedAt.toISOString().slice(0, 10)}.xlsx`;

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
