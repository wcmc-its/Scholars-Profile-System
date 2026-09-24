/**
 * GET /api/departments/[slug]/collaboration
 *
 * The data source for the department "Collaboration" tab — the department's
 * co-authorship network (members as nodes, divisions as colour groups). The
 * browser builds edges / rollups and applies every filter. Mirrors
 * `app/api/centers/[slug]/collaboration/route.ts`: reads only the path slug, NO
 * query params, so it needs no EdgeStack query-allowlist behavior and falls to
 * the default CloudFront behavior like the center route.
 *
 * `force-dynamic` ⇒ `Cache-Control: private, no-store` at the edge; the loader
 * itself is `cachedRead` (≤1h stale) because a large department's graph is an
 * expensive read on a public, unauthenticated route.
 *
 * Gating: the shared collaboration kill switch (404 when off), the department
 * existing and not unit-suppressed (`getDepartment` null ⇒ 404), and the
 * data-driven gate — ≥2 divisions with ≥1 public member (404 otherwise). A bad
 * slug is a 400 and is never queried.
 */
import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getDepartment } from "@/lib/api/departments";
import { getDepartmentDivisionMemberCounts } from "@/lib/api/unit-members";
import {
  getDepartmentCollaboration,
  isDepartmentCollaborationEligible,
} from "@/lib/api/department-collaboration";
import { isCenterCollaborationNetworkEnabled } from "@/lib/center-collaboration/flags";

export const dynamic = "force-dynamic";

// Department slugs are lowercase alnum + `_`/`-` (e.g. "medicine").
const SLUG_RE = /^[a-z0-9_-]+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  if (!isCenterCollaborationNetworkEnabled()) return apiError("not_found", 404);

  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return apiError("invalid slug", 400);

  const detail = await getDepartment(slug);
  if (!detail) return apiError("not_found", 404);

  const divisionCounts = await getDepartmentDivisionMemberCounts(detail.dept.code);
  if (!isDepartmentCollaborationEligible(divisionCounts)) {
    return apiError("not_found", 404);
  }

  const payload = await getDepartmentCollaboration({ code: detail.dept.code });
  return NextResponse.json(payload);
}
