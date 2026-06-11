/**
 * GET /api/export/methods/families — download-for-review CSV of the comms-steward
 * Method-Family roster (`docs/comms-steward-methods-visibility-spec.md` §7).
 *
 * The same roster the JSON endpoint returns, serialized to CSV via the shared
 * `toCsv` helper and returned as a `text/csv` attachment (the #847 export
 * Content-Disposition / no-store pattern). Columns per §7:
 *   supercategory, family_label, tier, reason, is_new, reviewed_at,
 *   scholar_count, pmid_count
 *
 * Supports the same `?filter=` narrowing as the JSON roster, plus
 * `?supercategory=` (a comma-separated allow-list) so the CSV matches the
 * steward's supercategory multi-select — the export reflects exactly what they
 * are viewing.
 *
 * Same guard as the JSON roster (§7/§9): COMMS_STEWARD_ENABLED off => 404;
 * anonymous => 401; non-steward/superuser => 403 (`not_comms_steward`, logged).
 * The export surfaces EFFECTIVE visibility (the derived tier), not just an
 * assigned label, per the §12 inert-sensitive mitigation.
 */
import { NextResponse, type NextRequest } from "next/server";

import { isCommsStewardEnabled } from "@/lib/auth/comms-steward";
import { getEditSession } from "@/lib/auth/superuser";
import { authorizeCommsStewardAction, logEditDenial } from "@/lib/edit/authz";
import { apiError } from "@/lib/api/error-response";
import { editError } from "@/lib/edit/request";
import { toCsv, type CsvCell } from "@/lib/csv";
import {
  buildFamilyRoster,
  applyRosterFilter,
  parseRosterFilter,
  applySupercategoryFilter,
  parseSupercategoriesParam,
} from "@/lib/api/methods-families";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const PATH = "/api/export/methods/families";

/** §7 column order — the CSV header row + the per-row projection key order. */
const HEADERS = [
  "supercategory",
  "family_label",
  "tier",
  "reason",
  "is_new",
  "reviewed_at",
  "scholar_count",
  "pmid_count",
] as const;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // (a) master kill switch — whole surface dark when off (§9).
  if (!isCommsStewardEnabled()) return apiError("not_found", 404);

  // (b) authoritative session + live role verdicts.
  const session = await getEditSession();
  if (!session) return apiError("unauthorized", 401);

  // (c) comms_steward OR superuser (§3 superset); denials logged.
  const authz = authorizeCommsStewardAction(session);
  if (!authz.ok) {
    logEditDenial({
      actorCwid: session.cwid,
      targetCwid: session.cwid,
      path: PATH,
      reason: authz.reason,
    });
    return editError(403, authz.reason);
  }

  const filter = parseRosterFilter(request.nextUrl.searchParams.get("filter"));
  const supercategories = parseSupercategoriesParam(
    request.nextUrl.searchParams.get("supercategory"),
  );
  const roster = applySupercategoryFilter(
    applyRosterFilter(await buildFamilyRoster(), filter),
    supercategories,
  );

  const rows: CsvCell[][] = roster.map((r) => [
    r.supercategory,
    r.familyLabel,
    r.tier,
    r.reason ?? "",
    r.isNew ? "true" : "false",
    r.reviewedAt ?? "",
    r.scholarCount,
    r.pmidCount,
  ]);
  const csv = toCsv(HEADERS, rows);
  const filename = `Method-Families-${todayStamp()}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
