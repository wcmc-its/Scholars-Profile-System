import { NextResponse, NextRequest } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getScholarByCwid } from "@/lib/api/scholars";
import { resolveViewerContext } from "@/lib/auth/viewer-context";

/**
 * GET /api/scholars/:cwid
 *
 * The route file is a thin delegator to a pure function in `lib/api/*` so that
 * if production architecture pivots to a separate Scholar API service (per
 * Mohammad's preliminary preference), the handler lifts cleanly without touching
 * Next.js-specific code. Same shape applies to all forthcoming /api/* routes.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ cwid: string }> },
) {
  const { cwid } = await context.params;
  // email-visibility-spec § A — resolve the #866 internal-viewer signal so an
  // authenticated / on-WCM-network caller still receives `institution` emails,
  // while an anonymous off-campus caller is gated to `public` only. Fail-closed:
  // a context-resolution error leaves the viewer external. No-op while
  // PROFILE_EMAIL_RELEASE_GATE is off (the gate inside getScholarByCwid).
  let internalViewer = false;
  try {
    const viewer = await resolveViewerContext(
      request instanceof NextRequest ? request : new NextRequest(request),
    );
    internalViewer = viewer.internal;
  } catch {
    internalViewer = false;
  }
  const result = await getScholarByCwid(cwid, internalViewer);
  if (!result) {
    return apiError("Scholar not found", 404);
  }
  return NextResponse.json(result);
}
