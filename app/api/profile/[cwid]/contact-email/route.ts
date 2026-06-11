import { NextResponse, type NextRequest } from "next/server";

import { resolveViewerContext } from "@/lib/auth/viewer-context";
import { isEmailReleaseGateEnabled } from "@/lib/profile/email-visibility-flags";
import { isEmailVisibleToViewer } from "@/lib/profile/email-display-gate";
import { loadScholarContactEmail } from "@/lib/api/profile";

/**
 * GET /api/profile/[cwid]/contact-email — email-visibility-spec § Cache-safety,
 * the INTERNAL-VIEWER reveal of a scholar's `institution`-released email.
 *
 * The profile page is CloudFront PATH-cached (cookies stripped), so its baked
 * Contact-card email must be viewer-independent: only `public` emails are baked.
 * An `institution` email may be shown to internal viewers but must NOT be baked
 * into the shared cache (that would leak it to external viewers). This uncacheable
 * endpoint performs that out-of-band reveal — exactly the #866 sensitive-families
 * pattern.
 *
 * It lives under /api/profile/* so the #866 origin-request policy forwards
 * `CloudFront-Viewer-Address`, and outside /api/edit/* so the SSO middleware does
 * not 401 an anonymous on-network viewer. Default-safe:
 *   - gate off                               → { email: null, viewer: "off" }
 *   - external viewer                        → { email: null, viewer: "external" }
 *   - internal viewer + public/institution   → { email, viewer: basis }
 *   - internal viewer + none/null/unknown    → { email: null, viewer: basis }
 * Never cached.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cwid: string }> },
): Promise<NextResponse> {
  const { cwid } = await params;

  if (!isEmailReleaseGateEnabled()) {
    return NextResponse.json({ email: null, viewer: "off" }, { headers: NO_STORE });
  }

  const vc = await resolveViewerContext(request);
  if (!vc.internal) {
    return NextResponse.json({ email: null, viewer: "external" }, { headers: NO_STORE });
  }

  const row = await loadScholarContactEmail(cwid);
  const email = row && isEmailVisibleToViewer(row.emailVisibility, true) ? row.email : null;
  return NextResponse.json({ email, viewer: vc.basis }, { headers: NO_STORE });
}
