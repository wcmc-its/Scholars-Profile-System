import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getScholarByCwid } from "@/lib/api/scholars";

/**
 * GET /api/scholars/:cwid
 *
 * The route file is a thin delegator to a pure function in `lib/api/*` so that
 * if production architecture pivots to a separate Scholar API service (per
 * Mohammad's preliminary preference), the handler lifts cleanly without touching
 * Next.js-specific code. Same shape applies to all forthcoming /api/* routes.
 *
 * email-visibility-spec § Cache-safety: this endpoint is CloudFront-cacheable by
 * path and not in the #866 origin-request policy, so `getScholarByCwid` bakes
 * only the viewer-independent (public) email. Internal callers obtain
 * `institution` emails via the uncacheable /api/profile/[cwid]/contact-email.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ cwid: string }> },
) {
  const { cwid } = await context.params;
  const result = await getScholarByCwid(cwid);
  if (!result) {
    return apiError("Scholar not found", 404);
  }
  return NextResponse.json(result);
}
